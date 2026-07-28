import { describe, expect, it, vi } from "vitest";

import requestModule from "../services/request.js";
import sessionModule from "../stores/session.js";

const { createRequestClient } = requestModule;
const { createSessionStore } = sessionModule;

function createClient(request, overrides = {}) {
  let requestId = 0;
  return createRequestClient({
    wxApi: { request },
    getRuntimeConfig: () => ({ apiBaseUrl: "https://api.example.com", envVersion: "trial" }),
    getSession: () => null,
    refreshSession: async () => undefined,
    reauthenticate: async () => undefined,
    createRequestId: () => `req_${++requestId}`,
    ...overrides,
  });
}

function identitySession(userId, token) {
  return {
    access_token: token,
    user: { id: userId },
  };
}

function canonicalIdentitySession(userId, marker) {
  return {
    access_token: marker.repeat(32),
    access_expires_in: 120,
    refresh_token: marker.toUpperCase().repeat(32),
    refresh_expires_in: 600,
    user: { id: userId },
  };
}

describe("request client", () => {
  it("returns validated envelope data and adds request/session headers", async () => {
    const request = vi.fn((options) => {
      expect(options.url).toBe("https://api.example.com/cities");
      expect(options.header).toMatchObject({
        Authorization: `Bearer ${"a".repeat(32)}`,
        "x-request-id": "req_1",
      });
      options.success({ statusCode: 200, data: { data: ["ok"], request_id: "server_req" } });
    });
    const client = createClient(request, {
      getSession: () => ({ access_token: "a".repeat(32) }),
    });

    await expect(client.get("/cities")).resolves.toEqual(["ok"]);
  });

  it("rejects unsafe paths before calling wx.request", async () => {
    const request = vi.fn();
    const client = createClient(request);
    for (const path of [
      "cities",
      "//evil.test/x",
      "/a/../secret",
      "/a/%2e%2e/secret",
      "/safe%2f%2fevil.test",
      "/safe%5csecret",
      "/%2e/secret",
      "/safe%252f%252fevil.test",
      "/safe%255csecret",
      "/%252e%252e/secret",
      "https://evil.test",
    ]) {
      await expect(client.get(path)).rejects.toMatchObject({ code: "INVALID_REQUEST_PATH" });
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("allows normal percent-encoded Chinese paths", async () => {
    const request = vi.fn((options) =>
      options.success({
        statusCode: 200,
        data: { data: "ok", request_id: "req_ok" },
      }),
    );
    await expect(createClient(request).get("/cities/%E6%9D%AD%E5%B7%9E")).resolves.toBe("ok");
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects malformed successful envelopes safely", async () => {
    const request = vi.fn((options) => {
      options.success({ statusCode: 200, data: { data: "token-value" } });
    });
    await expect(createClient(request).get("/test")).rejects.toMatchObject({
      code: "INVALID_API_RESPONSE",
      message: "Invalid API response",
    });
  });

  it("rejects a malformed 401 before starting authentication recovery", async () => {
    const userA = "11111111-1111-4111-8111-111111111111";
    const session = canonicalIdentitySession(userA, "a");
    const request = vi.fn((options) => {
      options.success({
        statusCode: 401,
        data: { error: { code: "UNAUTHORIZED", message: "Expired" } },
      });
    });
    const refreshSession = vi.fn(() => new Promise(() => {}));
    const reauthenticate = vi.fn();
    const client = createClient(request, {
      getSession: () => session,
      refreshSession,
      reauthenticate,
    });

    await expect(client.get("/private")).rejects.toMatchObject({
      code: "INVALID_API_RESPONSE",
      message: "Invalid API response",
    });
    expect(refreshSession).not.toHaveBeenCalled();
    expect(reauthenticate).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });

  it("parses a stable non-2xx API error", async () => {
    const request = vi.fn((options) => {
      options.success({
        statusCode: 422,
        data: {
          error: { code: "INVALID_CITY", message: "Choose another", details: { city: "x" } },
          request_id: "req_server",
        },
      });
    });
    await expect(createClient(request).post("/booking", {})).rejects.toMatchObject({
      code: "INVALID_CITY",
      message: "Choose another",
      requestId: "req_server",
      details: { city: "x" },
      statusCode: 422,
    });
  });

  it("retries a failed GET once with the same request id", async () => {
    const ids = [];
    const request = vi.fn((options) => {
      ids.push(options.header["x-request-id"]);
      if (ids.length === 1) {
        options.fail({ errMsg: "network secret" });
      } else {
        options.success({ statusCode: 200, data: { data: "ok", request_id: "req_ok" } });
      }
    });
    await expect(createClient(request).get("/cities")).resolves.toBe("ok");
    expect(ids).toEqual(["req_1", "req_1"]);
  });

  it("never retries POST network failures", async () => {
    const request = vi.fn((options) => options.fail({ errMsg: "network" }));
    await expect(createClient(request).post("/booking", {})).rejects.toMatchObject({
      code: "NETWORK_REQUEST_FAILED",
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("shares one refresh across concurrent 401 responses and replays each request once", async () => {
    let accessToken = "old";
    const attempts = new Map();
    const request = vi.fn((options) => {
      const path = new URL(options.url).pathname;
      attempts.set(path, (attempts.get(path) || 0) + 1);
      const respond = () => {
        if (options.header.Authorization === "Bearer old") {
          options.success({
            statusCode: 401,
            data: {
              error: { code: "UNAUTHORIZED", message: "Expired" },
              request_id: `req_401_${path.slice(1)}`,
            },
          });
        } else {
          options.success({
            statusCode: 200,
            data: { data: path, request_id: `req_200_${path.slice(1)}` },
          });
        }
      };
      if (path === "/two" && options.header.Authorization === "Bearer old") {
        setTimeout(respond, 5);
      } else {
        queueMicrotask(respond);
      }
    });
    const refreshSession = vi.fn(async () => {
      await Promise.resolve();
      accessToken = "new";
    });
    const client = createClient(request, {
      getSession: () => ({ access_token: accessToken }),
      refreshSession,
    });

    await expect(Promise.all([client.get("/one"), client.get("/two")])).resolves.toEqual([
      "/one",
      "/two",
    ]);
    expect(refreshSession).toHaveBeenCalledOnce();
    expect(attempts).toEqual(
      new Map([
        ["/one", 2],
        ["/two", 2],
      ]),
    );
  });

  it("does not refresh when auth is disabled or refresh a replay twice", async () => {
    const refreshSession = vi.fn(async () => undefined);
    const request = vi.fn((options) =>
      options.success({
        statusCode: 401,
        data: {
          error: { code: "UNAUTHORIZED", message: "No" },
          request_id: "req_401",
        },
      }),
    );
    const client = createClient(request, { refreshSession });
    await expect(client.get("/auth", { auth: false })).rejects.toMatchObject({ statusCode: 401 });
    await expect(client.get("/private")).rejects.toMatchObject({ statusCode: 401 });
    expect(refreshSession).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("falls back to one shared reauthentication when refresh fails", async () => {
    let accessToken = "old";
    const calls = new Map();
    const request = vi.fn((options) => {
      const path = new URL(options.url).pathname;
      calls.set(path, (calls.get(path) || 0) + 1);
      queueMicrotask(() => {
        if (options.header.Authorization === "Bearer old") {
          options.success({
            statusCode: 401,
            data: {
              error: { code: "UNAUTHORIZED", message: "Expired" },
              request_id: `req_old_${path.slice(1)}`,
            },
          });
        } else {
          options.success({
            statusCode: 200,
            data: { data: path, request_id: `req_new_${path.slice(1)}` },
          });
        }
      });
    });
    const refreshSession = vi.fn(async () => {
      throw Object.assign(new Error("refresh failed"), { code: "REFRESH_DENIED" });
    });
    const reauthenticate = vi.fn(async () => {
      await Promise.resolve();
      accessToken = "new";
    });
    const client = createClient(request, {
      getSession: () => ({ access_token: accessToken }),
      refreshSession,
      reauthenticate,
    });

    await expect(Promise.all([client.get("/one"), client.get("/two")])).resolves.toEqual([
      "/one",
      "/two",
    ]);
    expect(refreshSession).toHaveBeenCalledOnce();
    expect(reauthenticate).toHaveBeenCalledOnce();
    expect(calls).toEqual(
      new Map([
        ["/one", 2],
        ["/two", 2],
      ]),
    );
  });

  it("shares the complete refresh-to-reauthentication chain with a staggered 401", async () => {
    const userA = "11111111-1111-4111-8111-111111111111";
    const oldSession = canonicalIdentitySession(userA, "o");
    const newSession = canonicalIdentitySession(userA, "n");
    let session = oldSession;
    let releaseSecondUnauthorized;
    let releaseReauthentication;
    let markReauthenticationStarted;
    const reauthenticationStarted = new Promise((resolve) => {
      markReauthenticationStarted = resolve;
    });
    const attempts = new Map();
    const anonymousReplays = [];
    const request = vi.fn((options) => {
      const path = new URL(options.url).pathname;
      attempts.set(path, (attempts.get(path) || 0) + 1);
      const respond = () => {
        if (options.header.Authorization === `Bearer ${newSession.access_token}`) {
          options.success({
            statusCode: 200,
            data: { data: path, request_id: `req_new_${path.slice(1)}` },
          });
          return;
        }
        if (!options.header.Authorization) {
          anonymousReplays.push(path);
        }
        options.success({
          statusCode: 401,
          data: {
            error: { code: "UNAUTHORIZED", message: "Expired" },
            request_id: `req_old_${path.slice(1)}`,
          },
        });
      };
      if (
        path === "/two" &&
        options.header.Authorization === `Bearer ${oldSession.access_token}`
      ) {
        releaseSecondUnauthorized = respond;
      } else {
        queueMicrotask(respond);
      }
    });
    const refreshSession = vi.fn(async () => {
      session = null;
      throw new Error("refresh failed");
    });
    const reauthenticate = vi.fn(
      () =>
        new Promise((resolve) => {
          markReauthenticationStarted();
          releaseReauthentication = () => {
            session = newSession;
            resolve();
          };
        }),
    );
    const client = createClient(request, {
      getSession: () => session,
      refreshSession,
      reauthenticate,
    });

    const first = client.get("/one");
    const second = client.get("/two");
    const resultsPromise = Promise.allSettled([first, second]);
    await reauthenticationStarted;
    releaseSecondUnauthorized();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const secondAttemptsBeforeRecovery = attempts.get("/two");
    releaseReauthentication();

    const results = await resultsPromise;
    expect(secondAttemptsBeforeRecovery).toBe(1);
    expect(results).toEqual([
      { status: "fulfilled", value: "/one" },
      { status: "fulfilled", value: "/two" },
    ]);
    expect(refreshSession).toHaveBeenCalledOnce();
    expect(reauthenticate).toHaveBeenCalledOnce();
    expect(anonymousReplays).toEqual([]);
    expect(attempts).toEqual(
      new Map([
        ["/one", 2],
        ["/two", 2],
      ]),
    );
  });

  it("does not start login when a bound session is cleared without an in-flight recovery", async () => {
    const userA = "11111111-1111-4111-8111-111111111111";
    let session = canonicalIdentitySession(userA, "a");
    const request = vi.fn((options) => {
      session = null;
      options.success({
        statusCode: 401,
        data: {
          error: { code: "UNAUTHORIZED", message: "Expired" },
          request_id: "req_cleared",
        },
      });
    });
    const refreshSession = vi.fn();
    const reauthenticate = vi.fn();
    const client = createClient(request, {
      getSession: () => session,
      refreshSession,
      reauthenticate,
    });

    await expect(client.get("/private")).rejects.toMatchObject({
      code: "AUTH_SESSION_CHANGED",
      message: "Session identity changed",
    });
    expect(refreshSession).not.toHaveBeenCalled();
    expect(reauthenticate).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });

  it("replays a late old-token 401 with an already recovered nonempty token", async () => {
    let accessToken = "old";
    let releaseLateUnauthorized;
    const attempts = new Map();
    const request = vi.fn((options) => {
      const path = new URL(options.url).pathname;
      attempts.set(path, (attempts.get(path) || 0) + 1);
      const respond = () => {
        if (options.header.Authorization === "Bearer new") {
          options.success({
            statusCode: 200,
            data: { data: path, request_id: `req_new_${path.slice(1)}` },
          });
        } else {
          options.success({
            statusCode: 401,
            data: {
              error: { code: "UNAUTHORIZED", message: "Expired" },
              request_id: `req_old_${path.slice(1)}`,
            },
          });
        }
      };
      if (path === "/late" && options.header.Authorization === "Bearer old") {
        releaseLateUnauthorized = respond;
      } else {
        queueMicrotask(respond);
      }
    });
    const refreshSession = vi.fn(async () => {
      accessToken = "new";
    });
    const reauthenticate = vi.fn();
    const client = createClient(request, {
      getSession: () => ({ access_token: accessToken }),
      refreshSession,
      reauthenticate,
    });

    const early = client.get("/early");
    const late = client.get("/late");
    await expect(early).resolves.toBe("/early");
    releaseLateUnauthorized();
    await expect(late).resolves.toBe("/late");
    expect(refreshSession).toHaveBeenCalledOnce();
    expect(reauthenticate).not.toHaveBeenCalled();
    expect(attempts).toEqual(
      new Map([
        ["/early", 2],
        ["/late", 2],
      ]),
    );
  });

  it("refresh failure performs one wx.login and replays the request exactly once", async () => {
    const oldSession = {
      access_token: "o".repeat(32),
      access_expires_in: 120,
      refresh_token: "r".repeat(32),
      refresh_expires_in: 600,
      user: { id: "11111111-1111-4111-8111-111111111111" },
    };
    const newSession = {
      ...oldSession,
      access_token: "n".repeat(32),
      refresh_token: "s".repeat(32),
    };
    let stored = oldSession;
    const wxApi = {
      getStorageSync: () => stored,
      setStorageSync: (_key, value) => {
        stored = value;
      },
      removeStorageSync: () => {
        stored = undefined;
      },
      login: vi.fn(({ success }) => success({ code: "new-login-code" })),
      request: vi.fn((options) => {
        const authorized = options.header.Authorization === `Bearer ${newSession.access_token}`;
        options.success(
          authorized
            ? { statusCode: 200, data: { data: "ok", request_id: "req_ok" } }
            : {
                statusCode: 401,
                data: {
                  error: { code: "UNAUTHORIZED", message: "Expired" },
                  request_id: "req_old",
                },
              },
        );
      }),
    };
    const authService = {
      refresh: vi.fn(async () => {
        throw new Error("expired refresh");
      }),
      login: vi.fn(async () => newSession),
    };
    const store = createSessionStore({ wxApi, authService, storageKey: "session" });
    const client = createRequestClient({
      wxApi,
      getRuntimeConfig: () => ({
        apiBaseUrl: "https://api.example.com",
        envVersion: "trial",
      }),
      getSession: store.get,
      refreshSession: store.refreshSession,
      ensureSession: store.ensureSession,
      createRequestId: () => "req_client",
    });

    await expect(client.get("/private")).resolves.toBe("ok");
    expect(wxApi.login).toHaveBeenCalledOnce();
    expect(authService.login).toHaveBeenCalledOnce();
    expect(wxApi.request).toHaveBeenCalledTimes(2);
  });

  it("throws a stable error when reauthentication fails", async () => {
    const request = vi.fn((options) =>
      options.success({
        statusCode: 401,
        data: {
          error: { code: "UNAUTHORIZED", message: "Expired" },
          request_id: "req_unauthorized",
        },
      }),
    );
    const refreshSession = vi.fn(async () => {
      throw new Error("refresh secret");
    });
    const reauthenticate = vi.fn(async () => {
      throw new Error("login secret");
    });
    const clearSession = vi.fn();
    const client = createClient(request, { refreshSession, reauthenticate, clearSession });

    await expect(client.get("/private")).rejects.toMatchObject({
      code: "AUTH_REAUTHENTICATION_FAILED",
      message: "Authentication failed",
    });
    expect(refreshSession).toHaveBeenCalledOnce();
    expect(reauthenticate).toHaveBeenCalledOnce();
    expect(clearSession).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not reauthenticate after an explicit session-operation cancellation", async () => {
    const request = vi.fn((options) =>
      options.success({
        statusCode: 401,
        data: {
          error: { code: "UNAUTHORIZED", message: "Expired" },
          request_id: "req_unauthorized",
        },
      }),
    );
    const cancellation = Object.assign(new Error("Session operation cancelled"), {
      code: "AUTH_SESSION_OPERATION_CANCELLED",
    });
    const refreshSession = vi.fn(async () => {
      throw cancellation;
    });
    const reauthenticate = vi.fn();
    const clearSession = vi.fn();
    const client = createClient(request, { refreshSession, reauthenticate, clearSession });

    await expect(client.get("/private")).rejects.toMatchObject({
      code: "AUTH_SESSION_OPERATION_CANCELLED",
      message: "Session operation cancelled",
    });
    expect(reauthenticate).not.toHaveBeenCalled();
    expect(clearSession).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not replay a POST body after the active user changes", async () => {
    const userA = "11111111-1111-4111-8111-111111111111";
    const userB = "22222222-2222-4222-8222-222222222222";
    let session = identitySession(userA, "token-a");
    const request = vi.fn((options) => {
      session = identitySession(userB, "token-b");
      options.success({
        statusCode: 401,
        data: {
          error: { code: "UNAUTHORIZED", message: "Expired" },
          request_id: "req_user_a",
        },
      });
    });
    const refreshSession = vi.fn();
    const reauthenticate = vi.fn();
    const client = createClient(request, {
      getSession: () => session,
      refreshSession,
      reauthenticate,
    });

    await expect(client.post("/booking", { private: "user-a-body" })).rejects.toMatchObject({
      code: "AUTH_SESSION_CHANGED",
      message: "Session identity changed",
    });
    expect(request).toHaveBeenCalledOnce();
    expect(refreshSession).not.toHaveBeenCalled();
    expect(reauthenticate).not.toHaveBeenCalled();
  });

  it("does not replay after recovery authenticates a different user", async () => {
    const userA = "11111111-1111-4111-8111-111111111111";
    const userB = "22222222-2222-4222-8222-222222222222";
    let session = identitySession(userA, "token-a");
    const request = vi.fn((options) =>
      options.success({
        statusCode: 401,
        data: {
          error: { code: "UNAUTHORIZED", message: "Expired" },
          request_id: "req_user_a",
        },
      }),
    );
    const refreshSession = vi.fn(async () => {
      session = null;
      throw new Error("refresh failed");
    });
    const reauthenticate = vi.fn(async () => {
      session = identitySession(userB, "token-b");
    });
    const client = createClient(request, {
      getSession: () => session,
      refreshSession,
      reauthenticate,
    });

    await expect(client.get("/private")).rejects.toMatchObject({
      code: "AUTH_SESSION_CHANGED",
      message: "Session identity changed",
    });
    expect(refreshSession).toHaveBeenCalledOnce();
    expect(reauthenticate).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  });

  it("replays once when recovery rotates a token for the same user", async () => {
    const userA = "11111111-1111-4111-8111-111111111111";
    let session = identitySession(userA, "token-old");
    const request = vi.fn((options) =>
      options.success(
        options.header.Authorization === "Bearer token-new"
          ? { statusCode: 200, data: { data: "ok", request_id: "req_new" } }
          : {
              statusCode: 401,
              data: {
                error: { code: "UNAUTHORIZED", message: "Expired" },
                request_id: "req_old",
              },
            },
      ),
    );
    const refreshSession = vi.fn(async () => {
      session = identitySession(userA, "token-new");
    });
    const client = createClient(request, {
      getSession: () => session,
      refreshSession,
    });

    await expect(client.get("/private")).resolves.toBe("ok");
    expect(refreshSession).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("allows an initially anonymous request to replay once after login", async () => {
    const userA = "11111111-1111-4111-8111-111111111111";
    let session = null;
    const request = vi.fn((options) =>
      options.success(
        options.header.Authorization === "Bearer token-new"
          ? { statusCode: 200, data: { data: "ok", request_id: "req_new" } }
          : {
              statusCode: 401,
              data: {
                error: { code: "UNAUTHORIZED", message: "Login required" },
                request_id: "req_anonymous",
              },
            },
      ),
    );
    const refreshSession = vi.fn(async () => {
      throw new Error("no refresh session");
    });
    const reauthenticate = vi.fn(async () => {
      session = identitySession(userA, "token-new");
    });
    const client = createClient(request, {
      getSession: () => session,
      refreshSession,
      reauthenticate,
    });

    await expect(client.get("/private")).resolves.toBe("ok");
    expect(refreshSession).toHaveBeenCalledOnce();
    expect(reauthenticate).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not dispatch again when the user changes after recovery validation", async () => {
    const userA = "11111111-1111-4111-8111-111111111111";
    const userB = "22222222-2222-4222-8222-222222222222";
    let session = identitySession(userA, "token-old-a");
    let recoveryFinished = false;
    let switchScheduled = false;
    const getSession = vi.fn(() => {
      const current = session;
      if (recoveryFinished && !switchScheduled) {
        switchScheduled = true;
        queueMicrotask(() => {
          session = identitySession(userB, "token-b");
        });
      }
      return current;
    });
    const request = vi.fn((options) =>
      options.success(
        options.header.Authorization === "Bearer token-old-a"
          ? {
              statusCode: 401,
              data: {
                error: { code: "UNAUTHORIZED", message: "Expired" },
                request_id: "req_old",
              },
            }
          : { statusCode: 200, data: { data: "wrong-user", request_id: "req_b" } },
      ),
    );
    const refreshSession = vi.fn(async () => {
      session = identitySession(userA, "token-new-a");
      recoveryFinished = true;
    });
    const client = createClient(request, { getSession, refreshSession });

    await expect(client.get("/private")).rejects.toMatchObject({
      code: "AUTH_SESSION_CHANGED",
      message: "Session identity changed",
    });
    expect(refreshSession).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  });

  it("discards a successful response when the user changes while it is in flight", async () => {
    const userA = "11111111-1111-4111-8111-111111111111";
    const userB = "22222222-2222-4222-8222-222222222222";
    let session = identitySession(userA, "token-a");
    let releaseResponse;
    let markRequestStarted;
    const requestStarted = new Promise((resolve) => {
      markRequestStarted = resolve;
    });
    const request = vi.fn((options) => {
      releaseResponse = () =>
        options.success({
          statusCode: 200,
          data: { data: "user-a-data", request_id: "req_a" },
        });
      markRequestStarted();
    });
    const client = createClient(request, { getSession: () => session });

    const result = client.get("/private");
    await requestStarted;
    session = identitySession(userB, "token-b");
    releaseResponse();

    await expect(result).rejects.toMatchObject({
      code: "AUTH_SESSION_CHANGED",
      message: "Session identity changed",
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("refreshes after a GET network retry receives 401 with its latest attempted token", async () => {
    const userA = "11111111-1111-4111-8111-111111111111";
    let session = identitySession(userA, "token-old-a");
    const request = vi.fn((options) => {
      if (options.header.Authorization === "Bearer token-old-a") {
        session = identitySession(userA, "token-mid-a");
        options.fail({ errMsg: "network failed" });
      } else if (options.header.Authorization === "Bearer token-mid-a") {
        options.success({
          statusCode: 401,
          data: {
            error: { code: "UNAUTHORIZED", message: "Expired" },
            request_id: "req_mid",
          },
        });
      } else {
        options.success({
          statusCode: 200,
          data: { data: "ok", request_id: "req_new" },
        });
      }
    });
    const refreshSession = vi.fn(async () => {
      session = identitySession(userA, "token-new-a");
    });
    const client = createClient(request, {
      getSession: () => session,
      refreshSession,
    });

    await expect(client.get("/private")).resolves.toBe("ok");
    expect(refreshSession).toHaveBeenCalledOnce();
    expect(request.mock.calls.map(([options]) => options.header.Authorization)).toEqual([
      "Bearer token-old-a",
      "Bearer token-mid-a",
      "Bearer token-new-a",
    ]);
  });
});

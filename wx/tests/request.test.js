import { describe, expect, it, vi } from "vitest";

import requestModule from "../services/request.js";

const { createRequestClient } = requestModule;

function createClient(request, overrides = {}) {
  let requestId = 0;
  return createRequestClient({
    wxApi: { request },
    getRuntimeConfig: () => ({ apiBaseUrl: "https://api.example.com", envVersion: "trial" }),
    getSession: () => null,
    refreshSession: async () => undefined,
    createRequestId: () => `req_${++requestId}`,
    ...overrides,
  });
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
      "https://evil.test",
    ]) {
      await expect(client.get(path)).rejects.toMatchObject({ code: "INVALID_REQUEST_PATH" });
    }
    expect(request).not.toHaveBeenCalled();
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
});

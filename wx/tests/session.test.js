import { describe, expect, it, vi } from "vitest";

import sessionModule from "../stores/session.js";

const { createLoginCodeProvider, createSessionStore } = sessionModule;

function makeSession(marker = "a") {
  return {
    access_token: marker.repeat(32),
    access_expires_in: 120,
    refresh_token: marker.toUpperCase().repeat(32),
    refresh_expires_in: 600,
    user: { id: "11111111-1111-4111-8111-111111111111" },
  };
}

function createStorageWx(legacy) {
  let stored = legacy;
  return {
    login: vi.fn(),
    getStorageSync: vi.fn(() => stored),
    setStorageSync: vi.fn((_key, value) => {
      stored = value;
    }),
    removeStorageSync: vi.fn(() => {
      stored = undefined;
    }),
    stored: () => stored,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function expectNoTokenStorage(wxApi) {
  expect(wxApi.getStorageSync).not.toHaveBeenCalled();
  expect(wxApi.setStorageSync).not.toHaveBeenCalled();
  expect(JSON.stringify(wxApi.stored()) || "").not.toMatch(/access_token|refresh_token/);
}

describe("session store", () => {
  it("uses a deterministic mock code only for the explicit develop adapter", async () => {
    const wxApi = createStorageWx();
    const mockProvider = createLoginCodeProvider({
      wxApi,
      getRuntimeConfig: () => ({ envVersion: "develop", identityProvider: "mock" }),
    });
    const wechatProvider = createLoginCodeProvider({
      wxApi,
      getRuntimeConfig: () => ({ envVersion: "develop", identityProvider: "wechat" }),
    });
    wxApi.login.mockImplementation(({ success }) => success({ code: "real-wechat-code" }));

    await expect(mockProvider()).resolves.toBe("mock:wechatide-local-user");
    expect(wxApi.login).not.toHaveBeenCalled();
    await expect(wechatProvider()).resolves.toBe("real-wechat-code");
    expect(wxApi.login).toHaveBeenCalledOnce();
  });

  it("deletes a legacy stored session and performs a fresh login on cold start", async () => {
    const legacy = makeSession("a");
    const next = makeSession("b");
    const wxApi = createStorageWx(legacy);
    wxApi.login.mockImplementation(({ success }) =>
      queueMicrotask(() => success({ code: "temporary-login-code" })),
    );
    const authService = {
      login: vi.fn(async () => next),
      refresh: vi.fn(),
    };
    const store = createSessionStore({ wxApi, authService, storageKey: "session" });

    expect(store.get()).toBeNull();
    expect(wxApi.removeStorageSync).toHaveBeenCalledOnce();
    await expect(store.ensureSession()).resolves.toEqual(next);
    expect(store.get()).toEqual(next);
    expect(wxApi.login).toHaveBeenCalledOnce();
    expect(authService.login).toHaveBeenCalledWith("temporary-login-code");
    expectNoTokenStorage(wxApi);
  });

  it("merges concurrent login exchanges and keeps tokens only in memory", async () => {
    const wxApi = createStorageWx();
    wxApi.login.mockImplementation(({ success }) =>
      queueMicrotask(() => success({ code: "temporary-login-code" })),
    );
    const next = makeSession("c");
    const authService = {
      login: vi.fn(async () => next),
      refresh: vi.fn(),
    };
    const store = createSessionStore({ wxApi, authService, storageKey: "session" });

    await expect(Promise.all([store.ensureSession(), store.ensureSession()])).resolves.toEqual([
      next,
      next,
    ]);
    expect(wxApi.login).toHaveBeenCalledOnce();
    expect(authService.login).toHaveBeenCalledOnce();
    expect(store.get()).toEqual(next);
    expectNoTokenStorage(wxApi);
  });

  it("throws a safe login error when wx.login fails or returns no code", async () => {
    for (const implementation of [
      ({ fail }) => fail({ errMsg: "private failure" }),
      ({ success }) => success({}),
    ]) {
      const wxApi = createStorageWx();
      wxApi.login.mockImplementation(implementation);
      const store = createSessionStore({
        wxApi,
        authService: { login: vi.fn(), refresh: vi.fn() },
        storageKey: "session",
      });
      await expect(store.ensureSession()).rejects.toMatchObject({
        code: "AUTH_LOGIN_FAILED",
        message: "WeChat login failed",
      });
      expect(store.get()).toBeNull();
      expect(wxApi.removeStorageSync).toHaveBeenCalledWith("session");
      expectNoTokenStorage(wxApi);
    }
  });

  it("merges concurrent refreshes and rotates the in-memory session", async () => {
    const current = makeSession("d");
    const next = makeSession("e");
    const wxApi = createStorageWx();
    const authService = {
      login: vi.fn(),
      refresh: vi.fn(async () => {
        await Promise.resolve();
        return next;
      }),
    };
    const store = createSessionStore({ wxApi, authService, storageKey: "session" });
    store.set(current);

    await expect(Promise.all([store.refreshSession(), store.refreshSession()])).resolves.toEqual([
      next,
      next,
    ]);
    expect(authService.refresh).toHaveBeenCalledOnce();
    expect(authService.refresh).toHaveBeenCalledWith(current.refresh_token);
    expect(store.get()).toEqual(next);
    expectNoTokenStorage(wxApi);
  });

  it("clears memory and the legacy key when refresh fails", async () => {
    const wxApi = createStorageWx();
    const authService = {
      login: vi.fn(),
      refresh: vi.fn(async () => {
        throw Object.assign(new Error("Denied"), { code: "REFRESH_DENIED" });
      }),
    };
    const store = createSessionStore({ wxApi, authService, storageKey: "session" });
    store.set(makeSession("f"));

    await expect(store.refreshSession()).rejects.toMatchObject({ code: "REFRESH_DENIED" });
    expect(store.get()).toBeNull();
    expect(wxApi.removeStorageSync).toHaveBeenCalledTimes(2);
    expectNoTokenStorage(wxApi);
  });

  it("validates explicit values in memory and clear deletes the legacy key again", () => {
    const wxApi = createStorageWx();
    const store = createSessionStore({
      wxApi,
      authService: { login: vi.fn(), refresh: vi.fn() },
      storageKey: "session",
    });
    expect(() => store.set({ access_token: "secret" })).toThrowError(
      expect.objectContaining({ code: "INVALID_API_RESPONSE" }),
    );
    const expected = makeSession("g");
    expect(store.set(expected)).toEqual(expected);
    expect(() =>
      store.set({
        ...expected,
        code: "temporary-secret",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_API_RESPONSE" }));
    expect(store.get()).toEqual(expected);
    store.clear();
    expect(store.get()).toBeNull();
    expect(wxApi.removeStorageSync).toHaveBeenCalledTimes(2);
    expectNoTokenStorage(wxApi);
  });

  it("fails safely without reading a legacy token when cleanup fails", async () => {
    const wxApi = createStorageWx(makeSession("h"));
    wxApi.removeStorageSync.mockImplementation(() => {
      throw new Error("storage path and token secret");
    });
    const authService = { login: vi.fn(), refresh: vi.fn() };
    const store = createSessionStore({ wxApi, authService, storageKey: "session" });

    expect(() => store.get()).toThrowError(
      expect.objectContaining({
        code: "AUTH_SESSION_STORAGE_CLEANUP_FAILED",
        message: "Session storage cleanup failed",
      }),
    );
    await expect(Promise.resolve().then(() => store.ensureSession())).rejects.toMatchObject({
      code: "AUTH_SESSION_STORAGE_CLEANUP_FAILED",
      message: "Session storage cleanup failed",
    });
    expect(wxApi.login).not.toHaveBeenCalled();
    expect(authService.login).not.toHaveBeenCalled();
    expect(wxApi.getStorageSync).not.toHaveBeenCalled();
    expect(wxApi.setStorageSync).not.toHaveBeenCalled();
  });

  it("does not revive a session when clear wins over an in-flight refresh", async () => {
    const current = makeSession("i");
    const next = makeSession("j");
    const pending = deferred();
    const wxApi = createStorageWx();
    const authService = {
      login: vi.fn(),
      refresh: vi.fn(() => pending.promise),
    };
    const store = createSessionStore({ wxApi, authService, storageKey: "session" });
    store.set(current);

    const refresh = store.refreshSession();
    await vi.waitFor(() => expect(authService.refresh).toHaveBeenCalledOnce());
    store.clear();
    pending.resolve(next);

    await expect(refresh).rejects.toMatchObject({
      code: "AUTH_SESSION_OPERATION_CANCELLED",
      message: "Session operation cancelled",
    });
    expect(store.get()).toBeNull();
    expectNoTokenStorage(wxApi);
  });

  it("does not revive a session when clear wins over an in-flight login", async () => {
    const next = makeSession("k");
    const pending = deferred();
    const wxApi = createStorageWx();
    wxApi.login.mockImplementation(({ success }) => success({ code: "temporary-code" }));
    const authService = {
      login: vi.fn(() => pending.promise),
      refresh: vi.fn(),
    };
    const store = createSessionStore({ wxApi, authService, storageKey: "session" });

    const login = store.ensureSession();
    await vi.waitFor(() => expect(authService.login).toHaveBeenCalledOnce());
    store.clear();
    pending.resolve(next);

    await expect(login).rejects.toMatchObject({
      code: "AUTH_SESSION_OPERATION_CANCELLED",
      message: "Session operation cancelled",
    });
    expect(store.get()).toBeNull();
    expectNoTokenStorage(wxApi);
  });

  it("does not let an old refresh overwrite an explicitly set session", async () => {
    const pending = deferred();
    const explicit = makeSession("l");
    const stale = makeSession("m");
    const wxApi = createStorageWx();
    const authService = {
      login: vi.fn(),
      refresh: vi.fn(() => pending.promise),
    };
    const store = createSessionStore({ wxApi, authService, storageKey: "session" });
    store.set(makeSession("n"));

    const refresh = store.refreshSession();
    await vi.waitFor(() => expect(authService.refresh).toHaveBeenCalledOnce());
    store.set(explicit);
    pending.resolve(stale);

    await expect(refresh).rejects.toMatchObject({
      code: "AUTH_SESSION_OPERATION_CANCELLED",
      message: "Session operation cancelled",
    });
    expect(store.get()).toEqual(explicit);
    expectNoTokenStorage(wxApi);
  });
});

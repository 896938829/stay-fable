import { describe, expect, it, vi } from "vitest";

import sessionModule from "../stores/session.js";

const { createSessionStore } = sessionModule;

function makeSession(marker = "a") {
  return {
    access_token: marker.repeat(32),
    access_expires_in: 120,
    refresh_token: marker.toUpperCase().repeat(32),
    refresh_expires_in: 600,
    user: { id: "11111111-1111-4111-8111-111111111111" },
  };
}

function createStorageWx(initial) {
  let stored = initial;
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

describe("session store", () => {
  it("uses a valid stored session without logging in", async () => {
    const expected = makeSession();
    const wxApi = createStorageWx({
      ...expected,
      code: "persisted-secret",
      user: { ...expected.user, secret: "private" },
    });
    const authService = { login: vi.fn(), refresh: vi.fn() };
    const store = createSessionStore({ wxApi, authService, storageKey: "session" });
    expect(store.get()).toEqual(expected);
    expect(wxApi.stored()).toEqual(expected);
    expect(JSON.stringify(wxApi.stored())).not.toContain("secret");
    await expect(store.ensureSession()).resolves.toEqual(expected);
    expect(wxApi.login).not.toHaveBeenCalled();
  });

  it("merges concurrent login exchanges and never stores the code", async () => {
    const wxApi = createStorageWx();
    wxApi.login.mockImplementation(({ success }) =>
      queueMicrotask(() => success({ code: "temporary-login-code" })),
    );
    const next = makeSession("b");
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
    expect(JSON.stringify(wxApi.stored())).not.toContain("temporary-login-code");
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
      expect(wxApi.removeStorageSync).toHaveBeenCalledWith("session");
    }
  });

  it("merges concurrent refreshes and stores the rotated session", async () => {
    const current = makeSession("c");
    const next = makeSession("d");
    const wxApi = createStorageWx(current);
    const authService = {
      login: vi.fn(),
      refresh: vi.fn(async () => {
        await Promise.resolve();
        return next;
      }),
    };
    const store = createSessionStore({ wxApi, authService, storageKey: "session" });
    await expect(Promise.all([store.refreshSession(), store.refreshSession()])).resolves.toEqual([
      next,
      next,
    ]);
    expect(authService.refresh).toHaveBeenCalledOnce();
    expect(authService.refresh).toHaveBeenCalledWith(current.refresh_token);
    expect(wxApi.stored()).toEqual(next);
  });

  it("clears memory and storage when refresh fails", async () => {
    const wxApi = createStorageWx(makeSession("e"));
    const authService = {
      login: vi.fn(),
      refresh: vi.fn(async () => {
        throw Object.assign(new Error("Denied"), { code: "REFRESH_DENIED" });
      }),
    };
    const store = createSessionStore({ wxApi, authService, storageKey: "session" });
    await expect(store.refreshSession()).rejects.toMatchObject({ code: "REFRESH_DENIED" });
    expect(store.get()).toBeNull();
    expect(wxApi.removeStorageSync).toHaveBeenCalledWith("session");
  });

  it("validates set values and clear removes only the session key", () => {
    const wxApi = createStorageWx();
    const store = createSessionStore({
      wxApi,
      authService: { login: vi.fn(), refresh: vi.fn() },
      storageKey: "session",
    });
    expect(() => store.set({ access_token: "secret" })).toThrowError(
      expect.objectContaining({ code: "INVALID_API_RESPONSE" }),
    );
    store.set({
      ...makeSession(),
      code: "temporary-secret",
      user: { ...makeSession().user, secret: "private" },
    });
    expect(JSON.stringify(wxApi.stored())).not.toContain("temporary-secret");
    expect(JSON.stringify(wxApi.stored())).not.toContain("private");
    store.clear();
    expect(wxApi.removeStorageSync).toHaveBeenCalledWith("session");
  });
});

"use strict";

const { assertAuthSession } = require("../services/contracts");

const DEFAULT_STORAGE_KEY = "stay-fable:session";

function loginError() {
  const error = new Error("WeChat login failed");
  error.code = "AUTH_LOGIN_FAILED";
  return error;
}

function refreshError() {
  const error = new Error("Session refresh failed");
  error.code = "AUTH_REFRESH_FAILED";
  return error;
}

function operationCancelledError() {
  const error = new Error("Session operation cancelled");
  error.code = "AUTH_SESSION_OPERATION_CANCELLED";
  return error;
}

function wechatLogin(wxApi) {
  return new Promise((resolve, reject) => {
    try {
      wxApi.login({
        success(result) {
          if (!result || typeof result.code !== "string" || result.code.trim() === "") {
            reject(loginError());
            return;
          }
          resolve(result.code);
        },
        fail() {
          reject(loginError());
        },
      });
    } catch {
      reject(loginError());
    }
  });
}

function createSessionStore(options) {
  const { wxApi, authService } = options;
  const storageKey = options.storageKey || DEFAULT_STORAGE_KEY;
  let memory;
  let loaded = false;
  let ensurePromise;
  let refreshPromise;
  let generation = 0;

  function clear() {
    generation += 1;
    memory = null;
    loaded = true;
    wxApi.removeStorageSync(storageKey);
  }

  function set(session) {
    const canonical = assertAuthSession(session);
    wxApi.setStorageSync(storageKey, canonical);
    memory = canonical;
    loaded = true;
    generation += 1;
    return canonical;
  }

  function commit(session, operationGeneration) {
    if (generation !== operationGeneration) {
      throw operationCancelledError();
    }
    const canonical = assertAuthSession(session);
    wxApi.setStorageSync(storageKey, canonical);
    memory = canonical;
    loaded = true;
    generation += 1;
    return canonical;
  }

  function get() {
    if (loaded) {
      return memory;
    }
    loaded = true;
    const stored = wxApi.getStorageSync(storageKey);
    if (stored === undefined || stored === null || stored === "") {
      memory = null;
      return memory;
    }
    try {
      memory = assertAuthSession(stored);
      wxApi.setStorageSync(storageKey, memory);
    } catch {
      memory = null;
      wxApi.removeStorageSync(storageKey);
    }
    return memory;
  }

  function ensureSession() {
    const existing = get();
    if (existing) {
      return Promise.resolve(existing);
    }
    if (!ensurePromise) {
      const operationGeneration = generation;
      ensurePromise = (async () => {
        try {
          const code = await wechatLogin(wxApi);
          if (generation !== operationGeneration) {
            throw operationCancelledError();
          }
          const session = await authService.login(code);
          return commit(session, operationGeneration);
        } catch (error) {
          if (
            error.code === "AUTH_SESSION_OPERATION_CANCELLED" ||
            generation !== operationGeneration
          ) {
            throw operationCancelledError();
          }
          clear();
          throw error;
        }
      })().finally(() => {
        ensurePromise = undefined;
      });
    }
    return ensurePromise;
  }

  function refreshSession() {
    if (!refreshPromise) {
      const operationGeneration = generation;
      refreshPromise = (async () => {
        const current = get();
        if (!current) {
          throw refreshError();
        }
        try {
          const session = await authService.refresh(current.refresh_token);
          return commit(session, operationGeneration);
        } catch (error) {
          if (
            error.code === "AUTH_SESSION_OPERATION_CANCELLED" ||
            generation !== operationGeneration
          ) {
            throw operationCancelledError();
          }
          clear();
          throw error;
        }
      })().finally(() => {
        refreshPromise = undefined;
      });
    }
    return refreshPromise;
  }

  return {
    clear,
    ensureSession,
    get,
    refreshSession,
    set,
  };
}

let defaultStore;

function getDefaultStore() {
  if (!defaultStore) {
    const wxApi = {
      getStorageSync(key) {
        return globalThis.wx.getStorageSync(key);
      },
      login(options) {
        return globalThis.wx.login(options);
      },
      removeStorageSync(key) {
        return globalThis.wx.removeStorageSync(key);
      },
      setStorageSync(key, value) {
        return globalThis.wx.setStorageSync(key, value);
      },
    };
    defaultStore = createSessionStore({
      wxApi,
      authService: require("../services/auth"),
      storageKey: DEFAULT_STORAGE_KEY,
    });
  }
  return defaultStore;
}

module.exports = {
  clear() {
    return getDefaultStore().clear();
  },
  createSessionStore,
  ensureSession() {
    return getDefaultStore().ensureSession();
  },
  get() {
    return getDefaultStore().get();
  },
  refreshSession() {
    return getDefaultStore().refreshSession();
  },
  set(session) {
    return getDefaultStore().set(session);
  },
};

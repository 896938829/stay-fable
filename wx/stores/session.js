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

function storageCleanupError() {
  const error = new Error("Session storage cleanup failed");
  error.code = "AUTH_SESSION_STORAGE_CLEANUP_FAILED";
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

function createLoginCodeProvider(options) {
  const { wxApi, getRuntimeConfig } = options;

  return function loginCode() {
    const runtime = getRuntimeConfig();
    if (runtime.envVersion === "develop" && runtime.identityProvider === "mock") {
      return Promise.resolve("mock:wechatide-local-user");
    }
    return wechatLogin(wxApi);
  };
}

function createSessionStore(options) {
  const { wxApi, authService } = options;
  const loginCodeProvider = options.loginCodeProvider || (() => wechatLogin(wxApi));
  const storageKey = options.storageKey || DEFAULT_STORAGE_KEY;
  let memory = null;
  let initialized = false;
  let ensurePromise;
  let refreshPromise;
  let generation = 0;

  function removeLegacySession() {
    try {
      wxApi.removeStorageSync(storageKey);
    } catch {
      throw storageCleanupError();
    }
  }

  function initialize() {
    if (!initialized) {
      removeLegacySession();
      memory = null;
      initialized = true;
    }
  }

  function clear() {
    generation += 1;
    memory = null;
    removeLegacySession();
    initialized = true;
  }

  function set(session) {
    initialize();
    const canonical = assertAuthSession(session);
    memory = canonical;
    generation += 1;
    return canonical;
  }

  function commit(session, operationGeneration) {
    if (generation !== operationGeneration) {
      throw operationCancelledError();
    }
    const canonical = assertAuthSession(session);
    memory = canonical;
    generation += 1;
    return canonical;
  }

  function get() {
    initialize();
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
          const code = await loginCodeProvider();
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
      login(options) {
        return globalThis.wx.login(options);
      },
      removeStorageSync(key) {
        return globalThis.wx.removeStorageSync(key);
      },
    };
    defaultStore = createSessionStore({
      wxApi,
      authService: require("../services/auth"),
      loginCodeProvider: createLoginCodeProvider({
        wxApi,
        getRuntimeConfig: () => require("../config/runtime").getRuntimeConfig(globalThis.wx),
      }),
      storageKey: DEFAULT_STORAGE_KEY,
    });
  }
  return defaultStore;
}

module.exports = {
  clear() {
    return getDefaultStore().clear();
  },
  createLoginCodeProvider,
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

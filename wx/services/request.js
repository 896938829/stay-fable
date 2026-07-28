"use strict";

const { assertApiErrorResponse, assertEnvelope } = require("./contracts");

function requestError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sessionUserId(session) {
  return session &&
    session.user &&
    typeof session.user.id === "string" &&
    session.user.id !== ""
    ? session.user.id
    : undefined;
}

function assertPath(path) {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw requestError("INVALID_REQUEST_PATH", "Invalid request path");
  }

  let candidate = path;
  for (let depth = 0; depth <= path.length; depth += 1) {
    const pathOnly = candidate.split(/[?#]/, 1)[0];
    const segments = pathOnly.split("/");
    if (
      candidate.includes("//") ||
      candidate.includes("\\") ||
      /(?:^|\/)[A-Za-z][A-Za-z0-9+.-]*:/.test(candidate) ||
      segments.includes(".") ||
      segments.includes("..")
    ) {
      throw requestError("INVALID_REQUEST_PATH", "Invalid request path");
    }

    let decoded;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      throw requestError("INVALID_REQUEST_PATH", "Invalid request path");
    }
    if (decoded === candidate) {
      return;
    }
    candidate = decoded;
  }
  throw requestError("INVALID_REQUEST_PATH", "Invalid request path");
}

function wxRequest(wxApi, options) {
  return new Promise((resolve, reject) => {
    try {
      wxApi.request({
        ...options,
        success: resolve,
        fail() {
          reject(requestError("NETWORK_REQUEST_FAILED", "Network request failed"));
        },
      });
    } catch {
      reject(requestError("NETWORK_REQUEST_FAILED", "Network request failed"));
    }
  });
}

function apiError(response) {
  const parsed = assertApiErrorResponse(response.data);
  const error = new Error(parsed.error.message);
  error.code = parsed.error.code;
  error.requestId = parsed.request_id;
  error.statusCode = response.statusCode;
  if (Object.prototype.hasOwnProperty.call(parsed.error, "details")) {
    error.details = parsed.error.details;
  }
  return error;
}

function createRequestClient(dependencies) {
  const {
    wxApi,
    getRuntimeConfig,
    getSession,
    refreshSession,
    createRequestId,
  } = dependencies;
  const reauthenticate = dependencies.reauthenticate || dependencies.ensureSession;
  const clearSession = dependencies.clearSession;
  let recoveryPromise;

  async function recoverOnce() {
    if (!recoveryPromise) {
      recoveryPromise = Promise.resolve()
        .then(async () => {
          try {
            await refreshSession();
            return;
          } catch (error) {
            if (error && error.code === "AUTH_SESSION_OPERATION_CANCELLED") {
              throw error;
            }
            // A rejected refresh clears the session before the fallback login.
          }
          if (typeof reauthenticate !== "function") {
            throw requestError("AUTH_REAUTHENTICATION_FAILED", "Authentication failed");
          }
          await reauthenticate();
        })
        .catch((error) => {
          if (error && error.code === "AUTH_SESSION_OPERATION_CANCELLED") {
            throw error;
          }
          if (typeof clearSession === "function") {
            try {
              clearSession();
            } catch {
              // Preserve the stable authentication failure even if storage cleanup fails.
            }
          }
          throw requestError("AUTH_REAUTHENTICATION_FAILED", "Authentication failed");
        })
        .finally(() => {
          recoveryPromise = undefined;
        });
    }
    return recoveryPromise;
  }

  async function send(method, path, data, options) {
    assertPath(path);
    const settings = options || {};
    const auth = settings.auth !== false;
    const retry = settings.retry !== false;
    const initialSession = auth ? await Promise.resolve(getSession()) : null;
    let boundUserId = sessionUserId(initialSession);
    const requestId = await Promise.resolve(createRequestId());
    const runtime = getRuntimeConfig(wxApi);

    function assertBoundUser(session) {
      if (boundUserId && sessionUserId(session) !== boundUserId) {
        throw requestError("AUTH_SESSION_CHANGED", "Session identity changed");
      }
    }

    function bindRecoveredUser(session) {
      assertBoundUser(session);
      if (!boundUserId) {
        boundUserId = sessionUserId(session);
      }
    }

    async function dispatch(hasRefreshed) {
      let networkAttempt = 0;
      let response;
      let responseSession;
      let attemptedAccessToken;
      while (true) {
        const session = auth ? await Promise.resolve(getSession()) : null;
        assertBoundUser(session);
        const header = {
          ...(settings.header || {}),
          "x-request-id": requestId,
        };
        if (session && typeof session.access_token === "string") {
          attemptedAccessToken = session.access_token;
          header.Authorization = `Bearer ${attemptedAccessToken}`;
        } else {
          attemptedAccessToken = undefined;
        }
        try {
          response = await wxRequest(wxApi, {
            url: `${runtime.apiBaseUrl}${path}`,
            method,
            data,
            header,
          });
          responseSession = auth ? await Promise.resolve(getSession()) : null;
          assertBoundUser(responseSession);
          break;
        } catch (error) {
          if (
            error &&
            error.code === "NETWORK_REQUEST_FAILED" &&
            method === "GET" &&
            retry &&
            networkAttempt === 0
          ) {
            networkAttempt += 1;
            continue;
          }
          throw error;
        }
      }

      if (response.statusCode >= 200 && response.statusCode < 300) {
        return assertEnvelope(response.data).data;
      }

      const parsedError = apiError(response);
      if (response.statusCode === 401 && auth && !hasRefreshed) {
        const latestAccessToken =
          responseSession && typeof responseSession.access_token === "string"
            ? responseSession.access_token
            : undefined;
        const anotherRecoveryCompleted =
          typeof latestAccessToken === "string" &&
          latestAccessToken !== "" &&
          latestAccessToken !== attemptedAccessToken;
        if (!anotherRecoveryCompleted) {
          await recoverOnce();
          bindRecoveredUser(await Promise.resolve(getSession()));
        } else {
          bindRecoveredUser(responseSession);
        }
        return dispatch(true);
      }
      throw parsedError;
    }

    return dispatch(false);
  }

  return {
    get(path, options) {
      const settings = options || {};
      return send("GET", path, settings.data, settings);
    },
    post(path, data, options) {
      return send("POST", path, data, options);
    },
  };
}

let defaultClient;
let requestSequence = 0;

function defaultRequestId() {
  const { createIdempotencyManager } = require("../utils/idempotency");
  const manager = createIdempotencyManager();
  requestSequence += 1;
  return Promise.resolve(manager.get(String(requestSequence))).then((key) => `req_${key}`);
}

function getDefaultClient() {
  if (!defaultClient) {
    defaultClient = createRequestClient({
      wxApi: {
        request(options) {
          return globalThis.wx.request(options);
        },
      },
      getRuntimeConfig() {
        return require("../config/runtime").getRuntimeConfig(globalThis.wx);
      },
      getSession() {
        return require("../stores/session").get();
      },
      refreshSession() {
        return require("../stores/session").refreshSession();
      },
      ensureSession() {
        return require("../stores/session").ensureSession();
      },
      clearSession() {
        return require("../stores/session").clear();
      },
      createRequestId: defaultRequestId,
    });
  }
  return defaultClient;
}

module.exports = {
  createRequestClient,
  get(path, options) {
    return getDefaultClient().get(path, options);
  },
  post(path, data, options) {
    return getDefaultClient().post(path, data, options);
  },
};

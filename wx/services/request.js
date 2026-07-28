"use strict";

const { assertApiErrorResponse, assertEnvelope } = require("./contracts");

function requestError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertPath(path) {
  const pathOnly = typeof path === "string" ? path.split(/[?#]/, 1)[0] : "";
  let decodedPath = "";
  try {
    decodedPath = decodeURIComponent(pathOnly);
  } catch {
    throw requestError("INVALID_REQUEST_PATH", "Invalid request path");
  }
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("//") ||
    path.includes("\\") ||
    path.includes("://") ||
    decodedPath.split("/").includes("..")
  ) {
    throw requestError("INVALID_REQUEST_PATH", "Invalid request path");
  }
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
  let refreshPromise;

  async function refreshOnce() {
    if (!refreshPromise) {
      refreshPromise = Promise.resolve()
        .then(() => refreshSession())
        .finally(() => {
          refreshPromise = undefined;
        });
    }
    return refreshPromise;
  }

  async function send(method, path, data, options) {
    assertPath(path);
    const settings = options || {};
    const auth = settings.auth !== false;
    const retry = settings.retry !== false;
    const requestId = await Promise.resolve(createRequestId());
    const runtime = getRuntimeConfig(wxApi);

    async function dispatch(hasRefreshed) {
      let networkAttempt = 0;
      let response;
      let attemptedAccessToken;
      while (true) {
        const session = auth ? await Promise.resolve(getSession()) : null;
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
          break;
        } catch (error) {
          if (method === "GET" && retry && networkAttempt === 0) {
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
        const latestSession = await Promise.resolve(getSession());
        const latestAccessToken =
          latestSession && typeof latestSession.access_token === "string"
            ? latestSession.access_token
            : undefined;
        if (latestAccessToken === attemptedAccessToken) {
          await refreshOnce();
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

"use strict";

function safeSessionError(error) {
  const allowedCodes = [
    "AUTH_LOGIN_FAILED",
    "AUTH_REAUTHENTICATION_FAILED",
    "AUTH_REFRESH_FAILED",
    "NETWORK",
    "NETWORK_REQUEST_FAILED",
  ];
  return {
    code: allowedCodes.includes(error && error.code) ? error.code : "SERVICE_UNAVAILABLE",
  };
}

function createAppDefinition(dependencies = {}) {
  const sessionStore = dependencies.sessionStore || require("./stores/session");
  const searchStore = dependencies.searchStore || require("./stores/search");

  return {
    onLaunch() {
      searchStore.initializeDefaults();
      let sessionAttempt;
      try {
        sessionAttempt = sessionStore.ensureSession();
      } catch (error) {
        sessionAttempt = Promise.reject(error);
      }
      this.globalData.sessionReady = Promise.resolve(sessionAttempt).then(
        (session) => ({ session, error: null }),
        (error) => ({ session: null, error: safeSessionError(error) }),
      );
    },
    globalData: {
      sessionStore,
      searchStore,
      sessionReady: null,
    },
  };
}

const definition = createAppDefinition();
if (typeof App === "function") {
  App(definition);
}

module.exports = {
  createAppDefinition,
};

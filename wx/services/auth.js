"use strict";

const { assertAuthSession } = require("./contracts");

function createAuthService(requestClient) {
  return {
    async login(code) {
      const data = await requestClient.post(
        "/auth/wechat/login",
        { code },
        { auth: false, retry: false },
      );
      return assertAuthSession(data);
    },
    async refresh(refreshToken) {
      const data = await requestClient.post(
        "/auth/session/refresh",
        { refresh_token: refreshToken },
        { auth: false, retry: false },
      );
      return assertAuthSession(data);
    },
  };
}

let defaultService;

function getDefaultService() {
  if (!defaultService) {
    defaultService = createAuthService(require("./request"));
  }
  return defaultService;
}

module.exports = {
  createAuthService,
  login(code) {
    return getDefaultService().login(code);
  },
  refresh(refreshToken) {
    return getDefaultService().refresh(refreshToken);
  },
};

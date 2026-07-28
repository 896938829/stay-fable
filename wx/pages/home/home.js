"use strict";

const { locationFailureToAction, toHomeView } = require("./home.logic");

function modalResult(wxApi) {
  return new Promise((resolve) => {
    try {
      wxApi.showModal({
        title: "使用当前位置",
        content: "位置信息仅用于匹配附近已开通城市，不会保存您的坐标。",
        confirmText: "继续定位",
        cancelText: "手动选择",
        success: resolve,
        fail: () => resolve({ confirm: false }),
      });
    } catch {
      resolve({ confirm: false });
    }
  });
}

function currentLocation(wxApi, setTimer, clearTimer) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer(timer);
      callback(value);
    };
    const timer = setTimer(
      () =>
        settle(reject, {
          code: "LOCATION_TIMEOUT",
          errMsg: "getLocation:fail timeout",
        }),
      8000,
    );

    try {
      wxApi.getLocation({
        type: "gcj02",
        success: (value) => settle(resolve, value),
        fail: (error) => settle(reject, error),
      });
    } catch (error) {
      settle(reject, error);
    }
  });
}

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

function safeSessionResult(promise) {
  return Promise.resolve(promise).then(
    (value) => {
      if (value && Object.prototype.hasOwnProperty.call(value, "session")) {
        return {
          session: value.session || null,
          error: value.error ? safeSessionError(value.error) : null,
        };
      }
      return { session: value, error: null };
    },
    (error) => ({ session: null, error: safeSessionError(error) }),
  );
}

function createHomePage(dependencies = {}) {
  const wxApi = dependencies.wxApi || globalThis.wx;
  const getApplication = dependencies.getApp || globalThis.getApp;
  const locationService = dependencies.locationService || require("../../services/location");
  const setTimer = dependencies.setTimeout || globalThis.setTimeout;
  const clearTimer = dependencies.clearTimeout || globalThis.clearTimeout;

  function readSearch(app) {
    try {
      const search = app.globalData.searchStore.get();
      app.globalData.searchInitializationError = null;
      return { search, error: null };
    } catch {
      const error = { code: "SEARCH_INITIALIZATION_FAILED" };
      app.globalData.searchInitializationError = error;
      return { search: null, error };
    }
  }

  function render(page, options = {}) {
    const app = getApplication();
    const searchResult = readSearch(app);
    page.setData(
      toHomeView({
        session: options.session ?? app.globalData.sessionStore.get(),
        loading: Boolean(options.loading),
        error: searchResult.error || options.error || null,
        search: searchResult.search,
      }),
    );
  }

  function recoverSearch(app) {
    try {
      app.globalData.searchStore.initializeDefaults();
    } catch {
      try {
        app.globalData.searchStore.clear();
      } catch {
        app.globalData.searchInitializationError = {
          code: "SEARCH_INITIALIZATION_FAILED",
        };
        return false;
      }
    }
    app.globalData.searchInitializationError = null;
    return true;
  }

  async function waitForSession(page) {
    const app = getApplication();
    render(page, { loading: true, session: null });
    const result = await safeSessionResult(app.globalData.sessionReady);
    render(page, result);
  }

  return {
    data: {
      status: "loading",
      errorMessage: "",
      search: null,
      cityLabel: "请选择城市",
      dateLabel: "日期待选择",
      nightsLabel: "0晚",
      guestsLabel: "1人",
      canSearch: false,
      locating: false,
    },

    onLoad() {
      return waitForSession(this);
    },

    onShow() {
      const app = getApplication();
      if (this.data.search) {
        const session = app.globalData.sessionStore.get();
        if (session) {
          render(this, { session });
          return;
        }
        return waitForSession(this);
      }
    },

    async retrySession() {
      const app = getApplication();
      const hadSearchError = Boolean(app.globalData.searchInitializationError);
      render(this, { loading: true, session: null });
      if (hadSearchError) {
        recoverSearch(app);
        const result = await safeSessionResult(app.globalData.sessionReady);
        render(this, result);
        return;
      }
      let sessionAttempt;
      try {
        sessionAttempt = app.globalData.sessionStore.ensureSession();
      } catch (error) {
        sessionAttempt = Promise.reject(error);
      }
      const ready = safeSessionResult(sessionAttempt);
      app.globalData.sessionReady = ready;
      const result = await ready;
      render(this, result);
    },

    openCitySelect() {
      wxApi.navigateTo({ url: "/pages/city-select/city-select" });
    },

    openDateGuestSelect() {
      wxApi.navigateTo({ url: "/pages/date-guest-select/date-guest-select" });
    },

    async useCurrentLocation() {
      if (this.data.locating) {
        return;
      }
      this.setData({ locating: true });

      try {
        const choice = await modalResult(wxApi);
        if (!choice.confirm) {
          wxApi.navigateTo({
            url: "/pages/city-select/city-select?reason=location_cancelled",
          });
          return;
        }

        const position = await currentLocation(wxApi, setTimer, clearTimer);
        const resolved = await locationService.resolve({
          longitude: position.longitude,
          latitude: position.latitude,
        });
        const app = getApplication();
        app.globalData.searchStore.set({ city: resolved.city });
        render(this, { session: app.globalData.sessionStore.get() });
        wxApi.showToast({ title: `已选择${resolved.city.name}`, icon: "none" });
      } catch (error) {
        const action = locationFailureToAction(error);
        wxApi.showToast({ title: action.toast, icon: "none" });
        wxApi.navigateTo({ url: action.url });
      } finally {
        this.setData({ locating: false });
      }
    },

    searchProperties() {
      if (!this.data.canSearch || this.data.status !== "ready") {
        return;
      }
      wxApi.showToast({
        title: "供给浏览将在下一开发切片开放",
        icon: "none",
      });
    },
  };
}

const definition = createHomePage();
if (typeof Page === "function") {
  Page(definition);
}

module.exports = {
  createHomePage,
};

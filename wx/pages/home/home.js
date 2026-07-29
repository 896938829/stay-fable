"use strict";

const { locationFailureToAction, toHomeView } = require("./home.logic");

const CANCELLED_LOCATION_OPERATION = Symbol("cancelled-location-operation");

function modalResult(wxApi) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    try {
      const returned = wxApi.showModal({
        title: "使用当前位置",
        content: "位置信息仅用于匹配附近已开通城市，不会保存您的坐标。",
        confirmText: "继续定位",
        cancelText: "手动选择",
        success: settle,
        fail: () => settle({ confirm: false }),
      });
      if (returned && typeof returned.then === "function") {
        returned.then(settle, () => settle({ confirm: false }));
      }
    } catch {
      settle({ confirm: false });
    }
  });
}

function currentLocation(wxApi) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      callback(value);
    };

    try {
      const returned = wxApi.getLocation({
        type: "gcj02",
        success: (value) => settle(resolve, value),
        fail: (error) => settle(reject, error),
      });
      if (returned && typeof returned.then === "function") {
        returned.then(
          (value) => settle(resolve, value),
          (error) => settle(reject, error),
        );
      }
    } catch (error) {
      settle(reject, error);
    }
  });
}

function beginLocationOperation(page) {
  const operation = {
    cancelled: false,
    finish: null,
    timer: null,
  };
  operation.cancellation = new Promise((resolve) => {
    operation.resolveCancellation = resolve;
  });
  page._locationOperation = operation;
  return operation;
}

function cancelLocationOperation(page, clearTimer) {
  const operation = page._locationOperation;
  if (!operation || operation.cancelled) {
    return;
  }
  operation.cancelled = true;
  operation.resolveCancellation(CANCELLED_LOCATION_OPERATION);
  if (operation.finish) {
    operation.finish(CANCELLED_LOCATION_OPERATION);
  } else if (operation.timer !== null) {
    clearTimer(operation.timer);
    operation.timer = null;
  }
}

function operationIsCurrent(page, operation) {
  return (
    page._locationActive !== false &&
    page._locationOperation === operation &&
    !operation.cancelled &&
    !operation.finished
  );
}

function runWithDeadline(page, operation, task, setTimer, clearTimer) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value, isError = false) => {
      if (settled) {
        return;
      }
      settled = true;
      operation.finished = true;
      if (operation.timer !== null) {
        clearTimer(operation.timer);
        operation.timer = null;
      }
      operation.finish = null;
      if (isError) {
        reject(value);
      } else {
        resolve(value);
      }
    };
    operation.finish = (value) => finish(value);
    operation.timer = setTimer(
      () =>
        finish(
          {
            code: "LOCATION_TIMEOUT",
            errMsg: "getLocation:fail timeout",
          },
          true,
        ),
      8000,
    );

    Promise.resolve()
      .then(task)
      .then(
        (value) => finish(value),
        (error) => finish(error, true),
      );
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

function observeNavigationFailure(result, fail) {
  if (result === false) {
    fail();
    return;
  }
  try {
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function")
    ) {
      const then = result.then;
      if (typeof then === "function") {
        then.call(result, () => {}, fail);
      }
    }
  } catch {
    fail();
  }
}

function createHomePage(dependencies = {}) {
  const wxApi = dependencies.wxApi || globalThis.wx;
  const getApplication = dependencies.getApp || globalThis.getApp;
  const locationService = dependencies.locationService || require("../../services/location");
  const setTimer = dependencies.setTimeout || globalThis.setTimeout;
  const clearTimer = dependencies.clearTimeout || globalThis.clearTimeout;
  let propertyNavigationPending = false;

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
    let session;
    let sessionError = null;
    if (Object.prototype.hasOwnProperty.call(options, "session")) {
      session = options.session;
    } else {
      try {
        session = app.globalData.sessionStore.get();
      } catch {
        session = null;
        sessionError = { code: "AUTH_LOGIN_FAILED" };
      }
    }
    page.setData(
      toHomeView({
        session,
        loading: Boolean(options.loading),
        error: searchResult.error || options.error || sessionError,
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
      errorTitle: "",
      search: null,
      cityLabel: "请选择城市",
      dateLabel: "日期待选择",
      nightsLabel: "0晚",
      guestsLabel: "1人",
      canSearch: false,
      locating: false,
    },

    onLoad() {
      this._locationActive = true;
      return waitForSession(this);
    },

    onShow() {
      propertyNavigationPending = false;
      this._locationActive = true;
      this._locationOperation = null;
      if (this.data.locating) {
        this.setData({ locating: false });
      }
      const app = getApplication();
      if (this.data.search) {
        let session;
        try {
          session = app.globalData.sessionStore.get();
        } catch {
          render(this, {
            session: null,
            error: { code: "AUTH_LOGIN_FAILED" },
          });
          return;
        }
        if (session) {
          render(this, { session });
          return;
        }
        return waitForSession(this);
      }
    },

    onHide() {
      this._locationActive = false;
      cancelLocationOperation(this, clearTimer);
    },

    onUnload() {
      propertyNavigationPending = false;
      this._locationActive = false;
      cancelLocationOperation(this, clearTimer);
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
      if (this.data.locating || this._locationActive === false) {
        return;
      }
      const operation = beginLocationOperation(this);
      this.setData({ locating: true });

      try {
        const choice = await Promise.race([modalResult(wxApi), operation.cancellation]);
        if (
          choice === CANCELLED_LOCATION_OPERATION ||
          this._locationActive === false ||
          this._locationOperation !== operation
        ) {
          return;
        }
        if (!choice.confirm) {
          wxApi.navigateTo({
            url: "/pages/city-select/city-select?reason=location_cancelled",
          });
          return;
        }

        const resolved = await runWithDeadline(
          this,
          operation,
          async () => {
            const position = await currentLocation(wxApi);
            if (!operationIsCurrent(this, operation)) {
              return CANCELLED_LOCATION_OPERATION;
            }
            const result = await locationService.resolve({
              longitude: position.longitude,
              latitude: position.latitude,
            });
            return operationIsCurrent(this, operation)
              ? result
              : CANCELLED_LOCATION_OPERATION;
          },
          setTimer,
          clearTimer,
        );
        if (
          resolved === CANCELLED_LOCATION_OPERATION ||
          this._locationActive === false ||
          this._locationOperation !== operation ||
          operation.cancelled
        ) {
          return;
        }
        const app = getApplication();
        app.globalData.searchStore.set({ city: resolved.city });
        render(this);
        wxApi.showToast({ title: `已选择${resolved.city.name}`, icon: "none" });
      } catch (error) {
        if (
          this._locationActive === false ||
          this._locationOperation !== operation ||
          operation.cancelled
        ) {
          return;
        }
        const action = locationFailureToAction(error);
        wxApi.showToast({ title: action.toast, icon: "none" });
        wxApi.navigateTo({ url: action.url });
      } finally {
        if (
          this._locationActive !== false &&
          this._locationOperation === operation &&
          !operation.cancelled
        ) {
          this._locationOperation = null;
          this.setData({ locating: false });
        }
      }
    },

    searchProperties() {
      if (
        !this.data.canSearch ||
        this.data.status !== "ready" ||
        propertyNavigationPending
      ) {
        return;
      }
      propertyNavigationPending = true;
      const unlock = () => {
        propertyNavigationPending = false;
      };
      try {
        const result = wxApi.navigateTo({
          url: "/pages/property-list/property-list",
          fail: unlock,
        });
        observeNavigationFailure(result, unlock);
      } catch {
        unlock();
      }
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import homeLogic from "../pages/home/home.logic.js";
import homePage from "../pages/home/home.js";

const { locationFailureToAction, toHomeView } = homeLogic;
const { createHomePage } = homePage;

const city = {
  id: "11111111-1111-4111-8111-111111111111",
  code: "hangzhou",
  name: "杭州",
};
const search = {
  city,
  checkin: "2026-07-30",
  checkout: "2026-08-02",
  guests: 3,
};
const session = { user: { id: "22222222-2222-4222-8222-222222222222" } };

function pageContext(definition) {
  return {
    data: structuredClone(definition.data),
    setData(update) {
      this.data = { ...this.data, ...update };
    },
    ...definition,
  };
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("home view logic", () => {
  it("returns stable loading, error, and ready states with search context preserved", () => {
    expect(toHomeView({ loading: true, session: null, error: null, search })).toMatchObject({
      status: "loading",
      search,
    });
    expect(
      toHomeView({
        loading: false,
        session: null,
        error: { code: "AUTH_LOGIN_FAILED", stack: "secret-stack" },
        search,
      }),
    ).toEqual({
      status: "error",
      errorTitle: "暂时无法登录",
      errorMessage: "登录暂时失败，请重试",
      search,
      cityLabel: "杭州",
      dateLabel: "7月30日入住 · 8月2日离店",
      nightsLabel: "3晚",
      guestsLabel: "3人",
      canSearch: true,
    });
    expect(toHomeView({ loading: false, session, error: null, search })).toMatchObject({
      status: "ready",
      canSearch: true,
      cityLabel: "杭州",
      nightsLabel: "3晚",
    });
    expect(
      JSON.stringify(
        toHomeView({
          loading: false,
          session: null,
          error: { message: "request body secret", requestId: "private" },
          search,
        }),
      ),
    ).not.toContain("secret");
  });

  it("uses a distinct title for search-context errors", () => {
    expect(
      toHomeView({
        loading: false,
        session,
        error: { code: "SEARCH_INITIALIZATION_FAILED" },
        search: null,
      }),
    ).toMatchObject({
      status: "error",
      errorTitle: "搜索条件不可用",
      errorMessage: "搜索条件读取失败，请重试",
    });
  });

  it.each([
    [{ errMsg: "getLocation:fail auth deny" }, "location_denied"],
    [{ errMsg: "getLocation:fail timeout" }, "location_timeout"],
    [{ code: "CITY_NOT_SUPPORTED" }, "city_not_supported"],
  ])("routes location failures to safe manual city selection", (error, reason) => {
    expect(locationFailureToAction(error)).toMatchObject({
      url: `/pages/city-select/city-select?reason=${reason}`,
    });
  });
});

describe("application launch", () => {
  it("initializes search synchronously and exposes a safely settled session promise", async () => {
    const search = { initializeDefaults: vi.fn(() => ({ city: null })) };
    const failure = Object.assign(new Error("private login failure"), {
      code: "AUTH_LOGIN_FAILED",
      stack: "private stack",
    });
    const sessions = {
      ensureSession: vi.fn(() => {
        throw failure;
      }),
    };
    globalThis.App = vi.fn();
    const appModule = await import("../app.js");
    expect(globalThis.App).toHaveBeenCalledOnce();
    const definition = appModule.default.createAppDefinition({
      searchStore: search,
      sessionStore: sessions,
    });

    definition.onLaunch();

    expect(search.initializeDefaults).toHaveBeenCalledOnce();
    expect(definition.globalData.searchStore).toBe(search);
    expect(definition.globalData.sessionStore).toBe(sessions);
    await expect(definition.globalData.sessionReady).resolves.toEqual({
      session: null,
      error: { code: "AUTH_LOGIN_FAILED" },
    });
    expect(JSON.stringify(await definition.globalData.sessionReady)).not.toContain("private");
  });

  it("starts the session even when search initialization fails", async () => {
    const search = {
      initializeDefaults: vi.fn(() => {
        throw Object.assign(new Error("private storage failure"), {
          details: "secret",
        });
      }),
    };
    const sessions = {
      ensureSession: vi.fn(async () => session),
    };
    const appModule = await import("../app.js");
    const definition = appModule.default.createAppDefinition({
      searchStore: search,
      sessionStore: sessions,
    });

    expect(() => definition.onLaunch()).not.toThrow();
    expect(sessions.ensureSession).toHaveBeenCalledOnce();
    expect(definition.globalData.searchInitializationError).toEqual({
      code: "SEARCH_INITIALIZATION_FAILED",
    });
    expect(JSON.stringify(definition.globalData.searchInitializationError)).not.toContain(
      "private",
    );
    await expect(definition.globalData.sessionReady).resolves.toEqual({
      session,
      error: null,
    });
  });
});

describe("home page interactions", () => {
  let wxApi;
  let searchStore;
  let sessionStore;
  let locationService;
  let app;

  beforeEach(() => {
    wxApi = {
      getLocation: vi.fn(),
      navigateTo: vi.fn(),
      showModal: vi.fn(),
      showToast: vi.fn(),
    };
    searchStore = {
      get: vi.fn(() => search),
      set: vi.fn(),
    };
    sessionStore = {
      ensureSession: vi.fn(async () => session),
      get: vi.fn(() => session),
    };
    locationService = {
      resolve: vi.fn(async () => ({ city, distance_meters: 12 })),
    };
    app = {
      globalData: {
        searchStore,
        sessionStore,
        sessionReady: Promise.resolve({ session, error: null }),
        searchInitializationError: null,
      },
    };
  });

  it("registers its native page definition", async () => {
    globalThis.Page = vi.fn();
    await import("../pages/home/home.js?registration=home");
    expect(globalThis.Page).toHaveBeenCalledOnce();
    expect(globalThis.Page.mock.calls[0][0]).toMatchObject({
      data: { status: "loading" },
      onLoad: expect.any(Function),
      retrySession: expect.any(Function),
    });
  });

  it("loads the session and routes city and date controls", async () => {
    const page = pageContext(
      createHomePage({ getApp: () => app, locationService, wxApi }),
    );
    await page.onLoad.call(page);
    expect(page.data.status).toBe("ready");

    page.openCitySelect.call(page);
    page.openDateGuestSelect.call(page);
    expect(wxApi.navigateTo).toHaveBeenNthCalledWith(1, {
      url: "/pages/city-select/city-select",
    });
    expect(wxApi.navigateTo).toHaveBeenNthCalledWith(2, {
      url: "/pages/date-guest-select/date-guest-select",
    });
  });

  it("waits for the shared session on show when login is still in progress", async () => {
    sessionStore.get.mockReturnValue(null);
    const page = pageContext(
      createHomePage({ getApp: () => app, locationService, wxApi }),
    );
    page.data.search = search;

    await page.onShow.call(page);

    expect(page.data.status).toBe("ready");
    expect(page.data.errorMessage).toBe("");
  });

  it("does not reread a failed session when sessionReady explicitly resolves null", async () => {
    sessionStore.get.mockImplementation(() => {
      throw Object.assign(new Error("private legacy cleanup"), {
        code: "AUTH_SESSION_STORAGE_CLEANUP_FAILED",
        details: "secret",
      });
    });
    app.globalData.sessionReady = Promise.resolve({
      session: null,
      error: { code: "AUTH_LOGIN_FAILED" },
    });
    const page = pageContext(
      createHomePage({ getApp: () => app, locationService, wxApi }),
    );

    await expect(page.onLoad.call(page)).resolves.toBeUndefined();

    expect(page.data).toMatchObject({
      status: "error",
      errorTitle: "暂时无法登录",
      errorMessage: "登录暂时失败，请重试",
    });
    expect(sessionStore.get).not.toHaveBeenCalled();
    expect(JSON.stringify(page.data)).not.toContain("private");
  });

  it("maps an onShow session read failure to a safe auth error", async () => {
    sessionStore.get.mockImplementation(() => {
      throw new Error("private session read");
    });
    const page = pageContext(
      createHomePage({ getApp: () => app, locationService, wxApi }),
    );
    page.data.search = search;

    expect(() => page.onShow.call(page)).not.toThrow();

    expect(page.data).toMatchObject({
      status: "error",
      errorTitle: "暂时无法登录",
    });
    expect(JSON.stringify(page.data)).not.toContain("private");
  });

  it("does not request location after the explanation is cancelled", async () => {
    wxApi.showModal.mockImplementation(({ success }) => success({ confirm: false, cancel: true }));
    const page = pageContext(
      createHomePage({ getApp: () => app, locationService, wxApi }),
    );

    await page.useCurrentLocation.call(page);

    expect(wxApi.getLocation).not.toHaveBeenCalled();
    expect(wxApi.navigateTo).toHaveBeenCalledWith({
      url: "/pages/city-select/city-select?reason=location_cancelled",
    });
  });

  it("resolves coordinates locally and stores only the canonical city", async () => {
    wxApi.showModal.mockImplementation(({ success }) => success({ confirm: true }));
    wxApi.getLocation.mockImplementation(({ success }) =>
      success({ longitude: 120.1, latitude: 30.2 }),
    );
    const page = pageContext(
      createHomePage({ getApp: () => app, locationService, wxApi }),
    );

    await page.useCurrentLocation.call(page);

    expect(locationService.resolve).toHaveBeenCalledWith({
      longitude: 120.1,
      latitude: 30.2,
    });
    expect(searchStore.set).toHaveBeenCalledWith({ city });
    expect(JSON.stringify(page.data)).not.toContain("120.1");
    expect(JSON.stringify(searchStore.set.mock.calls)).not.toContain("120.1");
  });

  it(
    "supports Promise-based modal and location APIs when location is denied",
    async () => {
      wxApi.showModal.mockResolvedValue({ confirm: true });
      wxApi.getLocation.mockRejectedValue({ errMsg: "getLocation:fail auth deny" });
      const page = pageContext(
        createHomePage({ getApp: () => app, locationService, wxApi }),
      );

      await page.useCurrentLocation.call(page);

      expect(wxApi.navigateTo).toHaveBeenCalledWith({
        url: "/pages/city-select/city-select?reason=location_denied",
      });
      expect(page.data.locating).toBe(false);
    },
    500,
  );

  it("maps a session read failure after location success without misrouting it", async () => {
    wxApi.showModal.mockImplementation(({ success }) => success({ confirm: true }));
    wxApi.getLocation.mockImplementation(({ success }) =>
      success({ longitude: 120.1, latitude: 30.2 }),
    );
    sessionStore.get.mockImplementation(() => {
      throw new Error("private session read");
    });
    const page = pageContext(
      createHomePage({ getApp: () => app, locationService, wxApi }),
    );

    await page.useCurrentLocation.call(page);

    expect(searchStore.set).toHaveBeenCalledWith({ city });
    expect(page.data).toMatchObject({
      status: "error",
      errorTitle: "暂时无法登录",
    });
    expect(wxApi.navigateTo).not.toHaveBeenCalled();
    expect(JSON.stringify(page.data)).not.toContain("private");
  });

  describe("bounded location wait", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      wxApi.showModal.mockImplementation(({ success }) => success({ confirm: true }));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("times out after eight seconds, routes to manual selection, and unlocks", async () => {
      wxApi.getLocation.mockImplementation(() => {});
      const page = pageContext(
        createHomePage({ getApp: () => app, locationService, wxApi }),
      );

      page.useCurrentLocation.call(page);
      expect(page.data.locating).toBe(true);
      await vi.advanceTimersByTimeAsync(8000);

      expect(wxApi.getLocation.mock.calls[0][0]).not.toHaveProperty("timeout");
      expect(wxApi.navigateTo).toHaveBeenCalledWith({
        url: "/pages/city-select/city-select?reason=location_timeout",
      });
      expect(page.data.locating).toBe(false);
    });

    it("ignores a success callback that arrives after the timeout", async () => {
      let locationCallbacks;
      wxApi.getLocation.mockImplementation((options) => {
        locationCallbacks = options;
      });
      const page = pageContext(
        createHomePage({ getApp: () => app, locationService, wxApi }),
      );

      page.useCurrentLocation.call(page);
      await vi.advanceTimersByTimeAsync(8000);
      locationCallbacks.success({ longitude: 120.1, latitude: 30.2 });
      await Promise.resolve();

      expect(locationService.resolve).not.toHaveBeenCalled();
      expect(searchStore.set).not.toHaveBeenCalled();
    });

    it("applies one shared deadline while city resolution is pending", async () => {
      wxApi.getLocation.mockImplementation(({ success }) =>
        success({ longitude: 120.1, latitude: 30.2 }),
      );
      locationService.resolve.mockImplementation(() => new Promise(() => {}));
      const page = pageContext(
        createHomePage({ getApp: () => app, locationService, wxApi }),
      );

      page.useCurrentLocation.call(page);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(8000);

      expect(locationService.resolve).toHaveBeenCalledOnce();
      expect(wxApi.navigateTo).toHaveBeenCalledTimes(1);
      expect(wxApi.navigateTo).toHaveBeenCalledWith({
        url: "/pages/city-select/city-select?reason=location_timeout",
      });
      expect(page.data.locating).toBe(false);
    });

    it("does not store a city when resolution returns after the deadline", async () => {
      const resolution = deferred();
      wxApi.getLocation.mockImplementation(({ success }) =>
        success({ longitude: 120.1, latitude: 30.2 }),
      );
      locationService.resolve.mockReturnValue(resolution.promise);
      const page = pageContext(
        createHomePage({ getApp: () => app, locationService, wxApi }),
      );

      page.useCurrentLocation.call(page);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(8000);
      resolution.resolve({ city, distance_meters: 12 });
      await Promise.resolve();
      await Promise.resolve();

      expect(searchStore.set).not.toHaveBeenCalled();
      expect(wxApi.navigateTo).toHaveBeenCalledTimes(1);
    });

    it("silences a modal callback after the page is hidden and reactivates on show", async () => {
      let modalCallbacks;
      wxApi.showModal.mockImplementation((options) => {
        modalCallbacks = options;
      });
      const page = pageContext(
        createHomePage({ getApp: () => app, locationService, wxApi }),
      );
      const setData = vi.spyOn(page, "setData");

      page.useCurrentLocation.call(page);
      expect(page.onHide).toBeTypeOf("function");
      page.onHide.call(page);
      setData.mockClear();
      modalCallbacks.success({ confirm: true });
      await Promise.resolve();

      expect(wxApi.getLocation).not.toHaveBeenCalled();
      expect(wxApi.navigateTo).not.toHaveBeenCalled();
      expect(wxApi.showToast).not.toHaveBeenCalled();
      expect(setData).not.toHaveBeenCalled();

      page.onShow.call(page);
      wxApi.showModal.mockImplementation(({ success }) => success({ confirm: false }));
      await page.useCurrentLocation.call(page);
      expect(wxApi.navigateTo).toHaveBeenCalledWith({
        url: "/pages/city-select/city-select?reason=location_cancelled",
      });
    });

    it("silences a getLocation callback after unload and clears its timer", async () => {
      let locationCallbacks;
      const clearTimer = vi.fn((timer) => globalThis.clearTimeout(timer));
      wxApi.getLocation.mockImplementation((options) => {
        locationCallbacks = options;
      });
      const page = pageContext(
        createHomePage({
          clearTimeout: clearTimer,
          getApp: () => app,
          locationService,
          setTimeout: globalThis.setTimeout,
          wxApi,
        }),
      );
      const setData = vi.spyOn(page, "setData");

      page.useCurrentLocation.call(page);
      await vi.advanceTimersByTimeAsync(0);
      expect(locationCallbacks).toBeDefined();
      expect(page.onUnload).toBeTypeOf("function");
      page.onUnload.call(page);
      setData.mockClear();
      locationCallbacks.success({ longitude: 120.1, latitude: 30.2 });
      await Promise.resolve();

      expect(clearTimer).toHaveBeenCalledOnce();
      expect(locationService.resolve).not.toHaveBeenCalled();
      expect(searchStore.set).not.toHaveBeenCalled();
      expect(wxApi.navigateTo).not.toHaveBeenCalled();
      expect(wxApi.showToast).not.toHaveBeenCalled();
      expect(setData).not.toHaveBeenCalled();
    });

    it("silences a resolve result after hide and clears its timer", async () => {
      const resolution = deferred();
      const clearTimer = vi.fn((timer) => globalThis.clearTimeout(timer));
      wxApi.getLocation.mockImplementation(({ success }) =>
        success({ longitude: 120.1, latitude: 30.2 }),
      );
      locationService.resolve.mockReturnValue(resolution.promise);
      const page = pageContext(
        createHomePage({
          clearTimeout: clearTimer,
          getApp: () => app,
          locationService,
          setTimeout: globalThis.setTimeout,
          wxApi,
        }),
      );
      const setData = vi.spyOn(page, "setData");

      page.useCurrentLocation.call(page);
      await vi.advanceTimersByTimeAsync(0);
      expect(locationService.resolve).toHaveBeenCalledOnce();
      expect(page.onHide).toBeTypeOf("function");
      page.onHide.call(page);
      setData.mockClear();
      resolution.resolve({ city, distance_meters: 12 });
      await Promise.resolve();
      await Promise.resolve();

      expect(clearTimer).toHaveBeenCalledOnce();
      expect(searchStore.set).not.toHaveBeenCalled();
      expect(wxApi.navigateTo).not.toHaveBeenCalled();
      expect(wxApi.showToast).not.toHaveBeenCalled();
      expect(setData).not.toHaveBeenCalled();
    });

    it.each(["success", "fail"])("clears the deadline timer after %s", async (outcome) => {
      const clearTimer = vi.fn((timer) => globalThis.clearTimeout(timer));
      wxApi.getLocation.mockImplementation((options) => {
        if (outcome === "success") {
          options.success({ longitude: 120.1, latitude: 30.2 });
        } else {
          options.fail({ errMsg: "getLocation:fail network" });
        }
      });
      const page = pageContext(
        createHomePage({
          clearTimeout: clearTimer,
          getApp: () => app,
          locationService,
          setTimeout: globalThis.setTimeout,
          wxApi,
        }),
      );

      await page.useCurrentLocation.call(page);

      expect(clearTimer).toHaveBeenCalledOnce();
    });
  });

  it("falls back to manual selection on location failure and prevents duplicate taps", async () => {
    let resolveModal;
    wxApi.showModal.mockImplementation(
      ({ success }) =>
        new Promise((resolve) => {
          resolveModal = () => {
            success({ confirm: true });
            resolve();
          };
        }),
    );
    wxApi.getLocation.mockImplementation(({ fail }) =>
      fail({ errMsg: "getLocation:fail timeout", detail: "private" }),
    );
    const page = pageContext(
      createHomePage({ getApp: () => app, locationService, wxApi }),
    );

    const first = page.useCurrentLocation.call(page);
    const second = page.useCurrentLocation.call(page);
    resolveModal();
    await Promise.all([first, second]);
    await flush();

    expect(wxApi.showModal).toHaveBeenCalledOnce();
    expect(wxApi.navigateTo).toHaveBeenCalledWith({
      url: "/pages/city-select/city-select?reason=location_timeout",
    });
    expect(JSON.stringify(wxApi.showToast.mock.calls)).not.toContain("private");
  });

  it("retries failed login and keeps search context", async () => {
    sessionStore.get.mockReturnValue(null);
    app.globalData.sessionReady = Promise.resolve({
      session: null,
      error: { code: "AUTH_LOGIN_FAILED", message: "private" },
    });
    const page = pageContext(
      createHomePage({ getApp: () => app, locationService, wxApi }),
    );
    await page.onLoad.call(page);
    expect(page.data.status).toBe("error");

    await page.retrySession.call(page);

    expect(sessionStore.ensureSession).toHaveBeenCalledOnce();
    expect(page.data.status).toBe("ready");
    expect(page.data.search).toEqual(search);
  });

  it("keeps retry failures safe in both page data and the shared promise", async () => {
    sessionStore.get.mockReturnValue(null);
    sessionStore.ensureSession.mockImplementation(() => {
      throw Object.assign(new Error("request body private"), {
        code: "NETWORK_REQUEST_FAILED",
        details: "secret",
      });
    });
    const page = pageContext(
      createHomePage({ getApp: () => app, locationService, wxApi }),
    );

    await page.retrySession.call(page);

    expect(page.data).toMatchObject({
      status: "error",
      errorMessage: "网络连接不稳定，请重试",
      search,
    });
    await expect(app.globalData.sessionReady).resolves.toEqual({
      session: null,
      error: { code: "NETWORK_REQUEST_FAILED" },
    });
    expect(JSON.stringify(await app.globalData.sessionReady)).not.toContain("private");
  });

  it("shows a distinct safe search error and recovers it without relogin", async () => {
    const storageFailure = Object.assign(new Error("private search storage"), {
      details: "secret",
    });
    searchStore.get.mockImplementation(() => {
      throw storageFailure;
    });
    searchStore.initializeDefaults = vi.fn(() => search);
    searchStore.clear = vi.fn(() => search);
    app.globalData.searchInitializationError = {
      code: "SEARCH_INITIALIZATION_FAILED",
    };
    const page = pageContext(
      createHomePage({ getApp: () => app, locationService, wxApi }),
    );

    await expect(page.onLoad.call(page)).resolves.toBeUndefined();
    expect(page.data).toMatchObject({
      status: "error",
      errorMessage: "搜索条件读取失败，请重试",
    });
    expect(JSON.stringify(page.data)).not.toContain("private");

    searchStore.get.mockReturnValue(search);
    await page.retrySession.call(page);

    expect(searchStore.initializeDefaults).toHaveBeenCalledOnce();
    expect(sessionStore.ensureSession).not.toHaveBeenCalled();
    expect(app.globalData.searchInitializationError).toBeNull();
    expect(page.data.status).toBe("ready");
  });

  it("clears search defaults when retry initialization still fails", async () => {
    searchStore.get.mockImplementation(() => {
      throw new Error("private storage read");
    });
    searchStore.initializeDefaults = vi.fn(() => {
      throw new Error("private initialization");
    });
    searchStore.clear = vi.fn(() => search);
    app.globalData.searchInitializationError = {
      code: "SEARCH_INITIALIZATION_FAILED",
    };
    const page = pageContext(
      createHomePage({ getApp: () => app, locationService, wxApi }),
    );
    await page.onLoad.call(page);

    searchStore.get.mockReturnValue(search);
    await page.retrySession.call(page);

    expect(searchStore.clear).toHaveBeenCalledOnce();
    expect(app.globalData.searchInitializationError).toBeNull();
    expect(page.data.status).toBe("ready");
  });

  it("opens property results only with a complete ready search and without a toast", () => {
    const page = pageContext(
      createHomePage({ getApp: () => app, locationService, wxApi }),
    );
    page.data.canSearch = true;
    page.data.status = "ready";

    page.searchProperties.call(page);

    expect(wxApi.navigateTo).toHaveBeenCalledWith({
      url: "/pages/property-list/property-list",
      fail: expect.any(Function),
    });
    expect(wxApi.showToast).not.toHaveBeenCalled();
  });

  it.each([
    ["an incomplete search", { canSearch: false, status: "ready" }],
    ["an authentication error", { canSearch: true, status: "error" }],
  ])("does not navigate for %s", (_label, state) => {
    const page = pageContext(
      createHomePage({ getApp: () => app, locationService, wxApi }),
    );
    Object.assign(page.data, state);

    page.searchProperties.call(page);

    expect(wxApi.navigateTo).not.toHaveBeenCalled();
    expect(wxApi.showToast).not.toHaveBeenCalled();
  });

  it("single-flights navigation and unlocks when the page is shown again", () => {
    const page = pageContext(
      createHomePage({ getApp: () => app, locationService, wxApi }),
    );
    page.data.canSearch = true;
    page.data.status = "ready";

    page.searchProperties.call(page);
    page.searchProperties.call(page);
    expect(wxApi.navigateTo).toHaveBeenCalledOnce();

    page.onShow.call(page);
    page.searchProperties.call(page);
    expect(wxApi.navigateTo).toHaveBeenCalledTimes(2);
  });

  it.each(["callback", "throw", "thenable"])(
    "unlocks after a %s navigation failure",
    async (failureMode) => {
      wxApi.navigateTo.mockImplementationOnce((options) => {
        if (failureMode === "callback") {
          options.fail({ errMsg: "private callback failure" });
          return undefined;
        }
        if (failureMode === "throw") {
          throw new Error("private synchronous failure");
        }
        return Promise.reject(new Error("private promise failure"));
      });
      const page = pageContext(
        createHomePage({ getApp: () => app, locationService, wxApi }),
      );
      page.data.canSearch = true;
      page.data.status = "ready";

      page.searchProperties.call(page);
      await Promise.resolve();
      await Promise.resolve();
      page.searchProperties.call(page);

      expect(wxApi.navigateTo).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(wxApi.showToast.mock.calls)).not.toContain("private");
    },
  );
});

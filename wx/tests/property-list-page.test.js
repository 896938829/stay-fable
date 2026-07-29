import { readFile } from "node:fs/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

import propertyListLogic from "../pages/property-list/property-list.logic.js";
import propertyListPage from "../pages/property-list/property-list.js";

const { mergePropertyPage, safeCatalogError, toPropertyListView } =
  propertyListLogic;
const { createPropertyListPage } = propertyListPage;

const PROPERTY_A = "20000000-0000-4000-8000-000000000001";
const PROPERTY_B = "20000000-0000-4000-8000-000000000002";

const search = {
  city: {
    id: "10000000-0000-4000-8000-000000000001",
    code: "330100",
    name: "杭州",
  },
  checkin: "2026-07-30",
  checkout: "2026-08-02",
  guests: 3,
};

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function property(id, name, type = "HOTEL") {
  return {
    id,
    type,
    name,
    city: search.city,
    cover_url: "/images/properties/example.jpg",
    short_description: "安全简介",
    facility_highlights: ["早餐"],
    from_nightly_price_cents: 42800,
    currency: "CNY",
    available_room_type_count: 2,
  };
}

function pageContext(definition) {
  const page = {
    ...definition,
    data: structuredClone(definition.data),
  };
  page.setData = vi.fn((update) => {
    page.data = { ...page.data, ...update };
  });
  return page;
}

function createPage({ listProperties, searchValue = search, wxApi } = {}) {
  const searchStore = {
    get:
      typeof searchValue === "function"
        ? vi.fn(searchValue)
        : vi.fn(() => searchValue),
  };
  const catalogService = {
    listProperties: listProperties || vi.fn(async () => ({ items: [], next_cursor: null })),
  };
  const safeWxApi = wxApi || {
    navigateTo: vi.fn(),
    reLaunch: vi.fn(() => Promise.resolve()),
  };
  return {
    catalogService,
    page: pageContext(
      createPropertyListPage({
        catalogService,
        searchStore,
        wxApi: safeWxApi,
      }),
    ),
    searchStore,
    wxApi: safeWxApi,
  };
}

describe("property list pure logic", () => {
  it("builds a bounded search summary and the four catalog filters", () => {
    expect(toPropertyListView(search, "HOMESTAY")).toEqual({
      activeType: "HOMESTAY",
      filters: [
        { value: "", label: "全部" },
        { value: "HOTEL", label: "酒店" },
        { value: "HOMESTAY", label: "民宿" },
        { value: "FARM_STAY", label: "农家乐" },
      ],
      searchSummary: {
        cityLabel: "杭州",
        dateLabel: "2026-07-30 至 2026-08-02",
        nightsLabel: "3晚",
        guestsLabel: "3人",
      },
    });
  });

  it.each([
    [{ ...search, city: null }],
    [{ ...search, checkin: "2026-02-30" }],
    [{ ...search, checkout: "2026-07-30" }],
    [{ ...search, checkout: "2026-08-30" }],
    [{ ...search, guests: 0 }],
    [{ ...search, guests: 1.5 }],
    [search, "constructor"],
  ])("rejects an invalid search context or filter", (candidate, type = "") => {
    expect(() => toPropertyListView(candidate, type)).toThrow(
      expect.objectContaining({ code: "SEARCH_CONTEXT_INVALID" }),
    );
  });

  it("maps hostile search objects to SEARCH_CONTEXT_INVALID without retaining input", () => {
    const hostilePrototype = Object.assign(
      Object.create({ inherited: true }),
      search,
    );
    const throwingGetter = Object.defineProperty({ ...search }, "checkin", {
      get() {
        throw new Error("private getter");
      },
    });

    for (const candidate of [
      hostilePrototype,
      throwingGetter,
      { ...search, city: { ...search.city, code: "c".repeat(33) } },
      { ...search, city: { ...search.city, name: "城".repeat(81) } },
    ]) {
      expect(() => toPropertyListView(candidate)).toThrow(
        expect.objectContaining({
          code: "SEARCH_CONTEXT_INVALID",
          message: "Invalid search context",
        }),
      );
    }

    const mutable = structuredClone(search);
    const view = toPropertyListView(mutable);
    mutable.city.name = "已篡改";
    mutable.checkin = "2026-08-01";
    expect(view.searchSummary).toEqual({
      cityLabel: "杭州",
      dateLabel: "2026-07-30 至 2026-08-02",
      nightsLabel: "3晚",
      guestsLabel: "3人",
    });
    expect(JSON.stringify(view)).not.toContain("已篡改");
  });

  it("merges UUIDs in place, updates existing content, and deduplicates pages", () => {
    const existing = [
      { id: PROPERTY_A, name: "旧名称" },
      { id: PROPERTY_B, name: "第二家" },
    ];
    const incoming = [
      { id: PROPERTY_A, name: "新名称" },
      { id: PROPERTY_A.toUpperCase(), name: "最终名称" },
      { id: "not-a-uuid", name: "不可信" },
    ];

    expect(mergePropertyPage(existing, incoming)).toEqual([
      { id: PROPERTY_A.toUpperCase(), name: "最终名称" },
      { id: PROPERTY_B, name: "第二家" },
    ]);
    expect(existing[0].name).toBe("旧名称");
  });

  it("uses only the catalog error allowlist and never exposes server messages", () => {
    expect(safeCatalogError({ code: "AUTH_REAUTHENTICATION_FAILED" })).toBe(
      "登录暂时失败，请返回首页重试",
    );
    expect(safeCatalogError({ code: "CATALOG_CURSOR_INVALID" })).toBe(
      "列表已更新，请重新加载",
    );
    expect(safeCatalogError({ code: "NETWORK_REQUEST_FAILED" })).toBe(
      "网络连接不稳定，请重试",
    );
    expect(
      safeCatalogError({
        code: "DATABASE_FAILURE",
        message: "server sql and token must stay private",
      }),
    ).toBe("服务暂时不可用，请重试");
    expect(
      safeCatalogError({
        code: "toString",
        message: "prototype message must stay private",
      }),
    ).toBe("服务暂时不可用，请重试");
    expect(
      safeCatalogError(
        Object.defineProperty({}, "code", {
          get() {
            throw new Error("private getter");
          },
        }),
      ),
    ).toBe("服务暂时不可用，请重试");
  });
});

describe("property list page state machine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the native page and starts with the fixed safe state", async () => {
    globalThis.Page = vi.fn();
    await import("../pages/property-list/property-list.js?registration=property-list");

    expect(globalThis.Page).toHaveBeenCalledOnce();
    expect(globalThis.Page.mock.calls[0][0]).toMatchObject({
      data: {
        status: "loading",
        items: [],
        nextCursor: null,
        activeType: "",
        filters: [
          { value: "", label: "全部" },
          { value: "HOTEL", label: "酒店" },
          { value: "HOMESTAY", label: "民宿" },
          { value: "FARM_STAY", label: "农家乐" },
        ],
        searchSummary: null,
        errorMessage: "",
        footerStatus: "idle",
      },
      onReachBottom: expect.any(Function),
      selectType: expect.any(Function),
    });
  });

  it.each([
    null,
    { ...search, city: null },
    { ...search, checkin: "not-a-date" },
    { ...search, guests: 11 },
  ])("returns to home without a request for invalid search context", (searchValue) => {
    const { catalogService, page, wxApi } = createPage({ searchValue });

    expect(() => page.onLoad.call(page)).not.toThrow();

    expect(wxApi.reLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "/pages/home/home",
      }),
    );
    expect(catalogService.listProperties).not.toHaveBeenCalled();
  });

  it.each([
    [
      "synchronous throw",
      vi.fn(() => {
        throw new Error("private sync navigation failure");
      }),
    ],
    [
      "fail callback",
      vi.fn((options) => {
        options.fail({ errMsg: "private callback navigation failure" });
      }),
    ],
    [
      "promise rejection",
      vi.fn(() =>
        Promise.reject(new Error("private promise navigation failure")),
      ),
    ],
  ])(
    "renders a recoverable local error when home reLaunch has a %s",
    async (_label, reLaunch) => {
      const { page } = createPage({
        searchValue: null,
        wxApi: { navigateTo: vi.fn(), reLaunch },
      });

      await page.onLoad.call(page);

      expect(page.data).toMatchObject({
        status: "error",
        items: [],
        searchSummary: null,
        errorMessage: "搜索条件已失效，请返回首页重新选择",
      });
      expect(JSON.stringify(page.data)).not.toContain("private");
      const failedState = structuredClone(page.data);
      page.onShow.call(page);
      expect(page.data).toEqual(failedState);
    },
  );

  it("single-flights repeated no-context retries and accepts a later home success", async () => {
    const retryNavigation = deferred();
    const reLaunch = vi
      .fn()
      .mockImplementationOnce((options) => {
        options.fail({ errMsg: "initial failure" });
      })
      .mockReturnValueOnce(retryNavigation.promise);
    const { page } = createPage({
      searchValue: null,
      wxApi: { navigateTo: vi.fn(), reLaunch },
    });
    await page.onLoad.call(page);
    expect(page.data.status).toBe("error");

    const firstRetry = page.retry.call(page);
    const secondRetry = page.retry.call(page);

    expect(firstRetry).toBe(secondRetry);
    expect(reLaunch).toHaveBeenCalledTimes(2);
    expect(page.data).toMatchObject({
      status: "loading",
      errorMessage: "",
    });

    retryNavigation.resolve();
    await Promise.all([firstRetry, secondRetry]);
    expect(reLaunch).toHaveBeenCalledTimes(2);
    expect(page.data.status).toBe("loading");
  });

  it.each(["promise rejection", "fail callback"])(
    "restores a hidden home navigation %s on show and single-flights its retry",
    async (failureMode) => {
      const retryNavigation = deferred();
      let firstOptions;
      const firstNavigation = deferred();
      const reLaunch = vi
        .fn()
        .mockImplementationOnce((options) => {
          firstOptions = options;
          return failureMode === "promise rejection"
            ? firstNavigation.promise
            : undefined;
        })
        .mockReturnValueOnce(retryNavigation.promise);
      const { page } = createPage({
        searchValue: null,
        wxApi: { navigateTo: vi.fn(), reLaunch },
      });

      const initialNavigation = page.onLoad.call(page);
      page.onHide.call(page);
      page.setData.mockClear();
      if (failureMode === "promise rejection") {
        firstNavigation.reject(new Error("private hidden rejection"));
      } else {
        firstOptions.fail({ errMsg: "private hidden callback failure" });
      }
      await initialNavigation;
      expect(page.setData).not.toHaveBeenCalled();

      page.onShow.call(page);
      expect(page.data).toMatchObject({
        status: "error",
        errorMessage: "搜索条件已失效，请返回首页重新选择",
      });
      expect(JSON.stringify(page.data)).not.toContain("private");

      const firstRetry = page.retry.call(page);
      const secondRetry = page.retry.call(page);
      expect(firstRetry).toBe(secondRetry);
      expect(reLaunch).toHaveBeenCalledTimes(2);
      retryNavigation.resolve();
      await Promise.all([firstRetry, secondRetry]);
      expect(reLaunch).toHaveBeenCalledTimes(2);
      expect(page.data).toMatchObject({
        status: "loading",
        errorMessage: "",
      });
    },
  );

  it("moves from loading to list and sends only the canonical search query", async () => {
    const first = deferred();
    const listProperties = vi.fn(() => first.promise);
    const { page } = createPage({ listProperties });

    const loading = page.onLoad.call(page);
    expect(page.data).toMatchObject({
      status: "loading",
      items: [],
      searchSummary: {
        cityLabel: "杭州",
        nightsLabel: "3晚",
        guestsLabel: "3人",
      },
    });
    expect(listProperties).toHaveBeenCalledWith({
      city_id: search.city.id,
      checkin: search.checkin,
      checkout: search.checkout,
      guests: search.guests,
      page_size: 10,
    });

    first.resolve({
      items: [property(PROPERTY_A, "第一家旅店")],
      next_cursor: "cursor_one",
    });
    await loading;

    expect(page.data).toMatchObject({
      status: "list",
      items: [expect.objectContaining({ id: PROPERTY_A })],
      nextCursor: "cursor_one",
      errorMessage: "",
      footerStatus: "idle",
    });
  });

  it("renders empty and safe first-page error states", async () => {
    const empty = createPage();
    await empty.page.onLoad.call(empty.page);
    expect(empty.page.data).toMatchObject({
      status: "empty",
      items: [],
      nextCursor: null,
      footerStatus: "done",
    });

    const failed = createPage({
      listProperties: vi.fn(async () => {
        throw {
          code: "INTERNAL_DATABASE_ERROR",
          message: "SQL and private token must never render",
        };
      }),
    });
    await failed.page.onLoad.call(failed.page);
    expect(failed.page.data).toMatchObject({
      status: "error",
      items: [],
      errorMessage: "服务暂时不可用，请重试",
    });
    expect(JSON.stringify(failed.page.data)).not.toContain("private token");
  });

  it("can manually retry the empty state from the first page", async () => {
    const listProperties = vi
      .fn()
      .mockResolvedValueOnce({ items: [], next_cursor: null })
      .mockResolvedValueOnce({
        items: [property(PROPERTY_A, "恢复旅店")],
        next_cursor: null,
      });
    const { page } = createPage({ listProperties });
    await page.onLoad.call(page);

    await page.retry.call(page);

    expect(listProperties).toHaveBeenCalledTimes(2);
    expect(page.data).toMatchObject({
      status: "list",
      items: [expect.objectContaining({ id: PROPERTY_A })],
    });
  });

  it("atomically resets for a valid filter and suppresses the old generation", async () => {
    const oldRequest = deferred();
    const filteredRequest = deferred();
    const listProperties = vi
      .fn()
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(filteredRequest.promise);
    const { page } = createPage({ listProperties });

    const initialLoad = page.onLoad.call(page);
    const filterLoad = page.selectType.call(page, {
      currentTarget: { dataset: { type: "HOMESTAY" } },
    });
    const resetPatch = page.setData.mock.calls.at(-1)[0];
    expect(resetPatch).toMatchObject({
      status: "loading",
      items: [],
      nextCursor: null,
      activeType: "HOMESTAY",
      errorMessage: "",
      footerStatus: "idle",
    });
    expect(listProperties.mock.calls[1][0]).toMatchObject({
      property_type: "HOMESTAY",
    });

    filteredRequest.resolve({
      items: [property(PROPERTY_B, "民宿", "HOMESTAY")],
      next_cursor: null,
    });
    await filterLoad;
    oldRequest.resolve({
      items: [property(PROPERTY_A, "过期酒店")],
      next_cursor: "stale_cursor",
    });
    await initialLoad;

    expect(page.data).toMatchObject({
      status: "list",
      activeType: "HOMESTAY",
      nextCursor: null,
      items: [expect.objectContaining({ id: PROPERTY_B })],
    });
  });

  it("rejects forged filter events, inherited types, and repeated active taps", async () => {
    const { catalogService, page } = createPage();
    await page.onLoad.call(page);
    const callsAfterLoad = catalogService.listProperties.mock.calls.length;
    const inheritedDataset = Object.create({ type: "HOTEL" });

    await page.selectType.call(page, {
      currentTarget: { dataset: { type: "constructor" } },
    });
    await page.selectType.call(page, {
      currentTarget: { dataset: inheritedDataset },
    });
    await page.selectType.call(page, {
      currentTarget: { dataset: { type: "" } },
    });

    expect(catalogService.listProperties).toHaveBeenCalledTimes(callsAfterLoad);
    expect(page.data.activeType).toBe("");
  });

  it("single-flights a cursor, merges updates in place, and stops repeated cursors", async () => {
    const nextPage = deferred();
    const listProperties = vi
      .fn()
      .mockResolvedValueOnce({
        items: [
          property(PROPERTY_A, "旧名称"),
          property(PROPERTY_B, "第二家"),
        ],
        next_cursor: "cursor_one",
      })
      .mockReturnValueOnce(nextPage.promise);
    const { page } = createPage({ listProperties });
    await page.onLoad.call(page);

    const firstReach = page.onReachBottom.call(page);
    const secondReach = page.onReachBottom.call(page);
    expect(listProperties).toHaveBeenCalledTimes(2);
    expect(listProperties.mock.calls[1][0]).toMatchObject({
      cursor: "cursor_one",
    });

    nextPage.resolve({
      items: [
        property(PROPERTY_A, "新名称"),
        property(PROPERTY_A, "最终名称"),
      ],
      next_cursor: "cursor_one",
    });
    await Promise.all([firstReach, secondReach]);

    expect(page.data.items.map((item) => [item.id, item.name])).toEqual([
      [PROPERTY_A, "最终名称"],
      [PROPERTY_B, "第二家"],
    ]);
    expect(page.data).toMatchObject({
      nextCursor: null,
      footerStatus: "done",
    });
    await page.onReachBottom.call(page);
    expect(listProperties).toHaveBeenCalledTimes(2);
  });

  it("retains the list after pagination failure and retries only its current cursor", async () => {
    const failedPage = deferred();
    const retryPage = deferred();
    const listProperties = vi
      .fn()
      .mockResolvedValueOnce({
        items: [property(PROPERTY_A, "第一家")],
        next_cursor: "cursor_retry",
      })
      .mockReturnValueOnce(failedPage.promise)
      .mockReturnValueOnce(retryPage.promise);
    const { page } = createPage({ listProperties });
    await page.onLoad.call(page);

    const pagination = page.onReachBottom.call(page);
    failedPage.reject({
      code: "NETWORK_REQUEST_FAILED",
      message: "private network body",
    });
    await pagination;
    expect(page.data).toMatchObject({
      status: "list",
      items: [expect.objectContaining({ id: PROPERTY_A })],
      nextCursor: "cursor_retry",
      footerStatus: "error",
      errorMessage: "网络连接不稳定，请重试",
    });

    const retry = page.retryFooter.call(page);
    expect(listProperties.mock.calls[2][0]).toMatchObject({
      cursor: "cursor_retry",
    });
    retryPage.resolve({
      items: [property(PROPERTY_B, "第二家")],
      next_cursor: null,
    });
    await retry;
    expect(page.data.items.map((item) => item.id)).toEqual([
      PROPERTY_A,
      PROPERTY_B,
    ]);
    expect(page.data.footerStatus).toBe("done");
  });

  it.each(["hide", "unload"])(
    "suppresses a late response after page %s",
    async (lifecycle) => {
      const response = deferred();
      const { page } = createPage({
        listProperties: vi.fn(() => response.promise),
      });
      const loading = page.onLoad.call(page);
      page.setData.mockClear();

      if (lifecycle === "hide") {
        page.onHide.call(page);
      } else {
        page.onUnload.call(page);
      }
      response.resolve({
        items: [property(PROPERTY_A, "迟到旅店")],
        next_cursor: null,
      });
      await loading;

      expect(page.setData).not.toHaveBeenCalled();
      expect(page.data.items).toEqual([]);
    },
  );

  it("retries only the first page from the full-page error state", async () => {
    const listProperties = vi
      .fn()
      .mockRejectedValueOnce({ code: "CATALOG_CURSOR_INVALID" })
      .mockResolvedValueOnce({
        items: [property(PROPERTY_A, "恢复旅店")],
        next_cursor: null,
      });
    const { page } = createPage({ listProperties });
    await page.onLoad.call(page);
    expect(page.data.errorMessage).toBe("列表已更新，请重新加载");

    await page.retry.call(page);

    expect(listProperties).toHaveBeenCalledTimes(2);
    expect(listProperties.mock.calls[1][0]).not.toHaveProperty("cursor");
    expect(page.data.status).toBe("list");
  });

  it("navigates once for an own valid detail UUID and ignores forged events", () => {
    const navigateResult = deferred();
    const wxApi = {
      navigateTo: vi.fn(() => navigateResult.promise),
      reLaunch: vi.fn(),
    };
    const { page } = createPage({ wxApi });

    page.openProperty.call(page, {
      detail: { id: PROPERTY_A },
      currentTarget: {
        dataset: { id: "30000000-0000-4000-8000-000000000001" },
      },
    });
    page.openProperty.call(page, { detail: { id: PROPERTY_A } });
    page.openProperty.call(page, {
      detail: Object.create({ id: PROPERTY_B }),
    });
    page.openProperty.call(page, {
      detail: { id: "../../pages/private/private?token=secret" },
    });

    expect(wxApi.navigateTo).toHaveBeenCalledOnce();
    expect(wxApi.navigateTo.mock.calls[0][0]).toMatchObject({
      url: `/pages/property-detail/property-detail?id=${encodeURIComponent(PROPERTY_A)}`,
    });
    expect(wxApi.navigateTo.mock.calls[0][0].url).not.toContain("30000000");
  });
});

describe("property list native files", () => {
  it("registers only the five approved components and renders item cards without rooms", async () => {
    const [jsonSource, wxml, wxss] = await Promise.all([
      readFile(
        new URL(
          "../pages/property-list/property-list.json",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../pages/property-list/property-list.wxml",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../pages/property-list/property-list.wxss",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);

    expect(JSON.parse(jsonSource)).toEqual({
      navigationStyle: "custom",
      usingComponents: {
        "navigation-bar": "/components/navigation-bar/navigation-bar",
        "loading-state": "/components/loading-state/loading-state",
        "error-state": "/components/error-state/error-state",
        "empty-state": "/components/empty-state/empty-state",
        "property-card": "/components/property-card/property-card",
      },
    });
    expect(wxml).toContain('wx:for="{{items}}"');
    expect(wxml).toContain('property="{{item}}"');
    expect(wxml).toContain('bind:propertytap="openProperty"');
    expect(wxml).not.toMatch(/room_types|roomType|房型列表/);
    expect(wxml).not.toContain("rich-text");
    expect(wxml).not.toMatch(/data-(?:property|context|search)=/);
    expect(wxml).toContain("{{searchSummary.cityLabel}}");
    expect(wxml).toContain("{{errorMessage}}");
    expect(wxss).toContain("min-height: 88rpx");
    expect(wxss).toContain("env(safe-area-inset-bottom)");
    expect(wxss).toContain("var(--color-brand)");
    expect(wxss).toContain("var(--radius-medium)");
  });
});

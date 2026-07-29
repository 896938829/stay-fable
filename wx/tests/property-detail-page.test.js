import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import propertyDetailLogic from "../pages/property-detail/property-detail.logic.js";
import propertyDetailPage from "../pages/property-detail/property-detail.js";
import catalogModule from "../services/catalog.js";

const {
  safePropertyDetailError,
  toPropertyAvailability,
  toPropertyDetailView,
} = propertyDetailLogic;
const { createPropertyDetailPage } = propertyDetailPage;
const { createCatalogService } = catalogModule;

const IDS = {
  city: "10000000-0000-4000-8000-000000000001",
  property: "20000000-0000-4000-8000-000000000002",
  room: "30000000-0000-4000-8000-000000000003",
  otherRoom: "30000000-0000-4000-8000-000000000004",
};
const search = {
  city: { id: IDS.city, code: "330100", name: "杭州" },
  checkin: "2026-07-30",
  checkout: "2026-08-01",
  guests: 2,
};
const roomSummary = {
  id: IDS.room,
  name: "湖景大床房",
  bed_type: "大床",
  area_sqm: 35,
  max_guests: 2,
  cover_url: "/images/rooms/lake.jpg",
  policy_summary: "入住当日 18:00 前可免费取消",
  from_nightly_price_cents: 59900,
  currency: "CNY",
};
const propertyDetail = {
  id: IDS.property,
  type: "HOTEL",
  name: "西湖云栖酒店",
  city: search.city,
  address: "杭州市西湖区",
  description: "临近西湖的精品酒店。",
  policies: "14:00 后入住。",
  cover_url: "/images/properties/xihu.jpg",
  media: [
    {
      type: "IMAGE",
      url: "/images/properties/xihu-gallery.jpg",
      alt: "旅店庭院",
    },
    {
      type: "IMAGE",
      url: "/images/properties/xihu-gallery.jpg",
      alt: "重复图片",
    },
  ],
  facilities: [
    { code: "PARKING", name: "免费停车" },
    { code: "PARKING", name: "重复停车" },
    { code: "BREAKFAST", name: "早餐" },
  ],
  room_types: [roomSummary],
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

function createPage({
  getProperty = vi.fn(async () => propertyDetail),
  searchValue = search,
  wxApi,
} = {}) {
  const searchStore = {
    get:
      typeof searchValue === "function"
        ? vi.fn(searchValue)
        : vi.fn(() => searchValue),
  };
  const app = { globalData: { searchStore } };
  const safeWxApi = wxApi || {
    navigateBack: vi.fn(),
    navigateTo: vi.fn(),
    reLaunch: vi.fn(),
  };
  const catalogService = { getProperty };
  return {
    catalogService,
    page: pageContext(
      createPropertyDetailPage({
        catalogService,
        getApp: () => app,
        wxApi: safeWxApi,
      }),
    ),
    searchStore,
    wxApi: safeWxApi,
  };
}

describe("property detail pure logic", () => {
  it("copies bounded display fields and deduplicates facilities and media", () => {
    const view = toPropertyDetailView(propertyDetail);

    expect(view).toMatchObject({
      id: IDS.property,
      typeLabel: "酒店",
      name: "西湖云栖酒店",
      cityName: "杭州",
      address: "杭州市西湖区",
      description: "临近西湖的精品酒店。",
      policies: "14:00 后入住。",
      coverUrl: "/images/properties/xihu.jpg",
      coverFailed: false,
      facilities: [
        { code: "PARKING", name: "免费停车" },
        { code: "BREAKFAST", name: "早餐" },
      ],
      roomTypes: [
        expect.objectContaining({
          id: IDS.room,
          bedType: "大床",
          areaLabel: "35㎡",
          maxGuestsLabel: "最多 2 人",
          priceCents: 59900,
          coverFailed: false,
        }),
      ],
    });
    expect(view.media).toEqual([
      {
        url: "/images/properties/xihu-gallery.jpg",
        alt: "旅店庭院",
        failed: false,
      },
    ]);

    propertyDetail.facilities[0].name = "已篡改";
    expect(view.facilities[0].name).toBe("免费停车");
    propertyDetail.facilities[0].name = "免费停车";
  });

  it("accepts an empty available-room response without inventing rooms", () => {
    expect(
      toPropertyDetailView({ ...propertyDetail, room_types: [] }).roomTypes,
    ).toEqual([]);
  });

  it("rejects hostile prototypes, getters, invalid resources, and overlong text", () => {
    const inherited = Object.assign(Object.create({ private: true }), propertyDetail);
    const getter = Object.defineProperty({ ...propertyDetail }, "name", {
      get() {
        throw new Error("private getter");
      },
    });

    for (const candidate of [
      inherited,
      getter,
      { ...propertyDetail, cover_url: "javascript:alert(1)" },
      { ...propertyDetail, description: "长".repeat(2001) },
      {
        ...propertyDetail,
        room_types: [{ ...roomSummary, id: "not-a-uuid" }],
      },
    ]) {
      expect(() => toPropertyDetailView(candidate)).toThrow(
        expect.objectContaining({ code: "INVALID_PROPERTY_DETAIL" }),
      );
    }
  });

  it("validates and snapshots only a complete search availability context", () => {
    const availability = toPropertyAvailability(search);
    expect(availability).toEqual({
      checkin: "2026-07-30",
      checkout: "2026-08-01",
      guests: 2,
    });
    search.guests = 4;
    expect(availability.guests).toBe(2);
    search.guests = 2;

    for (const candidate of [
      { ...search, city: null },
      { ...search, checkin: "2026-02-30" },
      { ...search, checkout: "2026-07-30" },
      { ...search, guests: 11 },
      Object.assign(Object.create({ inherited: true }), search),
    ]) {
      expect(() => toPropertyAvailability(candidate)).toThrow(
        expect.objectContaining({ code: "SEARCH_CONTEXT_INVALID" }),
      );
    }
  });

  it("uses a local error allowlist and never exposes server messages", () => {
    expect(
      safePropertyDetailError({ code: "PROPERTY_NOT_AVAILABLE" }),
    ).toBe("当前条件下该旅店暂无可售房型");
    expect(
      safePropertyDetailError({ code: "NETWORK_REQUEST_FAILED" }),
    ).toBe("网络连接不稳定，请重试");
    expect(
      safePropertyDetailError({
        code: "DATABASE_FAILURE",
        message: "private SQL and token",
      }),
    ).toBe("服务暂时不可用，请重试");
    expect(
      safePropertyDetailError(
        Object.defineProperty({}, "code", {
          get() {
            throw new Error("private getter");
          },
        }),
      ),
    ).toBe("服务暂时不可用，请重试");
  });
});

describe("property detail page state machine", () => {
  it("registers the fixed native page data shape", async () => {
    globalThis.Page = vi.fn();
    await import("../pages/property-detail/property-detail.js?registration=property");

    expect(globalThis.Page).toHaveBeenCalledOnce();
    expect(globalThis.Page.mock.calls[0][0]).toMatchObject({
      data: {
        status: "loading",
        property: null,
        errorMessage: "",
      },
      onLoad: expect.any(Function),
      retry: expect.any(Function),
    });
  });

  it("loads with only the UUID URL value and shared-store availability", async () => {
    const { catalogService, page } = createPage();

    await page.onLoad.call(page, { id: IDS.property });

    expect(catalogService.getProperty).toHaveBeenCalledWith(IDS.property, {
      checkin: "2026-07-30",
      checkout: "2026-08-01",
      guests: 2,
    });
    expect(page.data).toMatchObject({
      status: "success",
      errorMessage: "",
      property: expect.objectContaining({
        id: IDS.property,
        roomTypes: [expect.objectContaining({ id: IDS.room })],
      }),
    });
    expect(JSON.stringify(catalogService.getProperty.mock.calls)).not.toContain(
      IDS.city,
    );
  });

  it("reaches the empty-room page state through the real catalog service contract", async () => {
    const requestClient = {
      get: vi.fn(async () => ({ ...propertyDetail, room_types: [] })),
    };
    const catalogService = createCatalogService(requestClient);
    const app = {
      globalData: {
        searchStore: { get: vi.fn(() => search) },
      },
    };
    const page = pageContext(
      createPropertyDetailPage({
        catalogService,
        getApp: () => app,
        wxApi: {
          navigateBack: vi.fn(),
          navigateTo: vi.fn(),
          reLaunch: vi.fn(),
        },
      }),
    );

    await page.onLoad.call(page, { id: IDS.property });

    expect(requestClient.get).toHaveBeenCalledWith(
      `/properties/${IDS.property}?checkin=2026-07-30&checkout=2026-08-01&guests=2`,
    );
    expect(page.data).toMatchObject({
      status: "success",
      errorMessage: "",
      property: {
        roomTypes: [],
      },
    });
  });

  it.each([
    undefined,
    {},
    { id: "ABCDEF00-0000-4000-8000-000000000002" },
    { id: "10000000-0000-1000-8000-000000000001" },
    { id: "../../private?token=secret" },
    Object.create({ id: IDS.property }),
  ])("blocks a non-canonical UUID and safely returns to the list", async (options) => {
    const { catalogService, page, wxApi } = createPage();

    await page.onLoad.call(page, options);

    expect(catalogService.getProperty).not.toHaveBeenCalled();
    expect(wxApi.navigateBack).toHaveBeenCalledWith(
      expect.objectContaining({ delta: 1 }),
    );
    expect(page.data).toEqual({
      status: "error",
      property: null,
      errorMessage: "旅店链接无效，请返回列表重新选择",
    });
    expect(JSON.stringify(page.data)).not.toContain("secret");
  });

  it("falls back home when list return throws, fails by callback, or rejects", async () => {
    for (const navigateBack of [
      vi.fn(() => {
        throw new Error("private native error");
      }),
      vi.fn(({ fail }) => fail({ message: "private" })),
      vi.fn(() => Promise.reject(new Error("private rejection"))),
    ]) {
      const wxApi = {
        navigateBack,
        navigateTo: vi.fn(),
        reLaunch: vi.fn(() => Promise.resolve()),
      };
      const { page } = createPage({ wxApi });
      await page.onLoad.call(page, { id: "bad" });
      await Promise.resolve();
      await Promise.resolve();

      expect(wxApi.reLaunch).toHaveBeenCalledWith(
        expect.objectContaining({ url: "/pages/home/home" }),
      );
      expect(JSON.stringify(page.data)).not.toContain("private");
    }
  });

  it("blocks an invalid search context, returns home, and never requests", async () => {
    const getProperty = vi.fn();
    const wxApi = {
      navigateBack: vi.fn(),
      navigateTo: vi.fn(),
      reLaunch: vi.fn(() => {
        throw new Error("private native failure");
      }),
    };
    const { page } = createPage({
      getProperty,
      searchValue: { ...search, guests: 99 },
      wxApi,
    });

    await page.onLoad.call(page, { id: IDS.property });

    expect(getProperty).not.toHaveBeenCalled();
    expect(wxApi.navigateBack).not.toHaveBeenCalled();
    expect(wxApi.reLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ url: "/pages/home/home" }),
    );
    expect(page.data).toEqual({
      status: "error",
      property: null,
      errorMessage: "搜索条件已失效，请返回首页重新选择",
    });
  });

  it("renders a safe error and retries the same request", async () => {
    const getProperty = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("private server body"), {
          code: "NETWORK_REQUEST_FAILED",
        }),
      )
      .mockResolvedValueOnce(propertyDetail);
    const { page } = createPage({ getProperty });

    await page.onLoad.call(page, { id: IDS.property });
    expect(page.data).toEqual({
      status: "error",
      property: null,
      errorMessage: "网络连接不稳定，请重试",
    });

    await page.retry.call(page);
    expect(getProperty).toHaveBeenCalledTimes(2);
    expect(page.data.status).toBe("success");
    expect(JSON.stringify(page.data)).not.toContain("private");
  });

  it("silences late results after hide/unload and reloads only hidden loading work", async () => {
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const getProperty = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const { page } = createPage({ getProperty });

    const initial = page.onLoad.call(page, { id: IDS.property });
    page.onHide.call(page);
    first.resolve(propertyDetail);
    await initial;
    expect(page.data.status).toBe("loading");

    const resumed = page.onShow.call(page);
    second.resolve(propertyDetail);
    await resumed;
    expect(page.data.status).toBe("success");

    page.onHide.call(page);
    page.onShow.call(page);
    expect(getProperty).toHaveBeenCalledTimes(2);

    page.data.status = "loading";
    page.onHide.call(page);
    const unloading = page.onShow.call(page);
    page.onUnload.call(page);
    third.resolve(propertyDetail);
    await unloading;
    expect(page.data.status).toBe("loading");
  });

  it("navigates only to an owned room UUID and safely unlocks failed navigation", async () => {
    const rejected = deferred();
    const wxApi = {
      navigateBack: vi.fn(),
      navigateTo: vi
        .fn()
        .mockReturnValueOnce(rejected.promise)
        .mockImplementationOnce(({ fail }) => fail()),
      reLaunch: vi.fn(),
    };
    const { page } = createPage({ wxApi });
    await page.onLoad.call(page, { id: IDS.property });

    page.openRoom.call(page, {
      currentTarget: { dataset: { id: IDS.room } },
    });
    page.openRoom.call(page, {
      currentTarget: { dataset: { id: IDS.room } },
    });
    rejected.reject(new Error("navigation failed"));
    await Promise.resolve();
    await Promise.resolve();
    page.openRoom.call(page, {
      currentTarget: { dataset: { id: IDS.room } },
    });
    page.openRoom.call(page, {
      currentTarget: { dataset: { id: IDS.otherRoom } },
    });
    page.openRoom.call(page, {
      currentTarget: { dataset: Object.create({ id: IDS.room }) },
    });

    expect(wxApi.navigateTo).toHaveBeenCalledTimes(2);
    expect(wxApi.navigateTo.mock.calls[0][0].url).toBe(
      `/pages/room-detail/room-detail?id=${encodeURIComponent(IDS.room)}`,
    );
  });

  it("marks only the matching failed cover, gallery, or room image", async () => {
    const { page } = createPage();
    await page.onLoad.call(page, { id: IDS.property });

    page.handleImageError.call(page, {
      currentTarget: {
        dataset: {
          kind: "media",
          index: 0,
          src: "/images/properties/xihu-gallery.jpg",
        },
      },
    });
    expect(page.data.property.media[0].failed).toBe(true);

    page.handleImageError.call(page, {
      currentTarget: {
        dataset: { kind: "cover", src: "forged.jpg" },
      },
    });
    expect(page.data.property.coverFailed).toBe(false);
  });
});

describe("property detail native files", () => {
  it("registers approved components and renders safe accessible detail content", async () => {
    const [jsonSource, wxml, wxss] = await Promise.all([
      readFile(
        new URL("../pages/property-detail/property-detail.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../pages/property-detail/property-detail.wxml", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../pages/property-detail/property-detail.wxss", import.meta.url),
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
        price: "/components/price/price",
      },
    });
    expect(wxml).toContain("{{property.name}}");
    expect(wxml).toContain("{{property.description}}");
    expect(wxml).toContain("{{property.policies}}");
    expect(wxml).toContain('wx:for="{{property.media}}"');
    expect(wxml).toContain('wx:for="{{property.facilities}}"');
    expect(wxml).toContain('wx:for="{{property.roomTypes}}"');
    expect(wxml).toContain("当前条件暂无可售房型");
    expect(wxml).toContain('bindtap="openRoom"');
    expect(wxml).toContain('binderror="handleImageError"');
    expect(wxml).not.toContain("rich-text");
    expect(wxml).not.toMatch(/data-(?:search|context|guests|checkin|checkout)=/);
    expect(wxss).toContain("env(safe-area-inset-bottom)");
    expect(wxss).toContain("var(--color-brand)");
    expect(wxss).toContain("var(--radius-medium)");
    expect(wxss).toContain("min-height: 88rpx");
  });
});

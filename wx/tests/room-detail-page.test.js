import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import roomDetailLogic from "../pages/room-detail/room-detail.logic.js";
import roomDetailPage from "../pages/room-detail/room-detail.js";

const {
  safeRoomDetailError,
  toRoomAvailability,
  toRoomDetailView,
} = roomDetailLogic;
const { createRoomDetailPage } = roomDetailPage;

const IDS = {
  city: "10000000-0000-4000-8000-000000000001",
  property: "20000000-0000-4000-8000-000000000002",
  room: "30000000-0000-4000-8000-000000000003",
};
const search = {
  city: { id: IDS.city, code: "330100", name: "杭州" },
  checkin: "2026-07-30",
  checkout: "2026-08-01",
  guests: 2,
};
const roomDetail = {
  id: IDS.room,
  name: "湖景大床房",
  bed_type: "大床",
  area_sqm: 35,
  max_guests: 2,
  cover_url: "/images/rooms/lake.jpg",
  currency: "CNY",
  property: {
    id: IDS.property,
    type: "HOTEL",
    name: "西湖云栖酒店",
    city: search.city,
  },
  description: "面向西湖的宽敞客房。",
  booking_policy: "入住当日 18:00 前可免费取消。",
  nightly_prices: [
    {
      business_date: "2026-07-30",
      sale_price_cents: 59900,
      rack_price_cents: 69900,
      currency: "CNY",
    },
    {
      business_date: "2026-07-31",
      sale_price_cents: 62900,
      rack_price_cents: 72900,
      currency: "CNY",
    },
  ],
};
const FORBIDDEN_FIELDS = [
  "total_inventory",
  "held_inventory",
  "sold_inventory",
  "version",
];

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
  getRoomType = vi.fn(async () => roomDetail),
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
    reLaunch: vi.fn(),
    showModal: vi.fn(),
  };
  const catalogService = { getRoomType };
  return {
    catalogService,
    page: pageContext(
      createRoomDetailPage({
        catalogService,
        getApp: () => app,
        wxApi: safeWxApi,
      }),
    ),
    searchStore,
    wxApi: safeWxApi,
  };
}

describe("room detail pure logic", () => {
  it("copies safe display content and preserves server nightly order", () => {
    const view = toRoomDetailView(roomDetail);

    expect(view).toMatchObject({
      id: IDS.room,
      name: "湖景大床房",
      bedType: "大床",
      areaLabel: "35㎡",
      maxGuestsLabel: "最多 2 人",
      coverUrl: "/images/rooms/lake.jpg",
      coverFailed: false,
      property: {
        id: IDS.property,
        typeLabel: "酒店",
        name: "西湖云栖酒店",
        cityName: "杭州",
      },
      description: "面向西湖的宽敞客房。",
      bookingPolicy: "入住当日 18:00 前可免费取消。",
    });
    expect(view.nightlyPrices).toEqual([
      {
        businessDate: "2026-07-30",
        dateLabel: "7月30日",
        salePriceCents: 59900,
      },
      {
        businessDate: "2026-07-31",
        dateLabel: "7月31日",
        salePriceCents: 62900,
      },
    ]);

    roomDetail.property.name = "已篡改";
    roomDetail.nightly_prices[0].sale_price_cents = 1;
    expect(view.property.name).toBe("西湖云栖酒店");
    expect(view.nightlyPrices[0].salePriceCents).toBe(59900);
    roomDetail.property.name = "西湖云栖酒店";
    roomDetail.nightly_prices[0].sale_price_cents = 59900;
  });

  it("does not retain any internal inventory-shaped fields in the view", () => {
    const view = toRoomDetailView(roomDetail);
    const serialized = JSON.stringify(view);
    for (const field of FORBIDDEN_FIELDS) {
      expect(serialized).not.toContain(field);
    }
  });

  it("rejects hostile prototypes, getters, unsafe images, long text, and bad IDs", () => {
    const inherited = Object.assign(Object.create({ private: true }), roomDetail);
    const getter = Object.defineProperty({ ...roomDetail }, "description", {
      get() {
        throw new Error("private getter");
      },
    });
    for (const candidate of [
      inherited,
      getter,
      { ...roomDetail, cover_url: "file:///private" },
      { ...roomDetail, booking_policy: "长".repeat(2001) },
      { ...roomDetail, id: "30000000-0000-1000-8000-000000000003" },
      {
        ...roomDetail,
        property: { ...roomDetail.property, id: "not-a-uuid" },
      },
    ]) {
      expect(() => toRoomDetailView(candidate)).toThrow(
        expect.objectContaining({ code: "INVALID_ROOM_DETAIL" }),
      );
    }
  });

  it("validates and snapshots the shared search context", () => {
    const availability = toRoomAvailability(search);
    expect(availability).toEqual({
      checkin: "2026-07-30",
      checkout: "2026-08-01",
      guests: 2,
    });

    for (const candidate of [
      null,
      { ...search, city: null },
      { ...search, checkout: "2026-07-30" },
      { ...search, checkout: "2026-08-31" },
      { ...search, guests: 1.5 },
      Object.assign(Object.create({ inherited: true }), search),
    ]) {
      expect(() => toRoomAvailability(candidate)).toThrow(
        expect.objectContaining({ code: "SEARCH_CONTEXT_INVALID" }),
      );
    }
  });

  it("maps only allowlisted room errors to local messages", () => {
    expect(safeRoomDetailError({ code: "ROOM_NOT_AVAILABLE" })).toBe(
      "当前条件下该房型暂不可售",
    );
    expect(
      safeRoomDetailError({ code: "ROOM_CAPACITY_EXCEEDED" }),
    ).toBe("当前入住人数超过该房型上限");
    expect(
      safeRoomDetailError({
        code: "DATABASE_FAILURE",
        message: "private SQL",
      }),
    ).toBe("服务暂时不可用，请重试");
    expect(
      safeRoomDetailError(
        Object.defineProperty({}, "code", {
          get() {
            throw new Error("private getter");
          },
        }),
      ),
    ).toBe("服务暂时不可用，请重试");
  });
});

describe("room detail page state machine", () => {
  it("registers only status, roomType, and errorMessage in page data", async () => {
    globalThis.Page = vi.fn();
    await import("../pages/room-detail/room-detail.js?registration=room");

    expect(globalThis.Page).toHaveBeenCalledOnce();
    const definition = globalThis.Page.mock.calls[0][0];
    expect(Object.keys(definition.data)).toEqual([
      "status",
      "roomType",
      "errorMessage",
    ]);
    expect(definition.data).toEqual({
      status: "loading",
      roomType: null,
      errorMessage: "",
    });
  });

  it("loads only the URL UUID and store availability", async () => {
    const { catalogService, page } = createPage();

    await page.onLoad.call(page, { id: IDS.room });

    expect(catalogService.getRoomType).toHaveBeenCalledWith(IDS.room, {
      checkin: "2026-07-30",
      checkout: "2026-08-01",
      guests: 2,
    });
    expect(page.data).toMatchObject({
      status: "success",
      roomType: expect.objectContaining({
        id: IDS.room,
        property: expect.objectContaining({ id: IDS.property }),
      }),
      errorMessage: "",
    });
    expect(JSON.stringify(catalogService.getRoomType.mock.calls)).not.toContain(
      IDS.city,
    );
  });

  it.each([
    undefined,
    {},
    { id: "ABCDEF00-0000-4000-8000-000000000003" },
    { id: "30000000-0000-1000-8000-000000000003" },
    { id: "../../private?token=secret" },
    Object.create({ id: IDS.room }),
  ])("blocks a malformed room URL and safely returns", async (options) => {
    const { catalogService, page, wxApi } = createPage();

    await page.onLoad.call(page, options);

    expect(catalogService.getRoomType).not.toHaveBeenCalled();
    expect(wxApi.navigateBack).toHaveBeenCalledWith(
      expect.objectContaining({ delta: 1 }),
    );
    expect(page.data).toEqual({
      status: "error",
      roomType: null,
      errorMessage: "房型链接无效，请返回旅店重新选择",
    });
  });

  it("falls back home for callback, throw, and rejected return failures", async () => {
    for (const navigateBack of [
      vi.fn(({ fail }) => fail()),
      vi.fn(() => {
        throw new Error("private native failure");
      }),
      vi.fn(() => Promise.reject(new Error("private promise rejection"))),
    ]) {
      const wxApi = {
        navigateBack,
        reLaunch: vi.fn(() => Promise.resolve()),
        showModal: vi.fn(),
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

  it("blocks a bad search context and returns home without a request", async () => {
    const getRoomType = vi.fn();
    const wxApi = {
      navigateBack: vi.fn(),
      reLaunch: vi.fn(() => false),
      showModal: vi.fn(),
    };
    const { page } = createPage({
      getRoomType,
      searchValue: () => {
        throw new Error("private storage error");
      },
      wxApi,
    });

    await page.onLoad.call(page, { id: IDS.room });

    expect(getRoomType).not.toHaveBeenCalled();
    expect(wxApi.navigateBack).not.toHaveBeenCalled();
    expect(wxApi.reLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ url: "/pages/home/home" }),
    );
    expect(page.data).toEqual({
      status: "error",
      roomType: null,
      errorMessage: "搜索条件已失效，请返回首页重新选择",
    });
  });

  it("renders safe errors and retries without changing availability", async () => {
    const getRoomType = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("private server message"), {
          code: "ROOM_NOT_AVAILABLE",
        }),
      )
      .mockResolvedValueOnce(roomDetail);
    const { page } = createPage({ getRoomType });

    await page.onLoad.call(page, { id: IDS.room });
    expect(page.data).toEqual({
      status: "error",
      roomType: null,
      errorMessage: "当前条件下该房型暂不可售",
    });

    await page.retry.call(page);
    expect(getRoomType).toHaveBeenCalledTimes(2);
    expect(getRoomType.mock.calls[1]).toEqual(getRoomType.mock.calls[0]);
    expect(page.data.status).toBe("success");
  });

  it("suppresses late results across hide/unload and resumes hidden loading work", async () => {
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const getRoomType = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const { page } = createPage({ getRoomType });

    const initial = page.onLoad.call(page, { id: IDS.room });
    page.onHide.call(page);
    first.resolve(roomDetail);
    await initial;
    expect(page.data.status).toBe("loading");

    const resumed = page.onShow.call(page);
    second.resolve(roomDetail);
    await resumed;
    expect(page.data.status).toBe("success");

    page.onHide.call(page);
    page.onShow.call(page);
    expect(getRoomType).toHaveBeenCalledTimes(2);

    page.data.status = "loading";
    page.onHide.call(page);
    const unloading = page.onShow.call(page);
    page.onUnload.call(page);
    third.resolve(roomDetail);
    await unloading;
    expect(page.data.status).toBe("loading");
  });

  it("shows only the exact Slice 3 notice and performs no fake booking action", async () => {
    const modal = deferred();
    const wxApi = {
      navigateBack: vi.fn(),
      reLaunch: vi.fn(),
      showModal: vi.fn(() => modal.promise),
      navigateTo: vi.fn(),
      request: vi.fn(),
      setStorageSync: vi.fn(),
      setStorage: vi.fn(),
    };
    const { catalogService, page } = createPage({ wxApi });
    await page.onLoad.call(page, { id: IDS.room });

    page.selectRoom.call(page, {
      currentTarget: Object.create({ dataset: { order: "forged" } }),
    });
    page.selectRoom.call(page);
    expect(wxApi.showModal).toHaveBeenCalledOnce();
    expect(wxApi.showModal).toHaveBeenCalledWith({
      title: "预订功能即将开放",
      content: "报价与预订将在下一开发切片开放",
      showCancel: false,
    });
    expect(catalogService).not.toHaveProperty("post");
    expect(wxApi.request).not.toHaveBeenCalled();
    expect(wxApi.setStorageSync).not.toHaveBeenCalled();
    expect(wxApi.setStorage).not.toHaveBeenCalled();
    expect(wxApi.navigateTo).not.toHaveBeenCalled();

    modal.reject(new Error("private modal failure"));
    await Promise.resolve();
    await Promise.resolve();
    page.selectRoom.call(page);
    expect(wxApi.showModal).toHaveBeenCalledTimes(2);
  });

  it("ignores selection unless active success and safely handles image failures", async () => {
    const wxApi = {
      navigateBack: vi.fn(),
      reLaunch: vi.fn(),
      showModal: vi.fn(),
    };
    const { page } = createPage({ wxApi });
    page.selectRoom.call(page);
    expect(wxApi.showModal).not.toHaveBeenCalled();

    await page.onLoad.call(page, { id: IDS.room });
    page.handleImageError.call(page, {
      currentTarget: {
        dataset: { src: "/images/rooms/lake.jpg" },
      },
    });
    expect(page.data.roomType.coverFailed).toBe(true);

    page.onHide.call(page);
    page.selectRoom.call(page);
    expect(wxApi.showModal).not.toHaveBeenCalled();
  });
});

describe("room detail native files", () => {
  it("renders approved components, nightly prices, safe area, and no internal fields", async () => {
    const [jsonSource, logic, pageSource, wxml, wxss] = await Promise.all([
      readFile(new URL("../pages/room-detail/room-detail.json", import.meta.url), "utf8"),
      readFile(
        new URL("../pages/room-detail/room-detail.logic.js", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../pages/room-detail/room-detail.js", import.meta.url), "utf8"),
      readFile(new URL("../pages/room-detail/room-detail.wxml", import.meta.url), "utf8"),
      readFile(new URL("../pages/room-detail/room-detail.wxss", import.meta.url), "utf8"),
    ]);

    expect(JSON.parse(jsonSource)).toEqual({
      navigationStyle: "custom",
      usingComponents: {
        "navigation-bar": "/components/navigation-bar/navigation-bar",
        "loading-state": "/components/loading-state/loading-state",
        "error-state": "/components/error-state/error-state",
        price: "/components/price/price",
      },
    });
    expect(wxml).toContain("{{roomType.property.name}}");
    expect(wxml).toContain("{{roomType.description}}");
    expect(wxml).toContain("{{roomType.bookingPolicy}}");
    expect(wxml).toContain('wx:for="{{roomType.nightlyPrices}}"');
    expect(wxml).toContain('cents="{{item.salePriceCents}}"');
    expect(wxml).toContain('bindtap="selectRoom"');
    expect(wxml).toContain('binderror="handleImageError"');
    expect(wxml).not.toContain("rich-text");
    expect(wxml).not.toMatch(/data-(?:search|context|guests|checkin|checkout)=/);
    for (const source of [logic, pageSource, wxml]) {
      for (const field of FORBIDDEN_FIELDS) {
        expect(source).not.toContain(field);
      }
    }
    expect(pageSource).not.toMatch(/setStorage|request\s*\(|\.post\s*\(/);
    expect(logic).not.toMatch(/\.reduce\s*\(/);
    expect(wxss).toContain("env(safe-area-inset-bottom)");
    expect(wxss).toContain("var(--color-brand)");
    expect(wxss).toContain("var(--radius-medium)");
    expect(wxss).toContain("min-height: 88rpx");
  });
});

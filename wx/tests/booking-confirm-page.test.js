import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import bookingConfirmLogic from "../pages/booking-confirm/booking-confirm.logic.js";
import bookingConfirmPage from "../pages/booking-confirm/booking-confirm.js";

const {
  createBookingView,
  createQuoteView,
  quoteChangedView,
  remainingSeconds,
} = bookingConfirmLogic;
const { createBookingConfirmPage } = bookingConfirmPage;

const IDS = {
  property: "10000000-0000-4000-8000-000000000001",
  room: "20000000-0000-4000-8000-000000000001",
  quote: "30000000-0000-4000-8000-000000000001",
  replacement: "30000000-0000-4000-8000-000000000002",
  booking: "40000000-0000-4000-8000-000000000001",
};
const NOW = Date.parse("2026-07-30T02:00:00.000Z");
const KEY = "booking-scope-1234567890_ABCDEFGHIJ";
const NEXT_KEY = "booking-scope-1234567890_KLMNOPQRST";
const search = {
  city: {
    id: "50000000-0000-4000-8000-000000000001",
    code: "330100",
    name: "杭州",
  },
  checkin: "2026-08-01",
  checkout: "2026-08-03",
  guests: 2,
};
const quote = {
  quote_id: IDS.quote,
  property: { id: IDS.property, name: "西湖云栖酒店" },
  room_type: {
    id: IDS.room,
    name: "湖景大床房",
    cover_url: "/images/catalog/hangzhou-hotel-room-1.jpg",
  },
  checkin: search.checkin,
  checkout: search.checkout,
  nights: 2,
  guests: search.guests,
  nightly_prices: [
    {
      business_date: "2026-08-01",
      sale_price_cents: 58800,
      rack_price_cents: 68800,
      currency: "CNY",
    },
    {
      business_date: "2026-08-02",
      sale_price_cents: 62800,
      rack_price_cents: 72800,
      currency: "CNY",
    },
  ],
  total_price_cents: 121600,
  currency: "CNY",
  booking_policy: "入住前一天 18:00 前可免费取消",
  expires_at: "2026-07-30T02:05:00.000Z",
};
const replacementQuote = {
  ...quote,
  quote_id: IDS.replacement,
  nightly_prices: [
    quote.nightly_prices[0],
    {
      ...quote.nightly_prices[1],
      sale_price_cents: 64800,
    },
  ],
  total_price_cents: 123600,
  expires_at: "2026-07-30T02:06:00.000Z",
};
const booking = {
  booking_id: IDS.booking,
  quote_id: IDS.quote,
  booking_number: "SF20260730A1B2C3D4E5F6",
  status: "PENDING_PAYMENT",
  property_name: quote.property.name,
  room_type_name: quote.room_type.name,
  checkin: quote.checkin,
  checkout: quote.checkout,
  nights: quote.nights,
  guests: quote.guests,
  total_price_cents: quote.total_price_cents,
  currency: "CNY",
  expires_at: "2026-07-30T02:15:00.000Z",
  created_at: "2026-07-30T02:00:00.000Z",
};

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
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

function createHarness({
  clockValue = NOW,
  createQuote = vi.fn(async () => quote),
  createBooking = vi.fn(async () => booking),
  getKey = vi.fn(() => KEY),
  searchValue = search,
  wxApi,
} = {}) {
  let now = clockValue;
  let intervalCallback;
  let intervalId = 0;
  const timerApi = {
    clearInterval: vi.fn(),
    setInterval: vi.fn((callback, milliseconds) => {
      intervalCallback = callback;
      intervalId += 1;
      expect(milliseconds).toBe(1000);
      return intervalId;
    }),
  };
  const bookingApi = { createBooking, createQuote };
  const idempotency = {
    clear: vi.fn(),
    get: getKey,
  };
  const searchStore = {
    get:
      typeof searchValue === "function"
        ? vi.fn(searchValue)
        : vi.fn(() => searchValue),
  };
  const safeWxApi = wxApi || {
    navigateBack: vi.fn(({ success } = {}) => success?.()),
    reLaunch: vi.fn(({ success } = {}) => success?.()),
    showModal: vi.fn(({ success, complete } = {}) => {
      success?.({ confirm: true });
      complete?.({ confirm: true });
    }),
    showToast: vi.fn(({ success, complete } = {}) => {
      success?.();
      complete?.();
    }),
  };
  const page = pageContext(
    createBookingConfirmPage({
      bookingApi,
      clock: () => now,
      getApp: () => ({ globalData: { searchStore } }),
      idempotency,
      timerApi,
      wxApi: safeWxApi,
    }),
  );
  return {
    bookingApi,
    idempotency,
    page,
    searchStore,
    setNow(value) {
      now = value;
    },
    tick() {
      intervalCallback?.();
    },
    timerApi,
    wxApi: safeWxApi,
  };
}

describe("booking confirmation pure logic", () => {
  it("uses server nights, totals, and nightly rows without recomputing them", () => {
    const view = createQuoteView(quote, NOW);

    expect(view).toEqual({
      quoteId: IDS.quote,
      property: { id: IDS.property, name: "西湖云栖酒店" },
      roomType: {
        id: IDS.room,
        name: "湖景大床房",
        coverUrl: "/images/catalog/hangzhou-hotel-room-1.jpg",
      },
      checkin: "2026-08-01",
      checkout: "2026-08-03",
      nights: 2,
      guests: 2,
      nightlyPrices: [
        {
          businessDate: "2026-08-01",
          salePriceCents: 58800,
          salePriceLabel: "¥588.00",
          rackPriceCents: 68800,
          rackPriceLabel: "¥688.00",
        },
        {
          businessDate: "2026-08-02",
          salePriceCents: 62800,
          salePriceLabel: "¥628.00",
          rackPriceCents: 72800,
          rackPriceLabel: "¥728.00",
        },
      ],
      totalPriceCents: 121600,
      totalPriceLabel: "¥1216.00",
      currency: "CNY",
      bookingPolicy: "入住前一天 18:00 前可免费取消",
      expiresAt: "2026-07-30T02:05:00.000Z",
      remainingSeconds: 300,
      expired: false,
    });
    expect(JSON.stringify(view)).not.toContain("unknown");
  });

  it("clamps expiration and creates detached, allowlisted views", () => {
    expect(remainingSeconds(quote.expires_at, NOW + 300001)).toBe(0);
    expect(remainingSeconds(quote.expires_at, NOW + 299001)).toBe(1);

    const bookingView = createBookingView({ ...booking, unknown: "private" });
    expect(bookingView).toEqual({
      bookingId: IDS.booking,
      quoteId: IDS.quote,
      bookingNumber: "SF20260730A1B2C3D4E5F6",
      status: "PENDING_PAYMENT",
      propertyName: "西湖云栖酒店",
      roomTypeName: "湖景大床房",
      checkin: "2026-08-01",
      checkout: "2026-08-03",
      nights: 2,
      guests: 2,
      totalPriceCents: 121600,
      totalPriceLabel: "¥1216.00",
      currency: "CNY",
      expiresAt: "2026-07-30T02:15:00.000Z",
      createdAt: "2026-07-30T02:00:00.000Z",
    });
    expect(JSON.stringify(bookingView)).not.toContain("private");
  });

  it("shows explicit old and new totals for a replacement quote", () => {
    const changed = quoteChangedView(
      quote.total_price_cents,
      { ...replacementQuote, unknown: "private" },
      NOW,
    );

    expect(changed.previousTotalPriceCents).toBe(121600);
    expect(changed.previousTotalPriceLabel).toBe("¥1216.00");
    expect(changed.newTotalPriceCents).toBe(123600);
    expect(changed.newTotalPriceLabel).toBe("¥1236.00");
    expect(changed.replacementQuote.quoteId).toBe(IDS.replacement);
    expect(JSON.stringify(changed)).not.toContain("unknown");
  });
});

describe("booking confirmation page state machine", () => {
  it("registers the accessible state model and loads from only UUID plus searchStore", async () => {
    globalThis.Page = vi.fn();
    await import("../pages/booking-confirm/booking-confirm.js?registration=booking");
    expect(globalThis.Page).toHaveBeenCalledOnce();

    const { bookingApi, page, searchStore, timerApi } = createHarness();
    await page.onLoad.call(page, { room_type_id: IDS.room });

    expect(searchStore.get).toHaveBeenCalledOnce();
    expect(bookingApi.createQuote).toHaveBeenCalledWith(
      {
        room_type_id: IDS.room,
        checkin: search.checkin,
        checkout: search.checkout,
        guests: search.guests,
      },
      { isActive: expect.any(Function) },
    );
    expect(page.data).toMatchObject({
      status: "quote_ready",
      quote: expect.objectContaining({ quoteId: IDS.quote }),
      booking: null,
      changed: null,
      errorMessage: "",
      remainingSeconds: 300,
      submitDisabled: false,
      submitPressed: false,
    });
    expect(timerApi.setInterval).toHaveBeenCalledOnce();
  });

  it.each([
    undefined,
    {},
    { room_type_id: "ABCDEF00-0000-4000-8000-000000000001" },
    { room_type_id: "20000000-0000-1000-8000-000000000001" },
    { room_type_id: "../../private?token=secret" },
    { room_type_id: IDS.room, extra: true },
    Object.create({ room_type_id: IDS.room }),
  ])("rejects malformed room links before reading search state", async (options) => {
    const { bookingApi, page, searchStore, wxApi } = createHarness();
    await page.onLoad.call(page, options);

    expect(searchStore.get).not.toHaveBeenCalled();
    expect(bookingApi.createQuote).not.toHaveBeenCalled();
    expect(page.data.status).toBe("quote_error");
    expect(page.data.errorMessage).toBe("房型链接无效，请返回重新选择");
    expect(wxApi.showModal).toHaveBeenCalledOnce();
    expect(wxApi.navigateBack).toHaveBeenCalled();
  });

  it("handles invalid search, quote failure, and explicit retry safely", async () => {
    const privateError = Object.defineProperty({}, "code", {
      get() {
        throw new Error("private getter");
      },
    });
    const createQuote = vi
      .fn()
      .mockRejectedValueOnce(privateError)
      .mockResolvedValueOnce(quote);
    const first = createHarness({
      searchValue: () => {
        throw new Error("private storage");
      },
    });
    await first.page.onLoad.call(first.page, { room_type_id: IDS.room });
    expect(first.bookingApi.createQuote).not.toHaveBeenCalled();
    expect(first.page.data).toMatchObject({
      status: "quote_error",
      errorMessage: "搜索条件已失效，请返回首页重新选择",
    });

    const second = createHarness({ createQuote });
    await second.page.onLoad.call(second.page, { room_type_id: IDS.room });
    expect(second.page.data).toMatchObject({
      status: "quote_error",
      errorMessage: "报价服务暂时不可用，请重试",
    });
    await second.page.retryQuote.call(second.page);
    expect(createQuote).toHaveBeenCalledTimes(2);
    expect(second.page.data.status).toBe("quote_ready");
  });

  it("recomputes a fixed one-second countdown without changing server expiration", async () => {
    const harness = createHarness();
    await harness.page.onLoad.call(harness.page, {
      room_type_id: IDS.room,
    });
    const expiresAt = harness.page.data.quote.expiresAt;

    harness.setNow(NOW + 299500);
    harness.tick();
    expect(harness.page.data.remainingSeconds).toBe(1);
    expect(harness.page.data.submitDisabled).toBe(false);
    harness.setNow(NOW + 300001);
    harness.tick();
    expect(harness.page.data.remainingSeconds).toBe(0);
    expect(harness.page.data.submitDisabled).toBe(true);
    expect(harness.page.data.quote.expiresAt).toBe(expiresAt);
  });

  it("deduplicates double clicks and passes only quote ID plus trusted context", async () => {
    const pending = deferred();
    const createBooking = vi.fn(() => pending.promise);
    const harness = createHarness({ createBooking });
    await harness.page.onLoad.call(harness.page, {
      room_type_id: IDS.room,
    });

    const first = harness.page.confirmBooking.call(harness.page);
    const second = harness.page.confirmBooking.call(harness.page);
    await Promise.resolve();
    expect(createBooking).toHaveBeenCalledOnce();
    expect(createBooking).toHaveBeenCalledWith(
      { quote_id: IDS.quote },
      KEY,
      {
        isActive: expect.any(Function),
        expectedQuote: {
          property_id: IDS.property,
          room_type_id: IDS.room,
        },
      },
    );
    expect(harness.page.data).toMatchObject({
      status: "submitting",
      submitDisabled: true,
      submitPressed: true,
    });

    pending.resolve(booking);
    await Promise.all([first, second]);
    expect(harness.page.data.status).toBe("booking_created");
  });

  it("reuses the same idempotency key after an uncertain network failure", async () => {
    const createBooking = vi
      .fn()
      .mockRejectedValueOnce({ code: "NETWORK_REQUEST_FAILED" })
      .mockResolvedValueOnce(booking);
    const harness = createHarness({ createBooking });
    await harness.page.onLoad.call(harness.page, {
      room_type_id: IDS.room,
    });

    await harness.page.confirmBooking.call(harness.page);
    expect(harness.page.data).toMatchObject({
      status: "booking_error",
      errorMessage: "网络连接不稳定，请使用同一订单请求重试",
      submitDisabled: false,
      submitPressed: false,
    });
    await harness.page.confirmBooking.call(harness.page);

    expect(harness.idempotency.get).toHaveBeenCalledTimes(2);
    expect(harness.idempotency.get).toHaveBeenNthCalledWith(
      1,
      `quote:${IDS.quote}`,
    );
    expect(harness.idempotency.get).toHaveBeenNthCalledWith(
      2,
      `quote:${IDS.quote}`,
    );
    expect(harness.idempotency.clear).toHaveBeenCalledWith(
      `quote:${IDS.quote}`,
    );
    expect(harness.page.data.status).toBe("booking_created");
  });

  it.each([
    [
      "network",
      async (harness) => {
        await harness.page.confirmBooking.call(harness.page);
        expect(harness.page.data.errorCode).toBe("NETWORK_REQUEST_FAILED");
      },
    ],
    [
      "generic service",
      async (harness) => {
        await harness.page.confirmBooking.call(harness.page);
        expect(harness.page.data.errorCode).toBe(
          "BOOKING_SERVICE_UNAVAILABLE",
        );
      },
    ],
    [
      "hidden uncertain result",
      async (harness) => {
        harness.page.data.status = "submitting";
        harness.page.onHide.call(harness.page);
        harness.page.onShow.call(harness.page);
        expect(harness.page.data.errorCode).toBe(
          "BOOKING_RESULT_UNCERTAIN",
        );
      },
    ],
  ])(
    "does not retire or requote a %s booking error through retryQuote",
    async (_label, enterError) => {
      const createQuote = vi.fn(async () => quote);
      const createBooking = vi.fn(async () => {
        throw {
          code:
            _label === "network"
              ? "NETWORK_REQUEST_FAILED"
              : "BOOKING_SERVICE_UNAVAILABLE",
        };
      });
      const harness = createHarness({ createBooking, createQuote });
      await harness.page.onLoad.call(harness.page, {
        room_type_id: IDS.room,
      });
      await enterError(harness);
      const quoteCalls = createQuote.mock.calls.length;
      harness.idempotency.clear.mockClear();

      await harness.page.retryQuote.call(harness.page);

      expect(harness.idempotency.clear).not.toHaveBeenCalled();
      expect(createQuote).toHaveBeenCalledTimes(quoteCalls);
      expect(harness.page.data.status).toBe("booking_error");
    },
  );

  it("requires explicit acceptance of QUOTE_CHANGED and then uses a new scope", async () => {
    const changedError = {
      code: "QUOTE_CHANGED",
      details: {
        previous_total_price_cents: quote.total_price_cents,
        replacement_quote: replacementQuote,
      },
    };
    const replacementBooking = {
      ...booking,
      quote_id: IDS.replacement,
      total_price_cents: replacementQuote.total_price_cents,
    };
    const createBooking = vi
      .fn()
      .mockRejectedValueOnce(changedError)
      .mockResolvedValueOnce(replacementBooking);
    const getKey = vi
      .fn()
      .mockReturnValueOnce(KEY)
      .mockReturnValueOnce(NEXT_KEY);
    const harness = createHarness({ createBooking, getKey });
    await harness.page.onLoad.call(harness.page, {
      room_type_id: IDS.room,
    });

    await harness.page.confirmBooking.call(harness.page);
    expect(harness.page.data.status).toBe("quote_changed");
    expect(harness.page.data.changed).toMatchObject({
      previousTotalPriceLabel: "¥1216.00",
      newTotalPriceLabel: "¥1236.00",
    });
    expect(createBooking).toHaveBeenCalledOnce();

    harness.page.acceptChangedQuote.call(harness.page);
    expect(harness.idempotency.clear).toHaveBeenCalledWith(
      `quote:${IDS.quote}`,
    );
    expect(harness.page.data).toMatchObject({
      status: "quote_ready",
      quote: expect.objectContaining({ quoteId: IDS.replacement }),
      changed: null,
    });
    await harness.page.confirmBooking.call(harness.page);
    expect(harness.idempotency.get).toHaveBeenLastCalledWith(
      `quote:${IDS.replacement}`,
    );
    expect(createBooking.mock.calls[1][0]).toEqual({
      quote_id: IDS.replacement,
    });
  });

  it.each([
    ["QUOTE_EXPIRED", "当前报价已失效，请重新获取报价"],
    ["INVENTORY_UNAVAILABLE", "所选日期库存不足，请重新选择"],
    ["QUOTE_ALREADY_USED", "该报价已被使用，请重新获取报价"],
  ])("shows an explicit %s state and retires its scope", async (code, message) => {
    const createBooking = vi.fn(async () => {
      throw { code };
    });
    const harness = createHarness({ createBooking });
    await harness.page.onLoad.call(harness.page, {
      room_type_id: IDS.room,
    });
    await harness.page.confirmBooking.call(harness.page);

    expect(harness.page.data).toMatchObject({
      status: "booking_error",
      errorCode: code,
      errorMessage: message,
      submitDisabled: true,
      submitPressed: false,
    });
    expect(harness.idempotency.clear).toHaveBeenCalledWith(
      `quote:${IDS.quote}`,
    );

    const clearCount = harness.idempotency.clear.mock.calls.length;
    const quoteCalls = harness.bookingApi.createQuote.mock.calls.length;
    await harness.page.retryQuote.call(harness.page);
    expect(harness.idempotency.clear.mock.calls.length).toBe(clearCount + 1);
    expect(harness.bookingApi.createQuote).toHaveBeenCalledTimes(
      quoteCalls + 1,
    );
  });

  it("renders pending-payment success in place and invokes no payment API", async () => {
    const wxApi = {
      navigateBack: vi.fn(),
      navigateTo: vi.fn(),
      reLaunch: vi.fn(),
      requestPayment: vi.fn(),
      setStorage: vi.fn(),
      setStorageSync: vi.fn(),
      showModal: vi.fn(),
      showToast: vi.fn(),
    };
    const harness = createHarness({ wxApi });
    await harness.page.onLoad.call(harness.page, {
      room_type_id: IDS.room,
    });
    await harness.page.confirmBooking.call(harness.page);

    expect(harness.page.data).toMatchObject({
      status: "booking_created",
      booking: expect.objectContaining({
        status: "PENDING_PAYMENT",
        bookingNumber: booking.booking_number,
      }),
      quote: null,
      submitDisabled: true,
      submitPressed: false,
    });
    expect(wxApi.requestPayment).not.toHaveBeenCalled();
    expect(wxApi.navigateTo).not.toHaveBeenCalled();
    expect(wxApi.setStorage).not.toHaveBeenCalled();
    expect(wxApi.setStorageSync).not.toHaveBeenCalled();
  });

  it("opens the created order using only its strict in-memory booking id and shares one navigation lock", async () => {
    const redirectTo = vi.fn();
    const switchTab = vi.fn();
    const harness = createHarness({
      wxApi: {
        redirectTo,
        switchTab,
        showModal: vi.fn(),
        showToast: vi.fn(),
      },
    });
    await harness.page.onLoad.call(harness.page, {
      room_type_id: IDS.room,
    });
    await harness.page.confirmBooking.call(harness.page);

    harness.page.viewOrderDetail.call(harness.page, {
      currentTarget: {
        dataset: {
          id: "../order-list/order-list?admin=true",
        },
      },
    });
    harness.page.viewAllOrders.call(harness.page);

    expect(redirectTo).toHaveBeenCalledOnce();
    expect(redirectTo.mock.calls[0][0]).toMatchObject({
      url: `/pages/order-detail/order-detail?id=${IDS.booking}`,
    });
    expect(switchTab).not.toHaveBeenCalled();
  });

  it("keeps the original private booking id when the public booking view is mutated", async () => {
    const redirectTo = vi.fn();
    const harness = createHarness({
      wxApi: {
        redirectTo,
        switchTab: vi.fn(),
        showModal: vi.fn(),
        showToast: vi.fn(),
      },
    });
    await harness.page.onLoad.call(harness.page, {
      room_type_id: IDS.room,
    });
    await harness.page.confirmBooking.call(harness.page);
    harness.page.data.booking.bookingId =
      "40000000-0000-4000-8000-000000000002";

    harness.page.viewOrderDetail.call(harness.page);

    expect(redirectTo).toHaveBeenCalledOnce();
    expect(redirectTo.mock.calls[0][0]).toMatchObject({
      url: `/pages/order-detail/order-detail?id=${IDS.booking}`,
    });
  });

  it("opens the orders tab only from created state with a strict in-memory booking id", async () => {
    const switchTab = vi.fn();
    const harness = createHarness({
      wxApi: {
        redirectTo: vi.fn(),
        switchTab,
        showModal: vi.fn(),
        showToast: vi.fn(),
      },
    });
    await harness.page.onLoad.call(harness.page, {
      room_type_id: IDS.room,
    });
    await harness.page.confirmBooking.call(harness.page);

    harness.page.viewAllOrders.call(harness.page, {
      id: "/pages/private/private",
    });

    expect(switchTab).toHaveBeenCalledOnce();
    expect(switchTab.mock.calls[0][0]).toMatchObject({
      url: "/pages/order-list/order-list",
    });

    const invalidRedirectTo = vi.fn();
    const invalidSwitchTab = vi.fn();
    const invalidId = createHarness({
      wxApi: {
        redirectTo: invalidRedirectTo,
        switchTab: invalidSwitchTab,
        showModal: vi.fn(),
        showToast: vi.fn(),
      },
    });
    invalidId.page.data = {
      ...invalidId.page.data,
      status: "booking_created",
      booking: { bookingId: "../private" },
    };
    invalidId.page.viewAllOrders.call(invalidId.page);
    invalidId.page.viewOrderDetail.call(invalidId.page);

    const wrongStateRedirectTo = vi.fn();
    const wrongStateSwitchTab = vi.fn();
    const wrongState = createHarness({
      wxApi: {
        redirectTo: wrongStateRedirectTo,
        switchTab: wrongStateSwitchTab,
        showModal: vi.fn(),
        showToast: vi.fn(),
      },
    });
    wrongState.page.data = {
      ...wrongState.page.data,
      status: "quote_ready",
      booking: { bookingId: IDS.booking },
    };
    wrongState.page.viewAllOrders.call(wrongState.page);
    wrongState.page.viewOrderDetail.call(wrongState.page);

    expect(switchTab).toHaveBeenCalledOnce();
    expect(invalidRedirectTo).not.toHaveBeenCalled();
    expect(invalidSwitchTab).not.toHaveBeenCalled();
    expect(wrongStateRedirectTo).not.toHaveBeenCalled();
    expect(wrongStateSwitchTab).not.toHaveBeenCalled();
  });

  it("releases the shared order navigation lock after callback and promise failures", async () => {
    const redirectTo = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.reject(new Error("private redirect failure")),
      )
      .mockImplementationOnce(() => undefined);
    const switchTab = vi.fn(({ fail }) => fail());
    const harness = createHarness({
      wxApi: {
        redirectTo,
        switchTab,
        showModal: vi.fn(),
        showToast: vi.fn(),
      },
    });
    await harness.page.onLoad.call(harness.page, {
      room_type_id: IDS.room,
    });
    await harness.page.confirmBooking.call(harness.page);

    harness.page.viewOrderDetail.call(harness.page);
    await Promise.resolve();
    await Promise.resolve();
    harness.page.viewAllOrders.call(harness.page);
    harness.page.viewOrderDetail.call(harness.page);

    expect(redirectTo).toHaveBeenCalledTimes(2);
    expect(switchTab).toHaveBeenCalledOnce();
  });

  it("cancels timers and ignores late quote or booking responses across hide and unload", async () => {
    const lateQuote = deferred();
    const quoteHarness = createHarness({
      createQuote: vi.fn(() => lateQuote.promise),
    });
    const quoteLoad = quoteHarness.page.onLoad.call(quoteHarness.page, {
      room_type_id: IDS.room,
    });
    quoteHarness.page.onHide.call(quoteHarness.page);
    lateQuote.resolve(quote);
    await quoteLoad;
    expect(quoteHarness.page.data.status).toBe("loading_quote");
    expect(quoteHarness.timerApi.setInterval).not.toHaveBeenCalled();

    const lateBooking = deferred();
    const bookingHarness = createHarness({
      createBooking: vi.fn(() => lateBooking.promise),
    });
    await bookingHarness.page.onLoad.call(bookingHarness.page, {
      room_type_id: IDS.room,
    });
    const submit = bookingHarness.page.confirmBooking.call(
      bookingHarness.page,
    );
    bookingHarness.page.onUnload.call(bookingHarness.page);
    lateBooking.resolve(booking);
    await submit;
    expect(bookingHarness.page.data.status).toBe("submitting");
    expect(bookingHarness.idempotency.clear).not.toHaveBeenCalled();
  });

  it("recomputes on show and resumes cancelled loads or uncertain submissions", async () => {
    const first = deferred();
    const createQuote = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(quote);
    const harness = createHarness({ createQuote });
    const loading = harness.page.onLoad.call(harness.page, {
      room_type_id: IDS.room,
    });
    harness.page.onHide.call(harness.page);
    first.resolve(quote);
    await loading;
    await harness.page.onShow.call(harness.page);
    expect(createQuote).toHaveBeenCalledTimes(2);
    expect(harness.page.data.status).toBe("quote_ready");

    harness.setNow(NOW + 299500);
    harness.page.onHide.call(harness.page);
    harness.page.onShow.call(harness.page);
    expect(harness.timerApi.clearInterval).toHaveBeenCalled();
    expect(harness.page.data).toMatchObject({
      remainingSeconds: 1,
      submitDisabled: false,
    });

    harness.page.data.status = "submitting";
    harness.page.onHide.call(harness.page);
    harness.page.onShow.call(harness.page);
    expect(harness.page.data).toMatchObject({
      status: "booking_error",
      errorMessage: "订单结果待确认，请使用同一订单请求重试",
      submitDisabled: false,
    });
  });

  it("releases toast, modal, and navigation locks on callback or promise failure", async () => {
    const modalCalls = [];
    const navigation = deferred();
    const wxApi = {
      navigateBack: vi.fn(),
      reLaunch: vi.fn().mockReturnValueOnce(navigation.promise),
      showModal: vi.fn((options) => {
        modalCalls.push(options);
      }),
      showToast: vi
        .fn()
        .mockImplementationOnce(({ fail }) => fail())
        .mockImplementationOnce(({ complete }) => complete()),
    };
    const getKey = vi
      .fn()
      .mockRejectedValueOnce(new Error("random unavailable"))
      .mockRejectedValueOnce(new Error("random unavailable"));
    const invalid = createHarness({ wxApi });
    invalid.page.onLoad.call(invalid.page, { room_type_id: "bad" });
    modalCalls[0].fail();
    invalid.page.onLoad.call(invalid.page, { room_type_id: "bad" });
    expect(wxApi.showModal).toHaveBeenCalledTimes(2);

    invalid.page.returnHome.call(invalid.page);
    navigation.reject(new Error("private navigation"));
    await Promise.resolve();
    await Promise.resolve();
    invalid.page.returnHome.call(invalid.page);
    invalid.page.returnHome.call(invalid.page);
    expect(wxApi.reLaunch).toHaveBeenCalledTimes(2);

    const toastHarness = createHarness({ getKey, wxApi });
    await toastHarness.page.onLoad.call(toastHarness.page, {
      room_type_id: IDS.room,
    });
    await toastHarness.page.confirmBooking.call(toastHarness.page);
    await toastHarness.page.confirmBooking.call(toastHarness.page);
    expect(wxApi.showToast).toHaveBeenCalledTimes(2);
    expect(toastHarness.page.data.submitPressed).toBe(false);
  });

  it("keeps invalid link and search errors actionable after native navigation failures", async () => {
    const backCalls = [];
    const homeCalls = [];
    const wxApi = {
      navigateBack: vi.fn((options) => backCalls.push(options)),
      reLaunch: vi.fn((options) => homeCalls.push(options)),
      showModal: vi.fn(({ fail }) => fail()),
      showToast: vi.fn(),
    };
    const invalidLink = createHarness({ wxApi });
    invalidLink.page.onLoad.call(invalidLink.page, {
      room_type_id: "bad",
    });
    expect(backCalls).toHaveLength(1);
    invalidLink.page.returnBack.call(invalidLink.page);
    expect(backCalls).toHaveLength(1);
    backCalls[0].fail();
    expect(homeCalls).toHaveLength(1);
    homeCalls[0].fail();
    invalidLink.page.returnBack.call(invalidLink.page);
    expect(backCalls).toHaveLength(2);

    const invalidSearch = createHarness({
      searchValue: () => {
        throw new Error("private search failure");
      },
      wxApi,
    });
    await invalidSearch.page.onLoad.call(invalidSearch.page, {
      room_type_id: IDS.room,
    });
    invalidSearch.page.returnHome.call(invalidSearch.page);
    expect(homeCalls).toHaveLength(2);
  });
});

describe("booking confirmation native files", () => {
  it("declares approved components and every accessible visual state", async () => {
    const [jsonSource, logic, pageSource, wxml, wxss] = await Promise.all([
      readFile(
        new URL(
          "../pages/booking-confirm/booking-confirm.json",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../pages/booking-confirm/booking-confirm.logic.js",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../pages/booking-confirm/booking-confirm.js",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../pages/booking-confirm/booking-confirm.wxml",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../pages/booking-confirm/booking-confirm.wxss",
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
        price: "/components/price/price",
      },
    });
    for (const status of [
      "loading_quote",
      "quote_error",
      "quote_ready",
      "quote_changed",
      "submitting",
      "booking_error",
      "booking_created",
    ]) {
      expect(wxml).toContain(status);
    }
    expect(wxml).toContain('wx:for="{{quote.nightlyPrices}}"');
    expect(wxml).toContain("{{quote.totalPriceLabel}}");
    expect(wxml).toContain("{{quote.bookingPolicy}}");
    expect(wxml).toContain("{{quote.expiresAt}}");
    expect(wxml).toContain("{{booking.expiresAt}}");
    expect(wxml).toContain('disabled="{{submitDisabled}}"');
    expect(wxml).toContain('aria-disabled="{{submitDisabled}}"');
    expect(wxml).toContain('aria-pressed="{{submitPressed}}"');
    expect(wxml).toContain('loading="{{status === \'submitting\'}}"');
    expect(wxml).not.toContain("支付与订单详情将在下一开发切片开放");
    expect(wxml).not.toContain(
      '<button class="secondary-button created-card__action" bindtap="returnHome">',
    );
    expect(wxml).toContain('bindtap="viewOrderDetail"');
    expect(wxml).toContain('aria-label="查看当前订单详情"');
    expect(wxml).toContain("查看订单");
    expect(wxml).toContain('bindtap="viewAllOrders"');
    expect(wxml).toContain('aria-label="查看全部订单"');
    expect(wxml).toContain("查看全部订单");
    expect(wxml).toContain(
      "errorCode === 'INVALID_ROOM_LINK'",
    );
    expect(wxml).toContain('bind:retry="returnBack"');
    expect(wxml).toContain(
      "errorCode === 'INVALID_SEARCH_CONTEXT'",
    );
    expect(wxml).toContain('bind:retry="returnHome"');
    expect(wxss).toContain("env(safe-area-inset-bottom)");
    expect(wxss).toContain("var(--color-brand)");
    expect(wxss).toContain("var(--radius-medium)");
    expect(wxss).toContain("min-height: 88rpx");
    for (const source of [logic, pageSource, wxml, wxss]) {
      expect(source).not.toMatch(/linear-gradient|radial-gradient/);
      expect(source).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    }
    expect(pageSource).not.toMatch(/setStorage/);
    expect(pageSource).not.toMatch(/requestPayment/);
  });
});

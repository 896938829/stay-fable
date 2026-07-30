import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import orderListLogic from "../pages/order-list/order-list.logic.js";
import orderListPage from "../pages/order-list/order-list.js";

const {
  mergeOrderPage,
  safeOrderListError,
  toOrderListItemView,
} = orderListLogic;
const { createOrderListPage } = orderListPage;

const BOOKING_A = "40000000-0000-4000-8000-000000000001";
const BOOKING_B = "40000000-0000-4000-8000-000000000002";
const NOW = Date.parse("2026-07-30T02:00:00.000Z");

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function booking(
  bookingId,
  {
    deadlinePassed = false,
    expiresAt = "2026-07-30T02:15:00.000Z",
    status = "PENDING_PAYMENT",
  } = {},
) {
  return {
    booking_id: bookingId,
    booking_number: `SF20260730${bookingId.slice(-12)}`,
    status,
    property_name: "西湖云栖酒店",
    room_type_name: "湖景大床房",
    checkin: "2026-08-01",
    checkout: "2026-08-03",
    nights: 2,
    guests: 2,
    total_price_cents: 117600,
    currency: "CNY",
    expires_at: expiresAt,
    payment_deadline_passed: deadlinePassed,
    created_at: "2026-07-30T01:59:00.000Z",
    updated_at: "2026-07-30T01:59:00.000Z",
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

function createPage({ listBookings, wxApi } = {}) {
  const ordersService = {
    listBookings:
      listBookings ||
      vi.fn(async () => ({
        items: [],
        next_cursor: null,
      })),
  };
  const safeWxApi = wxApi || {
    navigateTo: vi.fn(),
    stopPullDownRefresh: vi.fn(),
  };
  return {
    ordersService,
    page: pageContext(
      createOrderListPage({
        clock: () => NOW,
        ordersService,
        wxApi: safeWxApi,
      }),
    ),
    wxApi: safeWxApi,
  };
}

describe("order list pure logic", () => {
  it.each([
    ["PENDING_PAYMENT", "待支付"],
    ["PAID", "已支付"],
    ["CONFIRMED", "已确认"],
    ["CANCELLED", "已取消"],
    ["CLOSED", "已关闭"],
  ])("formats %s without changing the server status", (status, statusLabel) => {
    const raw = booking(BOOKING_A, { status });
    const view = toOrderListItemView(raw, NOW);

    expect(view).toMatchObject({
      bookingId: BOOKING_A,
      bookingNumber: raw.booking_number,
      status,
      statusLabel,
      propertyName: "西湖云栖酒店",
      roomTypeName: "湖景大床房",
      dateLabel: "2026年8月1日 至 2026年8月3日",
      stayLabel: "2晚 · 2人",
      totalPriceLabel: "¥1176.00",
      actionLabel: "查看订单",
    });
    expect(raw.status).toBe(status);
    expect(view).not.toHaveProperty("allowedActions");
    expect(view).not.toHaveProperty("allowed_actions");
  });

  it("formats remaining payment seconds and trusts the server deadline-passed flag", () => {
    expect(toOrderListItemView(booking(BOOKING_A), NOW)).toMatchObject({
      paymentRemainingSeconds: 900,
      paymentHint: "剩余 900 秒",
      paymentDeadlinePassed: false,
    });
    expect(
      toOrderListItemView(
        booking(BOOKING_A, {
          deadlinePassed: true,
          expiresAt: "2026-07-30T03:00:00.000Z",
          status: "CLOSED",
        }),
        NOW,
      ),
    ).toMatchObject({
      paymentRemainingSeconds: 0,
      paymentHint: "付款时间已截止",
      paymentDeadlinePassed: true,
      status: "CLOSED",
    });
  });

  it("merges pages by validated booking ID and does not mutate either page", () => {
    const existing = [
      { bookingId: BOOKING_A, propertyName: "旧名称" },
      { bookingId: BOOKING_B, propertyName: "第二家" },
    ];
    const incoming = [
      { bookingId: BOOKING_A, propertyName: "新名称" },
      { bookingId: "not-a-booking-id", propertyName: "不可信" },
    ];
    expect(mergeOrderPage(existing, incoming)).toEqual([
      { bookingId: BOOKING_A, propertyName: "新名称" },
      { bookingId: BOOKING_B, propertyName: "第二家" },
    ]);
    expect(existing[0].propertyName).toBe("旧名称");
  });

  it("uses only safe list errors and never exposes dependency messages", () => {
    expect(safeOrderListError({ code: "ORDER_CURSOR_INVALID" })).toBe(
      "订单列表已更新，请重新加载",
    );
    expect(safeOrderListError({ code: "NETWORK_REQUEST_FAILED" })).toBe(
      "网络连接不稳定，请重试",
    );
    expect(
      safeOrderListError({
        code: "DATABASE_FAILURE",
        message: "password=secret",
      }),
    ).toBe("订单服务暂时不可用，请重试");
  });
});

describe("order list page state machine", () => {
  it("loads the first page into list state and forwards the opaque cursor", async () => {
    const listBookings = vi.fn(async () => ({
      items: [booking(BOOKING_A)],
      next_cursor: "cursor_page_2",
    }));
    const { page } = createPage({ listBookings });

    await page.onLoad.call(page);

    expect(listBookings).toHaveBeenCalledWith(
      { limit: 10 },
      { retry: true, isActive: expect.any(Function) },
    );
    expect(page.data).toMatchObject({
      status: "list",
      items: [
        expect.objectContaining({
          bookingId: BOOKING_A,
          statusLabel: "待支付",
          actionLabel: "查看订单",
        }),
      ],
      nextCursor: "cursor_page_2",
      footerStatus: "idle",
      errorMessage: "",
    });
  });

  it("renders empty, first-page error, and a safe first-page retry", async () => {
    const listBookings = vi
      .fn()
      .mockResolvedValueOnce({ items: [], next_cursor: null })
      .mockRejectedValueOnce({
        code: "NETWORK_REQUEST_FAILED",
        message: "private response",
      })
      .mockResolvedValueOnce({
        items: [booking(BOOKING_A)],
        next_cursor: null,
      });
    const { page } = createPage({ listBookings });

    await page.onLoad.call(page);
    expect(page.data).toMatchObject({
      status: "empty",
      footerStatus: "done",
    });

    await page.onPullDownRefresh.call(page);
    expect(page.data).toMatchObject({
      status: "error",
      items: [],
      footerStatus: "idle",
      errorMessage: "网络连接不稳定，请重试",
    });

    await page.retry.call(page);
    expect(page.data).toMatchObject({
      status: "list",
      footerStatus: "done",
      errorMessage: "",
    });
  });

  it("retains rows on footer error, retries the same cursor, and reaches done", async () => {
    const listBookings = vi
      .fn()
      .mockResolvedValueOnce({
        items: [booking(BOOKING_A)],
        next_cursor: "cursor_page_2",
      })
      .mockRejectedValueOnce({ code: "ORDER_CURSOR_INVALID" })
      .mockResolvedValueOnce({
        items: [booking(BOOKING_B, { status: "CONFIRMED" })],
        next_cursor: null,
      });
    const { page } = createPage({ listBookings });
    await page.onLoad.call(page);

    await page.onReachBottom.call(page);
    expect(page.data).toMatchObject({
      status: "list",
      nextCursor: "cursor_page_2",
      footerStatus: "error",
      errorMessage: "订单列表已更新，请重新加载",
    });

    await page.retryFooter.call(page);
    expect(listBookings.mock.calls[2][0]).toEqual({
      limit: 10,
      cursor: "cursor_page_2",
    });
    expect(page.data.items.map(({ bookingId }) => bookingId)).toEqual([
      BOOKING_A,
      BOOKING_B,
    ]);
    expect(page.data.footerStatus).toBe("done");
    await page.onReachBottom.call(page);
    expect(listBookings).toHaveBeenCalledTimes(3);
  });

  it("rejects repeated, malformed, and already-completed next cursors", async () => {
    const listBookings = vi
      .fn()
      .mockResolvedValueOnce({
        items: [booking(BOOKING_A)],
        next_cursor: "cursor_repeat",
      })
      .mockResolvedValueOnce({
        items: [booking(BOOKING_B)],
        next_cursor: "cursor_repeat",
      });
    const { page } = createPage({ listBookings });
    await page.onLoad.call(page);
    await page.onReachBottom.call(page);
    expect(page.data.footerStatus).toBe("done");

    for (const nextCursor of ["../private", "x".repeat(513)]) {
      listBookings.mockResolvedValueOnce({
        items: [booking(BOOKING_A)],
        next_cursor: nextCursor,
      });
      await page.onPullDownRefresh.call(page);
      expect(page.data.footerStatus).toBe("done");
    }
  });

  it("stops pull-down refresh after success and failure", async () => {
    const wxApi = {
      navigateTo: vi.fn(),
      stopPullDownRefresh: vi.fn(),
    };
    const listBookings = vi
      .fn()
      .mockResolvedValueOnce({ items: [], next_cursor: null })
      .mockResolvedValueOnce({
        items: [booking(BOOKING_A)],
        next_cursor: null,
      })
      .mockRejectedValueOnce({ code: "NETWORK_REQUEST_FAILED" });
    const { page } = createPage({ listBookings, wxApi });
    await page.onLoad.call(page);

    await page.onPullDownRefresh.call(page);
    await page.onPullDownRefresh.call(page);

    expect(wxApi.stopPullDownRefresh).toHaveBeenCalledTimes(2);
  });

  it("refreshes once after returning from detail and waits for pagination to settle", async () => {
    const pagination = deferred();
    const refresh = deferred();
    const listBookings = vi
      .fn()
      .mockResolvedValueOnce({
        items: [booking(BOOKING_A)],
        next_cursor: "cursor_page_2",
      })
      .mockReturnValueOnce(pagination.promise)
      .mockReturnValueOnce(refresh.promise);
    const { page } = createPage({ listBookings });
    await page.onLoad.call(page);
    const loadingMore = page.onReachBottom.call(page);

    page.onHide.call(page);
    page.onShow.call(page);
    page.onShow.call(page);
    expect(listBookings).toHaveBeenCalledTimes(2);

    pagination.resolve({
      items: [booking(BOOKING_B)],
      next_cursor: null,
    });
    await loadingMore;
    expect(listBookings).toHaveBeenCalledTimes(3);

    refresh.resolve({
      items: [booking(BOOKING_B, { status: "CONFIRMED" })],
      next_cursor: null,
    });
    await Promise.resolve();
    expect(page.data.items).toEqual([
      expect.objectContaining({
        bookingId: BOOKING_B,
        statusLabel: "已确认",
      }),
    ]);
  });

  it("replaces a queued show refresh after another hide and show", async () => {
    const pagination = deferred();
    const listBookings = vi
      .fn()
      .mockResolvedValueOnce({
        items: [booking(BOOKING_A)],
        next_cursor: "cursor_page_2",
      })
      .mockReturnValueOnce(pagination.promise)
      .mockResolvedValueOnce({
        items: [booking(BOOKING_B, { status: "CONFIRMED" })],
        next_cursor: null,
      });
    const { page } = createPage({ listBookings });
    await page.onLoad.call(page);
    const loadingMore = page.onReachBottom.call(page);

    page.onHide.call(page);
    page.onShow.call(page);
    page.onHide.call(page);
    page.onShow.call(page);
    pagination.resolve({ items: [], next_cursor: null });
    await loadingMore;
    await Promise.resolve();

    expect(listBookings).toHaveBeenCalledTimes(3);
    expect(page.data.items).toEqual([
      expect.objectContaining({
        bookingId: BOOKING_B,
        statusLabel: "已确认",
      }),
    ]);
  });

  it("suppresses late generations and late hide/unload responses", async () => {
    const first = deferred();
    const replacement = deferred();
    const listBookings = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(replacement.promise);
    const { page } = createPage({ listBookings });
    const initial = page.onLoad.call(page);
    const refresh = page.onPullDownRefresh.call(page);
    first.resolve({
      items: [booking(BOOKING_A)],
      next_cursor: null,
    });
    await initial;
    replacement.resolve({
      items: [booking(BOOKING_B)],
      next_cursor: null,
    });
    await refresh;
    expect(page.data.items.map(({ bookingId }) => bookingId)).toEqual([
      BOOKING_B,
    ]);

    for (const lifecycle of ["onHide", "onUnload"]) {
      const pending = deferred();
      const isolated = createPage({
        listBookings: vi.fn(() => pending.promise),
      }).page;
      const loading = isolated.onLoad.call(isolated);
      isolated.setData.mockClear();
      isolated[lifecycle].call(isolated);
      pending.resolve({
        items: [booking(BOOKING_A)],
        next_cursor: null,
      });
      await loading;
      expect(isolated.setData).not.toHaveBeenCalled();
    }
  });

  it("navigates once from a plain button ID and unlocks only after navigation failure", async () => {
    const failed = deferred();
    const wxApi = {
      navigateTo: vi.fn(() => failed.promise),
      stopPullDownRefresh: vi.fn(),
    };
    const { page } = createPage({ wxApi });
    const validEvent = {
      currentTarget: { dataset: { bookingId: BOOKING_A } },
    };

    page.openOrder.call(page, validEvent);
    page.openOrder.call(page, validEvent);
    page.openOrder.call(page, {
      currentTarget: { dataset: { bookingId: "../private?id=secret" } },
    });
    page.openOrder.call(page, {
      currentTarget: { dataset: Object.create({ bookingId: BOOKING_B }) },
    });
    expect(wxApi.navigateTo).toHaveBeenCalledOnce();
    expect(wxApi.navigateTo.mock.calls[0][0]).toMatchObject({
      url: `/pages/order-detail/order-detail?id=${encodeURIComponent(BOOKING_A)}`,
    });

    failed.reject(new Error("navigation failed"));
    await failed.promise.catch(() => {});
    page.openOrder.call(page, validEvent);
    expect(wxApi.navigateTo).toHaveBeenCalledTimes(2);
  });
});

describe("order list native files", () => {
  it("uses approved state components and plain order buttons without a shadow card", async () => {
    const [jsonSource, wxml, wxss] = await Promise.all([
      readFile(
        new URL("../pages/order-list/order-list.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../pages/order-list/order-list.wxml", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../pages/order-list/order-list.wxss", import.meta.url),
        "utf8",
      ),
    ]);

    expect(JSON.parse(jsonSource)).toEqual({
      navigationStyle: "custom",
      enablePullDownRefresh: true,
      backgroundTextStyle: "dark",
      usingComponents: {
        "navigation-bar": "/components/navigation-bar/navigation-bar",
        "loading-state": "/components/loading-state/loading-state",
        "error-state": "/components/error-state/error-state",
        "empty-state": "/components/empty-state/empty-state",
      },
    });
    expect(wxml).toContain('wx:if="{{status === \'loading\'}}"');
    expect(wxml).toContain('wx:elif="{{status === \'empty\'}}"');
    expect(wxml).toContain('wx:elif="{{status === \'error\'}}"');
    expect(wxml).toContain('wx:elif="{{status === \'list\'}}"');
    expect(wxml).toContain('wx:for="{{items}}"');
    expect(wxml).toContain('class="order-row__action"');
    expect(wxml).toContain('data-booking-id="{{item.bookingId}}"');
    expect(wxml).toContain('bindtap="openOrder"');
    expect(wxml).not.toMatch(/order-card|shadow/);
    expect(wxml).not.toContain("rich-text");
    expect(wxss).toContain("min-height: 88rpx");
    expect(wxss).toContain("env(safe-area-inset-bottom)");
    expect(wxss).toContain("var(--color-brand)");
    expect(wxss).toContain("var(--radius-medium)");
  });
});

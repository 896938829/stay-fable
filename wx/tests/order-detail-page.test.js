import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import orderDetailLogic from "../pages/order-detail/order-detail.logic.js";
import orderDetailPage from "../pages/order-detail/order-detail.js";

const {
  safeOrderDetailError,
  toOrderDetailView,
} = orderDetailLogic;
const { createOrderDetailPage } = orderDetailPage;

const BOOKING_ID = "40000000-0000-4000-8000-000000000001";
const PAYMENT_KEY = "payment-key-1234567890_ABCDEFGHIJ";
const PAYMENT_SCOPE_SUCCESS = `payment:${BOOKING_ID}:SUCCEED`;
const PAYMENT_SCOPE_FAILURE = `payment:${BOOKING_ID}:FAIL`;

function bookingDetail({
  actions = ["CANCEL", "MOCK_PAY_SUCCESS", "MOCK_PAY_FAILURE"],
  history,
  latestPayment = null,
  status = "PENDING_PAYMENT",
} = {}) {
  return {
    booking_id: BOOKING_ID,
    booking_number: "SF20260730A1B2C3D4E5F6",
    status,
    property_name: "西湖云栖酒店",
    room_type_name: "湖景大床房",
    checkin: "2026-08-01",
    checkout: "2026-08-03",
    nights: 2,
    guests: 2,
    total_price_cents: 121600,
    currency: "CNY",
    expires_at: "2026-07-30T02:15:00.000Z",
    payment_deadline_passed: false,
    created_at: "2026-07-30T02:00:00.000Z",
    updated_at: "2026-07-30T02:01:00.000Z",
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
    booking_policy: "入住前一天 18:00 前可免费取消",
    latest_payment: latestPayment,
    status_history:
      history ||
      [
        {
          from_status: null,
          to_status: "PENDING_PAYMENT",
          reason: "BOOKING_CREATED",
          actor_type: "USER",
          created_at: "2026-07-30T02:00:00.000Z",
        },
      ],
    allowed_actions: actions,
  };
}

function terminalBooking(status) {
  const reasons = {
    CANCELLED: "USER_CANCELLED",
    CLOSED: "PAYMENT_TIMEOUT",
    CONFIRMED: "PAYMENT_CONFIRMED",
    PAID: "MOCK_PAYMENT_SUCCEEDED",
  };
  const transitions = [
    {
      from_status: null,
      to_status: "PENDING_PAYMENT",
      reason: "BOOKING_CREATED",
      actor_type: "USER",
      created_at: "2026-07-30T02:00:00.000Z",
    },
  ];
  if (status === "CONFIRMED") {
    transitions.push(
      {
        from_status: "PENDING_PAYMENT",
        to_status: "PAID",
        reason: "MOCK_PAYMENT_SUCCEEDED",
        actor_type: "USER",
        created_at: "2026-07-30T02:02:00.000Z",
      },
      {
        from_status: "PAID",
        to_status: "CONFIRMED",
        reason: "PAYMENT_CONFIRMED",
        actor_type: "SYSTEM",
        created_at: "2026-07-30T02:02:01.000Z",
      },
    );
  } else if (status !== "PENDING_PAYMENT") {
    transitions.push({
      from_status: "PENDING_PAYMENT",
      to_status: status,
      reason: reasons[status],
      actor_type: status === "CLOSED" ? "SYSTEM" : "USER",
      created_at: "2026-07-30T02:02:00.000Z",
    });
  }
  return bookingDetail({
    actions: [],
    history: transitions,
    latestPayment:
      status === "CONFIRMED"
        ? {
            payment_number: "SFP20260730A1B2C3D4E5F6",
            status: "SUCCEEDED",
            processed_at: "2026-07-30T02:02:00.000Z",
          }
        : null,
    status,
  });
}

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
  cancelBooking = vi.fn(async () => terminalBooking("CANCELLED")),
  getBooking = vi.fn(async () => bookingDetail()),
  getKey = vi.fn(async () => PAYMENT_KEY),
  simulatePayment = vi.fn(async () => terminalBooking("CONFIRMED")),
  wxApi,
} = {}) {
  const ordersService = {
    cancelBooking,
    getBooking,
    simulatePayment,
  };
  const idempotency = {
    clear: vi.fn(),
    get: getKey,
  };
  const safeWxApi =
    wxApi ||
    {
      navigateBack: vi.fn(({ success } = {}) => success?.()),
      showModal: vi.fn(({ success } = {}) =>
        success?.({ cancel: false, confirm: true }),
      ),
    };
  return {
    idempotency,
    ordersService,
    page: pageContext(
      createOrderDetailPage({
        idempotency,
        ordersService,
        wxApi: safeWxApi,
      }),
    ),
    wxApi: safeWxApi,
  };
}

describe("order detail pure view logic", () => {
  it.each([
    ["PENDING_PAYMENT", "待支付"],
    ["PAID", "支付处理中"],
    ["CONFIRMED", "已确认"],
    ["CANCELLED", "已取消"],
    ["CLOSED", "已关闭"],
  ])("maps %s to the fixed Chinese status label", (status, label) => {
    const view = toOrderDetailView(
      status === "PENDING_PAYMENT"
        ? bookingDetail()
        : terminalBooking(status),
    );
    expect(view.status).toBe(status);
    expect(view.statusLabel).toBe(label);
  });

  it("formats only server nightly and total amounts and derives buttons only from allowed actions", () => {
    const view = toOrderDetailView(bookingDetail());

    expect(view.totalPriceCents).toBe(121600);
    expect(view.totalPriceLabel).toBe("¥1216.00");
    expect(view.nightlyPrices).toEqual([
      {
        businessDate: "2026-08-01",
        salePriceCents: 58800,
        salePriceLabel: "¥588.00",
        rackPriceCents: 68800,
        rackPriceLabel: "¥688.00",
        currency: "CNY",
      },
      {
        businessDate: "2026-08-02",
        salePriceCents: 62800,
        salePriceLabel: "¥628.00",
        rackPriceCents: 72800,
        rackPriceLabel: "¥728.00",
        currency: "CNY",
      },
    ]);
    expect(view.actions).toEqual([
      { code: "CANCEL", label: "取消订单" },
      { code: "MOCK_PAY_SUCCESS", label: "模拟支付成功（开发）" },
      { code: "MOCK_PAY_FAILURE", label: "模拟支付失败（开发）" },
    ]);
  });

  it("uses a fixed history-reason whitelist and never renders unknown server text", () => {
    const raw = bookingDetail({
      history: [
        {
          from_status: null,
          to_status: "PENDING_PAYMENT",
          reason: "BOOKING_CREATED",
          actor_type: "USER",
          created_at: "2026-07-30T02:00:00.000Z",
        },
        {
          from_status: "PENDING_PAYMENT",
          to_status: "CLOSED",
          reason: "private server narrative with token=secret",
          actor_type: "SYSTEM",
          created_at: "2026-07-30T02:01:00.000Z",
        },
      ],
      status: "CLOSED",
      actions: [],
    });
    const view = toOrderDetailView(raw);

    expect(view.statusHistory[0].reasonLabel).toBe("订单已创建");
    expect(view.statusHistory[1].reasonLabel).toBe("");
    expect(JSON.stringify(view)).not.toContain("private server narrative");
    expect(JSON.stringify(view)).not.toContain("token=secret");
  });

  it("gives status-history rows unique render keys when timestamps match", () => {
    const timestamp = "2026-07-30T02:00:00.000Z";
    const view = toOrderDetailView(
      bookingDetail({
        actions: [],
        history: [
          {
            from_status: null,
            to_status: "PENDING_PAYMENT",
            reason: "BOOKING_CREATED",
            actor_type: "USER",
            created_at: timestamp,
          },
          {
            from_status: "PENDING_PAYMENT",
            to_status: "CLOSED",
            reason: "PAYMENT_TIMEOUT",
            actor_type: "SYSTEM",
            created_at: timestamp,
          },
        ],
        status: "CLOSED",
      }),
    );

    expect(view.statusHistory.map((item) => item.historyKey)).toEqual([
      `0:${timestamp}`,
      `1:${timestamp}`,
    ]);
  });

  it("does not reveal unknown dependency error messages", () => {
    const error = new Error("private upstream detail");
    error.code = "UNKNOWN_PRIVATE_CODE";
    expect(safeOrderDetailError(error)).toBe("订单服务暂时不可用，请重试");
    expect(safeOrderDetailError({ code: "NETWORK_REQUEST_FAILED" })).toBe(
      "网络连接不稳定，请重试",
    );
  });
});

describe("order detail page state machine", () => {
  it("loads one valid booking detail and rejects malformed links before GET", async () => {
    const valid = createHarness();
    await valid.page.onLoad.call(valid.page, { id: BOOKING_ID });
    expect(valid.ordersService.getBooking).toHaveBeenCalledWith(
      BOOKING_ID,
      expect.objectContaining({ retry: true }),
    );
    expect(valid.page.data).toMatchObject({
      status: "ready",
      errorMessage: "",
    });
    expect(valid.page.data.booking.bookingId).toBe(BOOKING_ID);

    const platform = createHarness();
    const platformOptions = Object.assign(
      Object.create({ platform: true }),
      { id: BOOKING_ID },
    );
    await platform.page.onLoad.call(platform.page, platformOptions);
    expect(platform.ordersService.getBooking).toHaveBeenCalledWith(
      BOOKING_ID,
      expect.objectContaining({ retry: true }),
    );
    expect(platform.page.data.status).toBe("ready");

    for (const options of [
      undefined,
      {},
      { id: "bad" },
      { id: "../../private?token=secret" },
      { id: BOOKING_ID, extra: true },
      Object.create({ id: BOOKING_ID }),
    ]) {
      const invalid = createHarness();
      await invalid.page.onLoad.call(invalid.page, options);
      expect(invalid.ordersService.getBooking).not.toHaveBeenCalled();
      expect(invalid.page.data).toMatchObject({
        status: "error",
        errorCode: "INVALID_BOOKING_LINK",
        errorMessage: "订单链接无效，请返回订单列表",
      });
      expect(invalid.wxApi.showModal).toHaveBeenCalledOnce();
      expect(invalid.wxApi.navigateBack).toHaveBeenCalledOnce();
    }
  });

  it("keeps an invalid link actionable after native back navigation fails and hide/show", async () => {
    const wxApi = {
      navigateBack: vi
        .fn()
        .mockImplementationOnce(({ fail }) => fail())
        .mockImplementationOnce(({ success }) => success()),
      showModal: vi.fn(({ success }) => success({ confirm: true })),
    };
    const harness = createHarness({ wxApi });

    await harness.page.onLoad.call(harness.page, { id: "bad" });
    expect(wxApi.navigateBack).toHaveBeenCalledOnce();

    harness.page.onHide.call(harness.page);
    await harness.page.onShow.call(harness.page);
    await harness.page.returnBack.call(harness.page);
    expect(wxApi.navigateBack).toHaveBeenCalledTimes(2);
  });

  it("locks a double-clicked successful payment to one POST and clears its exact scope", async () => {
    const payment = deferred();
    const harness = createHarness({
      simulatePayment: vi.fn(() => payment.promise),
    });
    await harness.page.onLoad.call(harness.page, { id: BOOKING_ID });

    const first = harness.page.simulateSuccess.call(harness.page);
    const second = harness.page.simulateSuccess.call(harness.page);
    await Promise.resolve();

    expect(harness.ordersService.simulatePayment).toHaveBeenCalledTimes(1);
    expect(harness.ordersService.simulatePayment).toHaveBeenCalledWith(
      BOOKING_ID,
      { outcome: "SUCCEED" },
      PAYMENT_KEY,
      expect.objectContaining({ isActive: expect.any(Function) }),
    );
    expect(harness.page.data.status).toBe("action_pending");

    payment.resolve(terminalBooking("CONFIRMED"));
    await Promise.all([first, second]);
    expect(harness.page.data.booking.status).toBe("CONFIRMED");
    expect(harness.page.data.booking.actions).toEqual([]);
    expect(harness.idempotency.clear).toHaveBeenCalledWith(
      PAYMENT_SCOPE_SUCCESS,
    );
  });

  it("records an explicit FAIL, clears its key, and safely refreshes the pending detail", async () => {
    const failedDetail = bookingDetail({
      latestPayment: {
        payment_number: "SFP20260730A1B2C3D4E5F6",
        status: "FAILED",
        processed_at: "2026-07-30T02:02:00.000Z",
      },
    });
    const getBooking = vi
      .fn()
      .mockResolvedValueOnce(bookingDetail())
      .mockResolvedValueOnce(failedDetail);
    const simulatePayment = vi.fn(async () => {
      throw { code: "MOCK_PAYMENT_FAILED" };
    });
    const harness = createHarness({ getBooking, simulatePayment });
    await harness.page.onLoad.call(harness.page, { id: BOOKING_ID });

    await harness.page.simulateFailure.call(harness.page);

    expect(simulatePayment).toHaveBeenCalledOnce();
    expect(getBooking).toHaveBeenCalledTimes(2);
    expect(harness.idempotency.clear).toHaveBeenCalledWith(
      PAYMENT_SCOPE_FAILURE,
    );
    expect(harness.page.data).toMatchObject({
      status: "ready",
      actionMessage: "模拟支付失败，订单仍待支付",
    });
    expect(harness.page.data.booking.latestPayment.status).toBe("FAILED");
  });

  it("honors cancel and confirm modal branches without duplicate writes", async () => {
    const cancelledModal = {
      navigateBack: vi.fn(),
      showModal: vi.fn(({ success }) =>
        success({ cancel: true, confirm: false }),
      ),
    };
    const declined = createHarness({ wxApi: cancelledModal });
    await declined.page.onLoad.call(declined.page, { id: BOOKING_ID });
    await declined.page.cancelBooking.call(declined.page);
    expect(declined.ordersService.cancelBooking).not.toHaveBeenCalled();
    expect(declined.page.data.status).toBe("ready");

    const operation = deferred();
    const confirmed = createHarness({
      cancelBooking: vi.fn(() => operation.promise),
    });
    await confirmed.page.onLoad.call(confirmed.page, { id: BOOKING_ID });
    const first = confirmed.page.cancelBooking.call(confirmed.page);
    const second = confirmed.page.cancelBooking.call(confirmed.page);
    expect(confirmed.wxApi.showModal).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(confirmed.ordersService.cancelBooking).toHaveBeenCalledOnce();
    });

    operation.resolve(terminalBooking("CANCELLED"));
    await Promise.all([first, second]);
    expect(confirmed.page.data.booking.status).toBe("CANCELLED");
    expect(confirmed.page.data.booking.actions).toEqual([]);
    expect(confirmed.idempotency.clear).toHaveBeenCalledWith(
      PAYMENT_SCOPE_SUCCESS,
    );
    expect(confirmed.idempotency.clear).toHaveBeenCalledWith(
      PAYMENT_SCOPE_FAILURE,
    );
  });

  it("releases the write lock when a modal result getter throws", async () => {
    const wxApi = {
      navigateBack: vi.fn(),
      showModal: vi.fn(({ success }) => {
        const result = {};
        Object.defineProperty(result, "confirm", {
          get() {
            throw new Error("malicious modal result");
          },
        });
        Promise.resolve()
          .then(() => success(result))
          .catch(() => {});
      }),
    };
    const harness = createHarness({ wxApi });
    await harness.page.onLoad.call(harness.page, { id: BOOKING_ID });

    const outcome = await Promise.race([
      harness.page.cancelBooking.call(harness.page).then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 25)),
    ]);
    expect(outcome).toBe("settled");

    await harness.page.simulateSuccess.call(harness.page);
    expect(harness.ordersService.simulatePayment).toHaveBeenCalledOnce();
  });

  it("reconciles an unknown cancel exactly once with GET and preserves a foreign terminal result", async () => {
    const getBooking = vi
      .fn()
      .mockResolvedValueOnce(bookingDetail())
      .mockResolvedValueOnce(terminalBooking("CANCELLED"));
    const cancelBooking = vi.fn(async () => {
      throw { code: "NETWORK_REQUEST_FAILED" };
    });
    const harness = createHarness({ cancelBooking, getBooking });
    await harness.page.onLoad.call(harness.page, { id: BOOKING_ID });

    await harness.page.cancelBooking.call(harness.page);

    expect(cancelBooking).toHaveBeenCalledOnce();
    expect(getBooking).toHaveBeenCalledTimes(2);
    expect(harness.page.data.status).toBe("ready");
    expect(harness.page.data.booking.status).toBe("CANCELLED");
    expect(harness.page.data.booking.actions).toEqual([]);
  });

  it("does not reconcile an explicit cancel rejection with an extra GET", async () => {
    const getBooking = vi.fn(async () => bookingDetail());
    const cancelBooking = vi.fn(async () => {
      throw { code: "BOOKING_NOT_CANCELLABLE" };
    });
    const harness = createHarness({ cancelBooking, getBooking });
    await harness.page.onLoad.call(harness.page, { id: BOOKING_ID });

    await harness.page.cancelBooking.call(harness.page);

    expect(cancelBooking).toHaveBeenCalledOnce();
    expect(getBooking).toHaveBeenCalledOnce();
    expect(harness.page.data).toMatchObject({
      status: "ready",
      actionMessage: "当前订单不可取消",
    });
  });

  it("allows only cancel retry while an unknown cancellation remains unresolved", async () => {
    const getBooking = vi
      .fn()
      .mockResolvedValueOnce(bookingDetail())
      .mockResolvedValueOnce(bookingDetail());
    const cancelBooking = vi
      .fn()
      .mockRejectedValueOnce({ code: "NETWORK_REQUEST_FAILED" })
      .mockResolvedValueOnce(terminalBooking("CANCELLED"));
    const harness = createHarness({ cancelBooking, getBooking });
    await harness.page.onLoad.call(harness.page, { id: BOOKING_ID });

    await harness.page.cancelBooking.call(harness.page);
    expect(harness.page.data).toMatchObject({
      status: "action_uncertain",
      uncertainAction: "CANCEL",
    });

    await harness.page.simulateSuccess.call(harness.page);
    await harness.page.simulateFailure.call(harness.page);
    expect(harness.ordersService.simulatePayment).not.toHaveBeenCalled();

    await harness.page.cancelBooking.call(harness.page);
    expect(cancelBooking).toHaveBeenCalledTimes(2);
    expect(harness.page.data.booking.status).toBe("CANCELLED");
  });

  it("keeps one payment key after an unknown result and only retries POST on an explicit tap", async () => {
    const simulatePayment = vi
      .fn()
      .mockRejectedValueOnce({ code: "NETWORK_REQUEST_FAILED" })
      .mockResolvedValueOnce(terminalBooking("CONFIRMED"));
    const harness = createHarness({ simulatePayment });
    await harness.page.onLoad.call(harness.page, { id: BOOKING_ID });

    await harness.page.simulateSuccess.call(harness.page);
    expect(simulatePayment).toHaveBeenCalledOnce();
    expect(harness.page.data).toMatchObject({
      status: "action_uncertain",
      actionMessage: "支付结果待确认，请使用同一支付请求重试",
    });
    expect(harness.idempotency.clear).not.toHaveBeenCalledWith(
      PAYMENT_SCOPE_SUCCESS,
    );

    await harness.page.simulateFailure.call(harness.page);
    await harness.page.cancelBooking.call(harness.page);
    expect(simulatePayment).toHaveBeenCalledOnce();
    expect(harness.ordersService.cancelBooking).not.toHaveBeenCalled();
    expect(harness.wxApi.showModal).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(simulatePayment).toHaveBeenCalledOnce();
    await harness.page.simulateSuccess.call(harness.page);

    expect(simulatePayment).toHaveBeenCalledTimes(2);
    expect(harness.idempotency.get).toHaveBeenNthCalledWith(
      1,
      PAYMENT_SCOPE_SUCCESS,
    );
    expect(harness.idempotency.get).toHaveBeenNthCalledWith(
      2,
      PAYMENT_SCOPE_SUCCESS,
    );
    expect(simulatePayment.mock.calls.map((call) => call[2])).toEqual([
      PAYMENT_KEY,
      PAYMENT_KEY,
    ]);
    expect(harness.idempotency.clear).toHaveBeenCalledWith(
      PAYMENT_SCOPE_SUCCESS,
    );
  });

  it("preserves the same payment key when the POST response is invalid", async () => {
    const simulatePayment = vi
      .fn()
      .mockRejectedValueOnce({ code: "INVALID_API_RESPONSE" })
      .mockResolvedValueOnce(terminalBooking("CONFIRMED"));
    const harness = createHarness({ simulatePayment });
    await harness.page.onLoad.call(harness.page, { id: BOOKING_ID });

    await harness.page.simulateSuccess.call(harness.page);

    expect(harness.page.data.status).toBe("action_uncertain");
    expect(harness.idempotency.clear).not.toHaveBeenCalledWith(
      PAYMENT_SCOPE_SUCCESS,
    );

    await harness.page.simulateSuccess.call(harness.page);

    expect(simulatePayment).toHaveBeenCalledTimes(2);
    expect(simulatePayment.mock.calls.map((call) => call[2])).toEqual([
      PAYMENT_KEY,
      PAYMENT_KEY,
    ]);
  });

  it("uses allowed_actions as the sole write authority and makes all writes mutually exclusive", async () => {
    const terminal = createHarness({
      getBooking: vi.fn(async () => terminalBooking("CONFIRMED")),
    });
    await terminal.page.onLoad.call(terminal.page, { id: BOOKING_ID });
    await terminal.page.simulateSuccess.call(terminal.page);
    await terminal.page.simulateFailure.call(terminal.page);
    await terminal.page.cancelBooking.call(terminal.page);
    expect(terminal.ordersService.simulatePayment).not.toHaveBeenCalled();
    expect(terminal.ordersService.cancelBooking).not.toHaveBeenCalled();
    expect(terminal.page.data.booking.actions).toEqual([]);

    const payment = deferred();
    const pending = createHarness({
      simulatePayment: vi.fn(() => payment.promise),
    });
    await pending.page.onLoad.call(pending.page, { id: BOOKING_ID });
    const activePayment = pending.page.simulateSuccess.call(pending.page);
    await Promise.resolve();
    await pending.page.simulateFailure.call(pending.page);
    await pending.page.cancelBooking.call(pending.page);
    expect(pending.ordersService.simulatePayment).toHaveBeenCalledOnce();
    expect(pending.ordersService.cancelBooking).not.toHaveBeenCalled();
    expect(pending.wxApi.showModal).not.toHaveBeenCalled();
    payment.resolve(terminalBooking("CONFIRMED"));
    await activePayment;
  });

  it("invalidates hidden and unloaded generations, ignores late responses, and refreshes safely on show", async () => {
    const lateLoad = deferred();
    const getBooking = vi
      .fn()
      .mockReturnValueOnce(lateLoad.promise)
      .mockResolvedValueOnce(bookingDetail());
    const loading = createHarness({ getBooking });
    const load = loading.page.onLoad.call(loading.page, { id: BOOKING_ID });
    loading.page.onHide.call(loading.page);
    lateLoad.resolve(terminalBooking("CONFIRMED"));
    await load;
    expect(loading.page.data.status).toBe("loading");
    await loading.page.onShow.call(loading.page);
    expect(getBooking).toHaveBeenCalledTimes(2);
    expect(loading.page.data.status).toBe("ready");

    const latePayment = deferred();
    const action = createHarness({
      simulatePayment: vi.fn(() => latePayment.promise),
    });
    await action.page.onLoad.call(action.page, { id: BOOKING_ID });
    const submit = action.page.simulateSuccess.call(action.page);
    await Promise.resolve();
    action.page.onUnload.call(action.page);
    latePayment.resolve(terminalBooking("CONFIRMED"));
    await submit;
    expect(action.page.data.status).toBe("action_pending");
    expect(action.idempotency.clear).not.toHaveBeenCalled();
  });

  it("dispatches only recognized dataset actions and keeps terminal WXML free of alternate action sources", async () => {
    const harness = createHarness();
    await harness.page.onLoad.call(harness.page, { id: BOOKING_ID });
    harness.page.performAction.call(harness.page, {
      currentTarget: { dataset: { action: "UNKNOWN_PRIVATE_ACTION" } },
    });
    expect(harness.ordersService.cancelBooking).not.toHaveBeenCalled();
    expect(harness.ordersService.simulatePayment).not.toHaveBeenCalled();

    const [wxml, json, wxss] = await Promise.all([
      readFile(
        new URL("../pages/order-detail/order-detail.wxml", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../pages/order-detail/order-detail.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../pages/order-detail/order-detail.wxss", import.meta.url),
        "utf8",
      ),
    ]);
    expect(wxml).toMatch(/wx:for="\{\{booking\.actions\}\}"/);
    expect(wxml).toMatch(/data-action="\{\{item\.code\}\}"/);
    expect(wxml).toMatch(/bindtap="performAction"/);
    expect(wxml).not.toMatch(/bindtap="(?:cancelBooking|simulateSuccess|simulateFailure)"/);
    expect(wxml).not.toContain("{{item.reason}}");
    expect(wxml).toContain("item.reasonLabel");
    expect(wxml).toContain('wx:key="historyKey"');
    expect(wxml).not.toContain("刷新订单状态");
    expect(wxml).not.toContain("refresh-button");
    expect(wxml).toMatch(
      /status === 'action_uncertain' && item\.code !== uncertainAction/,
    );
    expect(wxml).toMatch(
      /errorCode === 'INVALID_BOOKING_LINK'[\s\S]*bind:retry="returnBack"/,
    );
    expect(JSON.parse(json).usingComponents).toMatchObject({
      "error-state": "/components/error-state/error-state",
      "loading-state": "/components/loading-state/loading-state",
      "navigation-bar": "/components/navigation-bar/navigation-bar",
    });
    expect(wxss).toContain("env(safe-area-inset-bottom)");
  });
});

import { describe, expect, it, vi } from "vitest";

import ordersModule from "../services/orders.js";

const { createOrdersService } = ordersModule;
const BOOKING_ID = "40000000-0000-4000-8000-000000000001";
const IDEMPOTENCY_KEY = "order-payment-1234567890_ABCDEFGHIJ";
const list = { items: [], next_cursor: null };
const detail = {
  booking_id: BOOKING_ID,
  booking_number: "SF20260730A1B2C3D4E5F6",
  status: "CANCELLED",
  property_name: "西湖云栖酒店",
  room_type_name: "湖景大床房",
  checkin: "2026-08-01",
  checkout: "2026-08-02",
  nights: 1,
  guests: 2,
  total_price_cents: 58800,
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
  ],
  booking_policy: "可免费取消",
  latest_payment: null,
  status_history: [
    {
      from_status: null,
      to_status: "PENDING_PAYMENT",
      reason: "BOOKING_CREATED",
      actor_type: "USER",
      created_at: "2026-07-30T02:00:00.000Z",
    },
    {
      from_status: "PENDING_PAYMENT",
      to_status: "CANCELLED",
      reason: "USER_CANCELLED",
      actor_type: "USER",
      created_at: "2026-07-30T02:01:00.000Z",
    },
  ],
  allowed_actions: [],
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function serviceWith({ get = async () => list, post = async () => detail } = {}) {
  const requestClient = { get: vi.fn(get), post: vi.fn(post) };
  return { requestClient, service: createOrdersService(requestClient) };
}

describe("orders service", () => {
  it("lists encoded queries and exposes only caller-controlled GET retry", async () => {
    const { requestClient, service } = serviceWith();
    await expect(
      service.listBookings(
        { limit: 20, cursor: "next_cursor-1" },
        { retry: true, isActive: () => true },
      ),
    ).resolves.toEqual(list);
    expect(requestClient.get).toHaveBeenCalledWith(
      "/bookings?limit=20&cursor=next_cursor-1",
      { retry: true },
    );
  });

  it("gets an encoded path and validates response identity", async () => {
    const { requestClient, service } = serviceWith({ get: async () => detail });
    await expect(service.getBooking(BOOKING_ID)).resolves.toEqual(detail);
    expect(requestClient.get).toHaveBeenCalledWith(
      `/bookings/${encodeURIComponent(BOOKING_ID)}`,
      { retry: false },
    );
  });

  it("posts cancellation with an exact empty body and retry disabled", async () => {
    const { requestClient, service } = serviceWith();
    await expect(service.cancelBooking(BOOKING_ID)).resolves.toEqual(detail);
    expect(requestClient.post).toHaveBeenCalledWith(
      `/bookings/${encodeURIComponent(BOOKING_ID)}/cancel`,
      {},
      { retry: false },
    );
  });

  it("posts a snapshotted simulation and exact idempotency header without retry", async () => {
    const { requestClient, service } = serviceWith();
    await expect(
      service.simulatePayment(
        BOOKING_ID,
        { outcome: "SUCCEED" },
        IDEMPOTENCY_KEY,
        { isActive: () => true },
      ),
    ).resolves.toEqual(detail);
    expect(requestClient.post).toHaveBeenCalledWith(
      `/dev/payments/${encodeURIComponent(BOOKING_ID)}/simulate`,
      { outcome: "SUCCEED" },
      {
        header: { "Idempotency-Key": IDEMPOTENCY_KEY },
        retry: false,
      },
    );
  });

  it("snapshots inputs, options, and request methods before awaiting", async () => {
    const pending = deferred();
    const calls = [];
    const environment = Object.create(null);
    Object.defineProperties(environment, {
      get: { enumerable: true, value: vi.fn() },
      post: {
        enumerable: true,
        value(path, body, options) {
          calls.push({ path, body, options });
          return pending.promise;
        },
      },
    });
    const service = createOrdersService(environment);
    const input = { outcome: "FAIL" };
    const options = { isActive: () => true };
    const operation = service.simulatePayment(
      BOOKING_ID,
      input,
      IDEMPOTENCY_KEY,
      options,
    );
    input.outcome = "SUCCEED";
    options.isActive = () => false;
    pending.resolve(detail);

    await expect(operation).resolves.toEqual(detail);
    expect(calls).toEqual([
      {
        path: `/dev/payments/${BOOKING_ID}/simulate`,
        body: { outcome: "FAIL" },
        options: {
          header: { "Idempotency-Key": IDEMPOTENCY_KEY },
          retry: false,
        },
      },
    ]);
  });

  it("rejects hostile IDs, query/body/options, and environments before requesting", async () => {
    let reads = 0;
    const getter = {};
    Object.defineProperty(getter, "limit", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("private getter");
      },
    });
    const inherited = Object.assign(Object.create({ limit: 1 }), {});
    const { requestClient, service } = serviceWith();
    await expect(service.listBookings(getter)).rejects.toMatchObject({
      code: "INVALID_ORDER_INPUT",
    });
    await expect(service.listBookings(inherited)).rejects.toMatchObject({
      code: "INVALID_ORDER_INPUT",
    });
    await expect(service.getBooking("../secret")).rejects.toMatchObject({
      code: "INVALID_ORDER_INPUT",
    });
    await expect(
      service.simulatePayment(
        BOOKING_ID,
        { outcome: "SUCCEED", unexpected: true },
        IDEMPOTENCY_KEY,
      ),
    ).rejects.toMatchObject({ code: "INVALID_ORDER_INPUT" });
    await expect(
      service.simulatePayment(
        BOOKING_ID,
        { outcome: "SUCCEED" },
        "too-short",
      ),
    ).rejects.toMatchObject({ code: "INVALID_ORDER_INPUT" });
    expect(() =>
      createOrdersService(Object.create({ get() {}, post() {} })),
    ).toThrow(expect.objectContaining({ code: "INVALID_ORDER_ENVIRONMENT" }));
    expect(reads).toBe(0);
    expect(requestClient.get).not.toHaveBeenCalled();
    expect(requestClient.post).not.toHaveBeenCalled();
  });

  it("cancels a late response and a late rejection before publishing data or inspecting errors", async () => {
    for (const settle of ["resolve", "reject"]) {
      const pending = deferred();
      let active = true;
      let reads = 0;
      const hostile = {};
      Object.defineProperty(hostile, "code", {
        enumerable: true,
        get() {
          reads += 1;
          throw new Error("private error getter");
        },
      });
      const { service } = serviceWith({ get: () => pending.promise });
      const operation = service.getBooking(BOOKING_ID, {
        isActive: () => active,
      });
      active = false;
      pending[settle](settle === "resolve" ? detail : hostile);
      await expect(operation).rejects.toMatchObject({
        code: "BOOKING_OPERATION_CANCELLED",
      });
      expect(reads).toBe(0);
    }
  });

  it.each([
    "BOOKING_NOT_FOUND",
    "BOOKING_NOT_CANCELLABLE",
    "BOOKING_EXPIRED",
    "BOOKING_ALREADY_PROCESSED",
    "ORDER_CURSOR_INVALID",
    "PAYMENT_REQUEST_INVALID",
    "IDEMPOTENCY_KEY_REUSED",
    "MOCK_PAYMENT_FAILED",
    "RATE_LIMITED",
    "NETWORK_REQUEST_FAILED",
    "AUTH_SESSION_EXPIRED",
  ])("reconstructs the whitelisted %s failure without its dependency message", async (code) => {
    const dependency = Object.assign(new Error("secret dependency message"), {
      code,
      statusCode: code === "NETWORK_REQUEST_FAILED" ? 503 : 409,
      requestId: "request_order_safe",
    });
    const { service } = serviceWith({
      post: async () => {
        throw dependency;
      },
    });
    const error = await service.cancelBooking(BOOKING_ID).catch((value) => value);
    expect(error).toMatchObject({
      code,
      statusCode: expect.any(Number),
      requestId: "request_order_safe",
    });
    expect(error).not.toBe(dependency);
    expect(error.message).not.toContain("secret");
  });

  it("maps unknown, proxy, accessor, and malformed dependency failures to one safe error", async () => {
    let reads = 0;
    const accessor = {};
    Object.defineProperty(accessor, "code", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("private error getter");
      },
    });
    for (const dependency of [
      new Error("database password"),
      { code: "UNKNOWN_INTERNAL", message: "token=secret" },
      new Proxy(
        { code: "BOOKING_NOT_FOUND" },
        {
          getPrototypeOf() {
            throw new Error("trap");
          },
        },
      ),
      accessor,
    ]) {
      const { service } = serviceWith({
        post: async () => {
          throw dependency;
        },
      });
      await expect(service.cancelBooking(BOOKING_ID)).rejects.toMatchObject({
        code: "BOOKING_LIFECYCLE_UNAVAILABLE",
        message: "Booking lifecycle unavailable",
      });
    }
    expect(reads).toBe(0);
  });
});

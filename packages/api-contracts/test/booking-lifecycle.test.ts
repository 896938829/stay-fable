import { describe, expect, it } from "vitest";

import {
  bookingAllowedActionSchema,
  bookingDetailSchema,
  bookingListItemSchema,
  bookingListQuerySchema,
  bookingListResponseSchema,
  bookingPaymentSummarySchema,
  bookingStatusHistoryItemSchema,
  bookingStatusSchema,
  cancelBookingRequestSchema,
  simulatePaymentRequestSchema,
} from "../src/booking-lifecycle.js";

const listItem = {
  booking_id: "40000000-0000-4000-8000-000000000001",
  booking_number: "SF20260730A1B2C3D4E5F6",
  status: "PENDING_PAYMENT",
  property_name: "西湖云栖酒店",
  room_type_name: "湖景大床房",
  checkin: "2026-08-01",
  checkout: "2026-08-03",
  nights: 2,
  guests: 2,
  total_price_cents: 121_600,
  currency: "CNY",
  expires_at: "2026-07-30T02:15:00.000Z",
  payment_deadline_passed: false,
  created_at: "2026-07-30T02:00:00.000Z",
  updated_at: "2026-07-30T02:00:00.000Z",
};

const nightlyPrices = [
  {
    business_date: "2026-08-01",
    sale_price_cents: 58_800,
    rack_price_cents: 68_800,
    currency: "CNY",
  },
  {
    business_date: "2026-08-02",
    sale_price_cents: 62_800,
    rack_price_cents: 72_800,
    currency: "CNY",
  },
];

const payment = {
  payment_number: "SFP20260730A1B2C3D4E5F6",
  status: "SUCCEEDED",
  processed_at: "2026-07-30T02:02:00.000Z",
};

const history = {
  from_status: null,
  to_status: "PENDING_PAYMENT",
  reason: "BOOKING_CREATED",
  actor_type: "USER",
  created_at: "2026-07-30T02:00:00.000Z",
};

const detail = {
  ...listItem,
  nightly_prices: nightlyPrices,
  booking_policy: "入住前一天 18:00 前可免费取消",
  latest_payment: payment,
  status_history: [history],
  allowed_actions: ["CANCEL", "MOCK_PAY_SUCCESS", "MOCK_PAY_FAILURE"],
};

const hostileInputs = (source: object) => {
  const getter = { ...source };
  Object.defineProperty(getter, "secret", {
    enumerable: true,
    get() {
      throw new Error("getter-secret");
    },
  });

  const proxy = new Proxy(
    { ...source },
    {
      ownKeys() {
        throw new Error("proxy-secret");
      },
    },
  );
  const symbol = { ...source, [Symbol("secret")]: true };
  let deep: unknown = "leaf";
  for (let index = 0; index < 20; index += 1) {
    deep = { nested: deep };
  }
  return [getter, proxy, symbol, { ...source, unknown: deep }];
};

describe("booking lifecycle contracts", () => {
  it("accepts only the designed statuses, actions, and request bodies", () => {
    for (const status of ["PENDING_PAYMENT", "PAID", "CONFIRMED", "CANCELLED", "CLOSED"]) {
      expect(bookingStatusSchema.parse(status)).toBe(status);
    }
    expect(bookingStatusSchema.safeParse("EXPIRED").success).toBe(false);

    for (const action of ["CANCEL", "MOCK_PAY_SUCCESS", "MOCK_PAY_FAILURE"]) {
      expect(bookingAllowedActionSchema.parse(action)).toBe(action);
    }
    expect(bookingAllowedActionSchema.safeParse("PAY").success).toBe(false);
    expect(simulatePaymentRequestSchema.parse({ outcome: "SUCCEED" })).toEqual({
      outcome: "SUCCEED",
    });
    expect(simulatePaymentRequestSchema.parse({ outcome: "FAIL" })).toEqual({
      outcome: "FAIL",
    });
    expect(simulatePaymentRequestSchema.safeParse({ outcome: "SUCCEEDED" }).success).toBe(false);
    expect(
      simulatePaymentRequestSchema.safeParse({ outcome: "SUCCEED", extra: true }).success,
    ).toBe(false);
    expect(cancelBookingRequestSchema.parse({})).toEqual({});
    expect(cancelBookingRequestSchema.safeParse({ unexpected: true }).success).toBe(false);
  });

  it("coerces bounded list limits and accepts only bounded base64url cursors", () => {
    expect(bookingListQuerySchema.parse({ limit: "10" })).toEqual({ limit: 10 });
    expect(bookingListQuerySchema.parse({})).toEqual({ limit: 10 });
    expect(bookingListQuerySchema.parse({ cursor: "Abc_123-x" })).toEqual({
      limit: 10,
      cursor: "Abc_123-x",
    });
    for (const query of [
      { limit: "0" },
      { limit: "21" },
      { limit: "1.5" },
      { cursor: "" },
      { cursor: "a".repeat(513) },
      { cursor: "abc=" },
      { cursor: "abc+" },
      { unknown: true },
    ]) {
      expect(bookingListQuerySchema.safeParse(query).success).toBe(false);
    }
  });

  it("accepts exact list, payment, history, and detail shapes", () => {
    expect(bookingListItemSchema.parse(listItem)).toEqual(listItem);
    expect(bookingPaymentSummarySchema.parse(payment)).toEqual(payment);
    expect(bookingStatusHistoryItemSchema.parse(history)).toEqual(history);
    expect(bookingDetailSchema.parse(detail)).toEqual(detail);
    expect(
      bookingListResponseSchema.parse({
        items: [listItem],
        next_cursor: "next_cursor-1",
      }),
    ).toEqual({ items: [listItem], next_cursor: "next_cursor-1" });

    expect(bookingPaymentSummarySchema.safeParse({ ...payment, status: "FAILED" }).success).toBe(
      true,
    );
    expect(bookingPaymentSummarySchema.safeParse({ ...payment, status: "PENDING" }).success).toBe(
      false,
    );
    expect(
      bookingDetailSchema.safeParse({
        ...detail,
        user_id: "00000000-0000-4000-8000-000000000001",
      }).success,
    ).toBe(false);
    expect(bookingDetailSchema.safeParse({ ...detail, total_amount: 121_600 }).success).toBe(false);
    expect(
      bookingStatusHistoryItemSchema.safeParse({ ...history, actor_user_id: listItem.booking_id })
        .success,
    ).toBe(false);
  });

  it("requires fixed unique allowed-action order and bounded collections", () => {
    for (const allowedActions of [
      ["CANCEL", "CANCEL"],
      ["MOCK_PAY_SUCCESS", "CANCEL"],
      ["MOCK_PAY_FAILURE", "MOCK_PAY_SUCCESS"],
    ]) {
      expect(
        bookingDetailSchema.safeParse({ ...detail, allowed_actions: allowedActions }).success,
      ).toBe(false);
    }
    expect(
      bookingDetailSchema.safeParse({
        ...detail,
        status: "PAID",
        allowed_actions: ["CANCEL"],
      }).success,
    ).toBe(false);
    expect(
      bookingDetailSchema.safeParse({
        ...detail,
        payment_deadline_passed: true,
        allowed_actions: ["CANCEL"],
      }).success,
    ).toBe(false);
    const listItems = (length: number) => Array.from({ length }, () => ({ ...listItem }));
    expect(
      bookingListResponseSchema.safeParse({
        items: listItems(20),
        next_cursor: null,
      }).success,
    ).toBe(true);
    expect(
      bookingListResponseSchema.safeParse({
        items: listItems(21),
        next_cursor: null,
      }).success,
    ).toBe(false);

    const historyItems = (length: number) => Array.from({ length }, () => ({ ...history }));
    expect(
      bookingDetailSchema.safeParse({
        ...detail,
        status_history: historyItems(100),
      }).success,
    ).toBe(true);
    expect(
      bookingDetailSchema.safeParse({
        ...detail,
        status_history: historyItems(101),
      }).success,
    ).toBe(false);

    const sparseHistory = new Array(1);
    const historyWithExtraProperty = historyItems(1);
    Object.defineProperty(historyWithExtraProperty, "extra", { value: true });
    const historyWithSymbol = historyItems(1);
    Object.defineProperty(historyWithSymbol, Symbol("extra"), { value: true });
    for (const statusHistory of [sparseHistory, historyWithExtraProperty, historyWithSymbol]) {
      expect(
        bookingDetailSchema.safeParse({
          ...detail,
          status_history: statusHistory,
        }).success,
      ).toBe(false);
    }
  });

  it("requires dates, nights, nightly prices, and totals to describe one stay", () => {
    for (const invalid of [
      { ...detail, nights: 1 },
      { ...detail, checkout: "2026-08-04" },
      { ...detail, nightly_prices: [nightlyPrices[0]] },
      {
        ...detail,
        nightly_prices: [{ ...nightlyPrices[0], business_date: "2026-08-02" }, nightlyPrices[1]],
      },
      { ...detail, total_price_cents: 121_599 },
      {
        ...detail,
        nightly_prices: [{ ...nightlyPrices[0], rack_price_cents: 1 }, nightlyPrices[1]],
      },
    ]) {
      expect(bookingDetailSchema.safeParse(invalid).success).toBe(false);
    }
    expect(bookingListItemSchema.safeParse({ ...listItem, nights: 1 }).success).toBe(false);
  });

  it("fails closed for accessors, proxies, symbols, and excessive nesting", () => {
    for (const hostile of hostileInputs(detail)) {
      expect(() => bookingDetailSchema.safeParse(hostile)).not.toThrow();
      expect(bookingDetailSchema.safeParse(hostile).success).toBe(false);
    }
    for (const hostile of hostileInputs({ outcome: "SUCCEED" })) {
      expect(() => simulatePaymentRequestSchema.safeParse(hostile)).not.toThrow();
      expect(simulatePaymentRequestSchema.safeParse(hostile).success).toBe(false);
    }
  });

  it("rejects inherited accessors and non-ordinary prototypes without invoking inherited code", () => {
    let inheritedGetterCalls = 0;
    const inheritedPrototype = Object.create(Object.prototype) as Record<string, unknown>;
    Object.defineProperty(inheritedPrototype, "inherited_secret", {
      get() {
        inheritedGetterCalls += 1;
        throw new Error("inherited-getter-secret");
      },
    });
    const inheritedDetail = Object.assign(Object.create(inheritedPrototype) as object, detail);

    expect(() => bookingDetailSchema.safeParse(inheritedDetail)).not.toThrow();
    expect(bookingDetailSchema.safeParse(inheritedDetail).success).toBe(false);
    expect(inheritedGetterCalls).toBe(0);
    expect(cancelBookingRequestSchema.safeParse(new Date(0)).success).toBe(false);
    expect(cancelBookingRequestSchema.safeParse(new Map()).success).toBe(false);
    const inheritedArray = [...detail.status_history];
    Object.setPrototypeOf(inheritedArray, Object.create(Array.prototype) as object);
    expect(
      bookingDetailSchema.safeParse({ ...detail, status_history: inheritedArray }).success,
    ).toBe(false);

    const nullPrototypeDetail = Object.assign(Object.create(null) as object, detail);
    expect(bookingDetailSchema.safeParse(nullPrototypeDetail).success).toBe(true);
    expect(cancelBookingRequestSchema.safeParse(Object.create(null)).success).toBe(true);
  });

  it("fails closed when observable proxy reflection changes without throwing or leaking details", () => {
    const source = { outcome: "SUCCEED" };
    let prototypeReads = 0;
    const changingPrototype = new Proxy(source, {
      getPrototypeOf() {
        prototypeReads += 1;
        return prototypeReads % 2 === 1 ? Object.prototype : null;
      },
    });
    let ownKeyReads = 0;
    const changingOwnKeys = new Proxy(source, {
      ownKeys(target) {
        ownKeyReads += 1;
        return ownKeyReads === 1 ? Reflect.ownKeys(target) : [];
      },
    });
    let descriptorReads = 0;
    const changingDescriptor = new Proxy(source, {
      getOwnPropertyDescriptor(target, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        descriptorReads += 1;
        if (property === "outcome" && descriptor !== undefined && descriptorReads > 1) {
          return { ...descriptor, value: "FAIL" };
        }
        return descriptor;
      },
    });

    for (const hostile of [changingPrototype, changingOwnKeys, changingDescriptor]) {
      let result: ReturnType<typeof simulatePaymentRequestSchema.safeParse> | undefined;
      expect(() => {
        result = simulatePaymentRequestSchema.safeParse(hostile);
      }).not.toThrow();
      expect(result?.success).toBe(false);
      expect(JSON.stringify(result)).not.toContain("secret");
    }
  });
});

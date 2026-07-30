import { describe, expect, it } from "vitest";

import contractsModule from "../services/contracts.js";

const { assertBookingDetail, assertBookingListResponse } = contractsModule;

const IDS = {
  booking: "40000000-0000-4000-8000-000000000001",
};
const listItem = {
  booking_id: IDS.booking,
  booking_number: "SF20260730A1B2C3D4E5F6",
  status: "PENDING_PAYMENT",
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
};
const validList = {
  items: [listItem],
  next_cursor: "eyJjcmVhdGVkQXQiOiIyMDI2In0",
};
const validDetail = {
  ...listItem,
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
  latest_payment: {
    payment_number: "SFP20260730A1B2C3D4E5F6",
    status: "FAILED",
    processed_at: "2026-07-30T02:02:00.000Z",
  },
  status_history: [
    {
      from_status: null,
      to_status: "PENDING_PAYMENT",
      reason: "BOOKING_CREATED",
      actor_type: "USER",
      created_at: "2026-07-30T02:00:00.000Z",
    },
  ],
  allowed_actions: ["CANCEL", "MOCK_PAY_SUCCESS", "MOCK_PAY_FAILURE"],
};

describe("order contracts", () => {
  it("canonicalizes strict list and detail responses", () => {
    expect(assertBookingListResponse(validList)).toEqual(validList);
    expect(assertBookingDetail(validDetail)).toEqual(validDetail);
    expect(assertBookingListResponse(validList)).not.toBe(validList);
    expect(assertBookingDetail(validDetail).nightly_prices).not.toBe(
      validDetail.nightly_prices,
    );
  });

  it.each([
    ["unknown list field", { ...validList, unknown: true }, assertBookingListResponse],
    [
      "user identifier",
      { ...validDetail, user_id: "10000000-0000-4000-8000-000000000001" },
      assertBookingDetail,
    ],
    ["hold data", { ...validDetail, inventory_hold: [] }, assertBookingDetail],
    ["inventory data", { ...validDetail, held_inventory: 1 }, assertBookingDetail],
    [
      "actor user identifier",
      {
        ...validDetail,
        status_history: [
          { ...validDetail.status_history[0], actor_user_id: IDS.booking },
        ],
      },
      assertBookingDetail,
    ],
    [
      "payment identifier",
      {
        ...validDetail,
        latest_payment: { ...validDetail.latest_payment, payment_id: IDS.booking },
      },
      assertBookingDetail,
    ],
  ])("rejects %s leakage or unknown fields", (_label, value, assertion) => {
    expect(() => assertion(value)).toThrow(/Invalid API response/);
  });

  it("rejects accessors, proxies, symbols, sparse arrays, and non-ordinary prototypes safely", () => {
    let reads = 0;
    const getter = { ...validDetail };
    Object.defineProperty(getter, "booking_id", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("private booking getter");
      },
    });
    const proxy = new Proxy(validList, {
      getPrototypeOf() {
        throw new Error("private proxy trap");
      },
    });
    const sparseItems = [];
    sparseItems.length = 1;
    for (const [assertion, value] of [
      [assertBookingDetail, getter],
      [assertBookingListResponse, proxy],
      [assertBookingDetail, { ...validDetail, [Symbol("secret")]: true }],
      [assertBookingDetail, Object.assign(Object.create({ secret: true }), validDetail)],
      [assertBookingListResponse, { ...validList, items: sparseItems }],
    ]) {
      expect(() => assertion(value)).toThrow(/Invalid API response/);
    }
    expect(reads).toBe(0);
  });

  it.each([
    ["calendar date", { ...validDetail, checkin: "2026-02-30" }],
    ["stay length", { ...validDetail, nights: 3 }],
    ["instant", { ...validDetail, updated_at: "2026-13-30T02:01:00Z" }],
    ["negative money", { ...validDetail, total_price_cents: -1 }],
    ["fractional money", { ...validDetail, total_price_cents: 1.5 }],
    ["status", { ...validDetail, status: "REFUNDED" }],
    [
      "nightly total",
      {
        ...validDetail,
        nightly_prices: [
          { ...validDetail.nightly_prices[0], sale_price_cents: 1 },
          validDetail.nightly_prices[1],
        ],
      },
    ],
    [
      "nightly order",
      {
        ...validDetail,
        nightly_prices: [
          validDetail.nightly_prices[1],
          validDetail.nightly_prices[0],
        ],
      },
    ],
    [
      "payment status",
      {
        ...validDetail,
        latest_payment: { ...validDetail.latest_payment, status: "PENDING" },
      },
    ],
    [
      "history transition",
      {
        ...validDetail,
        status_history: [
          {
            ...validDetail.status_history[0],
            from_status: "CONFIRMED",
            to_status: "PENDING_PAYMENT",
          },
        ],
      },
    ],
    [
      "history actor",
      {
        ...validDetail,
        status_history: [
          { ...validDetail.status_history[0], actor_type: "ADMIN" },
        ],
      },
    ],
    [
      "duplicate actions",
      { ...validDetail, allowed_actions: ["CANCEL", "CANCEL"] },
    ],
    [
      "unordered actions",
      {
        ...validDetail,
        allowed_actions: ["MOCK_PAY_SUCCESS", "CANCEL"],
      },
    ],
    [
      "terminal actions",
      {
        ...validDetail,
        status: "CONFIRMED",
        allowed_actions: ["CANCEL"],
      },
    ],
  ])("rejects an invalid %s", (_label, value) => {
    expect(() => assertBookingDetail(value)).toThrow(/Invalid API response/);
  });

  it("enforces bounded arrays and cursor shape", () => {
    expect(() =>
      assertBookingListResponse({
        items: Array.from({ length: 21 }, () => listItem),
        next_cursor: null,
      }),
    ).toThrow(/Invalid API response/);
    expect(() =>
      assertBookingDetail({
        ...validDetail,
        status_history: Array.from(
          { length: 101 },
          () => validDetail.status_history[0],
        ),
      }),
    ).toThrow(/Invalid API response/);
    expect(() =>
      assertBookingListResponse({ ...validList, next_cursor: "bad=" }),
    ).toThrow(/Invalid API response/);
    expect(() =>
      assertBookingListResponse({
        ...validList,
        next_cursor: "A".repeat(513),
      }),
    ).toThrow(/Invalid API response/);
  });
});

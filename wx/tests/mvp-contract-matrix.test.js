import { describe, expect, it, vi } from "vitest";

import contractsModule from "../services/contracts.js";
import authModule from "../services/auth.js";

const {
  assertAuthSession,
  assertBookingDetail,
  assertBookingListResponse,
  assertBookingResponse,
  assertApiErrorResponse,
  assertEnvelope,
  assertPropertyDetail,
  assertPropertyListResponse,
  assertQuoteResponse,
  assertResolvedLocation,
  assertRoomTypeDetail,
} = contractsModule;
const { createAuthService } = authModule;

const IDS = {
  booking: "40000000-0000-4000-8000-000000000001",
  property: "10000000-0000-4000-8000-000000000001",
  quote: "30000000-0000-4000-8000-000000000001",
  roomType: "20000000-0000-4000-8000-000000000001",
};
const summary = {
  booking_id: IDS.booking,
  booking_number: "SF20260730A1B2C3D4E5F6",
  status: "PENDING_PAYMENT",
  property_name: "西湖云栖酒店",
  room_type_name: "湖景大床房",
  checkin: "2026-08-01",
  checkout: "2026-08-03",
  nights: 2,
  guests: 3,
  total_price_cents: 121600,
  currency: "CNY",
  expires_at: "2026-07-30T02:15:00.000Z",
  payment_deadline_passed: false,
  created_at: "2026-07-30T02:00:00.000Z",
  updated_at: "2026-07-30T02:01:00.000Z",
};
const detail = {
  ...summary,
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
const quote = {
  quote_id: IDS.quote,
  property: { id: IDS.property, name: "西湖云栖酒店" },
  room_type: {
    id: IDS.roomType,
    name: "湖景大床房",
    cover_url: "/images/catalog/hangzhou-hotel-room-1.jpg",
  },
  checkin: "2026-08-01",
  checkout: "2026-08-03",
  nights: 2,
  guests: 3,
  nightly_prices: detail.nightly_prices,
  total_price_cents: 121600,
  currency: "CNY",
  booking_policy: detail.booking_policy,
  expires_at: "2026-07-30T02:05:00.000Z",
};
const booking = {
  booking_id: IDS.booking,
  quote_id: IDS.quote,
  booking_number: summary.booking_number,
  status: "PENDING_PAYMENT",
  property_name: summary.property_name,
  room_type_name: summary.room_type_name,
  checkin: summary.checkin,
  checkout: summary.checkout,
  nights: summary.nights,
  guests: summary.guests,
  total_price_cents: summary.total_price_cents,
  currency: "CNY",
  expires_at: summary.expires_at,
  created_at: summary.created_at,
};
const city = { id: IDS.property, code: "330100", name: "杭州" };
const propertyListItem = {
  id: IDS.property,
  type: "HOTEL",
  name: "西湖云栖酒店",
  city,
  cover_url: "/images/properties/xihu.jpg",
  short_description: "湖景步行可达",
  facility_highlights: ["免费停车"],
  from_nightly_price_cents: 58800,
  currency: "CNY",
  available_room_type_count: 1,
};
const roomTypeSummary = {
  id: IDS.roomType,
  name: "湖景大床房",
  bed_type: "KING",
  area_sqm: 35,
  max_guests: 3,
  cover_url: "/images/catalog/hangzhou-hotel-room-1.jpg",
  policy_summary: "入住前一天 18:00 前可免费取消",
  from_nightly_price_cents: 58800,
  currency: "CNY",
};
const propertyDetail = {
  id: IDS.property,
  type: "HOTEL",
  name: propertyListItem.name,
  city,
  address: "杭州市西湖区灵隐路 1 号",
  description: "临近西湖的精品酒店。",
  policies: "14:00 后入住，12:00 前退房。",
  cover_url: propertyListItem.cover_url,
  media: [{ type: "IMAGE", url: propertyListItem.cover_url, alt: "酒店外观" }],
  facilities: [{ code: "PARKING", name: "免费停车" }],
  room_types: [roomTypeSummary],
};
const roomTypeDetail = {
  id: IDS.roomType,
  name: roomTypeSummary.name,
  bed_type: roomTypeSummary.bed_type,
  area_sqm: roomTypeSummary.area_sqm,
  max_guests: roomTypeSummary.max_guests,
  cover_url: roomTypeSummary.cover_url,
  currency: "CNY",
  property: {
    id: IDS.property,
    type: "HOTEL",
    name: propertyListItem.name,
    city,
  },
  description: "面向西湖的宽敞客房。",
  booking_policy: detail.booking_policy,
  nightly_prices: detail.nightly_prices,
};

const expectInvalid = (callback) =>
  expect(callback).toThrow(
    expect.objectContaining({
      code: "INVALID_API_RESPONSE",
      message: "Invalid API response",
    }),
  );

describe("MVP OpenAPI to WeChat contract matrix", () => {
  it("uses the established public refresh route fixed by the MVP OpenAPI", async () => {
    const post = vi.fn(async () => ({
      access_token: "a".repeat(32),
      access_expires_in: 900,
      refresh_token: "r".repeat(32),
      refresh_expires_in: 2_592_000,
      user: { id: IDS.property },
    }));
    await createAuthService({ post }).refresh("r".repeat(32));
    expect(post).toHaveBeenCalledWith(
      "/auth/session/refresh",
      { refresh_token: "r".repeat(32) },
      { auth: false, retry: false },
    );
  });

  it("accepts exact date, amount, cursor, history, payment, and server-action fields", () => {
    expect(assertQuoteResponse(quote, IDS.roomType)).toEqual(quote);
    expect(assertBookingResponse(booking, IDS.quote)).toEqual(booking);
    expect(
      assertBookingListResponse({ items: [summary], next_cursor: "eyJpZCI6IjEifQ" }),
    ).toEqual({ items: [summary], next_cursor: "eyJpZCI6IjEifQ" });
    expect(assertBookingDetail(detail)).toEqual(detail);
  });

  it("maps every MVP response family to an exact WeChat contract snapshot", () => {
    const session = {
      access_token: "a".repeat(32),
      access_expires_in: 900,
      refresh_token: "r".repeat(32),
      refresh_expires_in: 2_592_000,
      user: { id: IDS.property },
    };
    const cases = [
      [assertAuthSession, session],
      [
        assertResolvedLocation,
        { city, distance_meters: 8 },
      ],
      [
        assertPropertyListResponse,
        { items: [propertyListItem], next_cursor: null },
      ],
      [assertPropertyDetail, propertyDetail],
      [assertRoomTypeDetail, roomTypeDetail],
    ];
    for (const [assertion, value] of cases) {
      expect(assertion(value)).toEqual(value);
      expectInvalid(() => assertion({ ...value, public_future_field: true }));
    }
  });

  it("rejects a future public envelope field until the matrix is deliberately updated", () => {
    expectInvalid(() =>
      assertEnvelope({
        data: quote,
        request_id: "req_matrix",
        public_future_field: true,
      }),
    );
  });

  it.each([
    ["quote user", () => assertQuoteResponse({ ...quote, user_id: IDS.property }, IDS.roomType)],
    ["booking hold", () => assertBookingResponse({ ...booking, hold_id: IDS.property }, IDS.quote)],
    [
      "list inventory",
      () =>
        assertBookingListResponse({
          items: [{ ...summary, inventory_id: IDS.property }],
          next_cursor: null,
        }),
    ],
    [
      "payment UUID",
      () =>
        assertBookingDetail({
          ...detail,
          latest_payment: { ...detail.latest_payment, id: IDS.property },
        }),
    ],
    [
      "history user UUID",
      () =>
        assertBookingDetail({
          ...detail,
          status_history: [{ ...detail.status_history[0], actor_user_id: IDS.property }],
        }),
    ],
    ["unknown action", () => assertBookingDetail({ ...detail, allowed_actions: ["REFUND"] })],
  ])("rejects %s and other non-OpenAPI keys", (_label, assertion) => {
    expectInvalid(assertion);
  });

  it("does not invoke getters and safely rejects one invoked Proxy trap at the trusted JSON boundary", () => {
    let reads = 0;
    const getter = { ...detail };
    Object.defineProperty(getter, "allowed_actions", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("secret action getter");
      },
    });
    const proxy = new Proxy(detail, {
      getPrototypeOf() {
        reads += 1;
        throw new Error("secret proxy trap");
      },
    });
    expectInvalid(() => assertBookingDetail(getter));
    expect(reads).toBe(0);
    expectInvalid(() => assertBookingDetail(proxy));
    expectInvalid(() => assertBookingDetail({ ...detail, [Symbol("secret")]: true }));
    expect(reads).toBe(1);
  });

  it("rejects nested array accessors, sparse arrays, symbols, and extra keys without reading items", () => {
    let reads = 0;
    const accessorItems = [propertyListItem];
    Object.defineProperty(accessorItems, "0", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("nested array secret");
      },
    });
    expectInvalid(() =>
      assertPropertyListResponse({ items: accessorItems, next_cursor: null }),
    );
    expect(reads).toBe(0);

    const sparseItems = new Array(1);
    expectInvalid(() =>
      assertPropertyListResponse({ items: sparseItems, next_cursor: null }),
    );
    const symbolItems = [propertyListItem];
    symbolItems[Symbol("secret")] = true;
    expectInvalid(() =>
      assertPropertyListResponse({ items: symbolItems, next_cursor: null }),
    );
    const extraItems = [propertyListItem];
    extraItems.extra = true;
    expectInvalid(() =>
      assertPropertyListResponse({ items: extraItems, next_cursor: null }),
    );

    const proxyItems = new Proxy([propertyListItem], {
      getPrototypeOf() {
        reads += 1;
        throw new Error("nested proxy secret");
      },
    });
    expectInvalid(() =>
      assertPropertyListResponse({ items: proxyItems, next_cursor: null }),
    );
    expect(reads).toBe(1);
  });

  it("rejects an API error accessor without reading error.code", () => {
    let reads = 0;
    const error = {
      message: "bad request",
      details: null,
    };
    Object.defineProperty(error, "code", {
      enumerable: true,
      get() {
        reads += 1;
        return "BAD_REQUEST";
      },
    });
    expectInvalid(() =>
      assertApiErrorResponse({ error, request_id: "req_error" }),
    );
    expect(reads).toBe(0);
  });

  it("rejects catalog and city getters without invoking them", () => {
    let reads = 0;
    const withGetter = (value, key) => {
      const hostile = { ...value };
      Object.defineProperty(hostile, key, {
        enumerable: true,
        get() {
          reads += 1;
          throw new Error("catalog getter secret");
        },
      });
      return hostile;
    };
    expectInvalid(() =>
      assertResolvedLocation({
        city: withGetter(city, "name"),
        distance_meters: 8,
      }),
    );
    expectInvalid(() =>
      assertPropertyListResponse({
        items: [withGetter(propertyListItem, "name")],
        next_cursor: null,
      }),
    );
    expectInvalid(() => assertPropertyDetail(withGetter(propertyDetail, "name")));
    expectInvalid(() => assertRoomTypeDetail(withGetter(roomTypeDetail, "name")));
    expect(reads).toBe(0);
  });

  it("treats allowed_actions as server authority instead of deriving writes from status", () => {
    const noActions = { ...detail, allowed_actions: [] };
    expect(assertBookingDetail(noActions).allowed_actions).toEqual([]);
    expectInvalid(() =>
      assertBookingDetail({
        ...detail,
        status: "CONFIRMED",
        allowed_actions: ["CANCEL"],
      }),
    );
  });
});

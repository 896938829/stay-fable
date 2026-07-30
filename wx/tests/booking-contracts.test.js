import { describe, expect, it } from "vitest";

import contracts from "../services/contracts.js";

const { assertBookingResponse, assertQuoteChangedDetails, assertQuoteResponse } = contracts;

const IDS = {
  property: "10000000-0000-4000-8000-000000000001",
  roomType: "20000000-0000-4000-8000-000000000001",
  quote: "30000000-0000-4000-8000-000000000001",
  booking: "40000000-0000-4000-8000-000000000001",
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
  guests: 2,
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

const booking = {
  booking_id: IDS.booking,
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

function expectInvalid(callback) {
  expect(callback).toThrow(
    expect.objectContaining({
      code: "INVALID_API_RESPONSE",
      message: "Invalid API response",
    }),
  );
}

function nullPrototypeCopy(value) {
  if (Array.isArray(value)) {
    return value.map(nullPrototypeCopy);
  }
  if (value && typeof value === "object") {
    const result = Object.create(null);
    for (const [key, entry] of Object.entries(value)) {
      result[key] = nullPrototypeCopy(entry);
    }
    return result;
  }
  return value;
}

describe("booking response contracts", () => {
  it("returns detached strict quote, booking, and replacement quote snapshots", () => {
    const parsedQuote = assertQuoteResponse(nullPrototypeCopy(quote), IDS.roomType);
    const parsedBooking = assertBookingResponse(nullPrototypeCopy(booking), IDS.quote);
    const details = assertQuoteChangedDetails({
      previous_total_price_cents: quote.total_price_cents,
      replacement_quote: quote,
    });

    expect(parsedQuote).toEqual(quote);
    expect(parsedBooking).toEqual(booking);
    expect(details).toEqual({
      previous_total_price_cents: quote.total_price_cents,
      replacement_quote: quote,
    });
    expect(parsedQuote).not.toBe(quote);
    expect(parsedQuote.property).not.toBe(quote.property);
    expect(parsedBooking).not.toBe(booking);
    expect(details.replacement_quote).not.toBe(quote);
  });

  it("binds quote room IDs and requires a valid requested quote ID", () => {
    expectInvalid(() =>
      assertQuoteResponse(quote, "20000000-0000-4000-8000-000000000002"),
    );
    expectInvalid(() => assertBookingResponse(booking, "not-a-quote-id"));
  });

  it("rejects unknown inventory, user, history, version, and nested fields", () => {
    const quoteCases = [
      { ...quote, held_inventory: 1 },
      { ...quote, version: 1 },
      { ...quote, user_id: IDS.property },
      { ...quote, history: [] },
      { ...quote, property: { ...quote.property, sold_inventory: 1 } },
      { ...quote, room_type: { ...quote.room_type, total_inventory: 1 } },
      {
        ...quote,
        nightly_prices: [{ ...quote.nightly_prices[0], version: 1 }, quote.nightly_prices[1]],
      },
    ];
    const bookingCases = [
      { ...booking, user_id: IDS.property },
      { ...booking, held_inventory: 1 },
      { ...booking, history: [] },
      { ...booking, version: 1 },
      { ...booking, quote_id: IDS.quote },
    ];

    for (const value of quoteCases) {
      expectInvalid(() => assertQuoteResponse(value, IDS.roomType));
    }
    for (const value of bookingCases) {
      expectInvalid(() => assertBookingResponse(value, IDS.quote));
    }
    expectInvalid(() =>
      assertQuoteChangedDetails({
        previous_total_price_cents: quote.total_price_cents,
        replacement_quote: quote,
        version: 1,
      }),
    );
  });

  it("enforces date difference, contiguous nightly rows, counts, and safe totals", () => {
    const invalidQuotes = [
      { ...quote, checkout: "2026-08-04" },
      { ...quote, nights: 1 },
      { ...quote, nightly_prices: [quote.nightly_prices[0]] },
      {
        ...quote,
        nightly_prices: [
          quote.nightly_prices[0],
          { ...quote.nightly_prices[1], business_date: "2026-08-03" },
        ],
      },
      { ...quote, total_price_cents: quote.total_price_cents + 1 },
      {
        ...quote,
        nightly_prices: quote.nightly_prices.map((row) => ({
          ...row,
          sale_price_cents: Number.MAX_SAFE_INTEGER - 1,
          rack_price_cents: Number.MAX_SAFE_INTEGER - 1,
        })),
        total_price_cents: Number.MAX_SAFE_INTEGER - 1,
      },
    ];
    for (const value of invalidQuotes) {
      expectInvalid(() => assertQuoteResponse(value, IDS.roomType));
    }
    for (const value of [
      { ...booking, checkout: "2026-08-04" },
      { ...booking, nights: 1 },
      { ...booking, total_price_cents: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expectInvalid(() => assertBookingResponse(value, IDS.quote));
    }
  });

  it("supports leap-day stays and validates instants, currency, status, and booking number", () => {
    const leapQuote = {
      ...quote,
      checkin: "2028-02-29",
      checkout: "2028-03-01",
      nights: 1,
      nightly_prices: [{ ...quote.nightly_prices[0], business_date: "2028-02-29" }],
      total_price_cents: quote.nightly_prices[0].sale_price_cents,
    };
    expect(assertQuoteResponse(leapQuote, IDS.roomType)).toEqual(leapQuote);

    for (const value of [
      { ...quote, expires_at: "2026-07-30T02:05:00" },
      { ...quote, currency: "USD" },
      { ...quote, guests: 0 },
      {
        ...quote,
        nightly_prices: [
          { ...quote.nightly_prices[0], rack_price_cents: 1 },
          quote.nightly_prices[1],
        ],
      },
    ]) {
      expectInvalid(() => assertQuoteResponse(value, IDS.roomType));
    }
    for (const value of [
      { ...booking, status: "PAID" },
      { ...booking, booking_number: "SF1" },
      { ...booking, created_at: "2026-07-30T02:00:00" },
    ]) {
      expectInvalid(() => assertBookingResponse(value, IDS.quote));
    }
  });

  it("rejects hostile prototypes and accessors without invoking accessors", () => {
    const inherited = Object.assign(Object.create({ version: 1 }), quote);
    let reads = 0;
    const getter = { ...quote };
    Object.defineProperty(getter, "quote_id", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("private getter");
      },
    });
    const nestedGetter = { ...quote, property: { ...quote.property } };
    Object.defineProperty(nestedGetter.property, "name", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("private getter");
      },
    });

    expectInvalid(() => assertQuoteResponse(inherited, IDS.roomType));
    expectInvalid(() => assertQuoteResponse(getter, IDS.roomType));
    expectInvalid(() => assertQuoteResponse(nestedGetter, IDS.roomType));
    expect(reads).toBe(0);
  });
});

import { describe, expect, it } from "vitest";

import {
  bookingSummarySchema,
  createBookingRequestSchema,
  createQuoteRequestSchema,
  idempotencyKeySchema,
  quoteChangedDetailsSchema,
  quoteResponseDataSchema,
} from "../src/booking.js";

const quote = {
  quote_id: "30000000-0000-4000-8000-000000000001",
  property: {
    id: "10000000-0000-4000-8000-000000000101",
    name: "西湖云栖酒店",
  },
  room_type: {
    id: "20000000-0000-4000-8000-000000000001",
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
  booking_id: "40000000-0000-4000-8000-000000000001",
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

describe("booking contracts", () => {
  it("accepts a complete strict quote and rejects internal or unknown fields", () => {
    expect(quoteResponseDataSchema.parse(quote)).toEqual(quote);

    for (const extra of [
      { held_inventory: 1 },
      { total_inventory: 1 },
      { sold_inventory: 1 },
      { version: 1 },
      { user_id: quote.quote_id },
      { unexpected: true },
    ]) {
      expect(quoteResponseDataSchema.safeParse({ ...quote, ...extra }).success).toBe(false);
    }
  });

  it("accepts only quote request inputs and rejects client-controlled fields", () => {
    const request = {
      room_type_id: quote.room_type.id,
      checkin: quote.checkin,
      checkout: quote.checkout,
      guests: quote.guests,
    };
    expect(createQuoteRequestSchema.parse(request)).toEqual(request);

    for (const extra of [
      { total_price_cents: 1 },
      { status: "HELD" },
      { held_inventory: 1 },
      { unknown: true },
    ]) {
      expect(createQuoteRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    }
  });

  it("requires only quote_id to create a booking", () => {
    expect(createBookingRequestSchema.parse({ quote_id: quote.quote_id })).toEqual({
      quote_id: quote.quote_id,
    });
    expect(
      createBookingRequestSchema.safeParse({ quote_id: quote.quote_id, status: "HELD" }).success,
    ).toBe(false);
  });

  it("requires a complete replacement quote for QUOTE_CHANGED", () => {
    expect(
      quoteChangedDetailsSchema.parse({
        previous_total_price_cents: quote.total_price_cents,
        replacement_quote: quote,
      }),
    ).toEqual({
      previous_total_price_cents: quote.total_price_cents,
      replacement_quote: quote,
    });
    expect(quoteChangedDetailsSchema.safeParse({ replacement_quote: quote }).success).toBe(false);
    expect(
      quoteChangedDetailsSchema.safeParse({
        previous_total_price_cents: quote.total_price_cents,
        replacement_quote: { ...quote, held_inventory: 1 },
      }).success,
    ).toBe(false);
  });

  it("accepts a complete PENDING_PAYMENT booking summary and rejects private fields", () => {
    expect(bookingSummarySchema.parse(booking)).toEqual(booking);

    for (const extra of [
      { user_id: quote.quote_id },
      { held_inventory: 1 },
      { history: [] },
      { unexpected: true },
    ]) {
      expect(bookingSummarySchema.safeParse({ ...booking, ...extra }).success).toBe(false);
    }
  });

  it("rejects invalid identifiers, dates, guests, and idempotency keys", () => {
    expect(
      createQuoteRequestSchema.safeParse({ ...quote, room_type_id: "not-a-uuid" }).success,
    ).toBe(false);
    expect(
      createQuoteRequestSchema.safeParse({
        room_type_id: quote.room_type.id,
        checkin: "2026-02-30",
        checkout: quote.checkout,
        guests: 2,
      }).success,
    ).toBe(false);
    expect(
      createQuoteRequestSchema.safeParse({
        room_type_id: quote.room_type.id,
        checkin: quote.checkin,
        checkout: quote.checkout,
        guests: 11,
      }).success,
    ).toBe(false);
    expect(createBookingRequestSchema.safeParse({ quote_id: "not-a-uuid" }).success).toBe(false);
    expect(idempotencyKeySchema.safeParse("a".repeat(31)).success).toBe(false);
    expect(idempotencyKeySchema.safeParse("a".repeat(32) + "!").success).toBe(false);
    expect(idempotencyKeySchema.parse("a".repeat(80))).toBe("a".repeat(80));
  });

  it("requires nights and nightly prices to match an uninterrupted stay", () => {
    for (const invalidQuote of [
      { ...quote, nights: 1 },
      { ...quote, checkout: "2026-08-04" },
      { ...quote, nightly_prices: [quote.nightly_prices[0]] },
      {
        ...quote,
        nightly_prices: [
          { ...quote.nightly_prices[0], business_date: "2026-08-02" },
          quote.nightly_prices[1],
        ],
      },
      { ...quote, nightly_prices: [quote.nightly_prices[1], quote.nightly_prices[0]] },
      {
        ...quote,
        nights: 31,
        checkout: "2026-09-01",
        nightly_prices: Array.from({ length: 31 }, () => quote.nightly_prices[0]),
      },
    ]) {
      expect(quoteResponseDataSchema.safeParse(invalidQuote).success).toBe(false);
    }
  });

  it("requires valid safe money totals and nightly rack prices", () => {
    for (const invalidQuote of [
      { ...quote, total_price_cents: 1 },
      { ...quote, total_price_cents: -1 },
      { ...quote, total_price_cents: Number.MAX_SAFE_INTEGER + 1 },
      {
        ...quote,
        nightly_prices: [
          { ...quote.nightly_prices[0], sale_price_cents: -1 },
          quote.nightly_prices[1],
        ],
      },
      {
        ...quote,
        nightly_prices: [
          { ...quote.nightly_prices[0], rack_price_cents: 1 },
          quote.nightly_prices[1],
        ],
      },
      {
        ...quote,
        nightly_prices: [
          { ...quote.nightly_prices[0], sale_price_cents: Number.MAX_SAFE_INTEGER + 1 },
          quote.nightly_prices[1],
        ],
      },
    ]) {
      expect(quoteResponseDataSchema.safeParse(invalidQuote).success).toBe(false);
    }
  });

  it("rejects a quote whose individually safe nightly prices overflow their total", () => {
    const nightlySalePrice = Number.MAX_SAFE_INTEGER - 1;
    expect(
      quoteResponseDataSchema.safeParse({
        ...quote,
        nightly_prices: [
          {
            ...quote.nightly_prices[0],
            sale_price_cents: nightlySalePrice,
            rack_price_cents: nightlySalePrice,
          },
          {
            ...quote.nightly_prices[1],
            sale_price_cents: nightlySalePrice,
            rack_price_cents: nightlySalePrice,
          },
        ],
        total_price_cents: nightlySalePrice,
      }).success,
    ).toBe(false);
  });

  it("rejects negative and unsafe previous QUOTE_CHANGED totals", () => {
    for (const previous_total_price_cents of [-1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        quoteChangedDetailsSchema.safeParse({
          previous_total_price_cents,
          replacement_quote: quote,
        }).success,
      ).toBe(false);
    }
  });

  it("handles proleptic early calendar years, leap years, cross-year stays, and 30-night coverage", () => {
    expect(
      quoteResponseDataSchema.safeParse({
        ...quote,
        checkin: "0099-12-31",
        checkout: "0100-01-01",
        nights: 1,
        nightly_prices: [{ ...quote.nightly_prices[0], business_date: "0099-12-31" }],
        total_price_cents: 58800,
      }).success,
    ).toBe(true);
    expect(
      quoteResponseDataSchema.safeParse({
        ...quote,
        checkin: "2028-02-28",
        checkout: "2028-03-01",
        nightly_prices: [
          { ...quote.nightly_prices[0], business_date: "2028-02-28" },
          { ...quote.nightly_prices[1], business_date: "2028-02-29" },
        ],
      }).success,
    ).toBe(true);
    const thirtyNights = Array.from({ length: 30 }, (_, index) => ({
      ...quote.nightly_prices[0],
      business_date: `2026-12-${String(index + 1).padStart(2, "0")}`,
    }));
    expect(
      quoteResponseDataSchema.safeParse({
        ...quote,
        checkin: "2026-12-01",
        checkout: "2026-12-31",
        nights: 30,
        nightly_prices: thirtyNights,
        total_price_cents: 1_764_000,
      }).success,
    ).toBe(true);
  });

  it("requires timezone-aware valid instants and valid booking numbers", () => {
    for (const invalidQuote of [
      { ...quote, expires_at: "2026-07-30T02:05:00" },
      { ...quote, expires_at: "2026-02-30T02:05:00Z" },
    ]) {
      expect(quoteResponseDataSchema.safeParse(invalidQuote).success).toBe(false);
    }
    expect(
      quoteResponseDataSchema.parse({ ...quote, expires_at: "2026-07-30T10:05:00+08:00" }),
    ).toEqual({ ...quote, expires_at: "2026-07-30T10:05:00+08:00" });
    expect(
      bookingSummarySchema.safeParse({ ...booking, created_at: "2026-07-30T02:00:00" }).success,
    ).toBe(false);
    expect(
      bookingSummarySchema.safeParse({ ...booking, booking_number: "SF20260730A1B2C3D4E5F" })
        .success,
    ).toBe(false);
  });
});

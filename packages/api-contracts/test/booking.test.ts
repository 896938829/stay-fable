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
  quote_id: quote.quote_id,
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

const parseWithPrototypeField = (value: unknown) =>
  JSON.parse(`{"__proto__":true,${JSON.stringify(value).slice(1)}`) as Record<string, unknown>;

const parseJsonRecord = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

const isUnknownArray = (value: unknown): value is unknown[] => Array.isArray(value);

const createNullRecord = () => Object.setPrototypeOf({}, null) as Record<string, unknown>;

const hasPrototypeFieldAtAnyDepth = (value: unknown): boolean => {
  if (value === null || typeof value !== "object") {
    return false;
  }
  return (
    Object.hasOwn(value, "__proto__") || Object.values(value).some(hasPrototypeFieldAtAnyDepth)
  );
};

const toNullPrototype = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(toNullPrototype);
  }
  if (value !== null && typeof value === "object") {
    const result = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(value)) {
      result[key] = toNullPrototype(entry);
    }
    return result;
  }
  return value;
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

  it("accepts table-driven proleptic Gregorian stay boundaries", () => {
    const firstNight = quote.nightly_prices[0]!;
    const secondNight = quote.nightly_prices[1]!;
    const oneNight = (business_date: string) => [{ ...firstNight, business_date }];
    const thirtyNights = Array.from({ length: 30 }, (_, index) => ({
      ...firstNight,
      business_date: `2026-12-${String(index + 2).padStart(2, "0")}`,
    }));
    const cases = [
      {
        checkin: "0001-01-01",
        checkout: "0001-01-02",
        nights: 1,
        nightly_prices: oneNight("0001-01-01"),
      },
      {
        checkin: "0099-12-31",
        checkout: "0100-01-01",
        nights: 1,
        nightly_prices: oneNight("0099-12-31"),
      },
      {
        checkin: "0100-02-28",
        checkout: "0100-03-01",
        nights: 1,
        nightly_prices: oneNight("0100-02-28"),
      },
      {
        checkin: "0400-02-28",
        checkout: "0400-03-01",
        nights: 2,
        nightly_prices: [
          { ...firstNight, business_date: "0400-02-28" },
          { ...secondNight, business_date: "0400-02-29" },
        ],
      },
      {
        checkin: "2026-01-31",
        checkout: "2026-02-01",
        nights: 1,
        nightly_prices: oneNight("2026-01-31"),
      },
      {
        checkin: "2026-12-31",
        checkout: "2027-01-01",
        nights: 1,
        nightly_prices: oneNight("2026-12-31"),
      },
      { checkin: "2026-12-02", checkout: "2027-01-01", nights: 30, nightly_prices: thirtyNights },
      {
        checkin: "9999-12-30",
        checkout: "9999-12-31",
        nights: 1,
        nightly_prices: oneNight("9999-12-30"),
      },
    ];

    for (const stay of cases) {
      expect(
        quoteResponseDataSchema.safeParse({
          ...quote,
          ...stay,
          total_price_cents: stay.nightly_prices.reduce(
            (total, nightlyPrice) => total + nightlyPrice.sale_price_cents,
            0,
          ),
        }).success,
      ).toBe(true);
    }
    expect(
      quoteResponseDataSchema.safeParse({
        ...quote,
        checkin: "9999-12-31",
        checkout: "10000-01-01",
        nights: 1,
        nightly_prices: oneNight("9999-12-31"),
        total_price_cents: 58800,
      }).success,
    ).toBe(false);
  });

  it("rejects JSON own __proto__ fields at every object boundary", () => {
    const quoteRequest = {
      room_type_id: quote.room_type.id,
      checkin: quote.checkin,
      checkout: quote.checkout,
      guests: quote.guests,
    };
    const quoteWithPrototypeProperty = parseJsonRecord(quote);
    quoteWithPrototypeProperty.property = parseWithPrototypeField(quote.property);
    const quoteWithPrototypeRoomType = parseJsonRecord(quote);
    quoteWithPrototypeRoomType.room_type = parseWithPrototypeField(quote.room_type);
    const quoteWithPrototypeNightly = parseJsonRecord(quote);
    const nightlyPrices = quoteWithPrototypeNightly.nightly_prices;
    if (!Array.isArray(nightlyPrices)) {
      throw new Error("Quote fixture must contain nightly prices");
    }
    nightlyPrices[0] = parseWithPrototypeField(quote.nightly_prices[0]);
    const quoteChangedWithPrototypeReplacement = {
      previous_total_price_cents: quote.total_price_cents,
      replacement_quote: parseWithPrototypeField(quote),
    };

    const cases = [
      {
        payload: parseWithPrototypeField(quoteRequest),
        parse: (payload: unknown) => createQuoteRequestSchema.safeParse(payload),
      },
      {
        payload: parseWithPrototypeField({ quote_id: quote.quote_id }),
        parse: (payload: unknown) => createBookingRequestSchema.safeParse(payload),
      },
      {
        payload: parseWithPrototypeField(quote),
        parse: (payload: unknown) => quoteResponseDataSchema.safeParse(payload),
      },
      {
        payload: quoteWithPrototypeProperty,
        parse: (payload: unknown) => quoteResponseDataSchema.safeParse(payload),
      },
      {
        payload: quoteWithPrototypeRoomType,
        parse: (payload: unknown) => quoteResponseDataSchema.safeParse(payload),
      },
      {
        payload: quoteWithPrototypeNightly,
        parse: (payload: unknown) => quoteResponseDataSchema.safeParse(payload),
      },
      {
        payload: parseWithPrototypeField(booking),
        parse: (payload: unknown) => bookingSummarySchema.safeParse(payload),
      },
      {
        payload: parseWithPrototypeField(quoteChangedWithPrototypeReplacement),
        parse: (payload: unknown) => quoteChangedDetailsSchema.safeParse(payload),
      },
      {
        payload: quoteChangedWithPrototypeReplacement,
        parse: (payload: unknown) => quoteChangedDetailsSchema.safeParse(payload),
      },
    ];

    for (const { payload, parse } of cases) {
      expect(hasPrototypeFieldAtAnyDepth(payload)).toBe(true);
      expect(parse(payload).success).toBe(false);
    }
  });

  it("preserves normal and null-prototype JSON-like payload behavior while strict rejects constructor and prototype", () => {
    expect(quoteResponseDataSchema.safeParse(quote).success).toBe(true);
    expect(quoteResponseDataSchema.safeParse(toNullPrototype(quote)).success).toBe(true);
    for (const field of ["constructor", "prototype"]) {
      expect(quoteResponseDataSchema.safeParse({ ...quote, [field]: true }).success).toBe(false);
    }
  });

  it("rejects an own __proto__ getter without invoking it or throwing outside Zod", () => {
    const payload = Object.create(null) as Record<string, unknown>;
    Object.assign(payload, quote);
    let getterWasInvoked = false;
    Object.defineProperty(payload, "__proto__", {
      enumerable: true,
      get: () => {
        getterWasInvoked = true;
        throw new Error("must not execute getter");
      },
    });

    expect(() => quoteResponseDataSchema.safeParse(payload)).not.toThrow();
    expect(quoteResponseDataSchema.safeParse(payload).success).toBe(false);
    expect(getterWasInvoked).toBe(false);
  });

  it("clones root get-trap proxies without invoking traps and fails closed for used reflection traps", () => {
    const quoteRequest = {
      room_type_id: quote.room_type.id,
      checkin: quote.checkin,
      checkout: quote.checkout,
      guests: quote.guests,
    };
    const roots = [
      { input: quoteRequest, parse: (input: unknown) => createQuoteRequestSchema.safeParse(input) },
      {
        input: { quote_id: quote.quote_id },
        parse: (input: unknown) => createBookingRequestSchema.safeParse(input),
      },
      { input: quote, parse: (input: unknown) => quoteResponseDataSchema.safeParse(input) },
      { input: booking, parse: (input: unknown) => bookingSummarySchema.safeParse(input) },
      {
        input: { previous_total_price_cents: quote.total_price_cents, replacement_quote: quote },
        parse: (input: unknown) => quoteChangedDetailsSchema.safeParse(input),
      },
    ];

    for (const { input, parse } of roots) {
      const before = JSON.stringify(input);
      let getTrapCalls = 0;
      const getTrapInput = new Proxy(input, {
        get: () => {
          getTrapCalls += 1;
          throw new Error("root get trap");
        },
      });
      let getTrapResult: { success: boolean; data?: unknown } | undefined;
      expect(() => {
        getTrapResult = parse(getTrapInput);
      }).not.toThrow();
      expect(getTrapResult?.success).toBe(true);
      expect(getTrapResult?.data).not.toBe(input);
      expect(getTrapCalls).toBe(0);
      expect(JSON.stringify(input)).toBe(before);

      for (const handler of [
        {
          ownKeys: () => {
            throw new Error("root ownKeys trap");
          },
        },
        {
          getOwnPropertyDescriptor: () => {
            throw new Error("root descriptor trap");
          },
        },
      ]) {
        const hostileInput = new Proxy(input, handler);
        let result: { success: boolean; data?: unknown } | undefined;
        expect(() => {
          result = parse(hostileInput);
        }).not.toThrow();
        expect(result?.success).toBe(false);
      }
    }
  });

  it("clones nested get-trap proxies and fails closed for nested reflection traps, accessors, and cycles", () => {
    const withNestedProxy = (
      field: "property" | "room_type" | "nightly_prices",
      handler: ProxyHandler<object>,
    ) => {
      const payload = parseJsonRecord(quote);
      if (field === "nightly_prices") {
        const nightlyPrices = payload.nightly_prices;
        if (!Array.isArray(nightlyPrices)) {
          throw new Error("Quote fixture must contain nightly prices");
        }
        payload.nightly_prices = new Proxy(nightlyPrices, handler);
      } else {
        const nestedValue = payload[field];
        if (nestedValue === null || typeof nestedValue !== "object") {
          throw new Error("Quote fixture must contain nested object");
        }
        payload[field] = new Proxy(nestedValue, handler);
      }
      return payload;
    };
    const withNightlyItemProxy = (handler: ProxyHandler<object>) => {
      const payload = parseJsonRecord(quote);
      const nightlyPrices = payload.nightly_prices;
      if (!isUnknownArray(nightlyPrices)) {
        throw new Error("Quote fixture must contain nightly price array");
      }
      const firstNightlyPrice = nightlyPrices[0];
      if (firstNightlyPrice === null || typeof firstNightlyPrice !== "object") {
        throw new Error("Quote fixture must contain nightly price object");
      }
      nightlyPrices[0] = new Proxy(firstNightlyPrice, handler);
      return payload;
    };
    for (const createInput of [
      (handler: ProxyHandler<object>) => withNestedProxy("property", handler),
      (handler: ProxyHandler<object>) => withNestedProxy("room_type", handler),
      (handler: ProxyHandler<object>) => withNestedProxy("nightly_prices", handler),
      withNightlyItemProxy,
    ]) {
      let getTrapCalls = 0;
      const getTrapInput = createInput({
        get: () => {
          getTrapCalls += 1;
          throw new Error("nested get trap");
        },
      });
      let getTrapResult: { success: boolean; data?: unknown } | undefined;
      expect(() => {
        getTrapResult = quoteResponseDataSchema.safeParse(getTrapInput);
      }).not.toThrow();
      expect(getTrapResult?.success).toBe(true);
      expect(getTrapCalls).toBe(0);

      for (const handler of [
        {
          ownKeys: () => {
            throw new Error("nested ownKeys trap");
          },
        },
        {
          getOwnPropertyDescriptor: () => {
            throw new Error("nested descriptor trap");
          },
        },
      ]) {
        const hostileInput = createInput(handler);
        let result: { success: boolean; data?: unknown } | undefined;
        expect(() => {
          result = quoteResponseDataSchema.safeParse(hostileInput);
        }).not.toThrow();
        expect(result?.success).toBe(false);
      }
    }

    const accessorInput = parseJsonRecord(quote);
    let accessorWasInvoked = false;
    Object.defineProperty(accessorInput, "quote_id", {
      enumerable: true,
      get: () => {
        accessorWasInvoked = true;
        throw new Error("must not execute accessor");
      },
    });
    expect(() => quoteResponseDataSchema.safeParse(accessorInput)).not.toThrow();
    expect(quoteResponseDataSchema.safeParse(accessorInput).success).toBe(false);
    expect(accessorWasInvoked).toBe(false);

    const cyclicInput = parseJsonRecord(quote);
    cyclicInput.self = cyclicInput;
    expect(() => quoteResponseDataSchema.safeParse(cyclicInput)).not.toThrow();
    expect(quoteResponseDataSchema.safeParse(cyclicInput).success).toBe(false);
  });

  it("fails closed for sparse arrays and bounded snapshot limits", () => {
    const sparseArrayInput = parseJsonRecord(quote);
    const sparseNightlyPrices: unknown[] = [];
    sparseNightlyPrices.length = 2;
    sparseNightlyPrices[0] = quote.nightly_prices[0];
    sparseArrayInput.nightly_prices = sparseNightlyPrices;

    const tooManyKeysInput = parseJsonRecord(quote);
    for (let index = 0; index <= 100; index += 1) {
      tooManyKeysInput[`unknown_${index}`] = index;
    }

    const tooDeepInput = parseJsonRecord(quote);
    const deepValue = createNullRecord();
    let currentDeepValue = deepValue;
    for (let index = 0; index <= 16; index += 1) {
      const nextValue = createNullRecord();
      currentDeepValue.nested = nextValue;
      currentDeepValue = nextValue;
    }
    tooDeepInput.unknown = deepValue;

    const tooManyNodesInput = parseJsonRecord(quote);
    const createNodeTree = (depth: number): Record<string, unknown> => {
      const result = createNullRecord();
      if (depth > 0) {
        for (let index = 0; index < 10; index += 1) {
          result[`child_${index}`] = createNodeTree(depth - 1);
        }
      }
      return result;
    };
    tooManyNodesInput.unknown = createNodeTree(3);

    for (const input of [sparseArrayInput, tooManyKeysInput, tooDeepInput, tooManyNodesInput]) {
      expect(() => quoteResponseDataSchema.safeParse(input)).not.toThrow();
      expect(quoteResponseDataSchema.safeParse(input).success).toBe(false);
    }
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

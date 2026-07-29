/* eslint-disable @typescript-eslint/unbound-method */
import { describe, expect, it, vi } from "vitest";

import { BusinessException } from "../src/common/http/business.exception.js";
import type { Clock } from "../src/common/clock/clock.js";
import type { WriteRateLimitService } from "../src/common/rate-limit/write-rate-limit.service.js";
import {
  QuoteRepository,
  type PersistQuoteInput,
  type PersistedQuote,
  type QuoteDatabase,
  type QuoteInputLookup,
  type QuoteRange,
} from "../src/pricing/quote.repository.js";
import { PricingModule } from "../src/pricing/pricing.module.js";
import { QuotesService } from "../src/pricing/quotes.service.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const PROPERTY_ID = "20000000-0000-4000-8000-000000000001";
const ROOM_TYPE_ID = "30000000-0000-4000-8000-000000000001";
const QUOTE_ID = "40000000-0000-4000-8000-000000000001";
const CAPTURED_AT = new Date("2026-07-30T02:00:00.000Z");
const EXPIRES_AT = new Date("2026-07-30T02:05:00.000Z");

const availableLookup = (): Extract<QuoteInputLookup, { status: "AVAILABLE" }> => ({
  status: "AVAILABLE",
  property: { id: PROPERTY_ID, name: "西湖云栖酒店" },
  roomType: {
    id: ROOM_TYPE_ID,
    name: "舒适大床房",
    coverUrl: "/images/catalog/room.jpg",
    maxGuests: 2,
    bookingPolicy: "入住前一天18:00前可免费取消。",
  },
  nightlyPrices: [
    {
      businessDate: "2026-07-31",
      salePriceCents: 42_800,
      rackPriceCents: 48_800,
      available: true,
    },
    {
      businessDate: "2026-08-01",
      salePriceCents: 43_800,
      rackPriceCents: 49_800,
      available: true,
    },
  ],
});

const createRepository = () => ({
  findQuoteInput: vi.fn<(roomTypeId: string, range: QuoteRange) => Promise<QuoteInputLookup>>(() =>
    Promise.resolve(availableLookup()),
  ),
  createQuote: vi.fn<(input: PersistQuoteInput) => Promise<PersistedQuote>>(() =>
    Promise.resolve({
      id: QUOTE_ID,
      createdAt: CAPTURED_AT,
      expiresAt: EXPIRES_AT,
    }),
  ),
});

const createRateLimit = () => ({
  checkQuotes: vi.fn(() => Promise.resolve()),
});

const request = {
  room_type_id: ROOM_TYPE_ID,
  checkin: "2026-07-31",
  checkout: "2026-08-02",
  guests: 2,
};

const captureBusinessError = async (operation: Promise<unknown>): Promise<BusinessException> => {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(BusinessException);
    return error as BusinessException;
  }
  throw new Error("Expected BusinessException");
};

const expectBusinessError = async (
  operation: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> => {
  const error = await captureBusinessError(operation);
  expect(error.getStatus()).toBe(status);
  expect(error.code).toBe(code);
};

describe("QuotesService", () => {
  it("persists an exact five-minute quote snapshot and returns the strict shared response", async () => {
    const repository = createRepository();
    const rateLimit = createRateLimit();
    const clock: Clock = { now: vi.fn(() => CAPTURED_AT) };
    const service = new QuotesService(
      repository as unknown as QuoteRepository,
      rateLimit as unknown as WriteRateLimitService,
      clock,
    );

    await expect(
      service.create(USER_ID, {
        ...request,
      }),
    ).resolves.toEqual({
      quote_id: QUOTE_ID,
      property: { id: PROPERTY_ID, name: "西湖云栖酒店" },
      room_type: {
        id: ROOM_TYPE_ID,
        name: "舒适大床房",
        cover_url: "/images/catalog/room.jpg",
      },
      checkin: "2026-07-31",
      checkout: "2026-08-02",
      nights: 2,
      guests: 2,
      nightly_prices: [
        {
          business_date: "2026-07-31",
          sale_price_cents: 42_800,
          rack_price_cents: 48_800,
          currency: "CNY",
        },
        {
          business_date: "2026-08-01",
          sale_price_cents: 43_800,
          rack_price_cents: 49_800,
          currency: "CNY",
        },
      ],
      total_price_cents: 86_600,
      currency: "CNY",
      booking_policy: "入住前一天18:00前可免费取消。",
      expires_at: "2026-07-30T02:05:00.000Z",
    });

    expect(clock.now).toHaveBeenCalledTimes(1);
    expect(rateLimit.checkQuotes).toHaveBeenCalledWith(USER_ID);
    expect(repository.findQuoteInput).toHaveBeenCalledWith(ROOM_TYPE_ID, {
      checkin: "2026-07-31",
      checkout: "2026-08-02",
      nights: 2,
      guests: 2,
    });
    expect(repository.createQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        propertyId: PROPERTY_ID,
        roomTypeId: ROOM_TYPE_ID,
        checkin: "2026-07-31",
        checkout: "2026-08-02",
        guests: 2,
        totalPriceCents: 86_600,
        currency: "CNY",
        propertySnapshot: { id: PROPERTY_ID, name: "西湖云栖酒店" },
        roomTypeSnapshot: {
          id: ROOM_TYPE_ID,
          name: "舒适大床房",
          cover_url: "/images/catalog/room.jpg",
        },
        nightlyPrices: [
          {
            business_date: "2026-07-31",
            sale_price_cents: 42_800,
            rack_price_cents: 48_800,
            currency: "CNY",
          },
          {
            business_date: "2026-08-01",
            sale_price_cents: 43_800,
            rack_price_cents: 49_800,
            currency: "CNY",
          },
        ],
        bookingPolicySnapshot: "入住前一天18:00前可免费取消。",
        expiresAt: EXPIRES_AT,
      }),
    );
    expect(repository.createQuote.mock.calls[0]?.[0].fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const response = await service.create(USER_ID, request);
    expect(response).not.toHaveProperty("total_inventory");
    expect(response).not.toHaveProperty("held_inventory");
    expect(response).not.toHaveProperty("sold_inventory");
    expect(response).not.toHaveProperty("version");
  });

  it.each([
    ["NOT_AVAILABLE", { status: "NOT_AVAILABLE" } as const, 404, "ROOM_NOT_AVAILABLE"],
    ["CAPACITY_EXCEEDED", { status: "CAPACITY_EXCEEDED" } as const, 422, "ROOM_CAPACITY_EXCEEDED"],
  ])("maps %s lookup without persisting", async (_name, lookup, status, code) => {
    const repository = createRepository();
    repository.findQuoteInput.mockResolvedValue(lookup);
    const service = new QuotesService(
      repository as unknown as QuoteRepository,
      createRateLimit() as unknown as WriteRateLimitService,
      { now: () => CAPTURED_AT },
    );

    await expectBusinessError(service.create(USER_ID, request), status, code);
    expect(repository.createQuote).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a missing night",
      { ...availableLookup(), nightlyPrices: [availableLookup().nightlyPrices[0]!] },
    ],
    [
      "a sold-out night",
      {
        ...availableLookup(),
        nightlyPrices: [
          availableLookup().nightlyPrices[0]!,
          { ...availableLookup().nightlyPrices[1]!, available: false },
        ],
      },
    ],
  ])("maps %s to ROOM_NOT_AVAILABLE", async (_name, lookup) => {
    const repository = createRepository();
    repository.findQuoteInput.mockResolvedValue(lookup);
    const service = new QuotesService(
      repository as unknown as QuoteRepository,
      createRateLimit() as unknown as WriteRateLimitService,
      { now: () => CAPTURED_AT },
    );

    await expectBusinessError(service.create(USER_ID, request), 404, "ROOM_NOT_AVAILABLE");
    expect(repository.createQuote).not.toHaveBeenCalled();
  });

  it("supports an exact thirty-night quote and sums every night safely", async () => {
    const repository = createRepository();
    const nightlyPrices = Array.from({ length: 30 }, (_, index) => ({
      businessDate: new Date(Date.UTC(2026, 6, 31 + index)).toISOString().slice(0, 10),
      salePriceCents: 100 + index,
      rackPriceCents: 200 + index,
      available: true,
    }));
    repository.findQuoteInput.mockResolvedValue({
      ...availableLookup(),
      nightlyPrices,
    });
    const service = new QuotesService(
      repository as unknown as QuoteRepository,
      createRateLimit() as unknown as WriteRateLimitService,
      { now: () => CAPTURED_AT },
    );

    const response = await service.create(USER_ID, {
      ...request,
      checkout: "2026-08-30",
    });

    expect(response.nights).toBe(30);
    expect(response.nightly_prices).toHaveLength(30);
    expect(response.total_price_cents).toBe(3_435);
  });

  it("maps a safe-integer total overflow to BOOKING_SERVICE_UNAVAILABLE", async () => {
    const repository = createRepository();
    const amount = Number.MAX_SAFE_INTEGER - 1;
    repository.findQuoteInput.mockResolvedValue({
      ...availableLookup(),
      nightlyPrices: availableLookup().nightlyPrices.map((night) => ({
        ...night,
        salePriceCents: amount,
        rackPriceCents: amount,
      })),
    });
    const service = new QuotesService(
      repository as unknown as QuoteRepository,
      createRateLimit() as unknown as WriteRateLimitService,
      { now: () => CAPTURED_AT },
    );

    await expectBusinessError(service.create(USER_ID, request), 503, "BOOKING_SERVICE_UNAVAILABLE");
    expect(repository.createQuote).not.toHaveBeenCalled();
  });

  it("maps a PostgreSQL int4 total overflow to BOOKING_SERVICE_UNAVAILABLE", async () => {
    const repository = createRepository();
    repository.findQuoteInput.mockResolvedValue({
      ...availableLookup(),
      nightlyPrices: availableLookup().nightlyPrices.map((night) => ({
        ...night,
        salePriceCents: 1_500_000_000,
        rackPriceCents: 1_500_000_000,
      })),
    });
    const service = new QuotesService(
      repository as unknown as QuoteRepository,
      createRateLimit() as unknown as WriteRateLimitService,
      { now: () => CAPTURED_AT },
    );

    await expectBusinessError(service.create(USER_ID, request), 503, "BOOKING_SERVICE_UNAVAILABLE");
    expect(repository.createQuote).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid", { now: vi.fn(() => new Date(Number.NaN)) }],
    [
      "throwing",
      {
        now: vi.fn(() => {
          throw new Error("clock secret");
        }),
      },
    ],
  ])("maps a %s clock to BOOKING_SERVICE_UNAVAILABLE", async (_name, clock) => {
    const repository = createRepository();
    const service = new QuotesService(
      repository as unknown as QuoteRepository,
      createRateLimit() as unknown as WriteRateLimitService,
      clock,
    );

    const error = await captureBusinessError(service.create(USER_ID, request));
    expect(error.getStatus()).toBe(503);
    expect(error.code).toBe("BOOKING_SERVICE_UNAVAILABLE");
    expect(error.message).not.toContain("secret");
    expect(repository.findQuoteInput).not.toHaveBeenCalled();
  });

  it.each([
    ["lookup", "findQuoteInput"],
    ["create", "createQuote"],
  ] as const)("does not leak a repository %s failure", async (_name, method) => {
    const repository = createRepository();
    repository[method].mockRejectedValue(new Error("database-secret"));
    const service = new QuotesService(
      repository as unknown as QuoteRepository,
      createRateLimit() as unknown as WriteRateLimitService,
      { now: () => CAPTURED_AT },
    );

    const error = await captureBusinessError(service.create(USER_ID, request));
    expect(error.getStatus()).toBe(503);
    expect(error.code).toBe("BOOKING_SERVICE_UNAVAILABLE");
    expect(error.message).not.toContain("database-secret");
  });

  it.each([
    ["lookup", "findQuoteInput"],
    ["create", "createQuote"],
  ] as const)(
    "sanitizes a repository %s BusinessException instead of trusting its public shape",
    async (_name, method) => {
      const repository = createRepository();
      const repositoryError = new BusinessException(
        418,
        "INTERNAL_SECRET",
        "repository-secret-message",
        { credential: "repository-secret-details" },
      );
      repository[method].mockRejectedValue(repositoryError);
      const service = new QuotesService(
        repository as unknown as QuoteRepository,
        createRateLimit() as unknown as WriteRateLimitService,
        { now: () => CAPTURED_AT },
      );

      const error = await captureBusinessError(service.create(USER_ID, request));
      expect(error).not.toBe(repositoryError);
      expect(error.getStatus()).toBe(503);
      expect(error.code).toBe("BOOKING_SERVICE_UNAVAILABLE");
      expect(error.message).toBe("预订服务暂时不可用，请稍后重试");
      expect(error.details).toBeUndefined();
      expect(JSON.stringify(error)).not.toContain("repository-secret");
    },
  );

  it.each([
    new BusinessException(429, "RATE_LIMITED", "操作过于频繁，请稍后重试"),
    new BusinessException(503, "BOOKING_SERVICE_UNAVAILABLE", "预订服务暂时不可用，请稍后重试"),
  ])("preserves rate-limit BusinessException before database access", async (rateLimitError) => {
    const repository = createRepository();
    const rateLimit = createRateLimit();
    rateLimit.checkQuotes.mockRejectedValue(rateLimitError);
    const service = new QuotesService(
      repository as unknown as QuoteRepository,
      rateLimit as unknown as WriteRateLimitService,
      { now: () => CAPTURED_AT },
    );

    await expect(service.create(USER_ID, request)).rejects.toBe(rateLimitError);
    expect(repository.findQuoteInput).not.toHaveBeenCalled();
    expect(repository.createQuote).not.toHaveBeenCalled();
  });

  it.each([
    { ...request, unknown: true },
    { ...request, room_type_id: "not-a-uuid" },
    { ...request, checkin: "2026-02-30" },
    { ...request, checkout: "2026-07-31" },
    { ...request, guests: 0 },
  ])("rejects an invalid shared request before rate limiting or database access", async (input) => {
    const repository = createRepository();
    const rateLimit = createRateLimit();
    const service = new QuotesService(
      repository as unknown as QuoteRepository,
      rateLimit as unknown as WriteRateLimitService,
      { now: () => CAPTURED_AT },
    );

    const error = await captureBusinessError(service.create(USER_ID, input));
    expect(error.getStatus()).toBe(400);
    expect(error.code).toBe("QUOTE_REQUEST_INVALID");
    expect(error.message).toBe("报价请求无效，请检查入住信息");
    expect(rateLimit.checkQuotes).not.toHaveBeenCalled();
    expect(repository.findQuoteInput).not.toHaveBeenCalled();
  });

  it("maps a catalog date failure to QUOTE_REQUEST_INVALID with one captured clock read", async () => {
    const repository = createRepository();
    const rateLimit = createRateLimit();
    const clock: Clock = { now: vi.fn(() => CAPTURED_AT) };
    const service = new QuotesService(
      repository as unknown as QuoteRepository,
      rateLimit as unknown as WriteRateLimitService,
      clock,
    );

    await expectBusinessError(
      service.create(USER_ID, { ...request, checkin: "2026-07-29", checkout: "2026-07-31" }),
      400,
      "QUOTE_REQUEST_INVALID",
    );
    expect(clock.now).toHaveBeenCalledTimes(1);
    expect(repository.findQuoteInput).not.toHaveBeenCalled();
  });

  it("treats an invalid authenticated user id as an internal invariant failure", async () => {
    const repository = createRepository();
    const rateLimit = createRateLimit();
    const service = new QuotesService(
      repository as unknown as QuoteRepository,
      rateLimit as unknown as WriteRateLimitService,
      { now: () => CAPTURED_AT },
    );

    await expectBusinessError(
      service.create("not-a-user-id", request),
      503,
      "BOOKING_SERVICE_UNAVAILABLE",
    );
    expect(rateLimit.checkQuotes).not.toHaveBeenCalled();
    expect(repository.findQuoteInput).not.toHaveBeenCalled();
  });

  it("fingerprints only canonical display, stay, policy, guest, and nightly fields", async () => {
    const firstRepository = createRepository();
    const secondRepository = createRepository();
    const first = new QuotesService(
      firstRepository as unknown as QuoteRepository,
      createRateLimit() as unknown as WriteRateLimitService,
      { now: () => CAPTURED_AT },
    );
    const second = new QuotesService(
      secondRepository as unknown as QuoteRepository,
      createRateLimit() as unknown as WriteRateLimitService,
      { now: () => CAPTURED_AT },
    );

    await first.create(USER_ID, request);
    await second.create(USER_ID, request);

    expect(firstRepository.createQuote.mock.calls[0]?.[0].fingerprint).toBe(
      secondRepository.createQuote.mock.calls[0]?.[0].fingerprint,
    );
    expect(firstRepository.createQuote.mock.calls[0]?.[0].fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    {
      id: "not-a-uuid",
      createdAt: CAPTURED_AT,
      expiresAt: EXPIRES_AT,
    },
    {
      id: QUOTE_ID,
      createdAt: CAPTURED_AT,
      expiresAt: new Date(EXPIRES_AT.getTime() + 1),
    },
    {
      id: QUOTE_ID,
      createdAt: new Date(Number.NaN),
      expiresAt: EXPIRES_AT,
    },
  ])("rejects an invalid persisted quote record", async (record) => {
    const repository = createRepository();
    repository.createQuote.mockResolvedValue(record);
    const service = new QuotesService(
      repository as unknown as QuoteRepository,
      createRateLimit() as unknown as WriteRateLimitService,
      { now: () => CAPTURED_AT },
    );

    await expectBusinessError(service.create(USER_ID, request), 503, "BOOKING_SERVICE_UNAVAILABLE");
  });
});

const databaseBaseRow = {
  propertyId: PROPERTY_ID,
  propertyName: "西湖云栖酒店",
  roomTypeId: ROOM_TYPE_ID,
  roomTypeName: "舒适大床房",
  coverUrl: "/images/catalog/room.jpg",
  maxGuests: 2,
  bookingPolicy: "入住前一天18:00前可免费取消。",
};

const databaseNightlyRows = [
  {
    businessDate: "2026-07-31",
    salePriceCents: 42_800,
    rackPriceCents: 48_800,
    totalInventory: 3,
    heldInventory: 1,
    soldInventory: 1,
  },
  {
    businessDate: "2026-08-01",
    salePriceCents: 43_800,
    rackPriceCents: 49_800,
    totalInventory: 3,
    heldInventory: 0,
    soldInventory: 0,
  },
];

const createQuoteDatabase = (responses: unknown[] = [[databaseBaseRow], databaseNightlyRows]) => {
  let index = 0;
  return {
    $queryRaw: vi.fn((query: unknown) => {
      void query;
      return Promise.resolve(responses[index++]);
    }),
  };
};

const persistInput = (): PersistQuoteInput => ({
  userId: USER_ID,
  propertyId: PROPERTY_ID,
  roomTypeId: ROOM_TYPE_ID,
  checkin: "2026-07-31",
  checkout: "2026-08-02",
  guests: 2,
  propertySnapshot: { id: PROPERTY_ID, name: "西湖云栖酒店" },
  roomTypeSnapshot: {
    id: ROOM_TYPE_ID,
    name: "舒适大床房",
    cover_url: "/images/catalog/room.jpg",
  },
  nightlyPrices: [
    {
      business_date: "2026-07-31",
      sale_price_cents: 42_800,
      rack_price_cents: 48_800,
      currency: "CNY",
    },
    {
      business_date: "2026-08-01",
      sale_price_cents: 43_800,
      rack_price_cents: 49_800,
      currency: "CNY",
    },
  ],
  bookingPolicySnapshot: "入住前一天18:00前可免费取消。",
  totalPriceCents: 86_600,
  currency: "CNY",
  fingerprint: "a".repeat(64),
  expiresAt: EXPIRES_AT,
});

const copyWithNullPrototype = <T extends object>(source: T): T =>
  Object.assign(Object.create(null) as Record<PropertyKey, unknown>, source);

describe("QuoteRepository", () => {
  it("uses parameterized status-gated SQL and maps availability without exposing inventory", async () => {
    const database = createQuoteDatabase();
    const repository = new QuoteRepository(database as unknown as QuoteDatabase);

    const result = await repository.findQuoteInput(ROOM_TYPE_ID, {
      checkin: "2026-07-31",
      checkout: "2026-08-02",
      nights: 2,
      guests: 2,
    });
    expect(result).toEqual(availableLookup());

    expect(database.$queryRaw).toHaveBeenCalledTimes(2);
    const baseQuery = database.$queryRaw.mock.calls[0]?.[0] as {
      sql: string;
      values: unknown[];
    };
    const nightlyQuery = database.$queryRaw.mock.calls[1]?.[0] as {
      sql: string;
      values: unknown[];
    };
    expect(baseQuery.sql).toContain(`property."status" = 'OPEN'`);
    expect(baseQuery.sql).toContain(`room."status" = 'ON_SALE'`);
    expect(baseQuery.sql).not.toContain(ROOM_TYPE_ID);
    expect(baseQuery.values).toContain(ROOM_TYPE_ID);
    expect(nightlyQuery.sql).toContain("generate_series");
    expect(nightlyQuery.sql).toContain('LEFT JOIN "daily_price"');
    expect(nightlyQuery.sql).toContain('LEFT JOIN "daily_inventory"');
    expect(nightlyQuery.sql).toContain("ORDER BY requested.business_date ASC");
    expect(nightlyQuery.sql).not.toContain("2026-07-31");
    expect(nightlyQuery.values).toEqual(
      expect.arrayContaining([ROOM_TYPE_ID, "2026-07-31", "2026-08-02"]),
    );
    if (result.status === "AVAILABLE") {
      expect(result.nightlyPrices[0]).not.toHaveProperty("totalInventory");
      expect(result.nightlyPrices[0]).not.toHaveProperty("heldInventory");
      expect(result.nightlyPrices[0]).not.toHaveProperty("soldInventory");
    }
  });

  it("returns NOT_AVAILABLE for absent, closed, or off-sale rooms without a nightly query", async () => {
    const database = createQuoteDatabase([[]]);
    const repository = new QuoteRepository(database as unknown as QuoteDatabase);

    await expect(
      repository.findQuoteInput(ROOM_TYPE_ID, {
        checkin: "2026-07-31",
        checkout: "2026-08-02",
        nights: 2,
        guests: 2,
      }),
    ).resolves.toEqual({ status: "NOT_AVAILABLE" });
    expect(database.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("returns CAPACITY_EXCEEDED before querying prices", async () => {
    const database = createQuoteDatabase([[{ ...databaseBaseRow, maxGuests: 1 }]]);
    const repository = new QuoteRepository(database as unknown as QuoteDatabase);

    await expect(
      repository.findQuoteInput(ROOM_TYPE_ID, {
        checkin: "2026-07-31",
        checkout: "2026-08-02",
        nights: 2,
        guests: 2,
      }),
    ).resolves.toEqual({ status: "CAPACITY_EXCEEDED" });
    expect(database.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing price", [{ ...databaseNightlyRows[0], salePriceCents: null }]],
    ["missing inventory", [{ ...databaseNightlyRows[0], totalInventory: null }]],
    ["missing date", [databaseNightlyRows[0]]],
  ])("returns NOT_AVAILABLE for %s rows", async (_name, nightlyRows) => {
    const database = createQuoteDatabase([[databaseBaseRow], nightlyRows]);
    const repository = new QuoteRepository(database as unknown as QuoteDatabase);

    await expect(
      repository.findQuoteInput(ROOM_TYPE_ID, {
        checkin: "2026-07-31",
        checkout: "2026-08-02",
        nights: 2,
        guests: 2,
      }),
    ).resolves.toEqual({ status: "NOT_AVAILABLE" });
  });

  it("derives a sold-out night strictly from total minus held minus sold", async () => {
    const database = createQuoteDatabase([
      [databaseBaseRow],
      [
        databaseNightlyRows[0],
        {
          ...databaseNightlyRows[1],
          totalInventory: 3,
          heldInventory: 1,
          soldInventory: 2,
        },
      ],
    ]);
    const repository = new QuoteRepository(database as unknown as QuoteDatabase);

    const result = await repository.findQuoteInput(ROOM_TYPE_ID, {
      checkin: "2026-07-31",
      checkout: "2026-08-02",
      nights: 2,
      guests: 2,
    });

    expect(result.status).toBe("AVAILABLE");
    if (result.status === "AVAILABLE") {
      expect(result.nightlyPrices.map(({ available }) => available)).toEqual([true, false]);
    }
  });

  it("accepts the PostgreSQL int4 maximum for a database nightly price", async () => {
    const database = createQuoteDatabase([
      [databaseBaseRow],
      [
        {
          ...databaseNightlyRows[0],
          salePriceCents: 2_147_483_647,
          rackPriceCents: 2_147_483_647,
        },
        databaseNightlyRows[1],
      ],
    ]);
    const repository = new QuoteRepository(database as unknown as QuoteDatabase);

    const result = await repository.findQuoteInput(ROOM_TYPE_ID, {
      checkin: "2026-07-31",
      checkout: "2026-08-02",
      nights: 2,
      guests: 2,
    });
    expect(result.status).toBe("AVAILABLE");
    if (result.status === "AVAILABLE") {
      expect(result.nightlyPrices[0]).toMatchObject({
        businessDate: "2026-07-31",
        salePriceCents: 2_147_483_647,
        rackPriceCents: 2_147_483_647,
      });
    }
  });

  it("maps proleptic Gregorian nightly rows for years before 0100", async () => {
    const database = createQuoteDatabase([
      [databaseBaseRow],
      [
        { ...databaseNightlyRows[0], businessDate: "0001-01-01" },
        { ...databaseNightlyRows[1], businessDate: "0001-01-02" },
      ],
    ]);
    const repository = new QuoteRepository(database as unknown as QuoteDatabase);

    await expect(
      repository.findQuoteInput(ROOM_TYPE_ID, {
        checkin: "0001-01-01",
        checkout: "0001-01-03",
        nights: 2,
        guests: 2,
      }),
    ).resolves.toMatchObject({
      status: "AVAILABLE",
      nightlyPrices: [{ businessDate: "0001-01-01" }, { businessDate: "0001-01-02" }],
    });
  });

  it.each([
    ["unsafe price", [{ ...databaseNightlyRows[0], salePriceCents: Number.MAX_SAFE_INTEGER + 1 }]],
    [
      "price above int4",
      [
        {
          ...databaseNightlyRows[0],
          salePriceCents: 2_147_483_648,
          rackPriceCents: 2_147_483_648,
        },
      ],
    ],
    ["negative price", [{ ...databaseNightlyRows[0], salePriceCents: -1 }]],
    ["rack below sale", [{ ...databaseNightlyRows[0], rackPriceCents: 1 }]],
    [
      "oversold inventory",
      [{ ...databaseNightlyRows[0], totalInventory: 1, heldInventory: 1, soldInventory: 1 }],
    ],
    ["duplicate date", [databaseNightlyRows[0], databaseNightlyRows[0]]],
    ["out-of-order date", [...databaseNightlyRows].reverse()],
  ])("rejects abnormal database data: %s", async (_name, nightlyRows) => {
    const database = createQuoteDatabase([[databaseBaseRow], nightlyRows]);
    const repository = new QuoteRepository(database as unknown as QuoteDatabase);

    await expect(
      repository.findQuoteInput(ROOM_TYPE_ID, {
        checkin: "2026-07-31",
        checkout: "2026-08-02",
        nights: 2,
        guests: 2,
      }),
    ).rejects.toThrow("Unexpected quote repository data");
  });

  it.each([
    ["not-a-uuid", { checkin: "2026-07-31", checkout: "2026-08-02", nights: 2, guests: 2 }],
    [ROOM_TYPE_ID, { checkin: "2026-02-30", checkout: "2026-08-02", nights: 2, guests: 2 }],
    [ROOM_TYPE_ID, { checkin: "2026-07-31", checkout: "2026-08-02", nights: 1, guests: 2 }],
    [ROOM_TYPE_ID, { checkin: "2026-07-31", checkout: "2026-08-02", nights: 2, guests: 11 }],
  ])("rejects invalid lookup input before database access", async (roomTypeId, range) => {
    const database = createQuoteDatabase();
    const repository = new QuoteRepository(database as unknown as QuoteDatabase);

    await expect(repository.findQuoteInput(roomTypeId, range)).rejects.toThrow(
      "Invalid quote repository input",
    );
    expect(database.$queryRaw).not.toHaveBeenCalled();
  });

  it.each([
    ["null range", null],
    [
      "throwing range proxy",
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("range-proxy-secret");
          },
        },
      ),
    ],
  ])("normalizes invalid lookup input: %s", async (_name, range) => {
    const database = createQuoteDatabase();
    const repository = new QuoteRepository(database as unknown as QuoteDatabase);

    await expect(repository.findQuoteInput(ROOM_TYPE_ID, range as never)).rejects.toThrowError(
      "Invalid quote repository input",
    );
    expect(database.$queryRaw).not.toHaveBeenCalled();
  });

  it("persists exact immutable JSON display snapshots with parameterized SQL", async () => {
    const database = createQuoteDatabase([
      [{ id: QUOTE_ID, createdAt: CAPTURED_AT, expiresAt: EXPIRES_AT }],
    ]);
    const repository = new QuoteRepository(database as unknown as QuoteDatabase);
    const input = persistInput();
    const original = structuredClone(input);

    await expect(repository.createQuote(input)).resolves.toEqual({
      id: QUOTE_ID,
      createdAt: CAPTURED_AT,
      expiresAt: EXPIRES_AT,
    });

    expect(input).toEqual(original);
    const query = database.$queryRaw.mock.calls[0]?.[0] as { sql: string; values: unknown[] };
    expect(query.sql).toContain("INSERT INTO quote");
    expect(query.sql).not.toContain(USER_ID);
    expect(query.sql).not.toContain("西湖云栖酒店");
    expect(query.values).toEqual(
      expect.arrayContaining([
        USER_ID,
        PROPERTY_ID,
        ROOM_TYPE_ID,
        JSON.stringify(input.propertySnapshot),
        JSON.stringify(input.roomTypeSnapshot),
        JSON.stringify(input.nightlyPrices),
      ]),
    );
    expect(JSON.parse(JSON.stringify(input.propertySnapshot))).toEqual({
      id: PROPERTY_ID,
      name: "西湖云栖酒店",
    });
    expect(JSON.parse(JSON.stringify(input.roomTypeSnapshot))).toEqual({
      id: ROOM_TYPE_ID,
      name: "舒适大床房",
      cover_url: "/images/catalog/room.jpg",
    });
    expect(JSON.parse(JSON.stringify(input.nightlyPrices[0]))).toEqual({
      business_date: "2026-07-31",
      sale_price_cents: 42_800,
      rack_price_cents: 48_800,
      currency: "CNY",
    });
  });

  it("validates proleptic Gregorian persistence dates before year 0100", async () => {
    const input: PersistQuoteInput = {
      ...persistInput(),
      checkin: "0001-01-01",
      checkout: "0001-01-03",
      nightlyPrices: [
        {
          business_date: "0001-01-01",
          sale_price_cents: 42_800,
          rack_price_cents: 48_800,
          currency: "CNY",
        },
        {
          business_date: "0001-01-02",
          sale_price_cents: 43_800,
          rack_price_cents: 49_800,
          currency: "CNY",
        },
      ],
    };
    const database = createQuoteDatabase([
      [{ id: QUOTE_ID, createdAt: CAPTURED_AT, expiresAt: EXPIRES_AT }],
    ]);
    const repository = new QuoteRepository(database as unknown as QuoteDatabase);

    await expect(repository.createQuote(input)).resolves.toEqual({
      id: QUOTE_ID,
      createdAt: CAPTURED_AT,
      expiresAt: EXPIRES_AT,
    });
  });

  it("accepts the PostgreSQL int4 maximum for one nightly price and total", async () => {
    const input: PersistQuoteInput = {
      ...persistInput(),
      checkout: "2026-08-01",
      nightlyPrices: [
        {
          business_date: "2026-07-31",
          sale_price_cents: 2_147_483_647,
          rack_price_cents: 2_147_483_647,
          currency: "CNY",
        },
      ],
      totalPriceCents: 2_147_483_647,
    };
    const database = createQuoteDatabase([
      [{ id: QUOTE_ID, createdAt: CAPTURED_AT, expiresAt: EXPIRES_AT }],
    ]);
    const repository = new QuoteRepository(database as unknown as QuoteDatabase);

    await expect(repository.createQuote(input)).resolves.toMatchObject({ id: QUOTE_ID });
    expect(database.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "nightly amount above int4",
      {
        ...persistInput(),
        checkout: "2026-08-01",
        nightlyPrices: [
          {
            business_date: "2026-07-31",
            sale_price_cents: 2_147_483_648,
            rack_price_cents: 2_147_483_648,
            currency: "CNY",
          },
        ],
        totalPriceCents: 2_147_483_648,
      },
    ],
    [
      "multi-night total above int4",
      {
        ...persistInput(),
        nightlyPrices: persistInput().nightlyPrices.map((nightlyPrice) => ({
          ...nightlyPrice,
          sale_price_cents: 1_500_000_000,
          rack_price_cents: 1_500_000_000,
        })),
        totalPriceCents: 3_000_000_000,
      },
    ],
  ])("rejects PostgreSQL int4 persistence overflow: %s", async (_name, input) => {
    const database = createQuoteDatabase();
    const repository = new QuoteRepository(database as unknown as QuoteDatabase);

    await expect(repository.createQuote(input as PersistQuoteInput)).rejects.toThrowError(
      "Invalid quote repository input",
    );
    expect(database.$queryRaw).not.toHaveBeenCalled();
  });

  it("rejects a non-enumerable snapshot field without reading it", async () => {
    const input = persistInput();
    Object.defineProperty(input.propertySnapshot, "name", {
      value: "西湖云栖酒店",
      enumerable: false,
    });
    const database = createQuoteDatabase();
    const repository = new QuoteRepository(database as unknown as QuoteDatabase);

    await expect(repository.createQuote(input)).rejects.toThrowError(
      "Invalid quote repository input",
    );
    expect(database.$queryRaw).not.toHaveBeenCalled();
  });

  it("rejects snapshot accessors without invoking stateful getters", async () => {
    const input = persistInput();
    let reads = 0;
    Object.defineProperty(input.propertySnapshot, "name", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? "西湖云栖酒店" : "stateful-secret";
      },
    });
    const database = createQuoteDatabase();
    const repository = new QuoteRepository(database as unknown as QuoteDatabase);

    await expect(repository.createQuote(input)).rejects.toThrowError(
      "Invalid quote repository input",
    );
    expect(reads).toBe(0);
    expect(database.$queryRaw).not.toHaveBeenCalled();
  });

  it("normalizes throwing input Proxy traps without leaking attacker errors", async () => {
    const input = new Proxy(persistInput(), {
      ownKeys() {
        throw new Error("input-proxy-secret");
      },
    });
    const database = createQuoteDatabase();
    const repository = new QuoteRepository(database as unknown as QuoteDatabase);

    await expect(repository.createQuote(input)).rejects.toThrowError(
      "Invalid quote repository input",
    );
    expect(database.$queryRaw).not.toHaveBeenCalled();
  });

  it("rejects circular and augmented nightly arrays before serialization", async () => {
    const input = persistInput();
    const nightlyPrices = input.nightlyPrices as typeof input.nightlyPrices & {
      circular?: unknown;
    };
    nightlyPrices.circular = nightlyPrices;
    const database = createQuoteDatabase();
    const repository = new QuoteRepository(database as unknown as QuoteDatabase);

    await expect(repository.createQuote(input)).rejects.toThrowError(
      "Invalid quote repository input",
    );
    expect(database.$queryRaw).not.toHaveBeenCalled();
  });

  it("rejects holes and array accessors without invoking them", async () => {
    const sparseInput = persistInput();
    Reflect.deleteProperty(sparseInput.nightlyPrices, "1");
    const accessorInput = persistInput();
    const firstNight = accessorInput.nightlyPrices[0]!;
    let reads = 0;
    Object.defineProperty(accessorInput.nightlyPrices, "0", {
      enumerable: true,
      get() {
        reads += 1;
        return firstNight;
      },
    });
    const database = createQuoteDatabase();
    const repository = new QuoteRepository(database as unknown as QuoteDatabase);

    await expect(repository.createQuote(sparseInput)).rejects.toThrowError(
      "Invalid quote repository input",
    );
    await expect(repository.createQuote(accessorInput)).rejects.toThrowError(
      "Invalid quote repository input",
    );
    expect(reads).toBe(0);
    expect(database.$queryRaw).not.toHaveBeenCalled();
  });

  it("accepts null-prototype input records after materializing trusted JSON", async () => {
    const source = persistInput();
    const input: PersistQuoteInput = copyWithNullPrototype({
      ...source,
      propertySnapshot: copyWithNullPrototype(source.propertySnapshot),
      roomTypeSnapshot: copyWithNullPrototype(source.roomTypeSnapshot),
      nightlyPrices: source.nightlyPrices.map((nightlyPrice) =>
        copyWithNullPrototype(nightlyPrice),
      ),
    });
    const database = createQuoteDatabase([
      [{ id: QUOTE_ID, createdAt: CAPTURED_AT, expiresAt: EXPIRES_AT }],
    ]);
    const repository = new QuoteRepository(database as unknown as QuoteDatabase);

    await expect(repository.createQuote(input)).resolves.toMatchObject({ id: QUOTE_ID });
  });

  it.each([
    ["null input", null],
    ["null property snapshot", { ...persistInput(), propertySnapshot: null }],
    ["null room snapshot", { ...persistInput(), roomTypeSnapshot: null }],
    ["non-array nightly prices", { ...persistInput(), nightlyPrices: { length: 2 } }],
  ])("normalizes structurally invalid persistence input: %s", async (_name, input) => {
    const database = createQuoteDatabase();
    const repository = new QuoteRepository(database as unknown as QuoteDatabase);

    await expect(repository.createQuote(input as never)).rejects.toThrowError(
      "Invalid quote repository input",
    );
    expect(database.$queryRaw).not.toHaveBeenCalled();
  });

  it.each(["lookup", "create"] as const)(
    "does not normalize a database-stage %s failure as invalid input",
    async (operation) => {
      const databaseFailure = new Error("database-stage-failure");
      const database = {
        $queryRaw: vi.fn(() => Promise.reject(databaseFailure)),
      };
      const repository = new QuoteRepository(database);

      const result =
        operation === "lookup"
          ? repository.findQuoteInput(ROOM_TYPE_ID, {
              checkin: "2026-07-31",
              checkout: "2026-08-02",
              nights: 2,
              guests: 2,
            })
          : repository.createQuote(persistInput());
      await expect(result).rejects.toBe(databaseFailure);
    },
  );

  it.each([
    { ...persistInput(), userId: "not-a-uuid" },
    { ...persistInput(), currency: "USD" as "CNY" },
    { ...persistInput(), fingerprint: "secret" },
    { ...persistInput(), totalPriceCents: 1 },
    { ...persistInput(), expiresAt: new Date(Number.NaN) },
  ])("rejects invalid persistence input before database access", async (input) => {
    const database = createQuoteDatabase();
    const repository = new QuoteRepository(database as unknown as QuoteDatabase);

    await expect(repository.createQuote(input)).rejects.toThrow("Invalid quote repository input");
    expect(database.$queryRaw).not.toHaveBeenCalled();
  });

  it("rejects malformed persisted rows instead of trusting unknown database output", async () => {
    const database = createQuoteDatabase([
      [{ id: "not-a-uuid", createdAt: CAPTURED_AT, expiresAt: EXPIRES_AT }],
    ]);
    const repository = new QuoteRepository(database as unknown as QuoteDatabase);

    await expect(repository.createQuote(persistInput())).rejects.toThrow(
      "Unexpected quote repository data",
    );
  });
});

describe("PricingModule", () => {
  it("wires one pricing rate limiter and exports the service dependencies without controllers", () => {
    const imports = Reflect.getMetadata("imports", PricingModule) as unknown[];
    const providers = Reflect.getMetadata("providers", PricingModule) as unknown[];
    const controllers = Reflect.getMetadata("controllers", PricingModule) as unknown[] | undefined;

    expect(imports).toHaveLength(3);
    expect(providers).toEqual(
      expect.arrayContaining([QuoteRepository, QuotesService, expect.any(Function)]),
    );
    expect(
      providers.filter(
        (provider) =>
          provider ===
          (vi.mocked({ checkQuotes: () => Promise.resolve() }) as unknown as WriteRateLimitService)
            .constructor,
      ),
    ).toHaveLength(0);
    expect(controllers ?? []).toEqual([]);
  });
});

/* eslint-disable @typescript-eslint/unbound-method */
import { randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { Clock } from "../src/common/clock/clock.js";
import { BusinessException } from "../src/common/http/business.exception.js";
import { WriteRateLimitService } from "../src/common/rate-limit/write-rate-limit.service.js";
import {
  createBookingNumberGenerator,
  BOOKING_NUMBER_GENERATOR,
  type BookingNumberGenerator,
} from "../src/booking/booking-number.js";
import { BookingModule } from "../src/booking/booking.module.js";
import {
  BookingNumberConflictError,
  BookingRepository,
  type BookingDatabase,
  type CreateBookingInput,
  type CreateBookingResult,
} from "../src/booking/booking.repository.js";
import { BookingsService } from "../src/booking/bookings.service.js";
import { CLOCK } from "../src/common/clock/clock.js";
import { DatabaseModule } from "../src/database/database.module.js";
import { IdentityModule } from "../src/identity/identity.module.js";
import { Prisma } from "../src/generated/prisma/client.js";
import { PricingModule } from "../src/pricing/pricing.module.js";
import { createQuoteFingerprint } from "../src/pricing/quote-fingerprint.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const QUOTE_ID = "20000000-0000-4000-8000-000000000001";
const BOOKING_ID = "30000000-0000-4000-8000-000000000001";
const IDEMPOTENCY_KEY = "booking-key-1234567890_ABCDEFGHIJ";
const NOW = new Date("2026-07-30T02:00:00.000Z");

const booking = {
  booking_id: BOOKING_ID,
  booking_number: "SF20260730A1B2C3D4E5F6",
  status: "PENDING_PAYMENT" as const,
  property_name: "西湖云栖酒店",
  room_type_name: "湖景大床房",
  checkin: "2026-08-01",
  checkout: "2026-08-03",
  nights: 2,
  guests: 2,
  total_price_cents: 121_600,
  currency: "CNY" as const,
  expires_at: "2026-07-30T02:15:00.000Z",
  created_at: "2026-07-30T02:00:00.000Z",
};

const replacementQuote = {
  quote_id: "40000000-0000-4000-8000-000000000001",
  property: { id: "50000000-0000-4000-8000-000000000001", name: "西湖云栖酒店" },
  room_type: {
    id: "60000000-0000-4000-8000-000000000001",
    name: "湖景大床房",
    cover_url: "/images/catalog/room.jpg",
  },
  checkin: "2026-08-01",
  checkout: "2026-08-03",
  nights: 2,
  guests: 2,
  nightly_prices: [
    {
      business_date: "2026-08-01",
      sale_price_cents: 60_000,
      rack_price_cents: 68_800,
      currency: "CNY" as const,
    },
    {
      business_date: "2026-08-02",
      sale_price_cents: 64_000,
      rack_price_cents: 72_800,
      currency: "CNY" as const,
    },
  ],
  total_price_cents: 124_000,
  currency: "CNY" as const,
  booking_policy: "入住前一天18:00前可免费取消",
  expires_at: "2026-07-30T02:05:00.000Z",
};

const captureBusinessError = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BusinessException);
    return error as BusinessException;
  }
  throw new Error("Expected BusinessException");
};

describe("BookingNumberGenerator", () => {
  it("formats UTC date and exactly six random bytes", () => {
    const source = vi.fn(() => Buffer.from("a1b2c3d4e5f6", "hex"));
    const generator = createBookingNumberGenerator(source);
    expect(generator.next(new Date("2026-07-30T23:59:59.999Z"))).toBe("SF20260730A1B2C3D4E5F6");
    expect(source).toHaveBeenCalledWith(6);
  });

  it.each([
    ["invalid date", () => createBookingNumberGenerator().next(new Date(Number.NaN))],
    ["short read", () => createBookingNumberGenerator(() => Buffer.alloc(5)).next(NOW)],
    ["long read", () => createBookingNumberGenerator(() => Buffer.alloc(7)).next(NOW)],
    [
      "throwing source",
      () =>
        createBookingNumberGenerator(() => {
          throw new Error("random-secret");
        }).next(NOW),
    ],
    [
      "hostile buffer",
      () =>
        createBookingNumberGenerator(
          () =>
            new Proxy(Buffer.alloc(6), {
              get: () => {
                throw new Error("buffer-secret");
              },
            }),
        ).next(NOW),
    ],
  ])("fails safely for %s", (_name, operation) => {
    expect(operation).toThrow("Booking number unavailable");
  });

  it("defaults to cryptographic random bytes", () => {
    expect(createBookingNumberGenerator().next(NOW)).toMatch(/^SF20260730[A-F0-9]{12}$/);
    expect(randomBytes(6)).toHaveLength(6);
  });
});

const createRepository = (result: CreateBookingResult = { kind: "CREATED", booking }) => ({
  createFromQuote: vi.fn<(input: CreateBookingInput) => Promise<CreateBookingResult>>(() =>
    Promise.resolve(result),
  ),
});
const createRateLimit = () => ({ checkBookings: vi.fn(() => Promise.resolve()) });
const createGenerator = (...numbers: string[]): BookingNumberGenerator => ({
  next: vi.fn(() => numbers.shift() ?? "SF20260730ABCDEF123456"),
});

describe("BookingsService", () => {
  it.each(["CREATED", "REPLAYED"] as const)("returns a strict %s booking result", async (kind) => {
    const repository = createRepository({ kind, booking });
    const rateLimit = createRateLimit();
    const clock: Clock = { now: vi.fn(() => NOW) };
    const generator = createGenerator("SF20260730A1B2C3D4E5F6");
    const service = new BookingsService(
      repository as unknown as BookingRepository,
      rateLimit as unknown as WriteRateLimitService,
      clock,
      generator,
    );

    await expect(service.create(USER_ID, IDEMPOTENCY_KEY, { quote_id: QUOTE_ID })).resolves.toEqual(
      { kind, booking },
    );
    expect(rateLimit.checkBookings).toHaveBeenCalledWith(USER_ID);
    expect(clock.now).toHaveBeenCalledTimes(1);
    expect(repository.createFromQuote).toHaveBeenCalledWith({
      userId: USER_ID,
      quoteId: QUOTE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      bookingNumber: "SF20260730A1B2C3D4E5F6",
      now: NOW,
    });
  });

  it.each([
    ["QUOTE_EXPIRED", 409, "QUOTE_EXPIRED"],
    ["QUOTE_ALREADY_USED", 409, "QUOTE_ALREADY_USED"],
    ["INVENTORY_UNAVAILABLE", 409, "INVENTORY_UNAVAILABLE"],
  ] as const)("maps %s to a fixed safe business error", async (kind, status, code) => {
    const service = new BookingsService(
      createRepository({ kind }) as unknown as BookingRepository,
      createRateLimit() as unknown as WriteRateLimitService,
      { now: () => NOW },
      createGenerator("SF20260730A1B2C3D4E5F6"),
    );
    const error = await captureBusinessError(
      service.create(USER_ID, IDEMPOTENCY_KEY, { quote_id: QUOTE_ID }),
    );
    expect(error.getStatus()).toBe(status);
    expect(error.code).toBe(code);
    expect(error.message).not.toContain(USER_ID);
  });

  it("returns strictly parsed QUOTE_CHANGED details", async () => {
    const details = {
      previous_total_price_cents: 121_600,
      replacement_quote: replacementQuote,
    };
    const service = new BookingsService(
      createRepository({ kind: "QUOTE_CHANGED", details }) as unknown as BookingRepository,
      createRateLimit() as unknown as WriteRateLimitService,
      { now: () => NOW },
      createGenerator("SF20260730A1B2C3D4E5F6"),
    );
    const error = await captureBusinessError(
      service.create(USER_ID, IDEMPOTENCY_KEY, { quote_id: QUOTE_ID }),
    );
    expect(error.getStatus()).toBe(409);
    expect(error.code).toBe("QUOTE_CHANGED");
    expect(error.details).toEqual(details);
  });

  it.each([
    ["invalid user", "bad-user", IDEMPOTENCY_KEY, { quote_id: QUOTE_ID }],
    ["invalid key", USER_ID, "short", { quote_id: QUOTE_ID }],
    ["invalid body", USER_ID, IDEMPOTENCY_KEY, { quote_id: QUOTE_ID, unknown: true }],
  ])("rejects %s before rate limiting", async (_name, userId, key, body) => {
    const repository = createRepository();
    const rateLimit = createRateLimit();
    const service = new BookingsService(
      repository as unknown as BookingRepository,
      rateLimit as unknown as WriteRateLimitService,
      { now: () => NOW },
      createGenerator(),
    );
    const error = await captureBusinessError(service.create(userId, key, body));
    expect(error.getStatus()).toBe(400);
    expect(rateLimit.checkBookings).not.toHaveBeenCalled();
    expect(repository.createFromQuote).not.toHaveBeenCalled();
  });

  it("preserves rate limit errors before clock and database access", async () => {
    const repository = createRepository();
    const rateLimit = createRateLimit();
    const limited = new BusinessException(429, "RATE_LIMITED", "操作过于频繁，请稍后重试");
    rateLimit.checkBookings.mockRejectedValue(limited);
    const clock: Clock = { now: vi.fn(() => NOW) };
    const service = new BookingsService(
      repository as unknown as BookingRepository,
      rateLimit as unknown as WriteRateLimitService,
      clock,
      createGenerator(),
    );
    await expect(service.create(USER_ID, IDEMPOTENCY_KEY, { quote_id: QUOTE_ID })).rejects.toBe(
      limited,
    );
    expect(clock.now).not.toHaveBeenCalled();
    expect(repository.createFromQuote).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid clock", { now: () => new Date(Number.NaN) }],
    [
      "throwing clock",
      {
        now: () => {
          throw new Error("clock-secret");
        },
      },
    ],
  ])("maps %s and unknown repository failures to safe 503", async (_name, clock) => {
    const repository = createRepository();
    const service = new BookingsService(
      repository as unknown as BookingRepository,
      createRateLimit() as unknown as WriteRateLimitService,
      clock,
      createGenerator(),
    );
    const error = await captureBusinessError(
      service.create(USER_ID, IDEMPOTENCY_KEY, { quote_id: QUOTE_ID }),
    );
    expect(error.getStatus()).toBe(503);
    expect(error.code).toBe("BOOKING_SERVICE_UNAVAILABLE");
    expect(repository.createFromQuote).not.toHaveBeenCalled();
  });

  it("retries one complete transaction after a booking-number collision", async () => {
    const repository = createRepository();
    repository.createFromQuote
      .mockRejectedValueOnce(new BookingNumberConflictError())
      .mockResolvedValueOnce({ kind: "CREATED", booking });
    const generator = createGenerator("SF20260730AAAAAAAAAAAA", "SF20260730BBBBBBBBBBBB");
    const service = new BookingsService(
      repository as unknown as BookingRepository,
      createRateLimit() as unknown as WriteRateLimitService,
      { now: () => NOW },
      generator,
    );

    await expect(service.create(USER_ID, IDEMPOTENCY_KEY, { quote_id: QUOTE_ID })).resolves.toEqual(
      { kind: "CREATED", booking },
    );
    expect(repository.createFromQuote).toHaveBeenCalledTimes(2);
    expect(repository.createFromQuote.mock.calls.map(([input]) => input.bookingNumber)).toEqual([
      "SF20260730AAAAAAAAAAAA",
      "SF20260730BBBBBBBBBBBB",
    ]);
  });

  it("does not retry an unknown repository error or a second number collision", async () => {
    for (const failures of [
      [new Error("unique-secret")],
      [new BookingNumberConflictError(), new BookingNumberConflictError()],
    ]) {
      const repository = createRepository();
      repository.createFromQuote.mockReset();
      for (const failure of failures) {
        repository.createFromQuote.mockRejectedValueOnce(failure);
      }
      const service = new BookingsService(
        repository as unknown as BookingRepository,
        createRateLimit() as unknown as WriteRateLimitService,
        { now: () => NOW },
        createGenerator("SF20260730AAAAAAAAAAAA", "SF20260730BBBBBBBBBBBB"),
      );
      const error = await captureBusinessError(
        service.create(USER_ID, IDEMPOTENCY_KEY, { quote_id: QUOTE_ID }),
      );
      expect(error.getStatus()).toBe(503);
      expect(repository.createFromQuote).toHaveBeenCalledTimes(failures.length);
    }
  });
});

const PROPERTY_ID = "50000000-0000-4000-8000-000000000001";
const ROOM_TYPE_ID = "60000000-0000-4000-8000-000000000001";
const propertySnapshot = { id: PROPERTY_ID, name: "西湖云栖酒店" };
const roomTypeSnapshot = {
  id: ROOM_TYPE_ID,
  name: "湖景大床房",
  cover_url: "/images/catalog/room.jpg",
};
const nightlyPrices = [
  {
    business_date: "2026-08-01",
    sale_price_cents: 58_800,
    rack_price_cents: 68_800,
    currency: "CNY" as const,
  },
  {
    business_date: "2026-08-02",
    sale_price_cents: 62_800,
    rack_price_cents: 72_800,
    currency: "CNY" as const,
  },
];
const bookingPolicy = "入住前一天18:00前可免费取消";
const currentFingerprint = createQuoteFingerprint({
  property: propertySnapshot,
  roomType: {
    id: ROOM_TYPE_ID,
    name: roomTypeSnapshot.name,
    coverUrl: roomTypeSnapshot.cover_url,
  },
  checkin: "2026-08-01",
  checkout: "2026-08-03",
  guests: 2,
  bookingPolicy,
  nightlyPrices: nightlyPrices.map((night) => ({
    businessDate: night.business_date,
    salePriceCents: night.sale_price_cents,
    rackPriceCents: night.rack_price_cents,
  })),
});
const quoteRow = {
  id: QUOTE_ID,
  userId: USER_ID,
  propertyId: PROPERTY_ID,
  roomTypeId: ROOM_TYPE_ID,
  checkin: "2026-08-01",
  checkout: "2026-08-03",
  guests: 2,
  propertySnapshot,
  roomTypeSnapshot,
  nightlyPrices,
  bookingPolicy,
  totalPriceCents: 121_600,
  currency: "CNY",
  fingerprint: currentFingerprint,
  expiresAt: new Date("2026-07-30T02:05:00.000Z"),
  bookingId: null,
  bookingIdempotencyKey: null,
};
const currentBase = {
  propertyId: PROPERTY_ID,
  propertyName: propertySnapshot.name,
  roomTypeId: ROOM_TYPE_ID,
  roomTypeName: roomTypeSnapshot.name,
  coverUrl: roomTypeSnapshot.cover_url,
  maxGuests: 2,
  bookingPolicy,
};
const currentNightly = nightlyPrices.map((night) => ({
  businessDate: night.business_date,
  salePriceCents: night.sale_price_cents,
  rackPriceCents: night.rack_price_cents,
}));
const inventoryRows = nightlyPrices.map((night) => ({
  roomTypeId: ROOM_TYPE_ID,
  businessDate: night.business_date,
  totalInventory: 2,
  heldInventory: 0,
  soldInventory: 0,
}));
const bookingRecord = {
  id: BOOKING_ID,
  bookingNumber: booking.booking_number,
  status: "PENDING_PAYMENT",
  propertyName: propertySnapshot.name,
  roomTypeName: roomTypeSnapshot.name,
  checkin: quoteRow.checkin,
  checkout: quoteRow.checkout,
  guests: 2,
  totalPriceCents: 121_600,
  currency: "CNY",
  expiresAt: new Date("2026-07-30T02:15:00.000Z"),
  createdAt: NOW,
};
const repositoryInput: CreateBookingInput = {
  userId: USER_ID,
  quoteId: QUOTE_ID,
  idempotencyKey: IDEMPOTENCY_KEY,
  bookingNumber: booking.booking_number,
  now: NOW,
};

const createBookingDatabase = (responses: unknown[]) => {
  let index = 0;
  const staged: string[] = [];
  const committed: string[] = [];
  let rollbackCount = 0;
  const transaction = {
    $queryRaw: vi.fn<(query: unknown) => Promise<unknown>>((query) => {
      const sql = (query as { sql?: string }).sql ?? "";
      if (/\b(?:UPDATE|INSERT)\b/.test(sql)) {
        staged.push(sql);
      }
      const response = responses[index++];
      return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
    }),
  };
  const database = {
    transactionOptions: undefined as { isolationLevel: string } | undefined,
    committed,
    get staged() {
      return [...staged];
    },
    get rollbackCount() {
      return rollbackCount;
    },
    $transaction: vi.fn(
      async <T>(
        operation: (client: typeof transaction) => Promise<T>,
        options: { isolationLevel: string },
      ) => {
        database.transactionOptions = options;
        try {
          const result = await operation(transaction);
          committed.push(...staged);
          staged.length = 0;
          return result;
        } catch (error) {
          rollbackCount += 1;
          staged.length = 0;
          throw error;
        }
      },
    ),
    $queryRaw: vi.fn<(query: unknown) => Promise<unknown>>(),
  };
  return { database, transaction };
};

const queryText = (call: unknown[] | undefined) =>
  (call?.[0] as { sql?: string } | undefined)?.sql ?? "";

describe("BookingRepository", () => {
  it("runs the successful transaction in the fixed lock and write order with parameterized SQL", async () => {
    const responses = [
      [{ locked: null }],
      [],
      [quoteRow],
      [],
      [currentBase],
      currentNightly,
      inventoryRows,
      [{ roomTypeId: ROOM_TYPE_ID }],
      [{ roomTypeId: ROOM_TYPE_ID }],
      [bookingRecord],
      [{ bookingId: BOOKING_ID }, { bookingId: BOOKING_ID }],
      [{ id: "70000000-0000-4000-8000-000000000001" }],
    ];
    const { database, transaction } = createBookingDatabase(responses);
    const repository = new BookingRepository(database as unknown as BookingDatabase);

    await expect(repository.createFromQuote(repositoryInput)).resolves.toEqual({
      kind: "CREATED",
      booking,
    });
    expect(database.$transaction).toHaveBeenCalledTimes(1);
    expect(database.transactionOptions).toEqual({ isolationLevel: "ReadCommitted" });
    const sql = transaction.$queryRaw.mock.calls.map((call) => queryText(call));
    expect(sql).toHaveLength(12);
    expect(sql[0]).toContain("pg_advisory_xact_lock");
    expect(sql[1]).toContain("idempotency_key");
    expect(sql[2]).toContain("FROM quote");
    expect(sql[2]).toContain("FOR UPDATE");
    expect(sql[6]).toContain("ORDER BY");
    expect(sql[6]).toContain("FOR UPDATE");
    expect(sql[7]).toContain("held_inventory = held_inventory + 1");
    expect(sql[8]).toContain("held_inventory = held_inventory + 1");
    expect(sql[9]).toContain("INSERT INTO booking");
    expect(sql[10]).toContain("INSERT INTO inventory_hold");
    expect(sql[11]).toContain("INSERT INTO booking_status_history");
    for (const [callIndex, call] of transaction.$queryRaw.mock.calls.entries()) {
      const query = call[0] as { sql: string; values: unknown[] };
      expect(query.sql).not.toContain(USER_ID);
      expect(query.sql).not.toContain(IDEMPOTENCY_KEY);
      if (callIndex === 0) {
        expect(query.values).toEqual(expect.arrayContaining([USER_ID, IDEMPOTENCY_KEY]));
      }
    }
  });

  it("replays under the advisory lock before reading or locking the quote", async () => {
    const { database, transaction } = createBookingDatabase([[{ locked: null }], [bookingRecord]]);
    const repository = new BookingRepository(database as unknown as BookingDatabase);
    await expect(repository.createFromQuote(repositoryInput)).resolves.toEqual({
      kind: "REPLAYED",
      booking,
    });
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(2);
    expect(queryText(transaction.$queryRaw.mock.calls[0])).toContain("pg_advisory_xact_lock");
    expect(queryText(transaction.$queryRaw.mock.calls[1])).toContain("idempotency_key");
  });

  it.each([
    ["missing quote", [], undefined, "QUOTE_EXPIRED", 3],
    [
      "expired quote",
      [{ ...quoteRow, expiresAt: new Date("2026-07-30T02:00:00.000Z") }],
      [],
      "QUOTE_EXPIRED",
      4,
    ],
    [
      "used quote",
      [quoteRow],
      [{ ...bookingRecord, idempotencyKey: `${IDEMPOTENCY_KEY}x` }],
      "QUOTE_ALREADY_USED",
      4,
    ],
  ])("maps %s before inventory access", async (_name, quoteRows, usedRows, kind, calls) => {
    const responses: unknown[] = [[{ locked: null }], [], quoteRows];
    if (usedRows !== undefined) {
      responses.push(usedRows);
    }
    const { database, transaction } = createBookingDatabase(responses);
    const repository = new BookingRepository(database as unknown as BookingDatabase);
    await expect(repository.createFromQuote(repositoryInput)).resolves.toEqual({ kind });
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(calls);
  });

  it("commits a replacement quote on fingerprint change without locking inventory", async () => {
    const changedNightly = currentNightly.map((night, index) =>
      index === 0 ? { ...night, salePriceCents: 60_000 } : night,
    );
    const replacementRecord = {
      id: replacementQuote.quote_id,
      createdAt: NOW,
      expiresAt: new Date("2026-07-30T02:05:00.000Z"),
    };
    const { database, transaction } = createBookingDatabase([
      [{ locked: null }],
      [],
      [quoteRow],
      [],
      [currentBase],
      changedNightly,
      [replacementRecord],
    ]);
    const repository = new BookingRepository(database as unknown as BookingDatabase);
    const result = await repository.createFromQuote(repositoryInput);
    expect(result.kind).toBe("QUOTE_CHANGED");
    if (result.kind === "QUOTE_CHANGED") {
      expect(result.details.previous_total_price_cents).toBe(121_600);
      expect(result.details.replacement_quote.total_price_cents).toBe(122_800);
    }
    const sql = transaction.$queryRaw.mock.calls.map((call) => queryText(call));
    expect(sql.at(-1)).toContain("INSERT INTO quote");
    expect(sql.join("\n")).not.toContain("daily_inventory");
    expect(sql.join("\n")).not.toContain("INSERT INTO booking");
  });

  it("returns inventory unavailable before writes when any locked night is absent or sold out", async () => {
    for (const lockedRows of [
      inventoryRows.slice(0, 1),
      inventoryRows.map((row, index) => (index === 1 ? { ...row, heldInventory: 2 } : row)),
    ]) {
      const { database, transaction } = createBookingDatabase([
        [{ locked: null }],
        [],
        [quoteRow],
        [],
        [currentBase],
        currentNightly,
        lockedRows,
      ]);
      const repository = new BookingRepository(database as unknown as BookingDatabase);
      await expect(repository.createFromQuote(repositoryInput)).resolves.toEqual({
        kind: "INVENTORY_UNAVAILABLE",
      });
      expect(transaction.$queryRaw).toHaveBeenCalledTimes(7);
    }
  });

  it("rolls back the whole transaction when a conditional inventory update loses the race", async () => {
    const { database, transaction } = createBookingDatabase([
      [{ locked: null }],
      [],
      [quoteRow],
      [],
      [currentBase],
      currentNightly,
      inventoryRows,
      [{ roomTypeId: ROOM_TYPE_ID }],
      [],
    ]);
    const repository = new BookingRepository(database as unknown as BookingDatabase);
    await expect(repository.createFromQuote(repositoryInput)).resolves.toEqual({
      kind: "INVENTORY_UNAVAILABLE",
    });
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(9);
    expect(database.rollbackCount).toBe(1);
    expect(database.staged).toEqual([]);
    expect(database.committed).toEqual([]);
  });

  it("rejects malformed input and unknown database rows without continuing writes", async () => {
    const { database, transaction } = createBookingDatabase([
      [{ locked: null }],
      [],
      [{ ...quoteRow, userId: "x" }],
    ]);
    const repository = new BookingRepository(database as unknown as BookingDatabase);
    await expect(repository.createFromQuote(repositoryInput)).rejects.toThrow(
      "Unexpected booking repository data",
    );
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(3);
    await expect(
      repository.createFromQuote({ ...repositoryInput, idempotencyKey: "short" }),
    ).rejects.toThrow("Invalid booking repository input");
  });

  const knownRequestError = (
    code: "P2002" | "P2010",
    meta: Record<string, unknown>,
    message = "database error",
  ) =>
    new Prisma.PrismaClientKnownRequestError(message, {
      code,
      clientVersion: "test",
      meta,
    });

  it.each([
    [
      "P2002 target columns",
      knownRequestError("P2002", { target: ["booking_number"] }),
      "booking_number",
    ],
    [
      "P2002 constraint target",
      knownRequestError("P2002", { target: "booking_booking_number_key" }),
      "booking_number",
    ],
    [
      "P2002 idempotency columns",
      knownRequestError("P2002", { target: ["user_id", "idempotency_key"] }),
      "idempotency",
    ],
    ["P2002 quote column", knownRequestError("P2002", { target: ["quote_id"] }), "quote"],
    [
      "P2010 trusted constraint",
      knownRequestError("P2010", {
        code: "23505",
        constraint: "booking_booking_number_key",
      }),
      "booking_number",
    ],
    [
      "P2010 standard message",
      knownRequestError("P2010", {
        code: "23505",
        message: 'duplicate key value violates unique constraint "booking_booking_number_key"',
      }),
      "booking_number",
    ],
    [
      "P2010 idempotency constraint",
      knownRequestError("P2010", {
        code: "23505",
        constraint: "booking_user_id_idempotency_key_key",
      }),
      "idempotency",
    ],
    [
      "P2010 quote constraint",
      knownRequestError("P2010", {
        code: "23505",
        constraint: "booking_quote_id_key",
      }),
      "quote",
    ],
  ])("checks user/key after confirmed unique: %s", async (_name, error, classification) => {
    const { database } = createBookingDatabase([]);
    database.$transaction.mockRejectedValueOnce(error);
    database.$queryRaw.mockResolvedValueOnce([bookingRecord]);
    const repository = new BookingRepository(database as unknown as BookingDatabase);

    await expect(repository.createFromQuote(repositoryInput)).resolves.toEqual({
      kind: "REPLAYED",
      booking,
    });
    expect(database.$queryRaw).toHaveBeenCalledTimes(1);
    const lookup = database.$queryRaw.mock.calls[0]?.[0] as {
      sql: string;
      values: unknown[];
    };
    expect(lookup.sql).toContain("idempotency_key");
    expect(lookup.values).toEqual(expect.arrayContaining([USER_ID, IDEMPOTENCY_KEY]));
    expect(classification).toBeTruthy();
  });

  it("retries only a confirmed booking-number unique after rollback and empty user/key lookup", async () => {
    const error = knownRequestError("P2010", {
      code: "23505",
      message: 'duplicate key value violates unique constraint "booking_booking_number_key"',
    });
    const { database } = createBookingDatabase([]);
    database.$transaction.mockRejectedValueOnce(error);
    database.$queryRaw.mockResolvedValueOnce([]);
    const repository = new BookingRepository(database as unknown as BookingDatabase);

    await expect(repository.createFromQuote(repositoryInput)).rejects.toBeInstanceOf(
      BookingNumberConflictError,
    );
    expect(database.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("makes exactly one full service retry for a raw P2010 booking-number conflict", async () => {
    const error = knownRequestError("P2010", {
      code: "23505",
      constraint: "booking_booking_number_key",
    });
    const { database } = createBookingDatabase([[{ locked: null }], [bookingRecord]]);
    database.$transaction.mockRejectedValueOnce(error);
    database.$queryRaw.mockResolvedValueOnce([]);
    const repository = new BookingRepository(database as unknown as BookingDatabase);
    const generator = createGenerator("SF20260730AAAAAAAAAAAA", "SF20260730BBBBBBBBBBBB");
    const service = new BookingsService(
      repository,
      createRateLimit() as unknown as WriteRateLimitService,
      { now: () => NOW },
      generator,
    );

    await expect(service.create(USER_ID, IDEMPOTENCY_KEY, { quote_id: QUOTE_ID })).resolves.toEqual(
      { kind: "REPLAYED", booking },
    );
    expect(database.$transaction).toHaveBeenCalledTimes(2);
    expect(database.$queryRaw).toHaveBeenCalledTimes(1);
    expect(generator.next).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "other SQLSTATE",
      knownRequestError("P2010", {
        code: "23503",
        constraint: "booking_booking_number_key",
      }),
    ],
    [
      "forged message",
      knownRequestError("P2010", {
        code: "23505",
        message: 'user input mentions "booking_booking_number_key"',
      }),
    ],
    [
      "unknown constraint",
      knownRequestError("P2010", {
        code: "23505",
        constraint: "some_other_unique_key",
      }),
    ],
    [
      "malformed meta",
      knownRequestError("P2010", {
        code: "23505",
        constraint: { toString: () => "booking_booking_number_key" },
      }),
    ],
  ])("does not treat %s as a confirmed unique conflict", async (_name, error) => {
    const { database } = createBookingDatabase([]);
    database.$transaction.mockRejectedValueOnce(error);
    const repository = new BookingRepository(database as unknown as BookingDatabase);
    await expect(repository.createFromQuote(repositoryInput)).rejects.toBe(error);
    expect(database.$queryRaw).not.toHaveBeenCalled();
  });

  it("rolls back staged inventory and writes before classifying a raw unique violation", async () => {
    const unique = knownRequestError("P2010", {
      code: "23505",
      constraint: "booking_booking_number_key",
    });
    const { database } = createBookingDatabase([
      [{ locked: null }],
      [],
      [quoteRow],
      [],
      [currentBase],
      currentNightly,
      inventoryRows,
      [{ roomTypeId: ROOM_TYPE_ID }],
      [{ roomTypeId: ROOM_TYPE_ID }],
      unique,
    ]);
    database.$queryRaw.mockResolvedValueOnce([]);
    const repository = new BookingRepository(database as unknown as BookingDatabase);
    await expect(repository.createFromQuote(repositoryInput)).rejects.toBeInstanceOf(
      BookingNumberConflictError,
    );
    expect(database.rollbackCount).toBe(1);
    expect(database.staged).toEqual([]);
    expect(database.committed).toEqual([]);
    expect(database.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe("BookingModule", () => {
  it("reuses the pricing rate limiter and registers no controller", () => {
    const imports = Reflect.getMetadata("imports", BookingModule) as unknown[];
    const providers = Reflect.getMetadata("providers", BookingModule) as unknown[];
    const controllers = Reflect.getMetadata("controllers", BookingModule) as unknown[] | undefined;
    expect(imports).toEqual([DatabaseModule, IdentityModule, PricingModule]);
    expect(providers).toEqual(
      expect.arrayContaining([
        BookingRepository,
        BookingsService,
        expect.objectContaining({ provide: CLOCK }),
        expect.objectContaining({ provide: BOOKING_NUMBER_GENERATOR }),
      ]),
    );
    expect(providers).not.toContain(WriteRateLimitService);
    expect(controllers ?? []).toEqual([]);
  });
});

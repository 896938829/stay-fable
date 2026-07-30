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
import { BookingActionsController } from "../src/booking/booking-actions.controller.js";
import { BookingModule } from "../src/booking/booking.module.js";
import { BookingQueryController } from "../src/booking/booking-query.controller.js";
import { BookingsController } from "../src/booking/bookings.controller.js";
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

class FixedClock implements Clock {
  constructor(private readonly value = NOW) {}

  now(): Date {
    return new Date(Date.prototype.getTime.call(this.value));
  }
}

const booking = {
  booking_id: BOOKING_ID,
  quote_id: QUOTE_ID,
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

  it("does not call an own Buffer toString method", () => {
    const bytes = Buffer.from("a1b2c3d4e5f6", "hex");
    Object.defineProperty(bytes, "toString", {
      value: () => {
        throw new Error("buffer-method-secret");
      },
    });
    expect(createBookingNumberGenerator(() => bytes).next(NOW)).toBe("SF20260730A1B2C3D4E5F6");
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
      { replayed: kind === "REPLAYED", booking },
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

  it("rejects a repository booking that is bound to another quote", async () => {
    const service = new BookingsService(
      createRepository({
        kind: "CREATED",
        booking: {
          ...booking,
          quote_id: "20000000-0000-4000-8000-000000000002",
        },
      }) as unknown as BookingRepository,
      createRateLimit() as unknown as WriteRateLimitService,
      { now: () => NOW },
      createGenerator("SF20260730A1B2C3D4E5F6"),
    );

    const error = await captureBusinessError(
      service.create(USER_ID, IDEMPOTENCY_KEY, { quote_id: QUOTE_ID }),
    );
    expect(error.getStatus()).toBe(503);
    expect(error.code).toBe("BOOKING_SERVICE_UNAVAILABLE");
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
      { replayed: false, booking },
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
  quoteId: QUOTE_ID,
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

const dateWithHostileOwnMethods = (value: string): Date => {
  const date = new Date(value);
  Object.defineProperties(date, {
    getTime: {
      value: () => {
        throw new Error("date-get-time-secret");
      },
    },
    toISOString: {
      value: () => {
        throw new Error("date-iso-secret");
      },
    },
  });
  return date;
};

const createBookingDatabase = (
  responses: unknown[],
  hooks: { onQuery?: (sql: string) => void; onTransactionEnd?: () => void } = {},
) => {
  let index = 0;
  const staged: string[] = [];
  const committed: string[] = [];
  let rollbackCount = 0;
  const transaction = {
    $queryRaw: vi.fn<(query: unknown) => Promise<unknown>>((query) => {
      const sql = (query as { sql?: string }).sql ?? "";
      hooks.onQuery?.(sql);
      if (/^\s*(?:UPDATE|INSERT)\b/.test(sql)) {
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
        } finally {
          hooks.onTransactionEnd?.();
        }
      },
    ),
    $queryRaw: vi.fn<(query: unknown) => Promise<unknown>>(),
  };
  return { database, transaction };
};

const queryText = (call: unknown[] | undefined) =>
  (call?.[0] as { sql?: string } | undefined)?.sql ?? "";

const repositoryFor = (database: BookingDatabase, clock: Clock = new FixedClock()) =>
  new BookingRepository(database, clock);

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
    const repository = repositoryFor(database as unknown as BookingDatabase);

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
    expect(sql[4]).toContain("FOR UPDATE OF property, room");
    expect(sql[5]).toContain("FROM daily_price price");
    expect(sql[5]).toContain('ORDER BY price."business_date" ASC');
    expect(sql[5]).toContain("FOR UPDATE OF price");
    expect(sql[5]).not.toContain("generate_series");
    expect(sql[5]).not.toContain("LEFT JOIN");
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

  it("keeps catalog and price locks until commit", async () => {
    let releaseHistory!: (value: unknown) => void;
    const history = new Promise<unknown>((resolve) => {
      releaseHistory = resolve;
    });
    let catalogLocked = false;
    let priceLocked = false;
    let releaseUpdate: (() => void) | undefined;
    const updatePassed = vi.fn();
    const attemptUpdate = () =>
      new Promise<void>((resolve) => {
        if (!catalogLocked && !priceLocked) {
          updatePassed();
          resolve();
          return;
        }
        releaseUpdate = () => {
          updatePassed();
          resolve();
        };
      });
    const { database, transaction } = createBookingDatabase(
      [
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
        history,
      ],
      {
        onQuery: (sql) => {
          if (sql.includes("FOR UPDATE OF property, room")) {
            catalogLocked = true;
          }
          if (sql.includes("FOR UPDATE OF price")) {
            priceLocked = true;
          }
        },
        onTransactionEnd: () => {
          catalogLocked = false;
          priceLocked = false;
          releaseUpdate?.();
        },
      },
    );
    const repository = repositoryFor(database as unknown as BookingDatabase);
    const bookingPromise = repository.createFromQuote(repositoryInput);
    await vi.waitFor(() => expect(transaction.$queryRaw).toHaveBeenCalledTimes(12));
    const updatePromise = attemptUpdate();
    await Promise.resolve();
    expect(updatePassed).not.toHaveBeenCalled();
    releaseHistory([{ id: "70000000-0000-4000-8000-000000000001" }]);
    await expect(bookingPromise).resolves.toEqual({ kind: "CREATED", booking });
    await updatePromise;
    expect(updatePassed).toHaveBeenCalledTimes(1);
  });

  it("replays under the advisory lock before reading or locking the quote", async () => {
    const { database, transaction } = createBookingDatabase([[{ locked: null }], [bookingRecord]]);
    const repository = repositoryFor(database as unknown as BookingDatabase);
    await expect(repository.createFromQuote(repositoryInput)).resolves.toEqual({
      kind: "REPLAYED",
      booking,
    });
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(2);
    expect(queryText(transaction.$queryRaw.mock.calls[0])).toContain("pg_advisory_xact_lock");
    expect(queryText(transaction.$queryRaw.mock.calls[1])).toContain("idempotency_key");
  });

  it.each([
    ["missing quote", [], undefined, [], "QUOTE_EXPIRED", 3],
    [
      "expired quote",
      [{ ...quoteRow, expiresAt: new Date("2026-07-30T02:00:00.000Z") }],
      [],
      [[currentBase], currentNightly],
      "QUOTE_EXPIRED",
      6,
    ],
    [
      "used quote",
      [quoteRow],
      [{ ...bookingRecord, idempotencyKey: `${IDEMPOTENCY_KEY}x` }],
      [],
      "QUOTE_ALREADY_USED",
      4,
    ],
  ])("maps %s before inventory access", async (_name, quoteRows, usedRows, extra, kind, calls) => {
    const responses: unknown[] = [[{ locked: null }], [], quoteRows];
    if (usedRows !== undefined) {
      responses.push(usedRows);
    }
    responses.push(...extra);
    const { database, transaction } = createBookingDatabase(responses);
    const repository = repositoryFor(database as unknown as BookingDatabase);
    await expect(repository.createFromQuote(repositoryInput)).resolves.toEqual({ kind });
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(calls);
  });

  it("projects the quote ID used by strict same-quote materialization", async () => {
    const { database, transaction } = createBookingDatabase([
      [{ locked: null }],
      [],
      [quoteRow],
      [{ ...bookingRecord, idempotencyKey: `${IDEMPOTENCY_KEY}x` }],
    ]);
    const repository = repositoryFor(database as unknown as BookingDatabase);

    await expect(repository.createFromQuote(repositoryInput)).resolves.toEqual({
      kind: "QUOTE_ALREADY_USED",
    });
    const usedBookingSql = queryText(transaction.$queryRaw.mock.calls[3]);
    expect(usedBookingSql).toContain('booking."quote_id"::text AS "quoteId"');
    expect(usedBookingSql).toContain('WHERE booking."quote_id" =');
  });

  it("treats a missing current price night as an expired quote without writes", async () => {
    const { database, transaction } = createBookingDatabase([
      [{ locked: null }],
      [],
      [quoteRow],
      [],
      [currentBase],
      currentNightly.slice(0, 1),
    ]);
    const repository = repositoryFor(database as unknown as BookingDatabase);
    await expect(repository.createFromQuote(repositoryInput)).resolves.toEqual({
      kind: "QUOTE_EXPIRED",
    });
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(6);
    expect(database.staged).toEqual([]);
    expect(database.committed).toEqual([]);
  });

  it("expires a quote crossed while waiting for catalog and price locks", async () => {
    const catalogNow = new Date("2026-07-30T02:05:00.000Z");
    const clock: Clock = { now: vi.fn(() => catalogNow) };
    const { database, transaction } = createBookingDatabase([
      [{ locked: null }],
      [],
      [quoteRow],
      [],
      [currentBase],
      currentNightly,
    ]);
    const repository = repositoryFor(database as unknown as BookingDatabase, clock);
    await expect(repository.createFromQuote(repositoryInput)).resolves.toEqual({
      kind: "QUOTE_EXPIRED",
    });
    expect(clock.now).toHaveBeenCalledTimes(1);
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(6);
    expect(database.staged).toEqual([]);
  });

  it("expires a quote crossed while waiting for inventory locks without writes", async () => {
    const transactionClock: Clock = {
      now: vi
        .fn<() => Date>()
        .mockReturnValueOnce(new Date("2026-07-30T02:04:59.999Z"))
        .mockReturnValueOnce(new Date("2026-07-30T02:05:00.000Z")),
    };
    const { database, transaction } = createBookingDatabase([
      [{ locked: null }],
      [],
      [quoteRow],
      [],
      [currentBase],
      currentNightly,
      inventoryRows,
    ]);
    const repository = repositoryFor(database as unknown as BookingDatabase, transactionClock);
    await expect(repository.createFromQuote(repositoryInput)).resolves.toEqual({
      kind: "QUOTE_EXPIRED",
    });
    expect(transactionClock.now).toHaveBeenCalledTimes(2);
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(7);
    expect(database.staged).toEqual([]);
    expect(database.committed).toEqual([]);
  });

  it("derives replacement expiry from the post-lock clock snapshot", async () => {
    const postLockNow = new Date("2026-07-30T02:01:00.000Z");
    const changedNightly = currentNightly.map((night, index) =>
      index === 0 ? { ...night, salePriceCents: 60_000 } : night,
    );
    const replacementRecord = {
      id: replacementQuote.quote_id,
      createdAt: postLockNow,
      expiresAt: new Date("2026-07-30T02:06:00.000Z"),
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
    const clock: Clock = { now: vi.fn(() => postLockNow) };
    const repository = repositoryFor(database as unknown as BookingDatabase, clock);
    const result = await repository.createFromQuote(repositoryInput);
    expect(result.kind).toBe("QUOTE_CHANGED");
    if (result.kind === "QUOTE_CHANGED") {
      expect(result.details.replacement_quote.expires_at).toBe("2026-07-30T02:06:00.000Z");
    }
    const insert = transaction.$queryRaw.mock.calls
      .map((call) => call[0] as { sql: string; values: unknown[] })
      .find((query) => query.sql.includes("INSERT INTO quote"));
    expect(insert?.values).toContainEqual(new Date("2026-07-30T02:06:00.000Z"));
    expect(clock.now).toHaveBeenCalledTimes(1);
  });

  it("uses separate catalog and booking snapshots for all write timestamps", async () => {
    const catalogNow = new Date("2026-07-30T02:01:00.000Z");
    const bookingNow = new Date("2026-07-30T02:02:00.000Z");
    const bookingExpiry = new Date("2026-07-30T02:17:00.000Z");
    const hostileBookingNow = new Date("2026-07-30T02:02:00.000Z");
    Object.defineProperty(hostileBookingNow, "getTime", {
      value: () => {
        throw new Error("clock-get-time-secret");
      },
    });
    const transactionClock: Clock = {
      now: vi
        .fn<() => Date>()
        .mockReturnValueOnce(catalogNow)
        .mockReturnValueOnce(hostileBookingNow),
    };
    const record = {
      ...bookingRecord,
      expiresAt: bookingExpiry,
      createdAt: bookingNow,
    };
    const { database, transaction } = createBookingDatabase([
      [{ locked: null }],
      [],
      [quoteRow],
      [],
      [currentBase],
      currentNightly,
      inventoryRows,
      [{ roomTypeId: ROOM_TYPE_ID }],
      [{ roomTypeId: ROOM_TYPE_ID }],
      [record],
      [{ bookingId: BOOKING_ID }, { bookingId: BOOKING_ID }],
      [{ id: "70000000-0000-4000-8000-000000000001" }],
    ]);
    const repository = repositoryFor(database as unknown as BookingDatabase, transactionClock);
    const result = await repository.createFromQuote(repositoryInput);
    expect(result.kind).toBe("CREATED");
    if (result.kind === "CREATED") {
      expect(result.booking.expires_at).toBe("2026-07-30T02:17:00.000Z");
    }
    const writeValues = transaction.$queryRaw.mock.calls
      .map((call) => call[0] as { sql: string; values: unknown[] })
      .filter((query) => /^\s*(?:UPDATE|INSERT)\b/.test(query.sql))
      .flatMap((query) => query.values);
    expect(writeValues.filter((value) => value instanceof Date)).not.toContainEqual(NOW);
    expect(writeValues).not.toContainEqual(catalogNow);
    expect(writeValues).toContainEqual(bookingNow);
    expect(writeValues).toContainEqual(bookingExpiry);
    expect(transactionClock.now).toHaveBeenCalledTimes(2);
    expect(writeValues).not.toContain(hostileBookingNow);
  });

  it.each([
    ["invalid", () => new Date(Number.NaN)],
    [
      "throwing",
      () => {
        throw new Error("clock-secret");
      },
    ],
  ])("rolls back an %s second clock and surfaces safe 503", async (_name, secondNow) => {
    const repositoryClock: Clock = {
      now: vi
        .fn<() => Date>()
        .mockReturnValueOnce(new Date("2026-07-30T02:04:00.000Z"))
        .mockImplementationOnce(secondNow),
    };
    const { database } = createBookingDatabase([
      [{ locked: null }],
      [],
      [quoteRow],
      [],
      [currentBase],
      currentNightly,
      inventoryRows,
    ]);
    const repository = repositoryFor(database as unknown as BookingDatabase, repositoryClock);
    const service = new BookingsService(
      repository,
      createRateLimit() as unknown as WriteRateLimitService,
      new FixedClock(),
      createGenerator("SF20260730A1B2C3D4E5F6"),
    );
    const error = await captureBusinessError(
      service.create(USER_ID, IDEMPOTENCY_KEY, { quote_id: QUOTE_ID }),
    );
    expect(error.getStatus()).toBe(503);
    expect(error.code).toBe("BOOKING_SERVICE_UNAVAILABLE");
    expect(database.rollbackCount).toBe(1);
    expect(database.staged).toEqual([]);
    expect(database.committed).toEqual([]);
    expect(repositoryClock.now).toHaveBeenCalledTimes(2);
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
    const repository = repositoryFor(database as unknown as BookingDatabase);
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
      const repository = repositoryFor(database as unknown as BookingDatabase);
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
    const repository = repositoryFor(database as unknown as BookingDatabase);
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
    const repository = repositoryFor(database as unknown as BookingDatabase);
    await expect(repository.createFromQuote(repositoryInput)).rejects.toThrow(
      "Unexpected booking repository data",
    );
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(3);
    await expect(
      repository.createFromQuote({ ...repositoryInput, idempotencyKey: "short" }),
    ).rejects.toThrow("Invalid booking repository input");
  });

  it("uses Date built-ins after validating database dates", async () => {
    const hostileQuote = {
      ...quoteRow,
      expiresAt: dateWithHostileOwnMethods("2026-07-30T02:05:00.000Z"),
    };
    const hostileBooking = {
      ...bookingRecord,
      expiresAt: dateWithHostileOwnMethods("2026-07-30T02:15:00.000Z"),
      createdAt: dateWithHostileOwnMethods("2026-07-30T02:00:00.000Z"),
    };
    const { database } = createBookingDatabase([
      [{ locked: null }],
      [],
      [hostileQuote],
      [],
      [currentBase],
      currentNightly,
      inventoryRows,
      [{ roomTypeId: ROOM_TYPE_ID }],
      [{ roomTypeId: ROOM_TYPE_ID }],
      [hostileBooking],
      [{ bookingId: BOOKING_ID }, { bookingId: BOOKING_ID }],
      [{ id: "70000000-0000-4000-8000-000000000001" }],
    ]);
    const repository = repositoryFor(database as unknown as BookingDatabase);
    await expect(repository.createFromQuote(repositoryInput)).resolves.toEqual({
      kind: "CREATED",
      booking,
    });
  });

  it("snapshots a stateful history row only once", async () => {
    let idReads = 0;
    const history = new Proxy(
      { id: "70000000-0000-4000-8000-000000000001" },
      {
        getOwnPropertyDescriptor: (target, key) => {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
          if (key !== "id" || descriptor === undefined) {
            return descriptor;
          }
          idReads += 1;
          return {
            ...descriptor,
            value: idReads === 1 ? "70000000-0000-4000-8000-000000000001" : "changed",
          };
        },
      },
    );
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
      [bookingRecord],
      [{ bookingId: BOOKING_ID }, { bookingId: BOOKING_ID }],
      [history],
    ]);
    const repository = repositoryFor(database as unknown as BookingDatabase);
    await expect(repository.createFromQuote(repositoryInput)).resolves.toEqual({
      kind: "CREATED",
      booking,
    });
    expect(idReads).toBe(1);
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

  const nestedRawUnique = (fields: unknown, overrides: Record<string, unknown> = {}) =>
    knownRequestError("P2010", {
      driverAdapterError: {
        cause: {
          originalCode: "23505",
          kind: "UniqueConstraintViolation",
          constraint: { fields },
          originalMessage:
            'duplicate key value violates unique constraint "booking_booking_number_key"',
          ...overrides,
        },
      },
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
    ["P2010 nested booking-number fields", nestedRawUnique(["booking_number"]), "booking_number"],
    [
      "P2010 flat trusted constraint compatibility",
      knownRequestError("P2010", {
        code: "23505",
        constraint: "booking_booking_number_key",
      }),
      "booking_number",
    ],
    [
      "P2010 nested idempotency fields",
      nestedRawUnique(["user_id", "idempotency_key"]),
      "idempotency",
    ],
    ["P2010 nested quote fields", nestedRawUnique(["quote_id"]), "quote"],
  ])("checks user/key after confirmed unique: %s", async (_name, error, classification) => {
    const { database } = createBookingDatabase([]);
    database.$transaction.mockRejectedValueOnce(error);
    database.$queryRaw.mockResolvedValueOnce([bookingRecord]);
    const repository = repositoryFor(database as unknown as BookingDatabase);

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
    const error = nestedRawUnique(["booking_number"]);
    const { database } = createBookingDatabase([]);
    database.$transaction.mockRejectedValueOnce(error);
    database.$queryRaw.mockResolvedValueOnce([]);
    const repository = repositoryFor(database as unknown as BookingDatabase);

    await expect(repository.createFromQuote(repositoryInput)).rejects.toBeInstanceOf(
      BookingNumberConflictError,
    );
    expect(database.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("makes exactly one full service retry for a raw P2010 booking-number conflict", async () => {
    const error = nestedRawUnique(["booking_number"]);
    const firstPostLockNow = new Date("2026-07-30T02:01:00.000Z");
    const secondPostLockNow = new Date("2026-07-30T02:02:00.000Z");
    const retriedRecord = {
      ...bookingRecord,
      bookingNumber: "SF20260730BBBBBBBBBBBB",
      expiresAt: new Date("2026-07-30T02:17:00.000Z"),
      createdAt: secondPostLockNow,
    };
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
      error,
      [{ locked: null }],
      [],
      [quoteRow],
      [],
      [currentBase],
      currentNightly,
      inventoryRows,
      [{ roomTypeId: ROOM_TYPE_ID }],
      [{ roomTypeId: ROOM_TYPE_ID }],
      [retriedRecord],
      [{ bookingId: BOOKING_ID }, { bookingId: BOOKING_ID }],
      [{ id: "70000000-0000-4000-8000-000000000001" }],
    ]);
    database.$queryRaw.mockResolvedValueOnce([]);
    const transactionClock: Clock = {
      now: vi
        .fn<() => Date>()
        .mockReturnValueOnce(NOW)
        .mockReturnValueOnce(firstPostLockNow)
        .mockReturnValueOnce(new Date("2026-07-30T02:01:30.000Z"))
        .mockReturnValueOnce(secondPostLockNow),
    };
    const repository = repositoryFor(database as unknown as BookingDatabase, transactionClock);
    const generator = createGenerator("SF20260730AAAAAAAAAAAA", "SF20260730BBBBBBBBBBBB");
    const service = new BookingsService(
      repository,
      createRateLimit() as unknown as WriteRateLimitService,
      { now: () => NOW },
      generator,
    );

    await expect(service.create(USER_ID, IDEMPOTENCY_KEY, { quote_id: QUOTE_ID })).resolves.toEqual(
      {
        replayed: false,
        booking: {
          ...booking,
          booking_number: "SF20260730BBBBBBBBBBBB",
          expires_at: "2026-07-30T02:17:00.000Z",
          created_at: "2026-07-30T02:02:00.000Z",
        },
      },
    );
    expect(database.$transaction).toHaveBeenCalledTimes(2);
    expect(database.$queryRaw).toHaveBeenCalledTimes(1);
    expect(generator.next).toHaveBeenCalledTimes(2);
    expect(transactionClock.now).toHaveBeenCalledTimes(4);
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
      "wrong nested kind",
      nestedRawUnique(["booking_number"], { kind: "ForeignKeyConstraintViolation" }),
    ],
    ["wrong nested SQLSTATE", nestedRawUnique(["booking_number"], { originalCode: "23503" })],
  ])("does not treat %s as a confirmed unique conflict", async (_name, error) => {
    const { database } = createBookingDatabase([]);
    database.$transaction.mockRejectedValueOnce(error);
    const repository = repositoryFor(database as unknown as BookingDatabase);
    await expect(repository.createFromQuote(repositoryInput)).rejects.toBe(error);
    expect(database.$queryRaw).not.toHaveBeenCalled();
  });

  it.each([
    ["inventory hold fields", nestedRawUnique(["booking_id", "business_date"])],
    ["unknown fields", nestedRawUnique(["unknown_unique_column"])],
    [
      "flat inventory-hold constraint",
      knownRequestError("P2010", {
        code: "23505",
        constraint: "inventory_hold_booking_id_business_date_key",
      }),
    ],
    [
      "flat unknown constraint",
      knownRequestError("P2010", {
        code: "23505",
        constraint: "some_other_unique_key",
      }),
    ],
    [
      "flat untrusted message",
      knownRequestError("P2010", {
        code: "23505",
        message: 'user input mentions "booking_booking_number_key"',
      }),
    ],
    ["flat missing constraint", knownRequestError("P2010", { code: "23505" })],
    ["P2002 unknown target", knownRequestError("P2002", { target: ["unknown_column"] })],
    ["P2002 missing target", knownRequestError("P2002", {})],
  ])("checks user/key for confirmed unique even when non-retryable: %s", async (_name, error) => {
    const { database } = createBookingDatabase([]);
    database.$transaction.mockRejectedValueOnce(error);
    database.$queryRaw.mockResolvedValueOnce([]);
    const repository = repositoryFor(database as unknown as BookingDatabase);
    await expect(repository.createFromQuote(repositoryInput)).rejects.toBe(error);
    expect(database.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "proxy driver",
      knownRequestError("P2010", {
        driverAdapterError: new Proxy(
          {},
          {
            getOwnPropertyDescriptor: () => {
              throw new Error("trap-secret");
            },
          },
        ),
      }),
    ],
    [
      "accessor cause",
      knownRequestError("P2010", {
        driverAdapterError: Object.defineProperty({}, "cause", {
          enumerable: true,
          get: () => ({ originalCode: "23505", kind: "UniqueConstraintViolation" }),
        }),
      }),
    ],
    [
      "malformed fields",
      nestedRawUnique(
        new Proxy([], {
          ownKeys: () => {
            throw new Error("fields-secret");
          },
        }),
      ),
    ],
  ])("rejects malformed nested P2010 without lookup: %s", async (_name, error) => {
    const { database } = createBookingDatabase([]);
    database.$transaction.mockRejectedValueOnce(error);
    const repository = repositoryFor(database as unknown as BookingDatabase);
    await expect(repository.createFromQuote(repositoryInput)).rejects.toBe(error);
    expect(database.$queryRaw).not.toHaveBeenCalled();
  });

  it("rolls back staged inventory and writes before classifying a raw unique violation", async () => {
    const unique = nestedRawUnique(["booking_number"]);
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
    const repository = repositoryFor(database as unknown as BookingDatabase);
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
  it("reuses the pricing rate limiter and registers create and query controllers", () => {
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
    expect(controllers ?? []).toEqual([
      BookingsController,
      BookingQueryController,
      BookingActionsController,
    ]);
  });
});

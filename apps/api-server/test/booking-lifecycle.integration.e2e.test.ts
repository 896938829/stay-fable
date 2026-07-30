import { randomBytes, randomUUID } from "node:crypto";

import { ConfigService } from "@nestjs/config";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { Clock } from "../src/common/clock/clock.js";
import type { WriteRateLimitService } from "../src/common/rate-limit/write-rate-limit.service.js";
import {
  BookingLifecycleRepository,
  type BookingLifecycleDatabase,
  type BookingLifecycleTransaction,
} from "../src/booking/booking-lifecycle.repository.js";
import { BookingLifecycleService } from "../src/booking/booking-lifecycle.service.js";
import {
  BookingQueryRepository,
  type BookingQueryDatabase,
} from "../src/booking/booking-query.repository.js";
import { BookingQueryService } from "../src/booking/booking-query.service.js";
import { MockPaymentService } from "../src/booking/mock-payment.service.js";
import type { PaymentNumberGenerator } from "../src/booking/payment-number.js";
import { DatabaseService } from "../src/database/database.service.js";
import { requireSafeDatabaseIntegrationUrl } from "./database/database-integration-guard.js";

const runDatabaseIntegration = process.env.RUN_DATABASE_INTEGRATION === "true";
const describeDatabase = runDatabaseIntegration ? describe : describe.skip;
const LIVE_NOW = new Date("2030-01-01T00:05:00.000Z");
const EXPIRES_AT = new Date("2030-01-01T00:15:00.000Z");
const EXPIRED_NOW = new Date(EXPIRES_AT);
const INITIAL_HISTORY_AT = new Date("2030-01-01T00:00:00.000Z");
const STARTING_HELD = 3;
const STARTING_SOLD = 1;
const STARTING_VERSION = 11;

type EnvironmentSnapshot = { present: boolean; value?: string };

interface PendingBookingFixture {
  bookingId: string;
  dates: string[];
  expiresAt: Date;
  roomTypeId: string;
  userId: string;
}

interface LifecycleState {
  bookingStatus: string;
  histories: Array<{
    actor_type: string;
    actor_user_id: string | null;
    from_status: string | null;
    reason: string;
    to_status: string;
  }>;
  holds: Array<{ business_date: string; status: string }>;
  inventories: Array<{
    business_date: string;
    held_inventory: number;
    sold_inventory: number;
    total_inventory: number;
    version: number;
  }>;
  payments: Array<{
    idempotency_key: string;
    requested_outcome: string;
    status: string;
  }>;
}

const snapshotEnvironment = (key: string): EnvironmentSnapshot =>
  Object.hasOwn(process.env, key) ? { present: true, value: process.env[key] } : { present: false };

const restoreEnvironment = (key: string, snapshot: EnvironmentSnapshot): void => {
  if (snapshot.present) {
    process.env[key] = snapshot.value;
  } else {
    delete process.env[key];
  }
};

const quoteSchema = (schemaName: string): string => {
  if (!/^booking_lifecycle_test_[0-9a-f]{16}$/.test(schemaName)) {
    throw new Error("Invalid generated booking lifecycle schema");
  }
  return `"${schemaName}"`;
};

const addUtcDays = (date: string, days: number): string => {
  const milliseconds = Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000;
  return new Date(milliseconds).toISOString().slice(0, 10);
};

const nextBookingNumber = (): string => `SF20300101${randomBytes(6).toString("hex").toUpperCase()}`;
const nextPaymentNumber = (): string =>
  `SFP20300101${randomBytes(6).toString("hex").toUpperCase()}`;
const nextIdempotencyKey = (): string => `key_${randomBytes(24).toString("hex")}`;

const clockAt = (instant: Date): Clock => ({
  now: () => new Date(Date.prototype.getTime.call(instant)),
});

const createBarrier = (participants: number, timeoutMilliseconds = 5_000) => {
  let arrivals = 0;
  let released = false;
  let resolveRelease!: () => void;
  let rejectRelease!: (error: Error) => void;
  const releasePromise = new Promise<void>((resolve, reject) => {
    resolveRelease = resolve;
    rejectRelease = reject;
  });
  const timer = setTimeout(() => {
    if (!released) {
      released = true;
      rejectRelease(new Error(`Lifecycle barrier timed out after ${timeoutMilliseconds}ms`));
    }
  }, timeoutMilliseconds);
  const release = (): void => {
    if (!released) {
      released = true;
      clearTimeout(timer);
      resolveRelease();
    }
  };
  return {
    async arrive(): Promise<void> {
      if (released) {
        return releasePromise;
      }
      arrivals += 1;
      if (arrivals === participants) {
        release();
      } else if (arrivals > participants) {
        throw new Error("Lifecycle barrier participant overflow");
      }
      return releasePromise;
    },
    release,
  };
};

const errorCode = (result: PromiseSettledResult<unknown>): string | undefined => {
  if (result.status !== "rejected" || typeof result.reason !== "object" || result.reason === null) {
    return undefined;
  }
  const descriptor = Reflect.getOwnPropertyDescriptor(result.reason, "code");
  return descriptor !== undefined && Object.hasOwn(descriptor, "value")
    ? String(descriptor.value)
    : undefined;
};

describeDatabase("booking lifecycle PostgreSQL races", () => {
  let adminPool: Pool | undefined;
  let database: DatabaseService | undefined;
  let originalDatabaseUrl: EnvironmentSnapshot | undefined;
  let schemaCreated = false;
  let schemaName: string | undefined;
  let sqlPool: Pool | undefined;

  const activeDatabase = (): DatabaseService => {
    if (database === undefined) {
      throw new Error("Lifecycle DatabaseService was not initialized");
    }
    return database;
  };

  const activeSql = (): Pool => {
    if (sqlPool === undefined) {
      throw new Error("Lifecycle SQL pool was not initialized");
    }
    return sqlPool;
  };

  const queryService = (
    now: Date,
    queryDatabase: BookingQueryDatabase = activeDatabase(),
  ): BookingQueryService =>
    new BookingQueryService(
      new BookingQueryRepository(queryDatabase),
      clockAt(now),
      new ConfigService({ ENABLE_MOCK_PAYMENT: true }),
    );

  const rateLimit = {
    checkBookingCancellation: () => Promise.resolve(),
    checkMockPayment: () => Promise.resolve(),
  } as unknown as WriteRateLimitService;

  const cancellationService = (
    repository: BookingLifecycleRepository,
    now: Date,
  ): BookingLifecycleService =>
    new BookingLifecycleService(repository, rateLimit, clockAt(now), queryService(now));

  const paymentService = (
    repository: BookingLifecycleRepository,
    now: Date,
  ): MockPaymentService => {
    const paymentNumbers: PaymentNumberGenerator = {
      next: () => nextPaymentNumber(),
    };
    return new MockPaymentService(
      repository,
      rateLimit,
      clockAt(now),
      paymentNumbers,
      queryService(now),
    );
  };

  const concurrentLifecycleDatabase = (participants: number) => {
    const barrier = createBarrier(participants);
    const wrapped: BookingLifecycleDatabase = {
      $transaction: (operation, options) =>
        activeDatabase().$transaction(async (transaction) => {
          let firstQuery = true;
          const concurrentTransaction: BookingLifecycleTransaction = {
            $queryRaw: async (query) => {
              if (firstQuery) {
                firstQuery = false;
                await barrier.arrive();
              }
              return transaction.$queryRaw(query);
            },
          };
          return operation(concurrentTransaction);
        }, options),
    };
    return { barrier, database: wrapped };
  };

  const createPendingBooking = async (
    input: {
      dates?: string[];
      expiresAt?: Date;
      userId?: string;
    } = {},
  ): Promise<PendingBookingFixture> => {
    const dates = input.dates ?? ["2031-03-01", "2031-03-02", "2031-03-03"];
    if (dates.length < 1) {
      throw new Error("Pending fixture requires at least one night");
    }
    for (const [index, date] of dates.entries()) {
      if (date !== addUtcDays(dates[0]!, index)) {
        throw new Error("Pending fixture dates must be consecutive");
      }
    }
    const bookingId = randomUUID();
    const userId = input.userId ?? randomUUID();
    const roomTypeId = randomUUID();
    const propertyId = randomUUID();
    const quoteId = randomUUID();
    const expiresAt = input.expiresAt ?? EXPIRES_AT;
    const nightlyPrices = dates.map((businessDate, index) => ({
      business_date: businessDate,
      sale_price_cents: 15_000 + index * 500,
      rack_price_cents: 18_000 + index * 500,
      currency: "CNY",
    }));
    const totalPrice = nightlyPrices.reduce((sum, night) => sum + night.sale_price_cents, 0);
    const checkout = addUtcDays(dates[0]!, dates.length);

    await activeSql().query(
      `
        INSERT INTO booking (
          id, user_id, quote_id, property_id, room_type_id, booking_number, status,
          checkin_date, checkout_date, guests, property_snapshot, room_type_snapshot,
          nightly_prices, booking_policy_snapshot, total_price_cents, currency,
          idempotency_key, expires_at, created_at, updated_at
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, 'PENDING_PAYMENT',
          $7::date, $8::date, 2, $9::jsonb, $10::jsonb,
          $11::jsonb, $12, $13, 'CNY',
          $14, $15, $16, $16
        )
      `,
      [
        bookingId,
        userId,
        quoteId,
        propertyId,
        roomTypeId,
        nextBookingNumber(),
        dates[0],
        checkout,
        JSON.stringify({ id: propertyId, name: "Lifecycle Race Hotel" }),
        JSON.stringify({
          id: roomTypeId,
          name: "Lifecycle Race Room",
          cover_url: "https://example.test/lifecycle-room.jpg",
        }),
        JSON.stringify(nightlyPrices),
        "Lifecycle integration booking policy",
        totalPrice,
        nextIdempotencyKey(),
        expiresAt,
        INITIAL_HISTORY_AT,
      ],
    );

    for (const date of dates) {
      await activeSql().query(
        `
          INSERT INTO daily_inventory (
            room_type_id, business_date, total_inventory, held_inventory,
            sold_inventory, version, updated_at
          ) VALUES ($1::uuid, $2::date, 8, $3, $4, $5, $6)
        `,
        [roomTypeId, date, STARTING_HELD, STARTING_SOLD, STARTING_VERSION, INITIAL_HISTORY_AT],
      );
      await activeSql().query(
        `
          INSERT INTO inventory_hold (
            booking_id, room_type_id, business_date, status,
            expires_at, created_at, updated_at
          ) VALUES ($1::uuid, $2::uuid, $3::date, 'HELD', $4, $5, $5)
        `,
        [bookingId, roomTypeId, date, expiresAt, INITIAL_HISTORY_AT],
      );
    }
    await activeSql().query(
      `
        INSERT INTO booking_status_history (
          booking_id, from_status, to_status, reason,
          actor_type, actor_user_id, created_at
        ) VALUES (
          $1::uuid, NULL, 'PENDING_PAYMENT', 'BOOKING_CREATED',
          'USER', $2::uuid, $3
        )
      `,
      [bookingId, userId, INITIAL_HISTORY_AT],
    );
    return { bookingId, dates: [...dates], expiresAt: new Date(expiresAt), roomTypeId, userId };
  };

  const readLifecycleState = async (fixture: PendingBookingFixture): Promise<LifecycleState> => {
    const booking = await activeSql().query<{ status: string }>(
      `SELECT status::text FROM booking WHERE id = $1::uuid`,
      [fixture.bookingId],
    );
    const holds = await activeSql().query<{ business_date: string; status: string }>(
      `
        SELECT business_date::text, status::text
        FROM inventory_hold
        WHERE booking_id = $1::uuid
        ORDER BY business_date, id
      `,
      [fixture.bookingId],
    );
    const inventories = await activeSql().query<LifecycleState["inventories"][number]>(
      `
        SELECT
          business_date::text, held_inventory, sold_inventory,
          total_inventory, version
        FROM daily_inventory
        WHERE room_type_id = $1::uuid
        ORDER BY business_date
      `,
      [fixture.roomTypeId],
    );
    const payments = await activeSql().query<LifecycleState["payments"][number]>(
      `
        SELECT idempotency_key, requested_outcome::text, status::text
        FROM payment
        WHERE booking_id = $1::uuid
        ORDER BY created_at, id
      `,
      [fixture.bookingId],
    );
    const histories = await activeSql().query<LifecycleState["histories"][number]>(
      `
        SELECT
          from_status::text, to_status::text, reason,
          actor_type::text, actor_user_id::text
        FROM booking_status_history
        WHERE booking_id = $1::uuid
        ORDER BY created_at, id
      `,
      [fixture.bookingId],
    );
    const bookingStatus = booking.rows[0]?.status;
    if (bookingStatus === undefined) {
      throw new Error("Lifecycle fixture booking disappeared");
    }
    return {
      bookingStatus,
      histories: histories.rows,
      holds: holds.rows,
      inventories: inventories.rows,
      payments: payments.rows,
    };
  };

  const expectInventoryDelta = (
    fixture: PendingBookingFixture,
    state: LifecycleState,
    holdStatus: "CONSUMED" | "RELEASED",
    soldDelta: 0 | 1,
  ): void => {
    expect(state.holds).toEqual(
      fixture.dates.map((businessDate) => ({ business_date: businessDate, status: holdStatus })),
    );
    expect(state.inventories).toEqual(
      fixture.dates.map((businessDate) => ({
        business_date: businessDate,
        held_inventory: STARTING_HELD - 1,
        sold_inventory: STARTING_SOLD + soldDelta,
        total_inventory: 8,
        version: STARTING_VERSION + 1,
      })),
    );
    expect(
      state.inventories.every(
        ({ held_inventory, sold_inventory, total_inventory }) =>
          held_inventory >= 0 &&
          sold_inventory >= 0 &&
          held_inventory + sold_inventory <= total_inventory,
      ),
    ).toBe(true);
  };

  const expectFinalInvariant = (
    fixture: PendingBookingFixture,
    state: LifecycleState,
    expected: "CANCELLED" | "CLOSED" | "CONFIRMED",
  ): void => {
    expect(state.bookingStatus).toBe(expected);
    const lifecycleHistory = state.histories.filter(({ from_status }) => from_status !== null);
    if (expected === "CONFIRMED") {
      expectInventoryDelta(fixture, state, "CONSUMED", 1);
      expect(state.payments).toHaveLength(1);
      expect(state.payments[0]).toMatchObject({
        requested_outcome: "SUCCEED",
        status: "SUCCEEDED",
      });
      expect(lifecycleHistory).toHaveLength(2);
      expect(lifecycleHistory).toEqual(
        expect.arrayContaining([
          {
            actor_type: "USER",
            actor_user_id: fixture.userId,
            from_status: "PENDING_PAYMENT",
            reason: "MOCK_PAYMENT_SUCCEEDED",
            to_status: "PAID",
          },
          {
            actor_type: "SYSTEM",
            actor_user_id: null,
            from_status: "PAID",
            reason: "PAYMENT_CONFIRMED",
            to_status: "CONFIRMED",
          },
        ]),
      );
      return;
    }

    expectInventoryDelta(fixture, state, "RELEASED", 0);
    expect(state.payments.filter(({ status }) => status === "SUCCEEDED")).toEqual([]);
    expect(lifecycleHistory).toHaveLength(1);
    expect(lifecycleHistory[0]).toEqual(
      expected === "CANCELLED"
        ? {
            actor_type: "USER",
            actor_user_id: fixture.userId,
            from_status: "PENDING_PAYMENT",
            reason: "USER_CANCELLED",
            to_status: "CANCELLED",
          }
        : {
            actor_type: "SYSTEM",
            actor_user_id: null,
            from_status: "PENDING_PAYMENT",
            reason: "PAYMENT_TIMEOUT",
            to_status: "CLOSED",
          },
    );
  };

  const insertListBooking = async (
    userId: string,
    bookingId: string,
    createdAt: Date,
  ): Promise<void> => {
    const propertyId = randomUUID();
    const roomTypeId = randomUUID();
    await activeSql().query(
      `
        INSERT INTO booking (
          id, user_id, quote_id, property_id, room_type_id, booking_number, status,
          checkin_date, checkout_date, guests, property_snapshot, room_type_snapshot,
          nightly_prices, booking_policy_snapshot, total_price_cents, currency,
          idempotency_key, expires_at, created_at, updated_at
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, 'CLOSED',
          DATE '2031-06-01', DATE '2031-06-02', 2, $7::jsonb, $8::jsonb,
          $9::jsonb, 'Cursor integration policy', 15000, 'CNY',
          $10, $11, $12, $12
        )
      `,
      [
        bookingId,
        userId,
        randomUUID(),
        propertyId,
        roomTypeId,
        nextBookingNumber(),
        JSON.stringify({ id: propertyId, name: "Cursor Hotel" }),
        JSON.stringify({
          id: roomTypeId,
          name: "Cursor Room",
          cover_url: "https://example.test/cursor-room.jpg",
        }),
        JSON.stringify([
          {
            business_date: "2031-06-01",
            sale_price_cents: 15_000,
            rack_price_cents: 18_000,
            currency: "CNY",
          },
        ]),
        nextIdempotencyKey(),
        new Date(createdAt.getTime() + 15 * 60_000),
        createdAt,
      ],
    );
  };

  beforeAll(async () => {
    originalDatabaseUrl = snapshotEnvironment("DATABASE_URL");
    const connectionString = requireSafeDatabaseIntegrationUrl(process.env.DATABASE_URL);
    adminPool = new Pool({ connectionString });
    schemaName = `booking_lifecycle_test_${randomBytes(8).toString("hex")}`;
    const quoted = quoteSchema(schemaName);
    await adminPool.query(`CREATE SCHEMA ${quoted}`);
    schemaCreated = true;
    for (const table of [
      "booking",
      "payment",
      "inventory_hold",
      "booking_status_history",
      "daily_inventory",
    ]) {
      await adminPool.query(
        `CREATE TABLE ${quoted}."${table}" (LIKE public."${table}" INCLUDING ALL)`,
      );
    }
    const scoped = new URL(connectionString);
    scoped.searchParams.set("schema", schemaName);
    scoped.searchParams.set("options", `-c search_path=${schemaName},public`);
    process.env.DATABASE_URL = scoped.toString();
    sqlPool = new Pool({ connectionString: scoped.toString(), max: 10 });
    database = new DatabaseService();
    await database.check();
  }, 25_000);

  afterAll(async () => {
    const cleanupDatabase = database;
    const cleanupSqlPool = sqlPool;
    const cleanupAdminPool = adminPool;
    const cleanupSchemaName = schemaName;
    const cleanupSchemaCreated = schemaCreated;
    const cleanupEnvironment = originalDatabaseUrl;
    database = undefined;
    sqlPool = undefined;
    adminPool = undefined;
    schemaName = undefined;
    schemaCreated = false;
    originalDatabaseUrl = undefined;

    const errors: unknown[] = [];
    for (const cleanup of [
      async () => cleanupDatabase?.onModuleDestroy(),
      async () => cleanupSqlPool?.end(),
      async () => {
        if (cleanupSchemaCreated) {
          if (cleanupAdminPool === undefined || cleanupSchemaName === undefined) {
            throw new Error("Lifecycle schema cleanup metadata is incomplete");
          }
          await cleanupAdminPool.query(`DROP SCHEMA ${quoteSchema(cleanupSchemaName)} CASCADE`);
        }
      },
      async () => cleanupAdminPool?.end(),
      () => {
        if (cleanupEnvironment !== undefined) {
          restoreEnvironment("DATABASE_URL", cleanupEnvironment);
        }
        return Promise.resolve();
      },
    ]) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Lifecycle integration cleanup failed");
    }
  });

  test("serializes successful payment against owner cancellation", async () => {
    const fixture = await createPendingBooking();
    const concurrent = concurrentLifecycleDatabase(2);
    const repository = new BookingLifecycleRepository(concurrent.database);
    let results: [PromiseSettledResult<unknown>, PromiseSettledResult<unknown>];
    try {
      results = await Promise.allSettled([
        paymentService(repository, LIVE_NOW).simulate(
          fixture.userId,
          fixture.bookingId,
          nextIdempotencyKey(),
          { outcome: "SUCCEED" },
        ),
        cancellationService(repository, LIVE_NOW).cancel(fixture.userId, fixture.bookingId, {}),
      ]);
    } finally {
      concurrent.barrier.release();
    }

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const state = await readLifecycleState(fixture);
    expect(["CANCELLED", "CONFIRMED"]).toContain(state.bookingStatus);
    expectFinalInvariant(fixture, state, state.bookingStatus as "CANCELLED" | "CONFIRMED");
    if (state.bookingStatus === "CONFIRMED") {
      expect(results[0].status).toBe("fulfilled");
      expect(errorCode(results[1])).toBe("BOOKING_NOT_CANCELLABLE");
    } else {
      expect(errorCode(results[0])).toBe("BOOKING_ALREADY_PROCESSED");
      expect(results[1].status).toBe("fulfilled");
    }
  }, 25_000);

  test("serializes successful payment against timeout release", async () => {
    const fixture = await createPendingBooking();
    const concurrent = concurrentLifecycleDatabase(2);
    const repository = new BookingLifecycleRepository(concurrent.database);
    let results: [PromiseSettledResult<unknown>, PromiseSettledResult<unknown>];
    try {
      results = await Promise.allSettled([
        paymentService(repository, LIVE_NOW).simulate(
          fixture.userId,
          fixture.bookingId,
          nextIdempotencyKey(),
          { outcome: "SUCCEED" },
        ),
        cancellationService(repository, EXPIRED_NOW).cancel(fixture.userId, fixture.bookingId, {}),
      ]);
    } finally {
      concurrent.barrier.release();
    }

    const state = await readLifecycleState(fixture);
    expect(["CLOSED", "CONFIRMED"]).toContain(state.bookingStatus);
    expectFinalInvariant(fixture, state, state.bookingStatus as "CLOSED" | "CONFIRMED");
    if (state.bookingStatus === "CONFIRMED") {
      expect(results[0].status).toBe("fulfilled");
      expect(errorCode(results[1])).toBe("BOOKING_NOT_CANCELLABLE");
    } else {
      expect(errorCode(results[0])).toBe("BOOKING_ALREADY_PROCESSED");
      expect(errorCode(results[1])).toBe("BOOKING_EXPIRED");
    }
  }, 25_000);

  test("coalesces two owner release transactions without duplicate decrements or history", async () => {
    const fixture = await createPendingBooking();
    const concurrent = concurrentLifecycleDatabase(2);
    const repository = new BookingLifecycleRepository(concurrent.database);
    let results: [
      PromiseSettledResult<{ replayed: boolean }>,
      PromiseSettledResult<{ replayed: boolean }>,
    ];
    try {
      results = await Promise.allSettled([
        cancellationService(repository, LIVE_NOW).cancel(fixture.userId, fixture.bookingId, {}),
        cancellationService(repository, LIVE_NOW).cancel(fixture.userId, fixture.bookingId, {}),
      ]);
    } finally {
      concurrent.barrier.release();
    }

    expect(results.every(({ status }) => status === "fulfilled")).toBe(true);
    const replayed = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value.replayed] : [],
    );
    expect(replayed.sort()).toEqual([false, true]);
    expectFinalInvariant(fixture, await readLifecycleState(fixture), "CANCELLED");
  }, 25_000);

  test("serializes the same payment key with different outcomes into one canonical row", async () => {
    const fixture = await createPendingBooking();
    const concurrent = concurrentLifecycleDatabase(2);
    const repository = new BookingLifecycleRepository(concurrent.database);
    const key = nextIdempotencyKey();
    let results: [PromiseSettledResult<unknown>, PromiseSettledResult<unknown>];
    try {
      results = await Promise.allSettled([
        paymentService(repository, LIVE_NOW).simulate(fixture.userId, fixture.bookingId, key, {
          outcome: "SUCCEED",
        }),
        paymentService(repository, LIVE_NOW).simulate(fixture.userId, fixture.bookingId, key, {
          outcome: "FAIL",
        }),
      ]);
    } finally {
      concurrent.barrier.release();
    }

    const state = await readLifecycleState(fixture);
    expect(state.payments).toHaveLength(1);
    expect(state.payments[0]?.idempotency_key).toBe(key);
    const codes = results.map(errorCode);
    expect(codes).toContain("IDEMPOTENCY_KEY_REUSED");
    if (state.payments[0]?.status === "SUCCEEDED") {
      expect(state.payments[0]?.requested_outcome).toBe("SUCCEED");
      expect(results[0].status).toBe("fulfilled");
      expectFinalInvariant(fixture, state, "CONFIRMED");
    } else {
      expect(state.payments[0]).toMatchObject({
        requested_outcome: "FAIL",
        status: "FAILED",
      });
      expect(errorCode(results[1])).toBe("MOCK_PAYMENT_FAILED");
      expect(state.bookingStatus).toBe("PENDING_PAYMENT");
      expect(state.holds.every(({ status }) => status === "HELD")).toBe(true);
      expect(state.inventories).toEqual(
        fixture.dates.map((businessDate) => ({
          business_date: businessDate,
          held_inventory: STARTING_HELD,
          sold_inventory: STARTING_SOLD,
          total_inventory: 8,
          version: STARTING_VERSION,
        })),
      );
      expect(state.histories).toHaveLength(1);
    }
  }, 25_000);

  test("hides another owner's payment, cancellation, and detail without changing data", async () => {
    const fixture = await createPendingBooking();
    const otherUserId = randomUUID();
    const before = await readLifecycleState(fixture);
    const repository = new BookingLifecycleRepository(activeDatabase());

    await expect(
      repository.simulateMockPayment({
        userId: otherUserId,
        bookingId: fixture.bookingId,
        idempotencyKey: nextIdempotencyKey(),
        outcome: "SUCCEED",
        paymentNumber: nextPaymentNumber(),
        now: LIVE_NOW,
      }),
    ).resolves.toEqual({ kind: "NOT_FOUND" });
    await expect(
      paymentService(repository, LIVE_NOW).simulate(
        otherUserId,
        fixture.bookingId,
        nextIdempotencyKey(),
        { outcome: "SUCCEED" },
      ),
    ).rejects.toMatchObject({ status: 404, code: "BOOKING_NOT_FOUND" });
    await expect(
      cancellationService(repository, LIVE_NOW).cancel(otherUserId, fixture.bookingId, {}),
    ).rejects.toMatchObject({ status: 404, code: "BOOKING_NOT_FOUND" });
    await expect(
      queryService(LIVE_NOW).getOwned(otherUserId, fixture.bookingId),
    ).rejects.toMatchObject({ status: 404, code: "BOOKING_NOT_FOUND" });

    expect(await readLifecycleState(fixture)).toEqual(before);
  }, 25_000);

  test("paginates the real DESC tuple without gaps, duplicates, or cross-owner rows", async () => {
    const owner = randomUUID();
    const otherOwner = randomUUID();
    const rows = [
      {
        id: "71000000-0000-4000-8000-000000000003",
        createdAt: new Date("2030-02-03T00:00:00.000Z"),
      },
      {
        id: "71000000-0000-4000-8000-000000000002",
        createdAt: new Date("2030-02-03T00:00:00.000Z"),
      },
      {
        id: "71000000-0000-4000-8000-000000000001",
        createdAt: new Date("2030-02-02T00:00:00.000Z"),
      },
      {
        id: "71000000-0000-4000-8000-000000000005",
        createdAt: new Date("2030-02-01T00:00:00.000Z"),
      },
      {
        id: "71000000-0000-4000-8000-000000000004",
        createdAt: new Date("2030-02-01T00:00:00.000Z"),
      },
    ];
    for (const row of rows) {
      await insertListBooking(owner, row.id, row.createdAt);
    }
    await insertListBooking(
      otherOwner,
      "72000000-0000-4000-8000-000000000001",
      new Date("2030-02-04T00:00:00.000Z"),
    );

    const service = queryService(LIVE_NOW);
    const collected: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await service.listOwned(owner, {
        limit: 2,
        ...(cursor === null ? {} : { cursor }),
      });
      collected.push(...page.items.map(({ booking_id }) => booking_id));
      cursor = page.next_cursor;
    } while (cursor !== null);

    expect(collected).toEqual(rows.map(({ id }) => id));
    expect(new Set(collected).size).toBe(rows.length);
    expect(collected).not.toContain("72000000-0000-4000-8000-000000000001");

    let databaseCalls = 0;
    const rejectingDatabase = {
      $queryRaw: () => {
        databaseCalls += 1;
        throw new Error("Invalid cursor reached the database");
      },
      $transaction: () => {
        databaseCalls += 1;
        throw new Error("Invalid cursor opened a transaction");
      },
    } as unknown as BookingQueryDatabase;
    await expect(
      queryService(LIVE_NOW, rejectingDatabase).listOwned(owner, {
        limit: 2,
        cursor: "%%%",
      }),
    ).rejects.toMatchObject({ status: 400, code: "ORDER_CURSOR_INVALID" });
    expect(databaseCalls).toBe(0);
  }, 25_000);

  test("commits every night and exact history chain for success and release paths", async () => {
    const dates = ["2031-08-27", "2031-08-28", "2031-08-29", "2031-08-30"];
    const confirmed = await createPendingBooking({ dates });
    const cancelled = await createPendingBooking({ dates });
    const repository = new BookingLifecycleRepository(activeDatabase());

    await expect(
      paymentService(repository, LIVE_NOW).simulate(
        confirmed.userId,
        confirmed.bookingId,
        nextIdempotencyKey(),
        { outcome: "SUCCEED" },
      ),
    ).resolves.toMatchObject({ replayed: false, booking: { status: "CONFIRMED" } });
    await expect(
      cancellationService(repository, LIVE_NOW).cancel(cancelled.userId, cancelled.bookingId, {}),
    ).resolves.toMatchObject({ replayed: false, booking: { status: "CANCELLED" } });

    expectFinalInvariant(confirmed, await readLifecycleState(confirmed), "CONFIRMED");
    expectFinalInvariant(cancelled, await readLifecycleState(cancelled), "CANCELLED");
  }, 25_000);
});

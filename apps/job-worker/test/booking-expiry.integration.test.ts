import { randomBytes, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { BookingExpiryRepository } from "../src/booking-expiry.repository.js";
import { BookingExpirySweeper } from "../src/booking-expiry.sweeper.js";

const runDatabaseIntegration = process.env.RUN_DATABASE_INTEGRATION === "true";
const describeDatabase = runDatabaseIntegration ? describe : describe.skip;
const NOW = new Date("2030-01-01T00:20:00.000Z");
const CONNECTION_TIMEOUT_MS = 5_000;
const QUERY_TIMEOUT_MS = 20_000;

const safeDatabaseUrl = (value: string | undefined): string => {
  try {
    if (value === undefined) {
      throw new Error();
    }
    const parsed = new URL(value);
    const databaseName = decodeURIComponent(parsed.pathname.slice(1));
    if (
      parsed.protocol !== "postgresql:" ||
      !["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname) ||
      (!databaseName.endsWith("_test") && !databaseName.endsWith("_ci")) ||
      databaseName.includes("/")
    ) {
      throw new Error();
    }
    return value;
  } catch {
    throw new Error("Unsafe worker database integration URL");
  }
};

const quoteSchema = (schemaName: string): string => {
  if (!/^booking_expiry_test_[0-9a-f]{16}$/.test(schemaName)) {
    throw new Error("Invalid generated booking expiry schema");
  }
  return `"${schemaName}"`;
};

const boundedPool = (connectionString: string, maximum = 4): Pool =>
  new Pool({
    connectionString,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    max: maximum,
  });

const scopedDatabaseUrl = (
  connectionString: string,
  schemaName: string,
  lockTimeoutMs = 10_000,
  statementTimeoutMs = 15_000,
): string => {
  const scoped = new URL(connectionString);
  scoped.searchParams.set(
    "options",
    [
      `-c search_path=${schemaName},public`,
      `-c statement_timeout=${statementTimeoutMs}`,
      `-c lock_timeout=${lockTimeoutMs}`,
      "-c idle_in_transaction_session_timeout=20000",
    ].join(" "),
  );
  return scoped.toString();
};

interface BookingFixture {
  bookingId: string;
  bookingNumber: string;
  dates: string[];
  roomTypeId: string;
}

interface BookingState {
  bookingStatus: string;
  heldInventory: number[];
  historyCount: number;
  holdStatuses: string[];
}

describeDatabase("booking expiry PostgreSQL workers", () => {
  let adminPool: Pool | undefined;
  let schemaCreated = false;
  let schemaName: string | undefined;
  let workerPoolA: Pool | undefined;
  let workerPoolB: Pool | undefined;
  let workerProbePool: Pool | undefined;

  const activeWorkerA = (): Pool => {
    if (workerPoolA === undefined) {
      throw new Error("Booking expiry worker A pool was not initialized");
    }
    return workerPoolA;
  };

  const activeWorkerB = (): Pool => {
    if (workerPoolB === undefined) {
      throw new Error("Booking expiry worker B pool was not initialized");
    }
    return workerPoolB;
  };

  const activeWorkerProbe = (): Pool => {
    if (workerProbePool === undefined) {
      throw new Error("Booking expiry probe pool was not initialized");
    }
    return workerProbePool;
  };

  const seedExpiredBooking = async (expiredMinutesAgo = 5): Promise<BookingFixture> => {
    const bookingId = randomUUID();
    const roomTypeId = randomUUID();
    const bookingNumber = `SF20300101${randomBytes(6).toString("hex").toUpperCase()}`;
    const dates = ["2030-02-01", "2030-02-02"];
    await activeWorkerA().query(
      `
        INSERT INTO "booking" (
          "id", "user_id", "quote_id", "property_id", "room_type_id",
          "booking_number", "status", "checkin_date", "checkout_date", "guests",
          "property_snapshot", "room_type_snapshot", "nightly_prices",
          "booking_policy_snapshot", "total_price_cents", "currency",
          "idempotency_key", "expires_at", "created_at", "updated_at"
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
          $6, 'PENDING_PAYMENT', $7::date, $8::date, 1,
          '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
          '{}', 30000, 'CNY',
          $9, $10, $11, $11
        )
      `,
      [
        bookingId,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        roomTypeId,
        bookingNumber,
        dates[0],
        "2030-02-03",
        `key_${randomBytes(20).toString("hex")}`,
        new Date(NOW.getTime() - expiredMinutesAgo * 60_000),
        new Date(NOW.getTime() - 30 * 60_000),
      ],
    );
    for (const date of dates) {
      await activeWorkerA().query(
        `
          INSERT INTO "daily_inventory" (
            "room_type_id", "business_date", "total_inventory",
            "held_inventory", "sold_inventory", "version", "updated_at"
          ) VALUES ($1::uuid, $2::date, 3, 1, 1, 7, $3)
        `,
        [roomTypeId, date, new Date(NOW.getTime() - 30 * 60_000)],
      );
      await activeWorkerA().query(
        `
          INSERT INTO "inventory_hold" (
            "booking_id", "room_type_id", "business_date",
            "status", "expires_at", "created_at", "updated_at"
          ) VALUES (
            $1::uuid, $2::uuid, $3::date,
            'HELD', $4, $5, $5
          )
        `,
        [
          bookingId,
          roomTypeId,
          date,
          new Date(NOW.getTime() - expiredMinutesAgo * 60_000),
          new Date(NOW.getTime() - 30 * 60_000),
        ],
      );
    }
    return { bookingId, bookingNumber, dates, roomTypeId };
  };

  const readState = async (fixture: BookingFixture): Promise<BookingState> => {
    const booking = await activeWorkerA().query<{ status: string }>(
      `SELECT "status"::text AS "status" FROM "booking" WHERE "id" = $1::uuid`,
      [fixture.bookingId],
    );
    const inventories = await activeWorkerA().query<{ heldInventory: number }>(
      `
        SELECT "held_inventory" AS "heldInventory"
        FROM "daily_inventory"
        WHERE "room_type_id" = $1::uuid
        ORDER BY "business_date" ASC
      `,
      [fixture.roomTypeId],
    );
    const holds = await activeWorkerA().query<{ status: string }>(
      `
        SELECT "status"::text AS "status"
        FROM "inventory_hold"
        WHERE "booking_id" = $1::uuid
        ORDER BY "business_date" ASC
      `,
      [fixture.bookingId],
    );
    const history = await activeWorkerA().query<{ count: number }>(
      `
        SELECT count(*)::integer AS "count"
        FROM "booking_status_history"
        WHERE "booking_id" = $1::uuid
          AND "from_status" = 'PENDING_PAYMENT'
          AND "to_status" = 'CLOSED'
          AND "reason" = 'PAYMENT_TIMEOUT'
          AND "actor_type" = 'SYSTEM'
          AND "actor_user_id" IS NULL
      `,
      [fixture.bookingId],
    );
    return {
      bookingStatus: booking.rows[0]?.status ?? "",
      heldInventory: inventories.rows.map(({ heldInventory }) => heldInventory),
      historyCount: history.rows[0]?.count ?? -1,
      holdStatuses: holds.rows.map(({ status }) => status),
    };
  };

  beforeAll(async () => {
    const connectionString = safeDatabaseUrl(process.env.DATABASE_URL);
    adminPool = boundedPool(scopedDatabaseUrl(connectionString, "public"), 1);
    schemaName = `booking_expiry_test_${randomBytes(8).toString("hex")}`;
    const quoted = quoteSchema(schemaName);
    await adminPool.query(`CREATE SCHEMA ${quoted}`);
    schemaCreated = true;
    for (const table of [
      "booking",
      "inventory_hold",
      "daily_inventory",
      "booking_status_history",
    ]) {
      await adminPool.query(
        `CREATE TABLE ${quoted}."${table}" (LIKE public."${table}" INCLUDING ALL)`,
      );
    }
    const scoped = scopedDatabaseUrl(connectionString, schemaName);
    workerPoolA = boundedPool(scoped);
    workerPoolB = boundedPool(scoped);
    workerProbePool = boundedPool(scopedDatabaseUrl(connectionString, schemaName, 250, 1_000), 1);
    await Promise.all([
      workerPoolA.query("SELECT 1"),
      workerPoolB.query("SELECT 1"),
      workerProbePool.query("SELECT 1"),
    ]);
  }, 25_000);

  afterEach(async () => {
    if (workerPoolA !== undefined) {
      await workerPoolA.query(
        `TRUNCATE "booking_status_history", "inventory_hold", "booking", "daily_inventory"`,
      );
    }
  });

  afterAll(async () => {
    const cleanupWorkerA = workerPoolA;
    const cleanupWorkerB = workerPoolB;
    const cleanupAdmin = adminPool;
    const cleanupWorkerProbe = workerProbePool;
    const cleanupSchemaName = schemaName;
    const cleanupSchemaCreated = schemaCreated;
    workerPoolA = undefined;
    workerPoolB = undefined;
    adminPool = undefined;
    workerProbePool = undefined;
    schemaName = undefined;
    schemaCreated = false;

    const errors: unknown[] = [];
    for (const cleanup of [
      async () => cleanupWorkerA?.end(),
      async () => cleanupWorkerB?.end(),
      async () => cleanupWorkerProbe?.end(),
      async () => {
        if (cleanupSchemaCreated) {
          if (cleanupAdmin === undefined || cleanupSchemaName === undefined) {
            throw new Error("Booking expiry cleanup metadata is incomplete");
          }
          await cleanupAdmin.query(`DROP SCHEMA ${quoteSchema(cleanupSchemaName)} CASCADE`);
        }
      },
      async () => cleanupAdmin?.end(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Booking expiry integration cleanup failed");
    }
  });

  test("two workers release one expired booking once and can process the next booking", async () => {
    const first = await seedExpiredBooking();
    const workerA = new BookingExpiryRepository(activeWorkerA());
    const workerB = new BookingExpiryRepository(activeWorkerB());

    const firstResults = await Promise.all([
      workerA.closeNextExpired(NOW),
      workerB.closeNextExpired(NOW),
    ]);

    expect(firstResults).toEqual(
      expect.arrayContaining([
        { kind: "CLOSED", bookingNumber: first.bookingNumber },
        { kind: "NONE" },
      ]),
    );
    expect(await readState(first)).toEqual({
      bookingStatus: "CLOSED",
      heldInventory: [0, 0],
      historyCount: 1,
      holdStatuses: ["RELEASED", "RELEASED"],
    });

    await expect(
      Promise.all([workerA.closeNextExpired(NOW), workerB.closeNextExpired(NOW)]),
    ).resolves.toEqual([{ kind: "NONE" }, { kind: "NONE" }]);
    expect((await readState(first)).historyCount).toBe(1);

    const second = await seedExpiredBooking();
    await expect(workerB.closeNextExpired(NOW)).resolves.toEqual({
      kind: "CLOSED",
      bookingNumber: second.bookingNumber,
    });
    expect(await readState(second)).toEqual({
      bookingStatus: "CLOSED",
      heldInventory: [0, 0],
      historyCount: 1,
      holdStatuses: ["RELEASED", "RELEASED"],
    });
  }, 25_000);

  test("one poisoned booking does not starve the next healthy booking in the same tick", async () => {
    const poisoned = await seedExpiredBooking(15);
    await activeWorkerA().query(
      `
        DELETE FROM "inventory_hold"
        WHERE "booking_id" = $1::uuid
          AND "business_date" = $2::date
      `,
      [poisoned.bookingId, poisoned.dates[1]],
    );
    const healthy = await seedExpiredBooking(10);
    const logger = { error: vi.fn(), info: vi.fn() };
    const sweeper = new BookingExpirySweeper(
      new BookingExpiryRepository(activeWorkerA()),
      { now: () => new Date(NOW) },
      { setInterval: vi.fn(), clearInterval: vi.fn() },
      5_000,
      logger,
    );

    await sweeper.tick();

    expect(await readState(poisoned)).toEqual({
      bookingStatus: "PENDING_PAYMENT",
      heldInventory: [1, 1],
      historyCount: 0,
      holdStatuses: ["HELD"],
    });
    expect(await readState(healthy)).toEqual({
      bookingStatus: "CLOSED",
      heldInventory: [0, 0],
      historyCount: 1,
      holdStatuses: ["RELEASED", "RELEASED"],
    });
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      { failedCount: 1, processedCount: 1 },
      "booking expiry sweep completed",
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(poisoned.bookingId);
  }, 25_000);

  test("SKIP LOCKED selects the next booking while the earliest row is externally locked", async () => {
    const locked = await seedExpiredBooking(15);
    const available = await seedExpiredBooking(10);
    const locker = await activeWorkerA().connect();
    try {
      await locker.query("BEGIN");
      await locker.query(`SELECT "id" FROM "booking" WHERE "id" = $1::uuid FOR UPDATE`, [
        locked.bookingId,
      ]);

      await expect(
        new BookingExpiryRepository(activeWorkerProbe()).closeNextExpired(NOW),
      ).resolves.toEqual({
        kind: "CLOSED",
        bookingNumber: available.bookingNumber,
      });

      expect(await readState(locked)).toEqual({
        bookingStatus: "PENDING_PAYMENT",
        heldInventory: [1, 1],
        historyCount: 0,
        holdStatuses: ["HELD", "HELD"],
      });
      expect((await readState(available)).bookingStatus).toBe("CLOSED");
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
  }, 25_000);
});

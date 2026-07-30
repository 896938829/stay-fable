import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { BookingNumberGenerator } from "../../src/booking/booking-number.js";
import {
  BookingRepository,
  type BookingDatabase,
  type BookingTransaction,
  type CreateBookingInput,
  type CreateBookingResult,
} from "../../src/booking/booking.repository.js";
import { BookingsService } from "../../src/booking/bookings.service.js";
import type { Clock } from "../../src/common/clock/clock.js";
import type { WriteRateLimitService } from "../../src/common/rate-limit/write-rate-limit.service.js";
import { DatabaseService } from "../../src/database/database.service.js";
import { Prisma } from "../../src/generated/prisma/client.js";
import { createQuoteFingerprint } from "../../src/pricing/quote-fingerprint.js";
import { QuoteRepository } from "../../src/pricing/quote.repository.js";
import { requireSafeDatabaseIntegrationUrl } from "./database-integration-guard.js";

const runDatabaseIntegration = process.env.RUN_DATABASE_INTEGRATION === "true";
const describeDatabase = runDatabaseIntegration ? describe : describe.skip;
const suiteName = runDatabaseIntegration
  ? "quote booking PostgreSQL persistence contract"
  : "quote booking PostgreSQL persistence contract (set RUN_DATABASE_INTEGRATION=true to run)";
const targetMigration = fileURLToPath(
  new URL("../../prisma/migrations/202607300001_quote_booking_hold/migration.sql", import.meta.url),
);

const quoteGeneratedTestSchema = (schemaName: string): string => {
  if (!/^quote_booking_test_[0-9a-f]{16}$/.test(schemaName)) {
    throw new Error("Invalid generated quote booking test schema");
  }
  return `"${schemaName}"`;
};

type EnvironmentVariableSnapshot =
  { present: false } | { present: true; value: string | undefined };

const snapshotEnvironmentVariable = (
  environment: Record<string, string | undefined>,
  key: string,
): EnvironmentVariableSnapshot =>
  Object.prototype.hasOwnProperty.call(environment, key)
    ? { present: true, value: environment[key] }
    : { present: false };

const restoreEnvironmentVariable = (
  environment: Record<string, string | undefined>,
  key: string,
  snapshot: EnvironmentVariableSnapshot,
): void => {
  if (snapshot.present) {
    environment[key] = snapshot.value;
  } else {
    delete environment[key];
  }
};

const runBestEffortCleanup = async (
  message: string,
  steps: Array<() => Promise<void> | void>,
): Promise<void> => {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, message);
  }
};

type SqlMigrationScan = {
  hasExplicitDownMarker: boolean;
  statements: string[];
};

const dollarQuoteAt = (sql: string, offset: number): string | undefined =>
  /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(offset))?.[0];

const scanSqlMigration = (sql: string): SqlMigrationScan => {
  const statements: string[] = [];
  let current = "";
  let hasExplicitDownMarker = false;
  let state: "dollar" | "double" | "normal" | "single" = "normal";
  let dollarDelimiter = "";

  const finishStatement = (): void => {
    const statement = current.trim();
    if (statement.length > 0) {
      statements.push(statement);
    }
    current = "";
  };

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index] ?? "";
    const nextCharacter = sql[index + 1];

    if (state === "single") {
      current += character;
      if (character === "'" && nextCharacter === "'") {
        current += nextCharacter;
        index += 1;
      } else if (character === "'") {
        state = "normal";
      }
      continue;
    }
    if (state === "double") {
      current += character;
      if (character === '"' && nextCharacter === '"') {
        current += nextCharacter;
        index += 1;
      } else if (character === '"') {
        state = "normal";
      }
      continue;
    }
    if (state === "dollar") {
      if (sql.startsWith(dollarDelimiter, index)) {
        current += dollarDelimiter;
        index += dollarDelimiter.length - 1;
        state = "normal";
      } else {
        current += character;
      }
      continue;
    }

    if (character === "-" && nextCharacter === "-") {
      const newlineIndex = sql.indexOf("\n", index + 2);
      const commentEnd = newlineIndex === -1 ? sql.length : newlineIndex;
      const comment = sql.slice(index + 2, commentEnd);
      hasExplicitDownMarker ||= /^\s*(?:\+?migrate:\s*)?down\b/i.test(comment);
      current += newlineIndex === -1 ? " " : "\n";
      index = newlineIndex === -1 ? sql.length : newlineIndex;
      continue;
    }
    if (character === "/" && nextCharacter === "*") {
      let depth = 1;
      let commentEnd = index + 2;
      while (commentEnd < sql.length && depth > 0) {
        if (sql.startsWith("/*", commentEnd)) {
          depth += 1;
          commentEnd += 2;
        } else if (sql.startsWith("*/", commentEnd)) {
          depth -= 1;
          commentEnd += 2;
        } else {
          commentEnd += 1;
        }
      }
      const comment = sql.slice(index + 2, Math.max(index + 2, commentEnd - 2));
      hasExplicitDownMarker ||= /^\s*(?:\+?migrate:\s*)?down\b/i.test(comment);
      current += " ";
      index = commentEnd - 1;
      continue;
    }
    if (character === "'") {
      current += character;
      state = "single";
      continue;
    }
    if (character === '"') {
      current += character;
      state = "double";
      continue;
    }
    if (character === "$") {
      const delimiter = dollarQuoteAt(sql, index);
      if (delimiter !== undefined) {
        current += delimiter;
        dollarDelimiter = delimiter;
        state = "dollar";
        index += delimiter.length - 1;
        continue;
      }
    }
    if (character === ";") {
      finishStatement();
      continue;
    }
    current += character;
  }

  finishStatement();
  return { hasExplicitDownMarker, statements };
};

const unquotedSqlWords = (statement: string): string[] => {
  const words: string[] = [];
  let state: "dollar" | "double" | "normal" | "single" = "normal";
  let dollarDelimiter = "";

  for (let index = 0; index < statement.length; index += 1) {
    const character = statement[index] ?? "";
    const nextCharacter = statement[index + 1];
    if (state === "single") {
      if (character === "'" && nextCharacter === "'") {
        index += 1;
      } else if (character === "'") {
        state = "normal";
      }
      continue;
    }
    if (state === "double") {
      if (character === '"' && nextCharacter === '"') {
        index += 1;
      } else if (character === '"') {
        state = "normal";
      }
      continue;
    }
    if (state === "dollar") {
      if (statement.startsWith(dollarDelimiter, index)) {
        index += dollarDelimiter.length - 1;
        state = "normal";
      }
      continue;
    }
    if (character === "'") {
      state = "single";
      continue;
    }
    if (character === '"') {
      state = "double";
      continue;
    }
    if (character === "$") {
      const delimiter = dollarQuoteAt(statement, index);
      if (delimiter !== undefined) {
        dollarDelimiter = delimiter;
        state = "dollar";
        index += delimiter.length - 1;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(character)) {
      let wordEnd = index + 1;
      while (wordEnd < statement.length && /[A-Za-z0-9_$]/.test(statement[wordEnd] ?? "")) {
        wordEnd += 1;
      }
      words.push(statement.slice(index, wordEnd).toUpperCase());
      index = wordEnd - 1;
    }
  }
  return words;
};

const isAllowedMigrationStatement = (statement: string): boolean => {
  const words = unquotedSqlWords(statement);
  if (words[0] === "ALTER" && words[1] === "TABLE") {
    return true;
  }
  if (words[0] !== "CREATE") {
    return false;
  }
  if (words[1] === "TYPE" || words[1] === "INDEX") {
    return true;
  }
  if (words[1] === "UNIQUE" && words[2] === "INDEX") {
    return true;
  }
  return words[1] === "TABLE" && !words.slice(2).includes("AS");
};

const migrationSqlHasForbiddenStatements = (migrationSql: string): boolean => {
  const scan = scanSqlMigration(migrationSql);
  return (
    scan.hasExplicitDownMarker ||
    scan.statements.length === 0 ||
    scan.statements.some((statement) => !isAllowedMigrationStatement(statement))
  );
};

const inventoryCapacityExpression =
  /\(?\s*held_inventory\s*\+\s*sold_inventory\s*\)?\s*<=\s*total_inventory/;

type ColumnContract = {
  column_default: string | null;
  data_type: string;
  is_nullable: "NO" | "YES";
  udt_name: string;
};

const normalizeColumnDefault = (columnDefault: string | null): string | null => {
  if (columnDefault === null) {
    return null;
  }
  if (
    /^\s*(?:gen_random_uuid\(\)|\(\s*gen_random_uuid\(\)\s*\))(?:::\s*uuid)?\s*$/i.test(
      columnDefault,
    )
  ) {
    return "gen_random_uuid()";
  }
  if (
    /^\s*(?:CURRENT_TIMESTAMP|\(\s*CURRENT_TIMESTAMP\s*\))(?:::\s*(?:timestamptz|timestamp\s+with\s+time\s+zone))?\s*$/i.test(
      columnDefault,
    )
  ) {
    return "CURRENT_TIMESTAMP";
  }
  const literal = /^'([^']+)'::(?:[\w.]+|"[^"]+")$/.exec(columnDefault);
  return literal?.[1] ?? columnDefault;
};

const requiredColumn = (
  dataType: string,
  udtName: string,
  columnDefault: string | null = null,
): ColumnContract => ({
  column_default: columnDefault,
  data_type: dataType,
  is_nullable: "NO",
  udt_name: udtName,
});

const nullableColumn = (dataType: string, udtName: string): ColumnContract => ({
  column_default: null,
  data_type: dataType,
  is_nullable: "YES",
  udt_name: udtName,
});

test.each([
  ["gen_random_uuid()", "gen_random_uuid()"],
  ["(gen_random_uuid())", "gen_random_uuid()"],
  ["gen_random_uuid()::uuid", "gen_random_uuid()"],
  ["CURRENT_TIMESTAMP", "CURRENT_TIMESTAMP"],
  ["(CURRENT_TIMESTAMP)::timestamp with time zone", "CURRENT_TIMESTAMP"],
  ["'CNY'::bpchar", "CNY"],
  [null, null],
])("normalizes exact PostgreSQL column default %s", (columnDefault, expected) => {
  expect(normalizeColumnDefault(columnDefault)).toBe(expected);
});

test.each([
  "CURRENT_TIMESTAMP + INTERVAL '1 day'",
  "coalesce(gen_random_uuid(), '00000000-0000-0000-0000-000000000000'::uuid)",
  "prefixgen_random_uuid()",
  "gen_random_uuid()suffix",
  "prefix CURRENT_TIMESTAMP",
  "CURRENT_TIMESTAMP suffix",
])("preserves wrapped or extended column default %s", (columnDefault) => {
  expect(normalizeColumnDefault(columnDefault)).toBe(columnDefault);
});

const preBookingInventoryFixtureSql = `
  ALTER TABLE "daily_inventory"
  DROP CONSTRAINT IF EXISTS "daily_inventory_capacity_check";
  ALTER TABLE "daily_inventory"
  DROP CONSTRAINT IF EXISTS "daily_inventory_available_check";
  ALTER TABLE "daily_inventory"
  ADD CONSTRAINT "daily_inventory_available_check" CHECK (
    "total_inventory" < 0
    OR "held_inventory" < 0
    OR "sold_inventory" < 0
    OR "held_inventory" + "sold_inventory" <= "total_inventory"
  );
`;

test.each([
  [
    "allows foreign-key actions",
    'ALTER TABLE "booking" ADD CONSTRAINT "booking_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;',
    false,
  ],
  [
    "allows ordinary words in comments",
    "-- update this constraint later\nCREATE TABLE quote (id uuid);",
    false,
  ],
  [
    "allows ordinary down text",
    "CREATE TABLE quote (status text CHECK (status <> 'down'));",
    false,
  ],
  [
    "allows keywords and semicolons in string literals",
    "CREATE TABLE quote (note text DEFAULT 'UPDATE; DELETE FROM quote; MERGE');",
    false,
  ],
  [
    "allows keywords in quoted identifiers",
    'CREATE TABLE "UPDATE" ("DELETE" text, "DROP TABLE" text);',
    false,
  ],
  [
    "allows keywords and semicolons in dollar-quoted literals",
    "CREATE TABLE quote (note text DEFAULT $body$UPDATE; DELETE FROM quote;$body$);",
    false,
  ],
  [
    "allows regex strings and block comments",
    "/* DELETE FROM quote; */ CREATE TABLE quote (fingerprint text CHECK (fingerprint ~ 'UPDATE|DROP TABLE;'));",
    false,
  ],
  ["rejects UPDATE statements", "UPDATE quote SET currency = 'CNY';", true],
  ["rejects DELETE FROM statements", "DELETE FROM quote;", true],
  ["rejects INSERT statements", "INSERT INTO quote (id) VALUES (gen_random_uuid());", true],
  ["rejects TRUNCATE statements", "TRUNCATE TABLE quote;", true],
  ["rejects DROP TABLE statements", "DROP TABLE quote;", true],
  [
    "rejects MERGE statements",
    "MERGE INTO quote USING source ON false WHEN NOT MATCHED THEN INSERT DEFAULT VALUES;",
    true,
  ],
  [
    "rejects data-modifying WITH statements on one line",
    "WITH removed AS (DELETE FROM quote RETURNING id) SELECT * FROM removed;",
    true,
  ],
  ["rejects EXPLAIN ANALYZE UPDATE", "EXPLAIN ANALYZE UPDATE quote SET currency = 'CNY';", true],
  ["rejects DO statements", "DO $$ BEGIN UPDATE quote SET currency = 'CNY'; END $$;", true],
  ["rejects CALL statements", "CALL rebuild_quote();", true],
  ["rejects COPY statements", "COPY quote TO STDOUT;", true],
  ["rejects CREATE TABLE AS", "CREATE TABLE quote_copy AS SELECT * FROM quote;", true],
  ["rejects explicit down sections", "-- migrate:down\nSELECT 1;", true],
])("migration SQL guard %s", (_name, migrationSql, expected) => {
  expect(migrationSqlHasForbiddenStatements(migrationSql)).toBe(expected);
});

test("pre-booking fixture restores the original daily inventory capacity check", () => {
  expect(preBookingInventoryFixtureSql).toMatch(
    /ALTER\s+TABLE\s+"daily_inventory"\s+DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+"daily_inventory_capacity_check"/,
  );
  expect(preBookingInventoryFixtureSql).toContain(
    'ADD CONSTRAINT "daily_inventory_available_check" CHECK (',
  );
  expect(preBookingInventoryFixtureSql).toContain('"total_inventory" < 0');
  expect(preBookingInventoryFixtureSql).toContain('"held_inventory" < 0');
  expect(preBookingInventoryFixtureSql).toContain('"sold_inventory" < 0');
  expect(preBookingInventoryFixtureSql).toContain(
    '"held_inventory" + "sold_inventory" <= "total_inventory"',
  );
  expect(preBookingInventoryFixtureSql).not.toContain("daily_inventory_nonnegative_check");
  expect(preBookingInventoryFixtureSql).not.toContain("daily_price_");
});

test.each([
  "held_inventory + sold_inventory <= total_inventory",
  "((held_inventory + sold_inventory) <= total_inventory)",
])("recognizes PostgreSQL capacity deparse %s", (definition) => {
  expect(inventoryCapacityExpression.test(definition)).toBe(true);
});

test("restores an environment variable with its original presence and value", () => {
  const presentEnvironment: Record<string, string | undefined> = {
    DATABASE_URL: "postgresql://original",
  };
  const presentSnapshot = snapshotEnvironmentVariable(presentEnvironment, "DATABASE_URL");
  presentEnvironment.DATABASE_URL = "postgresql://temporary";
  restoreEnvironmentVariable(presentEnvironment, "DATABASE_URL", presentSnapshot);
  expect(presentEnvironment).toEqual({ DATABASE_URL: "postgresql://original" });

  const absentEnvironment: Record<string, string | undefined> = {};
  const absentSnapshot = snapshotEnvironmentVariable(absentEnvironment, "DATABASE_URL");
  absentEnvironment.DATABASE_URL = "postgresql://temporary";
  restoreEnvironmentVariable(absentEnvironment, "DATABASE_URL", absentSnapshot);
  expect(Object.hasOwn(absentEnvironment, "DATABASE_URL")).toBe(false);
});

test("best-effort cleanup runs every step and aggregates failures", async () => {
  const calls: string[] = [];
  const firstFailure = new Error("disconnect failed");
  const thirdFailure = new Error("release failed");

  const cleanup = runBestEffortCleanup("test cleanup", [
    () => {
      calls.push("disconnect");
      return Promise.reject(firstFailure);
    },
    () => {
      calls.push("drop schema");
    },
    () => {
      calls.push("release client");
      throw thirdFailure;
    },
    () => {
      calls.push("end pool");
      return Promise.resolve();
    },
    () => {
      calls.push("restore environment");
    },
  ]);

  await expect(cleanup).rejects.toMatchObject({
    errors: [firstFailure, thirdFailure],
    message: "test cleanup",
  });
  expect(calls).toEqual([
    "disconnect",
    "drop schema",
    "release client",
    "end pool",
    "restore environment",
  ]);
});

const createBarrier = (participants: number, timeoutMilliseconds: number) => {
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
      rejectRelease(new Error(`Barrier timed out after ${timeoutMilliseconds}ms`));
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
        throw new Error("Barrier participant overflow");
      }
      return releasePromise;
    },
    release,
  };
};

describeDatabase(suiteName, () => {
  let client: PoolClient | undefined;
  let pool: Pool | undefined;
  let quotedSchema: string | undefined;
  let schemaName: string | undefined;
  let schemaCreated = false;
  let migrationApplied: Promise<void> | undefined;
  let repositoryDatabase: DatabaseService | undefined;
  let originalDatabaseUrl: EnvironmentVariableSnapshot | undefined;

  const database = (): PoolClient => {
    if (client === undefined) {
      throw new Error("Quote booking database client was not initialized");
    }
    return client;
  };

  const createBaselineFixtures = async (): Promise<void> => {
    const db = database();
    if (quotedSchema === undefined) {
      throw new Error("Quote booking test schema was not initialized");
    }

    for (const table of [
      "city",
      "user",
      "property",
      "room_type",
      "daily_price",
      "daily_inventory",
    ]) {
      await db.query(
        `CREATE TABLE ${quotedSchema}."${table}" (LIKE public."${table}" INCLUDING ALL)`,
      );
    }
    await db.query(preBookingInventoryFixtureSql);

    const city = await db.query<{ id: string }>(`
      INSERT INTO city (code, name_zh, center, updated_at)
      VALUES ('quote-test', '报价测试城市', ST_SetSRID(ST_MakePoint(120, 30), 4326)::geography, CURRENT_TIMESTAMP)
      RETURNING id::text
    `);
    await db.query<{ id: string }>(
      'INSERT INTO "user" (updated_at) VALUES (CURRENT_TIMESTAMP) RETURNING id::text',
    );
    const property = await db.query<{ id: string }>(
      `
      INSERT INTO property (
        city_id, type, name_zh, address_zh, location, short_description_zh,
        description_zh, policies_zh, cover_url, updated_at
      )
      VALUES (
        $1::uuid, 'HOTEL', '报价测试酒店', '测试地址',
        ST_SetSRID(ST_MakePoint(120, 30), 4326)::geography, '测试简介',
        '测试描述', '测试政策', 'https://example.test/property.jpg', CURRENT_TIMESTAMP
      )
      RETURNING id::text
    `,
      [city.rows[0]?.id],
    );
    const room = await db.query<{ id: string }>(
      `
      INSERT INTO room_type (
        property_id, name_zh, bed_type_zh, area_sqm, max_guests, cover_url,
        description_zh, booking_policy_zh, updated_at
      )
      VALUES (
        $1::uuid, '报价测试房型', '大床', 30.00, 4, 'https://example.test/room.jpg',
        '测试房型描述', '测试预订政策', CURRENT_TIMESTAMP
      )
      RETURNING id::text
    `,
      [property.rows[0]?.id],
    );
    const roomId = room.rows[0]?.id;
    await db.query(
      `INSERT INTO daily_price (room_type_id, business_date, sale_price_cents, rack_price_cents, updated_at)
       VALUES ($1::uuid, DATE '2026-08-01', 15000, 18000, CURRENT_TIMESTAMP)`,
      [roomId],
    );
    await db.query(
      `INSERT INTO daily_inventory (room_type_id, business_date, total_inventory, held_inventory, sold_inventory, updated_at)
       VALUES ($1::uuid, DATE '2026-08-01', 3, 0, 0, CURRENT_TIMESTAMP)`,
      [roomId],
    );
  };

  const readTargetMigration = async (): Promise<string> => {
    const migrationSql = await readFile(targetMigration, "utf8");
    expect(migrationSqlHasForbiddenStatements(migrationSql)).toBe(false);
    const capacityStatements = scanSqlMigration(migrationSql).statements.filter((statement) =>
      /daily_inventory_(?:available|capacity)_check/i.test(statement),
    );
    expect(capacityStatements).toHaveLength(1);
    expect(capacityStatements[0]).toMatch(
      /^ALTER\s+TABLE\s+"daily_inventory"\s+RENAME\s+CONSTRAINT\s+"daily_inventory_available_check"\s+TO\s+"daily_inventory_capacity_check"\s*$/i,
    );
    expect(capacityStatements).not.toContainEqual(
      expect.stringMatching(
        /^ALTER\s+TABLE\s+"daily_inventory"\s+(?:ADD|DROP|VALIDATE)\s+CONSTRAINT\s+"daily_inventory_(?:available|capacity)_check"/i,
      ),
    );
    return migrationSql;
  };

  const applyTargetMigration = async (): Promise<void> => {
    migrationApplied ??= (async () => {
      await database().query(await readTargetMigration());
    })();
    return migrationApplied;
  };

  const activeRepositoryDatabase = (): DatabaseService => {
    if (repositoryDatabase === undefined) {
      throw new Error("Booking repository database was not initialized");
    }
    return repositoryDatabase;
  };

  const testNow = new Date("2030-01-01T00:00:00.000Z");
  const clockAt = (value: Date): Clock => ({
    now: () => new Date(Date.prototype.getTime.call(value)),
  });
  const nextBookingNumber = (): string =>
    `SF20300101${randomBytes(6).toString("hex").toUpperCase()}`;
  const nextIdempotencyKey = (): string => `key_${randomBytes(20).toString("hex")}`;

  interface ScenarioFixture {
    checkout: string;
    dates: string[];
    policy: string;
    prices: Array<{ rack: number; sale: number }>;
    propertyId: string;
    propertyName: string;
    roomId: string;
    roomName: string;
    users: string[];
  }

  interface ScenarioState {
    bookingRows: Array<{ booking_number: string; id: string; quote_id: string; user_id: string }>;
    historyCount: number;
    holdCount: number;
    holdStatuses: string[];
    inventories: Array<{
      business_date: string;
      held_inventory: number;
      sold_inventory: number;
      total_inventory: number;
      version: number;
    }>;
  }

  const createScenarioFixture = async (input: {
    checkout: string;
    dates: string[];
    totals: number[];
    userCount?: number;
  }): Promise<ScenarioFixture> => {
    const db = database();
    const users = Array.from({ length: input.userCount ?? 1 }, () => randomUUID());
    for (const userId of users) {
      await db.query(`INSERT INTO "user" (id, updated_at) VALUES ($1::uuid, CURRENT_TIMESTAMP)`, [
        userId,
      ]);
    }
    const propertyId = randomUUID();
    const roomId = randomUUID();
    const suffix = roomId.slice(0, 8);
    const propertyName = `并发测试酒店-${suffix}`;
    const roomName = `并发测试房型-${suffix}`;
    const policy = `并发测试政策-${suffix}`;
    await db.query(
      `
      INSERT INTO property (
        id, city_id, type, name_zh, address_zh, location, short_description_zh,
        description_zh, policies_zh, cover_url, status, updated_at
      )
      SELECT
        $1::uuid, city.id, 'HOTEL', $2, '测试地址',
        ST_SetSRID(ST_MakePoint(120, 30), 4326)::geography, '测试简介',
        '测试描述', '测试政策', 'https://example.test/property.jpg', 'OPEN', CURRENT_TIMESTAMP
      FROM city
      ORDER BY city.created_at, city.id
      LIMIT 1
    `,
      [propertyId, propertyName],
    );
    await db.query(
      `
      INSERT INTO room_type (
        id, property_id, name_zh, bed_type_zh, area_sqm, max_guests, cover_url,
        description_zh, booking_policy_zh, status, updated_at
      )
      VALUES (
        $1::uuid, $2::uuid, $3, '大床', 30.00, 4, 'https://example.test/room.jpg',
        '测试房型描述', $4, 'ON_SALE', CURRENT_TIMESTAMP
      )
    `,
      [roomId, propertyId, roomName, policy],
    );
    const prices = input.dates.map((_, index) => ({
      sale: 15_000 + index * 1_000,
      rack: 18_000 + index * 1_000,
    }));
    for (const [index, businessDate] of input.dates.entries()) {
      await db.query(
        `
        INSERT INTO daily_price (
          room_type_id, business_date, sale_price_cents, rack_price_cents, updated_at
        ) VALUES ($1::uuid, $2::date, $3, $4, CURRENT_TIMESTAMP)
      `,
        [roomId, businessDate, prices[index]?.sale, prices[index]?.rack],
      );
      await db.query(
        `
        INSERT INTO daily_inventory (
          room_type_id, business_date, total_inventory, held_inventory,
          sold_inventory, version, updated_at
        ) VALUES ($1::uuid, $2::date, $3, 0, 0, 0, CURRENT_TIMESTAMP)
      `,
        [roomId, businessDate, input.totals[index]],
      );
    }
    return {
      checkout: input.checkout,
      dates: input.dates,
      policy,
      prices,
      propertyId,
      propertyName,
      roomId,
      roomName,
      users,
    };
  };

  const createQuote = async (
    fixture: ScenarioFixture,
    userId: string,
    expiresAt = new Date("2030-01-01T00:05:00.000Z"),
  ): Promise<string> => {
    const nightlyPrices = fixture.dates.map((businessDate, index) => ({
      business_date: businessDate,
      sale_price_cents: fixture.prices[index]?.sale,
      rack_price_cents: fixture.prices[index]?.rack,
      currency: "CNY",
    }));
    const property = { id: fixture.propertyId, name: fixture.propertyName };
    const roomType = {
      id: fixture.roomId,
      name: fixture.roomName,
      cover_url: "https://example.test/room.jpg",
    };
    const fingerprint = createQuoteFingerprint({
      property,
      roomType: {
        id: roomType.id,
        name: roomType.name,
        coverUrl: roomType.cover_url,
      },
      checkin: fixture.dates[0]!,
      checkout: fixture.checkout,
      guests: 2,
      bookingPolicy: fixture.policy,
      nightlyPrices: fixture.dates.map((businessDate, index) => ({
        businessDate,
        salePriceCents: fixture.prices[index]!.sale,
        rackPriceCents: fixture.prices[index]!.rack,
      })),
    });
    const total = fixture.prices.reduce((sum, price) => sum + price.sale, 0);
    const quote = await database().query<{ id: string }>(
      `
      INSERT INTO quote (
        user_id, property_id, room_type_id, checkin_date, checkout_date, guests,
        nightly_prices, property_snapshot, room_type_snapshot, booking_policy_snapshot,
        total_price_cents, currency, fingerprint, expires_at, created_at
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::date, $5::date, 2,
        $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, 'CNY', $11, $12, $13
      )
      RETURNING id::text
    `,
      [
        userId,
        fixture.propertyId,
        fixture.roomId,
        fixture.dates[0],
        fixture.checkout,
        JSON.stringify(nightlyPrices),
        JSON.stringify(property),
        JSON.stringify(roomType),
        fixture.policy,
        total,
        fingerprint,
        expiresAt,
        new Date("2029-12-31T23:59:00.000Z"),
      ],
    );
    const quoteId = quote.rows[0]?.id;
    if (quoteId === undefined) {
      throw new Error("Quote fixture was not created");
    }
    return quoteId;
  };

  const repositoryInput = (
    userId: string,
    quoteId: string,
    idempotencyKey = nextIdempotencyKey(),
    bookingNumber = nextBookingNumber(),
  ): CreateBookingInput => ({
    userId,
    quoteId,
    idempotencyKey,
    bookingNumber,
    now: new Date(testNow),
  });

  const createThroughRepository = (
    input: CreateBookingInput,
    bookingDatabase: BookingDatabase = activeRepositoryDatabase(),
    clock: Clock = clockAt(testNow),
  ): Promise<CreateBookingResult> =>
    new BookingRepository(bookingDatabase, clock).createFromQuote(input);

  const createConcurrentDatabase = (
    barrier: ReturnType<typeof createBarrier>,
    backendPids: Set<number>,
  ): BookingDatabase => {
    const source = activeRepositoryDatabase();
    return {
      $queryRaw: <T = unknown>(query: Prisma.Sql) => source.$queryRaw<T>(query),
      $transaction: <T>(
        operation: (transaction: BookingTransaction) => Promise<T>,
        options: { isolationLevel: "ReadCommitted" },
      ) =>
        source.$transaction(async (transaction) => {
          const rows = await transaction.$queryRaw<Array<{ pid: number }>>(
            Prisma.sql`SELECT pg_backend_pid()::integer AS pid`,
          );
          const pid = rows[0]?.pid;
          if (!Number.isInteger(pid)) {
            throw new Error("Unable to capture PostgreSQL backend pid");
          }
          backendPids.add(pid!);
          await barrier.arrive();
          return operation(transaction);
        }, options),
    };
  };

  const readScenarioState = async (fixture: ScenarioFixture): Promise<ScenarioState> => {
    const bookingRows = await database().query<ScenarioState["bookingRows"][number]>(
      `
      SELECT id::text, quote_id::text, user_id::text, booking_number
      FROM booking
      WHERE room_type_id = $1::uuid
      ORDER BY created_at, id
    `,
      [fixture.roomId],
    );
    const counts = await database().query<{ history_count: number; hold_count: number }>(
      `
      SELECT
        (
          SELECT COUNT(*)::integer
          FROM inventory_hold hold
          JOIN booking ON booking.id = hold.booking_id
          WHERE booking.room_type_id = $1::uuid
        ) AS hold_count,
        (
          SELECT COUNT(*)::integer
          FROM booking_status_history history
          JOIN booking ON booking.id = history.booking_id
          WHERE booking.room_type_id = $1::uuid
        ) AS history_count
    `,
      [fixture.roomId],
    );
    const inventories = await database().query<ScenarioState["inventories"][number]>(
      `
      SELECT business_date::text, total_inventory, held_inventory, sold_inventory, version
      FROM daily_inventory
      WHERE room_type_id = $1::uuid
      ORDER BY business_date
    `,
      [fixture.roomId],
    );
    const holds = await database().query<{ status: string }>(
      `
      SELECT hold.status::text
      FROM inventory_hold hold
      JOIN booking ON booking.id = hold.booking_id
      WHERE booking.room_type_id = $1::uuid
      ORDER BY hold.business_date, hold.id
    `,
      [fixture.roomId],
    );
    return {
      bookingRows: bookingRows.rows,
      historyCount: counts.rows[0]?.history_count ?? -1,
      holdCount: counts.rows[0]?.hold_count ?? -1,
      holdStatuses: holds.rows.map(({ status }) => status),
      inventories: inventories.rows,
    };
  };

  const expectCheckViolation = async (sql: string, values: unknown[], constraint?: string) => {
    await database().query("BEGIN");
    try {
      await database().query("SAVEPOINT contract_violation");
      await expect(database().query(sql, values)).rejects.toMatchObject({
        code: "23514",
        ...(constraint === undefined ? {} : { constraint }),
      });
      await database().query("ROLLBACK TO SAVEPOINT contract_violation");
    } finally {
      await database().query("ROLLBACK");
    }
  };

  beforeAll(async () => {
    originalDatabaseUrl = snapshotEnvironmentVariable(process.env, "DATABASE_URL");
    const connectionString = requireSafeDatabaseIntegrationUrl(process.env.DATABASE_URL);
    pool = new Pool({ connectionString });
    client = await pool.connect();
    schemaName = `quote_booking_test_${randomBytes(8).toString("hex")}`;
    quotedSchema = quoteGeneratedTestSchema(schemaName);
    await client.query(`CREATE SCHEMA ${quotedSchema}`);
    schemaCreated = true;
    await client.query(`SET search_path TO ${quotedSchema}, public`);
    await createBaselineFixtures();
    if (schemaName === undefined) {
      throw new Error("Quote booking test schema was not generated");
    }
    const repositoryUrl = new URL(connectionString);
    repositoryUrl.searchParams.set("schema", schemaName);
    repositoryUrl.searchParams.set("options", `-c search_path=${schemaName},public`);
    process.env.DATABASE_URL = repositoryUrl.toString();
    repositoryDatabase = new DatabaseService();
  });

  afterAll(async () => {
    const cleanupRepositoryDatabase = repositoryDatabase;
    const cleanupClient = client;
    const cleanupPool = pool;
    const cleanupSchemaName = schemaName;
    const cleanupSchemaCreated = schemaCreated;
    const cleanupDatabaseUrl = originalDatabaseUrl;
    repositoryDatabase = undefined;
    client = undefined;
    pool = undefined;
    schemaCreated = false;
    originalDatabaseUrl = undefined;

    await runBestEffortCleanup("quote booking contract cleanup failed", [
      async () => cleanupRepositoryDatabase?.onModuleDestroy(),
      async () => {
        if (!cleanupSchemaCreated) {
          return;
        }
        if (cleanupSchemaName === undefined || cleanupPool === undefined) {
          throw new Error("Created quote booking schema is missing cleanup metadata");
        }
        const cleanupQuotedSchema = quoteGeneratedTestSchema(cleanupSchemaName);
        await cleanupPool.query(`DROP SCHEMA ${cleanupQuotedSchema} CASCADE`);
      },
      () => cleanupClient?.release(),
      async () => cleanupPool?.end(),
      () => {
        if (cleanupDatabaseUrl !== undefined) {
          restoreEnvironmentVariable(process.env, "DATABASE_URL", cleanupDatabaseUrl);
        }
      },
    ]);
  });

  test("the target migration is present and executes in an isolated schema", async () => {
    await applyTargetMigration();
  }, 25_000);

  test("target relations, enums, and key columns are isolated in the generated schema", async () => {
    await applyTargetMigration();
    const schema = schemaName;
    expect(schema).toMatch(/^quote_booking_test_[0-9a-f]{16}$/);

    const relations = await database().query<{ table_name: string }>(
      `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = $1
        AND table_name IN ('quote', 'booking', 'inventory_hold', 'booking_status_history')
      ORDER BY table_name
    `,
      [schema],
    );
    expect(relations.rows).toEqual([
      { table_name: "booking" },
      { table_name: "booking_status_history" },
      { table_name: "inventory_hold" },
      { table_name: "quote" },
    ]);

    const enums = await database().query<{ enum_name: string; enumlabel: string }>(
      `
      SELECT type_name.typname AS enum_name, enum_value.enumlabel
      FROM pg_type type_name
      JOIN pg_namespace type_schema ON type_schema.oid = type_name.typnamespace
      JOIN pg_enum enum_value ON enum_value.enumtypid = type_name.oid
      WHERE type_schema.nspname = $1
        AND type_name.typname IN ('BookingStatus', 'InventoryHoldStatus', 'BookingActorType')
      ORDER BY type_name.typname, enum_value.enumsortorder
    `,
      [schema],
    );
    expect(enums.rows).toEqual([
      { enum_name: "BookingActorType", enumlabel: "USER" },
      { enum_name: "BookingActorType", enumlabel: "SYSTEM" },
      { enum_name: "BookingStatus", enumlabel: "PENDING_PAYMENT" },
      { enum_name: "BookingStatus", enumlabel: "PAID" },
      { enum_name: "BookingStatus", enumlabel: "CONFIRMED" },
      { enum_name: "BookingStatus", enumlabel: "CANCELLED" },
      { enum_name: "BookingStatus", enumlabel: "CLOSED" },
      { enum_name: "InventoryHoldStatus", enumlabel: "HELD" },
      { enum_name: "InventoryHoldStatus", enumlabel: "CONSUMED" },
      { enum_name: "InventoryHoldStatus", enumlabel: "RELEASED" },
    ]);

    const columns = await database().query<{
      column_default: string | null;
      column_name: string;
      data_type: string;
      is_nullable: "NO" | "YES";
      table_name: string;
      udt_name: string;
    }>(
      `
      SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name IN ('quote', 'booking', 'inventory_hold', 'booking_status_history')
      ORDER BY table_name, ordinal_position
    `,
      [schema],
    );
    const contract = Object.fromEntries(
      columns.rows.map(({ column_default: columnDefault, column_name: columnName, ...column }) => [
        `${column.table_name}.${columnName}`,
        {
          column_default: normalizeColumnDefault(columnDefault),
          data_type: column.data_type,
          is_nullable: column.is_nullable,
          udt_name: column.udt_name,
        },
      ]),
    );
    const expectedContract: Record<string, ColumnContract> = {
      "quote.id": requiredColumn("uuid", "uuid", "gen_random_uuid()"),
      "quote.user_id": requiredColumn("uuid", "uuid"),
      "quote.property_id": requiredColumn("uuid", "uuid"),
      "quote.room_type_id": requiredColumn("uuid", "uuid"),
      "quote.checkin_date": requiredColumn("date", "date"),
      "quote.checkout_date": requiredColumn("date", "date"),
      "quote.guests": requiredColumn("integer", "int4"),
      "quote.nightly_prices": requiredColumn("jsonb", "jsonb"),
      "quote.property_snapshot": requiredColumn("jsonb", "jsonb"),
      "quote.room_type_snapshot": requiredColumn("jsonb", "jsonb"),
      "quote.booking_policy_snapshot": requiredColumn("character varying", "varchar"),
      "quote.total_price_cents": requiredColumn("integer", "int4"),
      "quote.currency": requiredColumn("character", "bpchar", "CNY"),
      "quote.fingerprint": requiredColumn("character", "bpchar"),
      "quote.expires_at": requiredColumn("timestamp with time zone", "timestamptz"),
      "quote.created_at": requiredColumn(
        "timestamp with time zone",
        "timestamptz",
        "CURRENT_TIMESTAMP",
      ),
      "booking.id": requiredColumn("uuid", "uuid", "gen_random_uuid()"),
      "booking.user_id": requiredColumn("uuid", "uuid"),
      "booking.quote_id": requiredColumn("uuid", "uuid"),
      "booking.property_id": requiredColumn("uuid", "uuid"),
      "booking.room_type_id": requiredColumn("uuid", "uuid"),
      "booking.booking_number": requiredColumn("character varying", "varchar"),
      "booking.status": requiredColumn("USER-DEFINED", "BookingStatus", "PENDING_PAYMENT"),
      "booking.checkin_date": requiredColumn("date", "date"),
      "booking.checkout_date": requiredColumn("date", "date"),
      "booking.guests": requiredColumn("integer", "int4"),
      "booking.property_snapshot": requiredColumn("jsonb", "jsonb"),
      "booking.room_type_snapshot": requiredColumn("jsonb", "jsonb"),
      "booking.nightly_prices": requiredColumn("jsonb", "jsonb"),
      "booking.booking_policy_snapshot": requiredColumn("character varying", "varchar"),
      "booking.total_price_cents": requiredColumn("integer", "int4"),
      "booking.currency": requiredColumn("character", "bpchar", "CNY"),
      "booking.idempotency_key": requiredColumn("character varying", "varchar"),
      "booking.expires_at": requiredColumn("timestamp with time zone", "timestamptz"),
      "booking.created_at": requiredColumn(
        "timestamp with time zone",
        "timestamptz",
        "CURRENT_TIMESTAMP",
      ),
      "booking.updated_at": requiredColumn("timestamp with time zone", "timestamptz"),
      "inventory_hold.id": requiredColumn("uuid", "uuid", "gen_random_uuid()"),
      "inventory_hold.booking_id": requiredColumn("uuid", "uuid"),
      "inventory_hold.room_type_id": requiredColumn("uuid", "uuid"),
      "inventory_hold.business_date": requiredColumn("date", "date"),
      "inventory_hold.status": requiredColumn("USER-DEFINED", "InventoryHoldStatus", "HELD"),
      "inventory_hold.expires_at": requiredColumn("timestamp with time zone", "timestamptz"),
      "inventory_hold.created_at": requiredColumn(
        "timestamp with time zone",
        "timestamptz",
        "CURRENT_TIMESTAMP",
      ),
      "inventory_hold.updated_at": requiredColumn("timestamp with time zone", "timestamptz"),
      "booking_status_history.id": requiredColumn("uuid", "uuid", "gen_random_uuid()"),
      "booking_status_history.booking_id": requiredColumn("uuid", "uuid"),
      "booking_status_history.from_status": nullableColumn("USER-DEFINED", "BookingStatus"),
      "booking_status_history.to_status": requiredColumn("USER-DEFINED", "BookingStatus"),
      "booking_status_history.reason": requiredColumn("character varying", "varchar"),
      "booking_status_history.actor_type": requiredColumn("USER-DEFINED", "BookingActorType"),
      "booking_status_history.actor_user_id": nullableColumn("uuid", "uuid"),
      "booking_status_history.created_at": requiredColumn(
        "timestamp with time zone",
        "timestamptz",
        "CURRENT_TIMESTAMP",
      ),
    };
    expect(contract).toEqual(expectedContract);
  }, 25_000);

  test("primary, foreign, and unique keys use restrict deletes and cascade updates", async () => {
    await applyTargetMigration();
    const schema = schemaName;
    const primaryKeys = await database().query<{ column_names: string[]; table_name: string }>(
      `
      SELECT child.relname AS table_name, array_agg(attribute.attname::text ORDER BY key_column.ordinality) AS column_names
      FROM pg_constraint con
      JOIN pg_class child ON child.oid = con.conrelid
      JOIN pg_namespace child_schema ON child_schema.oid = child.relnamespace
      JOIN unnest(con.conkey) WITH ORDINALITY AS key_column(attribute_number, ordinality) ON true
      JOIN pg_attribute attribute ON attribute.attrelid = child.oid AND attribute.attnum = key_column.attribute_number
      WHERE con.contype = 'p' AND child_schema.nspname = $1
        AND child.relname IN ('quote', 'booking', 'inventory_hold', 'booking_status_history')
      GROUP BY child.relname
      ORDER BY child.relname
    `,
      [schema],
    );
    expect(primaryKeys.rows).toEqual([
      { table_name: "booking", column_names: ["id"] },
      { table_name: "booking_status_history", column_names: ["id"] },
      { table_name: "inventory_hold", column_names: ["id"] },
      { table_name: "quote", column_names: ["id"] },
    ]);

    const foreignKeys = await database().query<{
      child_column: string;
      child_table: string;
      delete_action: string;
      parent_table: string;
      update_action: string;
    }>(
      `
      SELECT child.relname AS child_table, child_attribute.attname AS child_column,
             parent.relname AS parent_table, con.confdeltype::text AS delete_action,
             con.confupdtype::text AS update_action
      FROM pg_constraint con
      JOIN pg_class child ON child.oid = con.conrelid
      JOIN pg_namespace child_schema ON child_schema.oid = child.relnamespace
      JOIN pg_class parent ON parent.oid = con.confrelid
      JOIN unnest(con.conkey) WITH ORDINALITY AS child_key(attribute_number, ordinality) ON true
      JOIN pg_attribute child_attribute ON child_attribute.attrelid = child.oid AND child_attribute.attnum = child_key.attribute_number
      WHERE con.contype = 'f' AND child_schema.nspname = $1
        AND child.relname IN ('quote', 'booking', 'inventory_hold', 'booking_status_history')
      ORDER BY child.relname, child_attribute.attname
    `,
      [schema],
    );
    expect(foreignKeys.rows).toEqual([
      {
        child_table: "booking",
        child_column: "property_id",
        parent_table: "property",
        delete_action: "r",
        update_action: "c",
      },
      {
        child_table: "booking",
        child_column: "quote_id",
        parent_table: "quote",
        delete_action: "r",
        update_action: "c",
      },
      {
        child_table: "booking",
        child_column: "room_type_id",
        parent_table: "room_type",
        delete_action: "r",
        update_action: "c",
      },
      {
        child_table: "booking",
        child_column: "user_id",
        parent_table: "user",
        delete_action: "r",
        update_action: "c",
      },
      {
        child_table: "booking_status_history",
        child_column: "actor_user_id",
        parent_table: "user",
        delete_action: "r",
        update_action: "c",
      },
      {
        child_table: "booking_status_history",
        child_column: "booking_id",
        parent_table: "booking",
        delete_action: "r",
        update_action: "c",
      },
      {
        child_table: "inventory_hold",
        child_column: "booking_id",
        parent_table: "booking",
        delete_action: "r",
        update_action: "c",
      },
      {
        child_table: "inventory_hold",
        child_column: "room_type_id",
        parent_table: "room_type",
        delete_action: "r",
        update_action: "c",
      },
      {
        child_table: "quote",
        child_column: "property_id",
        parent_table: "property",
        delete_action: "r",
        update_action: "c",
      },
      {
        child_table: "quote",
        child_column: "room_type_id",
        parent_table: "room_type",
        delete_action: "r",
        update_action: "c",
      },
      {
        child_table: "quote",
        child_column: "user_id",
        parent_table: "user",
        delete_action: "r",
        update_action: "c",
      },
    ]);

    const uniqueKeys = await database().query<{ column_names: string[]; table_name: string }>(
      `
      SELECT child.relname AS table_name, array_agg(attribute.attname::text ORDER BY key_column.ordinality) AS column_names
      FROM pg_constraint con
      JOIN pg_class child ON child.oid = con.conrelid
      JOIN pg_namespace child_schema ON child_schema.oid = child.relnamespace
      JOIN unnest(con.conkey) WITH ORDINALITY AS key_column(attribute_number, ordinality) ON true
      JOIN pg_attribute attribute ON attribute.attrelid = child.oid AND attribute.attnum = key_column.attribute_number
      WHERE con.contype = 'u' AND child_schema.nspname = $1
        AND child.relname IN ('booking', 'inventory_hold')
      GROUP BY child.relname, con.oid
      ORDER BY child.relname, column_names
    `,
      [schema],
    );
    expect(uniqueKeys.rows).toEqual([
      { table_name: "booking", column_names: ["booking_number"] },
      { table_name: "booking", column_names: ["quote_id"] },
      { table_name: "booking", column_names: ["user_id", "idempotency_key"] },
      { table_name: "inventory_hold", column_names: ["booking_id", "business_date"] },
    ]);
  }, 25_000);

  test("checks and indexes cover quote booking capacity and worker access contracts", async () => {
    await applyTargetMigration();
    const schema = schemaName;
    const checks = await database().query<{
      constraint_name: string;
      definition: string;
      table_name: string;
    }>(
      `
      SELECT child.relname AS table_name, con.conname AS constraint_name,
             pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class child ON child.oid = con.conrelid
      JOIN pg_namespace child_schema ON child_schema.oid = child.relnamespace
      WHERE con.contype = 'c' AND child_schema.nspname = $1
        AND child.relname IN ('quote', 'booking', 'inventory_hold', 'booking_status_history', 'daily_price', 'daily_inventory')
    `,
      [schema],
    );
    const definitionByConstraint = new Map(
      checks.rows.map(({ constraint_name: constraintName, definition, table_name: tableName }) => [
        `${tableName}.${constraintName}`,
        definition.replaceAll('"', "").replaceAll(/\s+/g, " "),
      ]),
    );
    const expectedCheckKeys = [
      "quote.quote_dates_check",
      "quote.quote_guests_check",
      "quote.quote_total_price_check",
      "quote.quote_currency_check",
      "quote.quote_fingerprint_check",
      "quote.quote_expires_check",
      "booking.booking_dates_check",
      "booking.booking_guests_check",
      "booking.booking_total_price_check",
      "booking.booking_currency_check",
      "booking.booking_number_check",
      "booking.booking_idempotency_key_check",
      "booking.booking_expires_check",
      "inventory_hold.inventory_hold_expires_check",
      "booking_status_history.booking_status_history_actor_check",
      "daily_inventory.daily_inventory_nonnegative_check",
      "daily_inventory.daily_inventory_capacity_check",
      "daily_price.daily_price_sale_check",
      "daily_price.daily_price_rack_check",
    ].sort();
    expect([...definitionByConstraint.keys()].sort()).toEqual(expectedCheckKeys);

    const expectConstraint = (
      tableName: string,
      constraintName: string,
      fragments: (RegExp | string)[],
    ): void => {
      const definition = definitionByConstraint.get(`${tableName}.${constraintName}`);
      expect(definition, `${tableName}.${constraintName} must exist`).toBeDefined();
      for (const fragment of fragments) {
        if (typeof fragment === "string") {
          expect(definition).toContain(fragment);
        } else {
          expect(definition).toMatch(fragment);
        }
      }
    };

    expectConstraint("quote", "quote_dates_check", ["checkout_date > checkin_date"]);
    expectConstraint("quote", "quote_guests_check", ["guests >= 1", "guests <= 10"]);
    expectConstraint("quote", "quote_total_price_check", ["total_price_cents >= 0"]);
    expectConstraint("quote", "quote_currency_check", ["currency = 'CNY'"]);
    expectConstraint("quote", "quote_fingerprint_check", ["fingerprint", "^[0-9a-f]{64}$"]);
    expectConstraint("quote", "quote_expires_check", ["expires_at > created_at"]);

    expectConstraint("booking", "booking_dates_check", ["checkout_date > checkin_date"]);
    expectConstraint("booking", "booking_guests_check", ["guests >= 1", "guests <= 10"]);
    expectConstraint("booking", "booking_total_price_check", ["total_price_cents >= 0"]);
    expectConstraint("booking", "booking_currency_check", ["currency = 'CNY'"]);
    expectConstraint("booking", "booking_number_check", [
      "booking_number",
      "^SF[0-9]{8}[A-F0-9]{12}$",
    ]);
    expectConstraint("booking", "booking_idempotency_key_check", [
      "idempotency_key",
      "^[A-Za-z0-9._~-]{32,80}$",
    ]);
    expectConstraint("booking", "booking_expires_check", ["expires_at > created_at"]);

    expectConstraint("inventory_hold", "inventory_hold_expires_check", ["expires_at > created_at"]);
    expectConstraint("booking_status_history", "booking_status_history_actor_check", [
      "actor_type",
      "USER",
      "actor_user_id IS NOT NULL",
      "SYSTEM",
      "actor_user_id IS NULL",
    ]);
    expectConstraint("daily_inventory", "daily_inventory_nonnegative_check", [
      "total_inventory >= 0",
      "held_inventory >= 0",
      "sold_inventory >= 0",
      "version >= 0",
    ]);
    const capacityDefinition = definitionByConstraint.get(
      "daily_inventory.daily_inventory_capacity_check",
    );
    expect(capacityDefinition).toBeDefined();
    expect(capacityDefinition).toMatch(inventoryCapacityExpression);
    expectConstraint("daily_price", "daily_price_sale_check", ["sale_price_cents >= 0"]);
    expectConstraint("daily_price", "daily_price_rack_check", [
      "rack_price_cents >= sale_price_cents",
    ]);

    const indexes = await database().query<{ indexdef: string; indexname: string }>(
      `
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = $1
        AND indexname IN (
          'quote_user_expires_idx', 'quote_room_created_idx',
          'booking_user_created_id_idx', 'booking_status_expires_id_idx',
          'inventory_hold_status_expires_id_idx', 'inventory_hold_room_date_idx',
          'booking_status_history_booking_created_id_idx', 'booking_status_history_actor_user_id_idx'
        )
      ORDER BY indexname
    `,
      [schema],
    );
    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual([
      "booking_status_expires_id_idx",
      "booking_status_history_actor_user_id_idx",
      "booking_status_history_booking_created_id_idx",
      "booking_user_created_id_idx",
      "inventory_hold_room_date_idx",
      "inventory_hold_status_expires_id_idx",
      "quote_room_created_idx",
      "quote_user_expires_idx",
    ]);
    const indexByName = new Map(
      indexes.rows.map(({ indexdef, indexname }) => [indexname, indexdef.replaceAll('"', "")]),
    );
    expect(indexByName.get("quote_user_expires_idx")).toContain("(user_id, expires_at)");
    expect(indexByName.get("quote_room_created_idx")).toContain("(room_type_id, created_at)");
    expect(indexByName.get("booking_user_created_id_idx")).toContain("(user_id, created_at, id)");
    expect(indexByName.get("booking_status_expires_id_idx")).toContain("(status, expires_at, id)");
    expect(indexByName.get("inventory_hold_status_expires_id_idx")).toContain(
      "(status, expires_at, id)",
    );
    expect(indexByName.get("inventory_hold_room_date_idx")).toContain(
      "(room_type_id, business_date)",
    );
    expect(indexByName.get("booking_status_history_booking_created_id_idx")).toContain(
      "(booking_id, created_at, id)",
    );
    expect(indexByName.get("booking_status_history_actor_user_id_idx")).toContain(
      "(actor_user_id)",
    );
  }, 25_000);

  test("new capacity checks reject oversell and preserve copied catalog fixtures", async () => {
    await applyTargetMigration();
    const baselineCounts = await database().query<{
      daily_inventory_count: number;
      daily_price_count: number;
      property_count: number;
      room_type_count: number;
      user_count: number;
    }>(`
      SELECT
        (SELECT COUNT(*)::integer FROM "user") AS user_count,
        (SELECT COUNT(*)::integer FROM property) AS property_count,
        (SELECT COUNT(*)::integer FROM room_type) AS room_type_count,
        (SELECT COUNT(*)::integer FROM daily_price) AS daily_price_count,
        (SELECT COUNT(*)::integer FROM daily_inventory) AS daily_inventory_count
    `);
    expect(baselineCounts.rows).toEqual([
      {
        user_count: 1,
        property_count: 1,
        room_type_count: 1,
        daily_price_count: 1,
        daily_inventory_count: 1,
      },
    ]);
    const fixture = await database().query<{
      held_inventory: number;
      rack_price_cents: number;
      sale_price_cents: number;
      sold_inventory: number;
      total_inventory: number;
    }>(`
      SELECT inventory.total_inventory, inventory.held_inventory, inventory.sold_inventory,
             price.sale_price_cents, price.rack_price_cents
      FROM daily_inventory inventory
      JOIN daily_price price USING (room_type_id, business_date)
      WHERE inventory.business_date = DATE '2026-08-01'
    `);
    expect(fixture.rows).toEqual([
      {
        total_inventory: 3,
        held_inventory: 0,
        sold_inventory: 0,
        sale_price_cents: 15000,
        rack_price_cents: 18000,
      },
    ]);
    const oldCapacity = await database().query<{ conname: string }>(
      `
      SELECT conname FROM pg_constraint
      WHERE connamespace = $1::regnamespace AND conname = 'daily_inventory_available_check'
    `,
      [schemaName],
    );
    expect(oldCapacity.rows).toEqual([]);

    await expectCheckViolation(
      "UPDATE daily_inventory SET held_inventory = total_inventory + 1 WHERE business_date = $1::date",
      ["2026-08-01"],
      "daily_inventory_capacity_check",
    );
    await expectCheckViolation(
      "UPDATE daily_inventory SET total_inventory = -1 WHERE business_date = $1::date",
      ["2026-08-01"],
      "daily_inventory_nonnegative_check",
    );
    await expectCheckViolation(
      "UPDATE daily_inventory SET held_inventory = -1 WHERE business_date = $1::date",
      ["2026-08-01"],
      "daily_inventory_nonnegative_check",
    );
    await expectCheckViolation(
      "UPDATE daily_inventory SET sold_inventory = -1 WHERE business_date = $1::date",
      ["2026-08-01"],
      "daily_inventory_nonnegative_check",
    );
    await expectCheckViolation(
      "UPDATE daily_price SET sale_price_cents = -1 WHERE business_date = $1::date",
      ["2026-08-01"],
      "daily_price_sale_check",
    );
    await expectCheckViolation(
      "UPDATE daily_price SET rack_price_cents = sale_price_cents - 1 WHERE business_date = $1::date",
      ["2026-08-01"],
      "daily_price_rack_check",
    );

    const fixtureAfterFailures = await database().query<{
      held_inventory: number;
      rack_price_cents: number;
      sale_price_cents: number;
      sold_inventory: number;
      total_inventory: number;
    }>(`
      SELECT inventory.total_inventory, inventory.held_inventory, inventory.sold_inventory,
             price.sale_price_cents, price.rack_price_cents
      FROM daily_inventory inventory
      JOIN daily_price price USING (room_type_id, business_date)
      WHERE inventory.business_date = DATE '2026-08-01'
    `);
    expect(fixtureAfterFailures.rows).toEqual(fixture.rows);
  }, 25_000);

  test("quote booking hold and history checks reject invalid persisted states", async () => {
    await applyTargetMigration();
    const fixture = await database().query<{
      property_id: string;
      room_type_id: string;
      user_id: string;
    }>(`
      SELECT u.id::text AS user_id, p.id::text AS property_id, r.id::text AS room_type_id
      FROM "user" u CROSS JOIN property p CROSS JOIN room_type r
      LIMIT 1
    `);
    const ids = fixture.rows[0];
    if (ids === undefined) {
      throw new Error("Quote booking baseline fixture is missing");
    }
    const quote = await database().query<{ id: string }>(
      `
      INSERT INTO quote (
        user_id, property_id, room_type_id, checkin_date, checkout_date, guests,
        nightly_prices, property_snapshot, room_type_snapshot, booking_policy_snapshot,
        total_price_cents, fingerprint, expires_at
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, DATE '2026-08-01', DATE '2026-08-02', 2,
        '[15000]'::jsonb, '{"name":"fixture"}'::jsonb, '{"name":"fixture"}'::jsonb,
        'fixture policy', 15000, $4, CURRENT_TIMESTAMP + INTERVAL '5 minutes'
      ) RETURNING id::text
    `,
      [ids.user_id, ids.property_id, ids.room_type_id, "a".repeat(64)],
    );
    const quoteId = quote.rows[0]?.id;
    const booking = await database().query<{ id: string }>(
      `
      INSERT INTO booking (
        user_id, quote_id, property_id, room_type_id, booking_number, checkin_date,
        checkout_date, guests, property_snapshot, room_type_snapshot, nightly_prices,
        booking_policy_snapshot, total_price_cents, idempotency_key, expires_at, updated_at
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'SF20260801ABCDEF123456', DATE '2026-08-01',
        DATE '2026-08-02', 2, '{"name":"fixture"}'::jsonb, '{"name":"fixture"}'::jsonb,
        '[15000]'::jsonb, 'fixture policy', 15000, $5, CURRENT_TIMESTAMP + INTERVAL '15 minutes', CURRENT_TIMESTAMP
      ) RETURNING id::text
    `,
      [ids.user_id, quoteId, ids.property_id, ids.room_type_id, "key_".padEnd(32, "x")],
    );
    const bookingId = booking.rows[0]?.id;
    const hold = await database().query<{ id: string }>(
      `
      INSERT INTO inventory_hold (booking_id, room_type_id, business_date, expires_at, updated_at)
      VALUES ($1::uuid, $2::uuid, DATE '2026-08-01', CURRENT_TIMESTAMP + INTERVAL '15 minutes', CURRENT_TIMESTAMP)
      RETURNING id::text
    `,
      [bookingId, ids.room_type_id],
    );
    const history = await database().query<{ id: string }>(
      `
      INSERT INTO booking_status_history (booking_id, to_status, reason, actor_type, actor_user_id)
      VALUES ($1::uuid, 'PENDING_PAYMENT', 'BOOKING_CREATED', 'USER', $2::uuid)
      RETURNING id::text
    `,
      [bookingId, ids.user_id],
    );

    await expectCheckViolation(
      "UPDATE quote SET checkout_date = checkin_date WHERE id = $1::uuid",
      [quoteId],
    );
    await expectCheckViolation("UPDATE quote SET guests = 0 WHERE id = $1::uuid", [quoteId]);
    await expectCheckViolation("UPDATE quote SET total_price_cents = -1 WHERE id = $1::uuid", [
      quoteId,
    ]);
    await expectCheckViolation("UPDATE quote SET currency = 'USD' WHERE id = $1::uuid", [quoteId]);
    await expectCheckViolation("UPDATE quote SET fingerprint = $2 WHERE id = $1::uuid", [
      quoteId,
      "A".repeat(64),
    ]);
    await expectCheckViolation("UPDATE quote SET expires_at = created_at WHERE id = $1::uuid", [
      quoteId,
    ]);
    await expectCheckViolation(
      "UPDATE booking SET checkout_date = checkin_date WHERE id = $1::uuid",
      [bookingId],
    );
    await expectCheckViolation("UPDATE booking SET guests = 11 WHERE id = $1::uuid", [bookingId]);
    await expectCheckViolation("UPDATE booking SET total_price_cents = -1 WHERE id = $1::uuid", [
      bookingId,
    ]);
    await expectCheckViolation("UPDATE booking SET currency = 'USD' WHERE id = $1::uuid", [
      bookingId,
    ]);
    await expectCheckViolation("UPDATE booking SET booking_number = 'bad' WHERE id = $1::uuid", [
      bookingId,
    ]);
    await expectCheckViolation("UPDATE booking SET idempotency_key = 'short' WHERE id = $1::uuid", [
      bookingId,
    ]);
    await expectCheckViolation("UPDATE booking SET expires_at = created_at WHERE id = $1::uuid", [
      bookingId,
    ]);
    await expectCheckViolation(
      "UPDATE inventory_hold SET expires_at = created_at WHERE id = $1::uuid",
      [hold.rows[0]?.id],
    );
    await expectCheckViolation(
      "UPDATE booking_status_history SET actor_user_id = NULL WHERE id = $1::uuid",
      [history.rows[0]?.id],
    );
    await expectCheckViolation(
      "UPDATE booking_status_history SET actor_type = 'SYSTEM' WHERE id = $1::uuid",
      [history.rows[0]?.id],
    );

    const persistedRows = await database().query<{
      booking_currency: string;
      booking_guests: number;
      booking_number: string;
      booking_total_price_cents: number;
      history_actor_type: string;
      hold_status: string;
      quote_currency: string;
      quote_total_price_cents: number;
    }>(
      `
      SELECT
        quote.currency::text AS quote_currency,
        quote.total_price_cents AS quote_total_price_cents,
        booking.currency::text AS booking_currency,
        booking.total_price_cents AS booking_total_price_cents,
        booking.guests AS booking_guests,
        booking.booking_number,
        inventory_hold.status::text AS hold_status,
        history.actor_type::text AS history_actor_type
      FROM quote
      JOIN booking ON booking.quote_id = quote.id
      JOIN inventory_hold ON inventory_hold.booking_id = booking.id
      JOIN booking_status_history history ON history.booking_id = booking.id
      WHERE quote.id = $1::uuid
    `,
      [quoteId],
    );
    expect(persistedRows.rows).toEqual([
      {
        quote_currency: "CNY",
        quote_total_price_cents: 15000,
        booking_currency: "CNY",
        booking_total_price_cents: 15000,
        booking_guests: 2,
        booking_number: "SF20260801ABCDEF123456",
        hold_status: "HELD",
        history_actor_type: "USER",
      },
    ]);

    const baselineCounts = await database().query<{
      daily_inventory_count: number;
      daily_price_count: number;
      property_count: number;
      room_type_count: number;
      user_count: number;
    }>(`
      SELECT
        (SELECT COUNT(*)::integer FROM "user") AS user_count,
        (SELECT COUNT(*)::integer FROM property) AS property_count,
        (SELECT COUNT(*)::integer FROM room_type) AS room_type_count,
        (SELECT COUNT(*)::integer FROM daily_price) AS daily_price_count,
        (SELECT COUNT(*)::integer FROM daily_inventory) AS daily_inventory_count
    `);
    expect(baselineCounts.rows).toEqual([
      {
        user_count: 1,
        property_count: 1,
        room_type_count: 1,
        daily_price_count: 1,
        daily_inventory_count: 1,
      },
    ]);
  }, 25_000);

  test("returns exact date-only nightly prices across month boundaries in a non-UTC session", async () => {
    await applyTargetMigration();
    const fixture = await createScenarioFixture({
      dates: ["2030-01-31", "2030-02-01"],
      checkout: "2030-02-02",
      totals: [2, 2],
    });
    const { lookup, sessionRows } = await activeRepositoryDatabase().$transaction(
      async (transaction) => {
        await transaction.$queryRaw(
          Prisma.sql`SELECT set_config('TimeZone', 'Pacific/Auckland', true)`,
        );
        const scopedSessionRows = await transaction.$queryRaw<Array<{ timezone: string }>>(
          Prisma.sql`SELECT current_setting('TimeZone') AS timezone`,
        );
        const scopedLookup = await new QuoteRepository(transaction).findQuoteInput(fixture.roomId, {
          checkin: fixture.dates[0]!,
          checkout: fixture.checkout,
          nights: fixture.dates.length,
          guests: 2,
        });
        return { lookup: scopedLookup, sessionRows: scopedSessionRows };
      },
    );
    expect(sessionRows).toEqual([{ timezone: "Pacific/Auckland" }]);

    expect(lookup.status).toBe("AVAILABLE");
    if (lookup.status !== "AVAILABLE") {
      throw new Error(`Expected an available quote lookup, received ${lookup.status}`);
    }
    const businessDates = lookup.nightlyPrices.map(({ businessDate }) => businessDate);
    expect(businessDates).toEqual(fixture.dates);
    for (const businessDate of businessDates) {
      expect(businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(businessDate).not.toMatch(/[T+\s:]/);
    }
  }, 25_000);

  test("serializes two users competing for one available room night", async () => {
    await applyTargetMigration();
    const fixture = await createScenarioFixture({
      dates: ["2030-02-01"],
      checkout: "2030-02-02",
      totals: [1],
      userCount: 2,
    });
    const firstQuote = await createQuote(fixture, fixture.users[0]!);
    const secondQuote = await createQuote(fixture, fixture.users[1]!);
    const barrier = createBarrier(2, 5_000);
    const backendPids = new Set<number>();
    const concurrentDatabase = createConcurrentDatabase(barrier, backendPids);
    let results: CreateBookingResult[];
    try {
      results = await Promise.all([
        createThroughRepository(repositoryInput(fixture.users[0]!, firstQuote), concurrentDatabase),
        createThroughRepository(
          repositoryInput(fixture.users[1]!, secondQuote),
          concurrentDatabase,
        ),
      ]);
    } finally {
      barrier.release();
    }
    expect(backendPids.size).toBe(2);
    expect(results.map(({ kind }) => kind).sort()).toEqual(["CREATED", "INVENTORY_UNAVAILABLE"]);
    const state = await readScenarioState(fixture);
    expect(state.bookingRows).toHaveLength(1);
    expect(state.holdCount).toBe(1);
    expect(state.holdStatuses).toEqual(["HELD"]);
    expect(state.historyCount).toBe(1);
    expect(state.inventories).toEqual([
      {
        business_date: "2030-02-01",
        total_inventory: 1,
        held_inventory: 1,
        sold_inventory: 0,
        version: 1,
      },
    ]);
  }, 25_000);

  test("replays concurrent requests with the same user and idempotency key exactly once", async () => {
    await applyTargetMigration();
    const fixture = await createScenarioFixture({
      dates: ["2030-03-01"],
      checkout: "2030-03-02",
      totals: [1],
    });
    const quoteId = await createQuote(fixture, fixture.users[0]!);
    const idempotencyKey = nextIdempotencyKey();
    const barrier = createBarrier(2, 5_000);
    const backendPids = new Set<number>();
    const concurrentDatabase = createConcurrentDatabase(barrier, backendPids);
    let results: CreateBookingResult[];
    try {
      results = await Promise.all([
        createThroughRepository(
          repositoryInput(fixture.users[0]!, quoteId, idempotencyKey),
          concurrentDatabase,
        ),
        createThroughRepository(
          repositoryInput(fixture.users[0]!, quoteId, idempotencyKey),
          concurrentDatabase,
        ),
      ]);
    } finally {
      barrier.release();
    }
    expect(backendPids.size).toBe(2);
    expect(results.map(({ kind }) => kind).sort()).toEqual(["CREATED", "REPLAYED"]);
    const bookingIds = results.flatMap((result) =>
      result.kind === "CREATED" || result.kind === "REPLAYED" ? [result.booking.booking_id] : [],
    );
    const bookingNumbers = results.flatMap((result) =>
      result.kind === "CREATED" || result.kind === "REPLAYED"
        ? [result.booking.booking_number]
        : [],
    );
    expect(new Set(bookingIds).size).toBe(1);
    expect(new Set(bookingNumbers).size).toBe(1);
    const state = await readScenarioState(fixture);
    expect(state.bookingRows).toHaveLength(1);
    expect(state.holdCount).toBe(1);
    expect(state.holdStatuses).toEqual(["HELD"]);
    expect(state.historyCount).toBe(1);
    expect(state.inventories).toEqual([
      {
        business_date: "2030-03-01",
        total_inventory: 1,
        held_inventory: 1,
        sold_inventory: 0,
        version: 1,
      },
    ]);
  }, 25_000);

  test("allows only one idempotency key to consume the same quote", async () => {
    await applyTargetMigration();
    const fixture = await createScenarioFixture({
      dates: ["2030-04-01"],
      checkout: "2030-04-02",
      totals: [1],
    });
    const quoteId = await createQuote(fixture, fixture.users[0]!);
    const barrier = createBarrier(2, 5_000);
    const backendPids = new Set<number>();
    const concurrentDatabase = createConcurrentDatabase(barrier, backendPids);
    let results: CreateBookingResult[];
    try {
      results = await Promise.all([
        createThroughRepository(repositoryInput(fixture.users[0]!, quoteId), concurrentDatabase),
        createThroughRepository(repositoryInput(fixture.users[0]!, quoteId), concurrentDatabase),
      ]);
    } finally {
      barrier.release();
    }
    expect(backendPids.size).toBe(2);
    expect(results.map(({ kind }) => kind).sort()).toEqual(["CREATED", "QUOTE_ALREADY_USED"]);
    const state = await readScenarioState(fixture);
    expect(state.bookingRows).toHaveLength(1);
    expect(state.holdCount).toBe(1);
    expect(state.holdStatuses).toEqual(["HELD"]);
    expect(state.historyCount).toBe(1);
    expect(state.inventories).toEqual([
      {
        business_date: "2030-04-01",
        total_inventory: 1,
        held_inventory: 1,
        sold_inventory: 0,
        version: 1,
      },
    ]);
  }, 25_000);

  test("rolls back a multi-night booking when any night is unavailable", async () => {
    await applyTargetMigration();
    const fixture = await createScenarioFixture({
      dates: ["2030-05-01", "2030-05-02"],
      checkout: "2030-05-03",
      totals: [1, 0],
    });
    const quoteId = await createQuote(fixture, fixture.users[0]!);
    await expect(
      createThroughRepository(repositoryInput(fixture.users[0]!, quoteId)),
    ).resolves.toEqual({ kind: "INVENTORY_UNAVAILABLE" });
    const state = await readScenarioState(fixture);
    expect(state.bookingRows).toEqual([]);
    expect(state.holdCount).toBe(0);
    expect(state.holdStatuses).toEqual([]);
    expect(state.historyCount).toBe(0);
    expect(state.inventories).toEqual([
      {
        business_date: "2030-05-01",
        total_inventory: 1,
        held_inventory: 0,
        sold_inventory: 0,
        version: 0,
      },
      {
        business_date: "2030-05-02",
        total_inventory: 0,
        held_inventory: 0,
        sold_inventory: 0,
        version: 0,
      },
    ]);
  }, 25_000);

  test("creates a user-owned replacement quote after price and policy changes without holds", async () => {
    await applyTargetMigration();
    const fixture = await createScenarioFixture({
      dates: ["2030-06-01"],
      checkout: "2030-06-02",
      totals: [1],
    });
    const userId = fixture.users[0]!;
    const quoteId = await createQuote(fixture, userId);
    await database().query(
      `
      UPDATE daily_price
      SET sale_price_cents = sale_price_cents + 500,
          rack_price_cents = rack_price_cents + 500,
          updated_at = CURRENT_TIMESTAMP
      WHERE room_type_id = $1::uuid
    `,
      [fixture.roomId],
    );
    await database().query(
      `UPDATE room_type SET booking_policy_zh = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1::uuid`,
      [fixture.roomId, `${fixture.policy}-changed`],
    );
    const result = await createThroughRepository(repositoryInput(userId, quoteId));
    expect(result.kind).toBe("QUOTE_CHANGED");
    if (result.kind === "QUOTE_CHANGED") {
      expect(result.details.replacement_quote.total_price_cents).toBe(15_500);
      expect(result.details.replacement_quote.booking_policy).toBe(`${fixture.policy}-changed`);
    }
    const replacements = await database().query<{ id: string; user_id: string }>(
      `
      SELECT id::text, user_id::text
      FROM quote
      WHERE room_type_id = $1::uuid AND id <> $2::uuid
    `,
      [fixture.roomId, quoteId],
    );
    expect(replacements.rows).toHaveLength(1);
    expect(replacements.rows[0]?.user_id).toBe(userId);
    if (result.kind === "QUOTE_CHANGED") {
      expect(replacements.rows[0]?.id).toBe(result.details.replacement_quote.quote_id);
    }
    const state = await readScenarioState(fixture);
    expect(state.bookingRows).toEqual([]);
    expect(state.holdCount).toBe(0);
    expect(state.holdStatuses).toEqual([]);
    expect(state.historyCount).toBe(0);
    expect(state.inventories).toEqual([
      {
        business_date: "2030-06-01",
        total_inventory: 1,
        held_inventory: 0,
        sold_inventory: 0,
        version: 0,
      },
    ]);
  }, 25_000);

  test("does not hold inventory for an expired quote", async () => {
    await applyTargetMigration();
    const fixture = await createScenarioFixture({
      dates: ["2030-07-01"],
      checkout: "2030-07-02",
      totals: [1],
    });
    const quoteId = await createQuote(
      fixture,
      fixture.users[0]!,
      new Date("2030-01-01T00:04:00.000Z"),
    );
    await expect(
      createThroughRepository(
        repositoryInput(fixture.users[0]!, quoteId),
        activeRepositoryDatabase(),
        clockAt(new Date("2030-01-01T00:05:00.000Z")),
      ),
    ).resolves.toEqual({ kind: "QUOTE_EXPIRED" });
    const state = await readScenarioState(fixture);
    expect(state.bookingRows).toEqual([]);
    expect(state.holdCount).toBe(0);
    expect(state.holdStatuses).toEqual([]);
    expect(state.historyCount).toBe(0);
    expect(state.inventories).toEqual([
      {
        business_date: "2030-07-01",
        total_inventory: 1,
        held_inventory: 0,
        sold_inventory: 0,
        version: 0,
      },
    ]);
  }, 25_000);

  test("hides another user's quote as expired without reads or holds", async () => {
    await applyTargetMigration();
    const fixture = await createScenarioFixture({
      dates: ["2030-08-01"],
      checkout: "2030-08-02",
      totals: [1],
      userCount: 2,
    });
    const quoteId = await createQuote(fixture, fixture.users[0]!);
    await expect(
      createThroughRepository(repositoryInput(fixture.users[1]!, quoteId)),
    ).resolves.toEqual({ kind: "QUOTE_EXPIRED" });
    const state = await readScenarioState(fixture);
    expect(state.bookingRows).toEqual([]);
    expect(state.holdCount).toBe(0);
    expect(state.holdStatuses).toEqual([]);
    expect(state.historyCount).toBe(0);
    expect(state.inventories).toEqual([
      {
        business_date: "2030-08-01",
        total_inventory: 1,
        held_inventory: 0,
        sold_inventory: 0,
        version: 0,
      },
    ]);
  }, 25_000);

  test("rolls back a booking-number collision and retries the full service transaction once", async () => {
    await applyTargetMigration();
    const collisionNumber = nextBookingNumber();
    const blocker = await createScenarioFixture({
      dates: ["2030-09-01"],
      checkout: "2030-09-02",
      totals: [1],
    });
    const blockerUser = blocker.users[0]!;
    const blockerQuote = await createQuote(blocker, blockerUser);
    await database().query(
      `
      INSERT INTO booking (
        user_id, quote_id, property_id, room_type_id, booking_number, status,
        checkin_date, checkout_date, guests, property_snapshot, room_type_snapshot,
        nightly_prices, booking_policy_snapshot, total_price_cents, currency,
        idempotency_key, expires_at, created_at, updated_at
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'PENDING_PAYMENT',
        $6::date, $7::date, 2, $8::jsonb, $9::jsonb, $10::jsonb, $11,
        $12, 'CNY', $13, $14, $15, $15
      )
    `,
      [
        blockerUser,
        blockerQuote,
        blocker.propertyId,
        blocker.roomId,
        collisionNumber,
        blocker.dates[0],
        blocker.checkout,
        JSON.stringify({ id: blocker.propertyId, name: blocker.propertyName }),
        JSON.stringify({
          id: blocker.roomId,
          name: blocker.roomName,
          cover_url: "https://example.test/room.jpg",
        }),
        JSON.stringify([
          {
            business_date: blocker.dates[0],
            sale_price_cents: blocker.prices[0]!.sale,
            rack_price_cents: blocker.prices[0]!.rack,
            currency: "CNY",
          },
        ]),
        blocker.policy,
        blocker.prices[0]!.sale,
        nextIdempotencyKey(),
        new Date("2030-01-01T00:15:00.000Z"),
        new Date("2029-12-31T23:59:00.000Z"),
      ],
    );

    const fixture = await createScenarioFixture({
      dates: ["2030-10-01"],
      checkout: "2030-10-02",
      totals: [1],
    });
    const userId = fixture.users[0]!;
    const quoteId = await createQuote(fixture, userId);
    const successfulNumber = nextBookingNumber();
    const generatedNumbers = [collisionNumber, successfulNumber];
    let generatorCalls = 0;
    const generator: BookingNumberGenerator = {
      next: () => {
        generatorCalls += 1;
        const value = generatedNumbers.shift();
        if (value === undefined) {
          throw new Error("Unexpected booking number request");
        }
        return value;
      },
    };
    const rateLimit = {
      checkBookings: () => Promise.resolve(),
    } as unknown as WriteRateLimitService;
    const repository = new BookingRepository(activeRepositoryDatabase(), clockAt(testNow));
    const service = new BookingsService(repository, rateLimit, clockAt(testNow), generator);
    const result = await service.create(userId, nextIdempotencyKey(), { quote_id: quoteId });
    expect(result.replayed).toBe(false);
    expect(result.booking.booking_number).toBe(successfulNumber);
    expect(generatorCalls).toBe(2);
    const state = await readScenarioState(fixture);
    expect(state.bookingRows).toHaveLength(1);
    expect(state.bookingRows[0]?.booking_number).toBe(successfulNumber);
    expect(state.holdCount).toBe(1);
    expect(state.holdStatuses).toEqual(["HELD"]);
    expect(state.historyCount).toBe(1);
    expect(state.inventories).toEqual([
      {
        business_date: "2030-10-01",
        total_inventory: 1,
        held_inventory: 1,
        sold_inventory: 0,
        version: 1,
      },
    ]);
  }, 25_000);
});

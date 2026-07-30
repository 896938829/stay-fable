import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import { PrismaPg } from "@prisma/adapter-pg";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { runSeed } from "../../prisma/seed.js";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import { requireSafeDatabaseIntegrationUrl } from "./database-integration-guard.js";

const runDatabaseIntegration = process.env.RUN_DATABASE_INTEGRATION === "true";
const describeDatabase = runDatabaseIntegration ? describe : describe.skip;
const suiteName = runDatabaseIntegration
  ? "catalog supply PostgreSQL baseline"
  : "catalog supply PostgreSQL baseline (set RUN_DATABASE_INTEGRATION=true to run)";

const managedTables = [
  "city",
  "property",
  "property_media",
  "facility",
  "property_facility",
  "room_type",
  "daily_price",
  "daily_inventory",
] as const;

const expectedCatalogIdentityConflict =
  "Catalog seed identity conflict: existing id/business-key mapping does not match fixed reference data";
const expectedCatalogInventoryCapacityConflict =
  "Catalog seed inventory capacity conflict: managed total is below occupied inventory";
const migrationFiles = [
  "../../prisma/migrations/202607290001_identity_location/migration.sql",
  "../../prisma/migrations/202607290002_user_session_version/migration.sql",
  "../../prisma/migrations/202607290003_session_version_monotonic/migration.sql",
  "../../prisma/migrations/202607290004_catalog_supply/migration.sql",
] as const;
const expectedCatalogForeignKeys = [
  "daily_inventory_room_type_id_fkey",
  "daily_price_room_type_id_fkey",
  "property_city_id_fkey",
  "property_facility_facility_id_fkey",
  "property_facility_property_id_fkey",
  "property_media_property_id_fkey",
  "room_type_property_id_fkey",
] as const;

const quoteGeneratedTestSchema = (schemaName: string): string => {
  if (!/^catalog_seed_test_[0-9a-f]{16}$/.test(schemaName)) {
    throw new Error("Invalid generated catalog test schema");
  }
  return `"${schemaName}"`;
};

const awaitWithin = async <T>(promise: Promise<T>, milliseconds: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out after ${milliseconds}ms`)),
      milliseconds,
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(
          error instanceof Error
            ? error
            : new Error("Promise rejected with a non-Error reason", { cause: error }),
        );
      },
    );
  });

const normalizeFailure = (error: unknown, message: string): Error =>
  error instanceof Error ? error : new Error(message, { cause: error });

const finalizeIsolatedCatalogSeedTest = async ({
  disconnect,
  dropSchema,
  testFailure,
  timeoutMs = 3_000,
}: {
  disconnect: () => Promise<void>;
  dropSchema: () => Promise<void>;
  testFailure?: Error;
  timeoutMs?: number;
}): Promise<void> => {
  const cleanupFailures: Error[] = [];
  try {
    await awaitWithin(
      Promise.resolve().then(() => disconnect()),
      timeoutMs,
    );
  } catch (error: unknown) {
    cleanupFailures.push(
      new Error("Isolated Prisma disconnect cleanup failed", {
        cause: normalizeFailure(error, "Unknown disconnect cleanup failure"),
      }),
    );
  }
  try {
    await awaitWithin(
      Promise.resolve().then(() => dropSchema()),
      timeoutMs,
    );
  } catch (error: unknown) {
    cleanupFailures.push(
      new Error("Isolated schema DROP cleanup failed", {
        cause: normalizeFailure(error, "Unknown schema cleanup failure"),
      }),
    );
  }

  if (testFailure !== undefined) {
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [testFailure, ...cleanupFailures],
        "Dynamic catalog seed test and cleanup failed",
      );
    }
    throw testFailure;
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, "Dynamic catalog seed test cleanup failed");
  }
};

test("isolated catalog cleanup bounds disconnect and DROP independently", async () => {
  const source = await readFile(new URL(import.meta.url), "utf8");
  const helper = source.match(
    /^const finalizeIsolatedCatalogSeedTest = async \([\s\S]*?^\};$/m,
  )?.[0];

  expect(helper, "bounded isolated catalog cleanup helper must be defined").toBeTypeOf("string");
  expect(helper).toMatch(/awaitWithin\([\s\S]*disconnect\(\)/);
  expect(helper).toMatch(/awaitWithin\([\s\S]*dropSchema\(\)/);
});

test("pending isolated cleanup still attempts DROP and preserves every failure", async () => {
  const primaryFailure = new Error("primary test failure");
  let dropCalls = 0;
  let disconnectAggregate: unknown;

  try {
    await finalizeIsolatedCatalogSeedTest({
      testFailure: primaryFailure,
      disconnect: async () => new Promise(() => {}),
      dropSchema: () => {
        dropCalls += 1;
        return Promise.resolve();
      },
      timeoutMs: 20,
    });
  } catch (error: unknown) {
    disconnectAggregate = error;
  }

  expect(dropCalls).toBe(1);
  expect(disconnectAggregate).toBeInstanceOf(AggregateError);
  expect((disconnectAggregate as AggregateError).errors[0]).toBe(primaryFailure);
  expect((disconnectAggregate as AggregateError).errors[1]).toMatchObject({
    message: "Isolated Prisma disconnect cleanup failed",
  });

  await expect(
    finalizeIsolatedCatalogSeedTest({
      disconnect: async () => {},
      dropSchema: async () => new Promise(() => {}),
      timeoutMs: 20,
    }),
  ).rejects.toMatchObject({
    errors: [{ message: "Isolated schema DROP cleanup failed" }],
    message: "Dynamic catalog seed test cleanup failed",
  });
});

describeDatabase(suiteName, () => {
  let pool: Pool;
  let prisma: PrismaClient;

  const getManagedCounts = async (
    queryable: Pick<Pool, "query"> = pool,
  ): Promise<Record<(typeof managedTables)[number], number>> => {
    const entries = await Promise.all(
      managedTables.map(async (table) => {
        const result = await queryable.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM "${table}"`,
        );
        return [table, Number(result.rows[0]?.count)] as const;
      }),
    );

    return Object.fromEntries(entries) as Record<(typeof managedTables)[number], number>;
  };

  const expectCheckViolation = async (
    sql: string,
    values: unknown[],
    constraint: string,
  ): Promise<void> => {
    await expect(pool.query(sql, values)).rejects.toMatchObject({
      code: "23514",
      constraint,
    });
  };

  beforeAll(async () => {
    const connectionString = requireSafeDatabaseIntegrationUrl(process.env.DATABASE_URL);
    pool = new Pool({ connectionString });
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString }),
    });
    await runSeed(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
  });

  test("seed creates the fixed catalog supply row counts", async () => {
    await expect(getManagedCounts()).resolves.toMatchObject({
      facility: 4,
      property: 6,
      property_facility: 18,
      property_media: 6,
      room_type: 12,
      daily_price: 720,
      daily_inventory: 720,
    });
  });

  test("daily inventory exposes the exact downstream column and default contract", async () => {
    const columns = await pool.query<{
      column_default: string | null;
      column_name: string;
    }>(`
      SELECT column_name, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'daily_inventory'
        AND column_name IN (
          'total',
          'held',
          'sold',
          'total_inventory',
          'held_inventory',
          'sold_inventory',
          'version'
        )
      ORDER BY ordinal_position
    `);

    expect(columns.rows).toEqual([
      { column_default: null, column_name: "total_inventory" },
      { column_default: "0", column_name: "held_inventory" },
      { column_default: "0", column_name: "sold_inventory" },
      { column_default: "0", column_name: "version" },
    ]);
  });

  test("each city has all property types and every property has two rooms", async () => {
    const cityPropertyTypes = await pool.query<{
      city_code: string;
      property_type: string;
      property_count: number;
    }>(`
      SELECT
        c.code AS city_code,
        p.type::text AS property_type,
        COUNT(*)::integer AS property_count
      FROM city c
      JOIN property p ON p.city_id = c.id
      GROUP BY c.code, p.type
      ORDER BY c.code, p.type
    `);

    expect(cityPropertyTypes.rows).toHaveLength(6);
    for (const cityCode of ["330100", "520100"]) {
      expect(
        cityPropertyTypes.rows
          .filter(({ city_code: code }) => code === cityCode)
          .map(({ property_count, property_type: type }) => ({ property_count, type }))
          .sort((left, right) => left.type.localeCompare(right.type)),
      ).toEqual([
        { property_count: 1, type: "FARM_STAY" },
        { property_count: 1, type: "HOMESTAY" },
        { property_count: 1, type: "HOTEL" },
      ]);
    }

    const roomCounts = await pool.query<{ room_count: number }>(`
      SELECT COUNT(r.id)::integer AS room_count
      FROM property p
      LEFT JOIN room_type r ON r.property_id = p.id
      GROUP BY p.id
      ORDER BY p.id
    `);
    expect(roomCounts.rows).toHaveLength(6);
    expect(roomCounts.rows.every(({ room_count: count }) => count === 2)).toBe(true);
  });

  test("properties have the exact facility links and one ordered image", async () => {
    const facilityLinks = await pool.query<{
      facility_codes: string[];
      property_type: string;
    }>(`
      SELECT
        p.type::text AS property_type,
        array_agg(f.code ORDER BY f.code) AS facility_codes
      FROM property p
      JOIN property_facility pf ON pf.property_id = p.id
      JOIN facility f ON f.id = pf.facility_id
      GROUP BY p.id, p.type
      ORDER BY p.id
    `);

    expect(facilityLinks.rows).toHaveLength(6);
    expect(
      facilityLinks.rows.filter(
        ({ facility_codes: codes, property_type: type }) =>
          type === "HOTEL" &&
          JSON.stringify(codes) === JSON.stringify(["BREAKFAST", "PARKING", "WIFI"]),
      ),
    ).toHaveLength(2);
    expect(
      facilityLinks.rows.filter(
        ({ facility_codes: codes, property_type: type }) =>
          (type === "HOMESTAY" || type === "FARM_STAY") &&
          JSON.stringify(codes) === JSON.stringify(["FAMILY", "PARKING", "WIFI"]),
      ),
    ).toHaveLength(4);

    const media = await pool.query<{
      display_order: number;
      media_count: number;
      media_type: string;
    }>(`
      SELECT
        pm.type::text AS media_type,
        pm.display_order,
        COUNT(*)::integer AS media_count
      FROM property p
      LEFT JOIN property_media pm ON pm.property_id = p.id
      GROUP BY p.id, pm.type, pm.display_order
      ORDER BY p.id
    `);
    expect(media.rows).toHaveLength(6);
    expect(media.rows).toEqual(
      Array.from({ length: 6 }, () => ({
        display_order: 10,
        media_count: 1,
        media_type: "IMAGE",
      })),
    );
  });

  test("room and daily supply fixtures match the exact capacity and weekly price formula", async () => {
    const propertyFixtures = [
      { nameZh: "西湖云栖酒店", prices: [42_800, 56_800] },
      { nameZh: "龙井山居", prices: [32_800, 44_800] },
      { nameZh: "青山田园农庄", prices: [26_800, 38_800] },
      { nameZh: "筑城观山酒店", prices: [39_800, 52_800] },
      { nameZh: "黔灵巷居", prices: [29_800, 41_800] },
      { nameZh: "花溪稻田农庄", prices: [23_800, 35_800] },
    ] as const;
    const rooms = await pool.query<{
      area_sqm: string;
      base_price_cents: number;
      max_guests: number;
      name_zh: string;
      property_name_zh: string;
      room_type_id: string;
      total_inventory: number;
    }>(`
      SELECT
        p.name_zh AS property_name_zh,
        r.id::text AS room_type_id,
        r.name_zh,
        r.area_sqm::text,
        r.max_guests,
        inventory.total_inventory,
        price.sale_price_cents AS base_price_cents
      FROM property p
      JOIN room_type r ON r.property_id = p.id
      JOIN daily_inventory inventory
        ON inventory.room_type_id = r.id
       AND inventory.business_date = DATE '2026-07-30'
      JOIN daily_price price
        ON price.room_type_id = r.id
       AND price.business_date = DATE '2026-07-30'
      ORDER BY p.id, r.display_order
    `);

    expect(rooms.rows).toHaveLength(12);
    expect(
      rooms.rows.map(
        ({
          area_sqm: areaSqm,
          base_price_cents: basePriceCents,
          max_guests: maxGuests,
          name_zh: nameZh,
          property_name_zh: propertyNameZh,
          total_inventory: totalInventory,
        }) => ({
          areaSqm,
          basePriceCents,
          maxGuests,
          nameZh,
          propertyNameZh,
          totalInventory,
        }),
      ),
    ).toEqual(
      propertyFixtures.flatMap((property, propertyIndex) => [
        {
          areaSqm: "28.00",
          basePriceCents: property.prices[0],
          maxGuests: 2,
          nameZh: "舒适大床房",
          propertyNameZh: property.nameZh,
          totalInventory: propertyIndex === 0 ? 1 : 3,
        },
        {
          areaSqm: "38.00",
          basePriceCents: property.prices[1],
          maxGuests: 4,
          nameZh: "家庭双床房",
          propertyNameZh: property.nameZh,
          totalInventory: 2,
        },
      ]),
    );

    const priceDates = [
      { businessDate: "2026-07-30", offset: 0 },
      { businessDate: "2026-08-05", offset: 6 },
      { businessDate: "2026-08-06", offset: 7 },
      { businessDate: "2026-09-27", offset: 59 },
    ] as const;
    const prices = await pool.query<{
      business_date: string;
      rack_price_cents: number;
      room_type_id: string;
      sale_price_cents: number;
    }>(`
      SELECT
        room_type_id::text,
        business_date::text,
        sale_price_cents,
        rack_price_cents
      FROM daily_price
      WHERE business_date IN (
        DATE '2026-07-30',
        DATE '2026-08-05',
        DATE '2026-08-06',
        DATE '2026-09-27'
      )
      ORDER BY room_type_id, business_date
    `);
    const basePriceByRoom = new Map(
      rooms.rows.map(({ base_price_cents: basePrice, room_type_id: roomId }) => [
        roomId,
        basePrice,
      ]),
    );

    expect(prices.rows).toHaveLength(48);
    for (const price of prices.rows) {
      const expectedDate = priceDates.find(
        ({ businessDate }) => businessDate === price.business_date,
      );
      const basePrice = basePriceByRoom.get(price.room_type_id);
      expect(expectedDate).toBeDefined();
      expect(basePrice).toBeDefined();
      const expectedSale = (basePrice ?? 0) + ((expectedDate?.offset ?? 0) % 7) * 1_000;
      expect(price.sale_price_cents).toBe(expectedSale);
      expect(price.rack_price_cents - price.sale_price_cents).toBe(6_000);
    }
  });

  test("database metadata exposes the required unique keys, foreign keys, and indexes", async () => {
    const indexes = await pool.query<{ indexdef: string; indexname: string }>(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'property_city_id_name_zh_key',
          'property_city_status_type_order_id_idx',
          'property_location_gix',
          'property_media_property_id_display_order_key',
          'facility_code_key',
          'property_facility_pkey',
          'property_facility_facility_id_idx',
          'room_type_property_id_name_zh_key',
          'room_type_property_status_capacity_order_id_idx',
          'daily_price_date_room_idx',
          'daily_inventory_date_room_idx'
        )
      ORDER BY indexname
    `);
    expect(indexes.rows).toHaveLength(11);

    const indexDefinitions = new Map(
      indexes.rows.map(({ indexdef, indexname }) => [indexname, indexdef]),
    );
    expect(indexDefinitions.get("property_city_id_name_zh_key")).toMatch(
      /UNIQUE.*\(city_id, name_zh\)/,
    );
    expect(indexDefinitions.get("property_media_property_id_display_order_key")).toMatch(
      /UNIQUE.*\(property_id, display_order\)/,
    );
    expect(indexDefinitions.get("room_type_property_id_name_zh_key")).toMatch(
      /UNIQUE.*\(property_id, name_zh\)/,
    );
    expect(indexDefinitions.get("facility_code_key")).toMatch(/UNIQUE.*\(code\)/);
    expect(indexDefinitions.get("property_location_gix")).toMatch(/USING gist \(location\)/i);
    expect(indexDefinitions.get("property_city_status_type_order_id_idx")).toContain(
      "(city_id, status, type, display_order, id)",
    );
    expect(indexDefinitions.get("room_type_property_status_capacity_order_id_idx")).toContain(
      "(property_id, status, max_guests, display_order, id)",
    );
    expect(indexDefinitions.get("daily_price_date_room_idx")).toContain(
      "(business_date, room_type_id)",
    );
    expect(indexDefinitions.get("daily_inventory_date_room_idx")).toContain(
      "(business_date, room_type_id)",
    );

    const foreignKeys = await pool.query<{
      constraint_name: string;
      delete_action: string;
      update_action: string;
    }>(`
      SELECT
        conname AS constraint_name,
        confdeltype::text AS delete_action,
        confupdtype::text AS update_action
      FROM pg_constraint foreign_key
      JOIN pg_class child ON child.oid = foreign_key.conrelid
      JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
      JOIN pg_class parent ON parent.oid = foreign_key.confrelid
      JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
      WHERE foreign_key.contype = 'f'
        AND child_namespace.nspname = 'public'
        AND parent_namespace.nspname = 'public'
        AND conname IN (
          'property_city_id_fkey',
          'property_media_property_id_fkey',
          'property_facility_property_id_fkey',
          'property_facility_facility_id_fkey',
          'room_type_property_id_fkey',
          'daily_price_room_type_id_fkey',
          'daily_inventory_room_type_id_fkey'
        )
      ORDER BY conname
    `);
    expect(foreignKeys.rows).toEqual([
      {
        constraint_name: "daily_inventory_room_type_id_fkey",
        delete_action: "c",
        update_action: "c",
      },
      {
        constraint_name: "daily_price_room_type_id_fkey",
        delete_action: "c",
        update_action: "c",
      },
      {
        constraint_name: "property_city_id_fkey",
        delete_action: "r",
        update_action: "c",
      },
      {
        constraint_name: "property_facility_facility_id_fkey",
        delete_action: "c",
        update_action: "c",
      },
      {
        constraint_name: "property_facility_property_id_fkey",
        delete_action: "c",
        update_action: "c",
      },
      {
        constraint_name: "property_media_property_id_fkey",
        delete_action: "c",
        update_action: "c",
      },
      {
        constraint_name: "room_type_property_id_fkey",
        delete_action: "c",
        update_action: "c",
      },
    ]);
  });

  test("every room has the continuous sixty-day price and inventory horizon", async () => {
    for (const table of ["daily_price", "daily_inventory"] as const) {
      const horizons = await pool.query<{
        day_count: number;
        first_day: string;
        last_day: string;
      }>(`
        SELECT
          COUNT(*)::integer AS day_count,
          MIN(business_date)::text AS first_day,
          MAX(business_date)::text AS last_day
        FROM ${table}
        GROUP BY room_type_id
        ORDER BY room_type_id
      `);

      expect(horizons.rows).toHaveLength(12);
      expect(
        horizons.rows.every(
          ({ day_count: count, first_day: first, last_day: last }) =>
            count === 60 && first === "2026-07-30" && last === "2026-09-27",
        ),
      ).toBe(true);

      const missingDays = await pool.query<{ missing_count: number }>(`
        SELECT COUNT(*)::integer AS missing_count
        FROM room_type r
        CROSS JOIN generate_series(
          DATE '2026-07-30',
          DATE '2026-07-30' + 59,
          INTERVAL '1 day'
        ) AS expected(business_date)
        LEFT JOIN ${table} d
          ON d.room_type_id = r.id
         AND d.business_date = expected.business_date::date
        WHERE d.room_type_id IS NULL
      `);
      expect(missingDays.rows).toEqual([{ missing_count: 0 }]);
    }
  });

  test("running the seed repeatedly keeps all managed table counts stable", async () => {
    const before = await getManagedCounts();

    await runSeed(prisma);
    await runSeed(prisma);

    expect(await getManagedCounts()).toEqual(before);
  });

  test("running the seed restores changed managed descriptive fields", async () => {
    const wifiId = "40000000-0000-4000-8000-000000000001";
    try {
      await pool.query("UPDATE facility SET name_zh = $1 WHERE id = $2::uuid", [
        "被修改的无线网络",
        wifiId,
      ]);

      await runSeed(prisma);

      const wifi = await pool.query<{ name_zh: string }>(
        "SELECT name_zh FROM facility WHERE id = $1::uuid",
        [wifiId],
      );
      expect(wifi.rows).toEqual([{ name_zh: "无线网络" }]);
    } finally {
      await pool.query("UPDATE facility SET name_zh = '无线网络' WHERE id = $1::uuid", [wifiId]);
    }
  });

  test("seed preserves operational inventory and safely rejects occupied capacity reductions", async () => {
    const roomId = "30000000-0000-4000-8000-000000000001";
    const businessDate = "2026-07-30";
    const wifiId = "40000000-0000-4000-8000-000000000001";
    const readInventory = async (): Promise<{
      held_inventory: number;
      sold_inventory: number;
      total_inventory: number;
      updated_at_epoch: string;
      version: number;
    }> => {
      const result = await pool.query<{
        held_inventory: number;
        sold_inventory: number;
        total_inventory: number;
        updated_at_epoch: string;
        version: number;
      }>(
        `
          SELECT
            total_inventory,
            held_inventory,
            sold_inventory,
            version,
            EXTRACT(EPOCH FROM updated_at)::bigint::text AS updated_at_epoch
          FROM daily_inventory
          WHERE room_type_id = $1::uuid
            AND business_date = $2::date
        `,
        [roomId, businessDate],
      );
      const inventory = result.rows[0];
      if (inventory === undefined) {
        throw new Error("Expected fixed inventory row");
      }
      return inventory;
    };

    try {
      await pool.query(
        `
          UPDATE daily_inventory
          SET
            held_inventory = 1,
            sold_inventory = 0,
            version = 7,
            updated_at = TIMESTAMPTZ '2026-01-01 00:00:00+00'
          WHERE room_type_id = $1::uuid
            AND business_date = $2::date
        `,
        [roomId, businessDate],
      );

      await runSeed(prisma);

      expect(await readInventory()).toEqual({
        held_inventory: 1,
        sold_inventory: 0,
        total_inventory: 1,
        updated_at_epoch: "1767225600",
        version: 7,
      });

      await pool.query(
        `
          UPDATE daily_inventory
          SET
            total_inventory = 2,
            held_inventory = 1,
            sold_inventory = 0,
            version = 7,
            updated_at = TIMESTAMPTZ '2026-01-02 00:00:00+00'
          WHERE room_type_id = $1::uuid
            AND business_date = $2::date
        `,
        [roomId, businessDate],
      );

      await runSeed(prisma);

      const restored = await readInventory();
      expect(restored).toMatchObject({
        held_inventory: 1,
        sold_inventory: 0,
        total_inventory: 1,
        version: 8,
      });
      expect(restored.updated_at_epoch).not.toBe("1767312000");

      await pool.query("UPDATE facility SET name_zh = '容量冲突回滚标记' WHERE id = $1::uuid", [
        wifiId,
      ]);
      await pool.query(
        `
          UPDATE daily_inventory
          SET
            total_inventory = 2,
            held_inventory = 2,
            sold_inventory = 0,
            version = 11,
            updated_at = TIMESTAMPTZ '2026-01-03 00:00:00+00'
          WHERE room_type_id = $1::uuid
            AND business_date = $2::date
        `,
        [roomId, businessDate],
      );

      const seedModule = (await import("../../prisma/seed.js")) as unknown as Record<
        string,
        unknown
      >;
      expect(seedModule.CATALOG_SEED_INVENTORY_CAPACITY_CONFLICT_ERROR).toBe(
        expectedCatalogInventoryCapacityConflict,
      );
      await expect(runSeed(prisma)).rejects.toThrowError(expectedCatalogInventoryCapacityConflict);

      expect(await readInventory()).toEqual({
        held_inventory: 2,
        sold_inventory: 0,
        total_inventory: 2,
        updated_at_epoch: "1767398400",
        version: 11,
      });
      const facility = await pool.query<{ name_zh: string }>(
        "SELECT name_zh FROM facility WHERE id = $1::uuid",
        [wifiId],
      );
      expect(facility.rows).toEqual([{ name_zh: "容量冲突回滚标记" }]);
    } finally {
      await pool.query(
        `
          UPDATE daily_inventory
          SET
            total_inventory = 1,
            held_inventory = 0,
            sold_inventory = 0,
            version = 0,
            updated_at = CURRENT_TIMESTAMP
          WHERE room_type_id = $1::uuid
            AND business_date = $2::date
        `,
        [roomId, businessDate],
      );
      await pool.query("UPDATE facility SET name_zh = '无线网络' WHERE id = $1::uuid", [wifiId]);
    }
  });

  test("seed locks inventory in canonical business-date then room order", async () => {
    const suffix = randomBytes(8).toString("hex");
    const applicationName = `catalog_seed_lock_${suffix}`;
    const connectionUrl = new URL(requireSafeDatabaseIntegrationUrl(process.env.DATABASE_URL));
    connectionUrl.searchParams.set("application_name", applicationName);
    const lockOrderPrisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: connectionUrl.toString() }),
    });
    const blocker: PoolClient = await pool.connect();
    const probe: PoolClient = await pool.connect();
    let blockerOpen = false;
    let probeOpen = false;
    let blockerBackendPid: number | undefined;
    let seedBackendPid: number | undefined;
    let seedAttempt: Promise<void> | undefined;
    let seedSettled = false;

    const waitForSeedLock = async (): Promise<void> => {
      if (blockerBackendPid === undefined) {
        throw new Error("Expected blocker backend PID");
      }
      const expectedBlockerPid = blockerBackendPid;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const activity = await pool.query<{
          application_name: string;
          blocking_pids: number[];
          pid: number;
          query: string;
        }>(
          `
            SELECT
              application_name,
              pid,
              query,
              pg_blocking_pids(pid) AS blocking_pids
            FROM pg_stat_activity
            WHERE application_name = $1
              AND state = 'active'
          `,
          [applicationName],
        );
        const blockedSeed = activity.rows.find(
          ({ application_name: activeApplicationName, blocking_pids: blockingPids, query }) =>
            activeApplicationName === applicationName &&
            blockingPids.includes(expectedBlockerPid) &&
            /\bdaily_inventory\b/i.test(query) &&
            /\bFOR\s+UPDATE\b/i.test(query),
        );
        if (blockedSeed !== undefined) {
          seedBackendPid = blockedSeed.pid;
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("Timed out waiting for catalog seed inventory lock");
    };

    try {
      await blocker.query("BEGIN");
      blockerOpen = true;
      const blockerBackend = await blocker.query<{ pid: number }>(
        "SELECT pg_backend_pid()::integer AS pid",
      );
      blockerBackendPid = blockerBackend.rows[0]?.pid;
      expect(blockerBackendPid).toBeTypeOf("number");
      await blocker.query(
        `
          SELECT room_type_id
          FROM daily_inventory
          WHERE room_type_id = '30000000-0000-4000-8000-000000000002'::uuid
            AND business_date = DATE '2026-07-30'
          FOR UPDATE
        `,
      );

      seedAttempt = runSeed(lockOrderPrisma);
      void seedAttempt.then(
        () => {
          seedSettled = true;
        },
        () => {
          seedSettled = true;
        },
      );
      await awaitWithin(waitForSeedLock(), 7_000);
      expect(seedBackendPid).toBeTypeOf("number");

      await probe.query("BEGIN");
      probeOpen = true;
      const probeLock = await probe.query(
        `
          SELECT room_type_id
          FROM daily_inventory
          WHERE room_type_id = '30000000-0000-4000-8000-000000000001'::uuid
            AND business_date = DATE '2026-07-31'
          FOR UPDATE NOWAIT
        `,
      );
      expect(probeLock.rowCount).toBe(1);

      await probe.query("ROLLBACK");
      probeOpen = false;
      await blocker.query("COMMIT");
      blockerOpen = false;
      await awaitWithin(seedAttempt, 7_000);
    } finally {
      try {
        if (blockerOpen) {
          await blocker.query("ROLLBACK");
        }
        if (probeOpen) {
          await probe.query("ROLLBACK");
        }
        if (seedAttempt !== undefined && !seedSettled) {
          await awaitWithin(
            seedAttempt.then(
              () => undefined,
              () => undefined,
            ),
            3_000,
          ).catch(() => undefined);
        }
        if (!seedSettled && seedBackendPid === undefined) {
          const seedActivity = await pool.query<{ pid: number }>(
            `
              SELECT pid
              FROM pg_stat_activity
              WHERE application_name = $1
              ORDER BY (state = 'active') DESC, pid
              LIMIT 1
            `,
            [applicationName],
          );
          seedBackendPid = seedActivity.rows[0]?.pid;
        }
        if (!seedSettled && seedBackendPid !== undefined) {
          const seedActivity = await pool.query<{ state: string }>(
            "SELECT state FROM pg_stat_activity WHERE pid = $1",
            [seedBackendPid],
          );
          if (seedActivity.rows[0]?.state === "active") {
            await pool.query("SELECT pg_cancel_backend($1)", [seedBackendPid]);
          }
        }
        if (seedAttempt !== undefined && !seedSettled) {
          await awaitWithin(
            seedAttempt.then(
              () => undefined,
              () => undefined,
            ),
            3_000,
          );
        }
      } finally {
        probe.release();
        blocker.release();
        await awaitWithin(lockOrderPrisma.$disconnect(), 3_000);
      }
    }
  }, 30_000);

  test("a fixed UUID/business-key conflict rolls back the entire catalog seed", async () => {
    const schemaName = `catalog_seed_test_${randomBytes(8).toString("hex")}`;
    const quotedSchema = quoteGeneratedTestSchema(schemaName);
    const connectionUrl = new URL(requireSafeDatabaseIntegrationUrl(process.env.DATABASE_URL));
    connectionUrl.searchParams.set("options", `-c search_path=${schemaName},public`);
    const isolatedPrisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: connectionUrl.toString() }),
    });

    try {
      await pool.query(`CREATE SCHEMA ${quotedSchema}`);
      for (const table of managedTables) {
        await pool.query(
          `CREATE TABLE ${quotedSchema}."${table}" (LIKE public."${table}" INCLUDING ALL)`,
        );
      }
      await runSeed(isolatedPrisma);

      await pool.query(
        `UPDATE ${quotedSchema}.city SET name_zh = '应在回滚后保留' WHERE code = '330100'`,
      );
      await pool.query(
        `
          UPDATE ${quotedSchema}.facility
          SET id = '49999999-9999-4999-8999-999999999999'::uuid
          WHERE code = 'WIFI'
        `,
      );
      const before = await Promise.all(
        managedTables.map(async (table) => {
          const result = await pool.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM ${quotedSchema}."${table}"`,
          );
          return [table, Number(result.rows[0]?.count)] as const;
        }),
      );

      const seedModule = (await import("../../prisma/seed.js")) as unknown as Record<
        string,
        unknown
      >;
      expect(seedModule.CATALOG_SEED_IDENTITY_CONFLICT_ERROR).toBe(expectedCatalogIdentityConflict);
      await expect(runSeed(isolatedPrisma)).rejects.toThrowError(expectedCatalogIdentityConflict);

      const changedCity = await pool.query<{ name_zh: string }>(
        `SELECT name_zh FROM ${quotedSchema}.city WHERE code = '330100'`,
      );
      expect(changedCity.rows).toEqual([{ name_zh: "应在回滚后保留" }]);

      const after = await Promise.all(
        managedTables.map(async (table) => {
          const result = await pool.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM ${quotedSchema}."${table}"`,
          );
          return [table, Number(result.rows[0]?.count)] as const;
        }),
      );
      expect(Object.fromEntries(after)).toEqual(Object.fromEntries(before));
    } finally {
      await isolatedPrisma.$disconnect();
      await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    }
  });

  test("dynamic catalog windows are idempotent, overlap safely, and roll back capacity conflicts", async () => {
    const schemaName = `catalog_seed_test_${randomBytes(8).toString("hex")}`;
    const quotedSchema = quoteGeneratedTestSchema(schemaName);
    const connectionUrl = new URL(requireSafeDatabaseIntegrationUrl(process.env.DATABASE_URL));
    connectionUrl.searchParams.set("options", `-c search_path=${schemaName},public`);
    const isolatedPrisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: connectionUrl.toString() }),
    });
    const startDateWasPresent = Object.hasOwn(process.env, "STAY_FABLE_CATALOG_START_DATE");
    const previousStartDate = process.env.STAY_FABLE_CATALOG_START_DATE;
    const occupiedRoomId = "30000000-0000-4000-8000-000000000002";
    const conflictRoomId = "30000000-0000-4000-8000-000000000001";
    const wifiId = "40000000-0000-4000-8000-000000000001";
    let testFailure: Error | undefined;

    const readCoverage = async () => {
      const result = await pool.query<{
        first_day: string;
        last_day: string;
        row_count: number;
      }>(`
        SELECT
          MIN(business_date)::text AS first_day,
          MAX(business_date)::text AS last_day,
          COUNT(*)::integer AS row_count
        FROM ${quotedSchema}.daily_price
      `);
      return result.rows[0];
    };
    const readPriceKeys = async (): Promise<string[]> => {
      const result = await pool.query<{ row_key: string }>(`
        SELECT room_type_id::text || ':' || business_date::text AS row_key
        FROM ${quotedSchema}.daily_price
        ORDER BY room_type_id, business_date
      `);
      return result.rows.map(({ row_key: key }) => key);
    };
    const readPublicSnapshot = async (): Promise<unknown> => {
      const result = await pool.query<{ snapshot: unknown }>(`
        SELECT jsonb_build_object(
          'counts', jsonb_build_object(
            'city', (SELECT COUNT(*) FROM public.city),
            'property', (SELECT COUNT(*) FROM public.property),
            'property_media', (SELECT COUNT(*) FROM public.property_media),
            'facility', (SELECT COUNT(*) FROM public.facility),
            'property_facility', (SELECT COUNT(*) FROM public.property_facility),
            'room_type', (SELECT COUNT(*) FROM public.room_type),
            'daily_price', (SELECT COUNT(*) FROM public.daily_price),
            'daily_inventory', (SELECT COUNT(*) FROM public.daily_inventory)
          ),
          'sentinels', jsonb_build_object(
            'city_name', (
              SELECT name_zh FROM public.city
              WHERE id = '10000000-0000-4000-8000-000000000001'::uuid
            ),
            'facility_name', (
              SELECT name_zh FROM public.facility
              WHERE id = '40000000-0000-4000-8000-000000000001'::uuid
            ),
            'property_name', (
              SELECT name_zh FROM public.property
              WHERE id = '20000000-0000-4000-8000-000000000001'::uuid
            ),
            'room_name', (
              SELECT name_zh FROM public.room_type
              WHERE id = '30000000-0000-4000-8000-000000000001'::uuid
            ),
            'price', (
              SELECT jsonb_build_object(
                'sale', sale_price_cents,
                'rack', rack_price_cents
              )
              FROM public.daily_price
              WHERE room_type_id = '30000000-0000-4000-8000-000000000001'::uuid
                AND business_date = DATE '2026-07-30'
            ),
            'inventory', (
              SELECT jsonb_build_object(
                'total', total_inventory,
                'held', held_inventory,
                'sold', sold_inventory,
                'version', version
              )
              FROM public.daily_inventory
              WHERE room_type_id = '30000000-0000-4000-8000-000000000001'::uuid
                AND business_date = DATE '2026-07-30'
            )
          )
        ) AS snapshot
      `);
      return result.rows[0]?.snapshot;
    };

    try {
      const publicBefore = await readPublicSnapshot();
      const setupClient = await pool.connect();
      try {
        await setupClient.query(`CREATE SCHEMA ${quotedSchema}`);
        await setupClient.query(`SET search_path TO ${quotedSchema}, public`);
        for (const migrationFile of migrationFiles) {
          const migrationSql = await readFile(new URL(migrationFile, import.meta.url), "utf8");
          await setupClient.query(migrationSql);
        }
      } finally {
        setupClient.release();
      }

      const foreignKeys = await pool.query<{ constraint_name: string }>(
        `
          SELECT foreign_key.conname AS constraint_name
          FROM pg_constraint foreign_key
          JOIN pg_class child ON child.oid = foreign_key.conrelid
          JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
          JOIN pg_class parent ON parent.oid = foreign_key.confrelid
          JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
          WHERE child_namespace.nspname = $1
            AND parent_namespace.nspname = $1
            AND child.relname IN (
              'property',
              'property_media',
              'property_facility',
              'room_type',
              'daily_price',
              'daily_inventory'
            )
            AND foreign_key.contype = 'f'
          ORDER BY foreign_key.conname
        `,
        [schemaName],
      );
      expect(foreignKeys.rows.map(({ constraint_name: name }) => name)).toEqual(
        expectedCatalogForeignKeys,
      );

      process.env.STAY_FABLE_CATALOG_START_DATE = "2032-02-29";
      await runSeed(isolatedPrisma);
      await runSeed(isolatedPrisma);

      expect(await readCoverage()).toEqual({
        first_day: "2032-02-29",
        last_day: "2032-04-28",
        row_count: 720,
      });
      const firstWindowKeys = await readPriceKeys();
      expect(firstWindowKeys).toHaveLength(720);

      await pool.query(
        `
          UPDATE ${quotedSchema}.daily_price
          SET sale_price_cents = 1, rack_price_cents = 1
          WHERE room_type_id = $1::uuid
            AND business_date = DATE '2032-03-01'
        `,
        [occupiedRoomId],
      );
      await pool.query(
        `
          UPDATE ${quotedSchema}.daily_inventory
          SET held_inventory = 1, sold_inventory = 1, version = 7
          WHERE room_type_id = $1::uuid
            AND business_date = DATE '2032-03-01'
        `,
        [occupiedRoomId],
      );

      process.env.STAY_FABLE_CATALOG_START_DATE = "2032-03-01";
      await runSeed(isolatedPrisma);

      expect(await readCoverage()).toEqual({
        first_day: "2032-02-29",
        last_day: "2032-04-29",
        row_count: 732,
      });
      const secondWindowKeys = await readPriceKeys();
      const firstWindowKeySet = new Set(firstWindowKeys);
      const secondWindowKeySet = new Set(secondWindowKeys);
      expect(firstWindowKeys.filter((key) => !secondWindowKeySet.has(key))).toEqual([]);
      const addedBoundaryKeys = secondWindowKeys.filter((key) => !firstWindowKeySet.has(key));
      expect(addedBoundaryKeys).toHaveLength(12);
      expect(addedBoundaryKeys.every((key) => key.endsWith(":2032-04-29"))).toBe(true);

      const occupiedOverlap = await pool.query<{
        held_inventory: number;
        rack_price_cents: number;
        sale_price_cents: number;
        sold_inventory: number;
        version: number;
      }>(
        `
          SELECT
            inventory.held_inventory,
            price.rack_price_cents,
            price.sale_price_cents,
            inventory.sold_inventory,
            inventory.version
          FROM ${quotedSchema}.daily_inventory inventory
          JOIN ${quotedSchema}.daily_price price
            USING (room_type_id, business_date)
          WHERE inventory.room_type_id = $1::uuid
            AND inventory.business_date = DATE '2032-03-01'
        `,
        [occupiedRoomId],
      );
      expect(occupiedOverlap.rows).toEqual([
        {
          held_inventory: 1,
          rack_price_cents: 62_800,
          sale_price_cents: 56_800,
          sold_inventory: 1,
          version: 7,
        },
      ]);
      expect(await readPublicSnapshot()).toEqual(publicBefore);

      await pool.query(
        `UPDATE ${quotedSchema}.facility SET name_zh = '动态容量冲突回滚标记'
         WHERE id = $1::uuid`,
        [wifiId],
      );
      await pool.query(
        `
          UPDATE ${quotedSchema}.daily_inventory
          SET total_inventory = 2, held_inventory = 2, sold_inventory = 0, version = 11
          WHERE room_type_id = $1::uuid
            AND business_date = DATE '2032-03-02'
        `,
        [conflictRoomId],
      );

      process.env.STAY_FABLE_CATALOG_START_DATE = "2032-03-02";
      await expect(runSeed(isolatedPrisma)).rejects.toThrowError(
        expectedCatalogInventoryCapacityConflict,
      );

      expect(await readCoverage()).toEqual({
        first_day: "2032-02-29",
        last_day: "2032-04-29",
        row_count: 732,
      });
      const rolledBackFacility = await pool.query<{ name_zh: string }>(
        `SELECT name_zh FROM ${quotedSchema}.facility WHERE id = $1::uuid`,
        [wifiId],
      );
      expect(rolledBackFacility.rows).toEqual([{ name_zh: "动态容量冲突回滚标记" }]);
      const conflictInventory = await pool.query<{
        held_inventory: number;
        sold_inventory: number;
        total_inventory: number;
        version: number;
      }>(
        `
          SELECT total_inventory, held_inventory, sold_inventory, version
          FROM ${quotedSchema}.daily_inventory
          WHERE room_type_id = $1::uuid
            AND business_date = DATE '2032-03-02'
        `,
        [conflictRoomId],
      );
      expect(conflictInventory.rows).toEqual([
        {
          held_inventory: 2,
          sold_inventory: 0,
          total_inventory: 2,
          version: 11,
        },
      ]);
      expect(await readPublicSnapshot()).toEqual(publicBefore);
    } catch (error: unknown) {
      testFailure = normalizeFailure(error, "Dynamic catalog seed test failed");
    } finally {
      if (startDateWasPresent) {
        process.env.STAY_FABLE_CATALOG_START_DATE = previousStartDate;
      } else {
        delete process.env.STAY_FABLE_CATALOG_START_DATE;
      }
    }
    await finalizeIsolatedCatalogSeedTest({
      testFailure,
      disconnect: () => isolatedPrisma.$disconnect(),
      dropSchema: async () => {
        await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      },
    });
  }, 30_000);

  test("catalog database checks reject invalid price, room, and inventory values", async () => {
    const propertyId = "20000000-0000-4000-8000-000000000001";
    const mediaId = "50000000-0000-4000-8000-000000000001";
    const facilityId = "40000000-0000-4000-8000-000000000001";
    const roomId = "30000000-0000-4000-8000-000000000001";
    const businessDate = "2026-07-30";

    await expectCheckViolation(
      "UPDATE property SET display_order = -1 WHERE id = $1::uuid",
      [propertyId],
      "property_display_order_check",
    );
    await expectCheckViolation(
      "UPDATE property_media SET display_order = -1 WHERE id = $1::uuid",
      [mediaId],
      "property_media_display_order_check",
    );
    await expectCheckViolation(
      "UPDATE facility SET display_order = -1 WHERE id = $1::uuid",
      [facilityId],
      "facility_display_order_check",
    );
    await expectCheckViolation(
      "UPDATE room_type SET area_sqm = 0 WHERE id = $1::uuid",
      [roomId],
      "room_type_area_check",
    );
    await expectCheckViolation(
      "UPDATE room_type SET max_guests = 0 WHERE id = $1::uuid",
      [roomId],
      "room_type_guests_check",
    );
    await expectCheckViolation(
      "UPDATE room_type SET display_order = -1 WHERE id = $1::uuid",
      [roomId],
      "room_type_display_order_check",
    );
    await expectCheckViolation(
      "UPDATE room_type SET max_guests = 11 WHERE id = $1::uuid",
      [roomId],
      "room_type_guests_check",
    );
    await expectCheckViolation(
      `
        UPDATE daily_price
        SET sale_price_cents = -1
        WHERE room_type_id = $1::uuid AND business_date = $2::date
      `,
      [roomId, businessDate],
      "daily_price_sale_check",
    );
    await expectCheckViolation(
      `
        UPDATE daily_price
        SET rack_price_cents = sale_price_cents - 1
        WHERE room_type_id = $1::uuid AND business_date = $2::date
      `,
      [roomId, businessDate],
      "daily_price_rack_check",
    );

    for (const column of [
      "total_inventory",
      "held_inventory",
      "sold_inventory",
      "version",
    ] as const) {
      await expectCheckViolation(
        `
          UPDATE daily_inventory
          SET "${column}" = -1
          WHERE room_type_id = $1::uuid AND business_date = $2::date
        `,
        [roomId, businessDate],
        "daily_inventory_nonnegative_check",
      );
    }
    await expectCheckViolation(
      `
        UPDATE daily_inventory
        SET held_inventory = total_inventory, sold_inventory = 1
        WHERE room_type_id = $1::uuid AND business_date = $2::date
      `,
      [roomId, businessDate],
      "daily_inventory_capacity_check",
    );
  });
});

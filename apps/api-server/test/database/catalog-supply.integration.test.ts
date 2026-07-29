import { randomBytes } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
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

const quoteGeneratedTestSchema = (schemaName: string): string => {
  if (!/^catalog_seed_test_[0-9a-f]{16}$/.test(schemaName)) {
    throw new Error("Invalid generated catalog test schema");
  }
  return `"${schemaName}"`;
};

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
      property: 6,
      room_type: 12,
      daily_price: 720,
      daily_inventory: 720,
    });
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

  test("catalog database checks reject invalid price, room, and inventory values", async () => {
    const roomId = "30000000-0000-4000-8000-000000000001";
    const businessDate = "2026-07-30";

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

    for (const column of ["total", "held", "sold", "version"] as const) {
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
        SET held = total, sold = 1
        WHERE room_type_id = $1::uuid AND business_date = $2::date
      `,
      [roomId, businessDate],
      "daily_inventory_available_check",
    );
  });
});

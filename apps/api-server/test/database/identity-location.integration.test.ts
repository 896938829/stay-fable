import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { CITY_SEED_IDENTITY_CONFLICT_ERROR, runSeed } from "../../prisma/seed.js";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import { requireSafeDatabaseIntegrationUrl } from "./database-integration-guard.js";

const runDatabaseIntegration = process.env.RUN_DATABASE_INTEGRATION === "true";
const describeDatabase = runDatabaseIntegration ? describe : describe.skip;
const suiteName = runDatabaseIntegration
  ? "identity and city PostgreSQL/PostGIS baseline"
  : "identity and city PostgreSQL/PostGIS baseline (set RUN_DATABASE_INTEGRATION=true to run)";
describeDatabase(suiteName, () => {
  let pool: Pool;
  let prisma: PrismaClient;

  beforeAll(() => {
    const connectionString = requireSafeDatabaseIntegrationUrl(process.env.DATABASE_URL);
    pool = new Pool({
      connectionString,
    });
    prisma = new PrismaClient({
      adapter: new PrismaPg({
        connectionString,
      }),
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
  });

  test("migration and seed establish the PostGIS identity/location baseline", async () => {
    await expect(
      pool.query<{ extname: string }>("SELECT extname FROM pg_extension WHERE extname = 'postgis'"),
    ).resolves.toMatchObject({
      rows: [{ extname: "postgis" }],
    });

    await expect(pool.query("SELECT id FROM user_identity")).resolves.toMatchObject({
      rowCount: 0,
    });

    const cities = await pool.query<{
      code: string;
      name_zh: string;
      center: string;
      enabled: boolean;
      display_order: number;
    }>(`
      SELECT
        code,
        name_zh,
        ST_AsText(center::geometry) AS center,
        enabled,
        display_order
      FROM city
      ORDER BY display_order
    `);

    expect(cities.rows).toEqual([
      {
        code: "330100",
        name_zh: "杭州",
        center: "POINT(120.1551 30.2741)",
        enabled: true,
        display_order: 10,
      },
      {
        code: "520100",
        name_zh: "贵阳",
        center: "POINT(106.6302 26.647)",
        enabled: true,
        display_order: 20,
      },
    ]);
    expect(cities.rowCount).toBe(2);
    expect(cities.rows.filter(({ enabled }) => enabled)).toHaveLength(2);
    expect(cities.rows.every(({ center }) => center.length > 0)).toBe(true);

    const gistIndex = await pool.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'city'
        AND indexname = 'city_center_gix'
        AND indexdef ILIKE '%USING gist%'
    `);
    expect(gistIndex.rows).toEqual([{ indexname: "city_center_gix" }]);

    await runSeed(prisma);

    const afterSecondSeed = await pool.query<{ count: string }>("SELECT COUNT(*) FROM city");
    expect(afterSecondSeed.rows).toEqual([{ count: "2" }]);
  });

  test("seed rejects a city code mapped to a different UUID without changing it", async () => {
    const conflictingId = "20000000-0000-4000-8000-000000000001";

    await pool.query("DELETE FROM city WHERE code = $1", ["330100"]);
    await pool.query(
      `
        INSERT INTO city (
          id,
          code,
          name_zh,
          center,
          enabled,
          display_order,
          updated_at
        )
        VALUES (
          $1::uuid,
          '330100',
          '冲突占位',
          ST_SetSRID(ST_MakePoint(120, 30), 4326)::geography,
          false,
          999,
          CURRENT_TIMESTAMP
        )
      `,
      [conflictingId],
    );

    try {
      await expect(runSeed(prisma)).rejects.toThrowError(CITY_SEED_IDENTITY_CONFLICT_ERROR);

      const conflict = await pool.query<{ id: string; name_zh: string }>(
        "SELECT id::text, name_zh FROM city WHERE code = $1",
        ["330100"],
      );
      expect(conflict.rows).toEqual([{ id: conflictingId, name_zh: "冲突占位" }]);
    } finally {
      await pool.query("DELETE FROM city WHERE code = $1", ["330100"]);
      await runSeed(prisma);
    }
  });

  test("concurrent seeds serialize successfully and preserve two cities", async () => {
    const secondPrisma = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL,
      }),
    });

    try {
      await Promise.all([runSeed(prisma), runSeed(secondPrisma)]);
    } finally {
      await secondPrisma.$disconnect();
    }

    const cities = await pool.query<{ count: string }>("SELECT COUNT(*) FROM city");
    expect(cities.rows).toEqual([{ count: "2" }]);
  });
});

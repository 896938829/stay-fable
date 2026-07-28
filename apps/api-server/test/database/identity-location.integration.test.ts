import { randomBytes } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { CITY_SEED_IDENTITY_CONFLICT_ERROR, runSeed } from "../../prisma/seed.js";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import { requireSafeDatabaseIntegrationUrl } from "./database-integration-guard.js";

const runDatabaseIntegration = process.env.RUN_DATABASE_INTEGRATION === "true";
const describeDatabase = runDatabaseIntegration ? describe : describe.skip;
const suiteName = runDatabaseIntegration
  ? "identity and city PostgreSQL/PostGIS baseline"
  : "identity and city PostgreSQL/PostGIS baseline (set RUN_DATABASE_INTEGRATION=true to run)";

type IsolatedSeedHarness = {
  applicationName: string;
  prisma: PrismaClient;
  quotedSchema: string;
};

const quoteGeneratedTestSchema = (schemaName: string): string => {
  if (!/^seed_test_[0-9a-f]{16}$/.test(schemaName)) {
    throw new Error("Invalid generated test schema");
  }
  return `"${schemaName}"`;
};

describeDatabase(suiteName, () => {
  let pool: Pool;
  let prisma: PrismaClient;

  const createIsolatedSeedHarness = async (): Promise<IsolatedSeedHarness> => {
    const suffix = randomBytes(8).toString("hex");
    const schemaName = `seed_test_${suffix}`;
    const quotedSchema = quoteGeneratedTestSchema(schemaName);
    const applicationName = `seed_race_${suffix}`;

    await pool.query(`CREATE SCHEMA ${quotedSchema}`);
    await pool.query(`CREATE TABLE ${quotedSchema}."city" (LIKE public."city" INCLUDING ALL)`);

    const connectionUrl = new URL(requireSafeDatabaseIntegrationUrl(process.env.DATABASE_URL));
    connectionUrl.searchParams.set("options", `-c search_path=${schemaName},public`);
    connectionUrl.searchParams.set("application_name", applicationName);

    return {
      applicationName,
      prisma: new PrismaClient({
        adapter: new PrismaPg({
          connectionString: connectionUrl.toString(),
        }),
      }),
      quotedSchema,
    };
  };

  const destroyIsolatedSeedHarness = async ({
    prisma: isolatedPrisma,
    quotedSchema,
  }: IsolatedSeedHarness): Promise<void> => {
    try {
      await isolatedPrisma.$disconnect();
    } finally {
      await pool.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
    }
  };

  const waitForTransactionLock = async (applicationName: string): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await pool.query<{
        wait_event: string | null;
        wait_event_type: string | null;
      }>(
        `
          SELECT wait_event, wait_event_type
          FROM pg_stat_activity
          WHERE application_name = $1
            AND state = 'active'
        `,
        [applicationName],
      );
      if (
        waiting.rows.some(
          ({ wait_event, wait_event_type }) =>
            wait_event_type === "Lock" && wait_event === "transactionid",
        )
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Timed out waiting for seed transaction lock");
  };

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
    const harness = await createIsolatedSeedHarness();
    const conflictingId = "20000000-0000-4000-8000-000000000001";

    try {
      await pool.query(
        `
          INSERT INTO ${harness.quotedSchema}."city" (
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

      await expect(runSeed(harness.prisma)).rejects.toThrowError(CITY_SEED_IDENTITY_CONFLICT_ERROR);

      const conflict = await pool.query<{ id: string; name_zh: string }>(
        `
          SELECT id::text, name_zh
          FROM ${harness.quotedSchema}."city"
          WHERE code = $1
        `,
        ["330100"],
      );
      expect(conflict.rows).toEqual([{ id: conflictingId, name_zh: "冲突占位" }]);
    } finally {
      await destroyIsolatedSeedHarness(harness);
    }
  });

  test("seed rejects an uncommitted fixed UUID mapped to a wrong code after it wins", async () => {
    const harness = await createIsolatedSeedHarness();
    const blocker: PoolClient = await pool.connect();
    let blockerTransactionOpen = false;
    let seedAttempt: Promise<void> | undefined;

    try {
      await blocker.query("BEGIN");
      blockerTransactionOpen = true;
      await blocker.query(`SET LOCAL search_path TO ${harness.quotedSchema}, public`);
      await blocker.query(`
        INSERT INTO "city" (
          id,
          code,
          name_zh,
          center,
          enabled,
          display_order,
          updated_at
        )
        VALUES (
          '10000000-0000-4000-8000-000000000001',
          'wrong-code',
          '竞态胜者',
          ST_SetSRID(ST_MakePoint(120, 30), 4326)::geography,
          false,
          999,
          CURRENT_TIMESTAMP
        )
      `);

      seedAttempt = runSeed(harness.prisma);
      await waitForTransactionLock(harness.applicationName);

      await blocker.query("COMMIT");
      blockerTransactionOpen = false;

      await expect(seedAttempt).rejects.toThrowError(CITY_SEED_IDENTITY_CONFLICT_ERROR);

      const winner = await pool.query<{ code: string; name_zh: string }>(`
        SELECT code, name_zh
        FROM ${harness.quotedSchema}."city"
        WHERE id = '10000000-0000-4000-8000-000000000001'
      `);
      expect(winner.rows).toEqual([{ code: "wrong-code", name_zh: "竞态胜者" }]);
    } finally {
      if (blockerTransactionOpen) {
        await blocker.query("ROLLBACK");
      }
      await seedAttempt?.catch(() => undefined);
      blocker.release();
      await destroyIsolatedSeedHarness(harness);
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

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { catalogRoomTypes } from "../prisma/catalog-seed-data.js";
import { runSeed } from "../prisma/seed.js";
import {
  buildCatalogListSql,
  CatalogRepository,
  type CatalogAvailabilityInput,
  type CatalogListInput,
  type CatalogQueryDatabase,
} from "../src/catalog/catalog.repository.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { requireSafeDatabaseIntegrationUrl } from "./database/database-integration-guard.js";

const runDatabaseIntegration = process.env.RUN_DATABASE_INTEGRATION === "true";
const describeDatabase = runDatabaseIntegration ? describe : describe.skip;
const suiteName = runDatabaseIntegration
  ? "catalog repository full-stay availability with real PostgreSQL"
  : "catalog repository full-stay availability with real PostgreSQL (set RUN_DATABASE_INTEGRATION=true to run)";

const HANGZHOU_CITY_ID = "10000000-0000-4000-8000-000000000001";
const HOTEL_ID = "20000000-0000-4000-8000-000000000001";
const HOMESTAY_ID = "20000000-0000-4000-8000-000000000002";
const FARM_STAY_ID = "20000000-0000-4000-8000-000000000003";
const HOTEL_DOUBLE_ROOM_ID = "30000000-0000-4000-8000-000000000001";
const HOTEL_FAMILY_ROOM_ID = "30000000-0000-4000-8000-000000000002";
const EXTRA_FACILITY_ID = "49999999-0000-4000-8000-000000000001";
const INVALID_INPUT_ERROR = "Invalid CatalogRepository input";
const migrationFiles = [
  "../prisma/migrations/202607290001_identity_location/migration.sql",
  "../prisma/migrations/202607290002_user_session_version/migration.sql",
  "../prisma/migrations/202607290003_session_version_monotonic/migration.sql",
  "../prisma/migrations/202607290004_catalog_supply/migration.sql",
] as const;
const isolatedForeignKeys = [
  ["daily_inventory", "daily_inventory_room_type_id_fkey"],
  ["daily_price", "daily_price_room_type_id_fkey"],
  ["property", "property_city_id_fkey"],
  ["property_facility", "property_facility_facility_id_fkey"],
  ["property_facility", "property_facility_property_id_fkey"],
  ["property_media", "property_media_property_id_fkey"],
  ["room_type", "room_type_property_id_fkey"],
  ["user_identity", "user_identity_user_id_fkey"],
] as const;

type ExplainPlanNode = {
  "Actual Rows"?: number;
  "Index Name"?: string;
  "Node Type": string;
  "Subplan Name"?: string;
  Plans?: ExplainPlanNode[];
};

const flattenExplainPlan = (node: ExplainPlanNode): ExplainPlanNode[] => [
  node,
  ...(node.Plans ?? []).flatMap(flattenExplainPlan),
];

const availability: CatalogAvailabilityInput = {
  checkin: "2026-07-30",
  checkout: "2026-08-01",
  nights: 2,
  guests: 1,
};

const listInput = (overrides: Partial<CatalogListInput> = {}): CatalogListInput => ({
  ...availability,
  cityId: HANGZHOU_CITY_ID,
  pageSize: 10,
  ...overrides,
});

const expectNoOperationalInventory = (value: unknown): void => {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    "totalInventory",
    "heldInventory",
    "soldInventory",
    "version",
    "total_inventory",
    "held_inventory",
    "sold_inventory",
  ]) {
    expect(serialized).not.toContain(forbidden);
  }
};

const quoteGeneratedTestSchema = (schemaName: string): string => {
  if (!/^catalog_repository_test_[0-9a-f]{16}$/.test(schemaName)) {
    throw new Error("Invalid generated catalog repository test schema");
  }

  return `"${schemaName}"`;
};

describeDatabase(suiteName, () => {
  let adminPool: Pool | undefined;
  let database!: PrismaClient;
  let pool!: Pool;
  let repository: CatalogRepository;
  let schemaName: string | undefined;
  let quotedSchema: string | undefined;

  const resetBaseline = async (): Promise<void> => {
    await pool.query("DELETE FROM property WHERE name_zh LIKE '无关城市性能旅店-%'");
    await pool.query(
      `
        DELETE FROM property_facility
        WHERE property_id = $1::uuid AND facility_id = $2::uuid
      `,
      [HOTEL_ID, "40000000-0000-4000-8000-000000000004"],
    );
    await pool.query("DELETE FROM facility WHERE id = $1::uuid", [EXTRA_FACILITY_ID]);
    await pool.query(
      `
        UPDATE daily_inventory
        SET held_inventory = 0, sold_inventory = 0
        WHERE room_type_id = ANY($1::uuid[])
      `,
      [catalogRoomTypes.map(({ id }) => id)],
    );
    await runSeed(database);
  };

  beforeAll(async () => {
    const originalDatabaseUrl = requireSafeDatabaseIntegrationUrl(process.env.DATABASE_URL);
    adminPool = new Pool({
      connectionString: originalDatabaseUrl,
      connectionTimeoutMillis: 5_000,
    });
    schemaName = `catalog_repository_test_${randomBytes(8).toString("hex")}`;
    quotedSchema = quoteGeneratedTestSchema(schemaName);
    const setupClient = await adminPool.connect();
    try {
      await setupClient.query("SET statement_timeout = '10s'");
      await setupClient.query("SET lock_timeout = '5s'");
      await setupClient.query(`CREATE SCHEMA ${quotedSchema}`);
      await setupClient.query(`SET search_path TO ${quotedSchema}, public`);
      for (const migrationFile of migrationFiles) {
        const migrationSql = await readFile(new URL(migrationFile, import.meta.url), "utf8");
        await setupClient.query(migrationSql);
      }
      const constraintSuffix = schemaName.slice(-8);
      for (const [table, constraint] of isolatedForeignKeys) {
        await setupClient.query(
          `
            ALTER TABLE "${table}"
            RENAME CONSTRAINT "${constraint}" TO "${constraint}_${constraintSuffix}"
          `,
        );
      }
    } finally {
      setupClient.release();
    }

    const isolatedUrl = new URL(originalDatabaseUrl);
    isolatedUrl.searchParams.set("application_name", `catalog_repository_${schemaName}`);
    isolatedUrl.searchParams.set(
      "options",
      `-c search_path=${schemaName},public -c statement_timeout=10000 -c lock_timeout=5000`,
    );
    const connectionString = isolatedUrl.toString();
    pool = new Pool({
      connectionString,
      connectionTimeoutMillis: 5_000,
    });
    database = new PrismaClient({
      adapter: new PrismaPg({
        connectionString,
        connectionTimeoutMillis: 5_000,
      }),
    });
    repository = new CatalogRepository(database);
  });

  beforeEach(resetBaseline);

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    const clientCleanup = await Promise.allSettled([database?.$disconnect(), pool?.end()]);
    for (const result of clientCleanup) {
      if (result.status === "rejected") {
        cleanupErrors.push(result.reason);
      }
    }
    if (quotedSchema !== undefined && adminPool !== undefined) {
      try {
        await adminPool.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
      } catch (error: unknown) {
        cleanupErrors.push(error);
      }
    }
    try {
      await adminPool?.end();
    } catch (error: unknown) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Catalog repository test cleanup failed");
    }
  });

  test("isolated schema reproduces every migrated relation and foreign key", async () => {
    const schema = await pool.query<{ current_schema: string }>("SELECT current_schema()");
    expect(schema.rows).toEqual([{ current_schema: schemaName }]);

    const relations = await pool.query<{ table_name: string }>(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `,
    );
    expect(relations.rows.map(({ table_name: tableName }) => tableName)).toEqual([
      "city",
      "daily_inventory",
      "daily_price",
      "facility",
      "property",
      "property_facility",
      "property_media",
      "room_type",
      "user",
      "user_identity",
    ]);

    const foreignKeys = await pool.query<{
      delete_action: string;
      foreign_table_name: string;
      table_name: string;
    }>(
      `
        SELECT
          child.relname AS table_name,
          parent.relname AS foreign_table_name,
          CASE foreign_key.confdeltype
            WHEN 'c' THEN 'CASCADE'
            WHEN 'r' THEN 'RESTRICT'
            ELSE foreign_key.confdeltype::text
          END AS delete_action
        FROM pg_constraint foreign_key
        JOIN pg_class child ON child.oid = foreign_key.conrelid
        JOIN pg_namespace namespace ON namespace.oid = child.relnamespace
        JOIN pg_class parent ON parent.oid = foreign_key.confrelid
        WHERE namespace.nspname = current_schema()
          AND foreign_key.contype = 'f'
        ORDER BY child.relname, parent.relname
      `,
    );
    expect(foreignKeys.rows).toEqual([
      {
        delete_action: "CASCADE",
        foreign_table_name: "room_type",
        table_name: "daily_inventory",
      },
      {
        delete_action: "CASCADE",
        foreign_table_name: "room_type",
        table_name: "daily_price",
      },
      { delete_action: "RESTRICT", foreign_table_name: "city", table_name: "property" },
      {
        delete_action: "CASCADE",
        foreign_table_name: "facility",
        table_name: "property_facility",
      },
      {
        delete_action: "CASCADE",
        foreign_table_name: "property",
        table_name: "property_facility",
      },
      {
        delete_action: "CASCADE",
        foreign_table_name: "property",
        table_name: "property_media",
      },
      {
        delete_action: "CASCADE",
        foreign_table_name: "property",
        table_name: "room_type",
      },
      {
        delete_action: "CASCADE",
        foreign_table_name: "user",
        table_name: "user_identity",
      },
    ]);
  });

  test("rejects zero-night room lookup instead of returning an empty available stay", async () => {
    await expect(
      repository.findRoomType(HOTEL_DOUBLE_ROOM_ID, {
        checkin: "2026-07-30",
        checkout: "2026-07-30",
        nights: 0,
        guests: 1,
      }),
    ).rejects.toThrow(INVALID_INPUT_ERROR);
  });

  test("rejects invalid repository inputs before executing a database query", async () => {
    const queryRaw = vi.fn(() => Promise.resolve([]));
    const validatingRepository = new CatalogRepository({
      $queryRaw: queryRaw,
    } as unknown as CatalogQueryDatabase);
    const invalidCalls: Array<() => Promise<unknown>> = [
      () => validatingRepository.listProperties(listInput({ cityId: "not-a-uuid" })),
      () => validatingRepository.listProperties(listInput({ guests: 0 })),
      () => validatingRepository.listProperties(listInput({ guests: 1.5 })),
      () => validatingRepository.listProperties(listInput({ guests: 11 })),
      () => validatingRepository.listProperties(listInput({ nights: 0 })),
      () =>
        validatingRepository.listProperties(
          listInput({
            checkin: "2026-08-01",
            checkout: "2026-07-31",
          }),
        ),
      () =>
        validatingRepository.listProperties(
          listInput({
            checkout: "2026-08-01",
            nights: 1,
          }),
        ),
      () =>
        validatingRepository.listProperties(
          listInput({
            checkout: "2026-08-30",
            nights: 31,
          }),
        ),
      () => validatingRepository.listProperties(listInput({ pageSize: 0 })),
      () => validatingRepository.listProperties(listInput({ pageSize: 1.5 })),
      () => validatingRepository.listProperties(listInput({ pageSize: 21 })),
      () =>
        validatingRepository.listProperties(
          listInput({
            after: { displayOrder: -1, propertyId: HOTEL_ID },
          }),
        ),
      () =>
        validatingRepository.listProperties(
          listInput({
            after: { displayOrder: Number.MAX_SAFE_INTEGER + 1, propertyId: HOTEL_ID },
          }),
        ),
      () =>
        validatingRepository.listProperties(
          listInput({
            after: { displayOrder: 2_147_483_648, propertyId: HOTEL_ID },
          }),
        ),
      () =>
        validatingRepository.listProperties(
          listInput({
            after: null,
          } as unknown as Partial<CatalogListInput>),
        ),
      () =>
        validatingRepository.listProperties(
          listInput({
            after: { displayOrder: 10, propertyId: "not-a-uuid" },
          }),
        ),
      () =>
        validatingRepository.findProperty(HOTEL_ID, {
          ...availability,
          checkout: "2026-07-30",
        }),
      () =>
        validatingRepository.findRoomType(HOTEL_DOUBLE_ROOM_ID, {
          ...availability,
          checkin: "2026-02-30",
        }),
      () => validatingRepository.findProperty("not-a-uuid", availability),
      () => validatingRepository.findRoomType("not-a-uuid", availability),
      () => validatingRepository.listFacilityHighlights([HOTEL_ID, "not-a-uuid"]),
    ];

    for (const call of invalidCalls) {
      await expect(call()).rejects.toThrow(INVALID_INPUT_ERROR);
    }
    expect(queryRaw).not.toHaveBeenCalled();
  });

  test("lists only properties available for every requested night in stable display order", async () => {
    const result = await repository.listProperties(listInput());

    expect(result.nextAfter).toBeNull();
    expect(
      result.rows.map(({ availableRoomTypeCount, fromNightlyPriceCents, name, type }) => ({
        availableRoomTypeCount,
        fromNightlyPriceCents,
        name,
        type,
      })),
    ).toEqual([
      {
        availableRoomTypeCount: 2,
        fromNightlyPriceCents: 42_800,
        name: "西湖云栖酒店",
        type: "HOTEL",
      },
      {
        availableRoomTypeCount: 2,
        fromNightlyPriceCents: 32_800,
        name: "龙井山居",
        type: "HOMESTAY",
      },
      {
        availableRoomTypeCount: 2,
        fromNightlyPriceCents: 26_800,
        name: "青山田园农庄",
        type: "FARM_STAY",
      },
    ]);
    expect(result.rows[0]).toMatchObject({
      cityCode: "330100",
      cityId: HANGZHOU_CITY_ID,
      cityName: "杭州",
      displayOrder: 10,
      id: HOTEL_ID,
      shortDescription: "湖滨城市旅店，适合短途度假",
    });
    expect(result.rows.every((row) => !("roomTypes" in row) && !("rooms" in row))).toBe(true);
    for (const row of result.rows) {
      expect(Number.isSafeInteger(row.displayOrder)).toBe(true);
      expect(Number.isSafeInteger(row.fromNightlyPriceCents)).toBe(true);
      expect(Number.isSafeInteger(row.availableRoomTypeCount)).toBe(true);
    }
    expectNoOperationalInventory(result);
  });

  test("filters scaled unrelated-city supply before expanding requested nights", async () => {
    await pool.query(
      `
        WITH inserted_properties AS (
          INSERT INTO property (
            id,
            city_id,
            type,
            name_zh,
            address_zh,
            location,
            short_description_zh,
            description_zh,
            policies_zh,
            cover_url,
            status,
            display_order,
            created_at,
            updated_at
          )
          SELECT
            gen_random_uuid(),
            '10000000-0000-4000-8000-000000000002'::uuid,
            'HOTEL'::"PropertyType",
            '无关城市性能旅店-' || sequence::text,
            '贵阳市性能测试地址',
            ST_SetSRID(ST_MakePoint(106.63, 26.64), 4326)::geography,
            '无关城市性能数据',
            '无关城市性能数据',
            '无关城市性能数据',
            'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267',
            'OPEN'::"PropertyStatus",
            1000 + sequence,
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
          FROM generate_series(1, 200) sequence
          RETURNING id
        )
        INSERT INTO room_type (
          id,
          property_id,
          name_zh,
          bed_type_zh,
          area_sqm,
          max_guests,
          cover_url,
          description_zh,
          booking_policy_zh,
          status,
          display_order,
          created_at,
          updated_at
        )
        SELECT
          gen_random_uuid(),
          id,
          '无关城市性能房型',
          '1张1.8米大床',
          28.00,
          2,
          'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267',
          '无关城市性能数据',
          '无关城市性能数据',
          'ON_SALE'::"RoomTypeStatus",
          10,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        FROM inserted_properties
      `,
    );
    await pool.query(
      `
        INSERT INTO daily_price (
          room_type_id,
          business_date,
          sale_price_cents,
          rack_price_cents,
          created_at,
          updated_at
        )
        SELECT
          room.id,
          requested.business_date,
          99900,
          109900,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        FROM room_type room
        JOIN property property ON property.id = room.property_id
        CROSS JOIN (
          VALUES (DATE '2026-07-30'), (DATE '2026-07-31')
        ) requested(business_date)
        WHERE property.name_zh LIKE '无关城市性能旅店-%'
      `,
    );
    await pool.query(
      `
        INSERT INTO daily_inventory (
          room_type_id,
          business_date,
          total_inventory,
          created_at,
          updated_at
        )
        SELECT
          room.id,
          requested.business_date,
          1,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        FROM room_type room
        JOIN property property ON property.id = room.property_id
        CROSS JOIN (
          VALUES (DATE '2026-07-30'), (DATE '2026-07-31')
        ) requested(business_date)
        WHERE property.name_zh LIKE '无关城市性能旅店-%'
      `,
    );

    const result = await repository.listProperties(listInput());
    expect(result.rows.map(({ id }) => id)).toEqual([HOTEL_ID, HOMESTAY_ID, FARM_STAY_ID]);
    const unrelatedCount = await pool.query<{ count: number }>(
      `
        SELECT COUNT(*)::integer AS count
        FROM property
        WHERE name_zh LIKE '无关城市性能旅店-%'
      `,
    );
    expect(unrelatedCount.rows).toEqual([{ count: 200 }]);

    const planInput = listInput({
      after: { displayOrder: 10, propertyId: HOTEL_ID },
      propertyType: "HOMESTAY",
    });
    expect((await repository.listProperties(planInput)).rows.map(({ id }) => id)).toEqual([
      HOMESTAY_ID,
    ]);
    const catalogListSql = buildCatalogListSql(planInput);
    const explained = await pool.query<{
      "QUERY PLAN": Array<{ Plan: ExplainPlanNode }>;
    }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${catalogListSql.text}`, [
      ...catalogListSql.values,
    ]);
    const planRoot = explained.rows[0]?.["QUERY PLAN"][0]?.Plan;
    expect(planRoot).toBeDefined();
    const planNodes = flattenExplainPlan(planRoot as ExplainPlanNode);
    const candidatePlan = planNodes.find(
      (node) => node["Subplan Name"] === "CTE candidate_properties",
    );
    expect(candidatePlan?.["Actual Rows"]).toBe(1);
    expect(
      flattenExplainPlan(candidatePlan as ExplainPlanNode).some(
        (node) => node["Index Name"] === "property_city_status_type_order_id_idx",
      ),
    ).toBe(true);
  });

  test("makes only a room with a missing nightly price ineligible", async () => {
    await pool.query(
      `
        DELETE FROM daily_price
        WHERE room_type_id = $1::uuid AND business_date = $2::date
      `,
      [HOTEL_DOUBLE_ROOM_ID, "2026-07-31"],
    );

    const result = await repository.listProperties(listInput());
    expect(result.rows[0]).toMatchObject({
      availableRoomTypeCount: 1,
      fromNightlyPriceCents: 56_800,
      id: HOTEL_ID,
    });
    expect(result.rows).toHaveLength(3);
  });

  test("makes only a room with missing inventory ineligible", async () => {
    await pool.query(
      `
        DELETE FROM daily_inventory
        WHERE room_type_id = $1::uuid AND business_date = $2::date
      `,
      [HOTEL_DOUBLE_ROOM_ID, "2026-07-31"],
    );

    const result = await repository.listProperties(listInput());
    expect(result.rows[0]).toMatchObject({
      availableRoomTypeCount: 1,
      fromNightlyPriceCents: 56_800,
      id: HOTEL_ID,
    });
  });

  test("subtracts both held and sold inventory on every night", async () => {
    await pool.query(
      `
        UPDATE daily_inventory
        SET held_inventory = 1, sold_inventory = 0
        WHERE room_type_id = $1::uuid AND business_date = $2::date
      `,
      [HOTEL_FAMILY_ROOM_ID, "2026-07-31"],
    );
    expect((await repository.listProperties(listInput())).rows[0]).toMatchObject({
      availableRoomTypeCount: 2,
      id: HOTEL_ID,
    });

    await pool.query(
      `
        UPDATE daily_inventory
        SET sold_inventory = 1
        WHERE room_type_id = $1::uuid AND business_date = $2::date
      `,
      [HOTEL_FAMILY_ROOM_ID, "2026-07-31"],
    );
    expect((await repository.listProperties(listInput())).rows[0]).toMatchObject({
      availableRoomTypeCount: 1,
      fromNightlyPriceCents: 42_800,
      id: HOTEL_ID,
    });
  });

  test("requires a continuous row for every night across longer stays", async () => {
    await pool.query(
      `
        DELETE FROM daily_price
        WHERE room_type_id IN ($1::uuid, $2::uuid)
          AND business_date = $3::date
      `,
      [HOTEL_DOUBLE_ROOM_ID, HOTEL_FAMILY_ROOM_ID, "2026-07-31"],
    );

    const result = await repository.listProperties(
      listInput({ checkout: "2026-08-02", nights: 3 }),
    );
    expect(result.rows.map(({ id }) => id)).toEqual([HOMESTAY_ID, FARM_STAY_ID]);
  });

  test("filters room, property, city, capacity, and property type states", async () => {
    await pool.query("UPDATE room_type SET status = 'OFF_SALE' WHERE id = $1::uuid", [
      HOTEL_DOUBLE_ROOM_ID,
    ]);
    expect((await repository.listProperties(listInput())).rows[0]).toMatchObject({
      availableRoomTypeCount: 1,
      id: HOTEL_ID,
    });

    await resetBaseline();
    await pool.query("UPDATE property SET status = 'CLOSED' WHERE id = $1::uuid", [HOTEL_ID]);
    expect((await repository.listProperties(listInput())).rows.map(({ id }) => id)).toEqual([
      HOMESTAY_ID,
      FARM_STAY_ID,
    ]);

    await resetBaseline();
    await pool.query("UPDATE city SET enabled = false WHERE id = $1::uuid", [HANGZHOU_CITY_ID]);
    expect((await repository.listProperties(listInput())).rows).toEqual([]);

    await resetBaseline();
    const familyOnly = await repository.listProperties(listInput({ guests: 3 }));
    expect(
      familyOnly.rows.map(({ availableRoomTypeCount, fromNightlyPriceCents, id }) => ({
        availableRoomTypeCount,
        fromNightlyPriceCents,
        id,
      })),
    ).toEqual([
      { availableRoomTypeCount: 1, fromNightlyPriceCents: 56_800, id: HOTEL_ID },
      { availableRoomTypeCount: 1, fromNightlyPriceCents: 44_800, id: HOMESTAY_ID },
      { availableRoomTypeCount: 1, fromNightlyPriceCents: 38_800, id: FARM_STAY_ID },
    ]);
    expect((await repository.listProperties(listInput({ guests: 5 }))).rows).toEqual([]);
    expect(
      (
        await repository.listProperties(
          listInput({
            propertyType: "HOMESTAY",
          }),
        )
      ).rows.map(({ id, type }) => ({ id, type })),
    ).toEqual([{ id: HOMESTAY_ID, type: "HOMESTAY" }]);
  });

  test("paginates with the exact display-order and property-id tuple", async () => {
    const firstPage = await repository.listProperties(listInput({ pageSize: 2 }));
    expect(firstPage.rows.map(({ id }) => id)).toEqual([HOTEL_ID, HOMESTAY_ID]);
    expect(firstPage.nextAfter).toEqual({
      displayOrder: 20,
      propertyId: HOMESTAY_ID,
    });

    const secondPage = await repository.listProperties(
      listInput({ after: firstPage.nextAfter ?? undefined, pageSize: 2 }),
    );
    expect(secondPage.rows.map(({ id }) => id)).toEqual([FARM_STAY_ID]);
    expect(secondPage.nextAfter).toBeNull();
    expect(new Set([...firstPage.rows, ...secondPage.rows].map(({ id }) => id)).size).toBe(3);

    const exactTuple = await repository.listProperties(
      listInput({
        after: { displayOrder: 10, propertyId: HOTEL_ID },
      }),
    );
    expect(exactTuple.rows.map(({ id }) => id)).toEqual([HOMESTAY_ID, FARM_STAY_ID]);

    const exactFullPage = await repository.listProperties(listInput({ pageSize: 3 }));
    expect(exactFullPage.rows.map(({ id }) => id)).toEqual([HOTEL_ID, HOMESTAY_ID, FARM_STAY_ID]);
    expect(exactFullPage.nextAfter).toBeNull();

    const afterLast = await repository.listProperties(
      listInput({
        after: { displayOrder: 30, propertyId: FARM_STAY_ID },
      }),
    );
    expect(afterLast).toEqual({ rows: [], nextAfter: null });

    await pool.query("UPDATE property SET display_order = 10 WHERE id = $1::uuid", [HOMESTAY_ID]);
    const tiedFirstPage = await repository.listProperties(listInput({ pageSize: 1 }));
    expect(tiedFirstPage.rows.map(({ id }) => id)).toEqual([HOTEL_ID]);
    expect(tiedFirstPage.nextAfter).toEqual({ displayOrder: 10, propertyId: HOTEL_ID });
    const tiedSecondPage = await repository.listProperties(
      listInput({ after: tiedFirstPage.nextAfter ?? undefined, pageSize: 1 }),
    );
    expect(tiedSecondPage.rows.map(({ id }) => id)).toEqual([HOMESTAY_ID]);
  });

  test("returns sorted facility highlights capped at four and handles no property ids", async () => {
    expect(await repository.listFacilityHighlights([])).toEqual(new Map());

    await pool.query(
      `
        INSERT INTO facility (id, code, name_zh, display_order)
        VALUES ($1::uuid, 'SPA', '温泉', 5)
      `,
      [EXTRA_FACILITY_ID],
    );
    await pool.query(
      `
        INSERT INTO property_facility (property_id, facility_id)
        VALUES ($1::uuid, $2::uuid), ($1::uuid, $3::uuid)
      `,
      [HOTEL_ID, EXTRA_FACILITY_ID, "40000000-0000-4000-8000-000000000004"],
    );

    const highlights = await repository.listFacilityHighlights([HOMESTAY_ID, HOTEL_ID]);
    expect([...highlights.entries()]).toEqual([
      [HOTEL_ID, ["温泉", "无线网络", "早餐", "停车场"]],
      [HOMESTAY_ID, ["无线网络", "停车场", "亲子友好"]],
    ]);

    expect(await repository.listFacilityHighlights([HOTEL_ID, HOTEL_ID])).toEqual(
      new Map([[HOTEL_ID, ["温泉", "无线网络", "早餐", "停车场"]]]),
    );
    await pool.query("DELETE FROM facility WHERE id = $1::uuid", [EXTRA_FACILITY_ID]);
    const cascadedLinks = await pool.query<{ count: number }>(
      `
        SELECT COUNT(*)::integer AS count
        FROM property_facility
        WHERE facility_id = $1::uuid
      `,
      [EXTRA_FACILITY_ID],
    );
    expect(cascadedLinks.rows).toEqual([{ count: 0 }]);
  });

  test("finds an available property with ordered media, facilities, and eligible rooms", async () => {
    const property = await repository.findProperty(HOTEL_ID, availability);

    expect(property).toMatchObject({
      address: "杭州市西湖区湖滨片区",
      cityCode: "330100",
      cityId: HANGZHOU_CITY_ID,
      cityName: "杭州",
      id: HOTEL_ID,
      name: "西湖云栖酒店",
      type: "HOTEL",
    });
    expect(property?.media).toEqual([
      {
        alt: "西湖云栖酒店外观",
        type: "IMAGE",
        url: "https://images.unsplash.com/photo-1566073771259-6a8506099945",
      },
    ]);
    expect(property?.facilities).toEqual([
      { code: "WIFI", name: "无线网络" },
      { code: "BREAKFAST", name: "早餐" },
      { code: "PARKING", name: "停车场" },
    ]);
    expect(
      property?.roomTypes.map(({ areaSqm, fromNightlyPriceCents, id, maxGuests, name }) => ({
        areaSqm,
        fromNightlyPriceCents,
        id,
        maxGuests,
        name,
      })),
    ).toEqual([
      {
        areaSqm: 28,
        fromNightlyPriceCents: 42_800,
        id: HOTEL_DOUBLE_ROOM_ID,
        maxGuests: 2,
        name: "舒适大床房",
      },
      {
        areaSqm: 38,
        fromNightlyPriceCents: 56_800,
        id: HOTEL_FAMILY_ROOM_ID,
        maxGuests: 4,
        name: "家庭双床房",
      },
    ]);
    expectNoOperationalInventory(property);
  });

  test("findProperty returns only capacity-eligible rooms and hides unavailable properties", async () => {
    expect(
      (await repository.findProperty(HOTEL_ID, { ...availability, guests: 3 }))?.roomTypes.map(
        ({ id }) => id,
      ),
    ).toEqual([HOTEL_FAMILY_ROOM_ID]);
    expect(await repository.findProperty(HOTEL_ID, { ...availability, guests: 5 })).toBeNull();
    expect(
      await repository.findProperty("29999999-0000-4000-8000-000000000001", availability),
    ).toBeNull();

    await pool.query("UPDATE property SET status = 'CLOSED' WHERE id = $1::uuid", [HOTEL_ID]);
    expect(await repository.findProperty(HOTEL_ID, availability)).toBeNull();
  });

  test.each([
    { condition: "missing price", expectedRoomIds: [HOTEL_FAMILY_ROOM_ID] },
    { condition: "missing inventory", expectedRoomIds: [HOTEL_FAMILY_ROOM_ID] },
    { condition: "held plus sold exhaust availability", expectedRoomIds: [HOTEL_DOUBLE_ROOM_ID] },
    { condition: "OFF_SALE status", expectedRoomIds: [HOTEL_FAMILY_ROOM_ID] },
  ] as const)(
    "findProperty omits only a room with $condition",
    async ({ condition, expectedRoomIds }) => {
      if (condition === "missing price") {
        await pool.query(
          `
            DELETE FROM daily_price
            WHERE room_type_id = $1::uuid AND business_date = $2::date
          `,
          [HOTEL_DOUBLE_ROOM_ID, "2026-07-31"],
        );
      } else if (condition === "missing inventory") {
        await pool.query(
          `
            DELETE FROM daily_inventory
            WHERE room_type_id = $1::uuid AND business_date = $2::date
          `,
          [HOTEL_DOUBLE_ROOM_ID, "2026-07-31"],
        );
      } else if (condition === "held plus sold exhaust availability") {
        await pool.query(
          `
            UPDATE daily_inventory
            SET held_inventory = 1, sold_inventory = 1
            WHERE room_type_id = $1::uuid AND business_date = $2::date
          `,
          [HOTEL_FAMILY_ROOM_ID, "2026-07-31"],
        );
      } else {
        await pool.query("UPDATE room_type SET status = 'OFF_SALE' WHERE id = $1::uuid", [
          HOTEL_DOUBLE_ROOM_ID,
        ]);
      }

      const property = await repository.findProperty(HOTEL_ID, availability);
      expect(property?.roomTypes.map(({ id }) => id)).toEqual(expectedRoomIds);
      expectNoOperationalInventory(property);
    },
  );

  test("findProperty hides a property when its city is disabled", async () => {
    await pool.query("UPDATE city SET enabled = false WHERE id = $1::uuid", [HANGZHOU_CITY_ID]);

    expect(await repository.findProperty(HOTEL_ID, availability)).toBeNull();
  });

  test("findRoomType returns ordered display-only nightly prices when fully available", async () => {
    const lookup = await repository.findRoomType(HOTEL_DOUBLE_ROOM_ID, availability);

    expect(lookup).toEqual({
      room: {
        areaSqm: 28,
        bedType: "1张1.8米大床",
        bookingPolicy: "到店前一天18:00前可免费取消，之后取消规则以报价确认为准。",
        cityCode: "330100",
        cityId: HANGZHOU_CITY_ID,
        cityName: "杭州",
        coverUrl: "https://images.unsplash.com/photo-1566073771259-6a8506099945",
        description: "配备独立卫浴和基础洗护用品。",
        id: HOTEL_DOUBLE_ROOM_ID,
        maxGuests: 2,
        name: "舒适大床房",
        nightlyPrices: [
          {
            businessDate: "2026-07-30",
            rackPriceCents: 48_800,
            salePriceCents: 42_800,
          },
          {
            businessDate: "2026-07-31",
            rackPriceCents: 49_800,
            salePriceCents: 43_800,
          },
        ],
        propertyId: HOTEL_ID,
        propertyName: "西湖云栖酒店",
        propertyType: "HOTEL",
      },
      status: "AVAILABLE",
    });
    expectNoOperationalInventory(lookup);
  });

  test("findRoomType distinguishes capacity from all not-available states", async () => {
    expect(
      await repository.findRoomType(HOTEL_DOUBLE_ROOM_ID, { ...availability, guests: 3 }),
    ).toEqual({ status: "CAPACITY_EXCEEDED" });
    expect(
      await repository.findRoomType("39999999-0000-4000-8000-000000000001", availability),
    ).toEqual({ status: "NOT_AVAILABLE" });

    await pool.query("UPDATE room_type SET status = 'OFF_SALE' WHERE id = $1::uuid", [
      HOTEL_DOUBLE_ROOM_ID,
    ]);
    expect(await repository.findRoomType(HOTEL_DOUBLE_ROOM_ID, availability)).toEqual({
      status: "NOT_AVAILABLE",
    });

    await resetBaseline();
    await pool.query("UPDATE property SET status = 'CLOSED' WHERE id = $1::uuid", [HOTEL_ID]);
    expect(await repository.findRoomType(HOTEL_DOUBLE_ROOM_ID, availability)).toEqual({
      status: "NOT_AVAILABLE",
    });

    await resetBaseline();
    await pool.query("UPDATE city SET enabled = false WHERE id = $1::uuid", [HANGZHOU_CITY_ID]);
    expect(await repository.findRoomType(HOTEL_DOUBLE_ROOM_ID, availability)).toEqual({
      status: "NOT_AVAILABLE",
    });

    for (const table of ["daily_price", "daily_inventory"] as const) {
      await resetBaseline();
      await pool.query(
        `
          DELETE FROM ${table}
          WHERE room_type_id = $1::uuid AND business_date = $2::date
        `,
        [HOTEL_DOUBLE_ROOM_ID, "2026-07-31"],
      );
      expect(await repository.findRoomType(HOTEL_DOUBLE_ROOM_ID, availability)).toEqual({
        status: "NOT_AVAILABLE",
      });
    }

    await resetBaseline();
    await pool.query(
      `
        UPDATE daily_inventory
        SET held_inventory = total_inventory
        WHERE room_type_id = $1::uuid AND business_date = $2::date
      `,
      [HOTEL_DOUBLE_ROOM_ID, "2026-07-31"],
    );
    expect(await repository.findRoomType(HOTEL_DOUBLE_ROOM_ID, availability)).toEqual({
      status: "NOT_AVAILABLE",
    });
  });
});

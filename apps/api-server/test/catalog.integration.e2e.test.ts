import { randomBytes } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { catalogRoomTypes } from "../prisma/catalog-seed-data.js";
import { runSeed } from "../prisma/seed.js";
import {
  CatalogRepository,
  type CatalogAvailabilityInput,
  type CatalogListInput,
} from "../src/catalog/catalog.repository.js";
import { DatabaseService } from "../src/database/database.service.js";
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
  let adminPool: Pool;
  let database: DatabaseService;
  let seedClient: PrismaClient;
  let pool: Pool;
  let repository: CatalogRepository;
  let originalDatabaseUrl: string;
  let quotedSchema: string | undefined;

  const resetBaseline = async (): Promise<void> => {
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
    await runSeed(seedClient);
  };

  beforeAll(async () => {
    originalDatabaseUrl = requireSafeDatabaseIntegrationUrl(process.env.DATABASE_URL);
    adminPool = new Pool({ connectionString: originalDatabaseUrl });
    const schemaName = `catalog_repository_test_${randomBytes(8).toString("hex")}`;
    quotedSchema = quoteGeneratedTestSchema(schemaName);
    await adminPool.query(`CREATE SCHEMA ${quotedSchema}`);
    for (const table of managedTables) {
      await adminPool.query(
        `CREATE TABLE ${quotedSchema}."${table}" (LIKE public."${table}" INCLUDING ALL)`,
      );
    }

    const isolatedUrl = new URL(originalDatabaseUrl);
    isolatedUrl.searchParams.set("options", `-c search_path=${schemaName},public`);
    const connectionString = isolatedUrl.toString();
    process.env.DATABASE_URL = connectionString;
    pool = new Pool({ connectionString });
    seedClient = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
    database = new DatabaseService();
    repository = new CatalogRepository(database);
    await resetBaseline();
  });

  beforeEach(resetBaseline);
  afterEach(resetBaseline);

  afterAll(async () => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    try {
      await database?.$disconnect();
      await seedClient?.$disconnect();
      await pool?.end();
    } finally {
      try {
        if (quotedSchema !== undefined) {
          await adminPool?.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
        }
      } finally {
        await adminPool?.end();
      }
    }
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

  test("findProperty omits a room missing supply for one requested night", async () => {
    await pool.query(
      `
        DELETE FROM daily_price
        WHERE room_type_id = $1::uuid AND business_date = $2::date
      `,
      [HOTEL_DOUBLE_ROOM_ID, "2026-07-31"],
    );

    const property = await repository.findProperty(HOTEL_ID, availability);
    expect(property?.roomTypes.map(({ id }) => id)).toEqual([HOTEL_FAMILY_ROOM_ID]);
    expectNoOperationalInventory(property);
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

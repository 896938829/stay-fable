import { pathToFileURL } from "node:url";

import { PrismaPg } from "@prisma/adapter-pg";

import { Prisma, PrismaClient } from "../src/generated/prisma/client.js";
import {
  catalogDailySupply,
  catalogFacilities,
  catalogProperties,
  catalogPropertyMedia,
  catalogRoomTypes,
  createCatalogDailySupply,
} from "./catalog-seed-data.js";

type SeedCity = {
  id: string;
  code: string;
  nameZh: string;
  longitude: number;
  latitude: number;
  displayOrder: number;
};

const cities: SeedCity[] = [
  {
    id: "10000000-0000-4000-8000-000000000001",
    code: "330100",
    nameZh: "杭州",
    longitude: 120.1551,
    latitude: 30.2741,
    displayOrder: 10,
  },
  {
    id: "10000000-0000-4000-8000-000000000002",
    code: "520100",
    nameZh: "贵阳",
    longitude: 106.6302,
    latitude: 26.647,
    displayOrder: 20,
  },
];

export const CITY_SEED_IDENTITY_CONFLICT_ERROR =
  "City seed identity conflict: existing id/code mapping does not match fixed reference data";

export const CATALOG_SEED_IDENTITY_CONFLICT_ERROR =
  "Catalog seed identity conflict: existing id/business-key mapping does not match fixed reference data";

export const CATALOG_SEED_INVENTORY_CAPACITY_CONFLICT_ERROR =
  "Catalog seed inventory capacity conflict: managed total is below occupied inventory";

const citySeedAdvisoryLockId = 3_301_005_201;

const requireDatabaseUrl = (): string => {
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required");
  }

  return databaseUrl;
};

export const resolveCatalogDailySupply = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const startDate = environment.STAY_FABLE_CATALOG_START_DATE;
  return startDate === undefined ? catalogDailySupply : createCatalogDailySupply(startDate);
};

export async function runSeed(prisma: PrismaClient): Promise<void> {
  const dailySupply = resolveCatalogDailySupply();
  await prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw<Array<{ locked: boolean }>>(
      Prisma.sql`
        SELECT pg_advisory_xact_lock(${citySeedAdvisoryLockId}::bigint) IS NULL AS "locked"
      `,
    );

    for (const city of cities) {
      await transaction.$executeRaw(
        Prisma.sql`
          INSERT INTO "city" (
            "id",
            "code",
            "name_zh",
            "center",
            "enabled",
            "display_order",
            "created_at",
            "updated_at"
          )
          VALUES (
            ${city.id}::uuid,
            ${city.code},
            ${city.nameZh},
            ST_SetSRID(ST_MakePoint(${city.longitude}, ${city.latitude}), 4326)::geography,
            true,
            ${city.displayOrder},
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
          )
          ON CONFLICT DO NOTHING
        `,
      );

      const existingIdentities = await transaction.$queryRaw<Array<{ id: string; code: string }>>(
        Prisma.sql`
          SELECT "id"::text AS "id", "code"
          FROM "city"
          WHERE "id" = ${city.id}::uuid OR "code" = ${city.code}
          FOR UPDATE
        `,
      );

      const identity = existingIdentities[0];
      if (
        existingIdentities.length !== 1 ||
        identity?.id !== city.id ||
        identity.code !== city.code
      ) {
        throw new Error(CITY_SEED_IDENTITY_CONFLICT_ERROR);
      }

      await transaction.$executeRaw(
        Prisma.sql`
          UPDATE "city"
          SET
            "name_zh" = ${city.nameZh},
            "center" = ST_SetSRID(
              ST_MakePoint(${city.longitude}, ${city.latitude}),
              4326
            )::geography,
            "enabled" = true,
            "display_order" = ${city.displayOrder},
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${city.id}::uuid
            AND "code" = ${city.code}
        `,
      );
    }

    for (const facility of catalogFacilities) {
      await transaction.$executeRaw(
        Prisma.sql`
          INSERT INTO "facility" ("id", "code", "name_zh", "display_order")
          VALUES (
            ${facility.id}::uuid,
            ${facility.code},
            ${facility.nameZh},
            ${facility.displayOrder}
          )
          ON CONFLICT DO NOTHING
        `,
      );

      const existingIdentities = await transaction.$queryRaw<Array<{ id: string; code: string }>>(
        Prisma.sql`
          SELECT "id"::text AS "id", "code"
          FROM "facility"
          WHERE "id" = ${facility.id}::uuid OR "code" = ${facility.code}
          FOR UPDATE
        `,
      );
      const identity = existingIdentities[0];
      if (
        existingIdentities.length !== 1 ||
        identity?.id !== facility.id ||
        identity.code !== facility.code
      ) {
        throw new Error(CATALOG_SEED_IDENTITY_CONFLICT_ERROR);
      }

      await transaction.$executeRaw(
        Prisma.sql`
          UPDATE "facility"
          SET
            "name_zh" = ${facility.nameZh},
            "display_order" = ${facility.displayOrder}
          WHERE "id" = ${facility.id}::uuid
            AND "code" = ${facility.code}
        `,
      );
    }

    for (const property of catalogProperties) {
      await transaction.$executeRaw(
        Prisma.sql`
          INSERT INTO "property" (
            "id",
            "city_id",
            "type",
            "name_zh",
            "address_zh",
            "location",
            "short_description_zh",
            "description_zh",
            "policies_zh",
            "cover_url",
            "status",
            "display_order",
            "created_at",
            "updated_at"
          )
          VALUES (
            ${property.id}::uuid,
            ${property.cityId}::uuid,
            ${property.type}::"PropertyType",
            ${property.nameZh},
            ${property.addressZh},
            ST_SetSRID(
              ST_MakePoint(${property.longitude}, ${property.latitude}),
              4326
            )::geography,
            ${property.shortDescriptionZh},
            ${property.descriptionZh},
            ${property.policiesZh},
            ${property.coverUrl},
            'OPEN'::"PropertyStatus",
            ${property.displayOrder},
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
          )
          ON CONFLICT DO NOTHING
        `,
      );

      const existingIdentities = await transaction.$queryRaw<
        Array<{ id: string; cityId: string; nameZh: string }>
      >(
        Prisma.sql`
          SELECT
            "id"::text AS "id",
            "city_id"::text AS "cityId",
            "name_zh" AS "nameZh"
          FROM "property"
          WHERE "id" = ${property.id}::uuid
             OR (
               "city_id" = ${property.cityId}::uuid
               AND "name_zh" = ${property.nameZh}
             )
          FOR UPDATE
        `,
      );
      const identity = existingIdentities[0];
      if (
        existingIdentities.length !== 1 ||
        identity?.id !== property.id ||
        identity.cityId !== property.cityId ||
        identity.nameZh !== property.nameZh
      ) {
        throw new Error(CATALOG_SEED_IDENTITY_CONFLICT_ERROR);
      }

      await transaction.$executeRaw(
        Prisma.sql`
          UPDATE "property"
          SET
            "type" = ${property.type}::"PropertyType",
            "address_zh" = ${property.addressZh},
            "location" = ST_SetSRID(
              ST_MakePoint(${property.longitude}, ${property.latitude}),
              4326
            )::geography,
            "short_description_zh" = ${property.shortDescriptionZh},
            "description_zh" = ${property.descriptionZh},
            "policies_zh" = ${property.policiesZh},
            "cover_url" = ${property.coverUrl},
            "status" = 'OPEN'::"PropertyStatus",
            "display_order" = ${property.displayOrder},
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${property.id}::uuid
            AND "city_id" = ${property.cityId}::uuid
            AND "name_zh" = ${property.nameZh}
        `,
      );
    }

    for (const media of catalogPropertyMedia) {
      await transaction.$executeRaw(
        Prisma.sql`
          INSERT INTO "property_media" (
            "id",
            "property_id",
            "type",
            "url",
            "alt_zh",
            "display_order"
          )
          VALUES (
            ${media.id}::uuid,
            ${media.propertyId}::uuid,
            'IMAGE'::"PropertyMediaType",
            ${media.url},
            ${media.altZh},
            ${media.displayOrder}
          )
          ON CONFLICT DO NOTHING
        `,
      );

      const existingIdentities = await transaction.$queryRaw<
        Array<{ id: string; propertyId: string; displayOrder: number }>
      >(
        Prisma.sql`
          SELECT
            "id"::text AS "id",
            "property_id"::text AS "propertyId",
            "display_order" AS "displayOrder"
          FROM "property_media"
          WHERE "id" = ${media.id}::uuid
             OR (
               "property_id" = ${media.propertyId}::uuid
               AND "display_order" = ${media.displayOrder}
             )
          FOR UPDATE
        `,
      );
      const identity = existingIdentities[0];
      if (
        existingIdentities.length !== 1 ||
        identity?.id !== media.id ||
        identity.propertyId !== media.propertyId ||
        identity.displayOrder !== media.displayOrder
      ) {
        throw new Error(CATALOG_SEED_IDENTITY_CONFLICT_ERROR);
      }

      await transaction.$executeRaw(
        Prisma.sql`
          UPDATE "property_media"
          SET
            "type" = 'IMAGE'::"PropertyMediaType",
            "url" = ${media.url},
            "alt_zh" = ${media.altZh}
          WHERE "id" = ${media.id}::uuid
            AND "property_id" = ${media.propertyId}::uuid
            AND "display_order" = ${media.displayOrder}
        `,
      );
    }

    const facilitiesByCode = new Map(
      catalogFacilities.map((facility) => [facility.code, facility] as const),
    );
    for (const property of catalogProperties) {
      for (const facilityCode of property.facilityCodes) {
        const facility = facilitiesByCode.get(facilityCode);
        if (facility === undefined) {
          throw new Error(`Missing catalog facility seed: ${facilityCode}`);
        }
        await transaction.$executeRaw(
          Prisma.sql`
            INSERT INTO "property_facility" ("property_id", "facility_id")
            VALUES (${property.id}::uuid, ${facility.id}::uuid)
            ON CONFLICT ("property_id", "facility_id") DO NOTHING
          `,
        );
      }
    }

    for (const room of catalogRoomTypes) {
      await transaction.$executeRaw(
        Prisma.sql`
          INSERT INTO "room_type" (
            "id",
            "property_id",
            "name_zh",
            "bed_type_zh",
            "area_sqm",
            "max_guests",
            "cover_url",
            "description_zh",
            "booking_policy_zh",
            "status",
            "display_order",
            "created_at",
            "updated_at"
          )
          VALUES (
            ${room.id}::uuid,
            ${room.propertyId}::uuid,
            ${room.nameZh},
            ${room.bedTypeZh},
            ${room.areaSqm}::decimal(5,2),
            ${room.maxGuests},
            ${room.coverUrl},
            ${room.descriptionZh},
            ${room.bookingPolicyZh},
            'ON_SALE'::"RoomTypeStatus",
            ${room.displayOrder},
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
          )
          ON CONFLICT DO NOTHING
        `,
      );

      const existingIdentities = await transaction.$queryRaw<
        Array<{ id: string; propertyId: string; nameZh: string }>
      >(
        Prisma.sql`
          SELECT
            "id"::text AS "id",
            "property_id"::text AS "propertyId",
            "name_zh" AS "nameZh"
          FROM "room_type"
          WHERE "id" = ${room.id}::uuid
             OR (
               "property_id" = ${room.propertyId}::uuid
               AND "name_zh" = ${room.nameZh}
             )
          FOR UPDATE
        `,
      );
      const identity = existingIdentities[0];
      if (
        existingIdentities.length !== 1 ||
        identity?.id !== room.id ||
        identity.propertyId !== room.propertyId ||
        identity.nameZh !== room.nameZh
      ) {
        throw new Error(CATALOG_SEED_IDENTITY_CONFLICT_ERROR);
      }

      await transaction.$executeRaw(
        Prisma.sql`
          UPDATE "room_type"
          SET
            "bed_type_zh" = ${room.bedTypeZh},
            "area_sqm" = ${room.areaSqm}::decimal(5,2),
            "max_guests" = ${room.maxGuests},
            "cover_url" = ${room.coverUrl},
            "description_zh" = ${room.descriptionZh},
            "booking_policy_zh" = ${room.bookingPolicyZh},
            "status" = 'ON_SALE'::"RoomTypeStatus",
            "display_order" = ${room.displayOrder},
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${room.id}::uuid
            AND "property_id" = ${room.propertyId}::uuid
            AND "name_zh" = ${room.nameZh}
        `,
      );
    }

    const dailySupplyJson = JSON.stringify(dailySupply);
    await transaction.$executeRaw(
      Prisma.sql`
        INSERT INTO "daily_price" (
          "room_type_id",
          "business_date",
          "sale_price_cents",
          "rack_price_cents",
          "created_at",
          "updated_at"
        )
        SELECT
          supply."roomTypeId"::uuid,
          supply."businessDate"::date,
          supply."salePriceCents",
          supply."rackPriceCents",
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        FROM jsonb_to_recordset(${dailySupplyJson}::jsonb) AS supply(
          "roomTypeId" text,
          "businessDate" text,
          "salePriceCents" integer,
          "rackPriceCents" integer,
          "totalInventory" integer
        )
        ON CONFLICT ("room_type_id", "business_date") DO UPDATE
        SET
          "sale_price_cents" = EXCLUDED."sale_price_cents",
          "rack_price_cents" = EXCLUDED."rack_price_cents",
          "updated_at" = CURRENT_TIMESTAMP
      `,
    );

    const existingInventories = await transaction.$queryRaw<
      Array<{
        heldInventory: number;
        managedTotalInventory: number;
        soldInventory: number;
      }>
    >(
      Prisma.sql`
        SELECT
          inventory."held_inventory" AS "heldInventory",
          inventory."sold_inventory" AS "soldInventory",
          supply."totalInventory" AS "managedTotalInventory"
        FROM jsonb_to_recordset(${dailySupplyJson}::jsonb) AS supply(
          "roomTypeId" text,
          "businessDate" text,
          "salePriceCents" integer,
          "rackPriceCents" integer,
          "totalInventory" integer
        )
        JOIN "daily_inventory" inventory
          ON inventory."room_type_id" = supply."roomTypeId"::uuid
         AND inventory."business_date" = supply."businessDate"::date
        ORDER BY inventory."business_date" ASC, inventory."room_type_id" ASC
        FOR UPDATE OF inventory
      `,
    );
    if (
      existingInventories.some(
        ({ heldInventory, managedTotalInventory, soldInventory }) =>
          managedTotalInventory < heldInventory + soldInventory,
      )
    ) {
      throw new Error(CATALOG_SEED_INVENTORY_CAPACITY_CONFLICT_ERROR);
    }

    await transaction.$executeRaw(
      Prisma.sql`
        INSERT INTO "daily_inventory" (
          "room_type_id",
          "business_date",
          "total_inventory",
          "created_at",
          "updated_at"
        )
        SELECT
          supply."roomTypeId"::uuid,
          supply."businessDate"::date,
          supply."totalInventory",
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        FROM jsonb_to_recordset(${dailySupplyJson}::jsonb) AS supply(
          "roomTypeId" text,
          "businessDate" text,
          "salePriceCents" integer,
          "rackPriceCents" integer,
          "totalInventory" integer
        )
        ON CONFLICT ("room_type_id", "business_date") DO UPDATE
        SET
          "total_inventory" = EXCLUDED."total_inventory",
          "version" = "daily_inventory"."version" + 1,
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "daily_inventory"."total_inventory" IS DISTINCT FROM EXCLUDED."total_inventory"
          AND "daily_inventory"."held_inventory" + "daily_inventory"."sold_inventory"
              <= EXCLUDED."total_inventory"
      `,
    );

    const unresolvedInventoryCapacity = await transaction.$queryRaw<Array<{ conflict: boolean }>>(
      Prisma.sql`
        SELECT true AS "conflict"
        FROM jsonb_to_recordset(${dailySupplyJson}::jsonb) AS supply(
          "roomTypeId" text,
          "businessDate" text,
          "salePriceCents" integer,
          "rackPriceCents" integer,
          "totalInventory" integer
        )
        JOIN "daily_inventory" inventory
          ON inventory."room_type_id" = supply."roomTypeId"::uuid
         AND inventory."business_date" = supply."businessDate"::date
        WHERE inventory."total_inventory" <> supply."totalInventory"
           OR supply."totalInventory"
              < inventory."held_inventory" + inventory."sold_inventory"
        LIMIT 1
      `,
    );
    if (unresolvedInventoryCapacity.length > 0) {
      throw new Error(CATALOG_SEED_INVENTORY_CAPACITY_CONFLICT_ERROR);
    }
  });
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: requireDatabaseUrl(),
    }),
  });

  try {
    await runSeed(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

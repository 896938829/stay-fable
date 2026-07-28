import { pathToFileURL } from "node:url";

import { PrismaPg } from "@prisma/adapter-pg";

import { Prisma, PrismaClient } from "../src/generated/prisma/client.js";

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

const citySeedAdvisoryLockId = 3_301_005_201;

const requireDatabaseUrl = (): string => {
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required");
  }

  return databaseUrl;
};

export async function runSeed(prisma: PrismaClient): Promise<void> {
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

import { createHash, randomBytes } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { configureApplication } from "../src/application-configuration.js";
import { DatabaseService } from "../src/database/database.service.js";
import { Prisma } from "../src/generated/prisma/client.js";
import { LocationService } from "../src/location/location.service.js";
import { requireSafeDatabaseIntegrationUrl } from "./database/database-integration-guard.js";

const runDatabaseIntegration = process.env.RUN_DATABASE_INTEGRATION === "true";
const describeDatabase = runDatabaseIntegration ? describe : describe.skip;
const suiteName = runDatabaseIntegration
  ? "location HTTP API with real PostgreSQL/PostGIS and Redis"
  : "location HTTP API with real PostgreSQL/PostGIS and Redis (set RUN_DATABASE_INTEGRATION=true to run)";

const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

interface TestSession {
  access_token: string;
  refresh_token: string;
  user: { id: string };
}

interface ErrorEnvelope {
  error: { code: string };
}

const cleanupRedisSession = async (
  redis: Redis | undefined,
  session: TestSession | undefined,
): Promise<void> => {
  if (redis === undefined) {
    return;
  }

  try {
    if (session !== undefined) {
      const familyId = hash(session.refresh_token);
      await redis.del(
        `session:access:${hash(session.access_token)}`,
        `session:refresh:${hash(session.refresh_token)}`,
        `session:used-refresh:${hash(session.refresh_token)}`,
        `session:family:${familyId}`,
      );
    }
  } finally {
    redis.disconnect();
  }
};

const cleanupDatabaseUser = async (
  database: DatabaseService | undefined,
  session: TestSession | undefined,
): Promise<void> => {
  if (database !== undefined && session !== undefined) {
    await database.user.deleteMany({ where: { id: session.user.id } });
  }
};

describeDatabase(suiteName, () => {
  let app: INestApplication | undefined;
  let database: DatabaseService | undefined;
  let redis: Redis | undefined;
  let server: Parameters<typeof request>[0];
  let session: TestSession | undefined;
  const logWrites: string[] = [];
  let restoreStdout: (() => void) | undefined;

  beforeAll(async () => {
    requireSafeDatabaseIntegrationUrl(process.env.DATABASE_URL);
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        logWrites.push(String(chunk));
        return true;
      });
    restoreStdout = () => writeSpy.mockRestore();

    const { AppModule } = await import("../src/app.module.js");
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication({ bufferLogs: true });
    app.useLogger(app.get((await import("nestjs-pino")).Logger));
    app.flushLogs();
    configureApplication(app, "production");
    await app.init();

    server = app.getHttpServer() as Parameters<typeof request>[0];
    database = app.get(DatabaseService);
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl === undefined) {
      throw new Error("REDIS_URL is required");
    }
    redis = new Redis(redisUrl);

    const code = `mock:location-${randomBytes(12).toString("hex")}`;
    const response = await request(server)
      .post("/api/v1/auth/wechat/login")
      .send({ code })
      .expect(201);
    session = (response.body as { data: TestSession }).data;
  });

  afterAll(async () => {
    const cleanupFailures: unknown[] = [];

    try {
      const cleanupResults = await Promise.allSettled([
        cleanupRedisSession(redis, session),
        cleanupDatabaseUser(database, session),
      ]);
      for (const result of cleanupResults) {
        if (result.status === "rejected") {
          cleanupFailures.push(result.reason);
        }
      }
    } finally {
      try {
        await app?.close();
      } catch (error) {
        cleanupFailures.push(error);
      } finally {
        restoreStdout?.();
      }
    }

    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, "Location integration cleanup failed");
    }
  });

  const authorization = (): { Authorization: string } => {
    if (session === undefined) {
      throw new Error("Location integration session was not created");
    }

    return {
      Authorization: `Bearer ${session.access_token}`,
    };
  };

  it("requires an authenticated session for both location endpoints", async () => {
    await request(server)
      .get("/api/v1/cities")
      .expect(401)
      .expect((response) => {
        expect((response.body as ErrorEnvelope).error.code).toBe("AUTH_SESSION_EXPIRED");
      });
    await request(server)
      .post("/api/v1/location/resolve")
      .send({ longitude: 120.1551, latitude: 30.2741 })
      .expect(401)
      .expect((response) => {
        expect((response.body as ErrorEnvelope).error.code).toBe("AUTH_SESSION_EXPIRED");
      });
  });

  it("lists the exact seeded operating cities in display order", async () => {
    const response = await request(server).get("/api/v1/cities").set(authorization()).expect(200);

    expect((response.body as { data: unknown }).data).toEqual([
      {
        id: "10000000-0000-4000-8000-000000000001",
        code: "330100",
        name: "杭州",
      },
      {
        id: "10000000-0000-4000-8000-000000000002",
        code: "520100",
        name: "贵阳",
      },
    ]);
  });

  it.each([
    {
      city: "杭州",
      longitude: 120.1551,
      latitude: 30.2741,
    },
    {
      city: "贵阳",
      longitude: 106.6302,
      latitude: 26.647,
    },
  ])("resolves the $city center with a reasonable rounded distance", async (coordinates) => {
    const response = await request(server)
      .post("/api/v1/location/resolve")
      .set(authorization())
      .send({
        longitude: coordinates.longitude,
        latitude: coordinates.latitude,
      })
      .expect(200);
    const resolved = (
      response.body as {
        data: { city: { name: string }; distance_meters: number };
      }
    ).data;

    expect(resolved.city.name).toBe(coordinates.city);
    expect(Number.isInteger(resolved.distance_meters)).toBe(true);
    expect(resolved.distance_meters).toBeGreaterThanOrEqual(0);
    expect(resolved.distance_meters).toBeLessThan(10);
  });

  it("matches geography KNN and spherical distance near the two-city midpoint", async () => {
    if (database === undefined) {
      throw new Error("Location integration database was not created");
    }
    const longitude = 113.392_65;
    const latitude = 28.460_55;
    const [knn] = await database.$queryRaw<Array<{ id: string; name: string }>>(
      Prisma.sql`
        WITH "input_location" AS (
          SELECT ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography AS "point"
        )
        SELECT "city"."id"::text AS "id", "city"."name_zh" AS "name"
        FROM "city"
        CROSS JOIN "input_location"
        WHERE "city"."enabled" = true
        ORDER BY
          "city"."center" <-> "input_location"."point",
          "city"."display_order" ASC,
          "city"."id" ASC
        LIMIT 1
      `,
    );
    if (knn === undefined) {
      throw new Error("Expected an enabled city from the KNN probe");
    }
    const [distance] = await database.$queryRaw<Array<{ distance_meters: number }>>(
      Prisma.sql`
        WITH "input_location" AS (
          SELECT ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography AS "point"
        )
        SELECT ROUND(
          ST_Distance("city"."center", "input_location"."point", false)
        )::int AS "distance_meters"
        FROM "city"
        CROSS JOIN "input_location"
        WHERE "city"."id" = ${knn.id}::uuid
      `,
    );
    const highDistanceConfig = {
      getOrThrow: vi.fn(() => 2_000_000),
    } as unknown as ConfigService;
    const location = new LocationService(database, highDistanceConfig);

    const resolved = await location.resolve({ longitude, latitude });

    expect(resolved.city.id).toBe(knn.id);
    expect(resolved.city.name).toBe(knn.name);
    expect(resolved.city.code).toBeTypeOf("string");
    expect(resolved.distance_meters).toBe(distance?.distance_meters);
  });

  it("rejects a coordinate far from every operating city", async () => {
    await request(server)
      .post("/api/v1/location/resolve")
      .set(authorization())
      .send({ longitude: 0, latitude: 0 })
      .expect(422)
      .expect((response) => {
        expect((response.body as ErrorEnvelope).error.code).toBe("CITY_NOT_SUPPORTED");
      });
  });

  it("rejects out-of-bounds coordinates before executing location resolution", async () => {
    await request(server)
      .post("/api/v1/location/resolve")
      .set(authorization())
      .send({ longitude: 180.000_001, latitude: 30 })
      .expect(400);
  });

  it("does not serialize exact coordinates into default HTTP request logs", async () => {
    const longitude = 120.123_456_789;
    const latitude = 30.123_456_789;

    await request(server)
      .post("/api/v1/location/resolve")
      .set(authorization())
      .send({ longitude, latitude })
      .expect(200);
    await new Promise((resolve) => setImmediate(resolve));

    const logs = logWrites.join("");
    expect(logs).toContain('"url":"/api/v1/location/resolve"');
    expect(logs).not.toContain(String(longitude));
    expect(logs).not.toContain(String(latitude));
    expect(logs).not.toContain('"body":{"longitude"');
  });
});

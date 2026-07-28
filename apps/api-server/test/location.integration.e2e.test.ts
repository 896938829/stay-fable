import { createHash, randomBytes } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { configureApplication } from "../src/application-configuration.js";
import { DatabaseService } from "../src/database/database.service.js";
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

describeDatabase(suiteName, () => {
  let app: INestApplication;
  let database: DatabaseService;
  let redis: Redis;
  let server: Parameters<typeof request>[0];
  let session: TestSession;
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
    try {
      if (redis !== undefined && session !== undefined) {
        const familyId = hash(session.refresh_token);
        await redis.del(
          `session:access:${hash(session.access_token)}`,
          `session:refresh:${hash(session.refresh_token)}`,
          `session:used-refresh:${hash(session.refresh_token)}`,
          `session:family:${familyId}`,
        );
        redis.disconnect();
      }
      if (database !== undefined && session !== undefined) {
        await database.user.deleteMany({ where: { id: session.user.id } });
      }
      await app?.close();
    } finally {
      restoreStdout?.();
    }
  });

  const authorization = (): { Authorization: string } => ({
    Authorization: `Bearer ${session.access_token}`,
  });

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

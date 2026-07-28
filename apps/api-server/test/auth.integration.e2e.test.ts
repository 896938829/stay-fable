import { createHash, randomBytes } from "node:crypto";

import { Controller, Get, type INestApplication, UseGuards } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Redis } from "ioredis";
import { Client } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { configureApplication } from "../src/application-configuration.js";
import { DatabaseModule } from "../src/database/database.module.js";
import { DatabaseService } from "../src/database/database.service.js";
import { REDIS_CLIENT, RedisService } from "../src/infrastructure/redis/redis.service.js";
import { CurrentUser, type AuthenticatedUser } from "../src/identity/current-user.js";
import { IdentityModule } from "../src/identity/identity.module.js";
import { SessionAuthGuard } from "../src/identity/session-auth.guard.js";
import { ROTATE_SESSION_SCRIPT } from "../src/identity/session-scripts.js";
import { requireSafeDatabaseIntegrationUrl } from "./database/database-integration-guard.js";

const runDatabaseIntegration = process.env.RUN_DATABASE_INTEGRATION === "true";
const describeDatabase = runDatabaseIntegration ? describe : describe.skip;
const suiteName = runDatabaseIntegration
  ? "identity authentication with real PostgreSQL and Redis"
  : "identity authentication with real PostgreSQL and Redis (set RUN_DATABASE_INTEGRATION=true to run)";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const tokenForE2e = (label: string): string =>
  `${label}-${randomBytes(20).toString("base64url")}`.padEnd(43, "x");

interface TestSession {
  access_token: string;
  refresh_token: string;
  user: { id: string };
}

interface ErrorEnvelope {
  error: { code: string };
}

@Controller("identity-test")
class IdentityProbeController {
  @Get("current-user")
  @UseGuards(SessionAuthGuard)
  currentUser(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }
}

describeDatabase(suiteName, () => {
  let app: INestApplication;
  let redis: Redis;
  let database: DatabaseService;
  let server: Parameters<typeof request>[0];
  const logWrites: string[] = [];
  let restoreStdout: (() => void) | undefined;
  const keysToClean = new Set<string>();
  const userIdsToClean = new Set<string>();
  const suiteStartedAt = new Date();
  const suffix = randomBytes(10).toString("hex");
  const codeA = `mock:user-a-${suffix}`;
  const codeB = `mock:user-b-${suffix}`;

  beforeAll(async () => {
    requireSafeDatabaseIntegrationUrl(process.env.DATABASE_URL);
    const { AppModule } = await import("../src/app.module.js");
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        logWrites.push(String(chunk));
        return true;
      });
    restoreStdout = () => writeSpy.mockRestore();
    const module = await Test.createTestingModule({
      imports: [AppModule, IdentityModule, DatabaseModule],
      controllers: [IdentityProbeController],
    }).compile();
    app = module.createNestApplication();
    configureApplication(app, "production");
    await app.init();
    server = app.getHttpServer() as Parameters<typeof request>[0];
    database = app.get(DatabaseService);
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl === undefined) {
      throw new Error("REDIS_URL is required");
    }
    redis = new Redis(redisUrl);
  });

  afterAll(async () => {
    try {
      if (redis !== undefined) {
        for (const key of keysToClean) {
          await redis.del(key);
        }
        redis.disconnect();
      }
      if (database !== undefined && userIdsToClean.size > 0) {
        await database.user.deleteMany({
          where: { id: { in: [...userIdsToClean] } },
        });
      }
      await app?.close();
    } finally {
      restoreStdout?.();
    }
  });

  const login = async (code: string) => {
    const response = await request(server)
      .post("/api/v1/auth/wechat/login")
      .send({ code })
      .expect(201);
    const session = (response.body as { data: TestSession }).data;
    userIdsToClean.add(session.user.id);
    keysToClean.add(`session:access:${hash(session.access_token)}`);
    keysToClean.add(`session:refresh:${hash(session.refresh_token)}`);
    keysToClean.add(`session:used-refresh:${hash(session.refresh_token)}`);
    keysToClean.add(`session:family:${hash(session.refresh_token)}`);
    return session;
  };

  it("converges concurrent first login on one identity without orphan users", async () => {
    const concurrentCode = `mock:concurrent-${suffix}`;
    const orphanCountBefore = await database.user.count({
      where: {
        createdAt: { gte: suiteStartedAt },
        identities: { none: {} },
      },
    });

    const sessions = await Promise.all(Array.from({ length: 24 }, () => login(concurrentCode)));
    const ids = new Set(sessions.map(({ user }) => user.id));
    expect(ids.size).toBe(1);

    const providerSubject = `mock_${hash(concurrentCode)}`;
    await expect(
      database.userIdentity.count({
        where: { provider: "WECHAT", providerSubject },
      }),
    ).resolves.toBe(1);
    await expect(
      database.user.count({
        where: {
          createdAt: { gte: suiteStartedAt },
          identities: { none: {} },
        },
      }),
    ).resolves.toBe(orphanCountBefore);
  });

  it("maps repeated mock code to one user and a different code to another user", async () => {
    const first = await login(codeA);
    const repeated = await login(codeA);
    const different = await login(codeB);

    expect(repeated.user.id).toBe(first.user.id);
    expect(different.user.id).not.toBe(first.user.id);
  });

  it("stores only the mock hash in PostgreSQL and no plaintext in Redis", async () => {
    const session = await login(codeA);
    const database = app.get((await import("../src/database/database.service.js")).DatabaseService);
    const identity = await database.userIdentity.findUnique({
      where: {
        provider_providerSubject: {
          provider: "WECHAT",
          providerSubject: `mock_${hash(codeA)}`,
        },
      },
    });

    expect(identity?.providerSubject).toBe(`mock_${hash(codeA)}`);
    expect(identity?.providerSubject).not.toContain(codeA);
    const keys = await redis.keys("session:*");
    expect(keys.join(" ")).not.toContain(codeA);
    const ownValues = await Promise.all(
      [
        `session:access:${hash(session.access_token)}`,
        `session:refresh:${hash(session.refresh_token)}`,
      ].map((key) => redis.get(key)),
    );
    expect(ownValues.join(" ")).not.toContain(codeA);
    expect(ownValues.join(" ")).not.toContain(session.access_token);
    expect(ownValues.join(" ")).not.toContain(session.refresh_token);
  });

  it("protects current user and rotates refresh exactly once", async () => {
    const session = await login(codeA);

    await request(server)
      .get("/api/v1/identity-test/current-user")
      .set("Authorization", `Bearer ${session.access_token}`)
      .expect(200)
      .expect((response) => {
        expect((response.body as { data: AuthenticatedUser }).data).toEqual({
          id: session.user.id,
        });
      });

    const rotatedResponse = await request(server)
      .post("/api/v1/auth/session/refresh")
      .send({ refresh_token: session.refresh_token })
      .expect(201);
    const rotated = (rotatedResponse.body as { data: TestSession }).data;
    keysToClean.add(`session:access:${hash(rotated.access_token)}`);
    keysToClean.add(`session:refresh:${hash(rotated.refresh_token)}`);
    expect(rotated.access_token).not.toBe(session.access_token);
    expect(rotated.refresh_token).not.toBe(session.refresh_token);
    await request(server)
      .get("/api/v1/identity-test/current-user")
      .set("Authorization", `Bearer ${rotated.access_token}`)
      .expect(200);

    await request(server)
      .post("/api/v1/auth/session/refresh")
      .send({ refresh_token: session.refresh_token })
      .expect(401)
      .expect((response) => {
        expect((response.body as ErrorEnvelope).error.code).toBe("AUTH_REFRESH_REJECTED");
      });
    await request(server)
      .get("/api/v1/identity-test/current-user")
      .set("Authorization", `Bearer ${rotated.access_token}`)
      .expect(401);
    await request(server)
      .post("/api/v1/auth/session/refresh")
      .send({ refresh_token: rotated.refresh_token })
      .expect(401)
      .expect((response) => {
        expect((response.body as ErrorEnvelope).error.code).toBe("AUTH_REFRESH_REJECTED");
      });
    await expect(
      redis.mget(
        `session:access:${hash(rotated.access_token)}`,
        `session:refresh:${hash(rotated.refresh_token)}`,
        `session:family:${hash(session.refresh_token)}`,
      ),
    ).resolves.toEqual([null, null, null]);
    await request(server)
      .get("/api/v1/identity-test/current-user")
      .set("Authorization", `Bearer ${session.access_token}`)
      .expect(401)
      .expect((response) => {
        expect((response.body as ErrorEnvelope).error.code).toBe("AUTH_SESSION_EXPIRED");
      });
  });

  it("revokes access, refresh, and family before rejecting a disabled user", async () => {
    const disabledCode = `mock:disabled-${suffix}`;
    const session = await login(disabledCode);
    const familyId = hash(session.refresh_token);
    await database.user.update({
      where: { id: session.user.id },
      data: { status: "DISABLED" },
    });

    await request(server)
      .post("/api/v1/auth/session/refresh")
      .send({ refresh_token: session.refresh_token })
      .expect(403)
      .expect((response) => {
        expect((response.body as ErrorEnvelope).error.code).toBe("AUTH_USER_DISABLED");
      });
    await request(server)
      .get("/api/v1/identity-test/current-user")
      .set("Authorization", `Bearer ${session.access_token}`)
      .expect(401);
    await expect(
      redis.mget(
        `session:access:${hash(session.access_token)}`,
        `session:refresh:${hash(session.refresh_token)}`,
        `session:family:${familyId}`,
      ),
    ).resolves.toEqual([null, null, null]);
  });

  it("keeps disable ordered after an in-flight locked refresh and rejects its new access", async () => {
    const session = await login(`mock:disable-race-${suffix}`);
    const connectionString = process.env.DATABASE_URL;
    if (connectionString === undefined) {
      throw new Error("DATABASE_URL is required");
    }
    const disableClient = new Client({ connectionString });
    const observerClient = new Client({ connectionString });
    await Promise.all([disableClient.connect(), observerClient.connect()]);
    const redisService = app.get(RedisService);
    const originalExecute = redisService.executeSessionScript.bind(redisService);
    let releaseRotation: (() => void) | undefined;
    let rotationReached: (() => void) | undefined;
    const rotationGate = new Promise<void>((resolve) => {
      releaseRotation = resolve;
    });
    const reachedRotation = new Promise<void>((resolve) => {
      rotationReached = resolve;
    });
    const executeSpy = vi
      .spyOn(redisService, "executeSessionScript")
      .mockImplementation(async (script, keys, arguments_) => {
        if (script === ROTATE_SESSION_SCRIPT) {
          rotationReached?.();
          await rotationGate;
        }
        return originalExecute(script, keys, arguments_);
      });

    try {
      const refreshPromise = request(server)
        .post("/api/v1/auth/session/refresh")
        .send({ refresh_token: session.refresh_token })
        .then((response) => response);
      await reachedRotation;

      const pidResult = await disableClient.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const disablePid = pidResult.rows[0]?.pid;
      expect(disablePid).toBeTypeOf("number");
      const disablePromise = disableClient.query(
        'UPDATE "user" SET status = $1::"UserStatus" WHERE id = $2::uuid',
        ["DISABLED", session.user.id],
      );
      let observedLockWait = false;
      const lockDeadline = Date.now() + 5_000;
      while (!observedLockWait && Date.now() < lockDeadline) {
        const activity = await observerClient.query<{ wait_event_type: string | null }>(
          "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
          [disablePid],
        );
        observedLockWait = activity.rows[0]?.wait_event_type === "Lock";
        if (!observedLockWait) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(observedLockWait).toBe(true);

      releaseRotation?.();
      const refreshResponse = await refreshPromise;
      expect(refreshResponse.status).toBe(201);
      const rotated = (refreshResponse.body as { data: TestSession }).data;
      keysToClean.add(`session:access:${hash(rotated.access_token)}`);
      keysToClean.add(`session:refresh:${hash(rotated.refresh_token)}`);
      await disablePromise;

      await request(server)
        .get("/api/v1/identity-test/current-user")
        .set("Authorization", `Bearer ${rotated.access_token}`)
        .expect(403)
        .expect((response) => {
          expect((response.body as ErrorEnvelope).error.code).toBe("AUTH_USER_DISABLED");
        });
      await request(server)
        .post("/api/v1/auth/session/refresh")
        .send({ refresh_token: rotated.refresh_token })
        .expect(401);
      await expect(
        redis.mget(
          `session:access:${hash(rotated.access_token)}`,
          `session:refresh:${hash(rotated.refresh_token)}`,
          `session:family:${hash(session.refresh_token)}`,
        ),
      ).resolves.toEqual([null, null, null]);
    } finally {
      releaseRotation?.();
      executeSpy.mockRestore();
      await Promise.all([disableClient.end(), observerClient.end()]);
    }
  });

  it("returns stable session expiry for missing and invalid access", async () => {
    for (const authorization of [undefined, `Bearer ${"invalid".repeat(8)}`]) {
      const call = request(server).get("/api/v1/identity-test/current-user");
      if (authorization !== undefined) {
        call.set("Authorization", authorization);
      }
      await call.expect(401).expect((response) => {
        expect((response.body as ErrorEnvelope).error.code).toBe("AUTH_SESSION_EXPIRED");
      });
    }
  });

  it("distinguishes invalid refresh from Redis dependency failure", async () => {
    const unknownRefresh = tokenForE2e("unknown-refresh");
    await request(server)
      .post("/api/v1/auth/session/refresh")
      .send({ refresh_token: unknownRefresh })
      .expect(401)
      .expect((response) => {
        expect((response.body as ErrorEnvelope).error.code).toBe("AUTH_REFRESH_REJECTED");
      });

    const applicationRedis = app.get<Redis>(REDIS_CLIENT);
    applicationRedis.disconnect();
    try {
      await request(server)
        .post("/api/v1/auth/session/refresh")
        .send({ refresh_token: unknownRefresh })
        .expect(503)
        .expect((response) => {
          expect((response.body as ErrorEnvelope).error.code).toBe(
            "AUTH_SESSION_SERVICE_UNAVAILABLE",
          );
        });
    } finally {
      await applicationRedis.connect();
    }
  });

  it("does not serialize identity request bodies into request logs", async () => {
    const session = await login(codeB);
    await request(server)
      .post("/api/v1/auth/session/refresh")
      .send({ refresh_token: session.refresh_token })
      .expect(201);
    await new Promise((resolve) => setImmediate(resolve));
    const logs = logWrites.join("");
    expect(logs).toContain('"url":"/api/v1/auth/wechat/login"');
    expect(logs).not.toContain(codeB);
    expect(logs).not.toContain(session.refresh_token);
  });
});

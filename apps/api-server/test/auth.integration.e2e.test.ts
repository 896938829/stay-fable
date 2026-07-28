import { createHash, randomBytes } from "node:crypto";

import { Controller, Get, type INestApplication, UseGuards } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { configureApplication } from "../src/application-configuration.js";
import { CurrentUser, type AuthenticatedUser } from "../src/identity/current-user.js";
import { IdentityModule } from "../src/identity/identity.module.js";
import { SessionAuthGuard } from "../src/identity/session-auth.guard.js";
import { requireSafeDatabaseIntegrationUrl } from "./database/database-integration-guard.js";

const runDatabaseIntegration = process.env.RUN_DATABASE_INTEGRATION === "true";
const describeDatabase = runDatabaseIntegration ? describe : describe.skip;
const suiteName = runDatabaseIntegration
  ? "identity authentication with real PostgreSQL and Redis"
  : "identity authentication with real PostgreSQL and Redis (set RUN_DATABASE_INTEGRATION=true to run)";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

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
  let server: Parameters<typeof request>[0];
  const logWrites: string[] = [];
  let restoreStdout: (() => void) | undefined;
  const keysToClean = new Set<string>();
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
      imports: [AppModule, IdentityModule],
      controllers: [IdentityProbeController],
    }).compile();
    app = module.createNestApplication();
    configureApplication(app, "production");
    await app.init();
    server = app.getHttpServer() as Parameters<typeof request>[0];
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
    keysToClean.add(`session:access:${hash(session.access_token)}`);
    keysToClean.add(`session:refresh:${hash(session.refresh_token)}`);
    return session;
  };

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
      .post("/api/v1/auth/session/refresh")
      .send({ refresh_token: session.refresh_token })
      .expect(401)
      .expect((response) => {
        expect((response.body as ErrorEnvelope).error.code).toBe("AUTH_REFRESH_REJECTED");
      });
    await request(server)
      .get("/api/v1/identity-test/current-user")
      .set("Authorization", `Bearer ${session.access_token}`)
      .expect(401)
      .expect((response) => {
        expect((response.body as ErrorEnvelope).error.code).toBe("AUTH_SESSION_EXPIRED");
      });
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

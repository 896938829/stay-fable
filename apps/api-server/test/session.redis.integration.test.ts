import { createHash, randomBytes } from "node:crypto";

import type { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Clock } from "../src/common/clock/clock.js";
import { RedisService, type RedisClient } from "../src/infrastructure/redis/redis.service.js";
import {
  ISSUE_SESSION_SCRIPT,
  REVOKE_FAMILY_BY_ID_SCRIPT,
} from "../src/identity/session-scripts.js";
import { SessionService, type TokenGenerator } from "../src/identity/session.service.js";
import { requireSafeDatabaseIntegrationUrl } from "./database/database-integration-guard.js";

const runDatabaseIntegration = process.env.RUN_DATABASE_INTEGRATION === "true";
const describeRedis = runDatabaseIntegration ? describe : describe.skip;
const suiteName = runDatabaseIntegration
  ? "atomic session state with real Redis"
  : "atomic session state with real Redis (set RUN_DATABASE_INTEGRATION=true to run)";
const userId = "018f47b6-0f58-7f52-8a35-3f92a6f34762";
const sessionVersion = 7;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

describeRedis(suiteName, () => {
  let client: Redis;
  const cleanupKeys = new Set<string>();

  beforeAll(() => {
    requireSafeDatabaseIntegrationUrl(process.env.DATABASE_URL);
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl === undefined) {
      throw new Error("REDIS_URL is required");
    }
    client = new Redis(redisUrl);
  });

  afterAll(async () => {
    if (client !== undefined) {
      if (cleanupKeys.size > 0) {
        await client.del(...cleanupKeys);
      }
      client.disconnect();
    }
  });

  const token = (label: string): string =>
    `${label}-${randomBytes(20).toString("base64url")}`.padEnd(43, "x");

  const trackToken = (value: string) => {
    cleanupKeys.add(`session:access:${hash(value)}`);
    cleanupKeys.add(`session:refresh:${hash(value)}`);
    cleanupKeys.add(`session:used-refresh:${hash(value)}`);
  };

  const createService = (tokens: string[], redis = new RedisService(client)) => {
    for (const value of tokens) {
      trackToken(value);
    }
    const generator: TokenGenerator = {
      generate: () => {
        const value = tokens.shift();
        if (value === undefined) {
          throw new Error("Token queue exhausted");
        }
        return value;
      },
    };
    const config = {
      getOrThrow: (key: string) => (key === "SESSION_ACCESS_TTL_SECONDS" ? 120 : 3600),
    } as ConfigService;
    const clock: Clock = { now: () => new Date() };
    return new SessionService(redis, config, generator, clock);
  };

  it("atomically issues and rotates access, refresh, and family state", async () => {
    const access = token("issue-access");
    const refresh = token("issue-refresh");
    const nextAccess = token("rotate-access");
    const nextRefresh = token("rotate-refresh");
    const familyId = hash(refresh);
    cleanupKeys.add(`session:family:${familyId}`);
    const service = createService([access, refresh, nextAccess, nextRefresh]);

    await service.issue(userId, sessionVersion);
    await expect(
      client.mget(
        `session:access:${hash(access)}`,
        `session:refresh:${hash(refresh)}`,
        `session:family:${familyId}`,
      ),
    ).resolves.toSatisfy((values: Array<string | null>) => values.every((value) => value !== null));

    const inspected = await service.inspectRefresh(refresh);
    await service.refresh(refresh, inspected);

    const state = await client.mget(
      `session:access:${hash(access)}`,
      `session:refresh:${hash(refresh)}`,
      `session:used-refresh:${hash(refresh)}`,
      `session:access:${hash(nextAccess)}`,
      `session:refresh:${hash(nextRefresh)}`,
      `session:family:${familyId}`,
    );
    expect(state.slice(0, 2)).toEqual([null, null]);
    expect(state.slice(2)).toSatisfy((values: Array<string | null>) =>
      values.every((value) => value !== null),
    );
  });

  it("rejects mismatched issue epochs before writing any session key", async () => {
    const access = token("epoch-issue-access");
    const refresh = token("epoch-issue-refresh");
    const familyId = hash(refresh);
    const accessSessionKey = `session:access:${hash(access)}`;
    const refreshSessionKey = `session:refresh:${hash(refresh)}`;
    const familySessionKey = `session:family:${familyId}`;
    cleanupKeys.add(accessSessionKey);
    cleanupKeys.add(refreshSessionKey);
    cleanupKeys.add(familySessionKey);
    const now = Date.now();
    const redis = new RedisService(client);

    await expect(
      redis.executeSessionScript(
        ISSUE_SESSION_SCRIPT,
        [accessSessionKey, refreshSessionKey, familySessionKey],
        [
          JSON.stringify({
            kind: "access",
            userId,
            familyId,
            sessionVersion: 1,
            issuedAt: now,
            expiresAt: now + 120_000,
          }),
          JSON.stringify({
            kind: "refresh",
            userId,
            familyId,
            sessionVersion: 2,
            issuedAt: now,
            expiresAt: now + 3_600_000,
            accessKey: accessSessionKey,
          }),
          JSON.stringify({
            kind: "family",
            userId,
            familyId,
            sessionVersion: 1,
            issuedAt: now,
            expiresAt: now + 3_600_000,
            accessKey: accessSessionKey,
            refreshKey: refreshSessionKey,
          }),
          "120000",
          "3600000",
          String(now),
        ],
      ),
    ).resolves.toBe("INVALID");
    await expect(
      client.mget(accessSessionKey, refreshSessionKey, familySessionKey),
    ).resolves.toEqual([null, null, null]);
  });

  it("rejects a rotation epoch mismatch without consuming the active family", async () => {
    const access = token("epoch-rotate-access");
    const refresh = token("epoch-rotate-refresh");
    const nextAccess = token("epoch-rotate-next-access");
    const nextRefresh = token("epoch-rotate-next-refresh");
    const familyId = hash(refresh);
    const activeKeys = [
      `session:access:${hash(access)}`,
      `session:refresh:${hash(refresh)}`,
      `session:family:${familyId}`,
    ];
    cleanupKeys.add(activeKeys[2] as string);
    const service = createService([access, refresh, nextAccess, nextRefresh]);
    await service.issue(userId, sessionVersion);
    const before = await client.mget(...activeKeys);

    await expect(
      service.refresh(refresh, { userId, familyId, sessionVersion: sessionVersion + 1 }),
    ).rejects.toMatchObject({
      code: "AUTH_REFRESH_REJECTED",
      status: 401,
    });
    await expect(client.mget(...activeKeys)).resolves.toEqual(before);
  });

  it("refuses corrupt or mismatched family revocation targets without deleting linked keys", async () => {
    const access = token("corrupt-family-access");
    const refresh = token("corrupt-family-refresh");
    const familyId = hash(refresh);
    const familySessionKey = `session:family:${familyId}`;
    cleanupKeys.add(familySessionKey);
    const service = createService([access, refresh]);
    await service.issue(userId, sessionVersion);
    const rawFamily = await client.get(familySessionKey);
    expect(rawFamily).not.toBeNull();
    const family = JSON.parse(rawFamily ?? "{}") as Record<string, unknown>;
    await client.set(
      familySessionKey,
      JSON.stringify({ ...family, familyId: "corrupt-family-id" }),
      "PX",
      3_600_000,
    );
    const linkedKeys = [
      `session:access:${hash(access)}`,
      `session:refresh:${hash(refresh)}`,
      familySessionKey,
    ];
    const before = await client.mget(...linkedKeys);

    await expect(service.revokeFamily(familyId)).rejects.toMatchObject({
      code: "AUTH_SESSION_SERVICE_UNAVAILABLE",
      status: 503,
    });
    await expect(client.mget(...linkedKeys)).resolves.toEqual(before);

    const redis = new RedisService(client);
    await expect(
      redis.executeSessionScript(
        REVOKE_FAMILY_BY_ID_SCRIPT,
        [familySessionKey],
        ["different-family-id", String(Date.now())],
      ),
    ).resolves.toBe("CORRUPT");
    await expect(client.mget(...linkedKeys)).resolves.toEqual(before);
  });

  it("allows at most one concurrent rotation of the same refresh", async () => {
    const access = token("race-access");
    const refresh = token("race-refresh");
    const generated = [
      token("race-next-access-a"),
      token("race-next-refresh-a"),
      token("race-next-access-b"),
      token("race-next-refresh-b"),
    ];
    const familyId = hash(refresh);
    cleanupKeys.add(`session:family:${familyId}`);
    const service = createService([access, refresh, ...generated]);
    await service.issue(userId, sessionVersion);
    const inspected = await service.inspectRefresh(refresh);

    const results = await Promise.allSettled([
      service.refresh(refresh, inspected),
      service.refresh(refresh, inspected),
    ]);

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<SessionService["refresh"]>>> =>
        result.status === "fulfilled",
    );
    expect(fulfilled).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const winningSession = fulfilled[0]?.value;
    expect(winningSession).toBeDefined();
    await expect(service.resolveAccess(winningSession?.access_token ?? "")).rejects.toMatchObject({
      code: "AUTH_SESSION_EXPIRED",
      status: 401,
    });
    await expect(service.inspectRefresh(winningSession?.refresh_token ?? "")).rejects.toMatchObject(
      {
        code: "AUTH_REFRESH_REJECTED",
        status: 401,
      },
    );
    await expect(client.get(`session:family:${familyId}`)).resolves.toBeNull();
  });

  it("keeps millisecond TTLs bounded across multiple rotations", async () => {
    const access = token("ttl-access");
    const refresh = token("ttl-refresh");
    const nextAccess = token("ttl-next-access");
    const nextRefresh = token("ttl-next-refresh");
    const finalAccess = token("ttl-final-access");
    const finalRefresh = token("ttl-final-refresh");
    const familyId = hash(refresh);
    const family = `session:family:${familyId}`;
    const oldRefresh = `session:refresh:${hash(refresh)}`;
    const nextRefreshKey = `session:refresh:${hash(nextRefresh)}`;
    const finalRefreshKey = `session:refresh:${hash(finalRefresh)}`;
    const oldTombstone = `session:used-refresh:${hash(refresh)}`;
    const nextTombstone = `session:used-refresh:${hash(nextRefresh)}`;
    cleanupKeys.add(family);
    const redis = new RedisService(client);
    const service = createService(
      [access, refresh, nextAccess, nextRefresh, finalAccess, finalRefresh],
      redis,
    );

    await service.issue(userId, sessionVersion);
    const oldRemaining = await redis.ttlMilliseconds(oldRefresh);
    expect(oldRemaining).toBeGreaterThan(3_595_000);
    expect(oldRemaining).toBeLessThanOrEqual(3_600_000);

    await service.refresh(refresh, await service.inspectRefresh(refresh));
    for (const key of [family, nextRefreshKey]) {
      const ttl = await redis.ttlMilliseconds(key);
      expect(ttl).toBeGreaterThan(3_595_000);
      expect(ttl).toBeLessThanOrEqual(3_600_000);
    }
    expect(await redis.ttlMilliseconds(oldTombstone)).toBeGreaterThanOrEqual(oldRemaining - 1_000);

    await service.refresh(nextRefresh, await service.inspectRefresh(nextRefresh));
    for (const key of [family, finalRefreshKey, nextTombstone]) {
      const ttl = await redis.ttlMilliseconds(key);
      expect(ttl).toBeGreaterThan(3_595_000);
      expect(ttl).toBeLessThanOrEqual(3_600_000);
    }
  });

  it("revokes the active family when an old refresh is replayed", async () => {
    const access = token("replay-access");
    const refresh = token("replay-refresh");
    const nextAccess = token("replay-next-access");
    const nextRefresh = token("replay-next-refresh");
    const familyId = hash(refresh);
    cleanupKeys.add(`session:family:${familyId}`);
    const service = createService([access, refresh, nextAccess, nextRefresh]);
    await service.issue(userId, sessionVersion);
    await service.refresh(refresh, await service.inspectRefresh(refresh));

    await expect(service.refresh(refresh)).rejects.toMatchObject({
      code: "AUTH_REFRESH_REJECTED",
      status: 401,
    });
    await expect(service.resolveAccess(nextAccess)).rejects.toMatchObject({
      code: "AUTH_SESSION_EXPIRED",
      status: 401,
    });
    await expect(service.inspectRefresh(nextRefresh)).rejects.toMatchObject({
      code: "AUTH_REFRESH_REJECTED",
      status: 401,
    });
    await expect(
      client.mget(
        `session:access:${hash(nextAccess)}`,
        `session:refresh:${hash(nextRefresh)}`,
        `session:family:${familyId}`,
      ),
    ).resolves.toEqual([null, null, null]);
    await expect(client.get(`session:used-refresh:${hash(refresh)}`)).resolves.not.toBeNull();
  });

  it("leaves real Redis state unchanged when eval fails before execution", async () => {
    const access = token("fault-access");
    const refresh = token("fault-refresh");
    const nextAccess = token("fault-next-access");
    const nextRefresh = token("fault-next-refresh");
    const familyId = hash(refresh);
    const keys = [
      `session:access:${hash(access)}`,
      `session:refresh:${hash(refresh)}`,
      `session:family:${familyId}`,
    ];
    cleanupKeys.add(keys[2] as string);
    const healthy = createService([access, refresh]);
    await healthy.issue(userId, sessionVersion);
    const before = await client.mget(...keys);
    const failingClient: RedisClient = {
      ping: () => client.ping(),
      quit: () => Promise.resolve("OK"),
      get: (key) => client.get(key),
      set: (key, value, expiryMode, ttlSeconds) => client.set(key, value, expiryMode, ttlSeconds),
      eval: () => Promise.reject(new Error("injected eval failure")),
      del: (key) => client.del(key),
      pttl: (key) => client.pttl(key),
    };
    const failing = createService([nextAccess, nextRefresh], new RedisService(failingClient));

    await expect(
      failing.refresh(refresh, { userId, familyId, sessionVersion }),
    ).rejects.toMatchObject({
      code: "AUTH_SESSION_SERVICE_UNAVAILABLE",
      status: 503,
    });
    await expect(client.mget(...keys)).resolves.toEqual(before);
  });
});

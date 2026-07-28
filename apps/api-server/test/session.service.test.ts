/* eslint-disable @typescript-eslint/unbound-method */
import { createHash } from "node:crypto";

import type { ConfigService } from "@nestjs/config";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Clock } from "../src/common/clock/clock.js";
import { BusinessException } from "../src/common/http/business.exception.js";
import type { RedisService } from "../src/infrastructure/redis/redis.service.js";
import {
  SessionService,
  type StoredSession,
  type TokenGenerator,
} from "../src/identity/session.service.js";

const userId = "018f47b6-0f58-7f52-8a35-3f92a6f34762";
const now = new Date("2026-07-29T00:00:00.000Z");
const accessToken = "access-token-".padEnd(43, "a");
const refreshToken = "refresh-token-".padEnd(43, "r");
const nextAccessToken = "next-access-token-".padEnd(43, "a");
const nextRefreshToken = "next-refresh-token-".padEnd(43, "r");
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

const createHarness = () => {
  const values = new Map<string, StoredSession>();
  const ttls = new Map<string, number>();
  const redis = {
    getJson: vi.fn((key: string) => Promise.resolve(values.get(key) ?? null)),
    setJson: vi.fn((key: string, value: StoredSession, ttl: number) => {
      values.set(key, value);
      ttls.set(key, ttl);
      return Promise.resolve();
    }),
    consumeJson: vi.fn((key: string) => {
      const value = values.get(key) ?? null;
      values.delete(key);
      return Promise.resolve(value);
    }),
    delete: vi.fn((key: string) => {
      values.delete(key);
      return Promise.resolve();
    }),
  } as unknown as RedisService;
  const config = {
    getOrThrow: vi.fn((key: string) => (key === "SESSION_ACCESS_TTL_SECONDS" ? 120 : 600)),
  } as unknown as ConfigService;
  const tokenGenerator = {
    generate: vi
      .fn()
      .mockReturnValueOnce(accessToken)
      .mockReturnValueOnce(refreshToken)
      .mockReturnValueOnce(nextAccessToken)
      .mockReturnValueOnce(nextRefreshToken),
  } satisfies TokenGenerator;
  const clock: Clock = { now: vi.fn(() => now) };
  const service = new SessionService(redis, config, tokenGenerator, clock);

  return { service, redis, values, ttls, tokenGenerator, clock };
};

describe("SessionService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("stores only hashed access and refresh keys with configured TTLs", async () => {
    const { service, values, ttls } = createHarness();

    const session = await service.issue(userId);

    expect(session).toEqual({
      access_token: accessToken,
      access_expires_in: 120,
      refresh_token: refreshToken,
      refresh_expires_in: 600,
      user: { id: userId },
    });
    expect([...values.keys()]).toEqual([
      `session:access:${hash(accessToken)}`,
      `session:refresh:${hash(refreshToken)}`,
    ]);
    expect([...values.keys()].join(" ")).not.toContain(accessToken);
    expect([...values.keys()].join(" ")).not.toContain(refreshToken);
    expect(ttls.get(`session:access:${hash(accessToken)}`)).toBe(120);
    expect(ttls.get(`session:refresh:${hash(refreshToken)}`)).toBe(600);
    expect(JSON.stringify([...values.values()])).not.toContain(accessToken);
    expect(JSON.stringify([...values.values()])).not.toContain(refreshToken);
  });

  it("generates one high-entropy token for each session kind", async () => {
    const { service, tokenGenerator } = createHarness();

    await service.issue(userId);

    expect(tokenGenerator.generate).toHaveBeenCalledTimes(2);
  });

  it("cleans up the access key when writing the refresh record fails", async () => {
    const { service, redis } = createHarness();
    vi.mocked(redis.setJson)
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("redis unavailable"));

    await expect(service.issue(userId)).rejects.toThrow("redis unavailable");
    expect(redis.delete).toHaveBeenCalledWith(`session:access:${hash(accessToken)}`);
  });

  it("atomically consumes refresh, deletes linked access, and rotates both tokens", async () => {
    const { service, redis } = createHarness();
    await service.issue(userId);

    const rotated = await service.refresh(refreshToken);

    expect(redis.consumeJson).toHaveBeenCalledWith(`session:refresh:${hash(refreshToken)}`);
    expect(redis.delete).toHaveBeenCalledWith(`session:access:${hash(accessToken)}`);
    expect(rotated.access_token).toBe(nextAccessToken);
    expect(rotated.refresh_token).toBe(nextRefreshToken);
    await expect(service.refresh(refreshToken)).rejects.toMatchObject({
      code: "AUTH_REFRESH_REJECTED",
      status: 401,
    });
  });

  it("rejects expired refresh records without issuing replacements", async () => {
    const { service, values, tokenGenerator } = createHarness();
    values.set(`session:refresh:${hash(refreshToken)}`, {
      kind: "refresh",
      userId,
      familyId: "family",
      issuedAt: now.getTime() - 10_000,
      expiresAt: now.getTime() - 1,
      accessKey: `session:access:${hash(accessToken)}`,
    });

    await expect(service.refresh(refreshToken)).rejects.toMatchObject({
      code: "AUTH_REFRESH_REJECTED",
    });
    expect(tokenGenerator.generate).not.toHaveBeenCalled();
  });

  it("normalizes Redis failures after destructive refresh consumption", async () => {
    const { service, redis } = createHarness();
    vi.mocked(redis.consumeJson).mockRejectedValueOnce(new Error("redis internals"));

    const rejection = service.refresh(refreshToken);

    await expect(rejection).rejects.toBeInstanceOf(BusinessException);
    await expect(rejection).rejects.toMatchObject({
      code: "AUTH_REFRESH_REJECTED",
      message: "刷新凭证无效或已过期",
      status: 401,
    });
  });

  it("resolves a valid access session to its user", async () => {
    const { service } = createHarness();
    await service.issue(userId);

    await expect(service.resolveAccess(accessToken)).resolves.toEqual({ userId });
  });

  it.each([
    null,
    {
      kind: "refresh",
      userId,
      familyId: "family",
      issuedAt: now.getTime(),
      expiresAt: now.getTime() + 1000,
      accessKey: "session:access:any",
    },
    {
      kind: "access",
      userId,
      familyId: "family",
      issuedAt: now.getTime() - 2000,
      expiresAt: now.getTime() - 1,
    },
  ])("rejects missing, wrong-kind, or expired access records", async (record) => {
    const { service, values, redis } = createHarness();
    const key = `session:access:${hash(accessToken)}`;
    if (record !== null) {
      values.set(key, record as StoredSession);
    }

    await expect(service.resolveAccess(accessToken)).rejects.toMatchObject({
      code: "AUTH_SESSION_EXPIRED",
      message: "登录状态已过期，请重新登录",
      status: 401,
    });
    expect(redis.delete).toHaveBeenCalledWith(key);
  });
});

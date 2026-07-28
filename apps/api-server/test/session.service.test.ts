/* eslint-disable @typescript-eslint/unbound-method */
import { createHash } from "node:crypto";

import type { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";

import type { Clock } from "../src/common/clock/clock.js";
import type { RedisService } from "../src/infrastructure/redis/redis.service.js";
import {
  SessionService,
  type StoredAccessSession,
  type StoredRefreshSession,
  type TokenGenerator,
} from "../src/identity/session.service.js";

const userId = "018f47b6-0f58-7f52-8a35-3f92a6f34762";
const now = new Date("2026-07-29T00:00:00.000Z");
const accessToken = "access-token-".padEnd(43, "a");
const refreshToken = "refresh-token-".padEnd(43, "r");
const nextAccessToken = "next-access-token-".padEnd(43, "a");
const nextRefreshToken = "next-refresh-token-".padEnd(43, "r");
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const familyId = hash(refreshToken);

const createHarness = () => {
  const redis = {
    executeSessionScript: vi.fn(() => Promise.resolve("OK")),
    getJson: vi.fn(() => Promise.resolve(null)),
    delete: vi.fn(() => Promise.resolve()),
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

  return { service, redis, tokenGenerator };
};

describe("SessionService atomic state transitions", () => {
  it("issues access, refresh, and family records in one script without plaintext storage", async () => {
    const { service, redis } = createHarness();

    const session = await service.issue(userId);

    expect(session).toEqual({
      access_token: accessToken,
      access_expires_in: 120,
      refresh_token: refreshToken,
      refresh_expires_in: 600,
      user: { id: userId },
    });
    expect(redis.executeSessionScript).toHaveBeenCalledOnce();
    const [, keys, arguments_] = vi.mocked(redis.executeSessionScript).mock.calls[0] ?? [];
    expect(keys).toEqual([
      `session:access:${hash(accessToken)}`,
      `session:refresh:${hash(refreshToken)}`,
      `session:family:${familyId}`,
    ]);
    expect(arguments_?.slice(-3)).toEqual(["120000", "600000", String(now.getTime())]);
    expect(JSON.stringify({ keys, arguments_ })).not.toContain(accessToken);
    expect(JSON.stringify({ keys, arguments_ })).not.toContain(refreshToken);
  });

  it("maps issue script failures to a stable 503", async () => {
    const { service, redis } = createHarness();
    vi.mocked(redis.executeSessionScript).mockRejectedValueOnce(new Error("redis internals"));

    await expect(service.issue(userId)).rejects.toMatchObject({
      code: "AUTH_SESSION_SERVICE_UNAVAILABLE",
      message: "登录服务暂时不可用，请稍后重试",
      status: 503,
    });
  });

  it("inspects an active refresh without consuming it", async () => {
    const { service, redis, tokenGenerator } = createHarness();
    const record: StoredRefreshSession = {
      kind: "refresh",
      userId,
      familyId,
      issuedAt: now.getTime(),
      expiresAt: now.getTime() + 600_000,
      accessKey: `session:access:${hash(accessToken)}`,
    };
    vi.mocked(redis.executeSessionScript).mockResolvedValueOnce(
      JSON.stringify({ status: "ACTIVE", record }),
    );

    await expect(service.inspectRefresh(refreshToken)).resolves.toEqual({ userId, familyId });
    expect(tokenGenerator.generate).not.toHaveBeenCalled();
    expect(redis.executeSessionScript).toHaveBeenCalledWith(
      expect.any(String),
      [`session:refresh:${hash(refreshToken)}`, `session:used-refresh:${hash(refreshToken)}`],
      [String(now.getTime())],
    );
  });

  it.each(["INVALID", "EXPIRED", "REPLAY"])(
    "maps inspect status %s to rejected refresh",
    async (status) => {
      const { service, redis } = createHarness();
      vi.mocked(redis.executeSessionScript).mockResolvedValueOnce(status);

      await expect(service.inspectRefresh(refreshToken)).rejects.toMatchObject({
        code: "AUTH_REFRESH_REJECTED",
        status: 401,
      });
    },
  );

  it("rotates the family in one script and returns the new tokens", async () => {
    const { service, redis } = createHarness();
    // Reserve the first pair as if it were already issued.
    await service.issue(userId);
    vi.mocked(redis.executeSessionScript).mockResolvedValueOnce("OK");

    const rotated = await service.refresh(refreshToken, { userId, familyId });

    expect(rotated.access_token).toBe(nextAccessToken);
    expect(rotated.refresh_token).toBe(nextRefreshToken);
    const [, keys, arguments_] = vi.mocked(redis.executeSessionScript).mock.calls[1] ?? [];
    expect(keys).toEqual([
      `session:refresh:${hash(refreshToken)}`,
      `session:used-refresh:${hash(refreshToken)}`,
      `session:access:${hash(nextAccessToken)}`,
      `session:refresh:${hash(nextRefreshToken)}`,
    ]);
    expect(arguments_).toEqual(expect.arrayContaining([String(now.getTime()), "120000", "600000"]));
  });

  it.each(["INVALID", "EXPIRED", "REPLAY"])(
    "maps rotate status %s to a stable 401",
    async (status) => {
      const { service, redis } = createHarness();
      vi.mocked(redis.executeSessionScript).mockResolvedValueOnce(status);

      await expect(service.refresh(refreshToken, { userId, familyId })).rejects.toMatchObject({
        code: "AUTH_REFRESH_REJECTED",
        status: 401,
      });
    },
  );

  it("maps inspect and rotate Redis faults to a stable 503", async () => {
    const { service, redis } = createHarness();
    vi.mocked(redis.executeSessionScript).mockRejectedValue(new Error("redis internals"));

    await expect(service.inspectRefresh(refreshToken)).rejects.toMatchObject({
      code: "AUTH_SESSION_SERVICE_UNAVAILABLE",
      status: 503,
    });
    await expect(service.refresh(refreshToken, { userId, familyId })).rejects.toMatchObject({
      code: "AUTH_SESSION_SERVICE_UNAVAILABLE",
      status: 503,
    });
  });

  it("revokes a family through the supplied refresh hash", async () => {
    const { service, redis } = createHarness();
    vi.mocked(redis.executeSessionScript).mockResolvedValueOnce("REVOKED");

    await expect(service.revokeFamilyByRefresh(refreshToken)).resolves.toBeUndefined();
    expect(redis.executeSessionScript).toHaveBeenCalledWith(
      expect.any(String),
      [`session:refresh:${hash(refreshToken)}`, `session:used-refresh:${hash(refreshToken)}`],
      [String(now.getTime())],
    );
  });

  it("revokes the active access and refresh records by family id", async () => {
    const { service, redis } = createHarness();
    vi.mocked(redis.executeSessionScript).mockResolvedValueOnce("REVOKED");

    await expect(service.revokeFamily(familyId)).resolves.toBeUndefined();
    expect(redis.executeSessionScript).toHaveBeenCalledWith(
      expect.any(String),
      [`session:family:${familyId}`],
      [String(now.getTime())],
    );
  });

  it("resolves active access and distinguishes dependency faults from expiry", async () => {
    const { service, redis } = createHarness();
    const record: StoredAccessSession = {
      kind: "access",
      userId,
      familyId,
      issuedAt: now.getTime(),
      expiresAt: now.getTime() + 120_000,
    };
    vi.mocked(redis.getJson).mockResolvedValueOnce(record);
    await expect(service.resolveAccess(accessToken)).resolves.toEqual({ userId, familyId });

    vi.mocked(redis.getJson).mockResolvedValueOnce(null);
    await expect(service.resolveAccess(accessToken)).rejects.toMatchObject({
      code: "AUTH_SESSION_EXPIRED",
      status: 401,
    });

    vi.mocked(redis.getJson).mockRejectedValueOnce(new Error("redis internals"));
    await expect(service.resolveAccess(accessToken)).rejects.toMatchObject({
      code: "AUTH_SESSION_SERVICE_UNAVAILABLE",
      status: 503,
    });
  });
});

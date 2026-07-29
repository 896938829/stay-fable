/* eslint-disable @typescript-eslint/unbound-method */
import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { BusinessException } from "../src/common/http/business.exception.js";
import { WriteRateLimitService } from "../src/common/rate-limit/write-rate-limit.service.js";
import { RedisService, type RedisClient } from "../src/infrastructure/redis/redis.service.js";

const userId = "018f47b6-0f58-7f52-8a35-3f92a6f34762";
const otherUserId = "018f47b6-0f58-7f52-8a35-3f92a6f34763";
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const quoteKey = `rate-limit:quotes:${hash(userId)}`;

const createRedisClient = (): RedisClient => ({
  ping: vi.fn(() => Promise.resolve("PONG")),
  quit: vi.fn(() => Promise.resolve("OK")),
  get: vi.fn(() => Promise.resolve(null)),
  set: vi.fn(() => Promise.resolve("OK")),
  eval: vi.fn(() => Promise.resolve([1, 60_000])),
  del: vi.fn(() => Promise.resolve(1)),
  pttl: vi.fn(() => Promise.resolve(60_000)),
});

const captureError = async (rejection: Promise<unknown>): Promise<Error> => {
  try {
    await rejection;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }

  throw new Error("Expected operation to reject");
};

describe("RedisService.executeRateLimit", () => {
  it("atomically increments a safe key, sets its first-window expiry, and returns count with TTL", async () => {
    const client = createRedisClient();
    const service = new RedisService(client);

    await expect(service.executeRateLimit(quoteKey, 30, 60_000)).resolves.toEqual({
      count: 1,
      ttlMilliseconds: 60_000,
    });

    expect(client.eval).toHaveBeenCalledWith(expect.any(String), 1, quoteKey, "60000");
    const script = vi.mocked(client.eval).mock.calls[0]?.[0] ?? "";
    expect(script).toContain("redis.call('INCR', KEYS[1])");
    expect(script).toContain("if count == 1 then");
    expect(script).toContain("redis.call('PEXPIRE', KEYS[1], ARGV[1])");
    expect(script).toContain("redis.call('PTTL', KEYS[1])");
    expect(script).not.toContain(userId);
  });

  it.each([
    ["", 30, 60_000],
    ["rate-limit:quotes:not-a-hash", 30, 60_000],
    [quoteKey, 0, 60_000],
    [quoteKey, -1, 60_000],
    [quoteKey, 1.5, 60_000],
    [quoteKey, Number.MAX_SAFE_INTEGER + 1, 60_000],
    [quoteKey, 30, 0],
    [quoteKey, 30, -1],
    [quoteKey, 30, 1.5],
    [quoteKey, 30, Number.MAX_SAFE_INTEGER + 1],
  ])("rejects unsafe rate-limit inputs without touching Redis", async (key, limit, window) => {
    const client = createRedisClient();
    const service = new RedisService(client);

    await expect(service.executeRateLimit(key, limit, window)).rejects.toThrow(
      "Redis rate limit failed",
    );
    expect(client.eval).not.toHaveBeenCalled();
  });

  it("accepts any positive safe integer window", async () => {
    const client = createRedisClient();
    vi.mocked(client.eval).mockResolvedValueOnce([1, 59_999]);
    const service = new RedisService(client);

    await expect(service.executeRateLimit(quoteKey, 30, 59_999)).resolves.toEqual({
      count: 1,
      ttlMilliseconds: 59_999,
    });
    expect(client.eval).toHaveBeenCalledWith(expect.any(String), 1, quoteKey, "59999");
  });

  it.each([
    "1",
    Buffer.from("1"),
    [1],
    [1, 60_000, 1],
    [1, 60_000.5],
    [Number.NaN, 60_000],
    [0, 60_000],
    [-1, 60_000],
    [1, 0],
    [1, -1],
    [1, -2],
    [1, 60_001],
    [`secret-${quoteKey}`, 60_000],
  ])("fails closed for malformed Redis result %j", async (result) => {
    const client = createRedisClient();
    vi.mocked(client.eval).mockResolvedValueOnce(result);
    const service = new RedisService(client);

    const error = await captureError(service.executeRateLimit(quoteKey, 30, 60_000));
    expect(error.message).toBe("Redis rate limit failed");
    expect(error.message).not.toContain("secret");
    expect(error.message).not.toContain(quoteKey);
  });

  it("returns one exact safe error for Redis client failures", async () => {
    const client = createRedisClient();
    vi.mocked(client.eval).mockRejectedValueOnce(new Error(`secret ${quoteKey}`));
    const service = new RedisService(client);

    const error = await captureError(service.executeRateLimit(quoteKey, 30, 60_000));
    expect(error.message).toBe("Redis rate limit failed");
    expect(error.message).not.toContain("secret");
    expect(error.message).not.toContain(quoteKey);
  });

  it("returns the same exact safe error for a hostile mocked result", async () => {
    const client = createRedisClient();
    const hostileResult = new Proxy([1, 60_000], {
      get: (_target, property) => {
        if (property === "then") {
          return undefined;
        }
        throw new Error(`secret ${quoteKey}`);
      },
    });
    vi.mocked(client.eval).mockResolvedValueOnce(hostileResult);
    const service = new RedisService(client);

    const error = await captureError(service.executeRateLimit(quoteKey, 30, 60_000));
    expect(error.message).toBe("Redis rate limit failed");
    expect(error.message).not.toContain("secret");
    expect(error.message).not.toContain(quoteKey);
  });
});

const createWriteRateLimitService = () => {
  const redis = {
    executeRateLimit: vi.fn(() => Promise.resolve({ count: 1, ttlMilliseconds: 60_000 })),
  } as unknown as RedisService;

  return { redis, service: new WriteRateLimitService(redis) };
};

const expectUnavailable = async (
  rejection: Promise<unknown>,
  internalValues: string[] = [],
): Promise<void> => {
  const error = await captureError(rejection);
  expect(error).toBeInstanceOf(BusinessException);
  const businessError = error as BusinessException;
  expect(businessError.code).toBe("BOOKING_SERVICE_UNAVAILABLE");
  expect(businessError.details).toBeUndefined();
  expect(businessError.message).toBe("预订服务暂时不可用，请稍后重试");
  expect(businessError.getStatus()).toBe(503);
  for (const internalValue of internalValues) {
    expect(businessError.message).not.toContain(internalValue);
  }
};

const expectRateLimited = async (
  rejection: Promise<unknown>,
  retryAfterSeconds: number,
): Promise<void> => {
  const error = await captureError(rejection);
  expect(error).toBeInstanceOf(BusinessException);
  const businessError = error as BusinessException;
  expect(businessError.code).toBe("RATE_LIMITED");
  expect(businessError.details).toEqual({ retry_after_seconds: retryAfterSeconds });
  expect(businessError.message).toBe("操作过于频繁，请稍后重试");
  expect(businessError.getStatus()).toBe(429);
};

describe("WriteRateLimitService", () => {
  it("uses distinct hashed scopes and never exposes a raw user identifier", async () => {
    const { redis, service } = createWriteRateLimitService();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await expect(service.checkQuotes(userId)).resolves.toBeUndefined();
      await expect(service.checkBookings(userId)).resolves.toBeUndefined();
      await expect(service.checkQuotes(otherUserId)).resolves.toBeUndefined();
    } finally {
      logSpy.mockRestore();
    }

    const keys = vi.mocked(redis.executeRateLimit).mock.calls.map(([key]) => key);
    expect(keys).toEqual([
      `rate-limit:quotes:${hash(userId)}`,
      `rate-limit:bookings:${hash(userId)}`,
      `rate-limit:quotes:${hash(otherUserId)}`,
    ]);
    expect(new Set(keys).size).toBe(3);
    expect(JSON.stringify({ keys, logs: logSpy.mock.calls })).not.toContain(userId);
    expect(keys.every((key) => /^rate-limit:(quotes|bookings):[a-f0-9]{64}$/.test(key))).toBe(true);
    expect(vi.mocked(redis.executeRateLimit).mock.calls).toEqual(
      expect.arrayContaining([
        [`rate-limit:quotes:${hash(userId)}`, 30, 60_000],
        [`rate-limit:bookings:${hash(userId)}`, 10, 60_000],
      ]),
    );
  });

  it.each([
    ["quotes", 30, 31, "checkQuotes"],
    ["bookings", 10, 11, "checkBookings"],
  ] as const)(
    "allows exactly the %s limit of %i and rejects count %i",
    async (_, limit, rejectedCount, method) => {
      const { redis, service } = createWriteRateLimitService();
      vi.mocked(redis.executeRateLimit).mockImplementation((_, __, windowMilliseconds) =>
        Promise.resolve({
          count: vi.mocked(redis.executeRateLimit).mock.calls.length,
          ttlMilliseconds: windowMilliseconds,
        }),
      );

      for (let count = 1; count <= limit; count += 1) {
        await expect(service[method](userId)).resolves.toBeUndefined();
      }

      await expectRateLimited(service[method](userId), 60);
      expect(vi.mocked(redis.executeRateLimit)).toHaveBeenCalledTimes(rejectedCount);
    },
  );

  it.each([
    [1, 1],
    [1001, 2],
    [59_999, 60],
    [60_000, 60],
  ])("rounds TTL %i up to %i retry seconds within the fixed window", async (ttl, expected) => {
    const { redis, service } = createWriteRateLimitService();
    vi.mocked(redis.executeRateLimit).mockResolvedValueOnce({
      count: 31,
      ttlMilliseconds: ttl,
    });
    await expectRateLimited(service.checkQuotes(userId), expected);
  });

  it.each([null, undefined, "", "not-a-uuid", "x".repeat(257), { toString: () => userId }])(
    "fails closed for hostile user input without touching Redis",
    async (unsafeUserId) => {
      const { redis, service } = createWriteRateLimitService();

      await expectUnavailable(service.checkBookings(unsafeUserId as string));
      expect(redis.executeRateLimit).not.toHaveBeenCalled();
    },
  );

  it("maps Redis and unknown mocked results to a stable unavailable error before a caller can write", async () => {
    const { redis, service } = createWriteRateLimitService();
    const internalSecret = `secret ${userId}`;
    vi.mocked(redis.executeRateLimit).mockRejectedValueOnce(new Error(internalSecret));
    let sideEffect = false;
    const protectedWrite = async () => {
      await service.checkBookings(userId);
      sideEffect = true;
    };

    await expectUnavailable(protectedWrite(), [internalSecret, userId]);
    expect(sideEffect).toBe(false);

    vi.mocked(redis.executeRateLimit).mockRejectedValueOnce(
      new BusinessException(429, "UNSAFE_DEPENDENCY_ERROR", "internal rate-limit error"),
    );
    await expectUnavailable(service.checkBookings(userId), ["internal rate-limit error"]);

    vi.mocked(redis.executeRateLimit).mockResolvedValueOnce({ count: 1, ttlMilliseconds: -1 });
    await expectUnavailable(service.checkBookings(userId));

    const hostileResult = new Proxy(
      { count: 1, ttlMilliseconds: 60_000 },
      {
        get: (_target, property) => {
          if (property === "then") {
            return undefined;
          }
          throw new Error(internalSecret);
        },
      },
    );
    vi.mocked(redis.executeRateLimit).mockResolvedValueOnce(hostileResult);
    await expectUnavailable(service.checkBookings(userId), [internalSecret, userId]);
  });
});

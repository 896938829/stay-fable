import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { LoggerModule } from "nestjs-pino";

import { systemClock } from "../src/common/clock/clock.js";
import {
  REDIS_CLIENT,
  RedisService,
  type RedisClient,
} from "../src/infrastructure/redis/redis.service.js";

const redisConstructorMock = vi.hoisted(() => vi.fn());

vi.mock("ioredis", () => ({
  Redis: class {
    constructor(url: string) {
      redisConstructorMock(url);
    }
  },
}));

const createRedisClient = (): RedisClient => ({
  ping: vi.fn(() => Promise.resolve("PONG")),
  quit: vi.fn(() => Promise.resolve("OK")),
  get: vi.fn(() => Promise.resolve(null)),
  set: vi.fn(() => Promise.resolve("OK")),
  eval: vi.fn(() => Promise.resolve(null)),
  del: vi.fn(() => Promise.resolve(1)),
  pttl: vi.fn(() => Promise.resolve(60_000)),
});

describe("systemClock", () => {
  it("returns the current time as a Date", () => {
    const before = Date.now();
    const now = systemClock.now();

    expect(now).toBeInstanceOf(Date);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(now.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe("RedisService", () => {
  let client: RedisClient;
  let service: RedisService;

  beforeEach(() => {
    client = createRedisClient();
    service = new RedisService(client);
  });

  it("pings Redis when the module initializes", async () => {
    await service.onModuleInit();

    expect(client.ping).toHaveBeenCalledOnce();
  });

  it("quits Redis when the module is destroyed", async () => {
    await service.onModuleDestroy();

    expect(client.quit).toHaveBeenCalledOnce();
  });

  it("stores JSON with an expiration in seconds", async () => {
    await service.setJson("session:1", { accountId: "account-1" }, 7200);

    expect(client.set).toHaveBeenCalledWith("session:1", '{"accountId":"account-1"}', "EX", 7200);
  });

  it("gets parsed JSON", async () => {
    vi.mocked(client.get).mockResolvedValueOnce('{"accountId":"account-1"}');

    await expect(service.getJson<{ accountId: string }>("session:1")).resolves.toEqual({
      accountId: "account-1",
    });
  });

  it("returns null when a key does not exist", async () => {
    await expect(service.getJson("missing")).resolves.toBeNull();
  });

  it("atomically gets and deletes JSON with a fixed Lua script", async () => {
    vi.mocked(client.eval).mockResolvedValueOnce('{"tokenId":"token-1"}');

    await expect(service.consumeJson<{ tokenId: string }>("refresh:1")).resolves.toEqual({
      tokenId: "token-1",
    });
    expect(client.eval).toHaveBeenCalledOnce();
    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET', KEYS[1])"),
      1,
      "refresh:1",
    );
    expect(vi.mocked(client.eval).mock.calls[0]?.[0]).toContain("redis.call('DEL', KEYS[1])");
  });

  it("executes a session script with all declared keys and arguments", async () => {
    vi.mocked(client.eval).mockResolvedValueOnce("OK");

    await expect(
      service.executeSessionScript(
        "return 'OK'",
        ["session:access:a", "session:refresh:r", "session:family:f"],
        ["access-json", "refresh-json", "family-json", "120000", "600000"],
      ),
    ).resolves.toBe("OK");

    expect(client.eval).toHaveBeenCalledWith(
      "return 'OK'",
      3,
      "session:access:a",
      "session:refresh:r",
      "session:family:f",
      "access-json",
      "refresh-json",
      "family-json",
      "120000",
      "600000",
    );
  });

  it("returns a fixed safe failure for session script errors or invalid results", async () => {
    vi.mocked(client.eval).mockRejectedValueOnce(new Error("secret redis detail"));
    await expect(service.executeSessionScript("return 1", [], [])).rejects.toThrow(
      "Redis session script failed",
    );

    vi.mocked(client.eval).mockResolvedValueOnce(42);
    await expect(service.executeSessionScript("return 1", [], [])).rejects.toThrow(
      "Redis session script failed",
    );
  });

  it("deletes a key", async () => {
    await service.delete("session:1");

    expect(client.del).toHaveBeenCalledWith("session:1");
  });

  it("reads key TTL in milliseconds through a safe wrapper", async () => {
    vi.mocked(client.pttl).mockResolvedValueOnce(59_876);

    await expect(service.ttlMilliseconds("session:1")).resolves.toBe(59_876);
    expect(client.pttl).toHaveBeenCalledWith("session:1");

    vi.mocked(client.pttl).mockRejectedValueOnce(new Error("secret redis detail"));
    await expect(service.ttlMilliseconds("session:1")).rejects.toThrow("Redis operation failed");
  });

  it("throws a fixed safe error for malformed stored JSON", async () => {
    const malformedValue = "{secret-token";
    vi.mocked(client.get).mockResolvedValueOnce(malformedValue);

    let thrown: unknown;
    try {
      await service.getJson("session:1");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Stored JSON is invalid");
    expect((thrown as Error).message).not.toContain(malformedValue);
  });

  it("does not expose a value from Redis client errors", async () => {
    const sensitiveValue = "payment-secret";
    vi.mocked(client.set).mockRejectedValueOnce(new Error(`failed ${sensitiveValue}`));

    let thrown: unknown;
    try {
      await service.setJson("payment:1", sensitiveValue, 60);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(sensitiveValue);
  });

  it("rejects values that JSON cannot serialize to a string", async () => {
    await expect(service.setJson("session:1", undefined, 60)).rejects.toThrow(
      "Value cannot be serialized",
    );
    expect(client.set).not.toHaveBeenCalled();
  });
});

describe("RedisModule", () => {
  it("can be imported without reading process.env at module evaluation", async () => {
    const previousRedisUrl = process.env.REDIS_URL;
    delete process.env.REDIS_URL;

    try {
      await expect(import("../src/infrastructure/redis/redis.module.js")).resolves.toBeDefined();
    } finally {
      if (previousRedisUrl !== undefined) {
        process.env.REDIS_URL = previousRedisUrl;
      }
    }
  });

  it("creates the singleton client from ConfigService and exports RedisService", async () => {
    const { RedisModule } = await import("../src/infrastructure/redis/redis.module.js");
    const providers = Reflect.getMetadata("providers", RedisModule) as Array<
      | typeof RedisService
      | {
          provide: symbol;
          inject: unknown[];
          useFactory: (configService: Pick<ConfigService, "getOrThrow">) => RedisClient;
        }
    >;
    const clientProvider = providers.find(
      (
        provider,
      ): provider is {
        provide: symbol;
        inject: unknown[];
        useFactory: (configService: Pick<ConfigService, "getOrThrow">) => RedisClient;
      } => typeof provider === "object" && provider.provide === REDIS_CLIENT,
    );

    expect(clientProvider?.inject).toEqual([ConfigService]);
    clientProvider?.useFactory({
      getOrThrow: vi.fn(() => "redis://validated.example.test:6379"),
    });
    expect(redisConstructorMock).toHaveBeenCalledWith("redis://validated.example.test:6379");
    expect(Reflect.getMetadata("exports", RedisModule)).toContain(RedisService);
  });

  it("is appended after the existing ConfigModule and LoggerModule in AppModule", async () => {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = "postgresql://localhost:5432/stay_fable";
    process.env.REDIS_URL = "redis://localhost:6379";
    const { AppModule } = await import("../src/app.module.js");
    const { RedisModule } = await import("../src/infrastructure/redis/redis.module.js");
    const imports = Reflect.getMetadata("imports", AppModule) as unknown[];

    await expect(imports[0]).resolves.toHaveProperty("module", ConfigModule);
    expect(imports[1]).toHaveProperty("module", LoggerModule);
    expect(imports[2]).toBe(RedisModule);
  });
});

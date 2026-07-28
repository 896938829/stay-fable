import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabaseService } from "../src/database/database.service.js";
import { HealthService } from "../src/health/health.service.js";

const redisMock = vi.hoisted(() => ({
  connect: vi.fn(() => Promise.resolve()),
  disconnect: vi.fn(),
  on: vi.fn(),
  ping: vi.fn(() => Promise.resolve("PONG")),
  options: undefined as
    ({ retryStrategy?: () => number | null } & Record<string, unknown>) | undefined,
}));

vi.mock("ioredis", () => ({
  Redis: class RedisProbe {
    constructor(url: string, options: Record<string, unknown>) {
      if (url === "redis://constructor-error") {
        throw new Error("redis://user:secret@private");
      }
      redisMock.options = options;
    }

    connect = redisMock.connect;
    disconnect = redisMock.disconnect;
    on = redisMock.on;
    ping = redisMock.ping;
  },
}));

describe("HealthService readiness", () => {
  beforeEach(() => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    redisMock.connect.mockReset().mockResolvedValue(undefined);
    redisMock.disconnect.mockReset();
    redisMock.on.mockReset();
    redisMock.ping.mockReset().mockResolvedValue("PONG");
    redisMock.options = undefined;
  });

  it("reports both dependencies up and closes the bounded Redis probe", async () => {
    const database = { check: vi.fn(() => Promise.resolve()) } as unknown as DatabaseService;
    const service = new HealthService(database);

    await expect(service.ready()).resolves.toEqual({
      status: "ok",
      service: "api-server",
      checks: { database: "up", redis: "up" },
    });
    expect(redisMock.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(redisMock.options).toMatchObject({
      connectTimeout: 1_000,
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 0,
    });
    expect(redisMock.options?.retryStrategy?.()).toBeNull();
    expect(redisMock.disconnect).toHaveBeenCalledOnce();
  });

  it("normalizes a database failure and still probes Redis", async () => {
    const database = {
      check: vi.fn(() => Promise.reject(new Error("postgresql://user:secret@private/db"))),
    } as unknown as DatabaseService;
    const service = new HealthService(database);

    await expect(service.ready()).resolves.toEqual({
      status: "unavailable",
      service: "api-server",
      checks: { database: "down", redis: "up" },
    });
    expect(redisMock.ping).toHaveBeenCalledOnce();
  });

  it("normalizes a Redis failure, disconnects, and remains callable", async () => {
    const database = { check: vi.fn(() => Promise.resolve()) } as unknown as DatabaseService;
    redisMock.connect.mockRejectedValueOnce(new Error("redis://:secret@private:6379"));
    const service = new HealthService(database);

    await expect(service.ready()).resolves.toEqual({
      status: "unavailable",
      service: "api-server",
      checks: { database: "up", redis: "down" },
    });
    expect(redisMock.disconnect).toHaveBeenCalledOnce();
    expect(service.live()).toEqual({ status: "ok", service: "api-server" });
  });

  it("normalizes a Redis client construction failure", async () => {
    process.env.REDIS_URL = "redis://constructor-error";
    const database = { check: vi.fn(() => Promise.resolve()) } as unknown as DatabaseService;
    const service = new HealthService(database);

    await expect(service.ready()).resolves.toEqual({
      status: "unavailable",
      service: "api-server",
      checks: { database: "up", redis: "down" },
    });
  });
});

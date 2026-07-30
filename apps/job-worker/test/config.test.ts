import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { parseWorkerConfig } from "../src/config.js";

describe("parseWorkerConfig", () => {
  const databaseUrl = "postgresql://dbuser:secret@127.0.0.1:5432/stay_fable?sslmode=disable";

  it("derives a namespaced queue prefix from the runtime environment", () => {
    const config = parseWorkerConfig({
      NODE_ENV: "test",
      REDIS_URL: "redis://127.0.0.1:6379",
      DATABASE_URL: databaseUrl,
    });

    expect(config).toEqual({
      bookingExpiryPollMs: 5_000,
      databaseUrl,
      nodeEnv: "test",
      redisUrl: "redis://127.0.0.1:6379",
      queuePrefix: "stay-fable:test",
    });
    expectTypeOf(config).toEqualTypeOf<{
      readonly bookingExpiryPollMs: number;
      readonly databaseUrl: string;
      readonly nodeEnv: "development" | "test" | "production";
      readonly queuePrefix: `stay-fable:${"development" | "test" | "production"}`;
      readonly redisUrl: string;
    }>();
  });

  it.each(["redis://127.0.0.1:6379", "rediss://redis.example.test:6380"])(
    "accepts a Redis URL using %s",
    (redisUrl) => {
      expect(
        parseWorkerConfig({
          NODE_ENV: "test",
          REDIS_URL: redisUrl,
          DATABASE_URL: databaseUrl,
        }).redisUrl,
      ).toBe(redisUrl);
    },
  );

  it("rejects a non-Redis URL with a clear message", () => {
    let thrown: unknown;

    try {
      parseWorkerConfig({
        NODE_ENV: "test",
        REDIS_URL: "https://user:secret@redis.example.test",
        DATABASE_URL: databaseUrl,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("REDIS_URL must use redis: or rediss: protocol");
    expect((thrown as Error).message).not.toContain("user");
    expect((thrown as Error).message).not.toContain("secret");
  });

  it("rejects redis: in production", () => {
    expect(() =>
      parseWorkerConfig({
        NODE_ENV: "production",
        REDIS_URL: "redis://redis.example.test:6379",
        DATABASE_URL: "postgresql://worker:secret@database.example.test/stay_fable?sslmode=require",
      }),
    ).toThrow("Production REDIS_URL must use rediss: protocol");
  });

  it("accepts rediss: in production", () => {
    expect(
      parseWorkerConfig({
        NODE_ENV: "production",
        REDIS_URL: "rediss://redis.example.test:6380",
        DATABASE_URL: "postgresql://worker:secret@database.example.test/stay_fable?sslmode=require",
      }).redisUrl,
    ).toBe("rediss://redis.example.test:6380");
  });

  it("returns the database URL and configured booking expiry interval", () => {
    expect(
      parseWorkerConfig({
        NODE_ENV: "development",
        REDIS_URL: "redis://127.0.0.1:6379",
        DATABASE_URL: databaseUrl,
        BOOKING_EXPIRY_POLL_MS: "1200",
      }),
    ).toMatchObject({
      databaseUrl,
      bookingExpiryPollMs: 1_200,
    });
  });

  it.each([
    ["missing DATABASE_URL", undefined],
    ["too small interval", "999"],
    ["too large interval", "60001"],
  ])("rejects %s without exposing database credentials", (_scenario, interval) => {
    const environment: Record<string, unknown> = {
      NODE_ENV: "test",
      REDIS_URL: "redis://127.0.0.1:6379",
      DATABASE_URL: databaseUrl,
    };
    if (interval === undefined) {
      delete environment.DATABASE_URL;
    } else {
      environment.BOOKING_EXPIRY_POLL_MS = interval;
    }

    let thrown: unknown;
    try {
      parseWorkerConfig(environment);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toMatch(/dbuser|secret|127\.0\.0\.1/);
  });

  it.each([
    [
      "production TLS disable",
      "production",
      "postgresql://worker:secret@database.example.test/stay_fable?sslmode=disable",
    ],
    ["wrong protocol", "test", "https://worker:secret@database.example.test/stay_fable"],
  ])("rejects %s with a sanitized error", (_scenario, nodeEnv, unsafeDatabaseUrl) => {
    let thrown: unknown;
    try {
      parseWorkerConfig({
        NODE_ENV: nodeEnv,
        REDIS_URL: nodeEnv === "production" ? "rediss://redis.example.test" : "redis://localhost",
        DATABASE_URL: unsafeDatabaseUrl,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toMatch(/worker|secret|database\.example/);
  });

  it("fails closed without invoking a hostile environment getter", () => {
    const getter = vi.fn(() => {
      throw new Error("getter-secret");
    });
    const hostile = Object.defineProperty({}, "DATABASE_URL", {
      enumerable: true,
      get: getter,
    });
    let thrown: unknown;
    try {
      parseWorkerConfig(hostile);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Invalid worker environment");
    expect(getter).not.toHaveBeenCalled();
  });

  it("reads a proxy environment without invoking its hostile value trap", () => {
    const get = vi.fn(() => {
      throw new Error("proxy-secret");
    });
    const target = {
      NODE_ENV: "test",
      REDIS_URL: "redis://127.0.0.1:6379",
      DATABASE_URL: databaseUrl,
    };

    expect(parseWorkerConfig(new Proxy(target, { get }))).toMatchObject({
      nodeEnv: "test",
      databaseUrl,
    });
    expect(get).not.toHaveBeenCalled();
  });
});

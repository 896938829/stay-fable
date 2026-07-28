import { describe, expect, expectTypeOf, it } from "vitest";

import { parseWorkerConfig } from "../src/config.js";

describe("parseWorkerConfig", () => {
  it("derives a namespaced queue prefix from the runtime environment", () => {
    const config = parseWorkerConfig({
      NODE_ENV: "test",
      REDIS_URL: "redis://127.0.0.1:6379",
    });

    expect(config).toEqual({
      nodeEnv: "test",
      redisUrl: "redis://127.0.0.1:6379",
      queuePrefix: "stay-fable:test",
    });
    expectTypeOf(config).toEqualTypeOf<{
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
      }),
    ).toThrow("Production REDIS_URL must use rediss: protocol");
  });

  it("accepts rediss: in production", () => {
    expect(
      parseWorkerConfig({
        NODE_ENV: "production",
        REDIS_URL: "rediss://redis.example.test:6380",
      }).redisUrl,
    ).toBe("rediss://redis.example.test:6380");
  });
});

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
    expect(() =>
      parseWorkerConfig({
        NODE_ENV: "test",
        REDIS_URL: "https://redis.example.test",
      }),
    ).toThrow("REDIS_URL must use redis: or rediss: protocol");
  });
});

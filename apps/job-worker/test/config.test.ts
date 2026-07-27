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

  it("accepts any syntactically valid URL", () => {
    expect(
      parseWorkerConfig({
        NODE_ENV: "test",
        REDIS_URL: "https://redis.example.test",
      }).redisUrl,
    ).toBe("https://redis.example.test");
  });
});

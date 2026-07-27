import { describe, expect, it } from "vitest";

import { parseWorkerConfig } from "../src/config.js";

describe("parseWorkerConfig", () => {
  it("derives a namespaced queue prefix from the runtime environment", () => {
    expect(
      parseWorkerConfig({
        NODE_ENV: "test",
        REDIS_URL: "redis://127.0.0.1:6379",
      }),
    ).toEqual({
      nodeEnv: "test",
      redisUrl: "redis://127.0.0.1:6379",
      queuePrefix: "stay-fable:test",
    });
  });
});

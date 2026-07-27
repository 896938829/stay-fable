import { describe, expect, it } from "vitest";

import { validateRuntimeConfig } from "../src/config/runtime-config.js";

describe("validateRuntimeConfig", () => {
  it("inherits the shared production transport requirements", () => {
    expect(() =>
      validateRuntimeConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://localhost:5432/stay_fable?sslmode=require",
        REDIS_URL: "redis://localhost:6379",
      }),
    ).toThrow("Production REDIS_URL must use rediss: protocol");
  });
});

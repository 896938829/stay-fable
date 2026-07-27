import { describe, expect, it } from "vitest";

import { parseRuntimeEnvironment } from "../src/environment.js";

describe("parseRuntimeEnvironment", () => {
  it("rejects a production DATABASE_URL that disables TLS", () => {
    expect(() =>
      parseRuntimeEnvironment({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://user:password@localhost:5432/stay_fable?sslmode=disable",
        REDIS_URL: "redis://localhost:6379",
      }),
    ).toThrow("Production DATABASE_URL must require TLS.");
  });
});

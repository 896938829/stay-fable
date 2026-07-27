import { describe, expect, it } from "vitest";

import { parseRuntimeEnvironment } from "../src/environment.js";

describe("parseRuntimeEnvironment", () => {
  it("rejects a production DATABASE_URL that disables TLS", () => {
    let thrown: unknown;

    try {
      parseRuntimeEnvironment({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://user:password@localhost:5432/stay_fable?sslmode=disable",
        REDIS_URL: "redis://localhost:6379",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Production DATABASE_URL must require TLS");
  });
});

import { describe, expect, it } from "vitest";

import { healthResponseSchema } from "../src/health.js";

describe("healthResponseSchema", () => {
  it("accepts a healthy API response unchanged", () => {
    const response = {
      status: "ok",
      service: "api-server",
      checks: {
        database: "up",
        redis: "up",
      },
    } as const;

    expect(healthResponseSchema.parse(response)).toEqual(response);
  });

  it("accepts a structured unavailable response without error details", () => {
    const response = {
      status: "unavailable",
      service: "api-server",
      checks: {
        database: "down",
        redis: "up",
      },
    } as const;

    expect(healthResponseSchema.parse(response)).toEqual(response);
  });
});

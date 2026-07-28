import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  authSessionSchema,
  refreshSessionRequestSchema,
  wechatLoginRequestSchema,
} from "../src/auth.js";

const validUuid = "018f47b6-0f58-7f52-8a35-3f92a6f34762";

describe("auth package export", () => {
  it("publishes auth from a stable subpath", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      exports: Record<string, unknown>;
    };

    expect(packageJson.exports["./auth"]).toEqual({
      types: "./src/auth.ts",
      default: "./dist/src/auth.js",
    });
  });
});

describe("wechatLoginRequestSchema", () => {
  it("accepts codes from 8 through 128 characters", () => {
    expect(wechatLoginRequestSchema.parse({ code: "mock:abc" })).toEqual({ code: "mock:abc" });
    expect(wechatLoginRequestSchema.parse({ code: "x".repeat(128) })).toEqual({
      code: "x".repeat(128),
    });
  });

  it("rejects missing, short, long, and non-string codes", () => {
    for (const value of [{}, { code: "short" }, { code: "x".repeat(129) }, { code: 42 }]) {
      expect(wechatLoginRequestSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("authSessionSchema", () => {
  const validSession = {
    access_token: "a".repeat(32),
    access_expires_in: 7200,
    refresh_token: "r".repeat(32),
    refresh_expires_in: 2_592_000,
    user: { id: validUuid },
  };

  it("accepts a complete session", () => {
    expect(authSessionSchema.parse(validSession)).toEqual(validSession);
  });

  it("rejects weak tokens, non-positive expiry values, and invalid user IDs", () => {
    for (const value of [
      { ...validSession, access_token: "short" },
      { ...validSession, refresh_token: "short" },
      { ...validSession, access_expires_in: 0 },
      { ...validSession, refresh_expires_in: 1.5 },
      { ...validSession, user: { id: "not-a-uuid" } },
    ]) {
      expect(authSessionSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("refreshSessionRequestSchema", () => {
  it("accepts tokens of at least 32 characters and rejects shorter values", () => {
    expect(refreshSessionRequestSchema.parse({ refresh_token: "r".repeat(32) })).toEqual({
      refresh_token: "r".repeat(32),
    });
    expect(refreshSessionRequestSchema.safeParse({ refresh_token: "r".repeat(31) }).success).toBe(
      false,
    );
  });
});

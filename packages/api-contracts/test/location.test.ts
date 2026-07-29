import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  citySchema,
  resolvedLocationSchema,
  resolveLocationRequestSchema,
} from "../src/location.js";

describe("location contracts", () => {
  it("accepts an operating city with a UUID identifier", () => {
    expect(
      citySchema.parse({
        id: "10000000-0000-4000-8000-000000000001",
        code: "330100",
        name: "杭州",
      }),
    ).toEqual({
      id: "10000000-0000-4000-8000-000000000001",
      code: "330100",
      name: "杭州",
    });
  });

  it("bounds nonblank city labels without transforming accepted values", () => {
    const id = "10000000-0000-4000-8000-000000000001";
    const boundary = {
      id,
      code: "c".repeat(32),
      name: "城".repeat(80),
    };

    expect(citySchema.parse(boundary)).toEqual(boundary);
    expect(
      citySchema.parse({
        id,
        code: " 330100 ",
        name: " 杭州 ",
      }),
    ).toEqual({
      id,
      code: " 330100 ",
      name: " 杭州 ",
    });
    for (const invalid of [
      { ...boundary, code: "c".repeat(33) },
      { ...boundary, name: "城".repeat(81) },
      { ...boundary, code: " \t " },
      { ...boundary, name: "\n" },
    ]) {
      expect(citySchema.safeParse(invalid).success).toBe(false);
    }
  });

  it.each([
    { longitude: -180, latitude: -90 },
    { longitude: 180, latitude: 90 },
    { longitude: 120.1551, latitude: 30.2741 },
  ])("accepts coordinates on and within the world bounds", (coordinates) => {
    expect(resolveLocationRequestSchema.parse(coordinates)).toEqual(coordinates);
  });

  it.each([
    { longitude: -180.000_001, latitude: 0 },
    { longitude: 180.000_001, latitude: 0 },
    { longitude: 0, latitude: -90.000_001 },
    { longitude: 0, latitude: 90.000_001 },
    { latitude: 30.2741 },
    { longitude: 120.1551 },
  ])("rejects out-of-bounds or incomplete coordinates", (coordinates) => {
    expect(resolveLocationRequestSchema.safeParse(coordinates).success).toBe(false);
  });

  it("requires a non-negative integer distance and a contract-valid city", () => {
    const resolved = {
      city: {
        id: "10000000-0000-4000-8000-000000000001",
        code: "330100",
        name: "杭州",
      },
      distance_meters: 0,
    };

    expect(resolvedLocationSchema.parse(resolved)).toEqual(resolved);
    expect(resolvedLocationSchema.safeParse({ ...resolved, distance_meters: -1 }).success).toBe(
      false,
    );
    expect(resolvedLocationSchema.safeParse({ ...resolved, distance_meters: 1.5 }).success).toBe(
      false,
    );
    expect(resolvedLocationSchema.safeParse({ city: resolved.city }).success).toBe(false);
  });

  it("publishes a stable ./location package export", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      exports?: Record<string, { default?: string; types?: string }>;
    };

    expect(packageJson.exports?.["./location"]).toEqual({
      types: "./src/location.ts",
      default: "./dist/src/location.js",
    });
  });
});

import { describe, expect, it } from "vitest";

import { assertSupportedPlatform } from "./adapter";

describe("assertSupportedPlatform", () => {
  it.each(["weapp", "alipay", "tt"] as const)("accepts the %s platform", (platform) => {
    expect(assertSupportedPlatform(platform)).toBe(platform);
  });

  it("rejects an unsupported platform", () => {
    expect(() => assertSupportedPlatform("h5")).toThrowError("Unsupported platform: h5");
  });
});

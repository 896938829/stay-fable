import { describe, expect, it } from "vitest";

import { assertSupportedPlatform } from "./platform-adapter";

describe("assertSupportedPlatform", () => {
  it.each(["weapp", "alipay", "tt"] as const)("accepts %s", (platform) => {
    expect(assertSupportedPlatform(platform)).toBe(platform);
  });

  it("rejects an unplanned platform", () => {
    expect(() => assertSupportedPlatform("h5")).toThrowError("Unsupported platform: h5");
  });
});

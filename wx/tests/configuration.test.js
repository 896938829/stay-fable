import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const appConfigUrl = new URL("../app.json", import.meta.url);
const pendingVerificationUrl = new URL(
  "../../docs/operations/phase-0-verification.md",
  import.meta.url,
);
const taskEightUrl = new URL(
  "../../docs/superpowers/plans/2026-07-29-wx-booking-slice-1-identity-search.md",
  import.meta.url,
);
const cityPageUrl = new URL("../pages/city-select/city-select.wxml", import.meta.url);

describe("WeChat location privacy configuration", () => {
  it("declares the precise private API and user-facing purpose", async () => {
    const config = JSON.parse(await readFile(appConfigUrl, "utf8"));

    expect(config.requiredPrivateInfos).toEqual(["getLocation"]);
    expect(config.permission).toEqual({
      "scope.userLocation": {
        desc: "位置信息仅用于匹配附近已开通城市",
      },
    });
  });

  it("keeps the public-platform privacy declaration as a blocked external gate", async () => {
    const [pendingVerification, taskEight] = await Promise.all([
      readFile(pendingVerificationUrl, "utf8"),
      readFile(taskEightUrl, "utf8"),
    ]);
    const gate = "公众平台隐私保护指引声明位置信息";

    expect(pendingVerification).toContain(gate);
    expect(taskEight).toContain(gate);
    expect(pendingVerification).toMatch(/外部门禁.*Blocked|Blocked.*外部门禁/s);
  });

  it("does not leave unsupported role attributes in the city page", async () => {
    const wxml = await readFile(cityPageUrl, "utf8");

    expect(wxml).not.toMatch(/\srole=/);
  });
});

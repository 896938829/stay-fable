import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { validateWxProject } from "../../scripts/check-wx-project.mjs";

const require = createRequire(import.meta.url);
const appConfigUrl = new URL("../app.json", import.meta.url);
const bookingPageConfigUrl = new URL(
  "../pages/booking-confirm/booking-confirm.json",
  import.meta.url,
);
const wxRootUrl = new URL("../", import.meta.url);
const pendingVerificationUrl = new URL(
  "../../docs/operations/phase-0-verification.md",
  import.meta.url,
);
const taskEightUrl = new URL(
  "../../docs/superpowers/plans/2026-07-29-wx-booking-slice-1-identity-search.md",
  import.meta.url,
);
const cityPageUrl = new URL("../pages/city-select/city-select.wxml", import.meta.url);
const catalogAutomatorUrl = new URL(
  "../automator/slice-2-catalog.js",
  import.meta.url,
);
const sliceFivePreflightUrl = new URL(
  "../automator/slice-5-preflight.js",
  import.meta.url,
);

describe("WeChat location privacy configuration", () => {
  it("registers the nine user-flow pages in order and statically validates every page file", async () => {
    const config = JSON.parse(await readFile(appConfigUrl, "utf8"));

    expect(config.pages).toEqual([
      "pages/home/home",
      "pages/city-select/city-select",
      "pages/date-guest-select/date-guest-select",
      "pages/property-list/property-list",
      "pages/property-detail/property-detail",
      "pages/room-detail/room-detail",
      "pages/booking-confirm/booking-confirm",
      "pages/order-list/order-list",
      "pages/order-detail/order-detail",
    ]);
    await expect(validateWxProject(fileURLToPath(wxRootUrl))).resolves.toEqual({
      pageCount: 9,
    });
  });

  it("declares the precise home and orders tab bar", async () => {
    const config = JSON.parse(await readFile(appConfigUrl, "utf8"));

    expect(config.tabBar).toEqual({
      color: "#8a7f76",
      selectedColor: "#9b5c3f",
      backgroundColor: "#fbf7f2",
      borderStyle: "white",
      list: [
        {
          pagePath: "pages/home/home",
          text: "首页",
          iconPath: "images/tab-home.png",
          selectedIconPath: "images/tab-home-selected.png",
        },
        {
          pagePath: "pages/order-list/order-list",
          text: "订单",
          iconPath: "images/tab-orders.png",
          selectedIconPath: "images/tab-orders-selected.png",
        },
      ],
    });
  });

  it("uses only existing approved components on booking confirmation", async () => {
    const config = JSON.parse(
      await readFile(bookingPageConfigUrl, "utf8"),
    );

    expect(config).toEqual({
      navigationStyle: "custom",
      usingComponents: {
        "navigation-bar": "/components/navigation-bar/navigation-bar",
        "loading-state": "/components/loading-state/loading-state",
        "error-state": "/components/error-state/error-state",
        price: "/components/price/price",
      },
    });
    for (const component of Object.values(config.usingComponents)) {
      const componentJson = new URL(`.${component}.json`, wxRootUrl);
      await expect(readFile(componentJson, "utf8")).resolves.toBeTruthy();
    }
  });

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

  it("keeps the catalog automator executable and bound to real page and component selectors", async () => {
    const [
      script,
      homeWxml,
      listWxml,
      propertyCardWxml,
      propertyWxml,
      roomWxml,
      listLogic,
    ] = await Promise.all([
      readFile(catalogAutomatorUrl, "utf8"),
      readFile(new URL("../pages/home/home.wxml", import.meta.url), "utf8"),
      readFile(
        new URL("../pages/property-list/property-list.wxml", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL(
          "../components/property-card/property-card.wxml",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../pages/property-detail/property-detail.wxml",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL("../pages/room-detail/room-detail.wxml", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL(
          "../pages/property-list/property-list.logic.js",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);

    expect(() => new vm.Script(script)).not.toThrow();
    for (const [selector, source] of [
      [".home", homeWxml],
      [".search-button", homeWxml],
      [".property-list-page", listWxml],
      [".property-results", listWxml],
      [".property-card__tap-target", propertyCardWxml],
      [".property-detail-page", propertyWxml],
      [".room-card__action", propertyWxml],
      [".room-detail-page", roomWxml],
      [".nightly-list__item", roomWxml],
      [".selection-bar__action", roomWxml],
    ]) {
      expect(source).toContain(selector.slice(1));
      expect(script).toContain(`"${selector}"`);
    }
    expect(listWxml).toContain('data-type="{{item.value}}"');
    expect(listWxml).toContain("<property-card");
    expect(listLogic).toContain('{ value: "HOMESTAY", label: "民宿" }');
    expect(script).toContain('"property-card"');
    expect(script).toContain('"HOMESTAY"');
    expect(script).toMatch(
      /propertyCard\.\$\(\s*PROPERTY_CARD_ACTION_SELECTOR\s*\)/,
    );
    expect(script).toMatch(/withTimeout\(\s*"launch mini-program"/);
    expect(script).toMatch(/withTimeout\(\s*"close mini-program"/);
    expect(script).not.toMatch(
      /access_token|refresh_token|appid|longitude|latitude|pageX|pageY|clientX|clientY/i,
    );
  });

  it("keeps the Slice 5 preflight executable and strictly read-only", async () => {
    const script = await readFile(sliceFivePreflightUrl, "utf8");
    const preflight = require(fileURLToPath(sliceFivePreflightUrl));

    expect(() => new vm.Script(script)).not.toThrow();
    expect(Object.keys(preflight)).toEqual([
      "READ_ONLY_ADAPTER_METHODS",
      "runPreflight",
    ]);
    expect(preflight.READ_ONLY_ADAPTER_METHODS).toEqual([
      "readCandidate",
      "readWechatIde",
      "readTestAccountCount",
      "readApiHealth",
      "readClockDate",
      "readSeedWindow",
      "readBaseline",
    ]);
    expect(Object.isFrozen(preflight.READ_ONLY_ADAPTER_METHODS)).toBe(true);
  });
});

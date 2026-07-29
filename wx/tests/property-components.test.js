import { readFile } from "node:fs/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

const PROPERTY_ID = "20000000-0000-4000-8000-000000000002";

const property = {
  id: PROPERTY_ID,
  type: "HOTEL",
  name: "西湖云栖酒店",
  city: {
    id: "10000000-0000-4000-8000-000000000001",
    code: "330100",
    name: "杭州",
  },
  cover_url: "/images/properties/xihu.jpg",
  short_description: "湖景步行可达",
  facility_highlights: ["免费停车", "早餐", "湖景", "接送"],
  from_nightly_price_cents: 42800,
  currency: "CNY",
  available_room_type_count: 2,
};

async function readComponent(name, extension) {
  return readFile(
    new URL(`../components/${name}/${name}.${extension}`, import.meta.url),
    "utf8",
  );
}

async function loadDefinition(name) {
  let definition;
  globalThis.Component = vi.fn((value) => {
    definition = value;
  });
  const loaders = {
    price: () => import("../components/price/price.js"),
    "property-card": () => import("../components/property-card/property-card.js"),
  };
  await loaders[name]();
  return definition;
}

describe("catalog display components", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("keeps the price component text-only and formats changed cents", async () => {
    const [priceJs, priceJson, priceWxml, priceWxss] = await Promise.all([
      readComponent("price", "js"),
      readComponent("price", "json"),
      readComponent("price", "wxml"),
      readComponent("price", "wxss"),
    ]);

    expect(priceJs).toContain('require("../../utils/money")');
    expect(JSON.parse(priceJson)).toEqual({ component: true });
    expect(priceWxml).toContain("每晚");
    expect(priceWxml).toContain("起");
    expect(priceWxml).not.toContain("rich-text");
    expect(priceWxss).toContain("var(--color-brand-dark)");

    const definition = await loadDefinition("price");
    expect(definition.properties).toEqual({
      cents: { type: Number, value: 0 },
      prefix: { type: String, value: "每晚" },
      suffix: { type: String, value: "起" },
    });

    const setData = vi.fn();
    definition.observers.cents.call({ setData }, 42800);
    expect(setData).toHaveBeenCalledWith({ formatted: "¥428.00" });
  });

  it.each([Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "falls back safely for invalid cents %j",
    async (cents) => {
      const definition = await loadDefinition("price");
      const setData = vi.fn();

      expect(() => definition.observers.cents.call({ setData }, cents)).not.toThrow();
      expect(setData).toHaveBeenCalledWith({ formatted: "¥0.00" });
    },
  );

  it("renders only property summary fields and registers the price component", async () => {
    const [cardJs, cardJson, cardWxml, cardWxss] = await Promise.all([
      readComponent("property-card", "js"),
      readComponent("property-card", "json"),
      readComponent("property-card", "wxml"),
      readComponent("property-card", "wxss"),
    ]);

    expect(cardJs).toContain('"酒店"');
    expect(cardJs).toContain('"民宿"');
    expect(cardJs).toContain('"农家乐"');
    expect(JSON.parse(cardJson)).toEqual({
      component: true,
      usingComponents: {
        price: "../price/price",
      },
    });
    expect(cardWxml).toContain('bindtap="handleTap"');
    expect(cardWxml).toContain("<price");
    expect(cardWxml).toContain("可售房型");
    expect(cardWxml).not.toMatch(/room_types|roomType|房型列表/);
    expect(cardWxml).not.toContain("data-property");
    expect(cardWxss).toContain("min-height: 88rpx");
  });

  it("maps a property into a bounded display model", async () => {
    const definition = await loadDefinition("property-card");
    expect(definition.properties).toEqual({
      property: {
        type: Object,
        value: null,
      },
    });

    const setData = vi.fn();
    definition.observers.property.call(
      { setData },
      {
        ...property,
        facility_highlights: [...property.facility_highlights, "不应显示"],
      },
    );

    expect(setData).toHaveBeenCalledWith({
      viewModel: {
        id: PROPERTY_ID,
        typeLabel: "酒店",
        name: "西湖云栖酒店",
        description: "湖景步行可达",
        coverUrl: "/images/properties/xihu.jpg",
        coverAlt: "西湖云栖酒店封面",
        facilities: ["免费停车", "早餐", "湖景", "接送"],
        availableCount: 2,
        priceCents: 42800,
        interactive: true,
      },
    });
  });

  it("uses safe fallback display values for an invalid property", async () => {
    const definition = await loadDefinition("property-card");
    const setData = vi.fn();

    expect(() =>
      definition.observers.property.call(
        { setData },
        {
          id: "not-a-uuid",
          type: "UNKNOWN",
          name: "",
          short_description: null,
          cover_url: "",
          facility_highlights: ["", 12],
          available_room_type_count: -1,
          from_nightly_price_cents: -1,
        },
      ),
    ).not.toThrow();

    expect(setData).toHaveBeenCalledWith({
      viewModel: {
        id: "",
        typeLabel: "旅店",
        name: "旅店信息暂不可用",
        description: "暂无简介",
        coverUrl: "",
        coverAlt: "旅店封面",
        facilities: [],
        availableCount: 0,
        priceCents: 0,
        interactive: false,
      },
    });
  });

  it("emits only the property UUID and ignores invalid property input", async () => {
    const definition = await loadDefinition("property-card");
    const triggerEvent = vi.fn();

    definition.methods.handleTap.call({
      data: { property },
      triggerEvent,
    });
    expect(triggerEvent).toHaveBeenCalledTimes(1);
    expect(triggerEvent).toHaveBeenCalledWith("propertytap", { id: PROPERTY_ID });
    expect(triggerEvent.mock.calls[0][1]).not.toBe(property);

    triggerEvent.mockClear();
    definition.methods.handleTap.call({
      data: { property: { ...property, id: "not-a-uuid" } },
      triggerEvent,
    });
    expect(triggerEvent).not.toHaveBeenCalled();
  });
});

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  availabilityQuerySchema,
  catalogDateSchema,
  catalogResourceSchema,
  currencySchema,
  propertyDetailSchema,
  propertyListQuerySchema,
  propertyListResponseSchema,
  propertyTypeSchema,
  roomTypeDetailSchema,
} from "../src/catalog.js";

const ids = {
  city: "10000000-0000-4000-8000-000000000001",
  property: "20000000-0000-4000-8000-000000000002",
  roomType: "30000000-0000-4000-8000-000000000003",
};

const city = { id: ids.city, code: "330100", name: "杭州" };

const propertyListItem = {
  id: ids.property,
  type: "HOTEL",
  name: "西湖云栖酒店",
  city,
  cover_url: "/images/properties/xihu.jpg",
  short_description: "湖景步行可达",
  facility_highlights: ["免费停车", "早餐"],
  from_nightly_price_cents: 59900,
  currency: "CNY",
  available_room_type_count: 2,
};

const roomTypeSummary = {
  id: ids.roomType,
  name: "湖景大床房",
  bed_type: "KING",
  area_sqm: 35,
  max_guests: 2,
  cover_url: "https://cdn.example.com/rooms/lake-view.jpg",
  policy_summary: "入住当日 18:00 前可免费取消",
  from_nightly_price_cents: 59900,
  currency: "CNY",
};

const propertyDetail = {
  id: ids.property,
  type: "HOTEL",
  name: "西湖云栖酒店",
  city,
  address: "杭州市西湖区灵隐路 1 号",
  description: "临近西湖的精品酒店。",
  policies: "14:00 后入住，12:00 前退房。",
  cover_url: "/images/properties/xihu.jpg",
  media: [{ type: "IMAGE", url: "https://cdn.example.com/properties/xihu.jpg", alt: "酒店外观" }],
  facilities: [{ code: "PARKING", name: "免费停车" }],
  room_types: [roomTypeSummary],
};

const roomTypeDetail = {
  id: ids.roomType,
  name: "湖景大床房",
  bed_type: "KING",
  area_sqm: 35,
  max_guests: 2,
  cover_url: "https://cdn.example.com/rooms/lake-view.jpg",
  currency: "CNY",
  property: { id: ids.property, type: "HOTEL", name: "西湖云栖酒店", city },
  description: "面向西湖的宽敞客房。",
  booking_policy: "入住当日 18:00 前可免费取消。",
  nightly_prices: [
    {
      business_date: "2026-08-01",
      sale_price_cents: 59900,
      rack_price_cents: 69900,
      currency: "CNY",
    },
  ],
};

describe("catalog contracts", () => {
  it("accepts fixed-UUID valid property list, property detail, and room type detail payloads", () => {
    expect(
      propertyListResponseSchema.parse({ items: [propertyListItem], next_cursor: null }),
    ).toEqual({
      items: [propertyListItem],
      next_cursor: null,
    });
    expect(propertyDetailSchema.parse(propertyDetail)).toEqual(propertyDetail);
    expect(roomTypeDetailSchema.parse(roomTypeDetail)).toEqual(roomTypeDetail);
  });

  it("publishes the catalog contract from a stable package export", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { exports?: Record<string, { default?: string; types?: string }> };

    expect(packageJson.exports?.["./catalog"]).toEqual({
      types: "./src/catalog.ts",
      default: "./dist/src/catalog.js",
    });
  });

  it("accepts only exact calendar dates, 1–10 guests, and bounded pagination", () => {
    expect(catalogDateSchema.parse("2026-08-01")).toBe("2026-08-01");
    expect(catalogDateSchema.safeParse("2026-8-1").success).toBe(false);
    expect(catalogDateSchema.safeParse("2026-08-01T00:00:00Z").success).toBe(false);

    expect(
      availabilityQuerySchema.parse({ checkin: "2026-08-01", checkout: "2026-08-02", guests: 1 }),
    ).toEqual({ checkin: "2026-08-01", checkout: "2026-08-02", guests: 1 });
    expect(
      propertyListQuerySchema.parse({
        checkin: "2026-08-01",
        checkout: "2026-08-02",
        guests: 10,
        city_id: ids.city,
        page_size: 20,
      }),
    ).toMatchObject({ guests: 10, page_size: 20 });

    for (const value of [
      { checkin: "2026-08-01", checkout: "2026-08-02", guests: 0 },
      { checkin: "2026-08-01", checkout: "2026-08-02", guests: 11 },
      { checkin: "2026-08-01", checkout: "2026-08-02", guests: 1.5 },
      {
        checkin: "2026-08-01",
        checkout: "2026-08-02",
        guests: 1,
        city_id: ids.city,
        page_size: 0,
      },
      {
        checkin: "2026-08-01",
        checkout: "2026-08-02",
        guests: 1,
        city_id: ids.city,
        page_size: 21,
      },
    ]) {
      const schema = "city_id" in value ? propertyListQuerySchema : availabilityQuerySchema;
      expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it("accepts real calendar dates while rejecting impossible calendar dates", () => {
    expect(catalogDateSchema.parse("2028-02-29")).toBe("2028-02-29");

    for (const date of ["2026-02-30", "2026-99-99", "0000-00-00", "2027-02-29"]) {
      expect(catalogDateSchema.safeParse(date).success).toBe(false);
    }
  });

  it("defaults and bounds property list pagination cursors", () => {
    const query = {
      checkin: "2026-08-01",
      checkout: "2026-08-02",
      guests: 2,
      city_id: ids.city,
    };

    expect(propertyListQuerySchema.parse(query)).toEqual({ ...query, page_size: 10 });
    expect(propertyListQuerySchema.parse({ ...query, cursor: "a" }).cursor).toBe("a");
    expect(propertyListQuerySchema.parse({ ...query, cursor: "a".repeat(256) }).cursor).toBe(
      "a".repeat(256),
    );
    expect(propertyListQuerySchema.safeParse({ ...query, cursor: "" }).success).toBe(false);
    expect(propertyListQuerySchema.safeParse({ ...query, cursor: "a".repeat(257) }).success).toBe(
      false,
    );
  });

  it("limits property types, currencies, resource paths, and money cents", () => {
    for (const type of ["HOTEL", "HOMESTAY", "FARM_STAY"]) {
      expect(propertyTypeSchema.parse(type)).toBe(type);
    }
    expect(propertyTypeSchema.safeParse("HOSTEL").success).toBe(false);
    expect(currencySchema.parse("CNY")).toBe("CNY");
    expect(currencySchema.safeParse("USD").success).toBe(false);

    expect(catalogResourceSchema.parse("https://cdn.example.com/image.jpg")).toBe(
      "https://cdn.example.com/image.jpg",
    );
    expect(catalogResourceSchema.parse("/images/image.jpg")).toBe("/images/image.jpg");
    expect(catalogResourceSchema.safeParse("http://cdn.example.com/image.jpg").success).toBe(false);
    expect(catalogResourceSchema.safeParse("/assets/image.jpg").success).toBe(false);

    for (const cents of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        propertyListResponseSchema.safeParse({
          items: [{ ...propertyListItem, from_nightly_price_cents: cents }],
          next_cursor: null,
        }).success,
      ).toBe(false);
    }
  });

  it("accepts only well-formed HTTPS URLs and safe local image paths", () => {
    expect(
      catalogResourceSchema.parse("https://cdn.example.com/images/photo.jpg?width=480#hero"),
    ).toBe("https://cdn.example.com/images/photo.jpg?width=480#hero");
    expect(catalogResourceSchema.parse("/images/rooms/lake_view-1.0.jpg")).toBe(
      "/images/rooms/lake_view-1.0.jpg",
    );

    for (const resource of [
      "https://",
      "https://user:password@cdn.example.com/photo.jpg",
      "/images/",
      "/images//photo.jpg",
      "/images/./photo.jpg",
      "/images/../photo.jpg",
      "/images/room\\photo.jpg",
      "/images/photo.jpg?width=480",
      "/images/photo.jpg#hero",
      "/images/room name.jpg",
      "https:/cdn.example.com/photo.jpg",
    ]) {
      expect(catalogResourceSchema.safeParse(resource).success).toBe(false);
    }
  });

  it("rejects unknown fields in strict catalog objects", () => {
    expect(
      propertyListQuerySchema.safeParse({
        checkin: "2026-08-01",
        checkout: "2026-08-02",
        guests: 2,
        city_id: ids.city,
        ignored: true,
      }).success,
    ).toBe(false);
    expect(propertyDetailSchema.safeParse({ ...propertyDetail, ignored: true }).success).toBe(
      false,
    );
    expect(
      propertyDetailSchema.safeParse({
        ...propertyDetail,
        media: [{ ...propertyDetail.media[0], ignored: true }],
      }).success,
    ).toBe(false);
  });

  it("rejects unknown fields in catalog response cities", () => {
    expect(
      propertyDetailSchema.safeParse({
        ...propertyDetail,
        city: { ...city, ignored: true },
      }).success,
    ).toBe(false);
  });

  it("bounds room type detail nightly prices from one through thirty entries", () => {
    expect(roomTypeDetailSchema.parse(roomTypeDetail).nightly_prices).toHaveLength(1);
    expect(
      roomTypeDetailSchema.parse({
        ...roomTypeDetail,
        nightly_prices: Array.from({ length: 30 }, () => roomTypeDetail.nightly_prices[0]),
      }).nightly_prices,
    ).toHaveLength(30);
    expect(roomTypeDetailSchema.safeParse({ ...roomTypeDetail, nightly_prices: [] }).success).toBe(
      false,
    );
    expect(
      roomTypeDetailSchema.safeParse({
        ...roomTypeDetail,
        nightly_prices: Array.from({ length: 31 }, () => roomTypeDetail.nightly_prices[0]),
      }).success,
    ).toBe(false);
  });

  it("rejects inventory and optimistic-lock fields from public room type detail", () => {
    for (const forbidden of [
      "total_inventory",
      "held_inventory",
      "sold_inventory",
      "version",
    ] as const) {
      expect(roomTypeDetailSchema.safeParse({ ...roomTypeDetail, [forbidden]: 1 }).success).toBe(
        false,
      );
    }
  });
});

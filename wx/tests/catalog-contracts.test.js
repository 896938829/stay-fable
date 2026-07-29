import { describe, expect, it } from "vitest";

import {
  catalogResourceSchema,
  propertyDetailSchema,
  propertyListResponseSchema,
  roomTypeDetailSchema,
} from "../../packages/api-contracts/src/catalog.ts";
import contracts from "../services/contracts.js";

const {
  assertPropertyDetail,
  assertPropertyListResponse,
  assertRoomTypeDetail,
} = contracts;

const IDS = {
  city: "10000000-0000-4000-8000-000000000001",
  property: "20000000-0000-4000-8000-000000000002",
  roomType: "30000000-0000-4000-8000-000000000003",
};

const city = { id: IDS.city, code: "330100", name: "杭州" };
const propertyListItem = {
  id: IDS.property,
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
  id: IDS.roomType,
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
  id: IDS.property,
  type: "HOTEL",
  name: "西湖云栖酒店",
  city,
  address: "杭州市西湖区灵隐路 1 号",
  description: "临近西湖的精品酒店。",
  policies: "14:00 后入住，12:00 前退房。",
  cover_url: "/images/properties/xihu.jpg",
  media: [
    {
      type: "IMAGE",
      url: "https://cdn.example.com/properties/xihu.jpg",
      alt: "酒店外观",
    },
  ],
  facilities: [{ code: "PARKING", name: "免费停车" }],
  room_types: [roomTypeSummary],
};
const nightlyPrice = {
  business_date: "2026-08-01",
  sale_price_cents: 59900,
  rack_price_cents: 69900,
  currency: "CNY",
};
const roomTypeDetail = {
  id: IDS.roomType,
  name: "湖景大床房",
  bed_type: "KING",
  area_sqm: 35,
  max_guests: 2,
  cover_url: "https://cdn.example.com/rooms/lake-view.jpg",
  currency: "CNY",
  property: {
    id: IDS.property,
    type: "HOTEL",
    name: "西湖云栖酒店",
    city,
  },
  description: "面向西湖的宽敞客房。",
  booking_policy: "入住当日 18:00 前可免费取消。",
  nightly_prices: [nightlyPrice],
};

const acceptedHttpsResources = [
  "https://cdn.example.com",
  "https://cdn.example.com/images/photo.jpg?width=480&fit=cover#hero",
  "https://CDN-1.example.com:1/a%20b.jpg",
  "https://cdn.example.com:443/image.jpg",
  "https://cdn.example.com:65535/image.jpg?next=%2Fimages%2Fone.jpg",
];
const rejectedHttpsResources = [
  "https://user:pass@example.com/x",
  "https://例子.测试/image.jpg",
  "https://xn--fsqu00a.xn--0zwm56d/image.jpg",
  "https://[2001:db8::1]/image.jpg",
  "https://example.com./image.jpg",
  "https://example..com/image.jpg",
  "https://foo_bar.example/image.jpg",
  "https://-example.com/image.jpg",
  "https://example-.com/image.jpg",
  "https://127.0.0.1/image.jpg",
  "https://127.1/image.jpg",
  "https://0x7f.1/image.jpg",
  "https://0177.0.0.1/image.jpg",
  "https://2130706433/image.jpg",
  "https://example.com:/image.jpg",
  "https://example.com:0/image.jpg",
  "https://example.com:0443/image.jpg",
  "https://example.com:65536/image.jpg",
  "https://example.com:bad/image.jpg",
  "https://%",
  "https://%zz.example/x",
  "https://cdn.example.com/image%2.jpg",
  "https://cdn.example.com/image%GG.jpg",
  "https://cdn.example.com/image photo.jpg",
  "https://cdn.example.com/image\\photo.jpg",
  "https://cdn.example.com/image\nphoto.jpg",
];

function expectInvalid(callback) {
  expect(callback).toThrow(
    expect.objectContaining({
      code: "INVALID_API_RESPONSE",
      message: "Invalid API response",
    }),
  );
}

describe("catalog response contracts", () => {
  it("uses the same bounded city fields as the location contract", () => {
    const boundaryCity = {
      ...city,
      code: "c".repeat(32),
      name: "城".repeat(80),
    };

    expect(
      assertPropertyListResponse({
        items: [{ ...propertyListItem, city: boundaryCity }],
        next_cursor: null,
      }).items[0].city,
    ).toEqual(boundaryCity);
    for (const invalidCity of [
      { ...boundaryCity, code: "c".repeat(33) },
      { ...boundaryCity, name: "城".repeat(81) },
    ]) {
      expectInvalid(() =>
        assertPropertyListResponse({
          items: [{ ...propertyListItem, city: invalidCity }],
          next_cursor: null,
        }),
      );
    }
  });

  it("accepts and safely reconstructs the three exact public response shapes", () => {
    const listInput = {
      items: [{ ...propertyListItem, facility_highlights: [...propertyListItem.facility_highlights] }],
      next_cursor: null,
    };
    const propertyInput = {
      ...propertyDetail,
      city: { ...city },
      media: propertyDetail.media.map((item) => ({ ...item })),
      facilities: propertyDetail.facilities.map((item) => ({ ...item })),
      room_types: propertyDetail.room_types.map((item) => ({ ...item })),
    };
    const roomInput = {
      ...roomTypeDetail,
      property: {
        ...roomTypeDetail.property,
        city: { ...roomTypeDetail.property.city },
      },
      nightly_prices: roomTypeDetail.nightly_prices.map((item) => ({ ...item })),
    };

    const listResult = assertPropertyListResponse(listInput);
    const propertyResult = assertPropertyDetail(propertyInput);
    const roomResult = assertRoomTypeDetail(roomInput);

    expect(listResult).toEqual(listInput);
    expect(propertyResult).toEqual(propertyInput);
    expect(roomResult).toEqual(roomInput);
    expect(listResult).not.toBe(listInput);
    expect(listResult.items[0]).not.toBe(listInput.items[0]);
    expect(listResult.items[0].city).not.toBe(listInput.items[0].city);
    expect(propertyResult.media[0]).not.toBe(propertyInput.media[0]);
    expect(propertyResult.room_types[0]).not.toBe(propertyInput.room_types[0]);
    expect(roomResult.property).not.toBe(roomInput.property);
    expect(roomResult.nightly_prices[0]).not.toBe(roomInput.nightly_prices[0]);
  });

  it("accepts an empty bounded property room collection without weakening list availability", () => {
    expect(
      assertPropertyDetail({
        ...propertyDetail,
        room_types: [],
      }),
    ).toEqual({
      ...propertyDetail,
      room_types: [],
    });
    expectInvalid(() =>
      assertPropertyDetail({
        ...propertyDetail,
        room_types: Array.from({ length: 51 }, () => roomTypeSummary),
      }),
    );
    expectInvalid(() =>
      assertPropertyListResponse({
        items: [{ ...propertyListItem, available_room_type_count: 0 }],
        next_cursor: null,
      }),
    );
  });

  it("uses the Prisma facility code and name limits in details and highlights", () => {
    const exactCode = "c".repeat(64);
    const exactName = "设".repeat(80);
    expect(
      assertPropertyDetail({
        ...propertyDetail,
        facilities: [{ code: exactCode, name: exactName }],
      }),
    ).toMatchObject({
      facilities: [{ code: exactCode, name: exactName }],
    });
    expect(
      assertPropertyListResponse({
        items: [{ ...propertyListItem, facility_highlights: [exactName] }],
        next_cursor: null,
      }),
    ).toMatchObject({
      items: [{ facility_highlights: [exactName] }],
    });

    for (const facilities of [
      [{ code: "c".repeat(65), name: "设施" }],
      [{ code: "WIFI", name: "设".repeat(81) }],
    ]) {
      expectInvalid(() =>
        assertPropertyDetail({
          ...propertyDetail,
          facilities,
        }),
      );
    }
    expectInvalid(() =>
      assertPropertyListResponse({
        items: [
          {
            ...propertyListItem,
            facility_highlights: ["设".repeat(81)],
          },
        ],
        next_cursor: null,
      }),
    );
  });

  it.each(["HOSTEL", "", null])("rejects unknown property type %j", (type) => {
    expectInvalid(() =>
      assertPropertyListResponse({
        items: [{ ...propertyListItem, type }],
        next_cursor: null,
      }),
    );
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe cents value %j everywhere money appears",
    (cents) => {
      expectInvalid(() =>
        assertPropertyListResponse({
          items: [{ ...propertyListItem, from_nightly_price_cents: cents }],
          next_cursor: null,
        }),
      );
      expectInvalid(() =>
        assertPropertyDetail({
          ...propertyDetail,
          room_types: [{ ...roomTypeSummary, from_nightly_price_cents: cents }],
        }),
      );
      expectInvalid(() =>
        assertRoomTypeDetail({
          ...roomTypeDetail,
          nightly_prices: [{ ...nightlyPrice, sale_price_cents: cents }],
        }),
      );
      expectInvalid(() =>
        assertRoomTypeDetail({
          ...roomTypeDetail,
          nightly_prices: [{ ...nightlyPrice, rack_price_cents: cents }],
        }),
      );
    },
  );

  it("rejects non-CNY currency at every currency boundary", () => {
    expectInvalid(() =>
      assertPropertyListResponse({
        items: [{ ...propertyListItem, currency: "USD" }],
        next_cursor: null,
      }),
    );
    expectInvalid(() =>
      assertPropertyDetail({
        ...propertyDetail,
        room_types: [{ ...roomTypeSummary, currency: "USD" }],
      }),
    );
    expectInvalid(() =>
      assertRoomTypeDetail({
        ...roomTypeDetail,
        nightly_prices: [{ ...nightlyPrice, currency: "USD" }],
      }),
    );
    expectInvalid(() => assertRoomTypeDetail({ ...roomTypeDetail, currency: "USD" }));
  });

  it.each([
    "http://cdn.example.com/photo.jpg",
    "/assets/photo.jpg",
    "/images/",
    "/images/../secret.jpg",
  ])("rejects unsafe catalog resource %j", (resource) => {
    expectInvalid(() =>
      assertPropertyListResponse({
        items: [{ ...propertyListItem, cover_url: resource }],
        next_cursor: null,
      }),
    );
    expectInvalid(() =>
      assertPropertyDetail({
        ...propertyDetail,
        media: [{ ...propertyDetail.media[0], url: resource }],
      }),
    );
    expectInvalid(() => assertRoomTypeDetail({ ...roomTypeDetail, cover_url: resource }));
  });

  it.each(acceptedHttpsResources)(
    "accepts every planned HTTPS resource accepted by the shared schema: %j",
    (resource) => {
      expect(catalogResourceSchema.safeParse(resource).success).toBe(true);
      expect(
        assertPropertyListResponse({
          items: [{ ...propertyListItem, cover_url: resource }],
          next_cursor: null,
        }).items[0].cover_url,
      ).toBe(resource);
    },
  );

  it.each(rejectedHttpsResources)(
    "rejects every malformed HTTPS resource rejected by the shared schema: %j",
    (resource) => {
      expect(catalogResourceSchema.safeParse(resource).success).toBe(false);
      expectInvalid(() =>
        assertPropertyListResponse({
          items: [{ ...propertyListItem, cover_url: resource }],
          next_cursor: null,
        }),
      );
    },
  );

  it("bounds facility highlights, availability counts, cursors, and detail collections", () => {
    expectInvalid(() =>
      assertPropertyListResponse({
        items: [{ ...propertyListItem, facility_highlights: ["一", "二", "三", "四", "五"] }],
        next_cursor: null,
      }),
    );
    expectInvalid(() =>
      assertPropertyListResponse({
        items: [{ ...propertyListItem, available_room_type_count: 0 }],
        next_cursor: null,
      }),
    );
    expectInvalid(() =>
      assertPropertyListResponse({ items: [propertyListItem], next_cursor: "" }),
    );
    expectInvalid(() =>
      assertPropertyListResponse({
        items: [propertyListItem],
        next_cursor: "x".repeat(257),
      }),
    );
    for (const cursor of ["a/b", "a\\b", "//", "\ud800"]) {
      expect(
        propertyListResponseSchema.safeParse({
          items: [propertyListItem],
          next_cursor: cursor,
        }).success,
      ).toBe(false);
      expectInvalid(() =>
        assertPropertyListResponse({
          items: [propertyListItem],
          next_cursor: cursor,
        }),
      );
    }
    expectInvalid(() =>
      assertPropertyListResponse({
        items: Array.from({ length: 21 }, () => propertyListItem),
        next_cursor: null,
      }),
    );
    expectInvalid(() =>
      assertPropertyListResponse({
        items: [
          {
            ...propertyListItem,
            available_room_type_count: Number.MAX_SAFE_INTEGER + 1,
          },
        ],
        next_cursor: null,
      }),
    );
    for (const missing of ["media", "facilities", "room_types"]) {
      const malformed = { ...propertyDetail };
      delete malformed[missing];
      expectInvalid(() => assertPropertyDetail(malformed));
    }
  });

  it("matches the shared nonblank policy for every catalog display string", () => {
    const blankListItems = [
      { ...propertyListItem, name: " \t " },
      { ...propertyListItem, city: { ...city, code: "\n" } },
      { ...propertyListItem, city: { ...city, name: " " } },
      { ...propertyListItem, short_description: "\t" },
      { ...propertyListItem, facility_highlights: [" "] },
    ];
    for (const item of blankListItems) {
      const response = { items: [item], next_cursor: null };
      expect(propertyListResponseSchema.safeParse(response).success).toBe(false);
      expectInvalid(() => assertPropertyListResponse(response));
    }

    const blankPropertyDetails = [
      { ...propertyDetail, name: " " },
      { ...propertyDetail, address: "\t" },
      { ...propertyDetail, description: "\n" },
      { ...propertyDetail, policies: " " },
      { ...propertyDetail, media: [{ ...propertyDetail.media[0], alt: " " }] },
      { ...propertyDetail, facilities: [{ ...propertyDetail.facilities[0], code: "\t" }] },
      { ...propertyDetail, facilities: [{ ...propertyDetail.facilities[0], name: "\n" }] },
      { ...propertyDetail, room_types: [{ ...roomTypeSummary, name: " " }] },
      { ...propertyDetail, room_types: [{ ...roomTypeSummary, bed_type: "\t" }] },
      { ...propertyDetail, room_types: [{ ...roomTypeSummary, policy_summary: "\n" }] },
    ];
    for (const detail of blankPropertyDetails) {
      expect(propertyDetailSchema.safeParse(detail).success).toBe(false);
      expectInvalid(() => assertPropertyDetail(detail));
    }

    const blankRoomDetails = [
      { ...roomTypeDetail, name: " " },
      { ...roomTypeDetail, bed_type: "\t" },
      { ...roomTypeDetail, property: { ...roomTypeDetail.property, name: "\n" } },
      {
        ...roomTypeDetail,
        property: {
          ...roomTypeDetail.property,
          city: { ...city, code: " " },
        },
      },
      {
        ...roomTypeDetail,
        property: {
          ...roomTypeDetail.property,
          city: { ...city, name: "\t" },
        },
      },
      { ...roomTypeDetail, description: "\n" },
      { ...roomTypeDetail, booking_policy: " " },
    ];
    for (const detail of blankRoomDetails) {
      expect(roomTypeDetailSchema.safeParse(detail).success).toBe(false);
      expectInvalid(() => assertRoomTypeDetail(detail));
    }
  });

  it("requires one through thirty nightly prices in strict calendar order", () => {
    expectInvalid(() => assertRoomTypeDetail({ ...roomTypeDetail, nightly_prices: [] }));
    expectInvalid(() =>
      assertRoomTypeDetail({
        ...roomTypeDetail,
        nightly_prices: Array.from({ length: 31 }, (_, index) => ({
          ...nightlyPrice,
          business_date: `2026-08-${String(index + 1).padStart(2, "0")}`,
        })),
      }),
    );
    expectInvalid(() =>
      assertRoomTypeDetail({
        ...roomTypeDetail,
        nightly_prices: [
          { ...nightlyPrice, business_date: "2026-08-02" },
          { ...nightlyPrice, business_date: "2026-08-01" },
        ],
      }),
    );
    expectInvalid(() =>
      assertRoomTypeDetail({
        ...roomTypeDetail,
        nightly_prices: [
          nightlyPrice,
          { ...nightlyPrice },
        ],
      }),
    );
    expectInvalid(() =>
      assertRoomTypeDetail({
        ...roomTypeDetail,
        nightly_prices: [{ ...nightlyPrice, business_date: "2026-02-30" }],
      }),
    );
  });

  it("rejects unknown keys at every nesting level, including internal inventory fields", () => {
    const unknownCases = [
      () =>
        assertPropertyListResponse({
          items: [{ ...propertyListItem, total_inventory: 1 }],
          next_cursor: null,
        }),
      () =>
        assertPropertyListResponse({
          items: [{ ...propertyListItem, city: { ...city, version: 1 } }],
          next_cursor: null,
        }),
      () =>
        assertPropertyDetail({
          ...propertyDetail,
          media: [{ ...propertyDetail.media[0], held_inventory: 1 }],
        }),
      () =>
        assertPropertyDetail({
          ...propertyDetail,
          room_types: [{ ...roomTypeSummary, sold_inventory: 1 }],
        }),
      () =>
        assertRoomTypeDetail({
          ...roomTypeDetail,
          nightly_prices: [{ ...nightlyPrice, version: 1 }],
        }),
      () => assertRoomTypeDetail({ ...roomTypeDetail, total_inventory: 1 }),
    ];

    for (const invalid of unknownCases) {
      expectInvalid(invalid);
    }
  });
});

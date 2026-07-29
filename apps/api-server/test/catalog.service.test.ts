import type {
  PropertyDetail,
  PropertyListResponse,
  RoomTypeDetail,
} from "@stay-fable/api-contracts/catalog";
import { describe, expect, it, vi } from "vitest";

import type { Clock } from "../src/common/clock/clock.js";
import { BusinessException } from "../src/common/http/business.exception.js";
import type {
  CatalogPropertyDetailRow,
  CatalogRepository,
  CatalogRoomDetailRow,
} from "../src/catalog/catalog.repository.js";
import { encodeCatalogCursor } from "../src/catalog/catalog-cursor.js";
import { CatalogService } from "../src/catalog/catalog.service.js";

const CITY_ID = "10000000-0000-4000-8000-000000000001";
const PROPERTY_ID = "20000000-0000-4000-8000-000000000001";
const ROOM_ID = "30000000-0000-4000-8000-000000000001";
const NEXT_PROPERTY_ID = "20000000-0000-4000-8000-000000000002";
const query = {
  city_id: CITY_ID,
  checkin: "2026-07-30",
  checkout: "2026-08-01",
  guests: 2,
  page_size: 10,
};
const availability = {
  checkin: query.checkin,
  checkout: query.checkout,
  guests: query.guests,
};
const clock: Clock = { now: () => new Date("2026-07-29T04:00:00.000Z") };

const listRow = {
  id: PROPERTY_ID,
  type: "HOTEL" as const,
  name: "西湖云栖酒店",
  cityId: CITY_ID,
  cityCode: "330100",
  cityName: "杭州",
  coverUrl: "/images/catalog/hotel.jpg",
  shortDescription: "在西湖边住进一段安静时光。",
  displayOrder: 10,
  fromNightlyPriceCents: 42_800,
  availableRoomTypeCount: 2,
};

const propertyRow: CatalogPropertyDetailRow = {
  id: PROPERTY_ID,
  type: "HOTEL",
  name: "西湖云栖酒店",
  cityId: CITY_ID,
  cityCode: "330100",
  cityName: "杭州",
  address: "杭州市西湖区湖滨片区",
  description: "临近西湖的舒适酒店。",
  policies: "入住时请出示有效证件。",
  coverUrl: "/images/catalog/hotel.jpg",
  media: [{ type: "IMAGE", url: "/images/catalog/hotel-room.jpg", alt: "客房" }],
  facilities: [{ code: "WIFI", name: "无线网络" }],
  roomTypes: [
    {
      id: ROOM_ID,
      name: "舒适大床房",
      bedType: "1张1.8米大床",
      areaSqm: 28,
      maxGuests: 2,
      coverUrl: "/images/catalog/room.jpg",
      bookingPolicy: "到店前一天18:00前可免费取消。",
      fromNightlyPriceCents: 42_800,
    },
  ],
};

const roomRow: CatalogRoomDetailRow = {
  id: ROOM_ID,
  name: "舒适大床房",
  bedType: "1张1.8米大床",
  areaSqm: 28,
  maxGuests: 2,
  coverUrl: "/images/catalog/room.jpg",
  description: "配备独立卫浴和基础洗护用品。",
  bookingPolicy: "到店前一天18:00前可免费取消。",
  propertyId: PROPERTY_ID,
  propertyType: "HOTEL",
  propertyName: "西湖云栖酒店",
  cityId: CITY_ID,
  cityCode: "330100",
  cityName: "杭州",
  nightlyPrices: [
    { businessDate: "2026-07-30", salePriceCents: 42_800, rackPriceCents: 48_800 },
    { businessDate: "2026-07-31", salePriceCents: 43_800, rackPriceCents: 49_800 },
  ],
};

const createRepository = () => ({
  listProperties: vi.fn(),
  listFacilityHighlights: vi.fn(),
  findProperty: vi.fn(),
  findRoomType: vi.fn(),
});

describe("CatalogService", () => {
  it("maps property rows, facility defaults, and the next cursor to the shared response", async () => {
    const repository = createRepository();
    repository.listProperties.mockResolvedValue({
      rows: [listRow, { ...listRow, id: NEXT_PROPERTY_ID, displayOrder: 20 }],
      nextAfter: { displayOrder: 20, propertyId: NEXT_PROPERTY_ID },
    });
    repository.listFacilityHighlights.mockResolvedValue(
      new Map([[PROPERTY_ID, ["无线网络", "早餐"]]]),
    );
    const service = new CatalogService(repository as unknown as CatalogRepository, clock);

    const result: PropertyListResponse = await service.listProperties(query);

    expect(repository.listProperties).toHaveBeenCalledWith({
      cityId: CITY_ID,
      checkin: "2026-07-30",
      checkout: "2026-08-01",
      nights: 2,
      guests: 2,
      pageSize: 10,
    });
    expect(repository.listFacilityHighlights).toHaveBeenCalledWith([PROPERTY_ID, NEXT_PROPERTY_ID]);
    expect(result).toEqual({
      items: [
        {
          id: PROPERTY_ID,
          type: "HOTEL",
          name: "西湖云栖酒店",
          city: { id: CITY_ID, code: "330100", name: "杭州" },
          cover_url: "/images/catalog/hotel.jpg",
          short_description: "在西湖边住进一段安静时光。",
          facility_highlights: ["无线网络", "早餐"],
          from_nightly_price_cents: 42_800,
          currency: "CNY",
          available_room_type_count: 2,
        },
        {
          id: NEXT_PROPERTY_ID,
          type: "HOTEL",
          name: "西湖云栖酒店",
          city: { id: CITY_ID, code: "330100", name: "杭州" },
          cover_url: "/images/catalog/hotel.jpg",
          short_description: "在西湖边住进一段安静时光。",
          facility_highlights: [],
          from_nightly_price_cents: 42_800,
          currency: "CNY",
          available_room_type_count: 2,
        },
      ],
      next_cursor: encodeCatalogCursor({
        displayOrder: 20,
        propertyId: NEXT_PROPERTY_ID,
      }),
    });
  });

  it("passes optional filters, decoded cursor, and explicit page size exactly", async () => {
    const repository = createRepository();
    repository.listProperties.mockResolvedValue({ rows: [], nextAfter: null });
    const service = new CatalogService(repository as unknown as CatalogRepository, clock);
    const cursor = encodeCatalogCursor({ displayOrder: 10, propertyId: PROPERTY_ID });

    await service.listProperties({
      ...query,
      property_type: "HOMESTAY",
      page_size: 7,
      cursor,
    });

    expect(repository.listProperties).toHaveBeenCalledWith({
      cityId: CITY_ID,
      checkin: "2026-07-30",
      checkout: "2026-08-01",
      nights: 2,
      guests: 2,
      propertyType: "HOMESTAY",
      pageSize: 7,
      after: { displayOrder: 10, propertyId: PROPERTY_ID },
    });
    expect(repository.listFacilityHighlights).not.toHaveBeenCalled();
  });

  it.each([
    {
      query: { ...query, checkin: "2026-02-30" },
      code: "CATALOG_DATE_RANGE_INVALID",
    },
    {
      query: { ...query, cursor: "not-a-cursor" },
      code: "CATALOG_CURSOR_INVALID",
    },
  ])("rejects malformed dates or cursors before repository access", async ({ query, code }) => {
    const repository = createRepository();
    const service = new CatalogService(repository as unknown as CatalogRepository, clock);

    await expect(service.listProperties(query)).rejects.toMatchObject({ code });
    expect(repository.listProperties).not.toHaveBeenCalled();
    expect(repository.listFacilityHighlights).not.toHaveBeenCalled();
  });

  it("preserves the stable clock unavailable business error", async () => {
    const repository = createRepository();
    const service = new CatalogService(repository as unknown as CatalogRepository, {
      now: () => {
        throw new Error("clock failed");
      },
    });

    await expect(service.listProperties(query)).rejects.toMatchObject({
      code: "CATALOG_CLOCK_UNAVAILABLE",
      status: 503,
    });
    expect(repository.listProperties).not.toHaveBeenCalled();
  });

  it("maps property details and room policy summaries without inventory fields", async () => {
    const repository = createRepository();
    repository.findProperty.mockResolvedValue(propertyRow);
    const service = new CatalogService(repository as unknown as CatalogRepository, clock);

    const result: PropertyDetail = await service.getProperty(PROPERTY_ID, availability);

    expect(repository.findProperty).toHaveBeenCalledWith(PROPERTY_ID, {
      checkin: "2026-07-30",
      checkout: "2026-08-01",
      nights: 2,
      guests: 2,
    });
    expect(result).toEqual({
      id: PROPERTY_ID,
      type: "HOTEL",
      name: "西湖云栖酒店",
      city: { id: CITY_ID, code: "330100", name: "杭州" },
      address: "杭州市西湖区湖滨片区",
      description: "临近西湖的舒适酒店。",
      policies: "入住时请出示有效证件。",
      cover_url: "/images/catalog/hotel.jpg",
      media: [{ type: "IMAGE", url: "/images/catalog/hotel-room.jpg", alt: "客房" }],
      facilities: [{ code: "WIFI", name: "无线网络" }],
      room_types: [
        {
          id: ROOM_ID,
          name: "舒适大床房",
          bed_type: "1张1.8米大床",
          area_sqm: 28,
          max_guests: 2,
          cover_url: "/images/catalog/room.jpg",
          policy_summary: "到店前一天18:00前可免费取消。",
          from_nightly_price_cents: 42_800,
          currency: "CNY",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/inventory|held|sold/);
  });

  it("maps a repository property with no currently available room summaries", async () => {
    const repository = createRepository();
    repository.findProperty.mockResolvedValue({ ...propertyRow, roomTypes: [] });
    const service = new CatalogService(repository as unknown as CatalogRepository, clock);

    await expect(service.getProperty(PROPERTY_ID, availability)).resolves.toEqual({
      id: PROPERTY_ID,
      type: "HOTEL",
      name: "西湖云栖酒店",
      city: { id: CITY_ID, code: "330100", name: "杭州" },
      address: "杭州市西湖区湖滨片区",
      description: "临近西湖的舒适酒店。",
      policies: "入住时请出示有效证件。",
      cover_url: "/images/catalog/hotel.jpg",
      media: [{ type: "IMAGE", url: "/images/catalog/hotel-room.jpg", alt: "客房" }],
      facilities: [{ code: "WIFI", name: "无线网络" }],
      room_types: [],
    });
  });

  it("returns a stable property-not-available error for a missing property", async () => {
    const repository = createRepository();
    repository.findProperty.mockResolvedValue(null);
    const service = new CatalogService(repository as unknown as CatalogRepository, clock);

    await expect(service.getProperty(PROPERTY_ID, availability)).rejects.toEqual(
      expect.objectContaining({
        code: "PROPERTY_NOT_AVAILABLE",
        status: 404,
        message: "住宿当前不可预订",
      }),
    );
  });

  it("maps room details and every nightly currency without inventory fields", async () => {
    const repository = createRepository();
    repository.findRoomType.mockResolvedValue({ status: "AVAILABLE", room: roomRow });
    const service = new CatalogService(repository as unknown as CatalogRepository, clock);

    const result: RoomTypeDetail = await service.getRoomType(ROOM_ID, availability);

    expect(repository.findRoomType).toHaveBeenCalledWith(ROOM_ID, {
      checkin: "2026-07-30",
      checkout: "2026-08-01",
      nights: 2,
      guests: 2,
    });
    expect(result).toEqual({
      id: ROOM_ID,
      name: "舒适大床房",
      bed_type: "1张1.8米大床",
      area_sqm: 28,
      max_guests: 2,
      cover_url: "/images/catalog/room.jpg",
      currency: "CNY",
      property: {
        id: PROPERTY_ID,
        type: "HOTEL",
        name: "西湖云栖酒店",
        city: { id: CITY_ID, code: "330100", name: "杭州" },
      },
      description: "配备独立卫浴和基础洗护用品。",
      booking_policy: "到店前一天18:00前可免费取消。",
      nightly_prices: [
        {
          business_date: "2026-07-30",
          sale_price_cents: 42_800,
          rack_price_cents: 48_800,
          currency: "CNY",
        },
        {
          business_date: "2026-07-31",
          sale_price_cents: 43_800,
          rack_price_cents: 49_800,
          currency: "CNY",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/inventory|held|sold/);
  });

  it.each([
    {
      lookup: { status: "CAPACITY_EXCEEDED" },
      error: { status: 422, code: "ROOM_CAPACITY_EXCEEDED", message: "入住人数超过房型容量" },
    },
    {
      lookup: { status: "NOT_AVAILABLE" },
      error: { status: 404, code: "ROOM_NOT_AVAILABLE", message: "房型当前不可预订" },
    },
  ] as const)("maps room lookup failures to stable business errors", async ({ lookup, error }) => {
    const repository = createRepository();
    repository.findRoomType.mockResolvedValue(lookup);
    const service = new CatalogService(repository as unknown as CatalogRepository, clock);

    await expect(service.getRoomType(ROOM_ID, availability)).rejects.toEqual(
      expect.objectContaining(error),
    );
  });

  it("propagates unexpected repository failures", async () => {
    const repository = createRepository();
    const databaseError = new Error("database unavailable");
    repository.listProperties.mockRejectedValue(databaseError);
    const service = new CatalogService(repository as unknown as CatalogRepository, clock);

    await expect(service.listProperties(query)).rejects.toBe(databaseError);
  });

  it("rejects malformed repository rows through shared output validation", async () => {
    const repository = createRepository();
    repository.findProperty.mockResolvedValue({ ...propertyRow, name: "" });
    const service = new CatalogService(repository as unknown as CatalogRepository, clock);

    await expect(service.getProperty(PROPERTY_ID, availability)).rejects.not.toBeInstanceOf(
      BusinessException,
    );
  });

  it.each([
    { facilities: [{ code: "c".repeat(65), name: "设施" }] },
    { facilities: [{ code: "WIFI", name: "设".repeat(81) }] },
  ])("rejects repository facilities beyond Prisma text limits", async ({ facilities }) => {
    const repository = createRepository();
    repository.findProperty.mockResolvedValue({ ...propertyRow, facilities });
    const service = new CatalogService(repository as unknown as CatalogRepository, clock);

    await expect(service.getProperty(PROPERTY_ID, availability)).rejects.not.toBeInstanceOf(
      BusinessException,
    );
  });
});

import { describe, expect, it, vi } from "vitest";

import catalogModule from "../services/catalog.js";

const { createCatalogService } = catalogModule;

const IDS = {
  city: "10000000-0000-4000-8000-000000000001",
  property: "20000000-0000-4000-8000-000000000002",
  roomType: "30000000-0000-4000-8000-000000000003",
};
const availability = {
  checkin: "2026-07-30",
  checkout: "2026-08-01",
  guests: 2,
};
const city = { id: IDS.city, code: "330100", name: "杭州" };
const listResponse = {
  items: [
    {
      id: IDS.property,
      type: "HOTEL",
      name: "西湖云栖酒店",
      city,
      cover_url: "/images/properties/xihu.jpg",
      short_description: "湖景步行可达",
      facility_highlights: ["免费停车"],
      from_nightly_price_cents: 59900,
      currency: "CNY",
      available_room_type_count: 1,
    },
  ],
  next_cursor: null,
};
const roomSummary = {
  id: IDS.roomType,
  name: "湖景大床房",
  bed_type: "KING",
  area_sqm: 35,
  max_guests: 2,
  cover_url: "/images/rooms/lake.jpg",
  policy_summary: "入住当日 18:00 前可免费取消",
  from_nightly_price_cents: 59900,
  currency: "CNY",
};
const propertyDetail = {
  id: IDS.property,
  type: "HOTEL",
  name: "西湖云栖酒店",
  city,
  address: "杭州市西湖区",
  description: "临近西湖的精品酒店。",
  policies: "14:00 后入住。",
  cover_url: "/images/properties/xihu.jpg",
  media: [],
  facilities: [],
  room_types: [roomSummary],
};
const roomDetail = {
  id: IDS.roomType,
  name: "湖景大床房",
  bed_type: "KING",
  area_sqm: 35,
  max_guests: 2,
  cover_url: "/images/rooms/lake.jpg",
  currency: "CNY",
  property: {
    id: IDS.property,
    type: "HOTEL",
    name: "西湖云栖酒店",
    city,
  },
  description: "面向西湖的宽敞客房。",
  booking_policy: "入住当日 18:00 前可免费取消。",
  nightly_prices: [
    {
      business_date: "2026-07-30",
      sale_price_cents: 59900,
      rack_price_cents: 69900,
      currency: "CNY",
    },
  ],
};

function createService(response) {
  const requestClient = { get: vi.fn(async () => response) };
  return {
    requestClient,
    service: createCatalogService(requestClient),
  };
}

describe("catalog service", () => {
  it("builds the property-list query in a fixed order and validates the response", async () => {
    const { requestClient, service } = createService(listResponse);

    await expect(
      service.listProperties({
        city_id: IDS.city,
        ...availability,
        property_type: "HOTEL",
        page_size: 10,
        cursor: "cursor 1/+",
      }),
    ).resolves.toEqual(listResponse);

    expect(requestClient.get).toHaveBeenCalledWith(
      "/properties?city_id=10000000-0000-4000-8000-000000000001&checkin=2026-07-30&checkout=2026-08-01&guests=2&property_type=HOTEL&page_size=10&cursor=cursor%201%2F%2B",
    );
  });

  it("omits optional list query fields without inventing client defaults", async () => {
    const { requestClient, service } = createService({ items: [], next_cursor: null });

    await service.listProperties({ city_id: IDS.city, ...availability });

    expect(requestClient.get).toHaveBeenCalledWith(
      "/properties?city_id=10000000-0000-4000-8000-000000000001&checkin=2026-07-30&checkout=2026-08-01&guests=2",
    );
  });

  it("keeps detail identifiers in the path and availability only in the API query", async () => {
    const property = createService(propertyDetail);
    const room = createService(roomDetail);

    await expect(
      property.service.getProperty(IDS.property, availability),
    ).resolves.toEqual(propertyDetail);
    await expect(room.service.getRoomType(IDS.roomType, availability)).resolves.toEqual(roomDetail);

    expect(property.requestClient.get).toHaveBeenCalledWith(
      `/properties/${IDS.property}?checkin=2026-07-30&checkout=2026-08-01&guests=2`,
    );
    expect(room.requestClient.get).toHaveBeenCalledWith(
      `/room-types/${IDS.roomType}?checkin=2026-07-30&checkout=2026-08-01&guests=2`,
    );
  });

  it.each([
    [{ ...availability, city_id: "not-a-uuid" }],
    [{ ...availability, city_id: IDS.city, checkin: "2026-7-30" }],
    [{ ...availability, city_id: IDS.city, checkin: "2026-02-30" }],
    [{ ...availability, city_id: IDS.city, checkout: "2026-07-30" }],
    [{ ...availability, city_id: IDS.city, checkout: "2026-08-30" }],
    [{ ...availability, city_id: IDS.city, guests: 0 }],
    [{ ...availability, city_id: IDS.city, guests: 1.5 }],
    [{ ...availability, city_id: IDS.city, property_type: "HOSTEL" }],
    [{ ...availability, city_id: IDS.city, page_size: 0 }],
    [{ ...availability, city_id: IDS.city, page_size: 21 }],
    [{ ...availability, city_id: IDS.city, cursor: "" }],
    [{ ...availability, city_id: IDS.city, cursor: "x".repeat(257) }],
    [{ ...availability, city_id: IDS.city, token: "must-not-enter-url" }],
  ])("rejects invalid list input before requesting: %j", async (query) => {
    const { requestClient, service } = createService(listResponse);

    await expect(service.listProperties(query)).rejects.toMatchObject({
      code: "INVALID_CATALOG_INPUT",
      message: "Invalid catalog input",
    });
    expect(requestClient.get).not.toHaveBeenCalled();
  });

  it.each([
    ["not-a-uuid", availability],
    [IDS.property, { ...availability, checkin: "2026-02-30" }],
    [IDS.property, { ...availability, guests: 11 }],
    [IDS.property, { ...availability, session_token: "secret" }],
  ])("rejects invalid property detail input before requesting", async (propertyId, query) => {
    const { requestClient, service } = createService(propertyDetail);

    await expect(service.getProperty(propertyId, query)).rejects.toMatchObject({
      code: "INVALID_CATALOG_INPUT",
    });
    expect(requestClient.get).not.toHaveBeenCalled();
  });

  it.each([
    ["not-a-uuid", availability],
    [IDS.roomType, { ...availability, checkout: "2026-02-30" }],
    [IDS.roomType, { ...availability, checkout: availability.checkin }],
    [IDS.roomType, { ...availability, checkout: "2026-08-30" }],
    [IDS.roomType, { ...availability, guests: 0 }],
    [IDS.roomType, { ...availability, guests: 1.5 }],
    [IDS.roomType, { ...availability, access_token: "must-not-enter-url" }],
  ])("rejects invalid room detail input before requesting", async (roomTypeId, query) => {
    const { requestClient, service } = createService(roomDetail);

    await expect(service.getRoomType(roomTypeId, query)).rejects.toMatchObject({
      code: "INVALID_CATALOG_INPUT",
      message: "Invalid catalog input",
    });
    expect(requestClient.get).not.toHaveBeenCalled();
  });

  it("validates each API response after the request", async () => {
    const malformedList = createService({
      ...listResponse,
      items: [{ ...listResponse.items[0], total_inventory: 1 }],
    });
    const malformedProperty = createService({
      ...propertyDetail,
      room_types: [{ ...roomSummary, currency: "USD" }],
    });
    const malformedRoom = createService({
      ...roomDetail,
      nightly_prices: [{ ...roomDetail.nightly_prices[0], version: 1 }],
    });

    await expect(
      malformedList.service.listProperties({ city_id: IDS.city, ...availability }),
    ).rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });
    await expect(
      malformedProperty.service.getProperty(IDS.property, availability),
    ).rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });
    await expect(
      malformedRoom.service.getRoomType(IDS.roomType, availability),
    ).rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });
  });
});

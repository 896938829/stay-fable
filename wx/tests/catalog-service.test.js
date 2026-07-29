import { describe, expect, it, vi } from "vitest";

import catalogModule from "../services/catalog.js";
import requestModule from "../services/request.js";

const { createCatalogService } = catalogModule;
const { createRequestClient } = requestModule;

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
    {
      business_date: "2026-07-31",
      sale_price_cents: 62900,
      rack_price_cents: 72900,
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
        cursor: "cursor_1-abc",
      }),
    ).resolves.toEqual(listResponse);

    expect(requestClient.get).toHaveBeenCalledWith(
      "/properties?city_id=10000000-0000-4000-8000-000000000001&checkin=2026-07-30&checkout=2026-08-01&guests=2&property_type=HOTEL&page_size=10&cursor=cursor_1-abc",
    );
  });

  it("snapshots every list query field with a single read", async () => {
    const reads = {};
    const query = {};
    const values = {
      city_id: IDS.city,
      checkin: availability.checkin,
      checkout: availability.checkout,
      guests: availability.guests,
      property_type: "HOTEL",
      page_size: 10,
      cursor: "cursor_1-abc",
    };
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(query, key, {
        enumerable: true,
        get() {
          reads[key] = (reads[key] || 0) + 1;
          return reads[key] === 1 ? value : null;
        },
      });
    }
    const { requestClient, service } = createService(listResponse);

    await expect(service.listProperties(query)).resolves.toEqual(listResponse);

    expect(reads).toEqual({
      city_id: 1,
      checkin: 1,
      checkout: 1,
      guests: 1,
      property_type: 1,
      page_size: 1,
      cursor: 1,
    });
    expect(requestClient.get).toHaveBeenCalledWith(
      "/properties?city_id=10000000-0000-4000-8000-000000000001&checkin=2026-07-30&checkout=2026-08-01&guests=2&property_type=HOTEL&page_size=10&cursor=cursor_1-abc",
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

  it("binds a deferred room response to the availability snapshot sent in the request", async () => {
    const pending = deferred();
    const requestClient = { get: vi.fn(() => pending.promise) };
    const service = createCatalogService(requestClient);
    const mutableAvailability = { ...availability };

    const result = service.getRoomType(IDS.roomType, mutableAvailability);
    mutableAvailability.guests = 3;
    pending.resolve(roomDetail);

    await expect(result).resolves.toEqual(roomDetail);
    expect(requestClient.get).toHaveBeenCalledWith(
      `/room-types/${IDS.roomType}?checkin=2026-07-30&checkout=2026-08-01&guests=2`,
    );
  });

  it("reads changing detail availability getters only once", async () => {
    const reads = {};
    const changingAvailability = {};
    for (const [key, value] of Object.entries(availability)) {
      Object.defineProperty(changingAvailability, key, {
        enumerable: true,
        get() {
          reads[key] = (reads[key] || 0) + 1;
          return reads[key] === 1 ? value : null;
        },
      });
    }
    const { requestClient, service } = createService(roomDetail);

    await expect(
      service.getRoomType(IDS.roomType, changingAvailability),
    ).resolves.toEqual(roomDetail);

    expect(reads).toEqual({ checkin: 1, checkout: 1, guests: 1 });
    expect(requestClient.get).toHaveBeenCalledWith(
      `/room-types/${IDS.roomType}?checkin=2026-07-30&checkout=2026-08-01&guests=2`,
    );
  });

  it("maps a throwing availability getter to stable input rejection without requesting", async () => {
    const hostileAvailability = {
      checkout: availability.checkout,
      guests: availability.guests,
    };
    Object.defineProperty(hostileAvailability, "checkin", {
      enumerable: true,
      get() {
        throw new Error("hostile getter");
      },
    });
    const { requestClient, service } = createService(roomDetail);

    await expect(
      service.getRoomType(IDS.roomType, hostileAvailability),
    ).rejects.toMatchObject({
      code: "INVALID_CATALOG_INPUT",
      message: "Invalid catalog input",
    });
    expect(requestClient.get).not.toHaveBeenCalled();
  });

  it("accepts an empty property room collection from the real catalog service", async () => {
    const emptyProperty = {
      ...propertyDetail,
      room_types: [],
    };
    const { requestClient, service } = createService(emptyProperty);

    await expect(
      service.getProperty(IDS.property, availability),
    ).resolves.toEqual(emptyProperty);
    expect(requestClient.get).toHaveBeenCalledOnce();
  });

  it("rejects detail payloads whose resource id does not match the requested path", async () => {
    const otherPropertyId = "20000000-0000-4000-8000-000000000004";
    const otherRoomId = "30000000-0000-4000-8000-000000000005";
    const property = createService({ ...propertyDetail, id: otherPropertyId });
    const room = createService({ ...roomDetail, id: otherRoomId });

    await expect(
      property.service.getProperty(IDS.property, availability),
    ).rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });
    await expect(
      room.service.getRoomType(IDS.roomType, availability),
    ).rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });
  });

  it("rejects a property room summary that cannot hold the requested guests", async () => {
    const { service } = createService({
      ...propertyDetail,
      room_types: [{ ...roomSummary, max_guests: availability.guests - 1 }],
    });

    await expect(
      service.getProperty(IDS.property, availability),
    ).rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });
  });

  it.each([
    {
      name: "missing night",
      response: {
        ...roomDetail,
        nightly_prices: roomDetail.nightly_prices.slice(0, 1),
      },
    },
    {
      name: "extra night",
      response: {
        ...roomDetail,
        nightly_prices: [
          ...roomDetail.nightly_prices,
          {
            business_date: "2026-08-01",
            sale_price_cents: 63900,
            rack_price_cents: 73900,
            currency: "CNY",
          },
        ],
      },
    },
    {
      name: "skipped night",
      response: {
        ...roomDetail,
        nightly_prices: [
          roomDetail.nightly_prices[0],
          {
            ...roomDetail.nightly_prices[1],
            business_date: "2026-08-01",
          },
        ],
      },
    },
    {
      name: "capacity mismatch",
      response: {
        ...roomDetail,
        max_guests: availability.guests - 1,
      },
    },
  ])("rejects room availability mismatch: $name", async ({ response }) => {
    const { service } = createService(response);

    await expect(
      service.getRoomType(IDS.roomType, availability),
    ).rejects.toMatchObject({
      code: "INVALID_API_RESPONSE",
      message: "Invalid API response",
    });
  });

  it("keeps validating the nested room property relationship structurally", async () => {
    const { service } = createService({
      ...roomDetail,
      property: { ...roomDetail.property, id: "not-a-uuid" },
    });

    await expect(
      service.getRoomType(IDS.roomType, availability),
    ).rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });
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
    [{ ...availability, city_id: IDS.city, cursor: "a/b" }],
    [{ ...availability, city_id: IDS.city, cursor: "a\\b" }],
    [{ ...availability, city_id: IDS.city, cursor: "//" }],
    [{ ...availability, city_id: IDS.city, cursor: "\ud800" }],
    [{ ...availability, city_id: IDS.city, token: "must-not-enter-url" }],
  ])("rejects invalid list input before requesting: %j", async (query) => {
    const { requestClient, service } = createService(listResponse);

    await expect(service.listProperties(query)).rejects.toMatchObject({
      code: "INVALID_CATALOG_INPUT",
      message: "Invalid catalog input",
    });
    expect(requestClient.get).not.toHaveBeenCalled();
  });

  it("rejects non-canonical uppercase UUID inputs before requesting", async () => {
    const list = createService(listResponse);
    const property = createService(propertyDetail);
    const room = createService(roomDetail);

    await expect(
      list.service.listProperties({
        city_id: "10000000-0000-4000-8000-00000000000A",
        ...availability,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CATALOG_INPUT" });
    await expect(
      property.service.getProperty(
        "20000000-0000-4000-8000-00000000000A",
        availability,
      ),
    ).rejects.toMatchObject({ code: "INVALID_CATALOG_INPUT" });
    await expect(
      room.service.getRoomType(
        "30000000-0000-4000-8000-00000000000A",
        availability,
      ),
    ).rejects.toMatchObject({ code: "INVALID_CATALOG_INPUT" });
    expect(list.requestClient.get).not.toHaveBeenCalled();
    expect(property.requestClient.get).not.toHaveBeenCalled();
    expect(room.requestClient.get).not.toHaveBeenCalled();
  });

  it("rejects a response larger than the requested page before returning data", async () => {
    const { requestClient, service } = createService({
      items: [listResponse.items[0], { ...listResponse.items[0] }],
      next_cursor: null,
    });

    await expect(
      service.listProperties({
        city_id: IDS.city,
        ...availability,
        page_size: 1,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_API_RESPONSE",
      message: "Invalid API response",
    });
    expect(requestClient.get).toHaveBeenCalledOnce();
  });

  it("binds a deferred list response to the page-size snapshot sent in the request", async () => {
    const pending = deferred();
    const requestClient = { get: vi.fn(() => pending.promise) };
    const service = createCatalogService(requestClient);
    const query = {
      city_id: IDS.city,
      ...availability,
      page_size: 2,
    };

    const result = service.listProperties(query);
    query.page_size = 1;
    pending.resolve({
      items: [listResponse.items[0], { ...listResponse.items[0] }],
      next_cursor: null,
    });

    await expect(result).resolves.toMatchObject({ items: expect.any(Array) });
    expect(requestClient.get).toHaveBeenCalledWith(
      "/properties?city_id=10000000-0000-4000-8000-000000000001&checkin=2026-07-30&checkout=2026-08-01&guests=2&page_size=2",
    );
  });

  it("reuses a server cursor through the real request client and safe path validation", async () => {
    const cursor = "eyJ2IjoxLCJkIjoxMCwiaWQiOiJwcm9wZXJ0eSJ9";
    const urls = [];
    const wxRequest = vi.fn((options) => {
      urls.push(options.url);
      options.success({
        statusCode: 200,
        data: {
          data:
            urls.length === 1
              ? { ...listResponse, next_cursor: cursor }
              : { items: [], next_cursor: null },
          request_id: `req_server_${urls.length}`,
        },
      });
    });
    let requestId = 0;
    const requestClient = createRequestClient({
      wxApi: { request: wxRequest },
      getRuntimeConfig: () => ({
        apiBaseUrl: "https://api.example.com/api/v1",
        envVersion: "trial",
      }),
      getSession: () => null,
      refreshSession: async () => undefined,
      reauthenticate: async () => undefined,
      createRequestId: () => `req_client_${++requestId}`,
    });
    const service = createCatalogService(requestClient);
    const firstPage = await service.listProperties({
      city_id: IDS.city,
      ...availability,
      page_size: 1,
    });
    await expect(
      service.listProperties({
        city_id: IDS.city,
        ...availability,
        page_size: 1,
        cursor: firstPage.next_cursor,
      }),
    ).resolves.toEqual({ items: [], next_cursor: null });

    expect(urls).toEqual([
      "https://api.example.com/api/v1/properties?city_id=10000000-0000-4000-8000-000000000001&checkin=2026-07-30&checkout=2026-08-01&guests=2&page_size=1",
      `https://api.example.com/api/v1/properties?city_id=10000000-0000-4000-8000-000000000001&checkin=2026-07-30&checkout=2026-08-01&guests=2&page_size=1&cursor=${cursor}`,
    ]);
    expect(wxRequest).toHaveBeenCalledTimes(2);
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

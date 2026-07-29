import assert from "node:assert/strict";
import { pathToFileURL, URLSearchParams } from "node:url";

const search = {
  city_id: "10000000-0000-4000-8000-000000000001",
  checkin: "2026-07-30",
  checkout: "2026-08-01",
  guests: 1,
};
const internalInventoryFields = ["total_inventory", "held_inventory", "sold_inventory", "version"];

function endpoint(baseUrl, path, query) {
  const url = new URL(`/api/v1${path}`, `${baseUrl.replace(/\/+$/, "")}/`);
  if (query !== undefined) {
    url.search = new URLSearchParams(
      Object.entries(query).map(([key, value]) => [key, String(value)]),
    ).toString();
  }
  return url.toString();
}

async function requestJson(fetchImplementation, baseUrl, path, options, expectedStatus, query) {
  const response = await fetchImplementation(endpoint(baseUrl, path, query), {
    ...options,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...options?.headers,
    },
  });
  const body = await response.json();

  assert.equal(
    response.status,
    expectedStatus,
    `${options?.method || "GET"} ${path} returned HTTP ${response.status}`,
  );
  assert.equal(body?.error?.code, undefined, `response contained error code ${body?.error?.code}`);
  assert.notEqual(body?.data, undefined, `${options?.method || "GET"} ${path} omitted data`);
  return body.data;
}

function bearer(accessToken) {
  return { authorization: `Bearer ${accessToken}` };
}

function assertNoRoomCollections(items) {
  for (const item of items) {
    for (const field of ["room_types", "rooms"]) {
      assert.equal(
        Object.hasOwn(item, field),
        false,
        `property list leaked room collection ${field}`,
      );
    }
  }
}

function findObjectKey(value, expectedKey) {
  if (value === null || typeof value !== "object") {
    return false;
  }
  if (Object.hasOwn(value, expectedKey)) {
    return true;
  }
  return Object.values(value).some((nested) => findObjectKey(nested, expectedKey));
}

function assertUniquePropertyIds(items) {
  const ids = items.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length, "cursor pages contained a duplicate property ID");
}

export async function verifySliceTwoRuntime(options = {}) {
  const baseUrl = options.baseUrl || process.env.API_BASE_URL;
  const fetchImplementation = options.fetch || globalThis.fetch;
  const log = options.log || console.log;

  assert.equal(typeof baseUrl, "string", "API_BASE_URL is required");
  assert.equal(typeof fetchImplementation, "function", "fetch is required");

  const session = await requestJson(
    fetchImplementation,
    baseUrl,
    "/auth/wechat/login",
    {
      method: "POST",
      body: JSON.stringify({ code: "mock:slice-2-runtime-catalog" }),
    },
    201,
  );
  assert.equal(typeof session.access_token, "string", "login omitted access token");
  const authenticated = { headers: bearer(session.access_token) };

  const hangzhou = await requestJson(
    fetchImplementation,
    baseUrl,
    "/properties",
    authenticated,
    200,
    search,
  );
  assert.equal(hangzhou.items.length, 3, "Hangzhou did not return exactly three properties");
  assert.ok(
    hangzhou.items.every((item) => item.city?.id === search.city_id && item.city?.name === "杭州"),
    "Hangzhou list contained a property from another city",
  );
  assertNoRoomCollections(hangzhou.items);
  log("catalog validation: pass - Hangzhou properties");

  const homestays = await requestJson(
    fetchImplementation,
    baseUrl,
    "/properties",
    authenticated,
    200,
    { ...search, property_type: "HOMESTAY" },
  );
  assert.equal(homestays.items.length, 1, "HOMESTAY filter did not return exactly one property");
  assert.ok(
    homestays.items.every(({ type }) => type === "HOMESTAY"),
    "HOMESTAY filter returned another property type",
  );
  assertNoRoomCollections(homestays.items);
  log("catalog validation: pass - property type filter");

  const capacityProperty = await requestJson(
    fetchImplementation,
    baseUrl,
    `/properties/${hangzhou.items[0].id}`,
    authenticated,
    200,
    { checkin: search.checkin, checkout: search.checkout, guests: 3 },
  );
  assert.ok(
    capacityProperty.room_types.length > 0 &&
      capacityProperty.room_types.every(({ max_guests: maxGuests }) => maxGuests >= 3),
    "guests=3 returned a room type below the requested capacity",
  );
  log("catalog validation: pass - guest capacity");

  const firstPage = await requestJson(
    fetchImplementation,
    baseUrl,
    "/properties",
    authenticated,
    200,
    { ...search, page_size: 2 },
  );
  assert.equal(firstPage.items.length, 2, "first page did not honor page_size=2");
  assert.equal(typeof firstPage.next_cursor, "string", "first page omitted next_cursor");
  const secondPage = await requestJson(
    fetchImplementation,
    baseUrl,
    "/properties",
    authenticated,
    200,
    { ...search, page_size: 2, cursor: firstPage.next_cursor },
  );
  const pagedProperties = [...firstPage.items, ...secondPage.items];
  assert.equal(pagedProperties.length, 3, "two catalog pages did not contain three properties");
  assert.equal(secondPage.next_cursor, null, "second page unexpectedly returned another cursor");
  assertUniquePropertyIds(pagedProperties);
  assertNoRoomCollections(pagedProperties);
  log("catalog validation: pass - cursor pagination");

  const propertyDetail = await requestJson(
    fetchImplementation,
    baseUrl,
    `/properties/${hangzhou.items[0].id}`,
    authenticated,
    200,
    { checkin: search.checkin, checkout: search.checkout, guests: search.guests },
  );
  assert.equal(propertyDetail.room_types.length, 2, "guests=1 property detail omitted a room type");
  log("catalog validation: pass - property room types");

  const roomDetail = await requestJson(
    fetchImplementation,
    baseUrl,
    `/room-types/${propertyDetail.room_types[0].id}`,
    authenticated,
    200,
    { checkin: search.checkin, checkout: search.checkout, guests: search.guests },
  );
  for (const field of internalInventoryFields) {
    assert.equal(findObjectKey(roomDetail, field), false, `room detail leaked ${field}`);
  }
  log("catalog validation: pass - room inventory redaction");
}

const isCli =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isCli) {
  await verifySliceTwoRuntime();
}

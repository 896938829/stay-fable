import assert from "node:assert/strict";
import { clearTimeout, setTimeout } from "node:timers";
import { pathToFileURL, URLSearchParams } from "node:url";

const search = {
  city_id: "10000000-0000-4000-8000-000000000001",
  checkin: "2026-07-30",
  checkout: "2026-08-01",
  guests: 1,
};
const expectedHangzhouProperties = [
  { id: "20000000-0000-4000-8000-000000000001", type: "HOTEL" },
  { id: "20000000-0000-4000-8000-000000000002", type: "HOMESTAY" },
  { id: "20000000-0000-4000-8000-000000000003", type: "FARM_STAY" },
];
const internalInventoryFields = ["total_inventory", "held_inventory", "sold_inventory", "version"];
const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function withTimeout(operation, timeoutMs, message) {
  let timeout;
  const timeoutFailure = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([operation, timeoutFailure]);
  } finally {
    clearTimeout(timeout);
  }
}

function endpoint(baseUrl, path, query) {
  const url = new URL(`/api/v1${path}`, `${baseUrl.replace(/\/+$/, "")}/`);
  if (query !== undefined) {
    url.search = new URLSearchParams(
      Object.entries(query).map(([key, value]) => [key, String(value)]),
    ).toString();
  }
  return url.toString();
}

async function requestJson(
  fetchImplementation,
  baseUrl,
  path,
  options,
  expectedStatus,
  query,
  timeoutMs,
) {
  const signal = globalThis.AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await withTimeout(
      fetchImplementation(endpoint(baseUrl, path, query), {
        ...options,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...options?.headers,
        },
        signal,
      }),
      timeoutMs,
      "catalog fetch timed out",
    );
  } catch (error) {
    if (signal.aborted) {
      throw new Error("catalog fetch timed out", { cause: error });
    }
    throw error;
  }
  const body = await withTimeout(response.json(), timeoutMs, "catalog response JSON timed out");

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

function assertUuidV4(value, label) {
  assert.equal(typeof value, "string", `${label} must be a UUID v4`);
  assert.match(value, uuidV4Pattern, `${label} must be a UUID v4`);
  return value;
}

export async function verifySliceTwoRuntime(options = {}) {
  const baseUrl = options.baseUrl || process.env.API_BASE_URL;
  const fetchImplementation = options.fetch || globalThis.fetch;
  const log = options.log || console.log;
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;

  assert.equal(typeof baseUrl, "string", "API_BASE_URL is required");
  assert.equal(typeof fetchImplementation, "function", "fetch is required");
  assert.ok(
    Number.isInteger(requestTimeoutMs) && requestTimeoutMs > 0,
    "requestTimeoutMs must be a positive integer",
  );

  const session = await requestJson(
    fetchImplementation,
    baseUrl,
    "/auth/wechat/login",
    {
      method: "POST",
      body: JSON.stringify({ code: "mock:slice-2-runtime-catalog" }),
    },
    201,
    undefined,
    requestTimeoutMs,
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
    requestTimeoutMs,
  );
  assert.equal(hangzhou.items.length, 3, "Hangzhou did not return exactly three properties");
  for (const item of hangzhou.items) {
    assertUuidV4(item.id, "property ID");
  }
  assert.deepEqual(
    hangzhou.items.map(({ id, type }) => ({ id, type })),
    expectedHangzhouProperties,
    "catalog did not return the deterministic Hangzhou properties in order",
  );
  assert.ok(
    hangzhou.items.every(
      (item) =>
        item.city?.id === search.city_id &&
        item.city?.code === "330100" &&
        item.city?.name === "杭州",
    ),
    "Hangzhou city semantics did not match the requested city",
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
    requestTimeoutMs,
  );
  assert.equal(homestays.items.length, 1, "HOMESTAY filter did not return exactly one property");
  assert.ok(
    homestays.items.every(({ type }) => type === "HOMESTAY"),
    "HOMESTAY filter returned another property type",
  );
  const hangzhouTypesById = new Map(hangzhou.items.map(({ id, type }) => [id, type]));
  assert.ok(
    homestays.items.every(
      ({ id, type }) => hangzhouTypesById.get(id) === type && type === "HOMESTAY",
    ),
    "HOMESTAY result did not match the Hangzhou baseline",
  );
  assertNoRoomCollections(homestays.items);
  log("catalog validation: pass - property type filter");

  const propertyId = assertUuidV4(hangzhou.items[0].id, "property ID");
  const capacityProperty = await requestJson(
    fetchImplementation,
    baseUrl,
    `/properties/${encodeURIComponent(propertyId)}`,
    authenticated,
    200,
    { checkin: search.checkin, checkout: search.checkout, guests: 3 },
    requestTimeoutMs,
  );
  assert.equal(capacityProperty.id, propertyId, "property detail ID did not match the request");
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
    requestTimeoutMs,
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
    requestTimeoutMs,
  );
  const pagedProperties = [...firstPage.items, ...secondPage.items];
  assert.equal(pagedProperties.length, 3, "two catalog pages did not contain three properties");
  assert.equal(secondPage.next_cursor, null, "second page unexpectedly returned another cursor");
  assertUniquePropertyIds(pagedProperties);
  assert.deepEqual(
    pagedProperties.map(({ id }) => id),
    hangzhou.items.map(({ id }) => id),
    "cursor pages differed from the Hangzhou baseline",
  );
  assertNoRoomCollections(pagedProperties);
  log("catalog validation: pass - cursor pagination");

  const propertyDetail = await requestJson(
    fetchImplementation,
    baseUrl,
    `/properties/${encodeURIComponent(propertyId)}`,
    authenticated,
    200,
    { checkin: search.checkin, checkout: search.checkout, guests: search.guests },
    requestTimeoutMs,
  );
  assert.equal(propertyDetail.id, propertyId, "property detail ID did not match the request");
  assert.equal(propertyDetail.room_types.length, 2, "guests=1 property detail omitted a room type");
  log("catalog validation: pass - property room types");

  const roomTypeId = assertUuidV4(propertyDetail.room_types[0].id, "room type ID");
  const roomDetail = await requestJson(
    fetchImplementation,
    baseUrl,
    `/room-types/${encodeURIComponent(roomTypeId)}`,
    authenticated,
    200,
    { checkin: search.checkin, checkout: search.checkout, guests: search.guests },
    requestTimeoutMs,
  );
  assert.equal(roomDetail.id, roomTypeId, "room detail ID did not match the request");
  assert.equal(
    roomDetail.property?.id,
    propertyId,
    "room detail property ID did not match the request",
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

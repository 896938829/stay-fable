import assert from "node:assert/strict";
import test from "node:test";

import { verifySliceTwoRuntime } from "./verify-slice-2-runtime.mjs";

const cityId = "10000000-0000-4000-8000-000000000001";
const propertyIds = [
  "20000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-000000000002",
  "20000000-0000-4000-8000-000000000003",
];
const roomIds = ["30000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000002"];
const accessToken = "catalog-access-token-that-must-stay-secret";
const refreshToken = "catalog-refresh-token-that-must-stay-secret";
const nextCursor = "catalog-page-two";

function response(status, body) {
  return {
    status,
    async json() {
      return body;
    },
  };
}

function property(id, type, availableRoomTypeCount = 2) {
  return {
    id,
    type,
    name: `住宿 ${id.at(-1)}`,
    city: { id: cityId, code: "330100", name: "杭州" },
    available_room_type_count: availableRoomTypeCount,
  };
}

function room(id, maxGuests) {
  return {
    id,
    name: `房型 ${id.at(-1)}`,
    max_guests: maxGuests,
  };
}

function validResponses() {
  return [
    response(201, {
      data: {
        access_token: accessToken,
        refresh_token: refreshToken,
        user: { id: "11111111-1111-4111-8111-111111111111" },
      },
    }),
    response(200, {
      data: {
        items: [
          property(propertyIds[0], "HOTEL"),
          property(propertyIds[1], "HOMESTAY"),
          property(propertyIds[2], "FARM_STAY"),
        ],
        next_cursor: null,
      },
    }),
    response(200, {
      data: { items: [property(propertyIds[1], "HOMESTAY")], next_cursor: null },
    }),
    response(200, {
      data: {
        ...property(propertyIds[0], "HOTEL", 1),
        room_types: [room(roomIds[1], 4)],
      },
    }),
    response(200, {
      data: {
        items: [property(propertyIds[0], "HOTEL"), property(propertyIds[1], "HOMESTAY")],
        next_cursor: nextCursor,
      },
    }),
    response(200, {
      data: { items: [property(propertyIds[2], "FARM_STAY")], next_cursor: null },
    }),
    response(200, {
      data: {
        ...property(propertyIds[0], "HOTEL"),
        room_types: [room(roomIds[0], 2), room(roomIds[1], 4)],
      },
    }),
    response(200, {
      data: {
        ...room(roomIds[0], 2),
        property: property(propertyIds[0], "HOTEL"),
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
      },
    }),
  ];
}

function createHarness(responses = validResponses()) {
  const queue = [...responses];
  const calls = [];
  const logs = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const next = queue.shift();
    assert.ok(next, `unexpected request: ${url}`);
    return next;
  };

  return { calls, fetch, logs, queue };
}

test("verifies the seeded catalog filters, pagination, hierarchy, and redaction", async () => {
  const harness = createHarness();

  await verifySliceTwoRuntime({
    baseUrl: "http://api:3000",
    fetch: harness.fetch,
    log: (message) => harness.logs.push(message),
  });

  assert.equal(harness.queue.length, 0);
  assert.equal(harness.calls.length, 8);
  const urls = harness.calls.map(({ url }) => new URL(url));
  for (const url of urls.slice(1)) {
    assert.equal(url.searchParams.get("checkin"), "2026-07-30");
    assert.equal(url.searchParams.get("checkout"), "2026-08-01");
    assert.doesNotMatch(url.href, new RegExp(accessToken));
  }
  assert.equal(urls[1].searchParams.get("city_id"), cityId);
  assert.equal(urls[1].searchParams.get("guests"), "1");
  assert.equal(urls[2].searchParams.get("property_type"), "HOMESTAY");
  assert.equal(urls[3].searchParams.get("guests"), "3");
  assert.equal(urls[4].searchParams.get("page_size"), "2");
  assert.equal(urls[5].searchParams.get("cursor"), nextCursor);
  assert.equal(urls[6].pathname, `/api/v1/properties/${propertyIds[0]}`);
  assert.equal(urls[7].pathname, `/api/v1/room-types/${roomIds[0]}`);
  for (const call of harness.calls.slice(1)) {
    assert.equal(call.options.headers.authorization, `Bearer ${accessToken}`);
  }
  const renderedLogs = harness.logs.join("\n");
  assert.match(renderedLogs, /catalog validation: pass/);
  assert.doesNotMatch(renderedLogs, new RegExp(accessToken));
  assert.doesNotMatch(renderedLogs, new RegExp(refreshToken));
});

test("fails on any unexpected HTTP status", async () => {
  const responses = validResponses();
  responses[1] = response(503, { error: { code: "CATALOG_UNAVAILABLE" } });
  const harness = createHarness(responses);

  await assert.rejects(
    verifySliceTwoRuntime({
      baseUrl: "http://api:3000",
      fetch: harness.fetch,
      log: (message) => harness.logs.push(message),
    }),
    /HTTP 503/,
  );
});

test("fails when a successful response contains an error code", async () => {
  const responses = validResponses();
  responses[1] = response(200, {
    data: { items: [], next_cursor: null },
    error: { code: "CATALOG_PARTIAL_FAILURE" },
  });
  const harness = createHarness(responses);

  await assert.rejects(
    verifySliceTwoRuntime({
      baseUrl: "http://api:3000",
      fetch: harness.fetch,
      log: (message) => harness.logs.push(message),
    }),
    /CATALOG_PARTIAL_FAILURE/,
  );
});

test("fails when cursor pages contain duplicate property IDs", async () => {
  const responses = validResponses();
  responses[5] = response(200, {
    data: { items: [property(propertyIds[1], "HOMESTAY")], next_cursor: null },
  });
  const harness = createHarness(responses);

  await assert.rejects(
    verifySliceTwoRuntime({
      baseUrl: "http://api:3000",
      fetch: harness.fetch,
      log: (message) => harness.logs.push(message),
    }),
    /duplicate property ID/,
  );
});

test("fails when a property list leaks room collections", async () => {
  const responses = validResponses();
  const originalJson = responses[1].json;
  responses[1].json = async () => {
    const body = await originalJson();
    return {
      ...body,
      data: {
        ...body.data,
        items: [{ ...body.data.items[0], room_types: [] }, ...body.data.items.slice(1)],
      },
    };
  };
  const harness = createHarness(responses);

  await assert.rejects(
    verifySliceTwoRuntime({
      baseUrl: "http://api:3000",
      fetch: harness.fetch,
      log: (message) => harness.logs.push(message),
    }),
    /room collection/,
  );
});

for (const inventoryField of ["total_inventory", "held_inventory", "sold_inventory", "version"]) {
  test(`fails when room detail leaks ${inventoryField}`, async () => {
    const responses = validResponses();
    const originalJson = responses[7].json;
    responses[7].json = async () => {
      const body = await originalJson();
      return { ...body, data: { ...body.data, [inventoryField]: 1 } };
    };
    const harness = createHarness(responses);

    await assert.rejects(
      verifySliceTwoRuntime({
        baseUrl: "http://api:3000",
        fetch: harness.fetch,
        log: (message) => harness.logs.push(message),
      }),
      new RegExp(inventoryField),
    );
  });
}

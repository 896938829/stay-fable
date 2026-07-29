import assert from "node:assert/strict";
import { clearTimeout, setTimeout } from "node:timers";
import test from "node:test";

import {
  assertBookingSummary,
  assertPersistedBookingState,
  createBoundedBarrier,
  verifySliceThreeRuntime,
} from "./verify-slice-3-runtime.mjs";

const users = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const tokens = ["slice-three-access-token-a", "slice-three-access-token-b"];
const quoteIds = Array.from(
  { length: 8 },
  (_, index) => `${index + 3}0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);

const response = (status, body) => ({
  status,
  async json() {
    return body;
  },
});

const booking = (suffix, overrides = {}) => ({
  booking_id: `90000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`,
  booking_number: `SF20260730${String(suffix).padStart(12, "A")}`,
  status: "PENDING_PAYMENT",
  property_name: "西湖云栖酒店",
  room_type_name: "舒适大床房",
  checkin: "2026-08-02",
  checkout: "2026-08-03",
  nights: 1,
  guests: 1,
  total_price_cents: 46_800,
  currency: "CNY",
  expires_at: "2026-07-30T01:15:00.000Z",
  created_at: "2026-07-30T01:00:00.000Z",
  ...overrides,
});

const expectedBooking = {
  checkin: "2026-08-02",
  checkout: "2026-08-03",
  guests: 1,
  nights: 1,
  propertyName: "西湖云栖酒店",
  roomTypeName: "舒适大床房",
  totalPriceCents: 46_800,
};

test("accepts only a complete strict booking summary and returns a trusted snapshot", () => {
  const source = booking(1);
  const snapshot = assertBookingSummary(source, expectedBooking);

  assert.deepEqual(snapshot, source);
  assert.notEqual(snapshot, source);
  assert.equal(Object.getPrototypeOf(snapshot), Object.prototype);
  assert.equal(Object.isFrozen(snapshot), true);
});

test("rejects empty, unknown, and malformed booking summary data", () => {
  for (const malformed of [
    {},
    { ...booking(1), user_id: users[0] },
    { ...booking(1), booking_number: "" },
    { ...booking(1), status: "PAID" },
    { ...booking(1), nights: 2 },
    { ...booking(1), expires_at: "not-an-instant" },
    { ...booking(1), created_at: "2026-02-30T01:00:00.000Z" },
  ]) {
    assert.throws(
      () => assertBookingSummary(malformed, expectedBooking),
      /runtime booking summary/,
    );
  }
});

test("requires pending bookings, held holds, and one exact initial history per booking", () => {
  const valid = {
    bookings: [{ booking_id: booking(1).booking_id, status: "PENDING_PAYMENT" }],
    histories: [
      {
        actor_type: "USER",
        booking_id: booking(1).booking_id,
        from_status: null,
        reason: "BOOKING_CREATED",
        to_status: "PENDING_PAYMENT",
      },
    ],
    holds: [{ booking_id: booking(1).booking_id, status: "HELD" }],
  };
  const expected = { bookingCount: 1, historyCount: 1, holdCount: 1 };
  assert.doesNotThrow(() => assertPersistedBookingState(valid, expected));

  for (const malformed of [
    { ...valid, bookings: [{ ...valid.bookings[0], status: "PAID" }] },
    { ...valid, holds: [{ ...valid.holds[0], status: "RELEASED" }] },
    {
      ...valid,
      histories: [{ ...valid.histories[0], reason: "BOOKING_REPLAYED" }],
    },
  ]) {
    assert.throws(
      () => assertPersistedBookingState(malformed, expected),
      /runtime persisted booking state/,
    );
  }
  assert.doesNotThrow(() =>
    assertPersistedBookingState(
      { bookings: [], histories: [], holds: [] },
      { bookingCount: 0, historyCount: 0, holdCount: 0 },
    ),
  );
});

function createDatabase() {
  const calls = [];
  return {
    calls,
    async prepare(userIds) {
      calls.push(["prepare", [...userIds]]);
    },
    async resetInventory(input) {
      calls.push(["resetInventory", globalThis.structuredClone(input)]);
    },
    async setInventoryTotal(date, total) {
      calls.push(["setInventoryTotal", date, total]);
    },
    async changePrice(date) {
      calls.push(["changePrice", date]);
    },
    async expireQuote(quoteId, userId) {
      calls.push(["expireQuote", quoteId, userId]);
    },
    async assertQuoteOwner(quoteId, userId) {
      calls.push(["assertQuoteOwner", quoteId, userId]);
    },
    async assertReplacementQuote(quoteId, userId) {
      calls.push(["assertReplacementQuote", quoteId, userId]);
    },
    async assertState(input) {
      calls.push(["assertState", globalThis.structuredClone(input)]);
    },
    async cleanup(userIds) {
      calls.push(["cleanup", [...userIds]]);
    },
  };
}

function createFetch() {
  const calls = [];
  const loginCodes = [];
  const replayBooking = booking(1);
  const quotes = new Map();
  let quoteIndex = 0;
  let concurrencyWinner = false;

  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const parsed = new URL(url);
    const body = options.body === undefined ? undefined : JSON.parse(options.body);
    if (parsed.pathname === "/api/v1/auth/wechat/login") {
      loginCodes.push(body.code);
      const index = loginCodes.length - 1;
      return response(201, {
        data: {
          access_token: tokens[index],
          refresh_token: `refresh-${index}`,
          user: { id: users[index] },
        },
      });
    }
    if (parsed.pathname === "/api/v1/quotes") {
      const quoteId = quoteIds[quoteIndex++];
      const checkin = Date.parse(`${body.checkin}T00:00:00.000Z`);
      const checkout = Date.parse(`${body.checkout}T00:00:00.000Z`);
      const quote = {
        quote_id: quoteId,
        property: { name: "西湖云栖酒店" },
        room_type: { name: "舒适大床房" },
        checkin: body.checkin,
        checkout: body.checkout,
        nights: (checkout - checkin) / 86_400_000,
        guests: body.guests,
        total_price_cents: 46_800,
        currency: "CNY",
      };
      quotes.set(quoteId, quote);
      return response(201, {
        data: quote,
      });
    }
    if (parsed.pathname === "/api/v1/bookings") {
      if (body.quote_id === quoteIds[0]) {
        const replayed = calls.filter(
          (call) =>
            new URL(call.url).pathname === "/api/v1/bookings" &&
            JSON.parse(call.options.body).quote_id === quoteIds[0],
        ).length;
        return response(replayed === 1 ? 201 : 200, { data: replayBooking });
      }
      if (body.quote_id === quoteIds[1] || body.quote_id === quoteIds[2]) {
        if (!concurrencyWinner) {
          concurrencyWinner = true;
          const quote = quotes.get(body.quote_id);
          return response(201, {
            data: booking(2, {
              checkin: quote.checkin,
              checkout: quote.checkout,
              nights: quote.nights,
              guests: quote.guests,
              total_price_cents: quote.total_price_cents,
            }),
          });
        }
        return response(409, { error: { code: "INVENTORY_UNAVAILABLE" } });
      }
      if (body.quote_id === quoteIds[3]) {
        return response(409, { error: { code: "INVENTORY_UNAVAILABLE" } });
      }
      if (body.quote_id === quoteIds[4]) {
        quoteIndex = 6;
        return response(409, {
          error: {
            code: "QUOTE_CHANGED",
            details: { replacement_quote: { quote_id: quoteIds[5] } },
          },
        });
      }
      if (body.quote_id === quoteIds[6]) {
        return response(409, { error: { code: "QUOTE_EXPIRED" } });
      }
    }
    throw new Error(`unexpected request path ${parsed.pathname}`);
  };

  return { calls, fetch, loginCodes };
}

test("verifies all Slice 3 booking outcomes and logs only fixed markers", async () => {
  const database = createDatabase();
  const http = createFetch();
  const logs = [];

  await verifySliceThreeRuntime({
    baseUrl: "http://api:3000",
    database,
    fetch: http.fetch,
    log: (message) => logs.push(message),
  });

  assert.deepEqual(http.loginCodes, [
    "mock:slice-3-runtime-owner-a",
    "mock:slice-3-runtime-owner-b",
  ]);
  assert.deepEqual(logs, [
    "SLICE3_QUOTE_CREATED",
    "SLICE3_IDEMPOTENT_REPLAY",
    "SLICE3_LAST_ROOM_SERIALIZED",
    "SLICE3_MULTI_NIGHT_ROLLED_BACK",
    "SLICE3_QUOTE_CHANGED_NO_HOLD",
    "SLICE3_QUOTE_EXPIRED_NO_HOLD",
    "SLICE3_UAT_READY http://127.0.0.1:3000",
  ]);
  assert.equal(database.calls.at(-1)[0], "cleanup");
  assert.ok(database.calls.some(([name]) => name === "assertReplacementQuote"));
  const renderedLogs = logs.join("\n");
  for (const secret of [...tokens, ...users, ...quoteIds]) {
    assert.doesNotMatch(renderedLogs, new RegExp(secret));
  }
});

test("runs owner cleanup when an HTTP operation fails", async () => {
  const database = createDatabase();
  const http = createFetch();
  let requestCount = 0;

  await assert.rejects(
    verifySliceThreeRuntime({
      baseUrl: "http://api:3000",
      database,
      fetch: async (...arguments_) => {
        requestCount += 1;
        if (requestCount === 3) {
          throw new Error("injected HTTP failure");
        }
        return http.fetch(...arguments_);
      },
      log: () => {},
    }),
    /injected HTTP failure/,
  );

  assert.equal(database.calls.at(-1)[0], "cleanup");
});

for (const [name, malformed] of [
  ["empty", {}],
  ["malformed", { ...booking(1), inventory: 1 }],
]) {
  test(`rejects ${name} successful booking data and cleans owner data`, async () => {
    const database = createDatabase();
    const http = createFetch();
    let bookingResponses = 0;

    await assert.rejects(
      verifySliceThreeRuntime({
        baseUrl: "http://api:3000",
        database,
        fetch: async (...arguments_) => {
          const result = await http.fetch(...arguments_);
          if (new URL(arguments_[0]).pathname === "/api/v1/bookings" && bookingResponses < 2) {
            bookingResponses += 1;
            return response(result.status, { data: malformed });
          }
          return result;
        },
        log: () => {},
      }),
      /runtime booking summary/,
    );

    assert.equal(database.calls.at(-1)[0], "cleanup");
  });
}

for (const [name, mutate] of [
  [
    "booking",
    (state) => {
      state.bookings[0].status = "PAID";
    },
  ],
  [
    "hold",
    (state) => {
      state.holds[0].status = "RELEASED";
    },
  ],
  [
    "history",
    (state) => {
      state.histories[0].reason = "BOOKING_REPLAYED";
    },
  ],
]) {
  test(`rejects a wrong persisted ${name} status and cleans owner data`, async () => {
    const database = createDatabase();
    const http = createFetch();
    database.assertState = async (expected) => {
      database.calls.push(["assertState"]);
      const bookingId = booking(1).booking_id;
      const state = {
        bookings: [{ booking_id: bookingId, status: "PENDING_PAYMENT" }],
        histories: [
          {
            actor_type: "USER",
            booking_id: bookingId,
            from_status: null,
            reason: "BOOKING_CREATED",
            to_status: "PENDING_PAYMENT",
          },
        ],
        holds: [{ booking_id: bookingId, status: "HELD" }],
      };
      mutate(state);
      assertPersistedBookingState(state, expected);
    };

    await assert.rejects(
      verifySliceThreeRuntime({
        baseUrl: "http://api:3000",
        database,
        fetch: http.fetch,
        log: () => {},
      }),
      /runtime persisted booking state/,
    );

    assert.equal(database.calls.at(-1)[0], "cleanup");
  });
}

test("times out an under-participating concurrency barrier and cleans owner data", async () => {
  const database = createDatabase();
  const http = createFetch();

  await assert.rejects(
    verifySliceThreeRuntime({
      baseUrl: "http://api:3000",
      barrierFactory(participants, timeoutMilliseconds) {
        const arrive = createBoundedBarrier(participants, timeoutMilliseconds);
        let calls = 0;
        return () => {
          calls += 1;
          return calls === 1 ? arrive() : Promise.resolve();
        };
      },
      barrierTimeoutMs: 20,
      database,
      fetch: http.fetch,
      log: () => {},
    }),
    /runtime concurrency barrier timed out/,
  );

  assert.equal(database.calls.at(-1)[0], "cleanup");
});

test("bounds a stalled HTTP operation and still cleans owner data", async () => {
  const database = createDatabase();
  let guard;
  const verification = verifySliceThreeRuntime({
    baseUrl: "http://api:3000",
    database,
    fetch: async () => new Promise(() => {}),
    log: () => {},
    requestTimeoutMs: 20,
  });

  try {
    await assert.rejects(
      Promise.race([
        verification,
        new Promise((_, reject) => {
          guard = setTimeout(() => reject(new Error("outer timeout fired")), 250);
        }),
      ]),
      /runtime HTTP request timed out/,
    );
  } finally {
    clearTimeout(guard);
  }
  assert.equal(database.calls.at(-1)[0], "cleanup");
});

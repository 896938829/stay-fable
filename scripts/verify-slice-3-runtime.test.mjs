import assert from "node:assert/strict";
import { clearTimeout, setTimeout } from "node:timers";
import test from "node:test";

import { createBoundedBarrier, verifySliceThreeRuntime } from "./verify-slice-3-runtime.mjs";

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

const booking = (suffix) => ({
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
      return response(201, {
        data: {
          quote_id: quoteId,
          total_price_cents: 46_800,
          currency: "CNY",
        },
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
          return response(201, { data: booking(2) });
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

test("runs owner cleanup when a database assertion fails", async () => {
  const database = createDatabase();
  const http = createFetch();
  database.assertState = async () => {
    database.calls.push(["assertState"]);
    throw new Error("injected database failure");
  };

  await assert.rejects(
    verifySliceThreeRuntime({
      baseUrl: "http://api:3000",
      database,
      fetch: http.fetch,
      log: () => {},
    }),
    /injected database failure/,
  );

  assert.equal(database.calls.at(-1)[0], "cleanup");
});

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

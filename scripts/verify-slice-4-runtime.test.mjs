import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertMockFailureResponse,
  deleteRegisteredOwnerData,
  pollForWorkerExpiry,
  runCleanupStages,
  verifySliceFourRuntime,
} from "./verify-slice-4-runtime.mjs";

const scenarios = [
  ["verifyBookingQueryIsolation", "SLICE4_BOOKING_QUERY_ISOLATED"],
  ["verifyMockFailureIdempotency", "SLICE4_MOCK_FAILURE_IDEMPOTENT"],
  ["verifyMockSuccessConfirmed", "SLICE4_MOCK_SUCCESS_CONFIRMED"],
  ["verifyCancellationReleased", "SLICE4_CANCEL_RELEASED"],
  ["verifyLifecycleRaceSerialized", "SLICE4_LIFECYCLE_RACE_SERIALIZED"],
  ["verifyWorkerExpiryReleased", "SLICE4_WORKER_EXPIRY_RELEASED"],
];

const createRuntime = (events, cleanup = async () => {}) => ({
  ...Object.fromEntries(
    scenarios.map(([method]) => [
      method,
      async () => {
        events.push(`assert:${method}`);
      },
    ]),
  ),
  cleanup: async () => {
    events.push("cleanup");
    await cleanup();
  },
});

test("prints each fixed marker only after its corresponding database assertion", async () => {
  const events = [];

  await verifySliceFourRuntime({
    runtime: createRuntime(events),
    log: (message) => events.push(message),
  });

  assert.deepEqual(events, [
    ...scenarios.flatMap(([method, marker]) => [`assert:${method}`, marker]),
    "cleanup",
    "SLICE4_UAT_READY http://127.0.0.1:3000",
  ]);
});

test("cleanup failure prevents the Slice 4 UAT-ready marker", async () => {
  const events = [];
  const cleanupError = new Error("fixture cleanup failed");

  await assert.rejects(
    verifySliceFourRuntime({
      runtime: createRuntime(events, async () => {
        throw cleanupError;
      }),
      log: (message) => events.push(message),
    }),
    cleanupError,
  );

  assert.ok(events.includes("cleanup"));
  assert.ok(!events.includes("SLICE4_UAT_READY http://127.0.0.1:3000"));
});

test("accepts only the public mock-payment failure contract", () => {
  assert.doesNotThrow(() =>
    assertMockFailureResponse({
      status: 409,
      body: { error: { code: "MOCK_PAYMENT_FAILED" } },
    }),
  );
  assert.throws(() =>
    assertMockFailureResponse({
      status: 409,
      body: { error: { code: "PAYMENT_FAILED" } },
    }),
  );
});

test("backdates creation before expiring the booking and hold", async () => {
  const source = await readFile(new URL("./verify-slice-4-runtime.mjs", import.meta.url), "utf8");
  const expiry = source.slice(
    source.indexOf("async expire(bookingId)"),
    source.indexOf("async waitForExpiry"),
  );
  assert.match(
    expiry,
    /UPDATE booking SET created_at = CURRENT_TIMESTAMP - interval '2 minutes',\s+expires_at = CURRENT_TIMESTAMP - interval '1 second'/,
  );
  assert.match(
    expiry,
    /UPDATE inventory_hold SET created_at = CURRENT_TIMESTAMP - interval '2 minutes',\s+expires_at = CURRENT_TIMESTAMP - interval '1 second'/,
  );
});

test("registers each successful login immediately so partial initialization is cleaned", async () => {
  const registered = [];
  let cleanupCalls = 0;
  let loginCalls = 0;
  const firstUserId = "10000000-0000-4000-8000-000000000001";
  const database = {
    registerOwner(userId) {
      registered.push(userId);
    },
    async cleanup() {
      cleanupCalls += 1;
    },
  };

  await assert.rejects(
    verifySliceFourRuntime({
      baseUrl: "http://runtime.invalid",
      database,
      fetch: async () => {
        throw new Error("fetch must not be used by injected login");
      },
      login: async () => {
        loginCalls += 1;
        if (loginCalls === 1) {
          return { accessToken: "opaque-test-token", userId: firstUserId };
        }
        throw new Error("second login failed");
      },
      log: () => {},
    }),
    /second login failed/,
  );

  assert.deepEqual(registered, [firstUserId]);
  assert.equal(cleanupCalls, 1);
});

test("worker expiry polling passes the shrinking remaining deadline to each read", async () => {
  let now = 0;
  const budgets = [];
  const sleeps = [];
  const state = await pollForWorkerExpiry({
    pollIntervalMs: 5,
    timeoutMs: 30,
    monotonicNow: () => now,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
    readState: async (remainingTimeoutMs) => {
      budgets.push(remainingTimeoutMs);
      if (budgets.length === 1) {
        now += 20;
        return { status: "PENDING_PAYMENT" };
      }
      now += 4;
      return { status: "CLOSED" };
    },
  });

  assert.equal(state.status, "CLOSED");
  assert.deepEqual(budgets, [30, 5]);
  assert.deepEqual(sleeps, [5]);
});

test("worker expiry polling fails after one over-budget read without continuing", async () => {
  let now = 0;
  let reads = 0;
  let sleeps = 0;

  await assert.rejects(
    pollForWorkerExpiry({
      timeoutMs: 30,
      monotonicNow: () => now,
      sleep: async () => {
        sleeps += 1;
      },
      readState: async (remainingTimeoutMs) => {
        reads += 1;
        assert.equal(remainingTimeoutMs, 30);
        now = 31;
        return { status: "PENDING_PAYMENT" };
      },
    }),
    /runtime worker expiry timed out/,
  );

  assert.equal(reads, 1);
  assert.equal(sleeps, 0);
});

test("production expiry reads use the remaining pg query timeout without a detached race", async () => {
  const source = await readFile(new URL("./verify-slice-4-runtime.mjs", import.meta.url), "utf8");
  assert.match(source, /query_timeout: queryTimeoutMs/);
  assert.match(
    source,
    /readState: \(remainingTimeoutMs\) => readLifecycle\(bookingId, remainingTimeoutMs\)/,
  );
  assert.doesNotMatch(source, /Promise\.race/);
});

test("cleanup continues through owner and identity deletion after fixture isolation fails", async () => {
  const events = [];
  const foreignOccupancy = new Error("runtime fixture has foreign occupancy");

  await assert.rejects(
    runCleanupStages([
      async () => {
        events.push("fixture");
        throw foreignOccupancy;
      },
      async () => events.push("owner-data"),
      async () => events.push("identity-user"),
      async () => events.push("pool"),
    ]),
    (error) =>
      error instanceof AggregateError &&
      error.errors.length === 1 &&
      error.errors[0] === foreignOccupancy,
  );

  assert.deepEqual(events, ["fixture", "owner-data", "identity-user", "pool"]);
});

test("worker deadline uses an injected monotonic clock despite wall-clock rollback", async () => {
  const originalDateNow = Date.now;
  let monotonic = 0;
  let wallClock = 10_000;
  const budgets = [];
  Date.now = () => wallClock;
  try {
    const state = await pollForWorkerExpiry({
      monotonicNow: () => monotonic,
      pollIntervalMs: 5,
      timeoutMs: 30,
      sleep: async (milliseconds) => {
        monotonic += milliseconds;
        wallClock -= 5_000;
      },
      readState: async (remainingTimeoutMs) => {
        budgets.push(remainingTimeoutMs);
        if (budgets.length === 1) {
          monotonic += 20;
          wallClock -= 5_000;
          return { status: "PENDING_PAYMENT" };
        }
        return { status: "CLOSED" };
      },
    });
    assert.equal(state.status, "CLOSED");
  } finally {
    Date.now = originalDateNow;
  }

  assert.deepEqual(budgets, [30, 5]);
});

test("failed payment assertion checks the exact nightly held and sold inventory", async () => {
  const source = await readFile(new URL("./verify-slice-4-runtime.mjs", import.meta.url), "utf8");
  const assertion = source.slice(
    source.indexOf("async assertFailedPending"),
    source.indexOf("async assertConfirmed"),
  );
  assert.match(assertion, /async assertFailedPending\(bookingId, date\)/);
  assert.match(assertion, /SELECT held_inventory, sold_inventory FROM daily_inventory/);
  assert.match(assertion, /held_inventory, 1/);
  assert.match(assertion, /sold_inventory, 0/);
  assert.match(
    source,
    /await database\.assertFailedPending\(bookingId, fixture\.dates\[2\]\);\s+},/,
  );
});

test("owner cleanup locks lifecycle rows before deriving inventory compensation", async () => {
  const ownerIds = ["10000000-0000-4000-8000-000000000001"];
  const calls = [];
  const state = {
    foreignBooking: true,
    foreignHeld: 1,
    heldInventory: 2,
    ownerBooking: true,
    ownerHoldStatus: "HELD",
    ownerRecordsDeleted: false,
  };
  let ownerBookingLocked = false;

  const releaseOwnerBeforeLock = () => {
    if (!ownerBookingLocked && state.ownerHoldStatus === "HELD") {
      state.ownerHoldStatus = "RELEASED";
      state.heldInventory -= 1;
    }
  };
  const fakeQuery = async (_client, text, values = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    calls.push({ sql, values });
    if (calls.length === 1 && !/FROM booking .*FOR UPDATE/.test(sql)) {
      releaseOwnerBeforeLock();
    }
    if (/SELECT booking\.id::text AS booking_id/.test(sql)) {
      assert.match(sql, /WHERE booking\.user_id = ANY\(\$1::uuid\[\]\)/);
      assert.match(sql, /FOR UPDATE OF booking/);
      ownerBookingLocked = true;
      return { rowCount: 1, rows: [{ booking_id: "30000000-0000-4000-8000-000000000001" }] };
    }
    if (/SELECT hold\.id::text AS hold_id/.test(sql)) {
      assert.ok(ownerBookingLocked);
      assert.match(sql, /FOR UPDATE OF hold/);
      return {
        rowCount: 1,
        rows: [
          {
            business_date: "2026-08-14",
            hold_id: "40000000-0000-4000-8000-000000000001",
            room_type_id: "30000000-0000-4000-8000-000000000001",
            status: state.ownerHoldStatus,
          },
        ],
      };
    }
    if (/SELECT held_inventory, sold_inventory/.test(sql) && /FOR UPDATE/.test(sql)) {
      return {
        rowCount: 1,
        rows: [{ held_inventory: state.heldInventory, sold_inventory: 0 }],
      };
    }
    if (/UPDATE daily_inventory inventory/.test(sql)) {
      const [, , heldDelta, soldDelta, expectedHeld, expectedSold] = values;
      assert.equal(state.heldInventory, expectedHeld);
      assert.equal(expectedSold, 0);
      state.heldInventory -= heldDelta;
      assert.equal(soldDelta, 0);
      return { rowCount: 1, rows: [{ business_date: "2026-08-14" }] };
    }
    if (/^DELETE FROM /.test(sql)) {
      assert.match(sql, /user_id = ANY\(\$1::uuid\[\]\)/);
      state.ownerRecordsDeleted = true;
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`unexpected fake SQL: ${sql}`);
  };

  await deleteRegisteredOwnerData({
    client: {},
    ownerIds,
    query: fakeQuery,
  });

  const bookingLock = calls.findIndex(({ sql }) => /FOR UPDATE OF booking/.test(sql));
  const holdLock = calls.findIndex(({ sql }) => /FOR UPDATE OF hold/.test(sql));
  const inventoryLock = calls.findIndex(
    ({ sql }) => /SELECT held_inventory, sold_inventory/.test(sql) && /FOR UPDATE/.test(sql),
  );
  const compensation = calls.findIndex(({ sql }) => /UPDATE daily_inventory inventory/.test(sql));
  const firstDelete = calls.findIndex(({ sql }) => /^DELETE FROM /.test(sql));
  assert.ok(
    bookingLock === 0 &&
      holdLock > bookingLock &&
      inventoryLock > holdLock &&
      compensation > inventoryLock &&
      firstDelete > compensation,
  );
  assert.equal(state.ownerHoldStatus, "HELD");
  assert.equal(state.heldInventory, state.foreignHeld);
  assert.equal(state.ownerRecordsDeleted, true);
  assert.equal(state.foreignBooking, true);
});

test("owner cleanup stops before FK deletion when conditional inventory compensation drifts", async () => {
  let deletes = 0;
  const fakeQuery = async (_client, text) => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (/SELECT booking\.id::text AS booking_id/.test(sql)) {
      return { rowCount: 1, rows: [{ booking_id: "30000000-0000-4000-8000-000000000001" }] };
    }
    if (/SELECT hold\.id::text AS hold_id/.test(sql)) {
      return {
        rowCount: 1,
        rows: [
          {
            business_date: "2026-08-14",
            hold_id: "40000000-0000-4000-8000-000000000001",
            room_type_id: "30000000-0000-4000-8000-000000000001",
            status: "HELD",
          },
        ],
      };
    }
    if (/SELECT held_inventory, sold_inventory/.test(sql)) {
      return { rowCount: 1, rows: [{ held_inventory: 2, sold_inventory: 0 }] };
    }
    if (/UPDATE daily_inventory inventory/.test(sql)) {
      return { rowCount: 0, rows: [] };
    }
    if (/^DELETE FROM /.test(sql)) {
      deletes += 1;
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`unexpected fake SQL: ${sql}`);
  };

  await assert.rejects(
    deleteRegisteredOwnerData({
      client: {},
      ownerIds: ["10000000-0000-4000-8000-000000000001"],
      query: fakeQuery,
    }),
    /runtime owner inventory cleanup drift/,
  );
  assert.equal(deletes, 0);
});

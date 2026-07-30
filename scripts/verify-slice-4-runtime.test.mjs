import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertMockFailureResponse,
  pollForWorkerExpiry,
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
    now: () => now,
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
      now: () => now,
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

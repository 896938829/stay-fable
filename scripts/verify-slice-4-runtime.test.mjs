import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { assertMockFailureResponse, verifySliceFourRuntime } from "./verify-slice-4-runtime.mjs";

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

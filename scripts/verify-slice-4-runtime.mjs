import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const fixture = {
  propertyId: "20000000-0000-4000-8000-000000000001",
  roomTypeId: "30000000-0000-4000-8000-000000000001",
  dates: [
    "2026-08-12",
    "2026-08-13",
    "2026-08-14",
    "2026-08-15",
    "2026-08-16",
    "2026-08-17",
    "2026-08-18",
  ],
};
const loginCodes = ["mock:slice-4-runtime-owner-a", "mock:slice-4-runtime-owner-b"];
const requestTimeoutDefault = 5_000;
const sqlTimeoutMilliseconds = 5_000;
const workerTimeoutDefault = 30_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const markers = [
  ["verifyBookingQueryIsolation", "SLICE4_BOOKING_QUERY_ISOLATED"],
  ["verifyMockFailureIdempotency", "SLICE4_MOCK_FAILURE_IDEMPOTENT"],
  ["verifyMockSuccessConfirmed", "SLICE4_MOCK_SUCCESS_CONFIRMED"],
  ["verifyCancellationReleased", "SLICE4_CANCEL_RELEASED"],
  ["verifyLifecycleRaceSerialized", "SLICE4_LIFECYCLE_RACE_SERIALIZED"],
  ["verifyWorkerExpiryReleased", "SLICE4_WORKER_EXPIRY_RELEASED"],
];

function endpoint(baseUrl, path) {
  return new URL(`/api/v1${path}`, `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

async function requestJson(fetchImplementation, baseUrl, path, options, statuses, timeoutMs) {
  const response = await fetchImplementation(endpoint(baseUrl, path), {
    ...options,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...options?.headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json();
  assert.ok(statuses.includes(response.status), `runtime HTTP status was ${response.status}`);
  return { body, status: response.status };
}

function authorization(session) {
  return { authorization: `Bearer ${session.accessToken}` };
}

function nextDate(date) {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
}

async function login(fetchImplementation, baseUrl, code, timeoutMs) {
  const { body } = await requestJson(
    fetchImplementation,
    baseUrl,
    "/auth/wechat/login",
    { method: "POST", body: JSON.stringify({ code }) },
    [201],
    timeoutMs,
  );
  assert.equal(typeof body?.data?.access_token, "string", "runtime login omitted token");
  assert.match(body?.data?.user?.id, uuidPattern, "runtime login omitted user");
  return { accessToken: body.data.access_token, userId: body.data.user.id };
}

async function createBooking(fetchImplementation, baseUrl, session, date, suffix, timeoutMs) {
  const quote = await requestJson(
    fetchImplementation,
    baseUrl,
    "/quotes",
    {
      method: "POST",
      headers: authorization(session),
      body: JSON.stringify({
        room_type_id: fixture.roomTypeId,
        checkin: date,
        checkout: nextDate(date),
        guests: 1,
      }),
    },
    [201],
    timeoutMs,
  );
  assert.match(quote.body?.data?.quote_id, uuidPattern, "runtime quote omitted ID");
  const result = await requestJson(
    fetchImplementation,
    baseUrl,
    "/bookings",
    {
      method: "POST",
      headers: {
        ...authorization(session),
        "idempotency-key": `slice4-booking-${suffix}-0000000000000000`,
      },
      body: JSON.stringify({ quote_id: quote.body.data.quote_id }),
    },
    [201],
    timeoutMs,
  );
  assert.match(result.body?.data?.booking_id, uuidPattern, "runtime booking omitted ID");
  assert.equal(result.body?.data?.status, "PENDING_PAYMENT");
  return result.body.data.booking_id;
}

function paymentRequest(
  fetchImplementation,
  baseUrl,
  session,
  bookingId,
  key,
  outcome,
  statuses,
  timeoutMs,
) {
  return requestJson(
    fetchImplementation,
    baseUrl,
    `/dev/payments/${bookingId}/simulate`,
    {
      method: "POST",
      headers: { ...authorization(session), "idempotency-key": key },
      body: JSON.stringify({ outcome }),
    },
    statuses,
    timeoutMs,
  );
}

function cancelRequest(fetchImplementation, baseUrl, session, bookingId, statuses, timeoutMs) {
  return requestJson(
    fetchImplementation,
    baseUrl,
    `/bookings/${bookingId}/cancel`,
    {
      method: "POST",
      headers: authorization(session),
      body: JSON.stringify({}),
    },
    statuses,
    timeoutMs,
  );
}

export function assertMockFailureResponse(result) {
  assert.equal(result.status, 409);
  assert.equal(result.body?.error?.code, "MOCK_PAYMENT_FAILED");
}

export async function pollForWorkerExpiry(options) {
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const sleep = options.sleep ?? delay;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  assert.ok(Number.isInteger(options.timeoutMs) && options.timeoutMs > 0);
  assert.ok(Number.isInteger(pollIntervalMs) && pollIntervalMs > 0);
  const deadline = monotonicNow() + options.timeoutMs;

  while (true) {
    const remainingTimeoutMs = deadline - monotonicNow();
    if (remainingTimeoutMs <= 0) {
      throw new Error("runtime worker expiry timed out");
    }
    const state = await options.readState(remainingTimeoutMs);
    if (monotonicNow() > deadline) {
      throw new Error("runtime worker expiry timed out");
    }
    if (state.status === "CLOSED") {
      return state;
    }
    const remainingSleepMs = deadline - monotonicNow();
    if (remainingSleepMs <= 0) {
      throw new Error("runtime worker expiry timed out");
    }
    await sleep(Math.min(pollIntervalMs, remainingSleepMs));
    if (monotonicNow() > deadline) {
      throw new Error("runtime worker expiry timed out");
    }
  }
}

export async function runCleanupStages(stages) {
  const errors = [];
  for (const stage of stages) {
    try {
      await stage();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "runtime cleanup failed");
  }
}

export async function deleteRegisteredOwnerData({ client, ownerIds, query }) {
  if (ownerIds.length === 0) return;
  await query(
    client,
    `
      SELECT booking.id::text AS booking_id
      FROM booking
      WHERE booking.user_id = ANY($1::uuid[])
      ORDER BY booking.id
      FOR UPDATE OF booking
    `,
    [ownerIds],
  );
  const lockedHolds = await query(
    client,
    `
      SELECT hold.id::text AS hold_id, hold.room_type_id::text,
             hold.business_date::text, hold.status::text
      FROM inventory_hold hold
      JOIN booking ON booking.id = hold.booking_id
      WHERE booking.user_id = ANY($1::uuid[])
      ORDER BY hold.room_type_id, hold.business_date, hold.id
      FOR UPDATE OF hold
    `,
    [ownerIds],
  );
  const deltas = new Map();
  for (const hold of lockedHolds.rows) {
    if (hold.status !== "HELD" && hold.status !== "CONSUMED") continue;
    const key = `${hold.room_type_id}\0${hold.business_date}`;
    const delta = deltas.get(key) ?? {
      businessDate: hold.business_date,
      held: 0,
      roomTypeId: hold.room_type_id,
      sold: 0,
    };
    if (hold.status === "HELD") {
      delta.held += 1;
    } else {
      delta.sold += 1;
    }
    deltas.set(key, delta);
  }
  for (const delta of [...deltas.values()].sort((left, right) =>
    `${left.roomTypeId}\0${left.businessDate}`.localeCompare(
      `${right.roomTypeId}\0${right.businessDate}`,
    ),
  )) {
    const lockedInventory = await query(
      client,
      `
        SELECT held_inventory, sold_inventory
        FROM daily_inventory inventory
        WHERE room_type_id = $1::uuid AND business_date = $2::date
        FOR UPDATE OF inventory
      `,
      [delta.roomTypeId, delta.businessDate],
    );
    assert.equal(lockedInventory.rowCount, 1, "runtime owner inventory cleanup row missing");
    const current = lockedInventory.rows[0];
    assert.ok(current.held_inventory >= delta.held, "runtime owner held cleanup drift");
    assert.ok(current.sold_inventory >= delta.sold, "runtime owner sold cleanup drift");
    const adjusted = await query(
      client,
      `
        UPDATE daily_inventory inventory
        SET held_inventory = inventory.held_inventory - $3,
            sold_inventory = inventory.sold_inventory - $4,
            version = inventory.version + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE room_type_id = $1::uuid AND business_date = $2::date
          AND held_inventory = $5 AND sold_inventory = $6
        RETURNING business_date
      `,
      [
        delta.roomTypeId,
        delta.businessDate,
        delta.held,
        delta.sold,
        current.held_inventory,
        current.sold_inventory,
      ],
    );
    assert.equal(adjusted.rowCount, 1, "runtime owner inventory cleanup drift");
  }
  await query(
    client,
    `DELETE FROM payment USING booking
     WHERE payment.booking_id = booking.id AND booking.user_id = ANY($1::uuid[])`,
    [ownerIds],
  );
  await query(
    client,
    `DELETE FROM booking_status_history history USING booking
     WHERE history.booking_id = booking.id AND booking.user_id = ANY($1::uuid[])`,
    [ownerIds],
  );
  await query(
    client,
    `DELETE FROM inventory_hold hold USING booking
     WHERE hold.booking_id = booking.id AND booking.user_id = ANY($1::uuid[])`,
    [ownerIds],
  );
  await query(client, "DELETE FROM booking WHERE user_id = ANY($1::uuid[])", [ownerIds]);
  await query(client, "DELETE FROM quote WHERE user_id = ANY($1::uuid[])", [ownerIds]);
}

async function loadDatabase(databaseUrl) {
  assert.equal(typeof databaseUrl, "string", "DATABASE_URL is required");
  const requireFromArtifact = createRequire("/app/package.json");
  const { Pool } = requireFromArtifact("pg");
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: sqlTimeoutMilliseconds,
    query_timeout: sqlTimeoutMilliseconds,
    statement_timeout: sqlTimeoutMilliseconds,
    lock_timeout: sqlTimeoutMilliseconds,
    max: 3,
  });
  let snapshot;
  let ownerIds = [];
  let closed = false;

  const query = (client, text, values = [], queryTimeoutMs = sqlTimeoutMilliseconds) =>
    client.query({ text, values, query_timeout: queryTimeoutMs });

  const transaction = async (operation) => {
    const client = await pool.connect();
    try {
      await query(client, "BEGIN");
      await query(client, "SELECT set_config('statement_timeout', $1, true)", [
        `${sqlTimeoutMilliseconds}ms`,
      ]);
      await query(client, "SELECT set_config('lock_timeout', $1, true)", [
        `${sqlTimeoutMilliseconds}ms`,
      ]);
      const result = await operation(client);
      await query(client, "COMMIT");
      return result;
    } catch (error) {
      try {
        await query(client, "ROLLBACK");
      } catch {
        // Preserve the original bounded database failure.
      }
      throw error;
    } finally {
      client.release();
    }
  };

  const lockSupply = (client) =>
    query(
      client,
      `
        SELECT inventory.business_date::text, inventory.total_inventory,
               inventory.held_inventory, inventory.sold_inventory, inventory.version,
               price.sale_price_cents, price.rack_price_cents
        FROM daily_inventory inventory
        JOIN daily_price price
          ON price.room_type_id = inventory.room_type_id
         AND price.business_date = inventory.business_date
        WHERE inventory.room_type_id = $1::uuid
          AND inventory.business_date = ANY($2::date[])
        ORDER BY inventory.business_date
        FOR UPDATE OF inventory, price
      `,
      [fixture.roomTypeId, fixture.dates],
    );

  const assertNoForeignOccupancy = async (client) => {
    const result = await query(
      client,
      `
        SELECT count(*)::integer AS count
        FROM booking
        WHERE room_type_id = $1::uuid
          AND user_id <> ALL($2::uuid[])
          AND checkin_date <= $4::date
          AND checkout_date > $3::date
      `,
      [fixture.roomTypeId, ownerIds, fixture.dates[0], fixture.dates.at(-1)],
    );
    assert.equal(result.rows[0]?.count, 0, "runtime fixture has foreign occupancy");
  };

  const deleteOwnerData = (client) => deleteRegisteredOwnerData({ client, ownerIds, query });

  const restoreSupply = async (client) => {
    if (snapshot === undefined) return;
    for (const row of snapshot) {
      await query(
        client,
        `
          UPDATE daily_price
          SET sale_price_cents = $3, rack_price_cents = $4, updated_at = CURRENT_TIMESTAMP
          WHERE room_type_id = $1::uuid AND business_date = $2::date
        `,
        [fixture.roomTypeId, row.business_date, row.sale_price_cents, row.rack_price_cents],
      );
      const restored = await query(
        client,
        `
          UPDATE daily_inventory inventory
          SET total_inventory = $3, held_inventory = $4, sold_inventory = $5,
              version = inventory.version + 1, updated_at = CURRENT_TIMESTAMP
          WHERE room_type_id = $1::uuid AND business_date = $2::date
          RETURNING business_date
        `,
        [
          fixture.roomTypeId,
          row.business_date,
          row.total_inventory,
          row.held_inventory,
          row.sold_inventory,
        ],
      );
      assert.equal(restored.rowCount, 1, "runtime inventory restore missed fixture");
    }
  };

  const readLifecycle = async (bookingId, remainingTimeoutMs = sqlTimeoutMilliseconds) => {
    const queryTimeoutMs = Math.max(
      1,
      Math.min(sqlTimeoutMilliseconds, Math.floor(remainingTimeoutMs)),
    );
    const result = await query(
      pool,
      `
          SELECT
            booking.status::text,
            (SELECT count(*)::integer FROM payment
             WHERE payment.booking_id = booking.id) AS payment_count,
            (SELECT count(*)::integer FROM payment
             WHERE payment.booking_id = booking.id AND payment.status = 'FAILED') AS failed_count,
            (SELECT count(*)::integer FROM payment
             WHERE payment.booking_id = booking.id AND payment.status = 'SUCCEEDED') AS succeeded_count,
            (SELECT count(*)::integer FROM inventory_hold
             WHERE inventory_hold.booking_id = booking.id AND status = 'HELD') AS held_count,
            (SELECT count(*)::integer FROM inventory_hold
             WHERE inventory_hold.booking_id = booking.id AND status = 'CONSUMED') AS consumed_count,
            (SELECT count(*)::integer FROM inventory_hold
             WHERE inventory_hold.booking_id = booking.id AND status = 'RELEASED') AS released_count,
            (SELECT count(*)::integer FROM booking_status_history
             WHERE booking_id = booking.id AND to_status = 'PAID') AS paid_history_count,
            (SELECT count(*)::integer FROM booking_status_history
             WHERE booking_id = booking.id AND to_status = 'CONFIRMED') AS confirmed_history_count,
            (SELECT count(*)::integer FROM booking_status_history
             WHERE booking_id = booking.id AND to_status = 'CANCELLED') AS cancelled_history_count,
            (SELECT count(*)::integer FROM booking_status_history
             WHERE booking_id = booking.id AND to_status = 'CLOSED') AS closed_history_count
          FROM booking
          WHERE booking.id = $1::uuid AND booking.user_id = ANY($2::uuid[])
        `,
      [bookingId, ownerIds],
      queryTimeoutMs,
    );
    assert.equal(result.rowCount, 1, "runtime booking lifecycle row missing");
    return result.rows[0];
  };

  return {
    registerOwner(userId) {
      assert.match(userId, uuidPattern, "runtime owner user must be a UUID");
      assert.ok(!ownerIds.includes(userId), "runtime owner users must be distinct");
      ownerIds.push(userId);
    },

    async prepare(userIds) {
      assert.equal(userIds.length, 2);
      assert.notEqual(userIds[0], userIds[1]);
      assert.deepEqual(ownerIds, userIds, "runtime owner registration mismatch");
      await transaction(async (client) => {
        const supply = await lockSupply(client);
        assert.equal(supply.rowCount, fixture.dates.length, "runtime fixture supply incomplete");
        await assertNoForeignOccupancy(client);
        const stale = await query(
          client,
          "SELECT count(*)::integer AS count FROM booking WHERE user_id = ANY($1::uuid[])",
          [ownerIds],
        );
        assert.equal(stale.rows[0]?.count, 0, "runtime owners have stale bookings");
        snapshot = supply.rows.map((row) => ({ ...row }));
      });
    },

    async reset() {
      await transaction(async (client) => {
        await lockSupply(client);
        await assertNoForeignOccupancy(client);
        await deleteOwnerData(client);
        await restoreSupply(client);
      });
    },

    async assertOwnerBookings(firstId, secondId) {
      await transaction(async (client) => {
        const result = await query(
          client,
          `
            SELECT user_id::text, array_agg(id::text ORDER BY id) AS booking_ids
            FROM booking WHERE user_id = ANY($1::uuid[])
            GROUP BY user_id ORDER BY user_id
          `,
          [ownerIds],
        );
        assert.equal(result.rowCount, 2);
        const ownership = new Map(result.rows.map((row) => [row.user_id, row.booking_ids]));
        assert.deepEqual(ownership.get(ownerIds[0]), [firstId]);
        assert.deepEqual(ownership.get(ownerIds[1]), [secondId]);
      });
    },

    async assertFailedPending(bookingId, date) {
      const state = await readLifecycle(bookingId);
      assert.equal(state.status, "PENDING_PAYMENT");
      assert.equal(state.payment_count, 1);
      assert.equal(state.failed_count, 1);
      assert.equal(state.held_count, 1);
      const inventory = await transaction((client) =>
        query(
          client,
          `SELECT held_inventory, sold_inventory FROM daily_inventory
           WHERE room_type_id = $1::uuid AND business_date = $2::date`,
          [fixture.roomTypeId, date],
        ),
      );
      assert.equal(inventory.rows[0]?.held_inventory, 1);
      assert.equal(inventory.rows[0]?.sold_inventory, 0);
    },

    async assertConfirmed(bookingId, date) {
      const state = await readLifecycle(bookingId);
      assert.equal(state.status, "CONFIRMED");
      assert.equal(state.payment_count, 1);
      assert.equal(state.succeeded_count, 1);
      assert.equal(state.held_count, 0);
      assert.equal(state.consumed_count, 1);
      assert.equal(state.paid_history_count, 1);
      assert.equal(state.confirmed_history_count, 1);
      const inventory = await transaction((client) =>
        query(
          client,
          `SELECT held_inventory, sold_inventory FROM daily_inventory
           WHERE room_type_id = $1::uuid AND business_date = $2::date`,
          [fixture.roomTypeId, date],
        ),
      );
      assert.equal(inventory.rows[0]?.held_inventory, 0);
      assert.equal(inventory.rows[0]?.sold_inventory, 1);
    },

    async assertCancelled(bookingId, date) {
      const state = await readLifecycle(bookingId);
      assert.equal(state.status, "CANCELLED");
      assert.equal(state.held_count, 0);
      assert.equal(state.released_count, 1);
      assert.equal(state.cancelled_history_count, 1);
      const inventory = await transaction((client) =>
        query(
          client,
          `SELECT held_inventory, sold_inventory FROM daily_inventory
           WHERE room_type_id = $1::uuid AND business_date = $2::date`,
          [fixture.roomTypeId, date],
        ),
      );
      assert.equal(inventory.rows[0]?.held_inventory, 0);
      assert.equal(inventory.rows[0]?.sold_inventory, 0);
    },

    async assertRaceFinal(bookingId, date) {
      const state = await readLifecycle(bookingId);
      if (state.status === "CONFIRMED") {
        await this.assertConfirmed(bookingId, date);
        assert.equal(state.cancelled_history_count, 0);
      } else {
        assert.equal(state.status, "CANCELLED");
        await this.assertCancelled(bookingId, date);
        assert.equal(state.succeeded_count, 0);
        assert.equal(state.confirmed_history_count, 0);
      }
    },

    async expire(bookingId) {
      await transaction(async (client) => {
        const booking = await query(
          client,
          `UPDATE booking SET created_at = CURRENT_TIMESTAMP - interval '2 minutes',
                              expires_at = CURRENT_TIMESTAMP - interval '1 second'
           WHERE id = $1::uuid AND user_id = ANY($2::uuid[]) AND status = 'PENDING_PAYMENT'
           RETURNING id`,
          [bookingId, ownerIds],
        );
        const hold = await query(
          client,
          `UPDATE inventory_hold SET created_at = CURRENT_TIMESTAMP - interval '2 minutes',
                                     expires_at = CURRENT_TIMESTAMP - interval '1 second'
           WHERE booking_id = $1::uuid AND status = 'HELD' RETURNING id`,
          [bookingId],
        );
        assert.equal(booking.rowCount, 1);
        assert.equal(hold.rowCount, 1);
      });
    },

    async waitForExpiry(bookingId, date, timeoutMs) {
      const state = await pollForWorkerExpiry({
        timeoutMs,
        readState: (remainingTimeoutMs) => readLifecycle(bookingId, remainingTimeoutMs),
      });
      assert.equal(state.held_count, 0);
      assert.equal(state.released_count, 1);
      assert.equal(state.closed_history_count, 1);
      const inventory = await transaction((client) =>
        query(
          client,
          `SELECT held_inventory, sold_inventory FROM daily_inventory
               WHERE room_type_id = $1::uuid AND business_date = $2::date`,
          [fixture.roomTypeId, date],
        ),
      );
      assert.equal(inventory.rows[0]?.held_inventory, 0);
      assert.equal(inventory.rows[0]?.sold_inventory, 0);
    },

    async cleanup() {
      if (closed) return;
      closed = true;
      await runCleanupStages([
        () => this.reset(),
        () => transaction((client) => deleteOwnerData(client)),
        () =>
          transaction(async (client) => {
            await query(client, "DELETE FROM user_identity WHERE user_id = ANY($1::uuid[])", [
              ownerIds,
            ]);
            await query(client, 'DELETE FROM "user" WHERE id = ANY($1::uuid[])', [ownerIds]);
          }),
        () => pool.end(),
      ]);
    },
  };
}

async function createProductionRuntime(options) {
  const baseUrl = options.baseUrl || process.env.API_BASE_URL;
  const fetchImplementation = options.fetch || globalThis.fetch;
  const loginImplementation = options.login || login;
  const timeoutMs = options.requestTimeoutMs ?? requestTimeoutDefault;
  const workerTimeoutMs = options.workerTimeoutMs ?? workerTimeoutDefault;
  assert.equal(typeof baseUrl, "string", "API_BASE_URL is required");
  assert.equal(typeof fetchImplementation, "function", "fetch is required");
  assert.ok(timeoutMs > 0);
  assert.ok(workerTimeoutMs > 0 && workerTimeoutMs <= 30_000);
  const database =
    options.database ?? (await loadDatabase(options.databaseUrl || process.env.DATABASE_URL));
  const sessions = [];

  const fresh = async (date, owner = 0, suffix = date.replaceAll("-", "")) => {
    await database.reset();
    return createBooking(fetchImplementation, baseUrl, sessions[owner], date, suffix, timeoutMs);
  };

  return {
    async initialize() {
      for (const code of loginCodes) {
        const session = await loginImplementation(fetchImplementation, baseUrl, code, timeoutMs);
        database.registerOwner(session.userId);
        sessions.push(session);
      }
      await database.prepare(sessions.map(({ userId }) => userId));
    },

    async verifyBookingQueryIsolation() {
      await database.reset();
      const firstId = await createBooking(
        fetchImplementation,
        baseUrl,
        sessions[0],
        fixture.dates[0],
        "query-a",
        timeoutMs,
      );
      const secondId = await createBooking(
        fetchImplementation,
        baseUrl,
        sessions[1],
        fixture.dates[1],
        "query-b",
        timeoutMs,
      );
      for (const [session, ownedId, foreignId] of [
        [sessions[0], firstId, secondId],
        [sessions[1], secondId, firstId],
      ]) {
        const listed = await requestJson(
          fetchImplementation,
          baseUrl,
          "/bookings?limit=20",
          { method: "GET", headers: authorization(session) },
          [200],
          timeoutMs,
        );
        assert.deepEqual(
          listed.body?.data?.items?.map(({ booking_id: id }) => id),
          [ownedId],
        );
        const detail = await requestJson(
          fetchImplementation,
          baseUrl,
          `/bookings/${ownedId}`,
          { method: "GET", headers: authorization(session) },
          [200],
          timeoutMs,
        );
        assert.equal(detail.body?.data?.booking_id, ownedId);
        await requestJson(
          fetchImplementation,
          baseUrl,
          `/bookings/${foreignId}`,
          { method: "GET", headers: authorization(session) },
          [404],
          timeoutMs,
        );
      }
      await database.assertOwnerBookings(firstId, secondId);
    },

    async verifyMockFailureIdempotency() {
      const bookingId = await fresh(fixture.dates[2]);
      const key = "slice4-payment-failure-00000000000001";
      for (let index = 0; index < 2; index += 1) {
        const result = await paymentRequest(
          fetchImplementation,
          baseUrl,
          sessions[0],
          bookingId,
          key,
          "FAIL",
          [409],
          timeoutMs,
        );
        assertMockFailureResponse(result);
      }
      await database.assertFailedPending(bookingId, fixture.dates[2]);
    },

    async verifyMockSuccessConfirmed() {
      const bookingId = await fresh(fixture.dates[3]);
      const result = await paymentRequest(
        fetchImplementation,
        baseUrl,
        sessions[0],
        bookingId,
        "slice4-payment-success-00000000000001",
        "SUCCEED",
        [201],
        timeoutMs,
      );
      assert.equal(result.body?.data?.status, "CONFIRMED");
      await database.assertConfirmed(bookingId, fixture.dates[3]);
    },

    async verifyCancellationReleased() {
      const bookingId = await fresh(fixture.dates[4]);
      for (let index = 0; index < 2; index += 1) {
        const result = await cancelRequest(
          fetchImplementation,
          baseUrl,
          sessions[0],
          bookingId,
          [200],
          timeoutMs,
        );
        assert.equal(result.body?.data?.status, "CANCELLED");
      }
      await database.assertCancelled(bookingId, fixture.dates[4]);
    },

    async verifyLifecycleRaceSerialized() {
      const bookingId = await fresh(fixture.dates[5]);
      const results = await Promise.all([
        paymentRequest(
          fetchImplementation,
          baseUrl,
          sessions[0],
          bookingId,
          "slice4-payment-race-0000000000000001",
          "SUCCEED",
          [201, 409],
          timeoutMs,
        ),
        cancelRequest(fetchImplementation, baseUrl, sessions[0], bookingId, [200, 409], timeoutMs),
      ]);
      assert.equal(
        results.filter(({ body }) => ["CONFIRMED", "CANCELLED"].includes(body?.data?.status))
          .length,
        1,
        "runtime lifecycle race did not have one winner",
      );
      await database.assertRaceFinal(bookingId, fixture.dates[5]);
    },

    async verifyWorkerExpiryReleased() {
      const bookingId = await fresh(fixture.dates[6]);
      await database.expire(bookingId);
      await database.waitForExpiry(bookingId, fixture.dates[6], workerTimeoutMs);
    },

    cleanup: () => database.cleanup(),
  };
}

export async function verifySliceFourRuntime(options = {}) {
  const runtime = options.runtime ?? (await createProductionRuntime(options));
  const log = options.log || console.log;
  let completed = false;
  try {
    if (typeof runtime.initialize === "function") {
      await runtime.initialize();
    }
    for (const [method, marker] of markers) {
      await runtime[method]();
      log(marker);
    }
    completed = true;
  } finally {
    await runtime.cleanup();
  }
  assert.equal(completed, true);
  log("SLICE4_UAT_READY http://127.0.0.1:3000");
}

const isCli =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isCli) {
  try {
    await verifySliceFourRuntime();
  } catch {
    console.error("SLICE4_RUNTIME_VALIDATION_FAILED");
    process.exitCode = 1;
  }
}

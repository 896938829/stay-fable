import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { clearTimeout, setTimeout } from "node:timers";
import { pathToFileURL } from "node:url";

const fixture = {
  propertyId: "20000000-0000-4000-8000-000000000001",
  propertyName: "西湖云栖酒店",
  roomId: "30000000-0000-4000-8000-000000000001",
  roomName: "舒适大床房",
  uatRoomId: "30000000-0000-4000-8000-000000000002",
  uatRoomName: "家庭双床房",
  dates: ["2026-08-02", "2026-08-04", "2026-08-06", "2026-08-07", "2026-08-09", "2026-08-10"],
};
const loginCodes = ["mock:slice-3-runtime-owner-a", "mock:slice-3-runtime-owner-b"];
const scenarios = {
  replay: ["2026-08-02"],
  concurrency: ["2026-08-04"],
  multiNight: ["2026-08-06", "2026-08-07"],
  changed: ["2026-08-09"],
  expired: ["2026-08-10"],
};
const requestTimeoutDefault = 5_000;
const sqlTimeoutMilliseconds = 5_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bookingNumberPattern = /^SF[0-9]{8}[A-F0-9]{12}$/;
const calendarDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const instantPattern =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const bookingSummaryFields = [
  "booking_id",
  "quote_id",
  "booking_number",
  "status",
  "property_name",
  "room_type_name",
  "checkin",
  "checkout",
  "nights",
  "guests",
  "total_price_cents",
  "currency",
  "expires_at",
  "created_at",
].sort();

function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function requireCalendarDate(value) {
  assert.equal(typeof value, "string");
  assert.match(value, calendarDatePattern);
  const instant = Date.parse(`${value}T00:00:00.000Z`);
  assert.equal(new Date(instant).toISOString().slice(0, 10), value);
  return instant;
}

function requireInstant(value) {
  assert.equal(typeof value, "string");
  const match = instantPattern.exec(value);
  assert.ok(match);
  requireCalendarDate(match[1]);
  assert.ok(Number(match[2]) <= 23);
  assert.ok(Number(match[3]) <= 59);
  assert.ok(Number(match[4]) <= 59);
  const instant = Date.parse(value);
  assert.ok(Number.isFinite(instant));
  return instant;
}

export function assertBookingSummary(value, expected) {
  try {
    assert.ok(isPlainObject(value));
    assert.deepEqual(Object.keys(value).sort(), bookingSummaryFields);
    assert.match(value.booking_id, uuidPattern);
    assert.match(value.quote_id, uuidPattern);
    assert.equal(value.quote_id, expected.quoteId);
    assert.match(value.booking_number, bookingNumberPattern);
    assert.equal(value.status, "PENDING_PAYMENT");
    assert.equal(typeof value.property_name, "string");
    assert.ok(value.property_name.trim().length > 0);
    assert.equal(value.property_name, expected.propertyName);
    assert.equal(typeof value.room_type_name, "string");
    assert.ok(value.room_type_name.trim().length > 0);
    assert.equal(value.room_type_name, expected.roomTypeName);
    const checkinInstant = requireCalendarDate(value.checkin);
    const checkoutInstant = requireCalendarDate(value.checkout);
    assert.equal(value.checkin, expected.checkin);
    assert.equal(value.checkout, expected.checkout);
    const nights = (checkoutInstant - checkinInstant) / 86_400_000;
    assert.ok(Number.isInteger(nights) && nights >= 1 && nights <= 30);
    assert.equal(value.nights, nights);
    assert.equal(value.nights, expected.nights);
    assert.ok(Number.isInteger(value.guests) && value.guests >= 1 && value.guests <= 10);
    assert.equal(value.guests, expected.guests);
    assert.ok(
      Number.isInteger(value.total_price_cents) &&
        value.total_price_cents >= 0 &&
        value.total_price_cents <= 2_147_483_647,
    );
    assert.equal(value.total_price_cents, expected.totalPriceCents);
    assert.equal(value.currency, "CNY");
    const createdAt = requireInstant(value.created_at);
    const expiresAt = requireInstant(value.expires_at);
    assert.ok(expiresAt > createdAt);

    return Object.freeze(
      Object.fromEntries(bookingSummaryFields.map((field) => [field, value[field]])),
    );
  } catch (error) {
    throw new Error("runtime booking summary is invalid", { cause: error });
  }
}

export function assertPersistedBookingState(value, expected) {
  try {
    assert.ok(isPlainObject(value));
    assert.ok(Array.isArray(value.bookings));
    assert.ok(Array.isArray(value.holds));
    assert.ok(Array.isArray(value.histories));
    assert.equal(value.bookings.length, expected.bookingCount);
    assert.equal(value.holds.length, expected.holdCount);
    assert.equal(value.histories.length, expected.historyCount);
    assert.equal(value.histories.length, value.bookings.length);

    const bookingIds = new Set();
    for (const booking of value.bookings) {
      assert.ok(isPlainObject(booking));
      assert.deepEqual(Object.keys(booking).sort(), ["booking_id", "status"]);
      assert.match(booking.booking_id, uuidPattern);
      assert.equal(booking.status, "PENDING_PAYMENT");
      assert.equal(bookingIds.has(booking.booking_id), false);
      bookingIds.add(booking.booking_id);
    }
    for (const hold of value.holds) {
      assert.ok(isPlainObject(hold));
      assert.deepEqual(Object.keys(hold).sort(), ["booking_id", "status"]);
      assert.ok(bookingIds.has(hold.booking_id));
      assert.equal(hold.status, "HELD");
    }
    const historyCounts = new Map();
    for (const history of value.histories) {
      assert.ok(isPlainObject(history));
      assert.deepEqual(Object.keys(history).sort(), [
        "actor_type",
        "booking_id",
        "from_status",
        "reason",
        "to_status",
      ]);
      assert.ok(bookingIds.has(history.booking_id));
      assert.equal(history.from_status, null);
      assert.equal(history.to_status, "PENDING_PAYMENT");
      assert.equal(history.reason, "BOOKING_CREATED");
      assert.equal(history.actor_type, "USER");
      historyCounts.set(history.booking_id, (historyCounts.get(history.booking_id) ?? 0) + 1);
    }
    for (const bookingId of bookingIds) {
      assert.equal(historyCounts.get(bookingId), 1);
    }
  } catch (error) {
    throw new Error("runtime persisted booking state is invalid", { cause: error });
  }
}

async function withTimeout(operation, timeoutMilliseconds, message) {
  let timeout;
  const timeoutFailure = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMilliseconds);
  });
  try {
    return await Promise.race([operation, timeoutFailure]);
  } finally {
    clearTimeout(timeout);
  }
}

function endpoint(baseUrl, path) {
  return new URL(`/api/v1${path}`, `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

async function requestEnvelope(
  fetchImplementation,
  baseUrl,
  path,
  options,
  expectedStatuses,
  timeoutMilliseconds,
) {
  const signal = globalThis.AbortSignal.timeout(timeoutMilliseconds);
  let response;
  try {
    response = await withTimeout(
      fetchImplementation(endpoint(baseUrl, path), {
        ...options,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...options?.headers,
        },
        signal,
      }),
      timeoutMilliseconds,
      "runtime HTTP request timed out",
    );
  } catch (error) {
    if (signal.aborted) {
      throw new Error("runtime HTTP request timed out", { cause: error });
    }
    throw error;
  }
  const body = await withTimeout(
    response.json(),
    timeoutMilliseconds,
    "runtime HTTP response timed out",
  );
  assert.ok(
    expectedStatuses.includes(response.status),
    `runtime HTTP status was ${response.status}`,
  );
  return { body, status: response.status };
}

function bearer(accessToken) {
  return { authorization: `Bearer ${accessToken}` };
}

function quoteBody(dates) {
  return {
    room_type_id: fixture.roomId,
    checkin: dates[0],
    checkout:
      dates.length === 1
        ? new Date(`${dates[0]}T00:00:00.000Z`)
            .toISOString()
            .slice(0, 10)
            .replace(/(\d{4})-(\d{2})-(\d{2})/, (_, year, month, day) =>
              new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + 1))
                .toISOString()
                .slice(0, 10),
            )
        : "2026-08-08",
    guests: 1,
  };
}

async function login(fetchImplementation, baseUrl, code, timeoutMilliseconds) {
  const { body } = await requestEnvelope(
    fetchImplementation,
    baseUrl,
    "/auth/wechat/login",
    { method: "POST", body: JSON.stringify({ code }) },
    [201],
    timeoutMilliseconds,
  );
  assert.equal(typeof body?.data?.access_token, "string", "runtime login omitted access token");
  assert.match(body?.data?.user?.id, uuidPattern, "runtime login omitted a valid user");
  return { accessToken: body.data.access_token, userId: body.data.user.id };
}

async function createQuote(fetchImplementation, baseUrl, session, dates, timeoutMilliseconds) {
  const { body } = await requestEnvelope(
    fetchImplementation,
    baseUrl,
    "/quotes",
    {
      method: "POST",
      headers: bearer(session.accessToken),
      body: JSON.stringify(quoteBody(dates)),
    },
    [201],
    timeoutMilliseconds,
  );
  assert.match(body?.data?.quote_id, uuidPattern, "runtime quote omitted a valid ID");
  return body.data;
}

function expectedBookingFromQuote(quote, dates) {
  try {
    const requested = quoteBody(dates);
    assert.equal(quote.checkin, requested.checkin);
    assert.equal(quote.checkout, requested.checkout);
    assert.equal(quote.nights, dates.length);
    assert.equal(quote.guests, requested.guests);
    assert.equal(quote.property?.name, fixture.propertyName);
    assert.equal(quote.room_type?.name, fixture.roomName);
    assert.ok(
      Number.isInteger(quote.total_price_cents) &&
        quote.total_price_cents >= 0 &&
        quote.total_price_cents <= 2_147_483_647,
    );
    assert.equal(quote.currency, "CNY");
    return {
      quoteId: quote.quote_id,
      checkin: requested.checkin,
      checkout: requested.checkout,
      guests: requested.guests,
      nights: dates.length,
      propertyName: fixture.propertyName,
      roomTypeName: fixture.roomName,
      totalPriceCents: quote.total_price_cents,
    };
  } catch (error) {
    throw new Error("runtime quote booking semantics are invalid", { cause: error });
  }
}

async function createBooking(
  fetchImplementation,
  baseUrl,
  session,
  quoteId,
  idempotencyKey,
  expectedStatuses,
  timeoutMilliseconds,
) {
  return requestEnvelope(
    fetchImplementation,
    baseUrl,
    "/bookings",
    {
      method: "POST",
      headers: { ...bearer(session.accessToken), "idempotency-key": idempotencyKey },
      body: JSON.stringify({ quote_id: quoteId }),
    },
    expectedStatuses,
    timeoutMilliseconds,
  );
}

function requireErrorCode(result, expectedCode) {
  assert.equal(result.status, 409, `runtime ${expectedCode} did not return conflict`);
  assert.equal(result.body?.error?.code, expectedCode, `runtime omitted ${expectedCode}`);
}

export function createBoundedBarrier(participants, timeoutMilliseconds) {
  assert.ok(Number.isInteger(participants) && participants > 0, "invalid barrier participants");
  assert.ok(
    Number.isInteger(timeoutMilliseconds) && timeoutMilliseconds > 0,
    "invalid barrier timeout",
  );
  let arrivals = 0;
  let release;
  let reject;
  let settled = false;
  const ready = new Promise((resolve, rejectPromise) => {
    release = resolve;
    reject = rejectPromise;
  });
  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      reject(new Error("runtime concurrency barrier timed out"));
    }
  }, timeoutMilliseconds);
  return async () => {
    if (settled) {
      return ready;
    }
    arrivals += 1;
    if (arrivals === participants) {
      settled = true;
      clearTimeout(timeout);
      release();
    } else if (arrivals > participants) {
      throw new Error("runtime concurrency barrier overflow");
    }
    await ready;
  };
}

function requireUserIds(userIds) {
  assert.equal(userIds.length, 2, "runtime requires two owner users");
  assert.notEqual(userIds[0], userIds[1], "runtime owner users must be distinct");
  for (const userId of userIds) {
    assert.match(userId, uuidPattern, "runtime owner user must be a UUID");
  }
}

export function assertExactFixtureState(actual, expected, fields) {
  try {
    assert.ok(isPlainObject(actual));
    assert.ok(isPlainObject(expected));
    for (const field of fields) {
      assert.deepEqual(actual[field], expected[field], `fixture field ${field} drifted`);
    }
    return actual;
  } catch (error) {
    throw new Error("runtime fixture state drift", { cause: error });
  }
}

export function assertOwnerInventoryDelta(actual, expected, delta) {
  try {
    assert.ok(Number.isInteger(delta) && delta >= 0);
    assertExactFixtureState(actual, expected, ["total_inventory", "sold_inventory"]);
    assert.equal(actual.held_inventory, expected.held_inventory + delta);
    assert.equal(actual.version, expected.version + delta);
    assert.ok(actual.held_inventory >= delta);
    return {
      ...expected,
      held_inventory: actual.held_inventory - delta,
      version: actual.version + 1,
    };
  } catch (error) {
    throw new Error("runtime owner inventory delta mismatch", { cause: error });
  }
}

async function loadPostgresOwner(databaseUrl) {
  assert.equal(typeof databaseUrl, "string", "DATABASE_URL is required");
  const requireFromArtifact = createRequire("/app/package.json");
  const { Pool } = requireFromArtifact("pg");
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: sqlTimeoutMilliseconds,
    idleTimeoutMillis: sqlTimeoutMilliseconds,
    query_timeout: sqlTimeoutMilliseconds,
    statement_timeout: sqlTimeoutMilliseconds,
    lock_timeout: sqlTimeoutMilliseconds,
    max: 3,
  });
  let snapshots;
  let expectedState;
  let ownerUserIds = [];
  let closed = false;

  const query = (client, text, values = []) =>
    withTimeout(
      client.query({ text, values, query_timeout: sqlTimeoutMilliseconds }),
      sqlTimeoutMilliseconds,
      "runtime SQL query timed out",
    );

  const transaction = async (operation) => {
    const client = await withTimeout(
      pool.connect(),
      sqlTimeoutMilliseconds,
      "runtime SQL connection timed out",
    );
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
        // The original bounded database error is more useful to the caller.
      }
      throw error;
    } finally {
      client.release();
    }
  };

  const cloneSupply = (supply) => new Map([...supply].map(([date, row]) => [date, { ...row }]));

  const requireOwnedDates = (dates) => {
    assert.ok(dates.length > 0, "runtime fixture dates are required");
    assert.equal(new Set(dates).size, dates.length, "runtime fixture dates must be unique");
    assert.ok(
      dates.every((date) => fixture.dates.includes(date)),
      "runtime fixture date is not owned",
    );
    return [...dates].sort();
  };

  const rowsByDate = (rows) => new Map(rows.map((row) => [row.business_date, row]));

  const lockFixtureRows = async (client, dates) => {
    const orderedDates = requireOwnedDates(dates);
    const identity = await query(
      client,
      `
        SELECT room.id::text AS room_id, room.name_zh AS room_name,
               property.id::text AS property_id, property.name_zh AS property_name,
               room.booking_policy_zh AS booking_policy
        FROM room_type room
        JOIN property ON property.id = room.property_id
        WHERE room.id = $1::uuid AND property.id = $2::uuid
        FOR UPDATE OF property, room
      `,
      [fixture.roomId, fixture.propertyId],
    );
    assert.equal(identity.rowCount, 1, "runtime fixture identity mismatch");
    const prices = await query(
      client,
      `
        SELECT business_date::text, sale_price_cents, rack_price_cents
        FROM daily_price price
        WHERE room_type_id = $1::uuid AND business_date = ANY($2::date[])
        ORDER BY business_date ASC
        FOR UPDATE OF price
      `,
      [fixture.roomId, orderedDates],
    );
    const inventories = await query(
      client,
      `
        SELECT business_date::text, total_inventory, held_inventory, sold_inventory, version
        FROM daily_inventory inventory
        WHERE room_type_id = $1::uuid AND business_date = ANY($2::date[])
        ORDER BY business_date ASC
        FOR UPDATE OF inventory
      `,
      [fixture.roomId, orderedDates],
    );
    assert.deepEqual(
      prices.rows.map(({ business_date }) => business_date),
      orderedDates,
      "runtime fixture prices are incomplete",
    );
    assert.deepEqual(
      inventories.rows.map(({ business_date }) => business_date),
      orderedDates,
      "runtime fixture inventory is incomplete",
    );
    return {
      identity: identity.rows[0],
      inventories: rowsByDate(inventories.rows),
      prices: rowsByDate(prices.rows),
    };
  };

  const assertNoForeignOccupancy = async (client, userIds, dates) => {
    const orderedDates = requireOwnedDates(dates);
    const result = await query(
      client,
      `
        SELECT
          (
            SELECT count(*)::integer
            FROM booking
            WHERE room_type_id = $1::uuid
              AND user_id <> ALL($2::uuid[])
              AND checkin_date < ($3::date[])[array_length($3::date[], 1)] + 1
              AND checkout_date > ($3::date[])[1]
          ) AS booking_count,
          (
            SELECT count(*)::integer
            FROM inventory_hold hold
            JOIN booking ON booking.id = hold.booking_id
            WHERE hold.room_type_id = $1::uuid
              AND hold.business_date = ANY($3::date[])
              AND booking.user_id <> ALL($2::uuid[])
          ) AS hold_count
      `,
      [fixture.roomId, userIds, orderedDates],
    );
    assert.equal(result.rows[0]?.booking_count, 0, "runtime fixture has foreign booking drift");
    assert.equal(result.rows[0]?.hold_count, 0, "runtime fixture has foreign hold drift");
  };

  const assertLockedPricesAndPolicy = (locked, expected) => {
    assertExactFixtureState(locked.identity, expected, ["booking_policy"]);
    for (const [date, price] of locked.prices) {
      assertExactFixtureState(price, expected.supply.get(date), [
        "sale_price_cents",
        "rack_price_cents",
      ]);
    }
  };

  const deleteOwnerData = async (client, userIds, locked, workingSupply) => {
    if (userIds.length === 0) {
      return;
    }
    const groups = await query(
      client,
      `
        SELECT hold.room_type_id::text, hold.business_date::text,
               count(*) FILTER (WHERE hold.status = 'HELD')::integer AS held_count
        FROM inventory_hold hold
        JOIN booking ON booking.id = hold.booking_id
        WHERE booking.user_id = ANY($1::uuid[])
        GROUP BY hold.room_type_id, hold.business_date
        ORDER BY hold.room_type_id, hold.business_date
      `,
      [userIds],
    );
    const deltas = new Map();
    for (const group of groups.rows) {
      assert.equal(group.room_type_id, fixture.roomId, "runtime owner hold escaped fixture room");
      assert.ok(
        locked.inventories.has(group.business_date),
        "runtime owner hold escaped locked fixture dates",
      );
      deltas.set(group.business_date, group.held_count);
    }

    for (const [date, actual] of locked.inventories) {
      const expected = workingSupply.get(date);
      assert.ok(expected, "runtime expected inventory is missing");
      const delta = deltas.get(date) ?? 0;
      const next = assertOwnerInventoryDelta(actual, expected, delta);
      if (delta > 0) {
        const result = await query(
          client,
          `
            UPDATE daily_inventory inventory
            SET held_inventory = inventory.held_inventory - $3,
                version = inventory.version + 1,
                updated_at = CURRENT_TIMESTAMP
            WHERE room_type_id = $1::uuid AND business_date = $2::date
              AND total_inventory = $4 AND held_inventory = $5
              AND sold_inventory = $6 AND version = $7
            RETURNING business_date::text, total_inventory, held_inventory,
                      sold_inventory, version
          `,
          [
            fixture.roomId,
            date,
            delta,
            actual.total_inventory,
            actual.held_inventory,
            actual.sold_inventory,
            actual.version,
          ],
        );
        assert.equal(result.rowCount, 1, "runtime owner inventory delta mismatch");
        assertExactFixtureState(result.rows[0], next, [
          "total_inventory",
          "held_inventory",
          "sold_inventory",
          "version",
        ]);
        workingSupply.set(date, next);
      }
    }

    await query(
      client,
      `
        DELETE FROM booking_status_history history
        USING booking
        WHERE history.booking_id = booking.id AND booking.user_id = ANY($1::uuid[])
      `,
      [userIds],
    );
    await query(
      client,
      `
        DELETE FROM inventory_hold hold
        USING booking
        WHERE hold.booking_id = booking.id AND booking.user_id = ANY($1::uuid[])
      `,
      [userIds],
    );
    await query(client, "DELETE FROM booking WHERE user_id = ANY($1::uuid[])", [userIds]);
    await query(client, "DELETE FROM quote WHERE user_id = ANY($1::uuid[])", [userIds]);
  };

  const restoreFixture = async (client, locked, working) => {
    assertLockedPricesAndPolicy(locked, working);
    for (const [date, actual] of locked.inventories) {
      assertExactFixtureState(actual, working.supply.get(date), [
        "total_inventory",
        "held_inventory",
        "sold_inventory",
        "version",
      ]);
    }
    const policy = await query(
      client,
      `
        UPDATE room_type
        SET booking_policy_zh = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1::uuid AND booking_policy_zh = $3
        RETURNING booking_policy_zh AS booking_policy
      `,
      [fixture.roomId, snapshots.bookingPolicy, working.booking_policy],
    );
    assert.equal(policy.rowCount, 1, "runtime cleanup policy drift");
    working.booking_policy = snapshots.bookingPolicy;
    for (const row of snapshots.supply) {
      const expected = working.supply.get(row.business_date);
      if (
        expected.sale_price_cents !== row.sale_price_cents ||
        expected.rack_price_cents !== row.rack_price_cents
      ) {
        const price = await query(
          client,
          `
            UPDATE daily_price
            SET sale_price_cents = $3, rack_price_cents = $4,
                updated_at = CURRENT_TIMESTAMP
            WHERE room_type_id = $1::uuid AND business_date = $2::date
              AND sale_price_cents = $5 AND rack_price_cents = $6
            RETURNING business_date::text, sale_price_cents, rack_price_cents
          `,
          [
            fixture.roomId,
            row.business_date,
            row.sale_price_cents,
            row.rack_price_cents,
            expected.sale_price_cents,
            expected.rack_price_cents,
          ],
        );
        assert.equal(price.rowCount, 1, "runtime cleanup price drift");
        expected.sale_price_cents = row.sale_price_cents;
        expected.rack_price_cents = row.rack_price_cents;
      }
      const inventory = await query(
        client,
        `
          UPDATE daily_inventory inventory
          SET total_inventory = $3, held_inventory = $4, sold_inventory = $5,
              version = inventory.version + 1, updated_at = CURRENT_TIMESTAMP
          WHERE room_type_id = $1::uuid AND business_date = $2::date
            AND total_inventory = $6 AND held_inventory = $7
            AND sold_inventory = $8 AND version = $9
          RETURNING business_date::text, total_inventory, held_inventory,
                    sold_inventory, version
        `,
        [
          fixture.roomId,
          row.business_date,
          row.total_inventory,
          row.held_inventory,
          row.sold_inventory,
          expected.total_inventory,
          expected.held_inventory,
          expected.sold_inventory,
          expected.version,
        ],
      );
      assert.equal(inventory.rowCount, 1, "runtime cleanup inventory drift");
      working.supply.set(row.business_date, {
        ...expected,
        total_inventory: row.total_inventory,
        held_inventory: row.held_inventory,
        sold_inventory: row.sold_inventory,
        version: expected.version + 1,
      });
    }
  };

  return {
    async prepare(userIds) {
      requireUserIds(userIds);
      await transaction(async (client) => {
        const locked = await lockFixtureRows(client, fixture.dates);
        await assertNoForeignOccupancy(client, userIds, fixture.dates);
        const ownerData = await query(
          client,
          `
            SELECT
              (SELECT count(*)::integer FROM booking
               WHERE user_id = ANY($1::uuid[])) AS booking_count,
              (SELECT count(*)::integer FROM inventory_hold hold
               JOIN booking ON booking.id = hold.booking_id
               WHERE booking.user_id = ANY($1::uuid[])) AS hold_count
          `,
          [userIds],
        );
        assert.equal(ownerData.rows[0]?.booking_count, 0, "runtime owner has stale bookings");
        assert.equal(ownerData.rows[0]?.hold_count, 0, "runtime owner has stale holds");
        await query(client, "DELETE FROM quote WHERE user_id = ANY($1::uuid[])", [userIds]);
        const uatIdentity = await query(
          client,
          `
            SELECT room.id::text AS room_id, room.name_zh AS room_name,
                   property.id::text AS property_id, property.name_zh AS property_name
            FROM room_type room
            JOIN property ON property.id = room.property_id
            WHERE room.id = $1::uuid AND property.id = $2::uuid
          `,
          [fixture.uatRoomId, fixture.propertyId],
        );
        assert.deepEqual(
          [locked.identity, uatIdentity.rows[0]].map(
            ({ room_id, room_name, property_id, property_name }) => ({
              room_id,
              room_name,
              property_id,
              property_name,
            }),
          ),
          [
            {
              room_id: fixture.roomId,
              room_name: fixture.roomName,
              property_id: fixture.propertyId,
              property_name: fixture.propertyName,
            },
            {
              room_id: fixture.uatRoomId,
              room_name: fixture.uatRoomName,
              property_id: fixture.propertyId,
              property_name: fixture.propertyName,
            },
          ],
          "runtime fixture identity mismatch",
        );
        const supply = fixture.dates.map((date) => ({
          ...locked.prices.get(date),
          ...locked.inventories.get(date),
        }));
        assert.ok(
          supply.every(
            ({ held_inventory, sold_inventory }) => held_inventory === 0 && sold_inventory === 0,
          ),
          "runtime fixture supply is already occupied",
        );
        snapshots = {
          bookingPolicy: locked.identity.booking_policy,
          supply: supply.map((row) => ({ ...row })),
        };
        expectedState = {
          booking_policy: snapshots.bookingPolicy,
          supply: rowsByDate(supply.map((row) => ({ ...row }))),
        };
      });
      ownerUserIds = [...userIds];
    },

    async resetInventory({ dates, totals, userIds }) {
      requireUserIds(userIds);
      assert.equal(dates.length, totals.length, "runtime reset dates/totals mismatch");
      requireOwnedDates(dates);
      const working = { ...expectedState, supply: cloneSupply(expectedState.supply) };
      await transaction(async (client) => {
        const locked = await lockFixtureRows(client, fixture.dates);
        await assertNoForeignOccupancy(client, userIds, fixture.dates);
        assertLockedPricesAndPolicy(locked, working);
        await deleteOwnerData(client, userIds, locked, working.supply);
        for (const [index, date] of dates.entries()) {
          const expected = working.supply.get(date);
          const result = await query(
            client,
            `
              UPDATE daily_inventory inventory
              SET total_inventory = $3, held_inventory = 0, sold_inventory = 0,
                  version = inventory.version + 1, updated_at = CURRENT_TIMESTAMP
              WHERE room_type_id = $1::uuid AND business_date = $2::date
                AND total_inventory = $4 AND held_inventory = $5
                AND sold_inventory = $6 AND version = $7
              RETURNING business_date::text, total_inventory, held_inventory,
                        sold_inventory, version
            `,
            [
              fixture.roomId,
              date,
              totals[index],
              expected.total_inventory,
              expected.held_inventory,
              expected.sold_inventory,
              expected.version,
            ],
          );
          assert.equal(result.rowCount, 1, "runtime reset inventory drift");
          working.supply.set(date, {
            ...expected,
            total_inventory: totals[index],
            held_inventory: 0,
            sold_inventory: 0,
            version: expected.version + 1,
          });
        }
      });
      expectedState = working;
    },

    async setInventoryTotal(date, total) {
      requireOwnedDates([date]);
      const working = { ...expectedState, supply: cloneSupply(expectedState.supply) };
      await transaction(async (client) => {
        const locked = await lockFixtureRows(client, [date]);
        await assertNoForeignOccupancy(client, ownerUserIds, [date]);
        assertLockedPricesAndPolicy(locked, working);
        const actual = locked.inventories.get(date);
        const expected = working.supply.get(date);
        assertExactFixtureState(actual, expected, [
          "total_inventory",
          "held_inventory",
          "sold_inventory",
          "version",
        ]);
        const result = await query(
          client,
          `
            UPDATE daily_inventory inventory
            SET total_inventory = $3, version = version + 1, updated_at = CURRENT_TIMESTAMP
            WHERE room_type_id = $1::uuid AND business_date = $2::date
              AND total_inventory = $4 AND held_inventory = $5
              AND sold_inventory = $6 AND version = $7
            RETURNING business_date::text, total_inventory, held_inventory,
                      sold_inventory, version
          `,
          [
            fixture.roomId,
            date,
            total,
            expected.total_inventory,
            expected.held_inventory,
            expected.sold_inventory,
            expected.version,
          ],
        );
        assert.equal(result.rowCount, 1, "runtime inventory mutation was not isolated");
        working.supply.set(date, {
          ...expected,
          total_inventory: total,
          version: expected.version + 1,
        });
      });
      expectedState = working;
    },

    async changePrice(date) {
      requireOwnedDates([date]);
      const working = { ...expectedState, supply: cloneSupply(expectedState.supply) };
      await transaction(async (client) => {
        const locked = await lockFixtureRows(client, [date]);
        await assertNoForeignOccupancy(client, ownerUserIds, [date]);
        assertLockedPricesAndPolicy(locked, working);
        assertExactFixtureState(locked.inventories.get(date), working.supply.get(date), [
          "total_inventory",
          "held_inventory",
          "sold_inventory",
          "version",
        ]);
        const expected = working.supply.get(date);
        const result = await query(
          client,
          `
            UPDATE daily_price
            SET sale_price_cents = $3, updated_at = CURRENT_TIMESTAMP
            WHERE room_type_id = $1::uuid AND business_date = $2::date
              AND sale_price_cents = $4 AND rack_price_cents = $5
            RETURNING business_date::text, sale_price_cents, rack_price_cents
          `,
          [
            fixture.roomId,
            date,
            expected.sale_price_cents + 1,
            expected.sale_price_cents,
            expected.rack_price_cents,
          ],
        );
        assert.equal(result.rowCount, 1, "runtime price mutation missed fixture");
        working.supply.set(date, { ...expected, sale_price_cents: expected.sale_price_cents + 1 });
      });
      expectedState = working;
    },

    async expireQuote(quoteId, userId) {
      await transaction(async (client) => {
        const result = await query(
          client,
          `
            UPDATE quote
            SET created_at = CURRENT_TIMESTAMP - interval '1 minute',
                expires_at = CURRENT_TIMESTAMP - interval '1 second'
            WHERE id = $1::uuid AND user_id = $2::uuid
            RETURNING id
          `,
          [quoteId, userId],
        );
        assert.equal(result.rowCount, 1, "runtime quote expiry mutation missed owner quote");
      });
    },

    async assertQuoteOwner(quoteId, userId) {
      await transaction(async (client) => {
        const result = await query(
          client,
          "SELECT count(*)::integer AS count FROM quote WHERE id = $1::uuid AND user_id = $2::uuid",
          [quoteId, userId],
        );
        assert.equal(result.rows[0]?.count, 1, "runtime quote owner mismatch");
      });
    },

    async assertReplacementQuote(quoteId, userId) {
      await this.assertQuoteOwner(quoteId, userId);
    },

    async assertState({ userIds, dates, bookingCount, holdCount, historyCount, heldByDate }) {
      await transaction(async (client) => {
        const locked = await lockFixtureRows(client, fixture.dates);
        await assertNoForeignOccupancy(client, userIds, fixture.dates);
        assertLockedPricesAndPolicy(locked, expectedState);
        const bookings = await query(
          client,
          `
            SELECT id::text AS booking_id, status::text AS status
            FROM booking
            WHERE user_id = ANY($1::uuid[]) AND room_type_id = $2::uuid
            ORDER BY id
          `,
          [userIds, fixture.roomId],
        );
        const holds = await query(
          client,
          `
            SELECT hold.booking_id::text AS booking_id, hold.status::text AS status
            FROM inventory_hold hold
            JOIN booking ON booking.id = hold.booking_id
            WHERE booking.user_id = ANY($1::uuid[]) AND hold.room_type_id = $2::uuid
            ORDER BY hold.booking_id, hold.business_date
          `,
          [userIds, fixture.roomId],
        );
        const histories = await query(
          client,
          `
            SELECT history.booking_id::text AS booking_id,
                   history.from_status::text AS from_status,
                   history.to_status::text AS to_status,
                   history.reason,
                   history.actor_type::text AS actor_type
            FROM booking_status_history history
            JOIN booking ON booking.id = history.booking_id
            WHERE booking.user_id = ANY($1::uuid[])
            ORDER BY history.booking_id, history.created_at, history.id
          `,
          [userIds],
        );
        assertPersistedBookingState(
          {
            bookings: bookings.rows,
            holds: holds.rows,
            histories: histories.rows,
          },
          { bookingCount, holdCount, historyCount },
        );
        const ownerGroups = await query(
          client,
          `
            SELECT hold.business_date::text, count(*)::integer AS held_count
            FROM inventory_hold hold
            JOIN booking ON booking.id = hold.booking_id
            WHERE booking.user_id = ANY($1::uuid[]) AND hold.room_type_id = $2::uuid
              AND hold.status = 'HELD'
            GROUP BY hold.business_date
            ORDER BY business_date
          `,
          [userIds, fixture.roomId],
        );
        const deltas = new Map(ownerGroups.rows.map((row) => [row.business_date, row.held_count]));
        for (const [date, actual] of locked.inventories) {
          assertOwnerInventoryDelta(actual, expectedState.supply.get(date), deltas.get(date) ?? 0);
        }
        assert.deepEqual(
          dates.map((date) => locked.inventories.get(date).held_inventory),
          heldByDate,
          "runtime inventory state mismatch",
        );
      });
    },

    async cleanup(userIds) {
      if (closed) {
        return;
      }
      closed = true;
      const errors = [];
      const cleanupStep = async (operation) => {
        try {
          await operation();
        } catch (error) {
          errors.push(error);
        }
      };
      let fixtureCleaned = snapshots === undefined;
      if (snapshots !== undefined) {
        const working = { ...expectedState, supply: cloneSupply(expectedState.supply) };
        await cleanupStep(async () => {
          await transaction(async (client) => {
            const locked = await lockFixtureRows(client, fixture.dates);
            await assertNoForeignOccupancy(client, userIds, fixture.dates);
            assertLockedPricesAndPolicy(locked, working);
            await deleteOwnerData(client, userIds, locked, working.supply);
            const relocked = await lockFixtureRows(client, fixture.dates);
            await restoreFixture(client, relocked, working);
          });
          expectedState = working;
          fixtureCleaned = true;
        });
      }
      if (fixtureCleaned) {
        await cleanupStep(() =>
          transaction(async (client) => {
            if (userIds.length === 0) {
              return;
            }
            await query(client, "DELETE FROM user_identity WHERE user_id = ANY($1::uuid[])", [
              userIds,
            ]);
            await query(client, 'DELETE FROM "user" WHERE id = ANY($1::uuid[])', [userIds]);
          }),
        );
      }
      await cleanupStep(() =>
        withTimeout(pool.end(), sqlTimeoutMilliseconds, "runtime SQL pool close timed out"),
      );
      if (errors.length > 0) {
        throw new AggregateError(errors, "runtime owner cleanup failed");
      }
    },
  };
}

export async function verifySliceThreeRuntime(options = {}) {
  const baseUrl = options.baseUrl || process.env.API_BASE_URL;
  const fetchImplementation = options.fetch || globalThis.fetch;
  const log = options.log || console.log;
  const requestTimeoutMs = options.requestTimeoutMs ?? requestTimeoutDefault;
  const barrierTimeoutMs = options.barrierTimeoutMs ?? 5_000;
  const barrierFactory = options.barrierFactory ?? createBoundedBarrier;
  assert.equal(typeof baseUrl, "string", "API_BASE_URL is required");
  assert.equal(typeof fetchImplementation, "function", "fetch is required");
  assert.ok(Number.isInteger(requestTimeoutMs) && requestTimeoutMs > 0, "invalid HTTP timeout");
  assert.ok(Number.isInteger(barrierTimeoutMs) && barrierTimeoutMs > 0, "invalid barrier timeout");

  const database =
    options.database ?? (await loadPostgresOwner(options.databaseUrl || process.env.DATABASE_URL));
  const sessions = [];
  const userIds = [];
  try {
    for (const code of loginCodes) {
      const session = await login(fetchImplementation, baseUrl, code, requestTimeoutMs);
      sessions.push(session);
      userIds.push(session.userId);
    }
    requireUserIds(userIds);
    await database.prepare(userIds);

    await database.resetInventory({ dates: scenarios.replay, totals: [1], userIds });
    const replayQuote = await createQuote(
      fetchImplementation,
      baseUrl,
      sessions[0],
      scenarios.replay,
      requestTimeoutMs,
    );
    await database.assertQuoteOwner(replayQuote.quote_id, userIds[0]);
    log("SLICE3_QUOTE_CREATED");
    const replayKey = "slice3-replay-key-000000000000000001";
    const replayExpected = expectedBookingFromQuote(replayQuote, scenarios.replay);
    const firstBooking = await createBooking(
      fetchImplementation,
      baseUrl,
      sessions[0],
      replayQuote.quote_id,
      replayKey,
      [201],
      requestTimeoutMs,
    );
    const replayedBooking = await createBooking(
      fetchImplementation,
      baseUrl,
      sessions[0],
      replayQuote.quote_id,
      replayKey,
      [200],
      requestTimeoutMs,
    );
    const firstSummary = assertBookingSummary(firstBooking.body?.data, replayExpected);
    const replayedSummary = assertBookingSummary(replayedBooking.body?.data, replayExpected);
    assert.equal(replayedSummary.booking_id, firstSummary.booking_id, "replay booking ID changed");
    assert.equal(
      replayedSummary.booking_number,
      firstSummary.booking_number,
      "replay booking number changed",
    );
    assert.deepEqual(replayedSummary, firstSummary, "replay fields changed");
    await database.assertState({
      userIds,
      dates: scenarios.replay,
      bookingCount: 1,
      holdCount: 1,
      historyCount: 1,
      heldByDate: [1],
    });
    log("SLICE3_IDEMPOTENT_REPLAY");

    await database.resetInventory({ dates: scenarios.concurrency, totals: [1], userIds });
    const competingQuotes = await Promise.all(
      sessions.map((session) =>
        createQuote(fetchImplementation, baseUrl, session, scenarios.concurrency, requestTimeoutMs),
      ),
    );
    const arrive = barrierFactory(2, barrierTimeoutMs);
    const competingResults = await Promise.all(
      sessions.map(async (session, index) => {
        await arrive();
        return createBooking(
          fetchImplementation,
          baseUrl,
          session,
          competingQuotes[index].quote_id,
          `slice3-concurrency-key-00000000000${index}`,
          [201, 409],
          requestTimeoutMs,
        );
      }),
    );
    assert.deepEqual(
      competingResults.map(({ status }) => status).sort(),
      [201, 409],
      "last room was not serialized",
    );
    requireErrorCode(
      competingResults.find(({ status }) => status === 409),
      "INVENTORY_UNAVAILABLE",
    );
    const winnerIndex = competingResults.findIndex(({ status }) => status === 201);
    assert.ok(winnerIndex >= 0, "last room winner is missing");
    assertBookingSummary(
      competingResults[winnerIndex].body?.data,
      expectedBookingFromQuote(competingQuotes[winnerIndex], scenarios.concurrency),
    );
    await database.assertState({
      userIds,
      dates: scenarios.concurrency,
      bookingCount: 1,
      holdCount: 1,
      historyCount: 1,
      heldByDate: [1],
    });
    log("SLICE3_LAST_ROOM_SERIALIZED");

    await database.resetInventory({ dates: scenarios.multiNight, totals: [1, 1], userIds });
    const multiQuote = await createQuote(
      fetchImplementation,
      baseUrl,
      sessions[0],
      scenarios.multiNight,
      requestTimeoutMs,
    );
    await database.setInventoryTotal(scenarios.multiNight[1], 0);
    const multiResult = await createBooking(
      fetchImplementation,
      baseUrl,
      sessions[0],
      multiQuote.quote_id,
      "slice3-multi-night-key-0000000000001",
      [409],
      requestTimeoutMs,
    );
    requireErrorCode(multiResult, "INVENTORY_UNAVAILABLE");
    await database.assertState({
      userIds,
      dates: scenarios.multiNight,
      bookingCount: 0,
      holdCount: 0,
      historyCount: 0,
      heldByDate: [0, 0],
    });
    log("SLICE3_MULTI_NIGHT_ROLLED_BACK");

    await database.resetInventory({ dates: scenarios.changed, totals: [1], userIds });
    const changedQuote = await createQuote(
      fetchImplementation,
      baseUrl,
      sessions[0],
      scenarios.changed,
      requestTimeoutMs,
    );
    await database.changePrice(scenarios.changed[0]);
    const changedResult = await createBooking(
      fetchImplementation,
      baseUrl,
      sessions[0],
      changedQuote.quote_id,
      "slice3-changed-key-00000000000000001",
      [409],
      requestTimeoutMs,
    );
    requireErrorCode(changedResult, "QUOTE_CHANGED");
    const replacementQuoteId = changedResult.body?.error?.details?.replacement_quote?.quote_id;
    assert.match(replacementQuoteId, uuidPattern, "replacement quote ID is invalid");
    await database.assertReplacementQuote(replacementQuoteId, userIds[0]);
    await database.assertState({
      userIds,
      dates: scenarios.changed,
      bookingCount: 0,
      holdCount: 0,
      historyCount: 0,
      heldByDate: [0],
    });
    log("SLICE3_QUOTE_CHANGED_NO_HOLD");

    await database.resetInventory({ dates: scenarios.expired, totals: [1], userIds });
    const expiredQuote = await createQuote(
      fetchImplementation,
      baseUrl,
      sessions[0],
      scenarios.expired,
      requestTimeoutMs,
    );
    await database.expireQuote(expiredQuote.quote_id, userIds[0]);
    const expiredResult = await createBooking(
      fetchImplementation,
      baseUrl,
      sessions[0],
      expiredQuote.quote_id,
      "slice3-expired-key-00000000000000001",
      [409],
      requestTimeoutMs,
    );
    requireErrorCode(expiredResult, "QUOTE_EXPIRED");
    await database.assertState({
      userIds,
      dates: scenarios.expired,
      bookingCount: 0,
      holdCount: 0,
      historyCount: 0,
      heldByDate: [0],
    });
    log("SLICE3_QUOTE_EXPIRED_NO_HOLD");
  } finally {
    await database.cleanup(userIds);
  }
  log("SLICE3_UAT_READY http://127.0.0.1:3000");
}

const isCli =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isCli) {
  try {
    await verifySliceThreeRuntime();
  } catch {
    console.error("SLICE3_RUNTIME_VALIDATION_FAILED");
    process.exitCode = 1;
  }
}

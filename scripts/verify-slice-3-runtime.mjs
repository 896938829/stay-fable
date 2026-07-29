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

  const deleteOwnerData = async (client, userIds) => {
    if (userIds.length === 0) {
      return;
    }
    await query(
      client,
      `
        WITH owner_holds AS (
          SELECT hold.room_type_id, hold.business_date, count(*)::integer AS held_count
          FROM inventory_hold hold
          JOIN booking ON booking.id = hold.booking_id
          WHERE booking.user_id = ANY($1::uuid[]) AND hold.status = 'HELD'
          GROUP BY hold.room_type_id, hold.business_date
        )
        UPDATE daily_inventory inventory
        SET held_inventory = inventory.held_inventory - owner_holds.held_count,
            version = inventory.version + 1,
            updated_at = CURRENT_TIMESTAMP
        FROM owner_holds
        WHERE inventory.room_type_id = owner_holds.room_type_id
          AND inventory.business_date = owner_holds.business_date
          AND inventory.held_inventory >= owner_holds.held_count
      `,
      [userIds],
    );
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

  const assertNoForeignOccupancy = async (client, userIds, dates) => {
    const result = await query(
      client,
      `
        SELECT count(*)::integer AS count
        FROM booking
        WHERE room_type_id = $1::uuid
          AND user_id <> ALL($2::uuid[])
          AND checkin_date < ($3::date[])[array_length($3::date[], 1)] + 1
          AND checkout_date > ($3::date[])[1]
      `,
      [fixture.roomId, userIds, dates],
    );
    assert.equal(result.rows[0]?.count, 0, "runtime fixture has non-owner occupancy");
  };

  return {
    async prepare(userIds) {
      requireUserIds(userIds);
      await transaction(async (client) => {
        await deleteOwnerData(client, userIds);
        const identity = await query(
          client,
          `
            SELECT room.id::text AS room_id, room.name_zh AS room_name,
                   property.id::text AS property_id, property.name_zh AS property_name,
                   room.booking_policy_zh AS booking_policy
            FROM room_type room
            JOIN property ON property.id = room.property_id
            WHERE room.id = ANY($1::uuid[]) AND property.id = $2::uuid
            ORDER BY room.id
            FOR UPDATE OF room, property
          `,
          [[fixture.roomId, fixture.uatRoomId], fixture.propertyId],
        );
        assert.deepEqual(
          identity.rows.map(({ room_id, room_name, property_id, property_name }) => ({
            room_id,
            room_name,
            property_id,
            property_name,
          })),
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
        const supply = await query(
          client,
          `
            SELECT price.business_date::text, price.sale_price_cents, price.rack_price_cents,
                   inventory.total_inventory, inventory.held_inventory,
                   inventory.sold_inventory, inventory.version
            FROM daily_price price
            JOIN daily_inventory inventory
              ON inventory.room_type_id = price.room_type_id
             AND inventory.business_date = price.business_date
            WHERE price.room_type_id = $1::uuid
              AND price.business_date = ANY($2::date[])
            ORDER BY price.business_date
            FOR UPDATE OF price, inventory
          `,
          [fixture.roomId, fixture.dates],
        );
        assert.equal(
          supply.rows.length,
          fixture.dates.length,
          "runtime fixture supply is incomplete",
        );
        assert.ok(
          supply.rows.every(
            ({ held_inventory, sold_inventory }) => held_inventory === 0 && sold_inventory === 0,
          ),
          "runtime fixture supply is already occupied",
        );
        snapshots = {
          bookingPolicy: identity.rows[0].booking_policy,
          supply: supply.rows,
        };
      });
    },

    async resetInventory({ dates, totals, userIds }) {
      requireUserIds(userIds);
      assert.equal(dates.length, totals.length, "runtime reset dates/totals mismatch");
      assert.ok(
        dates.every((date) => fixture.dates.includes(date)),
        "runtime reset date is not owned",
      );
      await transaction(async (client) => {
        await assertNoForeignOccupancy(client, userIds, dates);
        await deleteOwnerData(client, userIds);
        for (const [index, date] of dates.entries()) {
          const result = await query(
            client,
            `
              UPDATE daily_inventory
              SET total_inventory = $3, held_inventory = 0, sold_inventory = 0,
                  version = version + 1, updated_at = CURRENT_TIMESTAMP
              WHERE room_type_id = $1::uuid AND business_date = $2::date
              RETURNING room_type_id
            `,
            [fixture.roomId, date, totals[index]],
          );
          assert.equal(result.rowCount, 1, "runtime reset missed fixture inventory");
        }
      });
    },

    async setInventoryTotal(date, total) {
      assert.ok(fixture.dates.includes(date), "runtime inventory date is not owned");
      await transaction(async (client) => {
        const result = await query(
          client,
          `
            UPDATE daily_inventory
            SET total_inventory = $3, version = version + 1, updated_at = CURRENT_TIMESTAMP
            WHERE room_type_id = $1::uuid AND business_date = $2::date
              AND held_inventory = 0 AND sold_inventory = 0
            RETURNING room_type_id
          `,
          [fixture.roomId, date, total],
        );
        assert.equal(result.rowCount, 1, "runtime inventory mutation was not isolated");
      });
    },

    async changePrice(date) {
      assert.ok(fixture.dates.includes(date), "runtime price date is not owned");
      await transaction(async (client) => {
        const result = await query(
          client,
          `
            UPDATE daily_price
            SET sale_price_cents = sale_price_cents + $3, updated_at = CURRENT_TIMESTAMP
            WHERE room_type_id = $1::uuid AND business_date = $2::date
            RETURNING room_type_id
          `,
          [fixture.roomId, date, 1],
        );
        assert.equal(result.rowCount, 1, "runtime price mutation missed fixture");
      });
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
        const counts = await query(
          client,
          `
            SELECT
              (SELECT count(*)::integer FROM booking
               WHERE user_id = ANY($1::uuid[]) AND room_type_id = $2::uuid) AS booking_count,
              (SELECT count(*)::integer FROM inventory_hold hold
               JOIN booking ON booking.id = hold.booking_id
               WHERE booking.user_id = ANY($1::uuid[]) AND hold.room_type_id = $2::uuid) AS hold_count,
              (SELECT count(*)::integer FROM booking_status_history history
               JOIN booking ON booking.id = history.booking_id
               WHERE booking.user_id = ANY($1::uuid[])) AS history_count
          `,
          [userIds, fixture.roomId],
        );
        assert.deepEqual(counts.rows[0], {
          booking_count: bookingCount,
          hold_count: holdCount,
          history_count: historyCount,
        });
        const inventory = await query(
          client,
          `
            SELECT business_date::text, held_inventory
            FROM daily_inventory
            WHERE room_type_id = $1::uuid AND business_date = ANY($2::date[])
            ORDER BY business_date
          `,
          [fixture.roomId, dates],
        );
        assert.deepEqual(
          inventory.rows.map(({ held_inventory }) => held_inventory),
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
      await cleanupStep(() =>
        transaction(async (client) => {
          await deleteOwnerData(client, userIds);
        }),
      );
      await cleanupStep(async () => {
        if (snapshots === undefined) {
          return;
        }
        await transaction(async (client) => {
          await query(
            client,
            `
              UPDATE room_type
              SET booking_policy_zh = $2, updated_at = CURRENT_TIMESTAMP
              WHERE id = $1::uuid
            `,
            [fixture.roomId, snapshots.bookingPolicy],
          );
          for (const row of snapshots.supply) {
            await query(
              client,
              `
                UPDATE daily_price
                SET sale_price_cents = $3, rack_price_cents = $4,
                    updated_at = CURRENT_TIMESTAMP
                WHERE room_type_id = $1::uuid AND business_date = $2::date
              `,
              [fixture.roomId, row.business_date, row.sale_price_cents, row.rack_price_cents],
            );
            await query(
              client,
              `
                UPDATE daily_inventory
                SET total_inventory = $3, held_inventory = $4, sold_inventory = $5,
                    version = $6, updated_at = CURRENT_TIMESTAMP
                WHERE room_type_id = $1::uuid AND business_date = $2::date
              `,
              [
                fixture.roomId,
                row.business_date,
                row.total_inventory,
                row.held_inventory,
                row.sold_inventory,
                row.version,
              ],
            );
          }
        });
      });
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
    assert.deepEqual(replayedBooking.body?.data, firstBooking.body?.data, "replay fields changed");
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

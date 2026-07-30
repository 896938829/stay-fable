import { describe, expect, it, vi } from "vitest";

import {
  BookingExpiryRepository,
  type BookingExpiryResult,
} from "../src/booking-expiry.repository.js";
import type { DatabaseClient, DatabasePool } from "../src/database.js";

const NOW = new Date("2030-01-01T00:20:00.000Z");
const BOOKING_ID = "10000000-0000-4000-8000-000000000001";
const ROOM_TYPE_ID = "20000000-0000-4000-8000-000000000001";
const HOLD_ID_1 = "30000000-0000-4000-8000-000000000001";
const HOLD_ID_2 = "30000000-0000-4000-8000-000000000002";
const HISTORY_ID = "40000000-0000-4000-8000-000000000001";
const BOOKING_NUMBER = "SF20300101ABCDEF123456";

type QueryInput = string | { text: string; values?: unknown[] };

const result = (rows: unknown[]) => ({
  command: "",
  fields: [],
  oid: 0,
  rowCount: rows.length,
  rows,
});

const bookingRow = {
  bookingId: BOOKING_ID,
  bookingNumber: BOOKING_NUMBER,
  roomTypeId: ROOM_TYPE_ID,
  checkin: "2030-02-01",
  checkout: "2030-02-03",
};

const holdRows = [
  { id: HOLD_ID_1, roomTypeId: ROOM_TYPE_ID, businessDate: "2030-02-01" },
  { id: HOLD_ID_2, roomTypeId: ROOM_TYPE_ID, businessDate: "2030-02-02" },
];

const inventoryRows = [
  { roomTypeId: ROOM_TYPE_ID, businessDate: "2030-02-01" },
  { roomTypeId: ROOM_TYPE_ID, businessDate: "2030-02-02" },
];

const createHarness = (scriptedRows: unknown[][]) => {
  let index = 0;
  const queries: QueryInput[] = [];
  const query = vi.fn<(queryInput: QueryInput) => Promise<ReturnType<typeof result>>>(
    (queryInput) => {
      queries.push(queryInput);
      if (typeof queryInput === "string") {
        return Promise.resolve(result([]));
      }
      const rows = scriptedRows[index];
      index += 1;
      if (rows === undefined) {
        return Promise.reject(new Error("Unexpected repository query"));
      }
      return Promise.resolve(result(rows));
    },
  );
  const release = vi.fn();
  const client = { query, release } as unknown as DatabaseClient;
  const connect = vi.fn(() => Promise.resolve(client));
  const pool = {
    connect,
    end: vi.fn(() => Promise.resolve()),
  } as unknown as DatabasePool;
  return { client, connect, pool, queries, query, release };
};

describe("BookingExpiryRepository.closeNextExpired", () => {
  it("commits NONE when no pending expired booking can be locked", async () => {
    const { pool, queries, release } = createHarness([[]]);
    const repository = new BookingExpiryRepository(pool);

    await expect(repository.closeNextExpired(NOW)).resolves.toEqual({ kind: "NONE" });

    expect(queries[0]).toBe("BEGIN");
    const selection = queries[1];
    if (selection === undefined || typeof selection === "string") {
      throw new Error("Expected a parameterized booking selection");
    }
    expect(selection.text).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(selection.values).toEqual([NOW, []]);
    expect(queries[2]).toBe("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });

  it("parameterizes booking exclusions when selecting the next expired booking", async () => {
    const { pool, queries } = createHarness([[]]);
    const repository = new BookingExpiryRepository(pool);

    await expect(repository.closeNextExpired(NOW, [BOOKING_ID])).resolves.toEqual({
      kind: "NONE",
    });

    const selection = queries[1];
    if (selection === undefined || typeof selection === "string") {
      throw new Error("Expected a parameterized booking selection");
    }
    expect(selection.text).toMatch(/NOT.+ANY/s);
    expect(selection.values).toEqual([NOW, [BOOKING_ID]]);
  });

  it("releases every night and records one system timeout transition atomically", async () => {
    const { pool, queries, release } = createHarness([
      [bookingRow],
      holdRows,
      inventoryRows,
      [inventoryRows[0]],
      [inventoryRows[1]],
      [{ id: HOLD_ID_1 }, { id: HOLD_ID_2 }],
      [{ id: BOOKING_ID }],
      [{ id: HISTORY_ID }],
    ]);
    const repository = new BookingExpiryRepository(pool);

    const outcome: BookingExpiryResult = await repository.closeNextExpired(NOW);

    expect(outcome).toEqual({ kind: "CLOSED", bookingNumber: BOOKING_NUMBER });
    expect(queries[0]).toBe("BEGIN");
    expect(queries.at(-1)).toBe("COMMIT");
    const parameterized = queries.filter(
      (query): query is { text: string; values?: unknown[] } => typeof query !== "string",
    );
    expect(parameterized).toHaveLength(8);
    expect(parameterized.every(({ values }) => Array.isArray(values))).toBe(true);
    for (const { text } of parameterized) {
      expect(text).not.toContain(BOOKING_ID);
      expect(text).not.toContain(ROOM_TYPE_ID);
      expect(text).not.toContain(BOOKING_NUMBER);
    }
    expect(parameterized[0]).toMatchObject({ values: [NOW, []] });
    expect(parameterized[1]?.text).toMatch(/inventory_hold[\s\S]*FOR UPDATE/);
    expect(parameterized[2]?.text).toMatch(/daily_inventory[\s\S]*FOR UPDATE/);
    expect(parameterized[3]).toMatchObject({
      values: [ROOM_TYPE_ID, "2030-02-01", NOW],
    });
    expect(parameterized[4]).toMatchObject({
      values: [ROOM_TYPE_ID, "2030-02-02", NOW],
    });
    expect(parameterized[5]).toMatchObject({ values: [BOOKING_ID, NOW] });
    expect(parameterized[6]).toMatchObject({ values: [BOOKING_ID, NOW] });
    expect(parameterized[7]).toMatchObject({ values: [BOOKING_ID, NOW] });
    expect(parameterized[7]?.text).toMatch(
      /'PENDING_PAYMENT'[\s\S]*'CLOSED'[\s\S]*'PAYMENT_TIMEOUT'[\s\S]*'SYSTEM'/,
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("rolls back the whole booking when a locked inventory night is missing", async () => {
    const { pool, queries, release } = createHarness([[bookingRow], holdRows, [inventoryRows[0]]]);
    const repository = new BookingExpiryRepository(pool);

    await expect(repository.closeNextExpired(NOW)).rejects.toThrow(
      "Booking expiry repository unavailable",
    );

    expect(queries.at(-1)).toBe("ROLLBACK");
    expect(
      queries.some(
        (query) => typeof query !== "string" && /UPDATE\s+"daily_inventory"/.test(query.text),
      ),
    ).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it("sanitizes database failures, rolls back, and releases the checked-out client", async () => {
    const secretError = new Error(
      "postgresql://dbuser:secret@database/tenant?booking=10000000-0000-4000-8000-000000000001",
    );
    const query = vi
      .fn<(queryInput: QueryInput) => Promise<ReturnType<typeof result>>>()
      .mockResolvedValueOnce(result([]))
      .mockRejectedValueOnce(secretError)
      .mockResolvedValueOnce(result([]));
    const release = vi.fn();
    const client = { query, release } as unknown as DatabaseClient;
    const pool = {
      connect: vi.fn(() => Promise.resolve(client)),
      end: vi.fn(() => Promise.resolve()),
    } as unknown as DatabasePool;
    const repository = new BookingExpiryRepository(pool);

    let thrown: unknown;
    try {
      await repository.closeNextExpired(NOW);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Booking expiry repository unavailable");
    expect(JSON.stringify(thrown)).not.toMatch(/dbuser|secret|10000000/);
    expect(query.mock.calls.map(([value]) => value)).toEqual([
      "BEGIN",
      expect.objectContaining({ values: [NOW, []] }),
      "ROLLBACK",
    ]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects an invalid clock value before checking out a connection", async () => {
    const { connect, pool } = createHarness([]);
    const repository = new BookingExpiryRepository(pool);

    await expect(repository.closeNextExpired(new Date(Number.NaN))).rejects.toThrow(
      "Booking expiry repository unavailable",
    );

    expect(connect).not.toHaveBeenCalled();
  });
});

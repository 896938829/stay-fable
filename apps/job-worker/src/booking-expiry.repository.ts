import type { QueryResult, QueryResultRow } from "pg";

import type { DatabaseClient, DatabasePool } from "./database.js";

export type BookingExpiryResult = { kind: "CLOSED"; bookingNumber: string } | { kind: "NONE" };

interface ExpiredBookingRow {
  bookingId: string;
  bookingNumber: string;
  roomTypeId: string;
  checkin: string;
  checkout: string;
}

interface HoldRow {
  id: string;
  roomTypeId: string;
  businessDate: string;
}

interface InventoryRow {
  roomTypeId: string;
  businessDate: string;
}

interface IdRow {
  id: string;
}

const UUID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
const BOOKING_NUMBER_PATTERN = /^SF[0-9]{8}[A-F0-9]{12}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UNAVAILABLE_MESSAGE = "Booking expiry repository unavailable";

const unavailable = (): Error => new Error(UNAVAILABLE_MESSAGE);

const readDate = (value: unknown): string => {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    throw unavailable();
  }
  const instant = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== value) {
    throw unavailable();
  }
  return value;
};

const readUuid = (value: unknown): string => {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw unavailable();
  }
  return value;
};

const readBookingNumber = (value: unknown): string => {
  if (typeof value !== "string" || !BOOKING_NUMBER_PATTERN.test(value)) {
    throw unavailable();
  }
  return value;
};

const dateRange = (checkin: string, checkout: string): string[] => {
  const start = Date.parse(`${checkin}T00:00:00.000Z`);
  const end = Date.parse(`${checkout}T00:00:00.000Z`);
  const nights = (end - start) / 86_400_000;
  if (!Number.isInteger(nights) || nights < 1 || nights > 30) {
    throw unavailable();
  }
  return Array.from({ length: nights }, (_, index) =>
    new Date(start + index * 86_400_000).toISOString().slice(0, 10),
  );
};

const oneRow = <Row extends QueryResultRow>(result: QueryResult<Row>): Row => {
  if (result.rows.length !== 1 || result.rows[0] === undefined) {
    throw unavailable();
  }
  return result.rows[0];
};

const sameIds = (rows: IdRow[], expectedIds: Set<string>): boolean => {
  const actualIds = new Set(rows.map(({ id }) => readUuid(id)));
  return (
    rows.length === expectedIds.size &&
    actualIds.size === expectedIds.size &&
    [...expectedIds].every((id) => actualIds.has(id))
  );
};

export class BookingExpiryRepository {
  constructor(private readonly pool: DatabasePool) {}

  async closeNextExpired(now: Date): Promise<BookingExpiryResult> {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw unavailable();
    }

    let client: DatabaseClient | undefined;
    let began = false;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      began = true;
      const bookingResult = await client.query<ExpiredBookingRow>({
        text: `
          SELECT
            booking."id"::text AS "bookingId",
            booking."booking_number" AS "bookingNumber",
            booking."room_type_id"::text AS "roomTypeId",
            booking."checkin_date"::text AS "checkin",
            booking."checkout_date"::text AS "checkout"
          FROM "booking" booking
          WHERE booking."status" = 'PENDING_PAYMENT'
            AND booking."expires_at" <= $1
          ORDER BY booking."expires_at" ASC, booking."id" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `,
        values: [now],
      });
      if (bookingResult.rows.length === 0) {
        await client.query("COMMIT");
        began = false;
        return { kind: "NONE" };
      }

      const booking = oneRow(bookingResult);
      const bookingId = readUuid(booking.bookingId);
      const bookingNumber = readBookingNumber(booking.bookingNumber);
      const roomTypeId = readUuid(booking.roomTypeId);
      const checkin = readDate(booking.checkin);
      const checkout = readDate(booking.checkout);
      const expectedDates = dateRange(checkin, checkout);

      const holdResult = await client.query<HoldRow>({
        text: `
          SELECT
            hold."id"::text AS "id",
            hold."room_type_id"::text AS "roomTypeId",
            hold."business_date"::text AS "businessDate"
          FROM "inventory_hold" hold
          WHERE hold."booking_id" = $1::uuid
            AND hold."status" = 'HELD'
          ORDER BY hold."business_date" ASC, hold."id" ASC
          FOR UPDATE
        `,
        values: [bookingId],
      });
      if (holdResult.rows.length !== expectedDates.length) {
        throw unavailable();
      }
      const holdIds = new Set<string>();
      for (const [index, hold] of holdResult.rows.entries()) {
        const holdId = readUuid(hold.id);
        if (
          holdIds.has(holdId) ||
          readUuid(hold.roomTypeId) !== roomTypeId ||
          readDate(hold.businessDate) !== expectedDates[index]
        ) {
          throw unavailable();
        }
        holdIds.add(holdId);
      }

      const inventoryResult = await client.query<InventoryRow>({
        text: `
          SELECT
            inventory."room_type_id"::text AS "roomTypeId",
            inventory."business_date"::text AS "businessDate"
          FROM "daily_inventory" inventory
          WHERE inventory."room_type_id" = $1::uuid
            AND inventory."business_date" >= $2::date
            AND inventory."business_date" < $3::date
          ORDER BY inventory."business_date" ASC
          FOR UPDATE
        `,
        values: [roomTypeId, checkin, checkout],
      });
      if (inventoryResult.rows.length !== expectedDates.length) {
        throw unavailable();
      }
      for (const [index, inventory] of inventoryResult.rows.entries()) {
        if (
          readUuid(inventory.roomTypeId) !== roomTypeId ||
          readDate(inventory.businessDate) !== expectedDates[index]
        ) {
          throw unavailable();
        }
      }

      for (const businessDate of expectedDates) {
        const updated = oneRow(
          await client.query<InventoryRow>({
            text: `
              UPDATE "daily_inventory"
              SET
                "held_inventory" = "held_inventory" - 1,
                "version" = "version" + 1,
                "updated_at" = $3
              WHERE "room_type_id" = $1::uuid
                AND "business_date" = $2::date
                AND "held_inventory" > 0
              RETURNING
                "room_type_id"::text AS "roomTypeId",
                "business_date"::text AS "businessDate"
            `,
            values: [roomTypeId, businessDate, now],
          }),
        );
        if (
          readUuid(updated.roomTypeId) !== roomTypeId ||
          readDate(updated.businessDate) !== businessDate
        ) {
          throw unavailable();
        }
      }

      const releasedHolds = await client.query<IdRow>({
        text: `
          UPDATE "inventory_hold"
          SET "status" = 'RELEASED', "updated_at" = $2
          WHERE "booking_id" = $1::uuid
            AND "status" = 'HELD'
          RETURNING "id"::text AS "id"
        `,
        values: [bookingId, now],
      });
      if (!sameIds(releasedHolds.rows, holdIds)) {
        throw unavailable();
      }

      const closedBooking = oneRow(
        await client.query<IdRow>({
          text: `
            UPDATE "booking"
            SET "status" = 'CLOSED', "updated_at" = $2
            WHERE "id" = $1::uuid
              AND "status" = 'PENDING_PAYMENT'
              AND "expires_at" <= $2
            RETURNING "id"::text AS "id"
          `,
          values: [bookingId, now],
        }),
      );
      if (readUuid(closedBooking.id) !== bookingId) {
        throw unavailable();
      }

      const history = oneRow(
        await client.query<IdRow>({
          text: `
            INSERT INTO "booking_status_history" (
              "booking_id", "from_status", "to_status", "reason",
              "actor_type", "actor_user_id", "created_at"
            ) VALUES (
              $1::uuid,
              'PENDING_PAYMENT',
              'CLOSED',
              'PAYMENT_TIMEOUT',
              'SYSTEM',
              NULL,
              $2
            )
            RETURNING "id"::text AS "id"
          `,
          values: [bookingId, now],
        }),
      );
      readUuid(history.id);

      await client.query("COMMIT");
      began = false;
      return { kind: "CLOSED", bookingNumber };
    } catch {
      if (client !== undefined && began) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The public error remains sanitized even if rollback also fails.
        }
      }
      throw unavailable();
    } finally {
      if (client !== undefined) {
        try {
          client.release();
        } catch {
          // There is no safe recovery path for a failed client release.
        }
      }
    }
  }
}

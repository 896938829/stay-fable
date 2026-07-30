import { Inject, Injectable } from "@nestjs/common";
import { types as nodeTypes } from "node:util";

import { DatabaseService } from "../database/database.service.js";
import { Prisma } from "../generated/prisma/client.js";

export interface BookingLifecycleTransaction {
  $queryRaw<T = unknown>(query: Prisma.Sql): PromiseLike<T>;
}

export interface BookingLifecycleDatabase {
  $transaction<T>(
    operation: (transaction: BookingLifecycleTransaction) => Promise<T>,
    options?: { isolationLevel: "ReadCommitted" },
  ): Promise<T>;
}

export interface CancelOwnedBookingInput {
  userId: string;
  bookingId: string;
  now: Date;
}

export type CancelOwnedBookingResult =
  | { kind: "CANCELLED" | "REPLAYED" | "EXPIRED"; bookingId: string }
  | { kind: "NOT_FOUND" | "NOT_CANCELLABLE" };

class ReleaseRollback extends Error {}

const UUID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const BOOKING_STATUSES = new Set(["PENDING_PAYMENT", "PAID", "CONFIRMED", "CANCELLED", "CLOSED"]);

const rollback = (): never => {
  throw new ReleaseRollback();
};

const readExactRecord = (
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  ) {
    return rollback();
  }
  const prototype = Reflect.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    return rollback();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value")
    ) {
      return rollback();
    }
    result[key] = descriptor.value;
  }
  return result;
};

const readRows = (value: unknown, maximum: number): unknown[] => {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || value.length > maximum) {
    return rollback();
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string") ||
    keys.length !== value.length + 1 ||
    !keys.includes("length")
  ) {
    return rollback();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const rows: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      return rollback();
    }
    rows.push(descriptor.value);
  }
  return rows;
};

const readUuid = (value: unknown): string =>
  typeof value === "string" && UUID_PATTERN.test(value) ? value : rollback();

const readDate = (value: unknown): string => {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    return rollback();
  }
  const instant = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== value) {
    return rollback();
  }
  return value;
};

const readInstant = (value: unknown): Date => {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    Reflect.getPrototypeOf(value) !== Date.prototype
  ) {
    return rollback();
  }
  const milliseconds = Date.prototype.getTime.call(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : rollback();
};

const dateRange = (checkin: string, checkout: string): string[] => {
  const start = Date.parse(`${checkin}T00:00:00.000Z`);
  const end = Date.parse(`${checkout}T00:00:00.000Z`);
  const nights = (end - start) / 86_400_000;
  if (!Number.isInteger(nights) || nights < 1 || nights > 30) {
    return rollback();
  }
  return Array.from({ length: nights }, (_, index) =>
    new Date(start + index * 86_400_000).toISOString().slice(0, 10),
  );
};

const materializeInput = (value: CancelOwnedBookingInput): CancelOwnedBookingInput => {
  const input = readExactRecord(value, ["userId", "bookingId", "now"]);
  return {
    userId: readUuid(input.userId),
    bookingId: readUuid(input.bookingId),
    now: readInstant(input.now),
  };
};

const queryRows = async (
  transaction: BookingLifecycleTransaction,
  query: Prisma.Sql,
  maximum: number,
): Promise<unknown[]> => readRows(await transaction.$queryRaw(query), maximum);

@Injectable()
export class BookingLifecycleRepository {
  constructor(
    @Inject(DatabaseService)
    private readonly database: BookingLifecycleDatabase,
  ) {}

  cancelOwnedBooking(input: CancelOwnedBookingInput): Promise<CancelOwnedBookingResult> {
    const trusted = materializeInput(input);
    return this.database.$transaction(
      (transaction) => this.cancelInTransaction(transaction, trusted),
      { isolationLevel: "ReadCommitted" },
    );
  }

  private async cancelInTransaction(
    transaction: BookingLifecycleTransaction,
    input: CancelOwnedBookingInput,
  ): Promise<CancelOwnedBookingResult> {
    const bookingRows = await queryRows(
      transaction,
      Prisma.sql`
        SELECT
          booking."id"::text AS "id",
          booking."status"::text AS "status",
          booking."room_type_id"::text AS "roomTypeId",
          booking."checkin_date"::text AS "checkin",
          booking."checkout_date"::text AS "checkout",
          booking."expires_at" AS "expiresAt"
        FROM "booking" booking
        WHERE booking."id" = ${input.bookingId}::uuid
          AND booking."user_id" = ${input.userId}::uuid
        FOR UPDATE
      `,
      1,
    );
    if (bookingRows.length === 0) {
      return { kind: "NOT_FOUND" };
    }
    const booking = readExactRecord(bookingRows[0], [
      "id",
      "status",
      "roomTypeId",
      "checkin",
      "checkout",
      "expiresAt",
    ]);
    const bookingId = readUuid(booking.id);
    const roomTypeId = readUuid(booking.roomTypeId);
    const status = typeof booking.status === "string" ? booking.status : rollback();
    const checkin = readDate(booking.checkin);
    const checkout = readDate(booking.checkout);
    const expiresAt = readInstant(booking.expiresAt);
    if (bookingId !== input.bookingId || !BOOKING_STATUSES.has(status)) {
      return rollback();
    }
    if (status === "CANCELLED") {
      return { kind: "REPLAYED", bookingId };
    }
    if (status !== "PENDING_PAYMENT") {
      return { kind: "NOT_CANCELLABLE" };
    }

    const expectedDates = dateRange(checkin, checkout);
    const holdRows = await queryRows(
      transaction,
      Prisma.sql`
        SELECT
          hold."id"::text AS "id",
          hold."room_type_id"::text AS "roomTypeId",
          hold."business_date"::text AS "businessDate"
        FROM "inventory_hold" hold
        WHERE hold."booking_id" = ${bookingId}::uuid
          AND hold."status" = 'HELD'
        ORDER BY hold."business_date" ASC, hold."id" ASC
        FOR UPDATE
      `,
      31,
    );
    if (holdRows.length !== expectedDates.length) {
      return rollback();
    }
    const holdIds = new Set<string>();
    for (const [index, rawHold] of holdRows.entries()) {
      const hold = readExactRecord(rawHold, ["id", "roomTypeId", "businessDate"]);
      const holdId = readUuid(hold.id);
      if (
        holdIds.has(holdId) ||
        readUuid(hold.roomTypeId) !== roomTypeId ||
        readDate(hold.businessDate) !== expectedDates[index]
      ) {
        return rollback();
      }
      holdIds.add(holdId);
    }

    const inventoryRows = await queryRows(
      transaction,
      Prisma.sql`
        SELECT
          inventory."room_type_id"::text AS "roomTypeId",
          inventory."business_date"::text AS "businessDate"
        FROM "daily_inventory" inventory
        WHERE inventory."room_type_id" = ${roomTypeId}::uuid
          AND inventory."business_date" >= ${checkin}::date
          AND inventory."business_date" < ${checkout}::date
        ORDER BY inventory."business_date" ASC
        FOR UPDATE
      `,
      31,
    );
    if (inventoryRows.length !== expectedDates.length) {
      return rollback();
    }
    for (const [index, rawInventory] of inventoryRows.entries()) {
      const inventory = readExactRecord(rawInventory, ["roomTypeId", "businessDate"]);
      if (
        readUuid(inventory.roomTypeId) !== roomTypeId ||
        readDate(inventory.businessDate) !== expectedDates[index]
      ) {
        return rollback();
      }
    }

    for (const businessDate of expectedDates) {
      const updatedRows = await queryRows(
        transaction,
        Prisma.sql`
          UPDATE "daily_inventory"
          SET
            "held_inventory" = "held_inventory" - 1,
            "version" = "version" + 1,
            "updated_at" = ${input.now}
          WHERE "room_type_id" = ${roomTypeId}::uuid
            AND "business_date" = ${businessDate}::date
            AND "held_inventory" > 0
          RETURNING
            "room_type_id"::text AS "roomTypeId",
            "business_date"::text AS "businessDate"
        `,
        1,
      );
      if (updatedRows.length !== 1) {
        return rollback();
      }
      const updated = readExactRecord(updatedRows[0], ["roomTypeId", "businessDate"]);
      if (
        readUuid(updated.roomTypeId) !== roomTypeId ||
        readDate(updated.businessDate) !== businessDate
      ) {
        return rollback();
      }
    }

    const releasedRows = await queryRows(
      transaction,
      Prisma.sql`
        UPDATE "inventory_hold"
        SET "status" = 'RELEASED', "updated_at" = ${input.now}
        WHERE "booking_id" = ${bookingId}::uuid
          AND "status" = 'HELD'
        RETURNING "id"::text AS "id"
      `,
      31,
    );
    const releasedIds = new Set(
      releasedRows.map((row) => readUuid(readExactRecord(row, ["id"]).id)),
    );
    if (
      releasedIds.size !== holdIds.size ||
      [...holdIds].some((holdId) => !releasedIds.has(holdId))
    ) {
      return rollback();
    }

    const expired = expiresAt.getTime() <= input.now.getTime();
    const finalStatus = expired ? "CLOSED" : "CANCELLED";
    const actorType = expired ? "SYSTEM" : "USER";
    const actorUserId = expired ? null : input.userId;
    const reason = expired ? "PAYMENT_TIMEOUT" : "USER_CANCELLED";
    const updatedBookingRows = await queryRows(
      transaction,
      Prisma.sql`
        UPDATE "booking"
        SET "status" = ${finalStatus}::"BookingStatus", "updated_at" = ${input.now}
        WHERE "id" = ${bookingId}::uuid
          AND "user_id" = ${input.userId}::uuid
          AND "status" = 'PENDING_PAYMENT'
        RETURNING "id"::text AS "id"
      `,
      1,
    );
    if (
      updatedBookingRows.length !== 1 ||
      readUuid(readExactRecord(updatedBookingRows[0], ["id"]).id) !== bookingId
    ) {
      return rollback();
    }

    const historyRows = await queryRows(
      transaction,
      Prisma.sql`
        INSERT INTO "booking_status_history" (
          "booking_id", "from_status", "to_status", "reason",
          "actor_type", "actor_user_id", "created_at"
        ) VALUES (
          ${bookingId}::uuid,
          'PENDING_PAYMENT',
          ${finalStatus}::"BookingStatus",
          ${reason},
          ${actorType}::"BookingActorType",
          ${actorUserId}::uuid,
          ${input.now}
        )
        RETURNING "id"::text AS "id"
      `,
      1,
    );
    if (
      historyRows.length !== 1 ||
      !UUID_PATTERN.test(readUuid(readExactRecord(historyRows[0], ["id"]).id))
    ) {
      return rollback();
    }
    return { kind: expired ? "EXPIRED" : "CANCELLED", bookingId };
  }
}

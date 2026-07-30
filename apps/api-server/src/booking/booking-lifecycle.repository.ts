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

export interface SimulateMockPaymentInput {
  userId: string;
  bookingId: string;
  idempotencyKey: string;
  outcome: "SUCCEED" | "FAIL";
  paymentNumber: string;
  now: Date;
}

export type SimulateMockPaymentResult =
  | {
      kind: "SUCCEEDED" | "FAILED";
      replayed: boolean;
      bookingId: string;
    }
  | { kind: "EXPIRED"; bookingId: string }
  | { kind: "NOT_FOUND" | "ALREADY_PROCESSED" | "IDEMPOTENCY_KEY_REUSED" };

export class PaymentNumberConflictError extends Error {}

interface LockedPaymentBooking {
  bookingId: string;
  status: string;
  roomTypeId: string;
  checkin: string;
  checkout: string;
  expiresAt: Date;
  totalPriceCents: number;
  currency: "CNY";
}

interface LockedInventory {
  expectedDates: string[];
  holdIds: Set<string>;
}

class ReleaseRollback extends Error {}

const UUID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const BOOKING_STATUSES = new Set(["PENDING_PAYMENT", "PAID", "CONFIRMED", "CANCELLED", "CLOSED"]);
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~-]{32,80}$/;
const PAYMENT_NUMBER_PATTERN = /^SFP[0-9]{8}[A-F0-9]{12}$/;

type PaymentUniqueConflict = "PAYMENT_NUMBER" | "IDEMPOTENCY" | "SUCCESS";

const ownDataValue = (value: object, key: string): unknown => {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
};

const paymentConstraint = (value: unknown): PaymentUniqueConflict | null => {
  if (value === "payment_payment_number_key") {
    return "PAYMENT_NUMBER";
  }
  if (value === "payment_booking_id_idempotency_key_key") {
    return "IDEMPOTENCY";
  }
  if (value === "payment_booking_success_key") {
    return "SUCCESS";
  }
  return null;
};

const classifyPaymentUnique = (error: unknown): PaymentUniqueConflict | null => {
  try {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
      return null;
    }
    const meta = error.meta;
    if (meta === null || typeof meta !== "object" || nodeTypes.isProxy(meta)) {
      return null;
    }
    if (error.code === "P2002") {
      const target = ownDataValue(meta, "target");
      const named = paymentConstraint(target);
      if (named !== null) {
        return named;
      }
      if (!Array.isArray(target) || nodeTypes.isProxy(target)) {
        return null;
      }
      const columns = readRows(target, 2);
      if (columns.length === 1 && columns[0] === "payment_number") {
        return "PAYMENT_NUMBER";
      }
      if (columns.length === 2 && columns[0] === "booking_id" && columns[1] === "idempotency_key") {
        return "IDEMPOTENCY";
      }
      if (columns.length === 1 && columns[0] === "booking_id") {
        return "SUCCESS";
      }
      return null;
    }
    if (error.code !== "P2010") {
      return null;
    }
    if (ownDataValue(meta, "code") === "23505") {
      const direct = paymentConstraint(ownDataValue(meta, "constraint"));
      if (direct !== null) {
        return direct;
      }
      const message = ownDataValue(meta, "message");
      if (typeof message !== "string") {
        return null;
      }
      const match =
        /^(?:ERROR: )?duplicate key value violates unique constraint "(payment_payment_number_key|payment_booking_id_idempotency_key_key|payment_booking_success_key)"(?:\r?\nDETAIL: [^\r\n]*)?$/.exec(
          message,
        );
      return paymentConstraint(match?.[1]);
    }
    const driver = ownDataValue(meta, "driverAdapterError");
    if (driver === null || typeof driver !== "object" || nodeTypes.isProxy(driver)) {
      return null;
    }
    const cause = ownDataValue(driver, "cause");
    if (
      cause === null ||
      typeof cause !== "object" ||
      nodeTypes.isProxy(cause) ||
      ownDataValue(cause, "originalCode") !== "23505" ||
      ownDataValue(cause, "kind") !== "UniqueConstraintViolation"
    ) {
      return null;
    }
    const constraint = ownDataValue(cause, "constraint");
    if (typeof constraint === "string") {
      return paymentConstraint(constraint);
    }
    if (constraint !== null && typeof constraint === "object" && !nodeTypes.isProxy(constraint)) {
      const fields = ownDataValue(constraint, "fields");
      if (Array.isArray(fields) && !nodeTypes.isProxy(fields)) {
        const columns = readRows(fields, 2);
        if (columns.length === 1 && columns[0] === "payment_number") {
          return "PAYMENT_NUMBER";
        }
        if (
          columns.length === 2 &&
          columns[0] === "booking_id" &&
          columns[1] === "idempotency_key"
        ) {
          return "IDEMPOTENCY";
        }
        if (columns.length === 1 && columns[0] === "booking_id") {
          return "SUCCESS";
        }
      }
    }
    const originalMessage = ownDataValue(cause, "originalMessage");
    if (typeof originalMessage !== "string") {
      return null;
    }
    const match =
      /^(?:ERROR: )?duplicate key value violates unique constraint "(payment_payment_number_key|payment_booking_id_idempotency_key_key|payment_booking_success_key)"(?:\r?\nDETAIL: [^\r\n]*)?$/.exec(
        originalMessage,
      );
    return paymentConstraint(match?.[1]);
  } catch {
    return null;
  }
};

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

const readNonnegativeInteger = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : rollback();

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

const materializePaymentInput = (value: SimulateMockPaymentInput): SimulateMockPaymentInput => {
  const input = readExactRecord(value, [
    "userId",
    "bookingId",
    "idempotencyKey",
    "outcome",
    "paymentNumber",
    "now",
  ]);
  const idempotencyKey =
    typeof input.idempotencyKey === "string" && IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)
      ? input.idempotencyKey
      : rollback();
  const outcome =
    input.outcome === "SUCCEED" || input.outcome === "FAIL" ? input.outcome : rollback();
  const paymentNumber =
    typeof input.paymentNumber === "string" && PAYMENT_NUMBER_PATTERN.test(input.paymentNumber)
      ? input.paymentNumber
      : rollback();
  return {
    userId: readUuid(input.userId),
    bookingId: readUuid(input.bookingId),
    idempotencyKey,
    outcome,
    paymentNumber,
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

  async simulateMockPayment(input: SimulateMockPaymentInput): Promise<SimulateMockPaymentResult> {
    const trusted = materializePaymentInput(input);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.database.$transaction(
          (transaction) => this.simulatePaymentInTransaction(transaction, trusted),
          { isolationLevel: "ReadCommitted" },
        );
      } catch (error) {
        const conflict = classifyPaymentUnique(error);
        if (conflict === "PAYMENT_NUMBER") {
          throw new PaymentNumberConflictError();
        }
        if ((conflict === "IDEMPOTENCY" || conflict === "SUCCESS") && attempt === 0) {
          continue;
        }
        throw error;
      }
    }
    return rollback();
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
      releasedRows.length !== holdIds.size ||
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

  private async simulatePaymentInTransaction(
    transaction: BookingLifecycleTransaction,
    input: SimulateMockPaymentInput,
  ): Promise<SimulateMockPaymentResult> {
    await transaction.$queryRaw(
      Prisma.sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${input.bookingId} || chr(31) || ${input.idempotencyKey}, 0)
        )
      `,
    );

    const bookingRows = await queryRows(
      transaction,
      Prisma.sql`
        SELECT
          booking."id"::text AS "id",
          booking."status"::text AS "status",
          booking."room_type_id"::text AS "roomTypeId",
          booking."checkin_date"::text AS "checkin",
          booking."checkout_date"::text AS "checkout",
          booking."expires_at" AS "expiresAt",
          booking."total_price_cents" AS "totalPriceCents",
          booking."currency"::text AS "currency"
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
    const rawBooking = readExactRecord(bookingRows[0], [
      "id",
      "status",
      "roomTypeId",
      "checkin",
      "checkout",
      "expiresAt",
      "totalPriceCents",
      "currency",
    ]);
    const status = typeof rawBooking.status === "string" ? rawBooking.status : rollback();
    const currency = rawBooking.currency === "CNY" ? rawBooking.currency : rollback();
    const booking: LockedPaymentBooking = {
      bookingId: readUuid(rawBooking.id),
      status,
      roomTypeId: readUuid(rawBooking.roomTypeId),
      checkin: readDate(rawBooking.checkin),
      checkout: readDate(rawBooking.checkout),
      expiresAt: readInstant(rawBooking.expiresAt),
      totalPriceCents: readNonnegativeInteger(rawBooking.totalPriceCents),
      currency,
    };
    if (booking.bookingId !== input.bookingId || !BOOKING_STATUSES.has(booking.status)) {
      return rollback();
    }

    const existingRows = await queryRows(
      transaction,
      Prisma.sql`
        SELECT
          payment."requested_outcome"::text AS "requestedOutcome",
          payment."status"::text AS "status",
          payment."payment_number" AS "paymentNumber"
        FROM "payment" payment
        WHERE payment."booking_id" = ${booking.bookingId}::uuid
          AND payment."idempotency_key" = ${input.idempotencyKey}
      `,
      1,
    );
    if (existingRows.length === 1) {
      const existing = readExactRecord(existingRows[0], [
        "requestedOutcome",
        "status",
        "paymentNumber",
      ]);
      const requestedOutcome =
        existing.requestedOutcome === "SUCCEED" || existing.requestedOutcome === "FAIL"
          ? existing.requestedOutcome
          : rollback();
      const paymentStatus =
        existing.status === "SUCCEEDED" || existing.status === "FAILED"
          ? existing.status
          : rollback();
      if (
        typeof existing.paymentNumber !== "string" ||
        !PAYMENT_NUMBER_PATTERN.test(existing.paymentNumber) ||
        (requestedOutcome === "SUCCEED" && paymentStatus !== "SUCCEEDED") ||
        (requestedOutcome === "FAIL" && paymentStatus !== "FAILED")
      ) {
        return rollback();
      }
      if (requestedOutcome !== input.outcome) {
        return { kind: "IDEMPOTENCY_KEY_REUSED" };
      }
      return {
        kind: paymentStatus,
        replayed: true,
        bookingId: booking.bookingId,
      };
    }

    if (booking.status !== "PENDING_PAYMENT") {
      return { kind: "ALREADY_PROCESSED" };
    }
    if (booking.expiresAt.getTime() <= input.now.getTime()) {
      const locked = await this.lockHeldInventory(transaction, booking);
      await this.updateHeldInventory(transaction, booking, locked.expectedDates, input.now, false);
      await this.updateHolds(transaction, booking.bookingId, locked.holdIds, input.now, "RELEASED");
      await this.updateBookingStatus(
        transaction,
        booking.bookingId,
        input.userId,
        input.now,
        "PENDING_PAYMENT",
        "CLOSED",
      );
      await this.insertHistory(
        transaction,
        booking.bookingId,
        "PENDING_PAYMENT",
        "CLOSED",
        "PAYMENT_TIMEOUT",
        "SYSTEM",
        null,
        input.now,
      );
      return { kind: "EXPIRED", bookingId: booking.bookingId };
    }

    if (input.outcome === "FAIL") {
      await this.insertPayment(transaction, input, booking, "FAILED");
      return { kind: "FAILED", replayed: false, bookingId: booking.bookingId };
    }

    const locked = await this.lockHeldInventory(transaction, booking);
    await this.updateHeldInventory(transaction, booking, locked.expectedDates, input.now, true);
    await this.updateHolds(transaction, booking.bookingId, locked.holdIds, input.now, "CONSUMED");
    await this.insertPayment(transaction, input, booking, "SUCCEEDED");
    await this.updateBookingStatus(
      transaction,
      booking.bookingId,
      input.userId,
      input.now,
      "PENDING_PAYMENT",
      "PAID",
    );
    await this.insertHistory(
      transaction,
      booking.bookingId,
      "PENDING_PAYMENT",
      "PAID",
      "MOCK_PAYMENT_SUCCEEDED",
      "USER",
      input.userId,
      input.now,
    );
    await this.updateBookingStatus(
      transaction,
      booking.bookingId,
      input.userId,
      input.now,
      "PAID",
      "CONFIRMED",
    );
    await this.insertHistory(
      transaction,
      booking.bookingId,
      "PAID",
      "CONFIRMED",
      "PAYMENT_CONFIRMED",
      "SYSTEM",
      null,
      input.now,
    );
    return { kind: "SUCCEEDED", replayed: false, bookingId: booking.bookingId };
  }

  private async lockHeldInventory(
    transaction: BookingLifecycleTransaction,
    booking: LockedPaymentBooking,
  ): Promise<LockedInventory> {
    const expectedDates = dateRange(booking.checkin, booking.checkout);
    const holdRows = await queryRows(
      transaction,
      Prisma.sql`
        SELECT
          hold."id"::text AS "id",
          hold."room_type_id"::text AS "roomTypeId",
          hold."business_date"::text AS "businessDate"
        FROM "inventory_hold" hold
        WHERE hold."booking_id" = ${booking.bookingId}::uuid
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
        readUuid(hold.roomTypeId) !== booking.roomTypeId ||
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
        WHERE inventory."room_type_id" = ${booking.roomTypeId}::uuid
          AND inventory."business_date" >= ${booking.checkin}::date
          AND inventory."business_date" < ${booking.checkout}::date
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
        readUuid(inventory.roomTypeId) !== booking.roomTypeId ||
        readDate(inventory.businessDate) !== expectedDates[index]
      ) {
        return rollback();
      }
    }
    return { expectedDates, holdIds };
  }

  private async updateHeldInventory(
    transaction: BookingLifecycleTransaction,
    booking: LockedPaymentBooking,
    expectedDates: string[],
    now: Date,
    consume: boolean,
  ): Promise<void> {
    for (const businessDate of expectedDates) {
      const updatedRows = await queryRows(
        transaction,
        consume
          ? Prisma.sql`
              UPDATE "daily_inventory"
              SET
                "held_inventory" = "held_inventory" - 1,
                "sold_inventory" = "sold_inventory" + 1,
                "version" = "version" + 1,
                "updated_at" = ${now}
              WHERE "room_type_id" = ${booking.roomTypeId}::uuid
                AND "business_date" = ${businessDate}::date
                AND "held_inventory" > 0
                AND "sold_inventory" < "total_inventory"
              RETURNING
                "room_type_id"::text AS "roomTypeId",
                "business_date"::text AS "businessDate"
            `
          : Prisma.sql`
              UPDATE "daily_inventory"
              SET
                "held_inventory" = "held_inventory" - 1,
                "version" = "version" + 1,
                "updated_at" = ${now}
              WHERE "room_type_id" = ${booking.roomTypeId}::uuid
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
        readUuid(updated.roomTypeId) !== booking.roomTypeId ||
        readDate(updated.businessDate) !== businessDate
      ) {
        return rollback();
      }
    }
  }

  private async updateHolds(
    transaction: BookingLifecycleTransaction,
    bookingId: string,
    holdIds: Set<string>,
    now: Date,
    destination: "CONSUMED" | "RELEASED",
  ): Promise<void> {
    const rows = await queryRows(
      transaction,
      destination === "CONSUMED"
        ? Prisma.sql`
            UPDATE "inventory_hold"
            SET "status" = 'CONSUMED', "updated_at" = ${now}
            WHERE "booking_id" = ${bookingId}::uuid
              AND "status" = 'HELD'
            RETURNING "id"::text AS "id"
          `
        : Prisma.sql`
            UPDATE "inventory_hold"
            SET "status" = 'RELEASED', "updated_at" = ${now}
            WHERE "booking_id" = ${bookingId}::uuid
              AND "status" = 'HELD'
            RETURNING "id"::text AS "id"
          `,
      31,
    );
    const returnedIds = new Set(rows.map((row) => readUuid(readExactRecord(row, ["id"]).id)));
    if (
      rows.length !== holdIds.size ||
      returnedIds.size !== holdIds.size ||
      [...holdIds].some((holdId) => !returnedIds.has(holdId))
    ) {
      return rollback();
    }
  }

  private async insertPayment(
    transaction: BookingLifecycleTransaction,
    input: SimulateMockPaymentInput,
    booking: LockedPaymentBooking,
    status: "SUCCEEDED" | "FAILED",
  ): Promise<void> {
    const rows = await queryRows(
      transaction,
      Prisma.sql`
        INSERT INTO "payment" (
          "booking_id", "payment_number", "provider", "status",
          "requested_outcome", "amount_cents", "currency",
          "idempotency_key", "processed_at"
        ) VALUES (
          ${booking.bookingId}::uuid,
          ${input.paymentNumber},
          'MOCK',
          ${status}::"PaymentStatus",
          ${input.outcome}::"MockPaymentOutcome",
          ${booking.totalPriceCents},
          ${booking.currency},
          ${input.idempotencyKey},
          ${input.now}
        )
        RETURNING
          "id"::text AS "id",
          "payment_number" AS "paymentNumber"
      `,
      1,
    );
    const inserted = readExactRecord(rows.length === 1 ? rows[0] : rollback(), [
      "id",
      "paymentNumber",
    ]);
    if (
      !UUID_PATTERN.test(readUuid(inserted.id)) ||
      inserted.paymentNumber !== input.paymentNumber
    ) {
      return rollback();
    }
  }

  private async updateBookingStatus(
    transaction: BookingLifecycleTransaction,
    bookingId: string,
    userId: string,
    now: Date,
    fromStatus: "PENDING_PAYMENT" | "PAID",
    toStatus: "PAID" | "CONFIRMED" | "CLOSED",
  ): Promise<void> {
    const rows = await queryRows(
      transaction,
      Prisma.sql`
        UPDATE "booking"
        SET "status" = ${toStatus}::"BookingStatus", "updated_at" = ${now}
        WHERE "id" = ${bookingId}::uuid
          AND "user_id" = ${userId}::uuid
          AND "status" = ${fromStatus}::"BookingStatus"
        RETURNING "id"::text AS "id"
      `,
      1,
    );
    if (rows.length !== 1 || readUuid(readExactRecord(rows[0], ["id"]).id) !== bookingId) {
      return rollback();
    }
  }

  private async insertHistory(
    transaction: BookingLifecycleTransaction,
    bookingId: string,
    fromStatus: "PENDING_PAYMENT" | "PAID",
    toStatus: "PAID" | "CONFIRMED" | "CLOSED",
    reason: "MOCK_PAYMENT_SUCCEEDED" | "PAYMENT_CONFIRMED" | "PAYMENT_TIMEOUT",
    actorType: "USER" | "SYSTEM",
    actorUserId: string | null,
    now: Date,
  ): Promise<void> {
    const rows = await queryRows(
      transaction,
      Prisma.sql`
        INSERT INTO "booking_status_history" (
          "booking_id", "from_status", "to_status", "reason",
          "actor_type", "actor_user_id", "created_at"
        ) VALUES (
          ${bookingId}::uuid,
          ${fromStatus}::"BookingStatus",
          ${toStatus}::"BookingStatus",
          ${reason},
          ${actorType}::"BookingActorType",
          ${actorUserId}::uuid,
          ${now}
        )
        RETURNING "id"::text AS "id"
      `,
      1,
    );
    if (rows.length !== 1 || !UUID_PATTERN.test(readUuid(readExactRecord(rows[0], ["id"]).id))) {
      return rollback();
    }
  }
}

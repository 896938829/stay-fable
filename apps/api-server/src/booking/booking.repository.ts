import { Inject, Injectable } from "@nestjs/common";
import {
  bookingSummarySchema,
  idempotencyKeySchema,
  quoteChangedDetailsSchema,
  quoteResponseDataSchema,
  type BookingSummary,
  type QuoteChangedDetails,
  type QuoteResponseData,
} from "@stay-fable/api-contracts/booking";
import { types as nodeTypes } from "node:util";

import { CLOCK, type Clock } from "../common/clock/clock.js";
import { DatabaseService } from "../database/database.service.js";
import { Prisma } from "../generated/prisma/client.js";
import { createQuoteFingerprint } from "../pricing/quote-fingerprint.js";

export interface CreateBookingInput {
  userId: string;
  quoteId: string;
  idempotencyKey: string;
  bookingNumber: string;
  now: Date;
}

export type CreateBookingResult =
  | { kind: "CREATED"; booking: BookingSummary }
  | { kind: "REPLAYED"; booking: BookingSummary }
  | { kind: "QUOTE_EXPIRED" }
  | { kind: "QUOTE_ALREADY_USED" }
  | { kind: "QUOTE_CHANGED"; details: QuoteChangedDetails }
  | { kind: "INVENTORY_UNAVAILABLE" };

export interface BookingTransaction {
  $queryRaw<T = unknown>(query: Prisma.Sql): PromiseLike<T>;
}

export interface BookingDatabase {
  $transaction<T>(
    operation: (transaction: BookingTransaction) => Promise<T>,
    options: { isolationLevel: "ReadCommitted" },
  ): Promise<T>;
  $queryRaw<T = unknown>(query: Prisma.Sql): PromiseLike<T>;
}

export class BookingNumberConflictError extends Error {
  constructor() {
    super("Booking number conflict");
  }
}

class InventoryUnavailableRollback extends Error {}
class CurrentPriceUnavailable extends Error {}

const UUID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
const BOOKING_NUMBER_PATTERN = /^SF[0-9]{8}[A-F0-9]{12}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

const invalidInput = (): never => {
  throw new Error("Invalid booking repository input");
};
const invalidData = (): never => {
  throw new Error("Unexpected booking repository data");
};

const snapshotRecord = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return invalidData();
    }
    const prototype = Reflect.getPrototypeOf(value);
    const ownKeys = Reflect.ownKeys(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    ) {
      return invalidData();
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")
      ) {
        return invalidData();
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return invalidData();
  }
};

const snapshotRows = (value: unknown): unknown[] => {
  try {
    if (!Array.isArray(value) || nodeTypes.isProxy(value)) {
      return invalidData();
    }
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
    const ownKeys = Reflect.ownKeys(value);
    const length =
      lengthDescriptor !== undefined && Object.hasOwn(lengthDescriptor, "value")
        ? lengthDescriptor.value
        : undefined;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      ownKeys.length !== length + 1
    ) {
      return invalidData();
    }
    const rows: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
        return invalidData();
      }
      rows.push(descriptor.value);
    }
    return rows;
  } catch {
    return invalidData();
  }
};

const validDate = (value: unknown): value is Date =>
  value instanceof Date &&
  !nodeTypes.isProxy(value) &&
  Reflect.getPrototypeOf(value) === Date.prototype &&
  Number.isFinite(Date.prototype.getTime.call(value));
const dateEpoch = (value: Date): number => Date.prototype.getTime.call(value);
const cloneDate = (value: Date): Date => new Date(dateEpoch(value));
const dateIso = (value: Date): string => Date.prototype.toISOString.call(value);
const validInteger = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= minimum &&
  value <= POSTGRES_INTEGER_MAX;

const materializeInput = (input: CreateBookingInput): CreateBookingInput => {
  try {
    const row = snapshotRecord(input, [
      "userId",
      "quoteId",
      "idempotencyKey",
      "bookingNumber",
      "now",
    ]);
    if (
      typeof row.userId !== "string" ||
      !UUID_PATTERN.test(row.userId) ||
      typeof row.quoteId !== "string" ||
      !UUID_PATTERN.test(row.quoteId) ||
      typeof row.idempotencyKey !== "string" ||
      !idempotencyKeySchema.safeParse(row.idempotencyKey).success ||
      typeof row.bookingNumber !== "string" ||
      !BOOKING_NUMBER_PATTERN.test(row.bookingNumber) ||
      !validDate(row.now)
    ) {
      return invalidInput();
    }
    return {
      userId: row.userId,
      quoteId: row.quoteId,
      idempotencyKey: row.idempotencyKey,
      bookingNumber: row.bookingNumber,
      now: cloneDate(row.now),
    };
  } catch {
    return invalidInput();
  }
};

const bookingRowKeys = [
  "id",
  "bookingNumber",
  "status",
  "propertyName",
  "roomTypeName",
  "checkin",
  "checkout",
  "guests",
  "totalPriceCents",
  "currency",
  "expiresAt",
  "createdAt",
] as const;
const usedBookingRowKeys = [...bookingRowKeys, "idempotencyKey"] as const;

const materializeBooking = (value: unknown): BookingSummary => {
  const row = snapshotRecord(value, bookingRowKeys);
  if (!validDate(row.expiresAt) || !validDate(row.createdAt)) {
    return invalidData();
  }
  const parsed = bookingSummarySchema.safeParse({
    booking_id: row.id,
    booking_number: row.bookingNumber,
    status: row.status,
    property_name: row.propertyName,
    room_type_name: row.roomTypeName,
    checkin: row.checkin,
    checkout: row.checkout,
    nights:
      typeof row.checkin === "string" && typeof row.checkout === "string"
        ? dayDifference(row.checkin, row.checkout)
        : Number.NaN,
    guests: row.guests,
    total_price_cents: row.totalPriceCents,
    currency: row.currency,
    expires_at: dateIso(row.expiresAt),
    created_at: dateIso(row.createdAt),
  });
  if (!parsed.success) {
    return invalidData();
  }
  return parsed.data;
};

const materializeUsedBooking = (
  value: unknown,
): { booking: BookingSummary; idempotencyKey: string } => {
  const row = snapshotRecord(value, usedBookingRowKeys);
  if (
    typeof row.idempotencyKey !== "string" ||
    !idempotencyKeySchema.safeParse(row.idempotencyKey).success
  ) {
    return invalidData();
  }
  const bookingValue = Object.fromEntries(bookingRowKeys.map((key) => [key, row[key]])) as Record<
    string,
    unknown
  >;
  return { booking: materializeBooking(bookingValue), idempotencyKey: row.idempotencyKey };
};

const dayOrdinal = (value: string): number => {
  const [year = 0, month = 0, day = 0] = value.split("-").map(Number);
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  return (
    era * 146_097 +
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear
  );
};
const dayDifference = (checkin: string, checkout: string): number =>
  dayOrdinal(checkout) - dayOrdinal(checkin);

const quoteRowKeys = [
  "id",
  "userId",
  "propertyId",
  "roomTypeId",
  "checkin",
  "checkout",
  "guests",
  "propertySnapshot",
  "roomTypeSnapshot",
  "nightlyPrices",
  "bookingPolicy",
  "totalPriceCents",
  "currency",
  "fingerprint",
  "expiresAt",
  "bookingId",
  "bookingIdempotencyKey",
] as const;

interface MaterializedQuote {
  id: string;
  userId: string;
  propertyId: string;
  roomTypeId: string;
  checkin: string;
  checkout: string;
  guests: number;
  response: QuoteResponseData;
  fingerprint: string;
  expiresAt: Date;
  bookingId: string | null;
  bookingIdempotencyKey: string | null;
}

const materializeQuote = (value: unknown): MaterializedQuote => {
  const row = snapshotRecord(value, quoteRowKeys);
  if (
    typeof row.id !== "string" ||
    !UUID_PATTERN.test(row.id) ||
    typeof row.userId !== "string" ||
    !UUID_PATTERN.test(row.userId) ||
    typeof row.propertyId !== "string" ||
    !UUID_PATTERN.test(row.propertyId) ||
    typeof row.roomTypeId !== "string" ||
    !UUID_PATTERN.test(row.roomTypeId) ||
    typeof row.fingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(row.fingerprint) ||
    !validDate(row.expiresAt) ||
    (row.bookingId !== null &&
      (typeof row.bookingId !== "string" || !UUID_PATTERN.test(row.bookingId))) ||
    (row.bookingIdempotencyKey !== null && typeof row.bookingIdempotencyKey !== "string")
  ) {
    return invalidData();
  }
  const response = quoteResponseDataSchema.safeParse({
    quote_id: row.id,
    property: row.propertySnapshot,
    room_type: row.roomTypeSnapshot,
    checkin: row.checkin,
    checkout: row.checkout,
    nights:
      typeof row.checkin === "string" && typeof row.checkout === "string"
        ? dayDifference(row.checkin, row.checkout)
        : Number.NaN,
    guests: row.guests,
    nightly_prices: row.nightlyPrices,
    total_price_cents: row.totalPriceCents,
    currency: row.currency,
    booking_policy: row.bookingPolicy,
    expires_at: dateIso(row.expiresAt),
  });
  if (
    !response.success ||
    response.data.property.id !== row.propertyId ||
    response.data.room_type.id !== row.roomTypeId
  ) {
    return invalidData();
  }
  return {
    id: row.id,
    userId: row.userId,
    propertyId: row.propertyId,
    roomTypeId: row.roomTypeId,
    checkin: response.data.checkin,
    checkout: response.data.checkout,
    guests: response.data.guests,
    response: response.data,
    fingerprint: row.fingerprint,
    expiresAt: cloneDate(row.expiresAt),
    bookingId: row.bookingId,
    bookingIdempotencyKey: row.bookingIdempotencyKey,
  };
};

const currentBaseKeys = [
  "propertyId",
  "propertyName",
  "roomTypeId",
  "roomTypeName",
  "coverUrl",
  "maxGuests",
  "bookingPolicy",
] as const;
const currentNightKeys = ["businessDate", "salePriceCents", "rackPriceCents"] as const;

const materializeCurrentQuote = (
  quote: MaterializedQuote,
  baseValue: unknown,
  nightlyValue: unknown,
  expiresAt: Date,
): { response: QuoteResponseData; fingerprint: string } => {
  const base = snapshotRecord(baseValue, currentBaseKeys);
  const nightlyRows = snapshotRows(nightlyValue).map((value) =>
    snapshotRecord(value, currentNightKeys),
  );
  const expectedNights = dayDifference(quote.checkin, quote.checkout);
  if (nightlyRows.length !== expectedNights) {
    throw new CurrentPriceUnavailable();
  }
  for (const [index, night] of nightlyRows.entries()) {
    if (typeof night.businessDate !== "string") {
      return invalidData();
    }
    if (dayOrdinal(night.businessDate) !== dayOrdinal(quote.checkin) + index) {
      throw new CurrentPriceUnavailable();
    }
  }
  if (
    typeof base.propertyId !== "string" ||
    !UUID_PATTERN.test(base.propertyId) ||
    typeof base.propertyName !== "string" ||
    typeof base.roomTypeId !== "string" ||
    !UUID_PATTERN.test(base.roomTypeId) ||
    typeof base.roomTypeName !== "string" ||
    typeof base.coverUrl !== "string" ||
    !validInteger(base.maxGuests, 1) ||
    quote.guests > base.maxGuests ||
    typeof base.bookingPolicy !== "string"
  ) {
    return invalidData();
  }
  const prices = nightlyRows.map((night) => ({
    business_date: night.businessDate,
    sale_price_cents: night.salePriceCents,
    rack_price_cents: night.rackPriceCents,
    currency: "CNY",
  }));
  const total = prices.reduce(
    (sum, night) =>
      validInteger(night.sale_price_cents) && validInteger(sum + night.sale_price_cents)
        ? sum + night.sale_price_cents
        : Number.NaN,
    0,
  );
  const parsed = quoteResponseDataSchema.safeParse({
    quote_id: quote.id,
    property: { id: base.propertyId, name: base.propertyName },
    room_type: {
      id: base.roomTypeId,
      name: base.roomTypeName,
      cover_url: base.coverUrl,
    },
    checkin: quote.checkin,
    checkout: quote.checkout,
    nights: dayDifference(quote.checkin, quote.checkout),
    guests: quote.guests,
    nightly_prices: prices,
    total_price_cents: total,
    currency: "CNY",
    booking_policy: base.bookingPolicy,
    expires_at: dateIso(expiresAt),
  });
  if (!parsed.success) {
    return invalidData();
  }
  const fingerprint = createQuoteFingerprint({
    property: parsed.data.property,
    roomType: {
      id: parsed.data.room_type.id,
      name: parsed.data.room_type.name,
      coverUrl: parsed.data.room_type.cover_url,
    },
    checkin: parsed.data.checkin,
    checkout: parsed.data.checkout,
    guests: parsed.data.guests,
    bookingPolicy: parsed.data.booking_policy,
    nightlyPrices: parsed.data.nightly_prices.map((night) => ({
      businessDate: night.business_date,
      salePriceCents: night.sale_price_cents,
      rackPriceCents: night.rack_price_cents,
    })),
  });
  return { response: parsed.data, fingerprint };
};

const inventoryKeys = [
  "roomTypeId",
  "businessDate",
  "totalInventory",
  "heldInventory",
  "soldInventory",
] as const;

type KnownUniqueConstraint =
  "booking_booking_number_key" | "booking_user_id_idempotency_key_key" | "booking_quote_id_key";

interface UniqueClassification {
  confirmed: true;
  bookingNumber: boolean;
}

const knownUniqueConstraints = new Set<KnownUniqueConstraint>([
  "booking_booking_number_key",
  "booking_user_id_idempotency_key_key",
  "booking_quote_id_key",
]);

const asKnownConstraint = (value: unknown): KnownUniqueConstraint | null =>
  typeof value === "string" && knownUniqueConstraints.has(value as KnownUniqueConstraint)
    ? (value as KnownUniqueConstraint)
    : null;

const ownDataValue = (value: object, key: string): unknown => {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
};

const p2002BookingNumber = (meta: unknown): boolean => {
  if (meta === null || typeof meta !== "object") {
    return false;
  }
  const target = ownDataValue(meta, "target");
  const named = asKnownConstraint(target);
  if (named !== null) {
    return named === "booking_booking_number_key";
  }
  if (!Array.isArray(target) || nodeTypes.isProxy(target)) {
    return false;
  }
  const columns = snapshotRows(target);
  return columns.length === 1 && columns[0] === "booking_number";
};

const STANDARD_UNIQUE_MESSAGE =
  /^(?:ERROR: )?duplicate key value violates unique constraint "(booking_booking_number_key|booking_user_id_idempotency_key_key|booking_quote_id_key)"(?:\r?\nDETAIL: [^\r\n]*)?$/;

const flatP2010BookingNumber = (meta: object): boolean => {
  if (ownDataValue(meta, "code") !== "23505") {
    return false;
  }
  const named = asKnownConstraint(ownDataValue(meta, "constraint"));
  if (named !== null) {
    return named === "booking_booking_number_key";
  }
  const message = ownDataValue(meta, "message");
  if (typeof message !== "string") {
    return false;
  }
  const match = STANDARD_UNIQUE_MESSAGE.exec(message);
  return match?.[1] === "booking_booking_number_key";
};

const nestedP2010 = (meta: object): UniqueClassification | null => {
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
  const originalMessageDescriptor = Reflect.getOwnPropertyDescriptor(cause, "originalMessage");
  if (
    originalMessageDescriptor !== undefined &&
    !Object.hasOwn(originalMessageDescriptor, "value")
  ) {
    return null;
  }
  const originalMessage = ownDataValue(cause, "originalMessage");
  const constraintDescriptor = Reflect.getOwnPropertyDescriptor(cause, "constraint");
  if (constraintDescriptor !== undefined && !Object.hasOwn(constraintDescriptor, "value")) {
    return null;
  }
  const constraint = ownDataValue(cause, "constraint");
  if (typeof constraint === "string") {
    return {
      confirmed: true,
      bookingNumber: constraint === "booking_booking_number_key",
    };
  }
  if (constraint !== undefined) {
    if (constraint === null || typeof constraint !== "object" || nodeTypes.isProxy(constraint)) {
      return null;
    }
    const fieldsDescriptor = Reflect.getOwnPropertyDescriptor(constraint, "fields");
    if (
      fieldsDescriptor === undefined ||
      !Object.hasOwn(fieldsDescriptor, "value") ||
      !Array.isArray(fieldsDescriptor.value) ||
      nodeTypes.isProxy(fieldsDescriptor.value)
    ) {
      return null;
    }
    const fields = snapshotRows(fieldsDescriptor.value);
    return {
      confirmed: true,
      bookingNumber: fields.length === 1 && fields[0] === "booking_number",
    };
  }
  const messageMatch =
    typeof originalMessage === "string" ? STANDARD_UNIQUE_MESSAGE.exec(originalMessage) : null;
  return {
    confirmed: true,
    bookingNumber: messageMatch?.[1] === "booking_booking_number_key",
  };
};

const p2010Classification = (meta: unknown): UniqueClassification | null => {
  if (meta === null || typeof meta !== "object" || ownDataValue(meta, "code") !== "23505") {
    if (meta === null || typeof meta !== "object") {
      return null;
    }
    const nested = nestedP2010(meta);
    if (nested !== null) {
      return nested;
    }
    return null;
  }
  const flat = flatP2010BookingNumber(meta);
  return { confirmed: true, bookingNumber: flat };
};

const classifyUniqueConstraint = (error: unknown): UniqueClassification | null => {
  try {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
      return null;
    }
    if (error.code === "P2002") {
      return { confirmed: true, bookingNumber: p2002BookingNumber(error.meta) };
    }
    if (error.code === "P2010") {
      return p2010Classification(error.meta);
    }
    return null;
  } catch {
    return null;
  }
};

@Injectable()
export class BookingRepository {
  constructor(
    @Inject(DatabaseService) private readonly database: BookingDatabase,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async createFromQuote(input: CreateBookingInput): Promise<CreateBookingResult> {
    const trusted = materializeInput(input);
    try {
      return await this.database.$transaction(
        (transaction) => this.createInTransaction(transaction, trusted),
        { isolationLevel: "ReadCommitted" },
      );
    } catch (error) {
      if (error instanceof InventoryUnavailableRollback) {
        return { kind: "INVENTORY_UNAVAILABLE" };
      }
      const unique = classifyUniqueConstraint(error);
      if (unique !== null) {
        const rows = snapshotRows(
          await this.database.$queryRaw<unknown[]>(Prisma.sql`
            ${this.bookingSummarySelect()}
            WHERE booking."user_id" = ${trusted.userId}::uuid
              AND booking."idempotency_key" = ${trusted.idempotencyKey}
            LIMIT 1
          `),
        );
        if (rows.length === 1) {
          return { kind: "REPLAYED", booking: materializeBooking(rows[0]) };
        }
        if (rows.length > 1) {
          return invalidData();
        }
        if (unique.bookingNumber) {
          throw new BookingNumberConflictError();
        }
      }
      throw error;
    }
  }

  private async createInTransaction(
    transaction: BookingTransaction,
    input: CreateBookingInput,
  ): Promise<CreateBookingResult> {
    const advisoryRows = snapshotRows(
      await transaction.$queryRaw<unknown[]>(Prisma.sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${input.userId}::text || ':' || ${input.idempotencyKey}, 0)
        ) AS "locked"
      `),
    );
    if (advisoryRows.length !== 1 || snapshotRecord(advisoryRows[0], ["locked"]).locked !== null) {
      return invalidData();
    }

    const replayRows = snapshotRows(
      await transaction.$queryRaw<unknown[]>(Prisma.sql`
        ${this.bookingSummarySelect()}
        WHERE booking."user_id" = ${input.userId}::uuid
          AND booking."idempotency_key" = ${input.idempotencyKey}
        LIMIT 1
      `),
    );
    if (replayRows.length > 1) {
      return invalidData();
    }
    if (replayRows.length === 1) {
      return { kind: "REPLAYED", booking: materializeBooking(replayRows[0]) };
    }

    const quoteRows = snapshotRows(
      await transaction.$queryRaw<unknown[]>(Prisma.sql`
        SELECT
          quote."id"::text AS "id",
          quote."user_id"::text AS "userId",
          quote."property_id"::text AS "propertyId",
          quote."room_type_id"::text AS "roomTypeId",
          quote."checkin_date"::text AS "checkin",
          quote."checkout_date"::text AS "checkout",
          quote."guests" AS "guests",
          quote."property_snapshot" AS "propertySnapshot",
          quote."room_type_snapshot" AS "roomTypeSnapshot",
          quote."nightly_prices" AS "nightlyPrices",
          quote."booking_policy_snapshot" AS "bookingPolicy",
          quote."total_price_cents" AS "totalPriceCents",
          quote."currency" AS "currency",
          quote."fingerprint" AS "fingerprint",
          quote."expires_at" AS "expiresAt",
          NULL::text AS "bookingId",
          NULL::text AS "bookingIdempotencyKey"
        FROM quote
        WHERE quote."id" = ${input.quoteId}::uuid
          AND quote."user_id" = ${input.userId}::uuid
        FOR UPDATE
      `),
    );
    if (quoteRows.length === 0) {
      return { kind: "QUOTE_EXPIRED" };
    }
    if (quoteRows.length !== 1) {
      return invalidData();
    }
    const quote = materializeQuote(quoteRows[0]);
    if (quote.userId !== input.userId || quote.id !== input.quoteId) {
      return invalidData();
    }
    const usedRows = snapshotRows(
      await transaction.$queryRaw<unknown[]>(Prisma.sql`
        SELECT
          booking."id"::text AS "id",
          booking."booking_number" AS "bookingNumber",
          booking."status"::text AS "status",
          (booking."property_snapshot" ->> 'name') AS "propertyName",
          (booking."room_type_snapshot" ->> 'name') AS "roomTypeName",
          booking."checkin_date"::text AS "checkin",
          booking."checkout_date"::text AS "checkout",
          booking."guests" AS "guests",
          booking."total_price_cents" AS "totalPriceCents",
          booking."currency" AS "currency",
          booking."expires_at" AS "expiresAt",
          booking."created_at" AS "createdAt",
          booking."idempotency_key" AS "idempotencyKey"
        FROM booking
        WHERE booking."quote_id" = ${quote.id}::uuid
        LIMIT 1
      `),
    );
    if (usedRows.length > 1) {
      return invalidData();
    }
    if (usedRows.length === 1) {
      const used = materializeUsedBooking(usedRows[0]);
      return used.idempotencyKey === input.idempotencyKey
        ? { kind: "REPLAYED", booking: used.booking }
        : { kind: "QUOTE_ALREADY_USED" };
    }
    const now = this.captureNow();
    if (dateEpoch(now) >= dateEpoch(quote.expiresAt)) {
      return { kind: "QUOTE_EXPIRED" };
    }

    const baseRows = snapshotRows(
      await transaction.$queryRaw<unknown[]>(Prisma.sql`
        SELECT
          property."id"::text AS "propertyId",
          property."name_zh" AS "propertyName",
          room."id"::text AS "roomTypeId",
          room."name_zh" AS "roomTypeName",
          room."cover_url" AS "coverUrl",
          room."max_guests" AS "maxGuests",
          room."booking_policy_zh" AS "bookingPolicy"
        FROM "room_type" room
        JOIN property ON property."id" = room."property_id"
        WHERE room."id" = ${quote.roomTypeId}::uuid
          AND property."status" = 'OPEN'
          AND room."status" = 'ON_SALE'
        LIMIT 1
        FOR UPDATE OF property, room
      `),
    );
    if (baseRows.length === 0) {
      return { kind: "QUOTE_EXPIRED" };
    }
    if (baseRows.length !== 1) {
      return invalidData();
    }
    const priceRows = snapshotRows(
      await transaction.$queryRaw<unknown[]>(Prisma.sql`
        SELECT
          price."business_date"::text AS "businessDate",
          price."sale_price_cents" AS "salePriceCents",
          price."rack_price_cents" AS "rackPriceCents"
        FROM daily_price price
        WHERE price."room_type_id" = ${quote.roomTypeId}::uuid
          AND price."business_date" >= ${quote.checkin}::date
          AND price."business_date" < ${quote.checkout}::date
        ORDER BY price."business_date" ASC
        FOR UPDATE OF price
      `),
    );
    const replacementExpiresAt = new Date(dateEpoch(now) + 5 * 60_000);
    let current: ReturnType<typeof materializeCurrentQuote>;
    try {
      current = materializeCurrentQuote(quote, baseRows[0], priceRows, replacementExpiresAt);
    } catch (error) {
      if (error instanceof CurrentPriceUnavailable) {
        return { kind: "QUOTE_EXPIRED" };
      }
      throw error;
    }
    if (current.fingerprint !== quote.fingerprint) {
      const replacementRows = snapshotRows(
        await transaction.$queryRaw<unknown[]>(Prisma.sql`
          INSERT INTO quote (
            user_id, property_id, room_type_id, checkin_date, checkout_date, guests,
            nightly_prices, property_snapshot, room_type_snapshot, booking_policy_snapshot,
            total_price_cents, currency, fingerprint, expires_at
          )
          VALUES (
            ${input.userId}::uuid,
            ${current.response.property.id}::uuid,
            ${current.response.room_type.id}::uuid,
            ${current.response.checkin}::date,
            ${current.response.checkout}::date,
            ${current.response.guests},
            ${JSON.stringify(current.response.nightly_prices)}::jsonb,
            ${JSON.stringify(current.response.property)}::jsonb,
            ${JSON.stringify(current.response.room_type)}::jsonb,
            ${current.response.booking_policy},
            ${current.response.total_price_cents},
            ${current.response.currency},
            ${current.fingerprint},
            ${replacementExpiresAt}
          )
          RETURNING
            "id"::text AS "id",
            "created_at" AS "createdAt",
            "expires_at" AS "expiresAt"
        `),
      );
      if (replacementRows.length !== 1) {
        return invalidData();
      }
      const replacementRecord = snapshotRecord(replacementRows[0], [
        "id",
        "createdAt",
        "expiresAt",
      ]);
      if (
        typeof replacementRecord.id !== "string" ||
        !UUID_PATTERN.test(replacementRecord.id) ||
        !validDate(replacementRecord.createdAt) ||
        !validDate(replacementRecord.expiresAt) ||
        dateEpoch(replacementRecord.expiresAt) !== dateEpoch(replacementExpiresAt)
      ) {
        return invalidData();
      }
      const details = quoteChangedDetailsSchema.safeParse({
        previous_total_price_cents: quote.response.total_price_cents,
        replacement_quote: {
          ...current.response,
          quote_id: replacementRecord.id,
          expires_at: dateIso(replacementRecord.expiresAt),
        },
      });
      if (!details.success) {
        return invalidData();
      }
      return { kind: "QUOTE_CHANGED", details: details.data };
    }

    const inventoryRows = snapshotRows(
      await transaction.$queryRaw<unknown[]>(Prisma.sql`
        SELECT
          inventory."room_type_id"::text AS "roomTypeId",
          inventory."business_date"::text AS "businessDate",
          inventory."total_inventory" AS "totalInventory",
          inventory."held_inventory" AS "heldInventory",
          inventory."sold_inventory" AS "soldInventory"
        FROM daily_inventory inventory
        WHERE inventory."room_type_id" = ${quote.roomTypeId}::uuid
          AND inventory."business_date" >= ${quote.checkin}::date
          AND inventory."business_date" < ${quote.checkout}::date
        ORDER BY inventory."business_date" ASC
        FOR UPDATE
      `),
    );
    if (inventoryRows.length !== quote.response.nights) {
      return { kind: "INVENTORY_UNAVAILABLE" };
    }
    for (const [index, value] of inventoryRows.entries()) {
      const inventory = snapshotRecord(value, inventoryKeys);
      const expectedDate = quote.response.nightly_prices[index]?.business_date;
      if (
        inventory.roomTypeId !== quote.roomTypeId ||
        inventory.businessDate !== expectedDate ||
        !validInteger(inventory.totalInventory) ||
        !validInteger(inventory.heldInventory) ||
        !validInteger(inventory.soldInventory) ||
        inventory.heldInventory + inventory.soldInventory > inventory.totalInventory
      ) {
        return invalidData();
      }
      if (inventory.heldInventory + inventory.soldInventory >= inventory.totalInventory) {
        return { kind: "INVENTORY_UNAVAILABLE" };
      }
    }

    for (const night of quote.response.nightly_prices) {
      const updatedRows = snapshotRows(
        await transaction.$queryRaw<unknown[]>(Prisma.sql`
          UPDATE daily_inventory
          SET
            held_inventory = held_inventory + 1,
            version = version + 1,
            updated_at = ${now}
          WHERE room_type_id = ${quote.roomTypeId}::uuid
            AND business_date = ${night.business_date}::date
            AND held_inventory + sold_inventory < total_inventory
          RETURNING "room_type_id"::text AS "roomTypeId"
        `),
      );
      if (updatedRows.length !== 1) {
        throw new InventoryUnavailableRollback();
      }
      const updated = snapshotRecord(updatedRows[0], ["roomTypeId"]);
      if (updated.roomTypeId !== quote.roomTypeId) {
        return invalidData();
      }
    }

    const bookingExpiresAt = new Date(dateEpoch(now) + 15 * 60_000);
    const bookingRows = snapshotRows(
      await transaction.$queryRaw<unknown[]>(Prisma.sql`
        INSERT INTO booking (
          user_id, quote_id, property_id, room_type_id, booking_number, status,
          checkin_date, checkout_date, guests, property_snapshot, room_type_snapshot,
          nightly_prices, booking_policy_snapshot, total_price_cents, currency,
          idempotency_key, expires_at, updated_at
        )
        VALUES (
          ${input.userId}::uuid,
          ${quote.id}::uuid,
          ${quote.propertyId}::uuid,
          ${quote.roomTypeId}::uuid,
          ${input.bookingNumber},
          'PENDING_PAYMENT',
          ${quote.checkin}::date,
          ${quote.checkout}::date,
          ${quote.guests},
          ${JSON.stringify(quote.response.property)}::jsonb,
          ${JSON.stringify(quote.response.room_type)}::jsonb,
          ${JSON.stringify(quote.response.nightly_prices)}::jsonb,
          ${quote.response.booking_policy},
          ${quote.response.total_price_cents},
          ${quote.response.currency},
          ${input.idempotencyKey},
          ${bookingExpiresAt},
          ${now}
        )
        RETURNING
          "id"::text AS "id",
          "booking_number" AS "bookingNumber",
          "status"::text AS "status",
          ("property_snapshot" ->> 'name') AS "propertyName",
          ("room_type_snapshot" ->> 'name') AS "roomTypeName",
          "checkin_date"::text AS "checkin",
          "checkout_date"::text AS "checkout",
          "guests" AS "guests",
          "total_price_cents" AS "totalPriceCents",
          "currency" AS "currency",
          "expires_at" AS "expiresAt",
          "created_at" AS "createdAt"
      `),
    );
    if (bookingRows.length !== 1) {
      return invalidData();
    }
    const createdBooking = materializeBooking(bookingRows[0]);

    const holdRows = snapshotRows(
      await transaction.$queryRaw<unknown[]>(Prisma.sql`
        INSERT INTO inventory_hold (
          booking_id, room_type_id, business_date, status, expires_at, updated_at
        )
        VALUES ${Prisma.join(
          quote.response.nightly_prices.map(
            (night) => Prisma.sql`(
              ${createdBooking.booking_id}::uuid,
              ${quote.roomTypeId}::uuid,
              ${night.business_date}::date,
              'HELD',
              ${bookingExpiresAt},
              ${now}
            )`,
          ),
        )}
        RETURNING "booking_id"::text AS "bookingId"
      `),
    );
    if (
      holdRows.length !== quote.response.nights ||
      holdRows.some(
        (value) => snapshotRecord(value, ["bookingId"]).bookingId !== createdBooking.booking_id,
      )
    ) {
      return invalidData();
    }

    const historyRows = snapshotRows(
      await transaction.$queryRaw<unknown[]>(Prisma.sql`
        INSERT INTO booking_status_history (
          booking_id, from_status, to_status, reason, actor_type, actor_user_id
        )
        VALUES (
          ${createdBooking.booking_id}::uuid,
          NULL,
          'PENDING_PAYMENT',
          'BOOKING_CREATED',
          'USER',
          ${input.userId}::uuid
        )
        RETURNING "id"
      `),
    );
    if (historyRows.length !== 1) {
      return invalidData();
    }
    const history = snapshotRecord(historyRows[0], ["id"]);
    if (typeof history.id !== "string" || !UUID_PATTERN.test(history.id)) {
      return invalidData();
    }
    return { kind: "CREATED", booking: createdBooking };
  }

  private bookingSummarySelect(): Prisma.Sql {
    return Prisma.sql`
      SELECT
        booking."id"::text AS "id",
        booking."booking_number" AS "bookingNumber",
        booking."status"::text AS "status",
        (booking."property_snapshot" ->> 'name') AS "propertyName",
        (booking."room_type_snapshot" ->> 'name') AS "roomTypeName",
        booking."checkin_date"::text AS "checkin",
        booking."checkout_date"::text AS "checkout",
        booking."guests" AS "guests",
        booking."total_price_cents" AS "totalPriceCents",
        booking."currency" AS "currency",
        booking."expires_at" AS "expiresAt",
        booking."created_at" AS "createdAt"
      FROM booking
    `;
  }

  private captureNow(): Date {
    let now: unknown;
    try {
      now = this.clock.now();
    } catch {
      return invalidData();
    }
    return validDate(now) ? cloneDate(now) : invalidData();
  }
}

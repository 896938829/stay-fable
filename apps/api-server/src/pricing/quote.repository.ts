import { Inject, Injectable } from "@nestjs/common";
import { catalogDateSchema } from "@stay-fable/api-contracts/catalog";

import { DatabaseService } from "../database/database.service.js";
import { Prisma } from "../generated/prisma/client.js";

export interface QuoteRange {
  checkin: string;
  checkout: string;
  nights: number;
  guests: number;
}

export interface QuoteNightlyPrice {
  businessDate: string;
  salePriceCents: number;
  rackPriceCents: number;
  available: boolean;
}

export type QuoteInputLookup =
  | { status: "NOT_AVAILABLE" }
  | { status: "CAPACITY_EXCEEDED" }
  | {
      status: "AVAILABLE";
      property: { id: string; name: string };
      roomType: {
        id: string;
        name: string;
        coverUrl: string;
        maxGuests: number;
        bookingPolicy: string;
      };
      nightlyPrices: QuoteNightlyPrice[];
    };

export interface PersistQuoteInput {
  userId: string;
  propertyId: string;
  roomTypeId: string;
  checkin: string;
  checkout: string;
  guests: number;
  propertySnapshot: { id: string; name: string };
  roomTypeSnapshot: { id: string; name: string; cover_url: string };
  nightlyPrices: Array<{
    business_date: string;
    sale_price_cents: number;
    rack_price_cents: number;
    currency: "CNY";
  }>;
  bookingPolicySnapshot: string;
  totalPriceCents: number;
  currency: "CNY";
  fingerprint: string;
  expiresAt: Date;
}

export interface PersistedQuote {
  id: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface QuoteDatabase {
  $queryRaw<T = unknown>(query: Prisma.Sql): PromiseLike<T>;
}

type BaseDatabaseRow = {
  propertyId: string;
  propertyName: string;
  roomTypeId: string;
  roomTypeName: string;
  coverUrl: string;
  maxGuests: number;
  bookingPolicy: string;
};

type NightlyDatabaseRow = {
  businessDate: unknown;
  salePriceCents: unknown;
  rackPriceCents: unknown;
  totalInventory: unknown;
  heldInventory: unknown;
  soldInventory: unknown;
};

const UUID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const INVALID_INPUT = "Invalid quote repository input";
const INVALID_DATA = "Unexpected quote repository data";

const invalidInput = (): never => {
  throw new Error(INVALID_INPUT);
};

const invalidData = (): never => {
  throw new Error(INVALID_DATA);
};

const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_PATTERN.test(value);
const isNonblank = (value: unknown, maximum: number): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= maximum &&
  value.trim().length > 0;
const isInteger = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= minimum &&
  value <= maximum;

const dayOrdinal = (value: string): number => {
  const [yearPart, monthPart, dayPart] = value.split("-");
  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const adjustedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * adjustedMonth + 2) / 5) + day - 1;
  return (
    era * 146_097 +
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear
  );
};

const validateRange = (roomTypeId: string, range: QuoteRange): void => {
  if (
    !isUuid(roomTypeId) ||
    !catalogDateSchema.safeParse(range.checkin).success ||
    !catalogDateSchema.safeParse(range.checkout).success ||
    !isInteger(range.nights, 1, 30) ||
    !isInteger(range.guests, 1, 10) ||
    dayOrdinal(range.checkout) - dayOrdinal(range.checkin) !== range.nights
  ) {
    invalidInput();
  }
};

const normalizeRows = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) {
    return invalidData();
  }
  return value;
};

const validateBaseRow = (value: unknown): BaseDatabaseRow => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidData();
  }
  const row = value as Record<keyof BaseDatabaseRow, unknown>;
  if (
    !isUuid(row.propertyId) ||
    !isNonblank(row.propertyName, 120) ||
    !isUuid(row.roomTypeId) ||
    !isNonblank(row.roomTypeName, 120) ||
    !isNonblank(row.coverUrl, 500) ||
    !isInteger(row.maxGuests, 1, 10) ||
    !isNonblank(row.bookingPolicy, 2_000)
  ) {
    return invalidData();
  }
  return row as BaseDatabaseRow;
};

const readInteger = (value: unknown, minimum: number): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const converted =
    typeof value === "bigint"
      ? Number(value)
      : value instanceof Prisma.Decimal
        ? Number(value)
        : value;
  if (typeof converted !== "number" || !Number.isSafeInteger(converted) || converted < minimum) {
    return invalidData();
  }
  if (value instanceof Prisma.Decimal && !new Prisma.Decimal(converted).equals(value)) {
    return invalidData();
  }
  return converted;
};

const readBusinessDate = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" && catalogDateSchema.safeParse(value).success) {
    return value;
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return invalidData();
};

const validatePersistInput = (input: PersistQuoteInput): void => {
  if (
    !isUuid(input.userId) ||
    !isUuid(input.propertyId) ||
    !isUuid(input.roomTypeId) ||
    !catalogDateSchema.safeParse(input.checkin).success ||
    !catalogDateSchema.safeParse(input.checkout).success ||
    !isInteger(input.guests, 1, 10) ||
    input.currency !== "CNY" ||
    !FINGERPRINT_PATTERN.test(input.fingerprint) ||
    !(input.expiresAt instanceof Date) ||
    !Number.isFinite(input.expiresAt.getTime()) ||
    !isNonblank(input.bookingPolicySnapshot, 2_000)
  ) {
    invalidInput();
  }

  const nights = dayOrdinal(input.checkout) - dayOrdinal(input.checkin);
  if (nights < 1 || nights > 30 || input.nightlyPrices.length !== nights) {
    invalidInput();
  }
  if (
    !isUuid(input.propertySnapshot.id) ||
    input.propertySnapshot.id !== input.propertyId ||
    !isNonblank(input.propertySnapshot.name, 120) ||
    Reflect.ownKeys(input.propertySnapshot).length !== 2 ||
    !isUuid(input.roomTypeSnapshot.id) ||
    input.roomTypeSnapshot.id !== input.roomTypeId ||
    !isNonblank(input.roomTypeSnapshot.name, 120) ||
    !isNonblank(input.roomTypeSnapshot.cover_url, 500) ||
    Reflect.ownKeys(input.roomTypeSnapshot).length !== 3
  ) {
    invalidInput();
  }

  let total = 0;
  for (let index = 0; index < input.nightlyPrices.length; index += 1) {
    const nightly = input.nightlyPrices[index]!;
    if (
      Reflect.ownKeys(nightly).length !== 4 ||
      nightly.business_date !== dateAfter(input.checkin, index) ||
      !isInteger(nightly.sale_price_cents, 0, Number.MAX_SAFE_INTEGER) ||
      !isInteger(nightly.rack_price_cents, nightly.sale_price_cents, Number.MAX_SAFE_INTEGER) ||
      nightly.currency !== "CNY"
    ) {
      invalidInput();
    }
    total += nightly.sale_price_cents;
    if (!Number.isSafeInteger(total)) {
      invalidInput();
    }
  }
  if (input.totalPriceCents !== total) {
    invalidInput();
  }
};

const dateAfter = (date: string, offset: number): string => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const result = new Date(Date.UTC(year, month - 1, day + offset));
  return result.toISOString().slice(0, 10);
};

@Injectable()
export class QuoteRepository {
  constructor(@Inject(DatabaseService) private readonly database: QuoteDatabase) {}

  async findQuoteInput(roomTypeId: string, range: QuoteRange): Promise<QuoteInputLookup> {
    validateRange(roomTypeId, range);

    const baseRows = normalizeRows(
      await this.database.$queryRaw<unknown[]>(Prisma.sql`
        SELECT
          property."id" AS "propertyId",
          property."name_zh" AS "propertyName",
          room."id" AS "roomTypeId",
          room."name_zh" AS "roomTypeName",
          room."cover_url" AS "coverUrl",
          room."max_guests" AS "maxGuests",
          room."booking_policy_zh" AS "bookingPolicy"
        FROM "room_type" AS room
        JOIN "property" AS property ON property."id" = room."property_id"
        WHERE room."id" = ${roomTypeId}::uuid
          AND property."status" = 'OPEN'
          AND room."status" = 'ON_SALE'
        LIMIT 1
      `),
    );
    if (baseRows.length === 0) {
      return { status: "NOT_AVAILABLE" };
    }
    if (baseRows.length !== 1) {
      return invalidData();
    }
    const base = validateBaseRow(baseRows[0]);
    if (base.roomTypeId !== roomTypeId) {
      return invalidData();
    }
    if (range.guests > base.maxGuests) {
      return { status: "CAPACITY_EXCEEDED" };
    }

    const nightlyRows = normalizeRows(
      await this.database.$queryRaw<unknown[]>(Prisma.sql`
        SELECT
          requested.business_date::text AS "businessDate",
          price."sale_price_cents" AS "salePriceCents",
          price."rack_price_cents" AS "rackPriceCents",
          inventory."total_inventory" AS "totalInventory",
          inventory."held_inventory" AS "heldInventory",
          inventory."sold_inventory" AS "soldInventory"
        FROM generate_series(
          ${range.checkin}::date,
          (${range.checkout}::date - INTERVAL '1 day'),
          INTERVAL '1 day'
        ) AS requested(business_date)
        LEFT JOIN "daily_price" AS price
          ON price."room_type_id" = ${roomTypeId}::uuid
         AND price."business_date" = requested.business_date
        LEFT JOIN "daily_inventory" AS inventory
          ON inventory."room_type_id" = ${roomTypeId}::uuid
         AND inventory."business_date" = requested.business_date
        ORDER BY requested.business_date ASC
      `),
    );
    const nightlyPrices: QuoteNightlyPrice[] = [];
    for (let index = 0; index < nightlyRows.length; index += 1) {
      const raw = nightlyRows[index];
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        return invalidData();
      }
      const row = raw as NightlyDatabaseRow;
      const businessDate = readBusinessDate(row.businessDate);
      const salePriceCents = readInteger(row.salePriceCents, 0);
      const rackPriceCents = readInteger(row.rackPriceCents, 0);
      const totalInventory = readInteger(row.totalInventory, 0);
      const heldInventory = readInteger(row.heldInventory, 0);
      const soldInventory = readInteger(row.soldInventory, 0);
      if (
        businessDate === null ||
        salePriceCents === null ||
        rackPriceCents === null ||
        totalInventory === null ||
        heldInventory === null ||
        soldInventory === null
      ) {
        return { status: "NOT_AVAILABLE" };
      }
      if (
        businessDate !== dateAfter(range.checkin, index) ||
        rackPriceCents < salePriceCents ||
        heldInventory + soldInventory > totalInventory
      ) {
        return invalidData();
      }
      nightlyPrices.push({
        businessDate,
        salePriceCents,
        rackPriceCents,
        available: totalInventory - heldInventory - soldInventory > 0,
      });
    }
    if (nightlyRows.length !== range.nights) {
      return { status: "NOT_AVAILABLE" };
    }

    return {
      status: "AVAILABLE",
      property: { id: base.propertyId, name: base.propertyName },
      roomType: {
        id: base.roomTypeId,
        name: base.roomTypeName,
        coverUrl: base.coverUrl,
        maxGuests: base.maxGuests,
        bookingPolicy: base.bookingPolicy,
      },
      nightlyPrices,
    };
  }

  async createQuote(input: PersistQuoteInput): Promise<PersistedQuote> {
    validatePersistInput(input);
    const rows = normalizeRows(
      await this.database.$queryRaw<unknown[]>(Prisma.sql`
        INSERT INTO quote (
          user_id, property_id, room_type_id, checkin_date, checkout_date, guests,
          nightly_prices, property_snapshot, room_type_snapshot, booking_policy_snapshot,
          total_price_cents, currency, fingerprint, expires_at
        )
        VALUES (
          ${input.userId}::uuid,
          ${input.propertyId}::uuid,
          ${input.roomTypeId}::uuid,
          ${input.checkin}::date,
          ${input.checkout}::date,
          ${input.guests},
          ${JSON.stringify(input.nightlyPrices)}::jsonb,
          ${JSON.stringify(input.propertySnapshot)}::jsonb,
          ${JSON.stringify(input.roomTypeSnapshot)}::jsonb,
          ${input.bookingPolicySnapshot},
          ${input.totalPriceCents},
          ${input.currency},
          ${input.fingerprint},
          ${input.expiresAt}
        )
        RETURNING
          id,
          created_at AS "createdAt",
          expires_at AS "expiresAt"
      `),
    );
    if (rows.length !== 1) {
      return invalidData();
    }
    const row = rows[0];
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      return invalidData();
    }
    const record = row as Partial<PersistedQuote>;
    if (
      !isUuid(record.id) ||
      !(record.createdAt instanceof Date) ||
      !Number.isFinite(record.createdAt.getTime()) ||
      !(record.expiresAt instanceof Date) ||
      !Number.isFinite(record.expiresAt.getTime())
    ) {
      return invalidData();
    }
    return {
      id: record.id,
      createdAt: new Date(record.createdAt.getTime()),
      expiresAt: new Date(record.expiresAt.getTime()),
    };
  }
}

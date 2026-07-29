import { types as nodeTypes } from "node:util";

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
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const rangeKeys = ["checkin", "checkout", "nights", "guests"] as const;
const persistInputKeys = [
  "userId",
  "propertyId",
  "roomTypeId",
  "checkin",
  "checkout",
  "guests",
  "propertySnapshot",
  "roomTypeSnapshot",
  "nightlyPrices",
  "bookingPolicySnapshot",
  "totalPriceCents",
  "currency",
  "fingerprint",
  "expiresAt",
] as const;
const propertySnapshotKeys = ["id", "name"] as const;
const roomTypeSnapshotKeys = ["id", "name", "cover_url"] as const;
const nightlyPriceKeys = [
  "business_date",
  "sale_price_cents",
  "rack_price_cents",
  "currency",
] as const;

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
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;

const normalizeInputFailure = <T>(operation: () => T): T => {
  try {
    return operation();
  } catch {
    return invalidInput();
  }
};

const materializeRecord = (
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> =>
  normalizeInputFailure(() => {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      nodeTypes.isProxy(value)
    ) {
      return invalidInput();
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return invalidInput();
    }
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== expectedKeys.length ||
      ownKeys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
    ) {
      return invalidInput();
    }

    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, "value")
      ) {
        return invalidInput();
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  });

const materializeNightlyPrices = (value: unknown): Array<Record<string, unknown>> =>
  normalizeInputFailure(() => {
    if (!Array.isArray(value) || nodeTypes.isProxy(value)) {
      return invalidInput();
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Array.prototype) {
      return invalidInput();
    }
    const ownKeys = Reflect.ownKeys(value);
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !Object.hasOwn(lengthDescriptor, "value") ||
      lengthDescriptor.enumerable !== false ||
      !isInteger(lengthDescriptor.value, 1, 30)
    ) {
      return invalidInput();
    }
    const length = lengthDescriptor.value;
    if (
      ownKeys.length !== length + 1 ||
      ownKeys.some(
        (key) =>
          typeof key !== "string" ||
          (key !== "length" && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length)),
      )
    ) {
      return invalidInput();
    }

    const snapshot: Array<Record<string, unknown>> = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, "value")
      ) {
        return invalidInput();
      }
      snapshot.push(materializeRecord(descriptor.value, nightlyPriceKeys));
    }
    return snapshot;
  });

const trustedRecord = <T extends object>(value: T): T =>
  Object.assign(Object.create(null) as Record<PropertyKey, unknown>, value);

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

const validateRange = (
  roomTypeId: unknown,
  range: unknown,
): { roomTypeId: string; range: QuoteRange } =>
  normalizeInputFailure(() => {
    const snapshot = materializeRecord(range, rangeKeys);
    const { checkin, checkout, nights, guests } = snapshot;
    if (
      !isUuid(roomTypeId) ||
      typeof checkin !== "string" ||
      !catalogDateSchema.safeParse(checkin).success ||
      typeof checkout !== "string" ||
      !catalogDateSchema.safeParse(checkout).success ||
      !isInteger(nights, 1, 30) ||
      !isInteger(guests, 1, 10) ||
      dayOrdinal(checkout) - dayOrdinal(checkin) !== nights
    ) {
      return invalidInput();
    }
    return {
      roomTypeId,
      range: { checkin, checkout, nights, guests },
    };
  });

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
  if (
    typeof converted !== "number" ||
    !Number.isSafeInteger(converted) ||
    converted < minimum ||
    converted > POSTGRES_INTEGER_MAX
  ) {
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

const materializePersistInput = (value: unknown): PersistQuoteInput =>
  normalizeInputFailure(() => {
    const input = materializeRecord(value, persistInputKeys);
    const propertySnapshot = materializeRecord(input.propertySnapshot, propertySnapshotKeys);
    const roomTypeSnapshot = materializeRecord(input.roomTypeSnapshot, roomTypeSnapshotKeys);
    const nightlyPriceSnapshots = materializeNightlyPrices(input.nightlyPrices);
    const {
      userId,
      propertyId,
      roomTypeId,
      checkin,
      checkout,
      guests,
      bookingPolicySnapshot,
      totalPriceCents,
      currency,
      fingerprint,
      expiresAt,
    } = input;

    if (
      !isUuid(userId) ||
      !isUuid(propertyId) ||
      !isUuid(roomTypeId) ||
      typeof checkin !== "string" ||
      !catalogDateSchema.safeParse(checkin).success ||
      typeof checkout !== "string" ||
      !catalogDateSchema.safeParse(checkout).success ||
      !isInteger(guests, 1, 10) ||
      currency !== "CNY" ||
      typeof fingerprint !== "string" ||
      !FINGERPRINT_PATTERN.test(fingerprint) ||
      !isNonblank(bookingPolicySnapshot, 2_000) ||
      !isInteger(totalPriceCents, 0, POSTGRES_INTEGER_MAX) ||
      !(expiresAt instanceof Date) ||
      nodeTypes.isProxy(expiresAt) ||
      Reflect.getPrototypeOf(expiresAt) !== Date.prototype
    ) {
      return invalidInput();
    }
    const expiresAtEpoch = Date.prototype.getTime.call(expiresAt);
    if (!Number.isFinite(expiresAtEpoch)) {
      return invalidInput();
    }

    const nights = dayOrdinal(checkout) - dayOrdinal(checkin);
    if (nights < 1 || nights > 30 || nightlyPriceSnapshots.length !== nights) {
      return invalidInput();
    }

    const propertyIdSnapshot = propertySnapshot.id;
    const propertyNameSnapshot = propertySnapshot.name;
    const roomTypeIdSnapshot = roomTypeSnapshot.id;
    const roomTypeNameSnapshot = roomTypeSnapshot.name;
    const roomTypeCoverSnapshot = roomTypeSnapshot.cover_url;
    if (
      !isUuid(propertyIdSnapshot) ||
      propertyIdSnapshot !== propertyId ||
      !isNonblank(propertyNameSnapshot, 120) ||
      !isUuid(roomTypeIdSnapshot) ||
      roomTypeIdSnapshot !== roomTypeId ||
      !isNonblank(roomTypeNameSnapshot, 120) ||
      !isNonblank(roomTypeCoverSnapshot, 500)
    ) {
      return invalidInput();
    }

    const nightlyPrices: PersistQuoteInput["nightlyPrices"] = [];
    let total = 0;
    for (let index = 0; index < nightlyPriceSnapshots.length; index += 1) {
      const nightly = nightlyPriceSnapshots[index]!;
      const businessDate = nightly.business_date;
      const salePriceCents = nightly.sale_price_cents;
      const rackPriceCents = nightly.rack_price_cents;
      const nightlyCurrency = nightly.currency;
      if (
        typeof businessDate !== "string" ||
        businessDate !== dateAfter(checkin, index) ||
        !isInteger(salePriceCents, 0, POSTGRES_INTEGER_MAX) ||
        !isInteger(rackPriceCents, salePriceCents, POSTGRES_INTEGER_MAX) ||
        nightlyCurrency !== "CNY"
      ) {
        return invalidInput();
      }
      total += salePriceCents;
      if (!isInteger(total, 0, POSTGRES_INTEGER_MAX)) {
        return invalidInput();
      }
      nightlyPrices.push(
        trustedRecord({
          business_date: businessDate,
          sale_price_cents: salePriceCents,
          rack_price_cents: rackPriceCents,
          currency: nightlyCurrency,
        }),
      );
    }
    if (totalPriceCents !== total) {
      return invalidInput();
    }

    return {
      userId,
      propertyId,
      roomTypeId,
      checkin,
      checkout,
      guests,
      propertySnapshot: trustedRecord({ id: propertyIdSnapshot, name: propertyNameSnapshot }),
      roomTypeSnapshot: trustedRecord({
        id: roomTypeIdSnapshot,
        name: roomTypeNameSnapshot,
        cover_url: roomTypeCoverSnapshot,
      }),
      nightlyPrices,
      bookingPolicySnapshot,
      totalPriceCents,
      currency,
      fingerprint,
      expiresAt: new Date(expiresAtEpoch),
    };
  });

const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysInMonth = (year: number, month: number): number =>
  [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;

const dateAfter = (date: string, offset: number): string => {
  let [year, month, day] = date.split("-").map(Number) as [number, number, number];
  for (let remaining = offset; remaining > 0; remaining -= 1) {
    day += 1;
    if (day > daysInMonth(year, month)) {
      day = 1;
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

@Injectable()
export class QuoteRepository {
  constructor(@Inject(DatabaseService) private readonly database: QuoteDatabase) {}

  async findQuoteInput(roomTypeId: string, range: QuoteRange): Promise<QuoteInputLookup> {
    const validated = validateRange(roomTypeId, range);
    const trustedRoomTypeId = validated.roomTypeId;
    const trustedRange = validated.range;

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
        WHERE room."id" = ${trustedRoomTypeId}::uuid
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
    if (base.roomTypeId !== trustedRoomTypeId) {
      return invalidData();
    }
    if (trustedRange.guests > base.maxGuests) {
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
          ${trustedRange.checkin}::date,
          (${trustedRange.checkout}::date - INTERVAL '1 day'),
          INTERVAL '1 day'
        ) AS requested(business_date)
        LEFT JOIN "daily_price" AS price
          ON price."room_type_id" = ${trustedRoomTypeId}::uuid
         AND price."business_date" = requested.business_date
        LEFT JOIN "daily_inventory" AS inventory
          ON inventory."room_type_id" = ${trustedRoomTypeId}::uuid
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
        businessDate !== dateAfter(trustedRange.checkin, index) ||
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
    if (nightlyRows.length !== trustedRange.nights) {
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
    const trustedInput = materializePersistInput(input);
    const nightlyPricesJson = JSON.stringify(trustedInput.nightlyPrices);
    const propertySnapshotJson = JSON.stringify(trustedInput.propertySnapshot);
    const roomTypeSnapshotJson = JSON.stringify(trustedInput.roomTypeSnapshot);
    const rows = normalizeRows(
      await this.database.$queryRaw<unknown[]>(Prisma.sql`
        INSERT INTO quote (
          user_id, property_id, room_type_id, checkin_date, checkout_date, guests,
          nightly_prices, property_snapshot, room_type_snapshot, booking_policy_snapshot,
          total_price_cents, currency, fingerprint, expires_at
        )
        VALUES (
          ${trustedInput.userId}::uuid,
          ${trustedInput.propertyId}::uuid,
          ${trustedInput.roomTypeId}::uuid,
          ${trustedInput.checkin}::date,
          ${trustedInput.checkout}::date,
          ${trustedInput.guests},
          ${nightlyPricesJson}::jsonb,
          ${propertySnapshotJson}::jsonb,
          ${roomTypeSnapshotJson}::jsonb,
          ${trustedInput.bookingPolicySnapshot},
          ${trustedInput.totalPriceCents},
          ${trustedInput.currency},
          ${trustedInput.fingerprint},
          ${trustedInput.expiresAt}
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

import { createHash } from "node:crypto";

import { createQuoteRequestSchema } from "@stay-fable/api-contracts/booking";
import { catalogDateSchema, catalogResourceSchema } from "@stay-fable/api-contracts/catalog";

export interface QuoteFingerprintInput {
  property: { id: string; name: string };
  roomType: { id: string; name: string; coverUrl: string };
  checkin: string;
  checkout: string;
  guests: number;
  bookingPolicy: string;
  nightlyPrices: Array<{
    businessDate: string;
    salePriceCents: number;
    rackPriceCents: number;
  }>;
}

const invalidInput = (): never => {
  throw new Error("Invalid quote fingerprint input");
};

const snapshotRecord = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidInput();
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalidInput();
  }

  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      return invalidInput();
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      return invalidInput();
    }
    result[key] = descriptor.value;
  }
  return result;
};

const snapshotArray = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) {
    return invalidInput();
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, "value") ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > 30 ||
    Reflect.ownKeys(value).length !== lengthDescriptor.value + 1
  ) {
    return invalidInput();
  }

  const result: unknown[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      return invalidInput();
    }
    result.push(descriptor.value);
  }
  return result;
};

const requireExactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actualKeys = Object.keys(value);
  if (actualKeys.length !== keys.length || actualKeys.some((key) => !keys.includes(key))) {
    return invalidInput();
  }
  return value;
};

const requireNonblankString = (value: unknown, maximum: number): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || !value.trim()) {
    return invalidInput();
  }
  return value;
};

const requireMoney = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalidInput();
  }
  return value;
};

const requireDate = (value: unknown): string => {
  if (typeof value !== "string" || !catalogDateSchema.safeParse(value).success) {
    return invalidInput();
  }
  return value;
};

const requireUuid = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !createQuoteRequestSchema.safeParse({
      room_type_id: value,
      checkin: "2000-01-01",
      checkout: "2000-01-02",
      guests: 1,
    }).success
  ) {
    return invalidInput();
  }
  return value;
};

const requireResource = (value: unknown): string => {
  if (typeof value !== "string" || !catalogResourceSchema.safeParse(value).success) {
    return invalidInput();
  }
  return value;
};

const calendarDay = (date: string) => {
  const [yearPart, monthPart, dayPart] = date.split("-");
  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
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

export const createQuoteFingerprint = (input: QuoteFingerprintInput): string => {
  try {
    const root = requireExactKeys(snapshotRecord(input), [
      "property",
      "roomType",
      "checkin",
      "checkout",
      "guests",
      "bookingPolicy",
      "nightlyPrices",
    ]);
    const property = requireExactKeys(snapshotRecord(root.property), ["id", "name"]);
    const roomType = requireExactKeys(snapshotRecord(root.roomType), ["id", "name", "coverUrl"]);
    const nightlyPrices = snapshotArray(root.nightlyPrices).map((nightlyPrice) =>
      requireExactKeys(snapshotRecord(nightlyPrice), [
        "businessDate",
        "salePriceCents",
        "rackPriceCents",
      ]),
    );

    const propertyId = requireUuid(property.id);
    const propertyName = requireNonblankString(property.name, 120);
    const roomTypeId = requireUuid(roomType.id);
    const roomTypeName = requireNonblankString(roomType.name, 120);
    const coverUrl = requireResource(roomType.coverUrl);
    const checkin = requireDate(root.checkin);
    const checkout = requireDate(root.checkout);
    const guests = root.guests;
    if (typeof guests !== "number" || !Number.isInteger(guests) || guests < 1 || guests > 10) {
      return invalidInput();
    }
    const bookingPolicy = requireNonblankString(root.bookingPolicy, 2000);
    const nights = calendarDay(checkout) - calendarDay(checkin);
    if (nights < 1 || nights > 30 || nightlyPrices.length !== nights) {
      return invalidInput();
    }

    const canonicalNightlyPrices = nightlyPrices
      .map((nightlyPrice) => {
        const businessDate = requireDate(nightlyPrice.businessDate);
        const salePriceCents = requireMoney(nightlyPrice.salePriceCents);
        const rackPriceCents = requireMoney(nightlyPrice.rackPriceCents);
        if (rackPriceCents < salePriceCents) {
          return invalidInput();
        }
        return [businessDate, salePriceCents, rackPriceCents] as const;
      })
      .sort(([leftDate], [rightDate]) =>
        leftDate < rightDate ? -1 : leftDate > rightDate ? 1 : 0,
      );

    for (const [index, nightlyPrice] of canonicalNightlyPrices.entries()) {
      if (calendarDay(nightlyPrice[0]) !== calendarDay(checkin) + index) {
        return invalidInput();
      }
    }

    const canonicalPayload = [
      roomTypeId,
      propertyId,
      checkin,
      checkout,
      guests,
      [propertyId, propertyName],
      [roomTypeId, roomTypeName, coverUrl],
      bookingPolicy,
      canonicalNightlyPrices,
    ];
    return createHash("sha256").update(JSON.stringify(canonicalPayload), "utf8").digest("hex");
  } catch {
    return invalidInput();
  }
};

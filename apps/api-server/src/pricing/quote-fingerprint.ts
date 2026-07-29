import { createHash } from "node:crypto";

import { quoteResponseDataSchema } from "@stay-fable/api-contracts/booking";
import { catalogDateSchema } from "@stay-fable/api-contracts/catalog";

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

const rootKeys = [
  "property",
  "roomType",
  "checkin",
  "checkout",
  "guests",
  "bookingPolicy",
  "nightlyPrices",
] as const;
const propertyKeys = ["id", "name"] as const;
const roomTypeKeys = ["id", "name", "coverUrl"] as const;
const nightlyPriceKeys = ["businessDate", "salePriceCents", "rackPriceCents"] as const;
const validationQuoteId = "30000000-0000-4000-8000-000000000003";
const validationExpiration = "2030-01-01T00:00:00Z";

const invalidInput = (): never => {
  throw new Error("Invalid quote fingerprint input");
};

const reflectOrInvalid = <T>(operation: () => T): T => {
  try {
    return operation();
  } catch {
    return invalidInput();
  }
};

const snapshotRecord = (
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || reflectOrInvalid(() => Array.isArray(value))) {
    return invalidInput();
  }
  const prototype = reflectOrInvalid(() => Reflect.getPrototypeOf(value));
  if (prototype !== Object.prototype && prototype !== null) {
    return invalidInput();
  }

  const ownKeys = reflectOrInvalid(() => Reflect.ownKeys(value));
  if (
    ownKeys.length !== expectedKeys.length ||
    ownKeys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    return invalidInput();
  }

  const result = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = reflectOrInvalid(() => Object.getOwnPropertyDescriptor(value, key));
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      return invalidInput();
    }
    result[key] = descriptor.value;
  }
  return result;
};

const snapshotArray = (value: unknown): unknown[] => {
  if (!reflectOrInvalid(() => Array.isArray(value))) {
    return invalidInput();
  }
  const arrayValue = value as object;

  const ownKeys = reflectOrInvalid(() => Reflect.ownKeys(arrayValue));
  if (ownKeys.length < 2 || ownKeys.length > 31 || ownKeys.some((key) => typeof key !== "string")) {
    return invalidInput();
  }
  const lengthDescriptor = reflectOrInvalid(() =>
    Object.getOwnPropertyDescriptor(arrayValue, "length"),
  );
  if (
    lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, "value") ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 1 ||
    lengthDescriptor.value > 30 ||
    ownKeys.length !== lengthDescriptor.value + 1 ||
    !ownKeys.includes("length")
  ) {
    return invalidInput();
  }
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    if (!ownKeys.includes(String(index))) {
      return invalidInput();
    }
  }

  const result: unknown[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = reflectOrInvalid(() =>
      Object.getOwnPropertyDescriptor(arrayValue, String(index)),
    );
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      return invalidInput();
    }
    result.push(descriptor.value);
  }
  return result;
};

const requireBusinessDate = (value: unknown): string => {
  if (typeof value !== "string" || !catalogDateSchema.safeParse(value).success) {
    return invalidInput();
  }
  return value;
};

interface SnapshotNightlyPrice {
  businessDate: string;
  salePriceCents: unknown;
  rackPriceCents: unknown;
}

const snapshotNightlyPrice = (value: unknown): SnapshotNightlyPrice => {
  const nightlyPrice = snapshotRecord(value, nightlyPriceKeys);
  return {
    businessDate: requireBusinessDate(nightlyPrice.businessDate),
    salePriceCents: nightlyPrice.salePriceCents,
    rackPriceCents: nightlyPrice.rackPriceCents,
  };
};

const deriveSafeTotal = (nightlyPrices: readonly SnapshotNightlyPrice[]): number => {
  let total = 0;
  for (const nightlyPrice of nightlyPrices) {
    const salePriceCents = nightlyPrice.salePriceCents;
    if (typeof salePriceCents !== "number") {
      return Number.NaN;
    }
    total += salePriceCents;
    if (!Number.isSafeInteger(total)) {
      return Number.NaN;
    }
  }
  return total;
};

export const createQuoteFingerprint = (input: QuoteFingerprintInput): string => {
  const root = snapshotRecord(input, rootKeys);
  const property = snapshotRecord(root.property, propertyKeys);
  const roomType = snapshotRecord(root.roomType, roomTypeKeys);
  const nightlyPrices = snapshotArray(root.nightlyPrices)
    .map(snapshotNightlyPrice)
    .sort(({ businessDate: leftDate }, { businessDate: rightDate }) =>
      leftDate < rightDate ? -1 : leftDate > rightDate ? 1 : 0,
    );

  const validationResult = quoteResponseDataSchema.safeParse({
    quote_id: validationQuoteId,
    property: {
      id: property.id,
      name: property.name,
    },
    room_type: {
      id: roomType.id,
      name: roomType.name,
      cover_url: roomType.coverUrl,
    },
    checkin: root.checkin,
    checkout: root.checkout,
    nights: nightlyPrices.length,
    guests: root.guests,
    nightly_prices: nightlyPrices.map((nightlyPrice) => ({
      business_date: nightlyPrice.businessDate,
      sale_price_cents: nightlyPrice.salePriceCents,
      rack_price_cents: nightlyPrice.rackPriceCents,
      currency: "CNY",
    })),
    total_price_cents: deriveSafeTotal(nightlyPrices),
    currency: "CNY",
    booking_policy: root.bookingPolicy,
    expires_at: validationExpiration,
  });
  if (!validationResult.success) {
    return invalidInput();
  }

  const quote = validationResult.data;
  const canonicalPayload = [
    quote.room_type.id,
    quote.property.id,
    quote.checkin,
    quote.checkout,
    quote.guests,
    [quote.property.id, quote.property.name],
    [quote.room_type.id, quote.room_type.name, quote.room_type.cover_url],
    quote.booking_policy,
    quote.nightly_prices.map((nightlyPrice) => [
      nightlyPrice.business_date,
      nightlyPrice.sale_price_cents,
      nightlyPrice.rack_price_cents,
    ]),
  ];
  return createHash("sha256").update(JSON.stringify(canonicalPayload), "utf8").digest("hex");
};

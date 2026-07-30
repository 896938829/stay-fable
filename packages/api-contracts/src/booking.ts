import { z } from "zod";

import {
  catalogDateSchema,
  catalogResourceSchema,
  currencySchema,
  nightlyPriceSchema,
} from "./catalog.js";

const nonblankString = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim().length > 0);

const invalidJsonLikeInput = Symbol("invalidJsonLikeInput");
const maximumSnapshotDepth = 16;
const maximumSnapshotNodes = 1_000;
const maximumSnapshotKeysPerObject = 100;
const maximumSnapshotArrayLength = 100;

const snapshotJsonLikeInput = (input: unknown): unknown => {
  const seen = new WeakSet<object>();
  let nodeCount = 0;

  const snapshot = (value: unknown, depth: number): unknown => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    if (typeof value !== "object" || depth > maximumSnapshotDepth || seen.has(value)) {
      return invalidJsonLikeInput;
    }
    seen.add(value);
    nodeCount += 1;
    if (nodeCount > maximumSnapshotNodes) {
      return invalidJsonLikeInput;
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const symbolKeys = Object.getOwnPropertySymbols(descriptors);
    const keys = Object.getOwnPropertyNames(descriptors);
    if (
      symbolKeys.length > 0 ||
      keys.length > maximumSnapshotKeysPerObject ||
      keys.includes("__proto__")
    ) {
      return invalidJsonLikeInput;
    }

    if (Array.isArray(value)) {
      const lengthDescriptor = descriptors.length;
      if (
        lengthDescriptor === undefined ||
        !Object.hasOwn(lengthDescriptor, "value") ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        lengthDescriptor.value > maximumSnapshotArrayLength ||
        keys.length !== lengthDescriptor.value + 1
      ) {
        return invalidJsonLikeInput;
      }
      const result: unknown[] = [];
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
          return invalidJsonLikeInput;
        }
        const entry = snapshot(descriptor.value, depth + 1);
        if (entry === invalidJsonLikeInput) {
          return invalidJsonLikeInput;
        }
        result.push(entry);
      }
      return result;
    }

    const result = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
        return invalidJsonLikeInput;
      }
      const entry = snapshot(descriptor.value, depth + 1);
      if (entry === invalidJsonLikeInput) {
        return invalidJsonLikeInput;
      }
      result[key] = entry;
    }
    return result;
  };

  try {
    const snapshotResult = snapshot(input, 0);
    return snapshotResult === invalidJsonLikeInput ? undefined : snapshotResult;
  } catch {
    return undefined;
  }
};

const snapshotJsonLikeSchemaInput = <T extends z.ZodType>(schema: T) =>
  z.preprocess(snapshotJsonLikeInput, schema);

const moneyCentsSchema = z.number().int().nonnegative().safe();
const guestCountSchema = z.number().int().min(1).max(10);
const nightCountSchema = z.number().int().min(1).max(30);
const instantPattern =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const instantSchema = z.string().refine((value) => {
  const match = instantPattern.exec(value);
  if (!match) {
    return false;
  }

  const [, date, hour, minute, second] = match;
  return (
    catalogDateSchema.safeParse(date).success &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 59 &&
    !Number.isNaN(Date.parse(value))
  );
});

const calendarDateParts = (date: string) => {
  const [yearPart = "", monthPart = "", dayPart = ""] = date.split("-");
  return { year: Number(yearPart), month: Number(monthPart), day: Number(dayPart) };
};

const daysFromCivil = (year: number, month: number, day: number) => {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra;
};

const isLeapYear = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysInMonth = (year: number, month: number) =>
  [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;

const calendarDayDifference = (checkin: string, checkout: string) => {
  const checkinParts = calendarDateParts(checkin);
  const checkoutParts = calendarDateParts(checkout);
  return (
    daysFromCivil(checkoutParts.year, checkoutParts.month, checkoutParts.day) -
    daysFromCivil(checkinParts.year, checkinParts.month, checkinParts.day)
  );
};

const dateAfterDays = (date: string, days: number) => {
  let { year, month, day } = calendarDateParts(date);
  for (let remainingDays = days; remainingDays > 0; remainingDays -= 1) {
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

const addStayValidation = <T extends z.ZodObject<z.ZodRawShape>>(schema: T) =>
  schema.superRefine((value, context) => {
    const dateDifference = calendarDayDifference(value.checkin as string, value.checkout as string);
    if (dateDifference < 1 || dateDifference > 30) {
      context.addIssue({ code: "custom", path: ["checkout"], message: "Invalid stay length" });
    }
  });

const quoteNightlyPriceSchema = snapshotJsonLikeSchemaInput(nightlyPriceSchema).superRefine(
  (value, context) => {
    if (value.rack_price_cents < value.sale_price_cents) {
      context.addIssue({
        code: "custom",
        path: ["rack_price_cents"],
        message: "Rack price must not be below sale price",
      });
    }
  },
);

const createQuoteRequestObjectSchema = addStayValidation(
  z
    .object({
      room_type_id: z.uuid(),
      checkin: catalogDateSchema,
      checkout: catalogDateSchema,
      guests: guestCountSchema,
    })
    .strict(),
);

export const createQuoteRequestSchema = snapshotJsonLikeSchemaInput(createQuoteRequestObjectSchema);

const quotePropertySchema = snapshotJsonLikeSchemaInput(
  z
    .object({
      id: z.uuid(),
      name: nonblankString(120),
    })
    .strict(),
);

const quoteRoomTypeSchema = snapshotJsonLikeSchemaInput(
  z
    .object({
      id: z.uuid(),
      name: nonblankString(120),
      cover_url: catalogResourceSchema,
    })
    .strict(),
);

const quoteResponseDataObjectSchema = z
  .object({
    quote_id: z.uuid(),
    property: quotePropertySchema,
    room_type: quoteRoomTypeSchema,
    checkin: catalogDateSchema,
    checkout: catalogDateSchema,
    nights: nightCountSchema,
    guests: guestCountSchema,
    nightly_prices: z.array(quoteNightlyPriceSchema).min(1).max(30),
    total_price_cents: moneyCentsSchema,
    currency: currencySchema,
    booking_policy: nonblankString(2000),
    expires_at: instantSchema,
  })
  .strict();

export const quoteResponseDataSchema = snapshotJsonLikeSchemaInput(
  quoteResponseDataObjectSchema,
).superRefine((value, context) => {
  const dateDifference = calendarDayDifference(value.checkin, value.checkout);
  if (dateDifference !== value.nights) {
    context.addIssue({ code: "custom", path: ["nights"], message: "Nights must match stay" });
  }
  if (dateDifference < 1 || dateDifference > 30) {
    context.addIssue({ code: "custom", path: ["checkout"], message: "Invalid stay length" });
  }
  if (value.nightly_prices.length !== value.nights) {
    context.addIssue({
      code: "custom",
      path: ["nightly_prices"],
      message: "Nightly prices must match nights",
    });
  }
  for (const [index, nightlyPrice] of value.nightly_prices.entries()) {
    if (nightlyPrice.business_date !== dateAfterDays(value.checkin, index)) {
      context.addIssue({
        code: "custom",
        path: ["nightly_prices", index, "business_date"],
        message: "Nightly prices must cover each stay date in order",
      });
    }
  }
  const total = value.nightly_prices.reduce(
    (sum, nightlyPrice) => sum + nightlyPrice.sale_price_cents,
    0,
  );
  if (!Number.isSafeInteger(total) || total !== value.total_price_cents) {
    context.addIssue({
      code: "custom",
      path: ["total_price_cents"],
      message: "Total must equal nightly sale prices",
    });
  }
});

export const createBookingRequestSchema = snapshotJsonLikeSchemaInput(
  z
    .object({
      quote_id: z.uuid(),
    })
    .strict(),
);

const bookingSummaryObjectSchema = z
  .object({
    booking_id: z.uuid(),
    quote_id: z.uuid(),
    booking_number: z.string().regex(/^SF[0-9]{8}[A-F0-9]{12}$/),
    status: z.literal("PENDING_PAYMENT"),
    property_name: nonblankString(120),
    room_type_name: nonblankString(120),
    checkin: catalogDateSchema,
    checkout: catalogDateSchema,
    nights: nightCountSchema,
    guests: guestCountSchema,
    total_price_cents: moneyCentsSchema,
    currency: currencySchema,
    expires_at: instantSchema,
    created_at: instantSchema,
  })
  .strict();

export const bookingSummarySchema = snapshotJsonLikeSchemaInput(
  bookingSummaryObjectSchema,
).superRefine((value, context) => {
  const dateDifference = calendarDayDifference(value.checkin, value.checkout);
  if (dateDifference !== value.nights) {
    context.addIssue({ code: "custom", path: ["nights"], message: "Nights must match stay" });
  }
  if (dateDifference < 1 || dateDifference > 30) {
    context.addIssue({ code: "custom", path: ["checkout"], message: "Invalid stay length" });
  }
});

export const quoteChangedDetailsSchema = snapshotJsonLikeSchemaInput(
  z
    .object({
      previous_total_price_cents: moneyCentsSchema,
      replacement_quote: quoteResponseDataSchema,
    })
    .strict(),
);

export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._~-]{32,80}$/);

export type CreateQuoteRequest = z.infer<typeof createQuoteRequestSchema>;
export type QuoteResponseData = z.infer<typeof quoteResponseDataSchema>;
export type CreateBookingRequest = z.infer<typeof createBookingRequestSchema>;
export type BookingSummary = z.infer<typeof bookingSummarySchema>;
export type QuoteChangedDetails = z.infer<typeof quoteChangedDetailsSchema>;

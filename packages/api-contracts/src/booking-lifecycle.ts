import { z } from "zod";

import { catalogDateSchema, currencySchema, nightlyPriceSchema } from "./catalog.js";

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

const nonblankString = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim().length > 0);

const moneyCentsSchema = z.number().int().nonnegative().safe();
const nightCountSchema = z.number().int().min(1).max(30);
const guestCountSchema = z.number().int().min(1).max(10);
const cursorSchema = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/);
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

const calendarDayDifference = (checkin: string, checkout: string) => {
  const checkinParts = calendarDateParts(checkin);
  const checkoutParts = calendarDateParts(checkout);
  return (
    daysFromCivil(checkoutParts.year, checkoutParts.month, checkoutParts.day) -
    daysFromCivil(checkinParts.year, checkinParts.month, checkinParts.day)
  );
};

const isLeapYear = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
const daysInMonth = (year: number, month: number) =>
  [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;

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

export const bookingStatusSchema = z.enum([
  "PENDING_PAYMENT",
  "PAID",
  "CONFIRMED",
  "CANCELLED",
  "CLOSED",
]);

export const bookingAllowedActionSchema = z.enum([
  "CANCEL",
  "MOCK_PAY_SUCCESS",
  "MOCK_PAY_FAILURE",
]);

const bookingAllowedActionsSchema = z
  .array(bookingAllowedActionSchema)
  .max(3)
  .superRefine((actions, context) => {
    const fixedOrder = ["CANCEL", "MOCK_PAY_SUCCESS", "MOCK_PAY_FAILURE"] as const;
    let previousIndex = -1;
    for (const [index, action] of actions.entries()) {
      const currentIndex = fixedOrder.indexOf(action);
      if (currentIndex <= previousIndex) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "Actions must be unique and in fixed order",
        });
      }
      previousIndex = currentIndex;
    }
  });

export const bookingListQuerySchema = snapshotJsonLikeSchemaInput(
  z
    .object({
      limit: z.coerce.number().int().min(1).max(20).default(10),
      cursor: cursorSchema.optional(),
    })
    .strict(),
);

export const simulatePaymentRequestSchema = snapshotJsonLikeSchemaInput(
  z
    .object({
      outcome: z.enum(["SUCCEED", "FAIL"]),
    })
    .strict(),
);

export const cancelBookingRequestSchema = snapshotJsonLikeSchemaInput(z.object({}).strict());

const bookingListItemObjectSchema = z
  .object({
    booking_id: z.uuid(),
    booking_number: z.string().regex(/^SF[0-9]{8}[A-F0-9]{12}$/),
    status: bookingStatusSchema,
    property_name: nonblankString(120),
    room_type_name: nonblankString(120),
    checkin: catalogDateSchema,
    checkout: catalogDateSchema,
    nights: nightCountSchema,
    guests: guestCountSchema,
    total_price_cents: moneyCentsSchema,
    currency: currencySchema,
    expires_at: instantSchema,
    payment_deadline_passed: z.boolean(),
    created_at: instantSchema,
    updated_at: instantSchema,
  })
  .strict();

const validateStay = (
  value: { checkin: string; checkout: string; nights: number },
  context: z.RefinementCtx,
) => {
  const dateDifference = calendarDayDifference(value.checkin, value.checkout);
  if (dateDifference !== value.nights) {
    context.addIssue({ code: "custom", path: ["nights"], message: "Nights must match stay" });
  }
  if (dateDifference < 1 || dateDifference > 30) {
    context.addIssue({ code: "custom", path: ["checkout"], message: "Invalid stay length" });
  }
};

export const bookingListItemSchema = snapshotJsonLikeSchemaInput(
  bookingListItemObjectSchema,
).superRefine(validateStay);

export const bookingListResponseSchema = snapshotJsonLikeSchemaInput(
  z
    .object({
      items: z.array(bookingListItemObjectSchema.superRefine(validateStay)).max(20),
      next_cursor: cursorSchema.nullable(),
    })
    .strict(),
);

const bookingPaymentSummaryObjectSchema = z
  .object({
    payment_number: z.string().regex(/^SFP[0-9]{8}[A-F0-9]{12}$/),
    status: z.enum(["SUCCEEDED", "FAILED"]),
    processed_at: instantSchema,
  })
  .strict();

export const bookingPaymentSummarySchema = snapshotJsonLikeSchemaInput(
  bookingPaymentSummaryObjectSchema,
);

const bookingStatusHistoryItemObjectSchema = z
  .object({
    from_status: bookingStatusSchema.nullable(),
    to_status: bookingStatusSchema,
    reason: nonblankString(120),
    actor_type: z.enum(["USER", "SYSTEM"]),
    created_at: instantSchema,
  })
  .strict();

export const bookingStatusHistoryItemSchema = snapshotJsonLikeSchemaInput(
  bookingStatusHistoryItemObjectSchema,
);

const detailNightlyPriceSchema = nightlyPriceSchema.superRefine((value, context) => {
  if (value.rack_price_cents < value.sale_price_cents) {
    context.addIssue({
      code: "custom",
      path: ["rack_price_cents"],
      message: "Rack price must not be below sale price",
    });
  }
});

const bookingDetailObjectSchema = bookingListItemObjectSchema
  .extend({
    nightly_prices: z.array(detailNightlyPriceSchema).min(1).max(30),
    booking_policy: nonblankString(2000),
    latest_payment: bookingPaymentSummaryObjectSchema.nullable(),
    status_history: z.array(bookingStatusHistoryItemObjectSchema).max(100),
    allowed_actions: bookingAllowedActionsSchema,
  })
  .strict();

export const bookingDetailSchema = snapshotJsonLikeSchemaInput(
  bookingDetailObjectSchema,
).superRefine((value, context) => {
  validateStay(value, context);
  if (
    value.allowed_actions.length > 0 &&
    (value.status !== "PENDING_PAYMENT" || value.payment_deadline_passed)
  ) {
    context.addIssue({
      code: "custom",
      path: ["allowed_actions"],
      message: "Actions require an unexpired pending booking",
    });
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

export type BookingStatus = z.infer<typeof bookingStatusSchema>;
export type BookingAllowedAction = z.infer<typeof bookingAllowedActionSchema>;
export type BookingListQuery = z.infer<typeof bookingListQuerySchema>;
export type SimulatePaymentRequest = z.infer<typeof simulatePaymentRequestSchema>;
export type CancelBookingRequest = z.infer<typeof cancelBookingRequestSchema>;
export type BookingListItem = z.infer<typeof bookingListItemSchema>;
export type BookingListResponse = z.infer<typeof bookingListResponseSchema>;
export type BookingPaymentSummary = z.infer<typeof bookingPaymentSummarySchema>;
export type BookingStatusHistoryItem = z.infer<typeof bookingStatusHistoryItemSchema>;
export type BookingDetail = z.infer<typeof bookingDetailSchema>;

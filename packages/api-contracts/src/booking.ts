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

const calendarDayDifference = (checkin: string, checkout: string) => {
  const [checkinYearPart = "", checkinMonthPart = "", checkinDayPart = ""] = checkin.split("-");
  const [checkoutYearPart = "", checkoutMonthPart = "", checkoutDayPart = ""] = checkout.split("-");
  const checkinYear = Number(checkinYearPart);
  const checkinMonth = Number(checkinMonthPart);
  const checkinDay = Number(checkinDayPart);
  const checkoutYear = Number(checkoutYearPart);
  const checkoutMonth = Number(checkoutMonthPart);
  const checkoutDay = Number(checkoutDayPart);

  return (
    (Date.UTC(checkoutYear, checkoutMonth - 1, checkoutDay) -
      Date.UTC(checkinYear, checkinMonth - 1, checkinDay)) /
    86_400_000
  );
};

const dateAfterDays = (date: string, days: number) => {
  const [yearPart = "", monthPart = "", dayPart = ""] = date.split("-");
  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};

const addStayValidation = <T extends z.ZodObject<z.ZodRawShape>>(schema: T) =>
  schema.superRefine((value, context) => {
    const dateDifference = calendarDayDifference(value.checkin as string, value.checkout as string);
    if (dateDifference < 1 || dateDifference > 30) {
      context.addIssue({ code: "custom", path: ["checkout"], message: "Invalid stay length" });
    }
  });

const quoteNightlyPriceSchema = nightlyPriceSchema.superRefine((value, context) => {
  if (value.rack_price_cents < value.sale_price_cents) {
    context.addIssue({
      code: "custom",
      path: ["rack_price_cents"],
      message: "Rack price must not be below sale price",
    });
  }
});

export const createQuoteRequestSchema = addStayValidation(
  z
    .object({
      room_type_id: z.uuid(),
      checkin: catalogDateSchema,
      checkout: catalogDateSchema,
      guests: guestCountSchema,
    })
    .strict(),
);

export const quoteResponseDataSchema = z
  .object({
    quote_id: z.uuid(),
    property: z
      .object({
        id: z.uuid(),
        name: nonblankString(120),
      })
      .strict(),
    room_type: z
      .object({
        id: z.uuid(),
        name: nonblankString(120),
        cover_url: catalogResourceSchema,
      })
      .strict(),
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
  .strict()
  .superRefine((value, context) => {
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

export const createBookingRequestSchema = z
  .object({
    quote_id: z.uuid(),
  })
  .strict();

export const bookingSummarySchema = z
  .object({
    booking_id: z.uuid(),
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
  .strict()
  .superRefine((value, context) => {
    const dateDifference = calendarDayDifference(value.checkin, value.checkout);
    if (dateDifference !== value.nights) {
      context.addIssue({ code: "custom", path: ["nights"], message: "Nights must match stay" });
    }
    if (dateDifference < 1 || dateDifference > 30) {
      context.addIssue({ code: "custom", path: ["checkout"], message: "Invalid stay length" });
    }
  });

export const quoteChangedDetailsSchema = z
  .object({
    previous_total_price_cents: moneyCentsSchema,
    replacement_quote: quoteResponseDataSchema,
  })
  .strict();

export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._~-]{32,80}$/);

export type CreateQuoteRequest = z.infer<typeof createQuoteRequestSchema>;
export type QuoteResponseData = z.infer<typeof quoteResponseDataSchema>;
export type CreateBookingRequest = z.infer<typeof createBookingRequestSchema>;
export type BookingSummary = z.infer<typeof bookingSummarySchema>;
export type QuoteChangedDetails = z.infer<typeof quoteChangedDetailsSchema>;

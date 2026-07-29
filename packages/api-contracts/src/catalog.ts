import { z } from "zod";

import { citySchema } from "./location.js";

const catalogCitySchema = citySchema.strict();

export const propertyTypeSchema = z.enum(["HOTEL", "HOMESTAY", "FARM_STAY"]);
export const currencySchema = z.literal("CNY");
const catalogDatePattern = /^\d{4}-\d{2}-\d{2}$/;

const isCalendarDate = (value: string) => {
  const [yearPart, monthPart, dayPart] = value.split("-");
  if (!yearPart || !monthPart || !dayPart) {
    return false;
  }

  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const daysInSelectedMonth = daysInMonth[month - 1];

  return (
    year > 0 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    daysInSelectedMonth !== undefined &&
    day <= daysInSelectedMonth
  );
};

export const catalogDateSchema = z.string().regex(catalogDatePattern).refine(isCalendarDate);
const localImagePathPattern = /^\/images\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

const isCatalogResource = (value: string) => {
  if (value.startsWith("/images/")) {
    return (
      localImagePathPattern.test(value) &&
      value.split("/").slice(2).every((segment) => segment !== "." && segment !== "..")
    );
  }

  if (!value.startsWith("https://")) {
    return false;
  }

  try {
    const url = new URL(value);

    return url.protocol === "https:" && url.hostname.length > 0 && !url.username && !url.password;
  } catch {
    return false;
  }
};

export const catalogResourceSchema = z
  .string()
  .max(500)
  .refine(isCatalogResource);

const moneyCentsSchema = z.number().int().nonnegative().safe();

export const availabilityQuerySchema = z
  .object({
    checkin: catalogDateSchema,
    checkout: catalogDateSchema,
    guests: z.number().int().min(1).max(10),
  })
  .strict();

export const propertyListQuerySchema = availabilityQuerySchema
  .extend({
    city_id: z.uuid(),
    property_type: propertyTypeSchema.optional(),
    page_size: z.number().int().min(1).max(20).default(10),
    cursor: z.string().min(1).max(256).optional(),
  })
  .strict();

export const propertyListItemSchema = z
  .object({
    id: z.uuid(),
    type: propertyTypeSchema,
    name: z.string().min(1).max(120),
    city: catalogCitySchema,
    cover_url: catalogResourceSchema,
    short_description: z.string().min(1).max(240),
    facility_highlights: z.array(z.string().min(1).max(80)).max(4),
    from_nightly_price_cents: moneyCentsSchema,
    currency: currencySchema,
    available_room_type_count: z.number().int().positive(),
  })
  .strict();

export const propertyListResponseSchema = z
  .object({
    items: z.array(propertyListItemSchema),
    next_cursor: z.string().min(1).max(256).nullable(),
  })
  .strict();

export const roomTypeSummarySchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1).max(120),
    bed_type: z.string().min(1).max(120),
    area_sqm: z.number().positive(),
    max_guests: z.number().int().min(1).max(10),
    cover_url: catalogResourceSchema,
    policy_summary: z.string().min(1).max(500),
    from_nightly_price_cents: moneyCentsSchema,
    currency: currencySchema,
  })
  .strict();

const mediaItemSchema = z
  .object({
    type: z.literal("IMAGE"),
    url: catalogResourceSchema,
    alt: z.string().min(1).max(120),
  })
  .strict();

const facilitySchema = z
  .object({
    code: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

export const propertyDetailSchema = z
  .object({
    id: z.uuid(),
    type: propertyTypeSchema,
    name: z.string().min(1).max(120),
    city: catalogCitySchema,
    address: z.string().min(1).max(240),
    description: z.string().min(1).max(2000),
    policies: z.string().min(1).max(2000),
    cover_url: catalogResourceSchema,
    media: z.array(mediaItemSchema).max(20),
    facilities: z.array(facilitySchema).max(50),
    room_types: z.array(roomTypeSummarySchema).min(1),
  })
  .strict();

export const nightlyPriceSchema = z
  .object({
    business_date: catalogDateSchema,
    sale_price_cents: moneyCentsSchema,
    rack_price_cents: moneyCentsSchema,
    currency: currencySchema,
  })
  .strict();

const roomTypePropertySchema = z
  .object({
    id: z.uuid(),
    type: propertyTypeSchema,
    name: z.string().min(1).max(120),
    city: catalogCitySchema,
  })
  .strict();

export const roomTypeDetailSchema = roomTypeSummarySchema
  .omit({
    policy_summary: true,
    from_nightly_price_cents: true,
  })
  .extend({
    property: roomTypePropertySchema,
    description: z.string().min(1).max(2000),
    booking_policy: z.string().min(1).max(2000),
    nightly_prices: z.array(nightlyPriceSchema).min(1).max(30),
  })
  .strict();

export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;
export type PropertyListQuery = z.infer<typeof propertyListQuerySchema>;
export type PropertyListResponse = z.infer<typeof propertyListResponseSchema>;
export type PropertyDetail = z.infer<typeof propertyDetailSchema>;
export type RoomTypeDetail = z.infer<typeof roomTypeDetailSchema>;
export type PropertyType = z.infer<typeof propertyTypeSchema>;

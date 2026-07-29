import { z } from "zod";

import { citySchema } from "./location.js";

const nonblankString = (maximum?: number) =>
  (maximum === undefined ? z.string().min(1) : z.string().min(1).max(maximum)).refine(
    (value) => value.trim().length > 0,
  );

const catalogCitySchema = citySchema
  .extend({
    code: nonblankString(),
    name: nonblankString(),
  })
  .strict();

export const propertyTypeSchema = z.enum(["HOTEL", "HOMESTAY", "FARM_STAY"]);
export const currencySchema = z.literal("CNY");
export const catalogCursorSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);
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
const safeHttpsSuffixPattern = /^[A-Za-z0-9._~!$&'()*+,;=:@/?#%-]*$/;
const standardHostnameLabelPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

const hasValidPercentEscapes = (value: string) => {
  for (let index = value.indexOf("%"); index !== -1; index = value.indexOf("%", index + 3)) {
    if (!/^[0-9A-Fa-f]{2}$/.test(value.slice(index + 1, index + 3))) {
      return false;
    }
  }
  return true;
};

const isSafeHttpsResource = (value: string) => {
  const remainder = value.slice("https://".length);
  const delimiterIndex = remainder.search(/[/?#]/);
  const authority = delimiterIndex === -1 ? remainder : remainder.slice(0, delimiterIndex);
  const suffix = delimiterIndex === -1 ? "" : remainder.slice(delimiterIndex);
  if (
    authority === "" ||
    authority.includes("@") ||
    authority.includes("[") ||
    authority.includes("]")
  ) {
    return false;
  }

  const colonIndex = authority.lastIndexOf(":");
  if (colonIndex !== -1 && authority.indexOf(":") !== colonIndex) {
    return false;
  }
  const hostname = colonIndex === -1 ? authority : authority.slice(0, colonIndex);
  const port = colonIndex === -1 ? undefined : authority.slice(colonIndex + 1);
  const labels = hostname.split(".");

  return (
    hostname.length >= 1 &&
    hostname.length <= 253 &&
    !/^(?:0[xX][0-9A-Fa-f]+|\d+)(?:\.(?:0[xX][0-9A-Fa-f]+|\d+))*$/.test(hostname) &&
    labels.every(
      (label) =>
        standardHostnameLabelPattern.test(label) && !label.toLowerCase().startsWith("xn--"),
    ) &&
    (port === undefined ||
      (/^[1-9]\d{0,4}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) &&
    safeHttpsSuffixPattern.test(suffix) &&
    hasValidPercentEscapes(suffix)
  );
};

const isCatalogResource = (value: string) => {
  if (value.startsWith("/images/")) {
    return (
      localImagePathPattern.test(value) &&
      value
        .split("/")
        .slice(2)
        .every((segment) => segment !== "." && segment !== "..")
    );
  }

  if (!value.startsWith("https://")) {
    return false;
  }
  return isSafeHttpsResource(value);
};

export const catalogResourceSchema = z.string().max(500).refine(isCatalogResource);

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
    cursor: catalogCursorSchema.optional(),
  })
  .strict();

export const propertyListItemSchema = z
  .object({
    id: z.uuid(),
    type: propertyTypeSchema,
    name: nonblankString(120),
    city: catalogCitySchema,
    cover_url: catalogResourceSchema,
    short_description: nonblankString(240),
    facility_highlights: z.array(nonblankString(80)).max(4),
    from_nightly_price_cents: moneyCentsSchema,
    currency: currencySchema,
    available_room_type_count: z.number().int().positive().safe(),
  })
  .strict();

export const propertyListResponseSchema = z
  .object({
    items: z.array(propertyListItemSchema).max(20),
    next_cursor: catalogCursorSchema.nullable(),
  })
  .strict();

export const roomTypeSummarySchema = z
  .object({
    id: z.uuid(),
    name: nonblankString(120),
    bed_type: nonblankString(120),
    area_sqm: z.number().positive(),
    max_guests: z.number().int().min(1).max(10),
    cover_url: catalogResourceSchema,
    policy_summary: nonblankString(500),
    from_nightly_price_cents: moneyCentsSchema,
    currency: currencySchema,
  })
  .strict();

const mediaItemSchema = z
  .object({
    type: z.literal("IMAGE"),
    url: catalogResourceSchema,
    alt: nonblankString(120),
  })
  .strict();

const facilitySchema = z
  .object({
    code: nonblankString(),
    name: nonblankString(),
  })
  .strict();

export const propertyDetailSchema = z
  .object({
    id: z.uuid(),
    type: propertyTypeSchema,
    name: nonblankString(120),
    city: catalogCitySchema,
    address: nonblankString(240),
    description: nonblankString(2000),
    policies: nonblankString(2000),
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
    name: nonblankString(120),
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
    description: nonblankString(2000),
    booking_policy: nonblankString(2000),
    nightly_prices: z.array(nightlyPriceSchema).min(1).max(30),
  })
  .strict();

export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;
export type PropertyListQuery = z.infer<typeof propertyListQuerySchema>;
export type PropertyListResponse = z.infer<typeof propertyListResponseSchema>;
export type PropertyDetail = z.infer<typeof propertyDetailSchema>;
export type RoomTypeDetail = z.infer<typeof roomTypeDetailSchema>;
export type PropertyType = z.infer<typeof propertyTypeSchema>;

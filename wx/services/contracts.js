"use strict";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const CATALOG_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_IMAGE_PATH_PATTERN =
  /^\/images\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const SAFE_HTTPS_SUFFIX_PATTERN = /^[A-Za-z0-9._~!$&'()*+,;=:@/?#%-]*$/;
const STANDARD_HOSTNAME_LABEL_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const CATALOG_CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const PROPERTY_TYPES = ["HOTEL", "HOMESTAY", "FARM_STAY"];

function invalidResponse() {
  const error = new Error("Invalid API response");
  error.code = "INVALID_API_RESPONSE";
  return error;
}

function isObject(value) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonemptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function assertRequestId(value) {
  if (!isNonemptyString(value) || !REQUEST_ID_PATTERN.test(value)) {
    throw invalidResponse();
  }
}

function assertEnvelope(value) {
  if (!isObject(value) || !Object.prototype.hasOwnProperty.call(value, "data")) {
    throw invalidResponse();
  }
  assertRequestId(value.request_id);
  return value;
}

function assertAuthSession(value) {
  if (
    !isObject(value) ||
    typeof value.access_token !== "string" ||
    value.access_token.length < 32 ||
    !isPositiveInteger(value.access_expires_in) ||
    typeof value.refresh_token !== "string" ||
    value.refresh_token.length < 32 ||
    !isPositiveInteger(value.refresh_expires_in) ||
    !isObject(value.user) ||
    typeof value.user.id !== "string" ||
    !UUID_PATTERN.test(value.user.id)
  ) {
    throw invalidResponse();
  }
  return {
    access_token: value.access_token,
    access_expires_in: value.access_expires_in,
    refresh_token: value.refresh_token,
    refresh_expires_in: value.refresh_expires_in,
    user: {
      id: value.user.id,
    },
  };
}

function assertCity(value) {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    !isNonemptyString(value.code) ||
    !isNonemptyString(value.name)
  ) {
    throw invalidResponse();
  }
  return {
    id: value.id,
    code: value.code,
    name: value.name,
  };
}

function assertResolvedLocation(value) {
  if (
    !isObject(value) ||
    !Object.prototype.hasOwnProperty.call(value, "city") ||
    !Number.isInteger(value.distance_meters) ||
    value.distance_meters < 0
  ) {
    throw invalidResponse();
  }
  return {
    city: assertCity(value.city),
    distance_meters: value.distance_meters,
  };
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasExactKeys(value, allowed) {
  return Object.keys(value).length === allowed.length && hasOnlyKeys(value, allowed);
}

function isBoundedString(value, maximum) {
  return isNonemptyString(value) && value.length <= maximum;
}

function isCatalogDate(value) {
  if (typeof value !== "string" || !CATALOG_DATE_PATTERN.test(value)) {
    return false;
  }
  const parts = value.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    isLeapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return (
    year > 0 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth[month - 1]
  );
}

function hasValidPercentEscapes(value) {
  for (
    let index = value.indexOf("%");
    index !== -1;
    index = value.indexOf("%", index + 3)
  ) {
    if (!/^[0-9A-Fa-f]{2}$/.test(value.slice(index + 1, index + 3))) {
      return false;
    }
  }
  return true;
}

function isValidHttpsResource(value) {
  const remainder = value.slice("https://".length);
  const delimiterIndex = remainder.search(/[/?#]/);
  const authority =
    delimiterIndex === -1 ? remainder : remainder.slice(0, delimiterIndex);
  const suffix =
    delimiterIndex === -1 ? "" : remainder.slice(delimiterIndex);
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
  const hostname =
    colonIndex === -1 ? authority : authority.slice(0, colonIndex);
  const port =
    colonIndex === -1 ? undefined : authority.slice(colonIndex + 1);
  const labels = hostname.split(".");

  return (
    hostname.length >= 1 &&
    hostname.length <= 253 &&
    !/^(?:0[xX][0-9A-Fa-f]+|\d+)(?:\.(?:0[xX][0-9A-Fa-f]+|\d+))*$/.test(
      hostname,
    ) &&
    labels.every(
      (label) =>
        STANDARD_HOSTNAME_LABEL_PATTERN.test(label) &&
        !label.toLowerCase().startsWith("xn--"),
    ) &&
    (port === undefined ||
      (/^[1-9]\d{0,4}$/.test(port) &&
        Number(port) >= 1 &&
        Number(port) <= 65535)) &&
    SAFE_HTTPS_SUFFIX_PATTERN.test(suffix) &&
    hasValidPercentEscapes(suffix)
  );
}

function isSafeCatalogResourceUrl(value) {
  if (typeof value !== "string" || value.length > 500) {
    return false;
  }
  if (value.startsWith("/images/")) {
    return (
      LOCAL_IMAGE_PATH_PATTERN.test(value) &&
      value
        .split("/")
        .slice(2)
        .every((segment) => segment !== "." && segment !== "..")
    );
  }
  return (
    value.startsWith("https://") &&
    !/[\s\\]/.test(value) &&
    isValidHttpsResource(value)
  );
}

function assertExactCity(value) {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["id", "code", "name"]) ||
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    !isNonemptyString(value.code) ||
    !isNonemptyString(value.name)
  ) {
    throw invalidResponse();
  }
  return {
    id: value.id,
    code: value.code,
    name: value.name,
  };
}

function assertPropertyType(value) {
  if (!PROPERTY_TYPES.includes(value)) {
    throw invalidResponse();
  }
  return value;
}

function assertCurrency(value) {
  if (value !== "CNY") {
    throw invalidResponse();
  }
  return value;
}

function assertMoneyCents(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidResponse();
  }
  return value;
}

function assertResource(value) {
  if (!isSafeCatalogResourceUrl(value)) {
    throw invalidResponse();
  }
  return value;
}

function assertPropertyListItem(value) {
  const keys = [
    "id",
    "type",
    "name",
    "city",
    "cover_url",
    "short_description",
    "facility_highlights",
    "from_nightly_price_cents",
    "currency",
    "available_room_type_count",
  ];
  if (
    !isObject(value) ||
    !hasExactKeys(value, keys) ||
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    !isBoundedString(value.name, 120) ||
    !isBoundedString(value.short_description, 240) ||
    !Array.isArray(value.facility_highlights) ||
    value.facility_highlights.length > 4 ||
    !value.facility_highlights.every((item) => isBoundedString(item, 80)) ||
    !Number.isSafeInteger(value.available_room_type_count) ||
    value.available_room_type_count <= 0
  ) {
    throw invalidResponse();
  }
  return {
    id: value.id,
    type: assertPropertyType(value.type),
    name: value.name,
    city: assertExactCity(value.city),
    cover_url: assertResource(value.cover_url),
    short_description: value.short_description,
    facility_highlights: value.facility_highlights.slice(),
    from_nightly_price_cents: assertMoneyCents(
      value.from_nightly_price_cents,
    ),
    currency: assertCurrency(value.currency),
    available_room_type_count: value.available_room_type_count,
  };
}

function assertPropertyListResponse(value) {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["items", "next_cursor"]) ||
    !Array.isArray(value.items) ||
    value.items.length > 20 ||
    !(
      value.next_cursor === null ||
      (typeof value.next_cursor === "string" &&
        value.next_cursor.length >= 1 &&
        value.next_cursor.length <= 256 &&
        CATALOG_CURSOR_PATTERN.test(value.next_cursor))
    )
  ) {
    throw invalidResponse();
  }
  return {
    items: value.items.map(assertPropertyListItem),
    next_cursor: value.next_cursor,
  };
}

function assertRoomTypeSummary(value) {
  const keys = [
    "id",
    "name",
    "bed_type",
    "area_sqm",
    "max_guests",
    "cover_url",
    "policy_summary",
    "from_nightly_price_cents",
    "currency",
  ];
  if (
    !isObject(value) ||
    !hasExactKeys(value, keys) ||
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    !isBoundedString(value.name, 120) ||
    !isBoundedString(value.bed_type, 120) ||
    typeof value.area_sqm !== "number" ||
    !Number.isFinite(value.area_sqm) ||
    value.area_sqm <= 0 ||
    !Number.isInteger(value.max_guests) ||
    value.max_guests < 1 ||
    value.max_guests > 10 ||
    !isBoundedString(value.policy_summary, 500)
  ) {
    throw invalidResponse();
  }
  return {
    id: value.id,
    name: value.name,
    bed_type: value.bed_type,
    area_sqm: value.area_sqm,
    max_guests: value.max_guests,
    cover_url: assertResource(value.cover_url),
    policy_summary: value.policy_summary,
    from_nightly_price_cents: assertMoneyCents(
      value.from_nightly_price_cents,
    ),
    currency: assertCurrency(value.currency),
  };
}

function assertMedia(value) {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["type", "url", "alt"]) ||
    value.type !== "IMAGE" ||
    !isBoundedString(value.alt, 120)
  ) {
    throw invalidResponse();
  }
  return {
    type: value.type,
    url: assertResource(value.url),
    alt: value.alt,
  };
}

function assertFacility(value) {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["code", "name"]) ||
    !isNonemptyString(value.code) ||
    !isNonemptyString(value.name)
  ) {
    throw invalidResponse();
  }
  return {
    code: value.code,
    name: value.name,
  };
}

function assertPropertyDetail(value) {
  const keys = [
    "id",
    "type",
    "name",
    "city",
    "address",
    "description",
    "policies",
    "cover_url",
    "media",
    "facilities",
    "room_types",
  ];
  if (
    !isObject(value) ||
    !hasExactKeys(value, keys) ||
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    !isBoundedString(value.name, 120) ||
    !isBoundedString(value.address, 240) ||
    !isBoundedString(value.description, 2000) ||
    !isBoundedString(value.policies, 2000) ||
    !Array.isArray(value.media) ||
    value.media.length > 20 ||
    !Array.isArray(value.facilities) ||
    value.facilities.length > 50 ||
    !Array.isArray(value.room_types) ||
    value.room_types.length < 1
  ) {
    throw invalidResponse();
  }
  return {
    id: value.id,
    type: assertPropertyType(value.type),
    name: value.name,
    city: assertExactCity(value.city),
    address: value.address,
    description: value.description,
    policies: value.policies,
    cover_url: assertResource(value.cover_url),
    media: value.media.map(assertMedia),
    facilities: value.facilities.map(assertFacility),
    room_types: value.room_types.map(assertRoomTypeSummary),
  };
}

function assertNightlyPrice(value) {
  if (
    !isObject(value) ||
    !hasExactKeys(value, [
      "business_date",
      "sale_price_cents",
      "rack_price_cents",
      "currency",
    ]) ||
    !isCatalogDate(value.business_date)
  ) {
    throw invalidResponse();
  }
  return {
    business_date: value.business_date,
    sale_price_cents: assertMoneyCents(value.sale_price_cents),
    rack_price_cents: assertMoneyCents(value.rack_price_cents),
    currency: assertCurrency(value.currency),
  };
}

function assertRoomTypeProperty(value) {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["id", "type", "name", "city"]) ||
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    !isBoundedString(value.name, 120)
  ) {
    throw invalidResponse();
  }
  return {
    id: value.id,
    type: assertPropertyType(value.type),
    name: value.name,
    city: assertExactCity(value.city),
  };
}

function assertRoomTypeDetail(value) {
  const keys = [
    "id",
    "name",
    "bed_type",
    "area_sqm",
    "max_guests",
    "cover_url",
    "currency",
    "property",
    "description",
    "booking_policy",
    "nightly_prices",
  ];
  if (
    !isObject(value) ||
    !hasExactKeys(value, keys) ||
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    !isBoundedString(value.name, 120) ||
    !isBoundedString(value.bed_type, 120) ||
    typeof value.area_sqm !== "number" ||
    !Number.isFinite(value.area_sqm) ||
    value.area_sqm <= 0 ||
    !Number.isInteger(value.max_guests) ||
    value.max_guests < 1 ||
    value.max_guests > 10 ||
    !isBoundedString(value.description, 2000) ||
    !isBoundedString(value.booking_policy, 2000) ||
    !Array.isArray(value.nightly_prices) ||
    value.nightly_prices.length < 1 ||
    value.nightly_prices.length > 30
  ) {
    throw invalidResponse();
  }
  const nightlyPrices = value.nightly_prices.map(assertNightlyPrice);
  for (let index = 1; index < nightlyPrices.length; index += 1) {
    if (
      nightlyPrices[index - 1].business_date >=
      nightlyPrices[index].business_date
    ) {
      throw invalidResponse();
    }
  }
  return {
    id: value.id,
    name: value.name,
    bed_type: value.bed_type,
    area_sqm: value.area_sqm,
    max_guests: value.max_guests,
    cover_url: assertResource(value.cover_url),
    currency: assertCurrency(value.currency),
    property: assertRoomTypeProperty(value.property),
    description: value.description,
    booking_policy: value.booking_policy,
    nightly_prices: nightlyPrices,
  };
}

function assertApiErrorResponse(value) {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["error", "request_id"]) ||
    !isObject(value.error) ||
    !hasOnlyKeys(value.error, ["code", "message", "details"]) ||
    !isNonemptyString(value.error.code) ||
    !isNonemptyString(value.error.message)
  ) {
    throw invalidResponse();
  }
  assertRequestId(value.request_id);
  return value;
}

module.exports = {
  assertApiErrorResponse,
  assertAuthSession,
  assertCity,
  assertEnvelope,
  assertPropertyDetail,
  assertPropertyListResponse,
  assertResolvedLocation,
  assertRoomTypeDetail,
  isSafeCatalogResourceUrl,
};

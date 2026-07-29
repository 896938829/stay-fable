"use strict";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const CATALOG_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_IMAGE_PATH_PATTERN =
  /^\/images\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
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

function parseIpv4Number(value) {
  let digits = value;
  let radix = 10;
  if (/^0[xX]/.test(digits)) {
    digits = digits.slice(2);
    radix = 16;
  } else if (digits.length >= 2 && digits.startsWith("0")) {
    digits = digits.slice(1);
    radix = 8;
  }
  if (digits === "") {
    return 0;
  }
  const patterns = {
    8: /^[0-7]+$/,
    10: /^\d+$/,
    16: /^[0-9A-Fa-f]+$/,
  };
  if (!patterns[radix].test(digits)) {
    return null;
  }
  const parsed = Number.parseInt(digits, radix);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function hasValidWhatwgIpv4Syntax(hostname) {
  const parts = hostname.split(".");
  if (parts[parts.length - 1] === "") {
    parts.pop();
  }
  if (parts.length < 1) {
    return false;
  }
  const lastPart = parts[parts.length - 1];
  const lastNumber = parseIpv4Number(lastPart);
  const endsInNumber = lastNumber !== null || /^\d+$/.test(lastPart);
  if (!endsInNumber) {
    return true;
  }
  if (parts.length > 4) {
    return false;
  }
  const numbers = parts.map(parseIpv4Number);
  if (numbers.some((part) => part === null)) {
    return false;
  }
  for (let index = 0; index < numbers.length - 1; index += 1) {
    if (numbers[index] > 255) {
      return false;
    }
  }
  return numbers[numbers.length - 1] < 256 ** (5 - numbers.length);
}

function isValidEmbeddedIpv4(value) {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every(
      (part) =>
        /^(?:0|[1-9]\d{0,2})$/.test(part) &&
        Number(part) >= 0 &&
        Number(part) <= 255,
    )
  );
}

function isValidIpv6Literal(value) {
  const halves = value.split("::");
  if (halves.length > 2) {
    return false;
  }
  const segments = [];
  for (const half of halves) {
    if (half === "") {
      continue;
    }
    const halfSegments = half.split(":");
    if (halfSegments.some((segment) => segment === "")) {
      return false;
    }
    segments.push(...halfSegments);
  }

  let units = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.includes(".")) {
      if (
        index !== segments.length - 1 ||
        !isValidEmbeddedIpv4(segment) ||
        (halves.length === 2 && halves[1] === "")
      ) {
        return false;
      }
      units += 2;
    } else {
      if (!/^[0-9A-Fa-f]{1,4}$/.test(segment)) {
        return false;
      }
      units += 1;
    }
  }
  return halves.length === 2 ? units < 8 : units === 8;
}

function isValidPort(value) {
  if (value === "") {
    return true;
  }
  if (!/^\d+$/.test(value)) {
    return false;
  }
  const normalized = value.replace(/^0+/, "") || "0";
  return normalized.length <= 5 && Number(normalized) <= 65535;
}

function isValidWhatwgHostname(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
    encodeURI(decoded);
  } catch {
    return false;
  }
  if (
    decoded === "" ||
    /[\u0000-\u0020\u007f#%/:<>?@[\\\]^|]/.test(decoded)
  ) {
    return false;
  }
  return hasValidWhatwgIpv4Syntax(decoded);
}

function isValidHttpsResource(value) {
  const remainder = value.slice("https://".length);
  const delimiterIndex = remainder.search(/[/?#]/);
  const authority =
    delimiterIndex === -1 ? remainder : remainder.slice(0, delimiterIndex);
  if (authority === "" || authority.includes("@")) {
    return false;
  }

  if (authority.startsWith("[")) {
    const closingBracket = authority.indexOf("]");
    if (closingBracket === -1) {
      return false;
    }
    const literal = authority.slice(1, closingBracket);
    const suffix = authority.slice(closingBracket + 1);
    if (
      !isValidIpv6Literal(literal) ||
      (suffix !== "" &&
        (!suffix.startsWith(":") || !isValidPort(suffix.slice(1))))
    ) {
      return false;
    }
    return true;
  }

  if (authority.includes("[") || authority.includes("]")) {
    return false;
  }
  const colonIndex = authority.lastIndexOf(":");
  if (colonIndex !== -1 && authority.indexOf(":") !== colonIndex) {
    return false;
  }
  const hostname =
    colonIndex === -1 ? authority : authority.slice(0, colonIndex);
  const port = colonIndex === -1 ? null : authority.slice(colonIndex + 1);
  return (
    isValidWhatwgHostname(hostname) &&
    (port === null || isValidPort(port))
  );
}

function isCatalogResource(value) {
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
  if (!isCatalogResource(value)) {
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
    !isPositiveInteger(value.available_room_type_count)
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
    !(
      value.next_cursor === null ||
      (typeof value.next_cursor === "string" &&
        value.next_cursor.length >= 1 &&
        value.next_cursor.length <= 256)
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
};

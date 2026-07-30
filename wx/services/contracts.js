"use strict";

const CONTRACT_SHAPES = require("./contract-shapes");

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
const BOOKING_NUMBER_PATTERN = /^SF[0-9]{8}[A-F0-9]{12}$/;
const PAYMENT_NUMBER_PATTERN = /^SFP[0-9]{8}[A-F0-9]{12}$/;
const INSTANT_PATTERN =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const PROPERTY_TYPES = ["HOTEL", "HOMESTAY", "FARM_STAY"];
const BOOKING_STATUSES = [
  "PENDING_PAYMENT",
  "PAID",
  "CONFIRMED",
  "CANCELLED",
  "CLOSED",
];
const BOOKING_ACTIONS = [
  "CANCEL",
  "MOCK_PAY_SUCCESS",
  "MOCK_PAY_FAILURE",
];

function shapeFields(name) {
  return CONTRACT_SHAPES[name].fields;
}

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
  let snapshot;
  try {
    snapshot = readExactRecord(value, shapeFields("AuthSessionEnvelopeDto"));
  } catch {
    throw invalidResponse();
  }
  assertRequestId(snapshot.request_id);
  return {
    data: snapshot.data,
    request_id: snapshot.request_id,
  };
}

function assertAuthSession(value) {
  try {
    const snapshot = readExactRecord(value, shapeFields("AuthSessionResponseDto"));
    const user = readExactRecord(snapshot.user, shapeFields("AuthSessionUserDto"));
    if (
      typeof snapshot.access_token !== "string" ||
      snapshot.access_token.length < 32 ||
      !isPositiveInteger(snapshot.access_expires_in) ||
      typeof snapshot.refresh_token !== "string" ||
      snapshot.refresh_token.length < 32 ||
      !isPositiveInteger(snapshot.refresh_expires_in) ||
      typeof user.id !== "string" ||
      !UUID_PATTERN.test(user.id)
    ) {
      throw invalidResponse();
    }
    return {
      access_token: snapshot.access_token,
      access_expires_in: snapshot.access_expires_in,
      refresh_token: snapshot.refresh_token,
      refresh_expires_in: snapshot.refresh_expires_in,
      user: {
        id: user.id,
      },
    };
  } catch {
    throw invalidResponse();
  }
}

function canonicalCity(value, exact) {
  try {
    const snapshot = exact
      ? readExactRecord(value, shapeFields("CatalogCityDto"))
      : value;
    if (!isObject(snapshot)) {
      throw invalidResponse();
    }
    const descriptors = Object.getOwnPropertyDescriptors(snapshot);
    for (const key of ["id", "code", "name"]) {
      if (
        descriptors[key] === undefined ||
        !Object.hasOwn(descriptors[key], "value")
      ) {
        throw invalidResponse();
      }
    }
    const id = descriptors.id.value;
    const code = descriptors.code.value;
    const name = descriptors.name.value;
    if (
      typeof id !== "string" ||
      !UUID_PATTERN.test(id) ||
      !isBoundedString(code, 32) ||
      !isBoundedString(name, 80)
    ) {
      throw invalidResponse();
    }
    return { id, code, name };
  } catch {
    throw invalidResponse();
  }
}

function assertCity(value) {
  return canonicalCity(value, true);
}

function assertResolvedLocation(value) {
  try {
    const snapshot = readExactRecord(value, shapeFields("ResolvedLocationResponseDto"));
    if (
      !Number.isInteger(snapshot.distance_meters) ||
      snapshot.distance_meters < 0
    ) {
      throw invalidResponse();
    }
    return {
      city: assertCity(snapshot.city),
      distance_meters: snapshot.distance_meters,
    };
  } catch {
    throw invalidResponse();
  }
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasExactKeys(value, allowed) {
  return Object.keys(value).length === allowed.length && hasOnlyKeys(value, allowed);
}

function readExactRecordUnsafe(value, keys) {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw invalidResponse();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    !hasExactKeys(descriptors, keys)
  ) {
    throw invalidResponse();
  }
  const snapshot = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw invalidResponse();
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function readExactRecord(value, keys) {
  try {
    return readExactRecordUnsafe(value, keys);
  } catch {
    throw invalidResponse();
  }
}

function readRecordWithOptionalUnsafe(value, requiredKeys, optionalKeys) {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw invalidResponse();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualKeys = Object.keys(descriptors);
  const allowedKeys = [...requiredKeys, ...optionalKeys];
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    !requiredKeys.every((key) => Object.hasOwn(descriptors, key)) ||
    !actualKeys.every((key) => allowedKeys.includes(key))
  ) {
    throw invalidResponse();
  }
  const snapshot = Object.create(null);
  for (const key of actualKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw invalidResponse();
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function readRecordWithOptional(value, requiredKeys, optionalKeys) {
  try {
    return readRecordWithOptionalUnsafe(value, requiredKeys, optionalKeys);
  } catch {
    throw invalidResponse();
  }
}

function readExactArrayUnsafe(value, minimum, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw invalidResponse();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (
    !Number.isSafeInteger(length) ||
    length < minimum ||
    length > maximum ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(descriptors).length !== length + 1
  ) {
    throw invalidResponse();
  }
  const snapshot = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw invalidResponse();
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function readExactArray(value, minimum, maximum) {
  try {
    return readExactArrayUnsafe(value, minimum, maximum);
  } catch {
    throw invalidResponse();
  }
}

function assertBookingStatus(value) {
  if (!BOOKING_STATUSES.includes(value)) {
    throw invalidResponse();
  }
  return value;
}

function assertBookingListItem(value) {
  const snapshot = readExactRecord(value, shapeFields("BookingListItemDto"));
  const checkin = catalogDateOrdinal(snapshot.checkin);
  const checkout = catalogDateOrdinal(snapshot.checkout);
  if (
    typeof snapshot.booking_number !== "string" ||
    !BOOKING_NUMBER_PATTERN.test(snapshot.booking_number) ||
    !isBoundedString(snapshot.property_name, 120) ||
    !isBoundedString(snapshot.room_type_name, 120) ||
    !Number.isInteger(snapshot.nights) ||
    snapshot.nights < 1 ||
    snapshot.nights > 30 ||
    checkout - checkin !== snapshot.nights ||
    !Number.isInteger(snapshot.guests) ||
    snapshot.guests < 1 ||
    snapshot.guests > 10 ||
    typeof snapshot.payment_deadline_passed !== "boolean"
  ) {
    throw invalidResponse();
  }
  return {
    booking_id: assertUuid(snapshot.booking_id),
    booking_number: snapshot.booking_number,
    status: assertBookingStatus(snapshot.status),
    property_name: snapshot.property_name,
    room_type_name: snapshot.room_type_name,
    checkin: snapshot.checkin,
    checkout: snapshot.checkout,
    nights: snapshot.nights,
    guests: snapshot.guests,
    total_price_cents: assertMoneyCents(snapshot.total_price_cents),
    currency: assertCurrency(snapshot.currency),
    expires_at: assertInstant(snapshot.expires_at),
    payment_deadline_passed: snapshot.payment_deadline_passed,
    created_at: assertInstant(snapshot.created_at),
    updated_at: assertInstant(snapshot.updated_at),
  };
}

function assertBookingListResponse(value) {
  try {
    const snapshot = readExactRecord(value, shapeFields("BookingListResponseDto"));
    const items = readExactArray(snapshot.items, 0, 20).map(
      assertBookingListItem,
    );
    if (
      snapshot.next_cursor !== null &&
      (typeof snapshot.next_cursor !== "string" ||
        snapshot.next_cursor.length < 1 ||
        snapshot.next_cursor.length > 512 ||
        !CATALOG_CURSOR_PATTERN.test(snapshot.next_cursor))
    ) {
      throw invalidResponse();
    }
    return {
      items,
      next_cursor: snapshot.next_cursor,
    };
  } catch {
    throw invalidResponse();
  }
}

function assertBookingPayment(value) {
  const snapshot = readExactRecord(value, shapeFields("BookingPaymentSummaryDto"));
  if (
    typeof snapshot.payment_number !== "string" ||
    !PAYMENT_NUMBER_PATTERN.test(snapshot.payment_number) ||
    !["SUCCEEDED", "FAILED"].includes(snapshot.status)
  ) {
    throw invalidResponse();
  }
  return {
    payment_number: snapshot.payment_number,
    status: snapshot.status,
    processed_at: assertInstant(snapshot.processed_at),
  };
}

function assertBookingHistoryItem(value) {
  const snapshot = readExactRecord(value, shapeFields("BookingStatusHistoryItemDto"));
  const fromStatus =
    snapshot.from_status === null
      ? null
      : assertBookingStatus(snapshot.from_status);
  const toStatus = assertBookingStatus(snapshot.to_status);
  const validTransition =
    (fromStatus === null && toStatus === "PENDING_PAYMENT") ||
    (fromStatus === "PENDING_PAYMENT" &&
      ["PAID", "CANCELLED", "CLOSED"].includes(toStatus)) ||
    (fromStatus === "PAID" &&
      ["CONFIRMED", "CLOSED"].includes(toStatus));
  if (
    !validTransition ||
    !isBoundedString(snapshot.reason, 120) ||
    !["USER", "SYSTEM"].includes(snapshot.actor_type)
  ) {
    throw invalidResponse();
  }
  return {
    from_status: fromStatus,
    to_status: toStatus,
    reason: snapshot.reason,
    actor_type: snapshot.actor_type,
    created_at: assertInstant(snapshot.created_at),
  };
}

function assertBookingActions(value, status, deadlinePassed) {
  const actions = readExactArray(value, 0, 3);
  let previousIndex = -1;
  for (const action of actions) {
    const index = BOOKING_ACTIONS.indexOf(action);
    if (index <= previousIndex) {
      throw invalidResponse();
    }
    previousIndex = index;
  }
  if (
    actions.length > 0 &&
    (status !== "PENDING_PAYMENT" || deadlinePassed)
  ) {
    throw invalidResponse();
  }
  return actions;
}

function assertBookingDetail(value) {
  try {
    const snapshot = readExactRecord(value, shapeFields("BookingDetailDto"));
    const summary = assertBookingListItem(
      Object.assign(Object.create(null), {
        booking_id: snapshot.booking_id,
        booking_number: snapshot.booking_number,
        status: snapshot.status,
        property_name: snapshot.property_name,
        room_type_name: snapshot.room_type_name,
        checkin: snapshot.checkin,
        checkout: snapshot.checkout,
        nights: snapshot.nights,
        guests: snapshot.guests,
        total_price_cents: snapshot.total_price_cents,
        currency: snapshot.currency,
        expires_at: snapshot.expires_at,
        payment_deadline_passed: snapshot.payment_deadline_passed,
        created_at: snapshot.created_at,
        updated_at: snapshot.updated_at,
      }),
    );
    const nightlyPrices = readExactArray(
      snapshot.nightly_prices,
      1,
      30,
    ).map(assertNightlyPrice);
    if (
      !isBoundedString(snapshot.booking_policy, 2000) ||
      nightlyPrices.length !== summary.nights
    ) {
      throw invalidResponse();
    }
    let total = 0;
    const checkin = catalogDateOrdinal(summary.checkin);
    for (let index = 0; index < nightlyPrices.length; index += 1) {
      const nightly = nightlyPrices[index];
      if (
        catalogDateOrdinal(nightly.business_date) !== checkin + index ||
        nightly.rack_price_cents < nightly.sale_price_cents
      ) {
        throw invalidResponse();
      }
      total += nightly.sale_price_cents;
      if (!Number.isSafeInteger(total)) {
        throw invalidResponse();
      }
    }
    if (total !== summary.total_price_cents) {
      throw invalidResponse();
    }
    const statusHistory = readExactArray(
      snapshot.status_history,
      0,
      100,
    ).map(assertBookingHistoryItem);
    for (let index = 1; index < statusHistory.length; index += 1) {
      if (
        statusHistory[index].from_status !==
          statusHistory[index - 1].to_status ||
        Date.parse(statusHistory[index].created_at) <
          Date.parse(statusHistory[index - 1].created_at)
      ) {
        throw invalidResponse();
      }
    }
    if (
      statusHistory.length > 0 &&
      statusHistory[statusHistory.length - 1].to_status !== summary.status
    ) {
      throw invalidResponse();
    }
    return {
      ...summary,
      nightly_prices: nightlyPrices,
      booking_policy: snapshot.booking_policy,
      latest_payment:
        snapshot.latest_payment === null
          ? null
          : assertBookingPayment(snapshot.latest_payment),
      status_history: statusHistory,
      allowed_actions: assertBookingActions(
        snapshot.allowed_actions,
        summary.status,
        summary.payment_deadline_passed,
      ),
    };
  } catch {
    throw invalidResponse();
  }
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
  return canonicalCity(value, true);
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
  const snapshot = readExactRecord(value, shapeFields("PropertyListItemDto"));
  const facilityHighlights = readExactArray(snapshot.facility_highlights, 0, 4);
  if (
    typeof snapshot.id !== "string" ||
    !UUID_PATTERN.test(snapshot.id) ||
    !isBoundedString(snapshot.name, 120) ||
    !isBoundedString(snapshot.short_description, 240) ||
    !facilityHighlights.every((item) => isBoundedString(item, 80)) ||
    !Number.isSafeInteger(snapshot.available_room_type_count) ||
    snapshot.available_room_type_count <= 0
  ) {
    throw invalidResponse();
  }
  return {
    id: snapshot.id,
    type: assertPropertyType(snapshot.type),
    name: snapshot.name,
    city: assertExactCity(snapshot.city),
    cover_url: assertResource(snapshot.cover_url),
    short_description: snapshot.short_description,
    facility_highlights: facilityHighlights,
    from_nightly_price_cents: assertMoneyCents(
      snapshot.from_nightly_price_cents,
    ),
    currency: assertCurrency(snapshot.currency),
    available_room_type_count: snapshot.available_room_type_count,
  };
}

function assertPropertyListResponse(value) {
  const snapshot = readExactRecord(value, shapeFields("PropertyListResponseDto"));
  const items = readExactArray(snapshot.items, 0, 20);
  if (
    !(
      snapshot.next_cursor === null ||
      (typeof snapshot.next_cursor === "string" &&
        snapshot.next_cursor.length >= 1 &&
        snapshot.next_cursor.length <= 256 &&
        CATALOG_CURSOR_PATTERN.test(snapshot.next_cursor))
    )
  ) {
    throw invalidResponse();
  }
  return {
    items: items.map(assertPropertyListItem),
    next_cursor: snapshot.next_cursor,
  };
}

function assertRoomTypeSummary(value) {
  const snapshot = readExactRecord(value, shapeFields("RoomTypeSummaryDto"));
  if (
    typeof snapshot.id !== "string" ||
    !UUID_PATTERN.test(snapshot.id) ||
    !isBoundedString(snapshot.name, 120) ||
    !isBoundedString(snapshot.bed_type, 120) ||
    typeof snapshot.area_sqm !== "number" ||
    !Number.isFinite(snapshot.area_sqm) ||
    snapshot.area_sqm <= 0 ||
    !Number.isInteger(snapshot.max_guests) ||
    snapshot.max_guests < 1 ||
    snapshot.max_guests > 10 ||
    !isBoundedString(snapshot.policy_summary, 500)
  ) {
    throw invalidResponse();
  }
  return {
    id: snapshot.id,
    name: snapshot.name,
    bed_type: snapshot.bed_type,
    area_sqm: snapshot.area_sqm,
    max_guests: snapshot.max_guests,
    cover_url: assertResource(snapshot.cover_url),
    policy_summary: snapshot.policy_summary,
    from_nightly_price_cents: assertMoneyCents(
      snapshot.from_nightly_price_cents,
    ),
    currency: assertCurrency(snapshot.currency),
  };
}

function assertMedia(value) {
  const snapshot = readExactRecord(value, shapeFields("CatalogMediaDto"));
  if (
    snapshot.type !== "IMAGE" ||
    !isBoundedString(snapshot.alt, 120)
  ) {
    throw invalidResponse();
  }
  return {
    type: snapshot.type,
    url: assertResource(snapshot.url),
    alt: snapshot.alt,
  };
}

function assertFacility(value) {
  const snapshot = readExactRecord(value, shapeFields("CatalogFacilityDto"));
  if (
    !isBoundedString(snapshot.code, 64) ||
    !isBoundedString(snapshot.name, 80)
  ) {
    throw invalidResponse();
  }
  return {
    code: snapshot.code,
    name: snapshot.name,
  };
}

function assertPropertyDetail(value) {
  const snapshot = readExactRecord(value, shapeFields("PropertyDetailResponseDto"));
  const media = readExactArray(snapshot.media, 0, 20);
  const facilities = readExactArray(snapshot.facilities, 0, 50);
  const roomTypes = readExactArray(snapshot.room_types, 0, 50);
  if (
    typeof snapshot.id !== "string" ||
    !UUID_PATTERN.test(snapshot.id) ||
    !isBoundedString(snapshot.name, 120) ||
    !isBoundedString(snapshot.address, 240) ||
    !isBoundedString(snapshot.description, 2000) ||
    !isBoundedString(snapshot.policies, 2000)
  ) {
    throw invalidResponse();
  }
  return {
    id: snapshot.id,
    type: assertPropertyType(snapshot.type),
    name: snapshot.name,
    city: assertExactCity(snapshot.city),
    address: snapshot.address,
    description: snapshot.description,
    policies: snapshot.policies,
    cover_url: assertResource(snapshot.cover_url),
    media: media.map(assertMedia),
    facilities: facilities.map(assertFacility),
    room_types: roomTypes.map(assertRoomTypeSummary),
  };
}

function assertNightlyPrice(value) {
  const snapshot = readExactRecord(value, shapeFields("NightlyPriceDto"));
  if (
    !isCatalogDate(snapshot.business_date)
  ) {
    throw invalidResponse();
  }
  return {
    business_date: snapshot.business_date,
    sale_price_cents: assertMoneyCents(snapshot.sale_price_cents),
    rack_price_cents: assertMoneyCents(snapshot.rack_price_cents),
    currency: assertCurrency(snapshot.currency),
  };
}

function assertRoomTypeProperty(value) {
  const snapshot = readExactRecord(value, shapeFields("RoomTypePropertySummaryDto"));
  if (
    typeof snapshot.id !== "string" ||
    !UUID_PATTERN.test(snapshot.id) ||
    !isBoundedString(snapshot.name, 120)
  ) {
    throw invalidResponse();
  }
  return {
    id: snapshot.id,
    type: assertPropertyType(snapshot.type),
    name: snapshot.name,
    city: assertExactCity(snapshot.city),
  };
}

function assertRoomTypeDetail(value) {
  const snapshot = readExactRecord(value, shapeFields("RoomTypeDetailResponseDto"));
  const nightlyPrices = readExactArray(snapshot.nightly_prices, 1, 30).map(
    assertNightlyPrice,
  );
  if (
    typeof snapshot.id !== "string" ||
    !UUID_PATTERN.test(snapshot.id) ||
    !isBoundedString(snapshot.name, 120) ||
    !isBoundedString(snapshot.bed_type, 120) ||
    typeof snapshot.area_sqm !== "number" ||
    !Number.isFinite(snapshot.area_sqm) ||
    snapshot.area_sqm <= 0 ||
    !Number.isInteger(snapshot.max_guests) ||
    snapshot.max_guests < 1 ||
    snapshot.max_guests > 10 ||
    !isBoundedString(snapshot.description, 2000) ||
    !isBoundedString(snapshot.booking_policy, 2000)
  ) {
    throw invalidResponse();
  }
  for (let index = 1; index < nightlyPrices.length; index += 1) {
    if (
      nightlyPrices[index - 1].business_date >=
      nightlyPrices[index].business_date
    ) {
      throw invalidResponse();
    }
  }
  return {
    id: snapshot.id,
    name: snapshot.name,
    bed_type: snapshot.bed_type,
    area_sqm: snapshot.area_sqm,
    max_guests: snapshot.max_guests,
    cover_url: assertResource(snapshot.cover_url),
    currency: assertCurrency(snapshot.currency),
    property: assertRoomTypeProperty(snapshot.property),
    description: snapshot.description,
    booking_policy: snapshot.booking_policy,
    nightly_prices: nightlyPrices,
  };
}

function catalogDateOrdinal(value) {
  if (!isCatalogDate(value)) {
    throw invalidResponse();
  }
  const [year, month, day] = value.split("-").map(Number);
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const dayOfYear =
    Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return era * 146097 + dayOfEra;
}

function assertInstant(value) {
  if (typeof value !== "string") {
    throw invalidResponse();
  }
  const match = INSTANT_PATTERN.exec(value);
  if (
    !match ||
    !isCatalogDate(match[1]) ||
    Number(match[2]) > 23 ||
    Number(match[3]) > 59 ||
    Number(match[4]) > 59 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw invalidResponse();
  }
  return value;
}

function assertUuid(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw invalidResponse();
  }
  return value;
}

function assertQuoteParty(value, roomType) {
  const keys = shapeFields(roomType ? "QuoteRoomTypeDto" : "QuotePropertyDto");
  const snapshot = readExactRecord(value, keys);
  if (!isBoundedString(snapshot.name, 120)) {
    throw invalidResponse();
  }
  return {
    id: assertUuid(snapshot.id),
    name: snapshot.name,
    ...(roomType ? { cover_url: assertResource(snapshot.cover_url) } : {}),
  };
}

function assertQuoteResponse(value, requestedRoomTypeId) {
  try {
    assertUuid(requestedRoomTypeId);
    const snapshot = readExactRecord(value, shapeFields("QuoteResponseDto"));
    const property = assertQuoteParty(snapshot.property, false);
    const roomType = assertQuoteParty(snapshot.room_type, true);
    const checkinOrdinal = catalogDateOrdinal(snapshot.checkin);
    const checkoutOrdinal = catalogDateOrdinal(snapshot.checkout);
    const nights = checkoutOrdinal - checkinOrdinal;
    const nightlyPrices = readExactArray(snapshot.nightly_prices, 1, 30).map(
      assertNightlyPrice,
    );
    if (
      roomType.id !== requestedRoomTypeId ||
      !Number.isInteger(snapshot.nights) ||
      snapshot.nights < 1 ||
      snapshot.nights > 30 ||
      snapshot.nights !== nights ||
      nightlyPrices.length !== nights ||
      !Number.isInteger(snapshot.guests) ||
      snapshot.guests < 1 ||
      snapshot.guests > 10 ||
      !isBoundedString(snapshot.booking_policy, 2000)
    ) {
      throw invalidResponse();
    }
    let total = 0;
    for (let index = 0; index < nightlyPrices.length; index += 1) {
      const nightly = nightlyPrices[index];
      if (
        catalogDateOrdinal(nightly.business_date) !== checkinOrdinal + index ||
        nightly.rack_price_cents < nightly.sale_price_cents
      ) {
        throw invalidResponse();
      }
      total += nightly.sale_price_cents;
      if (!Number.isSafeInteger(total)) {
        throw invalidResponse();
      }
    }
    if (assertMoneyCents(snapshot.total_price_cents) !== total) {
      throw invalidResponse();
    }
    return {
      quote_id: assertUuid(snapshot.quote_id),
      property,
      room_type: roomType,
      checkin: snapshot.checkin,
      checkout: snapshot.checkout,
      nights: snapshot.nights,
      guests: snapshot.guests,
      nightly_prices: nightlyPrices,
      total_price_cents: snapshot.total_price_cents,
      currency: assertCurrency(snapshot.currency),
      booking_policy: snapshot.booking_policy,
      expires_at: assertInstant(snapshot.expires_at),
    };
  } catch {
    throw invalidResponse();
  }
}

function assertBookingResponse(value, requestedQuoteId) {
  try {
    assertUuid(requestedQuoteId);
    const snapshot = readExactRecord(value, shapeFields("BookingResponseDto"));
    if (snapshot.quote_id !== requestedQuoteId) {
      throw invalidResponse();
    }
    const nights =
      catalogDateOrdinal(snapshot.checkout) - catalogDateOrdinal(snapshot.checkin);
    if (
      typeof snapshot.booking_number !== "string" ||
      !BOOKING_NUMBER_PATTERN.test(snapshot.booking_number) ||
      snapshot.status !== "PENDING_PAYMENT" ||
      !isBoundedString(snapshot.property_name, 120) ||
      !isBoundedString(snapshot.room_type_name, 120) ||
      !Number.isInteger(snapshot.nights) ||
      snapshot.nights < 1 ||
      snapshot.nights > 30 ||
      snapshot.nights !== nights ||
      !Number.isInteger(snapshot.guests) ||
      snapshot.guests < 1 ||
      snapshot.guests > 10
    ) {
      throw invalidResponse();
    }
    return {
      booking_id: assertUuid(snapshot.booking_id),
      quote_id: assertUuid(snapshot.quote_id),
      booking_number: snapshot.booking_number,
      status: snapshot.status,
      property_name: snapshot.property_name,
      room_type_name: snapshot.room_type_name,
      checkin: snapshot.checkin,
      checkout: snapshot.checkout,
      nights: snapshot.nights,
      guests: snapshot.guests,
      total_price_cents: assertMoneyCents(snapshot.total_price_cents),
      currency: assertCurrency(snapshot.currency),
      expires_at: assertInstant(snapshot.expires_at),
      created_at: assertInstant(snapshot.created_at),
    };
  } catch {
    throw invalidResponse();
  }
}

function assertQuoteChangedDetails(value, expectedQuote) {
  try {
    const context = readExactRecord(expectedQuote, [
      "property_id",
      "room_type_id",
    ]);
    assertUuid(context.property_id);
    assertUuid(context.room_type_id);
    const snapshot = readExactRecord(value, [
      "previous_total_price_cents",
      "replacement_quote",
    ]);
    const replacementRoom = readExactRecord(snapshot.replacement_quote, [
      "quote_id",
      "property",
      "room_type",
      "checkin",
      "checkout",
      "nights",
      "guests",
      "nightly_prices",
      "total_price_cents",
      "currency",
      "booking_policy",
      "expires_at",
    ]);
    const room = readExactRecord(replacementRoom.room_type, [
      "id",
      "name",
      "cover_url",
    ]);
    const property = readExactRecord(replacementRoom.property, ["id", "name"]);
    if (
      property.id !== context.property_id ||
      room.id !== context.room_type_id
    ) {
      throw invalidResponse();
    }
    return {
      previous_total_price_cents: assertMoneyCents(
        snapshot.previous_total_price_cents,
      ),
      replacement_quote: assertQuoteResponse(
        snapshot.replacement_quote,
        room.id,
      ),
    };
  } catch {
    throw invalidResponse();
  }
}

function assertApiErrorResponse(value) {
  let envelope;
  let error;
  try {
    envelope = readExactRecord(value, ["error", "request_id"]);
    error = readRecordWithOptional(envelope.error, ["code", "message"], ["details"]);
  } catch {
    throw invalidResponse();
  }
  if (!isNonemptyString(error.code) || !isNonemptyString(error.message)) {
    throw invalidResponse();
  }
  assertRequestId(envelope.request_id);
  return value;
}

module.exports = {
  assertApiErrorResponse,
  assertAuthSession,
  assertBookingResponse,
  assertBookingDetail,
  assertBookingListResponse,
  assertCity,
  assertEnvelope,
  assertPropertyDetail,
  assertPropertyListResponse,
  assertQuoteChangedDetails,
  assertQuoteResponse,
  assertResolvedLocation,
  assertRoomTypeDetail,
  isSafeCatalogResourceUrl,
};

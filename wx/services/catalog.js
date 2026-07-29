"use strict";

const {
  assertPropertyDetail,
  assertPropertyListResponse,
  assertRoomTypeDetail,
} = require("./contracts");

// Catalog route identifiers mirror canonical lowercase PostgreSQL UUID v4 text.
const CANONICAL_UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PROPERTY_TYPES = ["HOTEL", "HOMESTAY", "FARM_STAY"];
const CATALOG_CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const AVAILABILITY_KEYS = ["checkin", "checkout", "guests"];
const LIST_QUERY_KEYS = [
  "city_id",
  ...AVAILABILITY_KEYS,
  "property_type",
  "page_size",
  "cursor",
];

function catalogInputError() {
  const error = new Error("Invalid catalog input");
  error.code = "INVALID_CATALOG_INPUT";
  return error;
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

function parseDate(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    throw catalogInputError();
  }
  const parts = value.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leap ? 29 : 28,
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
  if (
    year <= 0 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1]
  ) {
    throw catalogInputError();
  }
  let ordinal =
    (year - 1) * 365 +
    Math.floor((year - 1) / 4) -
    Math.floor((year - 1) / 100) +
    Math.floor((year - 1) / 400) +
    day;
  for (let currentMonth = 1; currentMonth < month; currentMonth += 1) {
    ordinal += daysInMonth[currentMonth - 1];
  }
  return ordinal;
}

function readInputSnapshot(value, allowedKeys, requiredKeys) {
  try {
    if (!isObject(value)) {
      throw catalogInputError();
    }
    const keys = Object.keys(value);
    if (
      keys.some((key) => !allowedKeys.includes(key)) ||
      requiredKeys.some((key) => !keys.includes(key))
    ) {
      throw catalogInputError();
    }
    const snapshot = Object.create(null);
    for (const key of keys) {
      snapshot[key] = value[key];
    }
    return Object.freeze(snapshot);
  } catch {
    throw catalogInputError();
  }
}

function assertAvailability(value) {
  const checkinOrdinal = parseDate(value.checkin);
  const checkoutOrdinal = parseDate(value.checkout);
  const nights = checkoutOrdinal - checkinOrdinal;
  if (
    nights < 1 ||
    nights > 30 ||
    !Number.isInteger(value.guests) ||
    value.guests < 1 ||
    value.guests > 10
  ) {
    throw catalogInputError();
  }
  return Object.freeze({
    checkin: value.checkin,
    checkout: value.checkout,
    guests: value.guests,
    checkinOrdinal,
    checkoutOrdinal,
    nights,
  });
}

function snapshotAvailability(value) {
  return assertAvailability(
    readInputSnapshot(value, AVAILABILITY_KEYS, AVAILABILITY_KEYS),
  );
}

function snapshotListQuery(value) {
  const input = readInputSnapshot(value, LIST_QUERY_KEYS, [
    "city_id",
    ...AVAILABILITY_KEYS,
  ]);
  const availability = assertAvailability(input);
  if (
    typeof input.city_id !== "string" ||
    !CANONICAL_UUID_V4_PATTERN.test(input.city_id) ||
    (Object.prototype.hasOwnProperty.call(input, "property_type") &&
      !PROPERTY_TYPES.includes(input.property_type)) ||
    (Object.prototype.hasOwnProperty.call(input, "page_size") &&
      (!Number.isInteger(input.page_size) ||
        input.page_size < 1 ||
        input.page_size > 20)) ||
    (Object.prototype.hasOwnProperty.call(input, "cursor") &&
      (typeof input.cursor !== "string" ||
        input.cursor.length < 1 ||
        input.cursor.length > 256 ||
        !CATALOG_CURSOR_PATTERN.test(input.cursor)))
  ) {
    throw catalogInputError();
  }
  return Object.freeze({
    city_id: input.city_id,
    ...availability,
    ...(Object.prototype.hasOwnProperty.call(input, "property_type")
      ? { property_type: input.property_type }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(input, "page_size")
      ? { page_size: input.page_size }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(input, "cursor")
      ? { cursor: input.cursor }
      : {}),
  });
}

function assertResponseId(value, requestedId) {
  if (value.id !== requestedId) {
    throw invalidResponse();
  }
}

function assertPropertyAvailability(value, availability) {
  if (
    value.room_types.some(
      (roomType) => roomType.max_guests < availability.guests,
    )
  ) {
    throw invalidResponse();
  }
}

function responseDateOrdinal(value) {
  try {
    return parseDate(value);
  } catch {
    throw invalidResponse();
  }
}

function assertRoomAvailability(value, availability) {
  if (
    value.max_guests < availability.guests ||
    value.nightly_prices.length !== availability.nights
  ) {
    throw invalidResponse();
  }
  for (let index = 0; index < value.nightly_prices.length; index += 1) {
    if (
      responseDateOrdinal(value.nightly_prices[index].business_date) !==
      availability.checkinOrdinal + index
    ) {
      throw invalidResponse();
    }
  }
}

function appendQuery(parts, key, value) {
  parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
}

function availabilityQuery(value) {
  const parts = [];
  appendQuery(parts, "checkin", value.checkin);
  appendQuery(parts, "checkout", value.checkout);
  appendQuery(parts, "guests", value.guests);
  return parts.join("&");
}

function assertPropertyId(value) {
  if (
    typeof value !== "string" ||
    !CANONICAL_UUID_V4_PATTERN.test(value)
  ) {
    throw catalogInputError();
  }
}

function createCatalogService(requestClient) {
  return {
    async listProperties(query) {
      const snapshot = snapshotListQuery(query);

      const parts = [];
      appendQuery(parts, "city_id", snapshot.city_id);
      appendQuery(parts, "checkin", snapshot.checkin);
      appendQuery(parts, "checkout", snapshot.checkout);
      appendQuery(parts, "guests", snapshot.guests);
      if (Object.prototype.hasOwnProperty.call(snapshot, "property_type")) {
        appendQuery(parts, "property_type", snapshot.property_type);
      }
      if (Object.prototype.hasOwnProperty.call(snapshot, "page_size")) {
        appendQuery(parts, "page_size", snapshot.page_size);
      }
      if (Object.prototype.hasOwnProperty.call(snapshot, "cursor")) {
        appendQuery(parts, "cursor", snapshot.cursor);
      }

      const data = await requestClient.get(`/properties?${parts.join("&")}`);
      const response = assertPropertyListResponse(data);
      const requestedPageSize = Object.prototype.hasOwnProperty.call(
        snapshot,
        "page_size",
      )
        ? snapshot.page_size
        : 10;
      if (response.items.length > requestedPageSize) {
        throw invalidResponse();
      }
      return response;
    },

    async getProperty(propertyId, availability) {
      assertPropertyId(propertyId);
      const snapshot = snapshotAvailability(availability);
      const data = await requestClient.get(
        `/properties/${encodeURIComponent(propertyId)}?${availabilityQuery(snapshot)}`,
      );
      const response = assertPropertyDetail(data);
      assertResponseId(response, propertyId);
      assertPropertyAvailability(response, snapshot);
      return response;
    },

    async getRoomType(roomTypeId, availability) {
      assertPropertyId(roomTypeId);
      const snapshot = snapshotAvailability(availability);
      const data = await requestClient.get(
        `/room-types/${encodeURIComponent(roomTypeId)}?${availabilityQuery(snapshot)}`,
      );
      const response = assertRoomTypeDetail(data);
      assertResponseId(response, roomTypeId);
      assertRoomAvailability(response, snapshot);
      return response;
    },
  };
}

let defaultService;

function getDefaultService() {
  if (!defaultService) {
    defaultService = createCatalogService(require("./request"));
  }
  return defaultService;
}

module.exports = {
  createCatalogService,
  listProperties(query) {
    return getDefaultService().listProperties(query);
  },
  getProperty(propertyId, availability) {
    return getDefaultService().getProperty(propertyId, availability);
  },
  getRoomType(roomTypeId, availability) {
    return getDefaultService().getRoomType(roomTypeId, availability);
  },
};

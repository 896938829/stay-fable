"use strict";

const {
  assertPropertyDetail,
  assertPropertyListResponse,
  assertRoomTypeDetail,
} = require("./contracts");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PROPERTY_TYPES = ["HOTEL", "HOMESTAY", "FARM_STAY"];
const CATALOG_CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;

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

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
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

function assertAvailability(value, allowedKeys) {
  if (!isObject(value) || !hasOnlyKeys(value, allowedKeys)) {
    throw catalogInputError();
  }
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
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw catalogInputError();
  }
}

function createCatalogService(requestClient) {
  return {
    async listProperties(query) {
      const keys = [
        "city_id",
        "checkin",
        "checkout",
        "guests",
        "property_type",
        "page_size",
        "cursor",
      ];
      assertAvailability(query, keys);
      if (
        typeof query.city_id !== "string" ||
        !UUID_PATTERN.test(query.city_id) ||
        (Object.prototype.hasOwnProperty.call(query, "property_type") &&
          !PROPERTY_TYPES.includes(query.property_type)) ||
        (Object.prototype.hasOwnProperty.call(query, "page_size") &&
          (!Number.isInteger(query.page_size) ||
            query.page_size < 1 ||
            query.page_size > 20)) ||
        (Object.prototype.hasOwnProperty.call(query, "cursor") &&
          (typeof query.cursor !== "string" ||
            query.cursor.length < 1 ||
            query.cursor.length > 256 ||
            !CATALOG_CURSOR_PATTERN.test(query.cursor)))
      ) {
        throw catalogInputError();
      }

      const parts = [];
      appendQuery(parts, "city_id", query.city_id);
      appendQuery(parts, "checkin", query.checkin);
      appendQuery(parts, "checkout", query.checkout);
      appendQuery(parts, "guests", query.guests);
      if (Object.prototype.hasOwnProperty.call(query, "property_type")) {
        appendQuery(parts, "property_type", query.property_type);
      }
      if (Object.prototype.hasOwnProperty.call(query, "page_size")) {
        appendQuery(parts, "page_size", query.page_size);
      }
      if (Object.prototype.hasOwnProperty.call(query, "cursor")) {
        appendQuery(parts, "cursor", query.cursor);
      }

      const data = await requestClient.get(`/properties?${parts.join("&")}`);
      const response = assertPropertyListResponse(data);
      const requestedPageSize = Object.prototype.hasOwnProperty.call(
        query,
        "page_size",
      )
        ? query.page_size
        : 10;
      if (response.items.length > requestedPageSize) {
        throw invalidResponse();
      }
      return response;
    },

    async getProperty(propertyId, availability) {
      assertPropertyId(propertyId);
      assertAvailability(availability, ["checkin", "checkout", "guests"]);
      const data = await requestClient.get(
        `/properties/${encodeURIComponent(propertyId)}?${availabilityQuery(availability)}`,
      );
      return assertPropertyDetail(data);
    },

    async getRoomType(roomTypeId, availability) {
      assertPropertyId(roomTypeId);
      assertAvailability(availability, ["checkin", "checkout", "guests"]);
      const data = await requestClient.get(
        `/room-types/${encodeURIComponent(roomTypeId)}?${availabilityQuery(availability)}`,
      );
      return assertRoomTypeDetail(data);
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

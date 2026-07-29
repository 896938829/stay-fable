"use strict";

const { assertPropertyDetail, assertCity } = require("../../services/contracts");
const { parseDate } = require("../../utils/date");

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TYPE_LABELS = {
  HOTEL: "酒店",
  HOMESTAY: "民宿",
  FARM_STAY: "农家乐",
};
const SAFE_ERRORS = {
  AUTH_REAUTHENTICATION_FAILED: "登录暂时失败，请返回首页重试",
  INVALID_API_RESPONSE: "服务暂时不可用，请重试",
  NETWORK_REQUEST_FAILED: "网络连接不稳定，请重试",
  PROPERTY_NOT_AVAILABLE: "当前条件下该旅店暂无可售房型",
};
const PROPERTY_KEYS = [
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
function detailError() {
  const error = new Error("Invalid property detail");
  error.code = "INVALID_PROPERTY_DETAIL";
  return error;
}

function searchError() {
  const error = new Error("Invalid search context");
  error.code = "SEARCH_CONTEXT_INVALID";
  return error;
}

function isPlainObject(value) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function calendarOrdinal(value) {
  const date = parseDate(value);
  return Math.floor(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000,
  );
}

function toPropertyAvailability(search) {
  try {
    if (
      !isPlainObject(search) ||
      Object.keys(search).length !== 4 ||
      !["city", "checkin", "checkout", "guests"].every((key) =>
        Object.prototype.hasOwnProperty.call(search, key),
      )
    ) {
      throw searchError();
    }
    assertCity(search.city);
    const checkin = search.checkin;
    const checkout = search.checkout;
    const guests = search.guests;
    const nights = calendarOrdinal(checkout) - calendarOrdinal(checkin);
    if (
      nights < 1 ||
      nights > 30 ||
      !Number.isInteger(guests) ||
      guests < 1 ||
      guests > 10
    ) {
      throw searchError();
    }
    return { checkin, checkout, guests };
  } catch {
    throw searchError();
  }
}

function canonicalProperty(value) {
  try {
    if (
      !isPlainObject(value) ||
      Object.keys(value).length !== PROPERTY_KEYS.length ||
      !PROPERTY_KEYS.every((key) =>
        Object.prototype.hasOwnProperty.call(value, key),
      ) ||
      !Array.isArray(value.room_types)
    ) {
      throw detailError();
    }
    const candidate = {
      id: value.id,
      type: value.type,
      name: value.name,
      city: value.city,
      address: value.address,
      description: value.description,
      policies: value.policies,
      cover_url: value.cover_url,
      media: value.media,
      facilities: value.facilities,
      room_types: value.room_types,
    };
    const canonical = assertPropertyDetail(candidate);
    if (!UUID_V4_PATTERN.test(canonical.id)) {
      throw detailError();
    }
    return canonical;
  } catch {
    throw detailError();
  }
}

function uniqueBy(items, keyFor) {
  const result = [];
  const seen = new Set();
  for (const item of items) {
    const key = keyFor(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

function toPropertyDetailView(value) {
  try {
    const property = canonicalProperty(value);
    const facilities = uniqueBy(property.facilities, (item) => item.code).map(
      (item) => ({ code: item.code, name: item.name }),
    );
    const media = uniqueBy(property.media, (item) => item.url).map((item) => ({
      url: item.url,
      alt: item.alt,
      failed: false,
    }));
    const roomTypes = uniqueBy(property.room_types, (item) =>
      item.id.toLowerCase(),
    ).map((room) => {
      if (!UUID_V4_PATTERN.test(room.id)) {
        throw detailError();
      }
      return {
        id: room.id,
        name: room.name,
        bedType: room.bed_type,
        areaLabel: `${room.area_sqm}㎡`,
        maxGuestsLabel: `最多 ${room.max_guests} 人`,
        coverUrl: room.cover_url,
        coverAlt: `${room.name}封面`,
        coverFailed: false,
        policySummary: room.policy_summary,
        priceCents: room.from_nightly_price_cents,
      };
    });
    return {
      id: property.id,
      typeLabel: TYPE_LABELS[property.type],
      name: property.name,
      cityName: property.city.name,
      address: property.address,
      description: property.description,
      policies: property.policies,
      coverUrl: property.cover_url,
      coverAlt: `${property.name}封面`,
      coverFailed: false,
      media,
      facilities,
      roomTypes,
    };
  } catch {
    throw detailError();
  }
}

function safePropertyDetailError(error) {
  try {
    const code = error && error.code;
    return typeof code === "string" &&
      Object.prototype.hasOwnProperty.call(SAFE_ERRORS, code)
      ? SAFE_ERRORS[code]
      : "服务暂时不可用，请重试";
  } catch {
    return "服务暂时不可用，请重试";
  }
}

module.exports = {
  safePropertyDetailError,
  toPropertyAvailability,
  toPropertyDetailView,
};

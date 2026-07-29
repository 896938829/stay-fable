"use strict";

const { assertCity, assertRoomTypeDetail } = require("../../services/contracts");
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
  ROOM_CAPACITY_EXCEEDED: "当前入住人数超过该房型上限",
  ROOM_NOT_AVAILABLE: "当前条件下该房型暂不可售",
};

function roomError() {
  const error = new Error("Invalid room detail");
  error.code = "INVALID_ROOM_DETAIL";
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

function toRoomAvailability(search) {
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

function dateLabel(value) {
  const parts = value.split("-");
  return `${Number(parts[1])}月${Number(parts[2])}日`;
}

function toRoomDetailView(value) {
  try {
    const room = assertRoomTypeDetail(value);
    if (
      !UUID_V4_PATTERN.test(room.id) ||
      !UUID_V4_PATTERN.test(room.property.id)
    ) {
      throw roomError();
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
      property: {
        id: room.property.id,
        typeLabel: TYPE_LABELS[room.property.type],
        name: room.property.name,
        cityName: room.property.city.name,
      },
      description: room.description,
      bookingPolicy: room.booking_policy,
      nightlyPrices: room.nightly_prices.map((night) => ({
        businessDate: night.business_date,
        dateLabel: dateLabel(night.business_date),
        salePriceCents: night.sale_price_cents,
      })),
    };
  } catch {
    throw roomError();
  }
}

function safeRoomDetailError(error) {
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
  safeRoomDetailError,
  toRoomAvailability,
  toRoomDetailView,
};

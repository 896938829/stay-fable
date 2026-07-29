"use strict";

const { assertCity } = require("../../services/contracts");
const { parseDate } = require("../../utils/date");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILTERS = [
  { value: "", label: "全部" },
  { value: "HOTEL", label: "酒店" },
  { value: "HOMESTAY", label: "民宿" },
  { value: "FARM_STAY", label: "农家乐" },
];
const FILTER_VALUES = FILTERS.map((filter) => filter.value);
const SAFE_CATALOG_ERRORS = {
  AUTH_REAUTHENTICATION_FAILED: "登录暂时失败，请返回首页重试",
  CATALOG_CURSOR_INVALID: "列表已更新，请重新加载",
  NETWORK_REQUEST_FAILED: "网络连接不稳定，请重试",
};

function invalidSearchContext() {
  const error = new Error("Invalid search context");
  error.code = "SEARCH_CONTEXT_INVALID";
  return error;
}

function calendarOrdinal(value) {
  const date = parseDate(value);
  return Math.floor(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000,
  );
}

function isPlainObject(value) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function toPropertyListView(search, type = "") {
  try {
    if (!isPlainObject(search) || !FILTER_VALUES.includes(type)) {
      throw invalidSearchContext();
    }
    const city = assertCity(search.city);
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
      throw invalidSearchContext();
    }

    return {
      activeType: type,
      filters: FILTERS.map((filter) => ({ ...filter })),
      searchSummary: {
        cityLabel: city.name,
        dateLabel: `${checkin} 至 ${checkout}`,
        nightsLabel: `${nights}晚`,
        guestsLabel: `${guests}人`,
      },
    };
  } catch {
    throw invalidSearchContext();
  }
}

function mergePropertyPage(existing, incoming) {
  const merged = [];
  const positions = new Map();
  for (const property of [
    ...(Array.isArray(existing) ? existing : []),
    ...(Array.isArray(incoming) ? incoming : []),
  ]) {
    if (
      property === null ||
      Array.isArray(property) ||
      typeof property !== "object" ||
      typeof property.id !== "string" ||
      !UUID_PATTERN.test(property.id)
    ) {
      continue;
    }
    const key = property.id.toLowerCase();
    if (positions.has(key)) {
      merged[positions.get(key)] = property;
    } else {
      positions.set(key, merged.length);
      merged.push(property);
    }
  }
  return merged;
}

function safeCatalogError(error) {
  try {
    const code = error && error.code;
    return typeof code === "string" &&
      Object.prototype.hasOwnProperty.call(SAFE_CATALOG_ERRORS, code)
      ? SAFE_CATALOG_ERRORS[code]
      : "服务暂时不可用，请重试";
  } catch {
    return "服务暂时不可用，请重试";
  }
}

module.exports = {
  mergePropertyPage,
  safeCatalogError,
  toPropertyListView,
};

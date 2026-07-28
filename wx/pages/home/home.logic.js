"use strict";

const { compareDates, parseDate } = require("../../utils/date");

const SAFE_ERROR_MESSAGES = {
  AUTH_LOGIN_FAILED: "登录暂时失败，请重试",
  AUTH_REAUTHENTICATION_FAILED: "登录暂时失败，请重试",
  AUTH_REFRESH_FAILED: "登录暂时失败，请重试",
  CITY_NOT_SUPPORTED: "当前位置暂未开通，请手动选择城市",
  NETWORK: "网络连接不稳定，请重试",
  NETWORK_REQUEST_FAILED: "网络连接不稳定，请重试",
  SEARCH_INITIALIZATION_FAILED: "搜索条件读取失败，请重试",
};

function safeErrorMessage(error) {
  return SAFE_ERROR_MESSAGES[error && error.code] || "服务暂时不可用，请重试";
}

function monthDay(value) {
  try {
    const date = parseDate(value);
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  } catch {
    return "日期待选择";
  }
}

function nightCount(checkin, checkout) {
  try {
    const start = parseDate(checkin);
    const end = parseDate(checkout);
    return Math.round((end.getTime() - start.getTime()) / 86400000);
  } catch {
    return 0;
  }
}

function hasCompleteSearch(search) {
  return Boolean(
    search &&
      search.city &&
      typeof search.checkin === "string" &&
      typeof search.checkout === "string" &&
      compareDates(search.checkout, search.checkin) > 0 &&
      Number.isInteger(search.guests) &&
      search.guests >= 1,
  );
}

function toHomeView({ session, loading, error, search }) {
  const safeSearch = search || {
    city: null,
    checkin: "",
    checkout: "",
    guests: 1,
  };
  const nights = nightCount(safeSearch.checkin, safeSearch.checkout);
  const status = loading ? "loading" : error || !session ? "error" : "ready";

  return {
    status,
    errorMessage: status === "error" ? safeErrorMessage(error) : "",
    search: safeSearch,
    cityLabel: safeSearch.city ? safeSearch.city.name : "请选择城市",
    dateLabel: `${monthDay(safeSearch.checkin)}入住 · ${monthDay(safeSearch.checkout)}离店`,
    nightsLabel: `${nights}晚`,
    guestsLabel: `${safeSearch.guests}人`,
    canSearch: hasCompleteSearch(safeSearch),
  };
}

function locationFailureToAction(error) {
  const message = String((error && error.errMsg) || "").toLowerCase();
  let reason = "location_failed";
  let toast = "定位失败，请手动选择城市";

  if (message.includes("deny") || message.includes("auth")) {
    reason = "location_denied";
    toast = "未获得定位权限，请手动选择城市";
  } else if (message.includes("timeout")) {
    reason = "location_timeout";
    toast = "定位超时，请手动选择城市";
  } else if (error && error.code === "CITY_NOT_SUPPORTED") {
    reason = "city_not_supported";
    toast = "当前位置暂未开通，请手动选择城市";
  } else if (message.includes("not support") || message.includes("unsupported")) {
    reason = "location_unsupported";
    toast = "当前设备不支持定位，请手动选择城市";
  }

  return {
    url: `/pages/city-select/city-select?reason=${reason}`,
    toast,
  };
}

module.exports = {
  locationFailureToAction,
  safeErrorMessage,
  toHomeView,
};

"use strict";

const { parseDate } = require("../../utils/date");
const { formatMoney } = require("../../utils/money");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUS_LABELS = Object.freeze({
  PENDING_PAYMENT: "待支付",
  PAID: "已支付",
  CONFIRMED: "已确认",
  CANCELLED: "已取消",
  CLOSED: "已关闭",
});
const SAFE_ORDER_LIST_ERRORS = Object.freeze({
  AUTH_REAUTHENTICATION_FAILED: "登录暂时失败，请返回首页重试",
  AUTH_SESSION_EXPIRED: "登录状态已失效，请返回首页重试",
  NETWORK_REQUEST_FAILED: "网络连接不稳定，请重试",
  ORDER_CURSOR_INVALID: "订单列表已更新，请重新加载",
  RATE_LIMITED: "操作过于频繁，请稍后重试",
});

function formatChineseDate(value) {
  const date = parseDate(value);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function remainingSeconds(expiresAt, now) {
  const expires = Date.parse(expiresAt);
  const current = typeof now === "number" ? now : Number(now);
  if (!Number.isFinite(expires) || !Number.isFinite(current)) {
    return 0;
  }
  return Math.max(0, Math.ceil((expires - current) / 1000));
}

function toOrderListItemView(booking, now) {
  const seconds =
    booking.status === "PENDING_PAYMENT" &&
    booking.payment_deadline_passed !== true
      ? remainingSeconds(booking.expires_at, now)
      : 0;
  const paymentHint =
    booking.payment_deadline_passed === true
      ? "付款时间已截止"
      : booking.status === "PENDING_PAYMENT"
        ? `剩余 ${seconds} 秒`
        : "";

  return {
    bookingId: booking.booking_id,
    bookingNumber: booking.booking_number,
    status: booking.status,
    statusLabel: STATUS_LABELS[booking.status],
    propertyName: booking.property_name,
    roomTypeName: booking.room_type_name,
    dateLabel: `${formatChineseDate(booking.checkin)} 至 ${formatChineseDate(booking.checkout)}`,
    stayLabel: `${booking.nights}晚 · ${booking.guests}人`,
    totalPriceCents: booking.total_price_cents,
    totalPriceLabel: formatMoney(booking.total_price_cents),
    currency: booking.currency,
    expiresAt: booking.expires_at,
    paymentDeadlinePassed: booking.payment_deadline_passed,
    paymentRemainingSeconds: seconds,
    paymentHint,
    createdAt: booking.created_at,
    updatedAt: booking.updated_at,
    actionLabel: "查看订单",
  };
}

function mergeOrderPage(existing, incoming) {
  const merged = [];
  const positions = new Map();
  for (const item of [
    ...(Array.isArray(existing) ? existing : []),
    ...(Array.isArray(incoming) ? incoming : []),
  ]) {
    if (
      item === null ||
      Array.isArray(item) ||
      typeof item !== "object" ||
      typeof item.bookingId !== "string" ||
      !UUID_PATTERN.test(item.bookingId)
    ) {
      continue;
    }
    const key = item.bookingId.toLowerCase();
    if (positions.has(key)) {
      merged[positions.get(key)] = item;
    } else {
      positions.set(key, merged.length);
      merged.push(item);
    }
  }
  return merged;
}

function safeOrderListError(error) {
  try {
    const code = error && error.code;
    return typeof code === "string" &&
      Object.prototype.hasOwnProperty.call(SAFE_ORDER_LIST_ERRORS, code)
      ? SAFE_ORDER_LIST_ERRORS[code]
      : "订单服务暂时不可用，请重试";
  } catch {
    return "订单服务暂时不可用，请重试";
  }
}

module.exports = {
  mergeOrderPage,
  safeOrderListError,
  toOrderListItemView,
};

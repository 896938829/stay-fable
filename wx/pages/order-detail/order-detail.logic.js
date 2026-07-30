"use strict";

const { formatMoney } = require("../../utils/money");

const STATUS_LABELS = Object.freeze({
  PENDING_PAYMENT: "待支付",
  PAID: "支付处理中",
  CONFIRMED: "已确认",
  CANCELLED: "已取消",
  CLOSED: "已关闭",
});
const HISTORY_REASON_LABELS = Object.freeze({
  BOOKING_CREATED: "订单已创建",
  USER_CANCELLED: "用户已取消",
  PAYMENT_TIMEOUT: "支付超时，订单已关闭",
  MOCK_PAYMENT_SUCCEEDED: "模拟支付成功",
  PAYMENT_CONFIRMED: "订单已确认",
});
const ACTION_LABELS = Object.freeze({
  CANCEL: "取消订单",
  MOCK_PAY_SUCCESS: "模拟支付成功（开发）",
  MOCK_PAY_FAILURE: "模拟支付失败（开发）",
});
const PAYMENT_STATUS_LABELS = Object.freeze({
  SUCCEEDED: "支付成功",
  FAILED: "支付失败",
});
const SAFE_ERRORS = Object.freeze({
  AUTH_REAUTHENTICATION_FAILED: "登录暂时失败，请返回首页重试",
  AUTH_SESSION_CHANGED: "登录状态已变化，请重试",
  AUTH_SESSION_EXPIRED: "登录状态已失效，请返回首页重试",
  AUTH_SESSION_OPERATION_CANCELLED: "登录操作已取消，请重试",
  AUTH_SESSION_SERVICE_UNAVAILABLE: "登录服务暂时不可用，请重试",
  AUTH_USER_DISABLED: "当前账号暂不可用",
  BOOKING_ALREADY_PROCESSED: "订单状态已更新，请刷新",
  BOOKING_EXPIRED: "订单已超过支付时限",
  BOOKING_LIFECYCLE_UNAVAILABLE: "订单服务暂时不可用，请重试",
  BOOKING_NOT_CANCELLABLE: "当前订单不可取消",
  BOOKING_NOT_FOUND: "订单不存在或已失效",
  IDEMPOTENCY_KEY_REUSED: "支付请求已失效，请重新操作",
  INVALID_API_RESPONSE: "订单服务暂时不可用，请重试",
  MOCK_PAYMENT_FAILED: "模拟支付失败，订单仍待支付",
  NETWORK_REQUEST_FAILED: "网络连接不稳定，请重试",
  PAYMENT_REQUEST_INVALID: "支付请求无效",
  RATE_LIMITED: "操作过于频繁，请稍后重试",
});

function safeErrorCode(error) {
  try {
    if (error === null || typeof error !== "object") {
      return "";
    }
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor &&
      Object.prototype.hasOwnProperty.call(descriptor, "value") &&
      typeof descriptor.value === "string"
      ? descriptor.value
      : "";
  } catch {
    return "";
  }
}

function safeOrderDetailError(error) {
  const code = safeErrorCode(error);
  return Object.prototype.hasOwnProperty.call(SAFE_ERRORS, code)
    ? SAFE_ERRORS[code]
    : "订单服务暂时不可用，请重试";
}

function toOrderDetailView(booking) {
  const statusHistory = booking.status_history.map((item, index) => ({
    historyKey: `${index}:${item.created_at}`,
    fromStatus: item.from_status,
    toStatus: item.to_status,
    toStatusLabel: STATUS_LABELS[item.to_status],
    reasonLabel: Object.prototype.hasOwnProperty.call(
      HISTORY_REASON_LABELS,
      item.reason,
    )
      ? HISTORY_REASON_LABELS[item.reason]
      : "",
    actorType: item.actor_type,
    createdAt: item.created_at,
  }));
  const latestPayment =
    booking.latest_payment === null
      ? null
      : {
          paymentNumber: booking.latest_payment.payment_number,
          status: booking.latest_payment.status,
          statusLabel: PAYMENT_STATUS_LABELS[booking.latest_payment.status],
          processedAt: booking.latest_payment.processed_at,
        };

  return {
    bookingId: booking.booking_id,
    bookingNumber: booking.booking_number,
    status: booking.status,
    statusLabel: STATUS_LABELS[booking.status],
    propertyName: booking.property_name,
    roomTypeName: booking.room_type_name,
    checkin: booking.checkin,
    checkout: booking.checkout,
    nights: booking.nights,
    guests: booking.guests,
    totalPriceCents: booking.total_price_cents,
    totalPriceLabel: formatMoney(booking.total_price_cents),
    currency: booking.currency,
    expiresAt: booking.expires_at,
    paymentDeadlinePassed: booking.payment_deadline_passed,
    createdAt: booking.created_at,
    updatedAt: booking.updated_at,
    nightlyPrices: booking.nightly_prices.map((night) => ({
      businessDate: night.business_date,
      salePriceCents: night.sale_price_cents,
      salePriceLabel: formatMoney(night.sale_price_cents),
      rackPriceCents: night.rack_price_cents,
      rackPriceLabel: formatMoney(night.rack_price_cents),
      currency: night.currency,
    })),
    bookingPolicy: booking.booking_policy,
    latestPayment,
    statusHistory,
    actions: booking.allowed_actions.map((code) => ({
      code,
      label: ACTION_LABELS[code],
    })),
  };
}

module.exports = {
  safeErrorCode,
  safeOrderDetailError,
  toOrderDetailView,
};

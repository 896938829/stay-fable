"use strict";

const {
  safeErrorCode,
  safeOrderDetailError,
  toOrderDetailView,
} = require("./order-detail.logic");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVALID_LINK_MESSAGE = "订单链接无效，请返回订单列表";
const UNCERTAIN_CODES = new Set([
  "",
  "AUTH_SESSION_OPERATION_CANCELLED",
  "AUTH_SESSION_SERVICE_UNAVAILABLE",
  "BOOKING_LIFECYCLE_UNAVAILABLE",
  "INVALID_API_RESPONSE",
  "NETWORK_REQUEST_FAILED",
]);

function canonicalBookingId(options) {
  try {
    if (
      options === null ||
      Array.isArray(options) ||
      typeof options !== "object" ||
      Object.getPrototypeOf(options) !== Object.prototype
    ) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const keys = Object.keys(descriptors);
    const id = descriptors.id;
    if (
      Object.getOwnPropertySymbols(options).length !== 0 ||
      keys.length !== 1 ||
      !id ||
      !Object.prototype.hasOwnProperty.call(id, "value") ||
      typeof id.value !== "string" ||
      !UUID_PATTERN.test(id.value)
    ) {
      return null;
    }
    return id.value;
  } catch {
    return null;
  }
}

function nativePromise(method, options, readResult) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const success = (result) => {
      try {
        finish(readResult(result));
      } catch {
        finish(false);
      }
    };
    const fail = () => finish(false);
    try {
      if (typeof method !== "function") {
        fail();
        return;
      }
      const result = method({ ...options, success, fail, complete: success });
      if (
        result !== null &&
        (typeof result === "object" || typeof result === "function") &&
        typeof result.then === "function"
      ) {
        Promise.resolve(result).then(success, fail);
      }
    } catch {
      fail();
    }
  });
}

function createOrderDetailPage(dependencies = {}) {
  const ordersService =
    dependencies.ordersService || require("../../services/orders");
  const idempotency =
    dependencies.idempotency || require("../../utils/idempotency");
  const wxApi = dependencies.wxApi || globalThis.wx;

  let active = true;
  let hidden = false;
  let generation = 0;
  let nativeGeneration = 0;
  let bookingId = null;
  let currentBooking = null;
  let submitting = false;

  function isCurrent(token) {
    return active && !hidden && generation === token;
  }

  function paymentScope(outcome) {
    return `payment:${bookingId}:${outcome}`;
  }

  function clearPaymentScopes() {
    if (bookingId === null) {
      return;
    }
    idempotency.clear(paymentScope("SUCCEED"));
    idempotency.clear(paymentScope("FAIL"));
  }

  function applyBooking(page, response, actionMessage = "") {
    currentBooking = response;
    const booking = toOrderDetailView(response);
    if (booking.actions.length === 0) {
      clearPaymentScopes();
    }
    page.setData({
      status: "ready",
      booking,
      errorCode: "",
      errorMessage: "",
      actionMessage,
      uncertainAction: "",
    });
  }

  function canWrite(action) {
    const actionableState =
      this.data.status === "ready" ||
      (this.data.status === "action_uncertain" &&
        this.data.uncertainAction === action);
    return (
      active &&
      !hidden &&
      !submitting &&
      currentBooking !== null &&
      actionableState &&
      currentBooking.allowed_actions.includes(action)
    );
  }

  async function readCurrent(page, token, options = {}) {
    try {
      const response = await ordersService.getBooking(bookingId, {
        retry: true,
        isActive: () => isCurrent(token),
      });
      if (!isCurrent(token)) {
        return null;
      }
      applyBooking(page, response, options.actionMessage || "");
      return response;
    } catch (error) {
      if (!isCurrent(token)) {
        return null;
      }
      if (options.uncertain) {
        page.setData({
          status: "action_uncertain",
          errorCode: safeErrorCode(error),
          errorMessage: "",
          actionMessage: options.uncertainMessage,
          uncertainAction: options.uncertainAction || "",
        });
      } else {
        currentBooking = null;
        page.setData({
          status: "error",
          booking: null,
          errorCode: safeErrorCode(error) || "ORDER_DETAIL_UNAVAILABLE",
          errorMessage: safeOrderDetailError(error),
          actionMessage: "",
          uncertainAction: "",
        });
      }
      return null;
    }
  }

  async function load(page, status) {
    const token = generation;
    page.setData({
      status,
      errorCode: "",
      errorMessage: "",
      actionMessage: "",
      uncertainAction: "",
    });
    return readCurrent(page, token);
  }

  async function showInvalidLink(page) {
    currentBooking = null;
    page.setData({
      status: "error",
      booking: null,
      errorCode: "INVALID_BOOKING_LINK",
      errorMessage: INVALID_LINK_MESSAGE,
      actionMessage: "",
      uncertainAction: "",
    });
    const token = nativeGeneration;
    await nativePromise(
      wxApi && wxApi.showModal,
      {
        title: "无法打开订单",
        content: INVALID_LINK_MESSAGE,
        showCancel: false,
      },
      () => true,
    );
    if (!active || token !== nativeGeneration) {
      return;
    }
    await navigateBack();
  }

  function navigateBack() {
    return nativePromise(
      wxApi && wxApi.navigateBack,
      { delta: 1 },
      () => true,
    );
  }

  async function runPayment(page, outcome, action) {
    if (!canWrite.call(page, action)) {
      return;
    }
    const token = generation;
    const scope = paymentScope(outcome);
    submitting = true;
    page.setData({
      status: "action_pending",
      errorCode: "",
      errorMessage: "",
      actionMessage:
        outcome === "SUCCEED" ? "正在模拟支付" : "正在记录模拟支付失败",
      uncertainAction: "",
    });
    let posted = false;
    try {
      const key = await idempotency.get(scope);
      if (!isCurrent(token)) {
        return;
      }
      posted = true;
      const response = await ordersService.simulatePayment(
        bookingId,
        { outcome },
        key,
        { isActive: () => isCurrent(token) },
      );
      if (!isCurrent(token)) {
        return;
      }
      idempotency.clear(scope);
      applyBooking(page, response);
    } catch (error) {
      if (!isCurrent(token)) {
        return;
      }
      const code = safeErrorCode(error);
      if (!posted) {
        page.setData({
          status: "ready",
          errorCode: "PAYMENT_KEY_UNAVAILABLE",
          errorMessage: "",
          actionMessage: "无法安全发起支付，请重试",
          uncertainAction: "",
        });
      } else if (code === "MOCK_PAYMENT_FAILED") {
        idempotency.clear(scope);
        await readCurrent(page, token, {
          actionMessage: "模拟支付失败，订单仍待支付",
          uncertain: true,
          uncertainAction: action,
          uncertainMessage: "支付状态暂时无法确认，请刷新订单",
        });
      } else if (UNCERTAIN_CODES.has(code)) {
        page.setData({
          status: "action_uncertain",
          errorCode: code || "PAYMENT_RESULT_UNCERTAIN",
          errorMessage: "",
          actionMessage: "支付结果待确认，请使用同一支付请求重试",
          uncertainAction: action,
        });
      } else {
        idempotency.clear(scope);
        page.setData({
          status: "ready",
          errorCode: code,
          errorMessage: "",
          actionMessage: safeOrderDetailError(error),
          uncertainAction: "",
        });
      }
    } finally {
      if (isCurrent(token)) {
        submitting = false;
      }
    }
  }

  async function confirmCancellation() {
    return nativePromise(
      wxApi && wxApi.showModal,
      {
        title: "取消订单",
        content: "确认取消当前订单吗？",
        confirmText: "确认取消",
        cancelText: "暂不取消",
      },
      (result) => result && result.confirm === true,
    );
  }

  async function runCancellation(page) {
    if (!canWrite.call(page, "CANCEL")) {
      return;
    }
    const token = generation;
    submitting = true;
    const confirmed = await confirmCancellation();
    if (!isCurrent(token)) {
      return;
    }
    if (!confirmed) {
      submitting = false;
      return;
    }
    page.setData({
      status: "action_pending",
      errorCode: "",
      errorMessage: "",
      actionMessage: "正在取消订单",
      uncertainAction: "",
    });
    try {
      const response = await ordersService.cancelBooking(bookingId, {
        isActive: () => isCurrent(token),
      });
      if (!isCurrent(token)) {
        return;
      }
      applyBooking(page, response);
    } catch (error) {
      if (!isCurrent(token)) {
        return;
      }
      const code = safeErrorCode(error);
      const uncertain = UNCERTAIN_CODES.has(code);
      if (!uncertain) {
        page.setData({
          status: "ready",
          errorCode: code,
          errorMessage: "",
          actionMessage: safeOrderDetailError(error),
          uncertainAction: "",
        });
        return;
      }
      const reconciled = await readCurrent(page, token, {
        actionMessage: "",
        uncertain: true,
        uncertainAction: "CANCEL",
        uncertainMessage: "取消结果待确认，请重试取消或刷新订单",
      });
      if (
        reconciled !== null &&
        reconciled.status === "PENDING_PAYMENT"
      ) {
        page.setData({
          status: "action_uncertain",
          errorCode: code || "CANCEL_RESULT_UNCERTAIN",
          errorMessage: "",
          actionMessage: "取消结果待确认，请重试取消或刷新订单",
          uncertainAction: "CANCEL",
        });
      }
    } finally {
      if (isCurrent(token)) {
        submitting = false;
      }
    }
  }

  return {
    data: {
      status: "loading",
      booking: null,
      errorCode: "",
      errorMessage: "",
      actionMessage: "",
      uncertainAction: "",
    },

    onLoad(options) {
      active = true;
      hidden = false;
      generation += 1;
      nativeGeneration += 1;
      submitting = false;
      currentBooking = null;
      bookingId = canonicalBookingId(options);
      if (bookingId === null) {
        return showInvalidLink(this);
      }
      this.setData({
        status: "loading",
        booking: null,
        errorCode: "",
        errorMessage: "",
        actionMessage: "",
        uncertainAction: "",
      });
      return readCurrent(this, generation);
    },

    onShow() {
      if (!hidden) {
        active = true;
        return;
      }
      active = true;
      hidden = false;
      generation += 1;
      submitting = false;
      if (bookingId === null) {
        return;
      }
      return load(this, "refreshing");
    },

    onHide() {
      active = false;
      hidden = true;
      generation += 1;
      nativeGeneration += 1;
      submitting = false;
    },

    onUnload() {
      active = false;
      hidden = false;
      generation += 1;
      nativeGeneration += 1;
      submitting = false;
      bookingId = null;
      currentBooking = null;
    },

    retry() {
      if (
        !active ||
        hidden ||
        bookingId === null ||
        this.data.status !== "error"
      ) {
        return;
      }
      generation += 1;
      return load(this, "loading");
    },

    returnBack() {
      if (!active || hidden || this.data.errorCode !== "INVALID_BOOKING_LINK") {
        return;
      }
      return navigateBack();
    },

    refresh() {
      if (
        !active ||
        hidden ||
        bookingId === null ||
        submitting ||
        !["ready", "action_uncertain"].includes(this.data.status)
      ) {
        return;
      }
      generation += 1;
      return load(this, "refreshing");
    },

    simulateSuccess() {
      return runPayment(this, "SUCCEED", "MOCK_PAY_SUCCESS");
    },

    simulateFailure() {
      return runPayment(this, "FAIL", "MOCK_PAY_FAILURE");
    },

    cancelBooking() {
      return runCancellation(this);
    },

    performAction(event) {
      let action;
      try {
        const descriptor = Object.getOwnPropertyDescriptor(
          event.currentTarget.dataset,
          "action",
        );
        action =
          descriptor &&
          Object.prototype.hasOwnProperty.call(descriptor, "value")
            ? descriptor.value
            : undefined;
      } catch {
        return;
      }
      if (
        currentBooking === null ||
        !currentBooking.allowed_actions.includes(action)
      ) {
        return;
      }
      if (action === "CANCEL") {
        return this.cancelBooking();
      }
      if (action === "MOCK_PAY_SUCCESS") {
        return this.simulateSuccess();
      }
      if (action === "MOCK_PAY_FAILURE") {
        return this.simulateFailure();
      }
    },
  };
}

const definition = createOrderDetailPage();
if (typeof Page === "function") {
  Page(definition);
}

module.exports = {
  createOrderDetailPage,
};

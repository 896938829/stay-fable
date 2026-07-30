"use strict";

const {
  createBookingView,
  createQuoteView,
  quoteChangedView,
  remainingSeconds,
} = require("./booking-confirm.logic");

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_QUOTE_ERRORS = Object.freeze({
  AUTH_REAUTHENTICATION_FAILED: "登录暂时失败，请返回首页重试",
  AUTH_SESSION_EXPIRED: "登录状态已失效，请返回首页重试",
  NETWORK_REQUEST_FAILED: "网络连接不稳定，请重试",
  ROOM_CAPACITY_EXCEEDED: "当前入住人数超过该房型上限",
  ROOM_NOT_AVAILABLE: "当前条件下该房型暂不可售",
});
const SAFE_BOOKING_ERRORS = Object.freeze({
  NETWORK_REQUEST_FAILED: "网络连接不稳定，请使用同一订单请求重试",
  QUOTE_ALREADY_USED: "该报价已被使用，请重新获取报价",
  RATE_LIMITED: "操作过于频繁，请稍后重试",
});
const INVALID_LINK_MESSAGE = "房型链接无效，请返回重新选择";
const INVALID_SEARCH_MESSAGE = "搜索条件已失效，请返回首页重新选择";
const UNAVAILABLE_QUOTE_MESSAGE = "报价服务暂时不可用，请重试";
const UNAVAILABLE_BOOKING_MESSAGE = "订单服务暂时不可用，请重试";
const UNCERTAIN_BOOKING_MESSAGE =
  "订单结果待确认，请使用同一订单请求重试";

function plainOrNullPrototype(value) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownRecord(value, expectedKeys) {
  if (!plainOrNullPrototype(value)) {
    throw new Error("Invalid record");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(descriptors, key)) ||
    keys.some((key) => !expectedKeys.includes(key))
  ) {
    throw new Error("Invalid record");
  }
  const snapshot = {};
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new Error("Invalid record");
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function canonicalRoomId(options) {
  try {
    const snapshot = ownRecord(options, ["room_type_id"]);
    return typeof snapshot.room_type_id === "string" &&
      UUID_V4_PATTERN.test(snapshot.room_type_id)
      ? snapshot.room_type_id
      : null;
  } catch {
    return null;
  }
}

function calendarDay(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    throw new Error("Invalid date");
  }
  const [year, month, day] = value.split("-").map(Number);
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error("Invalid date");
  }
  return time / 86400000;
}

function quoteInput(roomTypeId, search) {
  try {
    const snapshot = ownRecord(search, [
      "city",
      "checkin",
      "checkout",
      "guests",
    ]);
    const nights =
      calendarDay(snapshot.checkout) - calendarDay(snapshot.checkin);
    if (
      nights < 1 ||
      nights > 30 ||
      !Number.isInteger(snapshot.guests) ||
      snapshot.guests < 1 ||
      snapshot.guests > 10
    ) {
      throw new Error("Invalid search");
    }
    return Object.freeze({
      room_type_id: roomTypeId,
      checkin: snapshot.checkin,
      checkout: snapshot.checkout,
      guests: snapshot.guests,
    });
  } catch {
    throw new Error("Invalid search");
  }
}

function safeErrorSnapshot(value) {
  try {
    if (!plainOrNullPrototype(value) && Object.getPrototypeOf(value) !== Error.prototype) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const code = descriptors.code;
    const details = descriptors.details;
    if (
      !code ||
      !Object.prototype.hasOwnProperty.call(code, "value") ||
      typeof code.value !== "string"
    ) {
      return undefined;
    }
    return {
      code: code.value,
      details:
        details && Object.prototype.hasOwnProperty.call(details, "value")
          ? details.value
          : undefined,
    };
  } catch {
    return undefined;
  }
}

function quoteErrorMessage(value) {
  const snapshot = safeErrorSnapshot(value);
  return snapshot &&
    Object.prototype.hasOwnProperty.call(SAFE_QUOTE_ERRORS, snapshot.code)
    ? SAFE_QUOTE_ERRORS[snapshot.code]
    : UNAVAILABLE_QUOTE_MESSAGE;
}

function observeNativeResult(result, success, failure) {
  if (result === false) {
    failure();
    return;
  }
  try {
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function")
    ) {
      const then = result.then;
      if (typeof then === "function") {
        then.call(result, success, failure);
      }
    }
  } catch {
    failure();
  }
}

function invokeNative(method, options, settle) {
  let settled = false;
  const finish = (successful) => {
    if (!settled) {
      settled = true;
      settle(successful);
    }
  };
  try {
    if (typeof method !== "function") {
      finish(false);
      return;
    }
    const result = method({
      ...options,
      success: () => finish(true),
      fail: () => finish(false),
      complete: () => finish(true),
    });
    observeNativeResult(
      result,
      () => finish(true),
      () => finish(false),
    );
  } catch {
    finish(false);
  }
}

function createBookingConfirmPage(dependencies) {
  const bookingApi =
    dependencies?.bookingApi || require("../../services/booking");
  const idempotency =
    dependencies?.idempotency || require("../../utils/idempotency");
  const wxApi = dependencies?.wxApi || globalThis.wx;
  const clock = dependencies?.clock || (() => Date.now());
  const getApplication = dependencies?.getApp || globalThis.getApp;
  const timerApi = dependencies?.timerApi || globalThis;

  let active = true;
  let hidden = false;
  let generation = 0;
  let roomTypeId = null;
  let requestInput = null;
  let currentQuote = null;
  let replacementQuote = null;
  let timer = null;
  let submitting = false;
  let nativeToken = 0;
  let modalLocked = false;
  let toastLocked = false;
  let navigationLocked = false;

  function isCurrent(token) {
    return active && generation === token;
  }

  function stopTimer() {
    if (timer !== null) {
      try {
        timerApi.clearInterval(timer);
      } catch {
        // Timer cleanup is best-effort.
      }
      timer = null;
    }
  }

  function updateCountdown(page) {
    if (currentQuote === null) {
      return;
    }
    const seconds = remainingSeconds(currentQuote.expires_at, clock());
    page.setData({
      remainingSeconds: seconds,
      submitDisabled:
        submitting ||
        seconds === 0 ||
        (page.data.status !== "quote_ready" &&
          page.data.status !== "booking_error"),
    });
    if (seconds === 0) {
      stopTimer();
    }
  }

  function startTimer(page) {
    stopTimer();
    updateCountdown(page);
    if (!active || page.data.remainingSeconds === 0) {
      return;
    }
    try {
      timer = timerApi.setInterval(() => {
        if (active) {
          updateCountdown(page);
        }
      }, 1000);
    } catch {
      timer = null;
    }
  }

  function showToast(title) {
    if (toastLocked) {
      return;
    }
    const token = nativeToken;
    toastLocked = true;
    invokeNative(wxApi && wxApi.showToast, { title, icon: "none" }, () => {
      if (nativeToken === token) {
        toastLocked = false;
      }
    });
  }

  function navigateBackSafely(page, token) {
    invokeNative(wxApi && wxApi.navigateBack, { delta: 1 }, (successful) => {
      if (nativeToken !== token) {
        return;
      }
      navigationLocked = false;
      if (!successful) {
        page.returnHome();
      }
    });
  }

  function showInvalidLink(page) {
    page.setData({
      status: "quote_error",
      quote: null,
      booking: null,
      changed: null,
      errorCode: "INVALID_ROOM_LINK",
      errorMessage: INVALID_LINK_MESSAGE,
      remainingSeconds: 0,
      submitDisabled: true,
      submitPressed: false,
    });
    if (modalLocked) {
      return;
    }
    const token = nativeToken;
    modalLocked = true;
    invokeNative(
      wxApi && wxApi.showModal,
      {
        title: "无法打开预订确认",
        content: INVALID_LINK_MESSAGE,
        showCancel: false,
      },
      () => {
        if (nativeToken === token) {
          modalLocked = false;
          navigateBackSafely(page, token);
        }
      },
    );
  }

  async function loadQuote(page, token = generation) {
    if (!isCurrent(token) || requestInput === null) {
      return;
    }
    try {
      const response = await bookingApi.createQuote(requestInput, {
        isActive: () => isCurrent(token),
      });
      if (!isCurrent(token)) {
        return;
      }
      currentQuote = response;
      replacementQuote = null;
      const view = createQuoteView(response, clock());
      page.setData({
        status: "quote_ready",
        quote: view,
        booking: null,
        changed: null,
        errorCode: "",
        errorMessage: "",
        remainingSeconds: view.remainingSeconds,
        submitDisabled: view.expired,
        submitPressed: false,
      });
      startTimer(page);
    } catch (error) {
      if (!isCurrent(token)) {
        return;
      }
      currentQuote = null;
      replacementQuote = null;
      stopTimer();
      page.setData({
        status: "quote_error",
        quote: null,
        booking: null,
        changed: null,
        errorCode: "QUOTE_LOAD_FAILED",
        errorMessage: quoteErrorMessage(error),
        remainingSeconds: 0,
        submitDisabled: true,
        submitPressed: false,
      });
    }
  }

  function setBookingFailure(page, code, message, disabled) {
    page.setData({
      status: "booking_error",
      errorCode: code,
      errorMessage: message,
      submitDisabled: disabled,
      submitPressed: false,
    });
  }

  return {
    data: {
      status: "loading_quote",
      quote: null,
      booking: null,
      changed: null,
      errorCode: "",
      errorMessage: "",
      remainingSeconds: 0,
      submitDisabled: true,
      submitPressed: false,
    },

    onLoad(options) {
      active = true;
      hidden = false;
      generation += 1;
      nativeToken += 1;
      roomTypeId = canonicalRoomId(options);
      requestInput = null;
      currentQuote = null;
      replacementQuote = null;
      submitting = false;
      modalLocked = false;
      toastLocked = false;
      navigationLocked = false;
      stopTimer();
      if (roomTypeId === null) {
        showInvalidLink(this);
        return;
      }
      try {
        const searchStore = getApplication().globalData.searchStore;
        requestInput = quoteInput(roomTypeId, searchStore.get());
      } catch {
        this.setData({
          status: "quote_error",
          quote: null,
          booking: null,
          changed: null,
          errorCode: "INVALID_SEARCH_CONTEXT",
          errorMessage: INVALID_SEARCH_MESSAGE,
          remainingSeconds: 0,
          submitDisabled: true,
          submitPressed: false,
        });
        return;
      }
      this.setData({
        status: "loading_quote",
        quote: null,
        booking: null,
        changed: null,
        errorCode: "",
        errorMessage: "",
        remainingSeconds: 0,
        submitDisabled: true,
        submitPressed: false,
      });
      return loadQuote(this);
    },

    onShow() {
      active = true;
      if (!hidden) {
        return;
      }
      hidden = false;
      if (this.data.status === "loading_quote") {
        return loadQuote(this);
      }
      if (this.data.status === "submitting" && currentQuote !== null) {
        setBookingFailure(
          this,
          "BOOKING_RESULT_UNCERTAIN",
          UNCERTAIN_BOOKING_MESSAGE,
          remainingSeconds(currentQuote.expires_at, clock()) === 0,
        );
      }
      if (
        currentQuote !== null &&
        (this.data.status === "quote_ready" ||
          this.data.status === "booking_error")
      ) {
        startTimer(this);
      }
    },

    onHide() {
      active = false;
      hidden = true;
      generation += 1;
      nativeToken += 1;
      submitting = false;
      modalLocked = false;
      toastLocked = false;
      navigationLocked = false;
      stopTimer();
    },

    onUnload() {
      active = false;
      hidden = false;
      generation += 1;
      nativeToken += 1;
      submitting = false;
      modalLocked = false;
      toastLocked = false;
      navigationLocked = false;
      roomTypeId = null;
      requestInput = null;
      currentQuote = null;
      replacementQuote = null;
      stopTimer();
    },

    retryQuote() {
      if (
        !active ||
        requestInput === null ||
        (this.data.status !== "quote_error" &&
          this.data.status !== "booking_error")
      ) {
        return;
      }
      if (currentQuote !== null) {
        idempotency.clear(`quote:${currentQuote.quote_id}`);
      }
      currentQuote = null;
      replacementQuote = null;
      generation += 1;
      this.setData({
        status: "loading_quote",
        quote: null,
        booking: null,
        changed: null,
        errorCode: "",
        errorMessage: "",
        remainingSeconds: 0,
        submitDisabled: true,
        submitPressed: false,
      });
      return loadQuote(this);
    },

    async confirmBooking() {
      if (
        !active ||
        submitting ||
        currentQuote === null ||
        (this.data.status !== "quote_ready" &&
          this.data.status !== "booking_error") ||
        this.data.submitDisabled
      ) {
        return;
      }
      const token = generation;
      const selectedQuote = currentQuote;
      const scope = `quote:${selectedQuote.quote_id}`;
      submitting = true;
      this.setData({
        status: "submitting",
        errorCode: "",
        errorMessage: "",
        submitDisabled: true,
        submitPressed: true,
      });
      let key;
      try {
        key = await idempotency.get(scope);
        if (!isCurrent(token)) {
          return;
        }
        const result = await bookingApi.createBooking(
          { quote_id: selectedQuote.quote_id },
          key,
          {
            isActive: () => isCurrent(token),
            expectedQuote: {
              property_id: selectedQuote.property.id,
              room_type_id: selectedQuote.room_type.id,
            },
          },
        );
        if (!isCurrent(token)) {
          return;
        }
        idempotency.clear(scope);
        currentQuote = null;
        replacementQuote = null;
        stopTimer();
        this.setData({
          status: "booking_created",
          quote: null,
          booking: createBookingView(result),
          changed: null,
          errorCode: "",
          errorMessage: "",
          remainingSeconds: 0,
          submitDisabled: true,
          submitPressed: false,
        });
      } catch (error) {
        if (!isCurrent(token)) {
          return;
        }
        const snapshot = safeErrorSnapshot(error);
        if (snapshot && snapshot.code === "QUOTE_CHANGED") {
          try {
            const details = ownRecord(snapshot.details, [
              "previous_total_price_cents",
              "replacement_quote",
            ]);
            const changed = quoteChangedView(
              details.previous_total_price_cents,
              details.replacement_quote,
              clock(),
            );
            replacementQuote = details.replacement_quote;
            stopTimer();
            this.setData({
              status: "quote_changed",
              changed,
              errorCode: "QUOTE_CHANGED",
              errorMessage: "价格已变化，请确认新价格",
              remainingSeconds: changed.replacementQuote.remainingSeconds,
              submitDisabled: true,
              submitPressed: false,
            });
          } catch {
            setBookingFailure(
              this,
              "INVALID_API_RESPONSE",
              UNAVAILABLE_BOOKING_MESSAGE,
              false,
            );
          }
        } else if (
          snapshot &&
          (snapshot.code === "QUOTE_EXPIRED" ||
            snapshot.code === "INVENTORY_UNAVAILABLE")
        ) {
          idempotency.clear(scope);
          stopTimer();
          setBookingFailure(
            this,
            snapshot.code,
            snapshot.code === "QUOTE_EXPIRED"
              ? "当前报价已失效，请重新获取报价"
              : "所选日期库存不足，请重新选择",
            true,
          );
        } else {
          const code = snapshot ? snapshot.code : "BOOKING_SERVICE_UNAVAILABLE";
          const message =
            snapshot &&
            Object.prototype.hasOwnProperty.call(SAFE_BOOKING_ERRORS, code)
              ? SAFE_BOOKING_ERRORS[code]
              : UNAVAILABLE_BOOKING_MESSAGE;
          setBookingFailure(
            this,
            code,
            message,
            code === "QUOTE_ALREADY_USED" ||
              remainingSeconds(selectedQuote.expires_at, clock()) === 0,
          );
        }
        if (key === undefined) {
          showToast("无法安全创建订单，请重试");
        }
      } finally {
        if (isCurrent(token)) {
          submitting = false;
          if (this.data.status === "submitting") {
            setBookingFailure(
              this,
              "BOOKING_SERVICE_UNAVAILABLE",
              UNAVAILABLE_BOOKING_MESSAGE,
              false,
            );
          } else if (this.data.submitPressed) {
            this.setData({ submitPressed: false });
          }
        }
      }
    },

    acceptChangedQuote() {
      if (
        !active ||
        this.data.status !== "quote_changed" ||
        currentQuote === null ||
        replacementQuote === null
      ) {
        return;
      }
      idempotency.clear(`quote:${currentQuote.quote_id}`);
      currentQuote = replacementQuote;
      replacementQuote = null;
      const view = createQuoteView(currentQuote, clock());
      this.setData({
        status: "quote_ready",
        quote: view,
        booking: null,
        changed: null,
        errorCode: "",
        errorMessage: "",
        remainingSeconds: view.remainingSeconds,
        submitDisabled: view.expired,
        submitPressed: false,
      });
      startTimer(this);
    },

    returnHome() {
      if (!active || navigationLocked) {
        return;
      }
      const token = nativeToken;
      navigationLocked = true;
      invokeNative(
        wxApi && wxApi.reLaunch,
        { url: "/pages/home/home" },
        () => {
          if (nativeToken === token) {
            navigationLocked = false;
          }
        },
      );
    },
  };
}

const definition = createBookingConfirmPage();
if (typeof Page === "function") {
  Page(definition);
}

module.exports = {
  createBookingConfirmPage,
};

"use strict";

const {
  safeRoomDetailError,
  toRoomAvailability,
  toRoomDetailView,
} = require("./room-detail.logic");

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INVALID_LINK_MESSAGE = "房型链接无效，请返回旅店重新选择";
const INVALID_SEARCH_MESSAGE = "搜索条件已失效，请返回首页重新选择";
const BOOKING_NOTICE = {
  title: "预订功能即将开放",
  content: "报价与预订将在下一开发切片开放",
  showCancel: false,
};

function canonicalId(options) {
  try {
    if (
      options === null ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      (Object.getPrototypeOf(options) !== Object.prototype &&
        Object.getPrototypeOf(options) !== null) ||
      Object.keys(options).length !== 1
    ) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, "id");
    return descriptor &&
      Object.prototype.hasOwnProperty.call(descriptor, "value") &&
      typeof descriptor.value === "string" &&
      UUID_V4_PATTERN.test(descriptor.value)
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function ownData(event) {
  try {
    if (
      event === null ||
      typeof event !== "object" ||
      event.currentTarget === null ||
      typeof event.currentTarget !== "object" ||
      event.currentTarget.dataset === null ||
      typeof event.currentTarget.dataset !== "object"
    ) {
      return null;
    }
    const dataset = event.currentTarget.dataset;
    const prototype = Object.getPrototypeOf(dataset);
    return prototype === Object.prototype || prototype === null
      ? dataset
      : null;
  } catch {
    return null;
  }
}

function observeNavigationResult(result, succeed, fail) {
  if (result === false) {
    fail();
    return;
  }
  try {
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function")
    ) {
      const then = result.then;
      if (typeof then === "function") {
        then.call(result, succeed, fail);
      }
    }
  } catch {
    fail();
  }
}

function invokeNavigation(method, options, succeed, fail) {
  let settled = false;
  const settleSuccess = () => {
    if (!settled) {
      settled = true;
      succeed();
    }
  };
  const settleFailure = () => {
    if (!settled) {
      settled = true;
      fail();
    }
  };
  try {
    if (typeof method !== "function") {
      settleFailure();
      return;
    }
    const result = method({
      ...options,
      success: settleSuccess,
      fail: settleFailure,
    });
    observeNavigationResult(result, settleSuccess, settleFailure);
  } catch {
    settleFailure();
  }
}

function createRoomDetailPage(dependencies = {}) {
  const catalogService =
    dependencies.catalogService || require("../../services/catalog");
  const getApplication = dependencies.getApp || globalThis.getApp;
  const wxApi = dependencies.wxApi || globalThis.wx;

  let active = true;
  let hidden = false;
  let generation = 0;
  let roomId = null;
  let availability = null;
  let invalidDestination = null;
  let returnInFlight = false;
  let choosing = false;

  function current(requestGeneration) {
    return active && generation === requestGeneration;
  }

  function renderInvalid(page, destination) {
    page.setData({
      status: "error",
      roomType: null,
      errorMessage:
        destination === "property"
          ? INVALID_LINK_MESSAGE
          : INVALID_SEARCH_MESSAGE,
    });
  }

  function returnHome(page) {
    invokeNavigation(
      wxApi && wxApi.reLaunch,
      { url: "/pages/home/home" },
      () => {
        returnInFlight = false;
      },
      () => {
        returnInFlight = false;
        if (active && invalidDestination !== null) {
          renderInvalid(page, invalidDestination);
        }
      },
    );
  }

  function returnSafely(page) {
    if (!active || invalidDestination === null || returnInFlight) {
      return;
    }
    returnInFlight = true;
    renderInvalid(page, invalidDestination);
    if (invalidDestination === "home") {
      returnHome(page);
      return;
    }
    invokeNavigation(
      wxApi && wxApi.navigateBack,
      { delta: 1 },
      () => {
        returnInFlight = false;
      },
      () => returnHome(page),
    );
  }

  async function load(page, requestGeneration = generation) {
    if (
      !active ||
      roomId === null ||
      availability === null ||
      invalidDestination !== null
    ) {
      return;
    }
    try {
      const response = await catalogService.getRoomType(roomId, availability);
      if (!current(requestGeneration)) {
        return;
      }
      page.setData({
        status: "success",
        roomType: toRoomDetailView(response),
        errorMessage: "",
      });
    } catch (error) {
      if (!current(requestGeneration)) {
        return;
      }
      page.setData({
        status: "error",
        roomType: null,
        errorMessage: safeRoomDetailError(error),
      });
    }
  }

  return {
    data: {
      status: "loading",
      roomType: null,
      errorMessage: "",
    },

    onLoad(options) {
      active = true;
      hidden = false;
      generation += 1;
      roomId = canonicalId(options);
      availability = null;
      invalidDestination = null;
      returnInFlight = false;
      choosing = false;
      if (roomId === null) {
        invalidDestination = "property";
        returnSafely(this);
        return;
      }
      try {
        const application = getApplication();
        const searchStore = application.globalData.searchStore;
        availability = toRoomAvailability(searchStore.get());
      } catch {
        invalidDestination = "home";
        returnSafely(this);
        return;
      }
      this.setData({
        status: "loading",
        roomType: null,
        errorMessage: "",
      });
      return load(this);
    },

    onShow() {
      active = true;
      choosing = false;
      if (invalidDestination !== null) {
        hidden = false;
        returnSafely(this);
        return;
      }
      if (!hidden) {
        return;
      }
      hidden = false;
      if (this.data.status === "loading") {
        return load(this);
      }
    },

    onHide() {
      active = false;
      hidden = true;
      choosing = false;
      generation += 1;
    },

    onUnload() {
      active = false;
      hidden = false;
      generation += 1;
      roomId = null;
      availability = null;
      invalidDestination = null;
      returnInFlight = false;
      choosing = false;
    },

    retry() {
      if (!active) {
        return;
      }
      if (invalidDestination !== null) {
        returnInFlight = false;
        returnSafely(this);
        return;
      }
      if (this.data.status !== "error") {
        return;
      }
      generation += 1;
      this.setData({
        status: "loading",
        roomType: null,
        errorMessage: "",
      });
      return load(this);
    },

    selectRoom() {
      if (!active || this.data.status !== "success" || choosing) {
        return;
      }
      choosing = true;
      let result;
      try {
        result = wxApi.showModal({ ...BOOKING_NOTICE });
      } catch {
        choosing = false;
        return;
      }
      try {
        if (
          result !== null &&
          (typeof result === "object" || typeof result === "function") &&
          typeof result.then === "function"
        ) {
          result.then(
            () => {
              choosing = false;
            },
            () => {
              choosing = false;
            },
          );
        } else {
          choosing = false;
        }
      } catch {
        choosing = false;
      }
    },

    handleImageError(event) {
      if (!active || this.data.status !== "success") {
        return;
      }
      const dataset = ownData(event);
      let src;
      try {
        src =
          dataset &&
          Object.prototype.hasOwnProperty.call(dataset, "src") &&
          typeof dataset.src === "string"
            ? dataset.src
            : null;
      } catch {
        return;
      }
      if (
        src === null ||
        this.data.roomType === null ||
        src !== this.data.roomType.coverUrl
      ) {
        return;
      }
      this.setData({
        roomType: { ...this.data.roomType, coverFailed: true },
      });
    },
  };
}

const definition = createRoomDetailPage();
if (typeof Page === "function") {
  Page(definition);
}

module.exports = {
  createRoomDetailPage,
};

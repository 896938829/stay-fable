"use strict";

const {
  safePropertyDetailError,
  toPropertyAvailability,
  toPropertyDetailView,
} = require("./property-detail.logic");

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INVALID_LINK_MESSAGE = "旅店链接无效，请返回列表重新选择";
const INVALID_SEARCH_MESSAGE = "搜索条件已失效，请返回首页重新选择";

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
    return event.currentTarget.dataset;
  } catch {
    return null;
  }
}

function canonicalId(options) {
  try {
    if (
      options === null ||
      typeof options !== "object" ||
      Array.isArray(options) ||
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

function createPropertyDetailPage(dependencies = {}) {
  const catalogService =
    dependencies.catalogService || require("../../services/catalog");
  const getApplication = dependencies.getApp || globalThis.getApp;
  const wxApi = dependencies.wxApi || globalThis.wx;

  let active = true;
  let hidden = false;
  let generation = 0;
  let propertyId = null;
  let availability = null;
  let invalidDestination = null;
  let returnInFlight = false;
  let returnToken = 0;
  let navigating = false;

  function current(requestGeneration) {
    return active && generation === requestGeneration;
  }

  function renderInvalid(page, destination) {
    page.setData({
      status: "error",
      property: null,
      errorMessage:
        destination === "list" ? INVALID_LINK_MESSAGE : INVALID_SEARCH_MESSAGE,
    });
  }

  function currentReturn(token, requestGeneration) {
    return (
      active &&
      generation === requestGeneration &&
      returnToken === token &&
      invalidDestination !== null
    );
  }

  function settleReturn(token) {
    if (returnToken === token) {
      returnInFlight = false;
    }
  }

  function returnHome(page, token, requestGeneration) {
    if (!currentReturn(token, requestGeneration)) {
      settleReturn(token);
      return;
    }
    returnInFlight = true;
    invokeNavigation(
      wxApi && wxApi.reLaunch,
      { url: "/pages/home/home" },
      () => settleReturn(token),
      () => {
        settleReturn(token);
        if (currentReturn(token, requestGeneration)) {
          renderInvalid(page, invalidDestination);
        }
      },
    );
  }

  function returnSafely(page) {
    if (!active || invalidDestination === null || returnInFlight) {
      return;
    }
    const token = ++returnToken;
    const requestGeneration = generation;
    returnInFlight = true;
    renderInvalid(page, invalidDestination);
    if (invalidDestination === "home") {
      returnHome(page, token, requestGeneration);
      return;
    }
    invokeNavigation(
      wxApi && wxApi.navigateBack,
      { delta: 1 },
      () => settleReturn(token),
      () => {
        settleReturn(token);
        if (currentReturn(token, requestGeneration)) {
          returnHome(page, token, requestGeneration);
        }
      },
    );
  }

  async function load(page, requestGeneration = generation) {
    if (
      !active ||
      propertyId === null ||
      availability === null ||
      invalidDestination !== null
    ) {
      return;
    }
    try {
      const response = await catalogService.getProperty(
        propertyId,
        availability,
      );
      if (!current(requestGeneration)) {
        return;
      }
      page.setData({
        status: "success",
        property: toPropertyDetailView(response),
        errorMessage: "",
      });
    } catch (error) {
      if (!current(requestGeneration)) {
        return;
      }
      page.setData({
        status: "error",
        property: null,
        errorMessage: safePropertyDetailError(error),
      });
    }
  }

  function roomIsOwned(page, id) {
    try {
      return (
        page.data.status === "success" &&
        page.data.property !== null &&
        Array.isArray(page.data.property.roomTypes) &&
        page.data.property.roomTypes.some((room) => room.id === id)
      );
    } catch {
      return false;
    }
  }

  return {
    data: {
      status: "loading",
      property: null,
      errorMessage: "",
    },

    onLoad(options) {
      active = true;
      hidden = false;
      generation += 1;
      returnToken += 1;
      propertyId = canonicalId(options);
      availability = null;
      invalidDestination = null;
      returnInFlight = false;
      navigating = false;
      if (propertyId === null) {
        invalidDestination = "list";
        returnSafely(this);
        return;
      }
      try {
        const application = getApplication();
        const searchStore = application.globalData.searchStore;
        availability = toPropertyAvailability(searchStore.get());
      } catch {
        invalidDestination = "home";
        returnSafely(this);
        return;
      }
      this.setData({
        status: "loading",
        property: null,
        errorMessage: "",
      });
      return load(this);
    },

    onShow() {
      active = true;
      navigating = false;
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
      generation += 1;
      returnToken += 1;
      returnInFlight = false;
    },

    onUnload() {
      active = false;
      hidden = false;
      generation += 1;
      returnToken += 1;
      propertyId = null;
      availability = null;
      invalidDestination = null;
      returnInFlight = false;
      navigating = false;
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
        property: null,
        errorMessage: "",
      });
      return load(this);
    },

    openRoom(event) {
      if (!active || navigating) {
        return;
      }
      const dataset = ownData(event);
      let id;
      try {
        id =
          dataset &&
          Object.prototype.hasOwnProperty.call(dataset, "id") &&
          typeof dataset.id === "string"
            ? dataset.id
            : null;
      } catch {
        return;
      }
      if (
        id === null ||
        !UUID_V4_PATTERN.test(id) ||
        !roomIsOwned(this, id)
      ) {
        return;
      }
      navigating = true;
      invokeNavigation(
        wxApi && wxApi.navigateTo,
        {
          url: `/pages/room-detail/room-detail?id=${encodeURIComponent(id)}`,
        },
        () => {},
        () => {
          navigating = false;
        },
      );
    },

    handleImageError(event) {
      if (!active || this.data.status !== "success") {
        return;
      }
      const dataset = ownData(event);
      if (dataset === null) {
        return;
      }
      let kind;
      let index;
      let src;
      try {
        kind = dataset.kind;
        index = dataset.index;
        src = dataset.src;
      } catch {
        return;
      }
      const property = this.data.property;
      if (typeof src !== "string" || property === null) {
        return;
      }
      if (kind === "cover" && src === property.coverUrl) {
        this.setData({
          property: { ...property, coverFailed: true },
        });
        return;
      }
      if (
        kind === "media" &&
        Number.isInteger(index) &&
        index >= 0 &&
        index < property.media.length &&
        property.media[index].url === src
      ) {
        const media = property.media.map((item, itemIndex) =>
          itemIndex === index ? { ...item, failed: true } : item,
        );
        this.setData({ property: { ...property, media } });
        return;
      }
      if (
        kind === "room" &&
        Number.isInteger(index) &&
        index >= 0 &&
        index < property.roomTypes.length &&
        property.roomTypes[index].coverUrl === src
      ) {
        const roomTypes = property.roomTypes.map((item, itemIndex) =>
          itemIndex === index ? { ...item, coverFailed: true } : item,
        );
        this.setData({ property: { ...property, roomTypes } });
      }
    },
  };
}

const definition = createPropertyDetailPage();
if (typeof Page === "function") {
  Page(definition);
}

module.exports = {
  createPropertyDetailPage,
};

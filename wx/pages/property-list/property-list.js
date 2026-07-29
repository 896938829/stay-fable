"use strict";

const {
  mergePropertyPage,
  safeCatalogError,
  toPropertyListView,
} = require("./property-list.logic");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const FILTER_TYPES = ["", "HOTEL", "HOMESTAY", "FARM_STAY"];

function hasOwn(value, key) {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, key)
  );
}

function selectedType(event) {
  const currentTarget =
    event !== null && typeof event === "object" ? event.currentTarget : null;
  const dataset =
    currentTarget !== null && typeof currentTarget === "object"
      ? currentTarget.dataset
      : null;
  if (!hasOwn(dataset, "type") || typeof dataset.type !== "string") {
    return null;
  }
  return FILTER_TYPES.includes(dataset.type) ? dataset.type : null;
}

function createPropertyListPage(dependencies = {}) {
  const searchStore = dependencies.searchStore || require("../../stores/search");
  const catalogService =
    dependencies.catalogService || require("../../services/catalog");
  const wxApi = dependencies.wxApi || globalThis.wx;

  let generation = 0;
  let active = true;
  let hidden = false;
  let navigating = false;
  let searchContext = null;
  const inFlightCursors = new Set();
  const completedCursors = new Set();

  function requestKey(requestGeneration, cursor) {
    return `${requestGeneration}:${cursor === null ? "<first>" : cursor}`;
  }

  function currentRequest(requestGeneration) {
    return active && generation === requestGeneration;
  }

  function queryFor(page, cursor) {
    const query = {
      city_id: searchContext.city.id,
      checkin: searchContext.checkin,
      checkout: searchContext.checkout,
      guests: searchContext.guests,
      page_size: 10,
    };
    if (page.data.activeType !== "") {
      query.property_type = page.data.activeType;
    }
    if (cursor !== null) {
      query.cursor = cursor;
    }
    return query;
  }

  function safeNextCursor(cursor, candidate) {
    if (
      typeof candidate !== "string" ||
      !CURSOR_PATTERN.test(candidate) ||
      candidate === cursor ||
      completedCursors.has(candidate)
    ) {
      return null;
    }
    return candidate;
  }

  async function loadPage(page, cursor, requestGeneration = generation) {
    if (!active || searchContext === null) {
      return;
    }
    const key = requestKey(requestGeneration, cursor);
    if (inFlightCursors.has(key)) {
      return;
    }
    inFlightCursors.add(key);

    if (cursor !== null) {
      page.setData({
        errorMessage: "",
        footerStatus: "loading",
      });
    }

    try {
      const response = await catalogService.listProperties(
        queryFor(page, cursor),
      );
      if (!currentRequest(requestGeneration)) {
        return;
      }
      if (cursor !== null) {
        completedCursors.add(cursor);
      }
      const items = mergePropertyPage(
        cursor === null ? [] : page.data.items,
        response.items,
      );
      const nextCursor =
        items.length === 0
          ? null
          : safeNextCursor(cursor, response.next_cursor);
      page.setData({
        status: items.length === 0 ? "empty" : "list",
        items,
        nextCursor,
        errorMessage: "",
        footerStatus: nextCursor === null ? "done" : "idle",
      });
    } catch (error) {
      if (!currentRequest(requestGeneration)) {
        return;
      }
      if (cursor === null) {
        page.setData({
          status: "error",
          items: [],
          nextCursor: null,
          errorMessage: safeCatalogError(error),
          footerStatus: "idle",
        });
      } else {
        page.setData({
          status: "list",
          errorMessage: safeCatalogError(error),
          footerStatus: "error",
        });
      }
    } finally {
      inFlightCursors.delete(key);
    }
  }

  function resetForFirstPage(page, view) {
    page.setData({
      status: "loading",
      items: [],
      nextCursor: null,
      activeType: view.activeType,
      filters: view.filters,
      searchSummary: view.searchSummary,
      errorMessage: "",
      footerStatus: "idle",
    });
  }

  return {
    data: {
      status: "loading",
      items: [],
      nextCursor: null,
      activeType: "",
      filters: [
        { value: "", label: "全部" },
        { value: "HOTEL", label: "酒店" },
        { value: "HOMESTAY", label: "民宿" },
        { value: "FARM_STAY", label: "农家乐" },
      ],
      searchSummary: null,
      errorMessage: "",
      footerStatus: "idle",
    },

    onLoad() {
      active = true;
      hidden = false;
      navigating = false;
      generation += 1;
      completedCursors.clear();

      try {
        const stored = searchStore.get();
        const view = toPropertyListView(stored, "");
        searchContext = {
          city: {
            id: stored.city.id,
            code: stored.city.code,
            name: stored.city.name,
          },
          checkin: stored.checkin,
          checkout: stored.checkout,
          guests: stored.guests,
        };
        resetForFirstPage(this, view);
      } catch {
        active = false;
        searchContext = null;
        try {
          wxApi.reLaunch({ url: "/pages/home/home" });
        } catch {
          // A navigation failure must not expose or persist the invalid context.
        }
        return;
      }

      return loadPage(this, null);
    },

    onShow() {
      navigating = false;
      if (!hidden || searchContext === null) {
        active = true;
        return;
      }
      active = true;
      hidden = false;
      if (this.data.status === "loading") {
        return loadPage(this, null);
      }
      if (
        this.data.footerStatus === "loading" &&
        typeof this.data.nextCursor === "string"
      ) {
        return loadPage(this, this.data.nextCursor);
      }
    },

    onHide() {
      active = false;
      hidden = true;
      generation += 1;
    },

    onUnload() {
      active = false;
      hidden = false;
      navigating = false;
      searchContext = null;
      generation += 1;
      completedCursors.clear();
    },

    retry() {
      if (
        !active ||
        searchContext === null ||
        !["empty", "error"].includes(this.data.status)
      ) {
        return;
      }
      generation += 1;
      completedCursors.clear();
      const view = toPropertyListView(searchContext, this.data.activeType);
      resetForFirstPage(this, view);
      return loadPage(this, null);
    },

    selectType(event) {
      if (!active || searchContext === null) {
        return;
      }
      const type = selectedType(event);
      if (type === null || type === this.data.activeType) {
        return;
      }
      generation += 1;
      completedCursors.clear();
      const view = toPropertyListView(searchContext, type);
      resetForFirstPage(this, view);
      return loadPage(this, null);
    },

    onReachBottom() {
      if (
        !active ||
        this.data.status !== "list" ||
        this.data.footerStatus !== "idle" ||
        typeof this.data.nextCursor !== "string"
      ) {
        return;
      }
      return loadPage(this, this.data.nextCursor);
    },

    retryFooter() {
      if (
        !active ||
        this.data.status !== "list" ||
        this.data.footerStatus !== "error" ||
        typeof this.data.nextCursor !== "string"
      ) {
        return;
      }
      return loadPage(this, this.data.nextCursor);
    },

    openProperty(event) {
      const detail =
        event !== null && typeof event === "object" ? event.detail : null;
      if (
        !active ||
        navigating ||
        !hasOwn(detail, "id") ||
        typeof detail.id !== "string" ||
        !UUID_PATTERN.test(detail.id)
      ) {
        return;
      }

      navigating = true;
      const resetNavigation = () => {
        navigating = false;
      };
      try {
        const result = wxApi.navigateTo({
          url: `/pages/property-detail/property-detail?id=${encodeURIComponent(detail.id)}`,
          fail: resetNavigation,
        });
        if (result && typeof result.then === "function") {
          result.catch(resetNavigation);
        }
      } catch {
        resetNavigation();
      }
    },
  };
}

const definition = createPropertyListPage();
if (typeof Page === "function") {
  Page(definition);
}

module.exports = {
  createPropertyListPage,
};

"use strict";

const {
  mergeOrderPage,
  safeOrderListError,
  toOrderListItemView,
} = require("./order-list.logic");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;

function hasOwn(value, key) {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, key)
  );
}

function createOrderListPage(dependencies = {}) {
  const ordersService =
    dependencies.ordersService || require("../../services/orders");
  const wxApi = dependencies.wxApi || globalThis.wx;
  const clock = dependencies.clock || (() => Date.now());

  let active = true;
  let hidden = false;
  let generation = 0;
  let navigating = false;
  let refreshOnShow = false;
  let pendingRefresh = null;
  const inFlight = new Set();
  const completedCursors = new Set();

  function isCurrent(token) {
    return active && generation === token;
  }

  function requestKey(token, cursor) {
    return `${token}:${cursor === null ? "<first>" : cursor}`;
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

  function stopPullDownRefresh() {
    try {
      if (wxApi && typeof wxApi.stopPullDownRefresh === "function") {
        wxApi.stopPullDownRefresh();
      }
    } catch {
      // Native refresh cleanup is best-effort.
    }
  }

  function cancelPendingRefresh() {
    if (pendingRefresh === null) {
      return;
    }
    const pending = pendingRefresh;
    pendingRefresh = null;
    if (pending.pullDown) {
      stopPullDownRefresh();
    }
    pending.resolve();
  }

  function resetFirstPage(page) {
    page.setData({
      status: "loading",
      items: [],
      nextCursor: null,
      errorMessage: "",
      footerStatus: "idle",
    });
  }

  function drainPendingRefresh() {
    if (pendingRefresh === null || inFlight.size !== 0) {
      return;
    }
    const pending = pendingRefresh;
    pendingRefresh = null;
    if (!active || hidden || generation !== pending.token) {
      if (pending.pullDown) {
        stopPullDownRefresh();
      }
      pending.resolve();
      return;
    }
    loadPage(pending.page, null, pending.token)
      .finally(() => {
        if (pending.pullDown) {
          stopPullDownRefresh();
        }
        pending.resolve();
      })
      .catch(() => {});
  }

  async function loadPage(page, cursor, token = generation) {
    if (!isCurrent(token)) {
      return;
    }
    const key = requestKey(token, cursor);
    if (inFlight.has(key)) {
      return;
    }
    inFlight.add(key);

    if (cursor !== null) {
      page.setData({
        errorMessage: "",
        footerStatus: "loading",
      });
    }

    try {
      const query = { limit: 10 };
      if (cursor !== null) {
        query.cursor = cursor;
      }
      const response = await ordersService.listBookings(query, {
        retry: true,
        isActive: () => isCurrent(token),
      });
      if (!isCurrent(token)) {
        return;
      }
      if (cursor !== null) {
        completedCursors.add(cursor);
      }
      const incoming = response.items.map((item) =>
        toOrderListItemView(item, clock()),
      );
      const items = mergeOrderPage(
        cursor === null ? [] : page.data.items,
        incoming,
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
      if (!isCurrent(token)) {
        return;
      }
      if (cursor === null) {
        page.setData({
          status: "error",
          items: [],
          nextCursor: null,
          errorMessage: safeOrderListError(error),
          footerStatus: "idle",
        });
      } else {
        page.setData({
          status: "list",
          errorMessage: safeOrderListError(error),
          footerStatus: "error",
        });
      }
    } finally {
      inFlight.delete(key);
      drainPendingRefresh();
    }
  }

  function refreshFirstPage(page, pullDown = false) {
    if (!active || hidden) {
      if (pullDown) {
        stopPullDownRefresh();
      }
      return;
    }
    if (pendingRefresh !== null) {
      pendingRefresh.pullDown = pendingRefresh.pullDown || pullDown;
      return pendingRefresh.promise;
    }

    const token = ++generation;
    completedCursors.clear();
    resetFirstPage(page);
    if (inFlight.size === 0) {
      const operation = loadPage(page, null, token);
      return operation.finally(() => {
        if (pullDown) {
          stopPullDownRefresh();
        }
      });
    }

    let resolve;
    const promise = new Promise((resolvePromise) => {
      resolve = resolvePromise;
    });
    pendingRefresh = {
      page,
      promise,
      pullDown,
      resolve,
      token,
    };
    return promise;
  }

  function settleNavigationFailure(token) {
    if (generation === token) {
      navigating = false;
    }
  }

  return {
    data: {
      status: "loading",
      items: [],
      nextCursor: null,
      errorMessage: "",
      footerStatus: "idle",
    },

    onLoad() {
      active = true;
      hidden = false;
      navigating = false;
      refreshOnShow = false;
      generation += 1;
      completedCursors.clear();
      resetFirstPage(this);
      return loadPage(this, null, generation);
    },

    onShow() {
      navigating = false;
      if (!hidden) {
        active = true;
        return;
      }
      active = true;
      hidden = false;
      if (!refreshOnShow) {
        return;
      }
      refreshOnShow = false;
      return refreshFirstPage(this);
    },

    onHide() {
      active = false;
      hidden = true;
      navigating = false;
      refreshOnShow = true;
      generation += 1;
      cancelPendingRefresh();
    },

    onUnload() {
      active = false;
      hidden = false;
      navigating = false;
      refreshOnShow = false;
      generation += 1;
      completedCursors.clear();
      cancelPendingRefresh();
    },

    retry() {
      if (
        !active ||
        hidden ||
        !["empty", "error"].includes(this.data.status)
      ) {
        return;
      }
      return refreshFirstPage(this);
    },

    onPullDownRefresh() {
      return refreshFirstPage(this, true);
    },

    onReachBottom() {
      if (
        !active ||
        hidden ||
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
        hidden ||
        this.data.status !== "list" ||
        this.data.footerStatus !== "error" ||
        typeof this.data.nextCursor !== "string"
      ) {
        return;
      }
      return loadPage(this, this.data.nextCursor);
    },

    openOrder(event) {
      const currentTarget =
        event !== null && typeof event === "object"
          ? event.currentTarget
          : null;
      const dataset =
        currentTarget !== null && typeof currentTarget === "object"
          ? currentTarget.dataset
          : null;
      if (
        !active ||
        hidden ||
        navigating ||
        !hasOwn(dataset, "bookingId") ||
        typeof dataset.bookingId !== "string" ||
        !UUID_PATTERN.test(dataset.bookingId)
      ) {
        return;
      }

      const bookingId = dataset.bookingId;
      const token = generation;
      navigating = true;
      const fail = () => settleNavigationFailure(token);
      try {
        const result = wxApi.navigateTo({
          url: `/pages/order-detail/order-detail?id=${encodeURIComponent(bookingId)}`,
          fail,
        });
        if (
          result !== null &&
          (typeof result === "object" || typeof result === "function") &&
          typeof result.then === "function"
        ) {
          Promise.resolve(result).catch(fail);
        }
      } catch {
        fail();
      }
    },
  };
}

const definition = createOrderListPage();
if (typeof Page === "function") {
  Page(definition);
}

module.exports = {
  createOrderListPage,
};

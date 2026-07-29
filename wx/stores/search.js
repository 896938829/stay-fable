"use strict";

const { assertCity } = require("../services/contracts");
const {
  addDays,
  compareDates,
  formatDate,
  getDefaultDates,
  parseDate,
} = require("../utils/date");

const DEFAULT_STORAGE_KEY = "stay-fable:search";
const CONTEXT_KEYS = ["city", "checkin", "checkout", "guests"];

function contextError() {
  const error = new Error("Invalid search context");
  error.code = "SEARCH_CONTEXT_INVALID";
  return error;
}

function isPlainObject(value) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function snapshotUpdate(update) {
  try {
    if (!isPlainObject(update)) {
      throw contextError();
    }
    const snapshot = {};
    for (const key of Reflect.ownKeys(update)) {
      if (typeof key !== "string" || !CONTEXT_KEYS.includes(key)) {
        throw contextError();
      }
      const descriptor = Object.getOwnPropertyDescriptor(update, key);
      if (!descriptor || !descriptor.enumerable) {
        throw contextError();
      }
      snapshot[key] = update[key];
    }
    return snapshot;
  } catch {
    throw contextError();
  }
}

function mergeContext(current, update) {
  try {
    const candidate = {};
    for (const key of CONTEXT_KEYS) {
      candidate[key] = Object.prototype.hasOwnProperty.call(update, key)
        ? update[key]
        : current[key];
    }
    return candidate;
  } catch {
    throw contextError();
  }
}

function createSearchStore(options) {
  const { wxApi } = options;
  const storageKey = options.storageKey || DEFAULT_STORAGE_KEY;
  const clock = options.clock || (() => new Date());
  let state;

  function defaults() {
    return {
      city: null,
      ...getDefaultDates(clock),
      guests: 2,
    };
  }

  function validate(candidate) {
    try {
      if (
        !isPlainObject(candidate) ||
        !CONTEXT_KEYS.every((key) => Object.prototype.hasOwnProperty.call(candidate, key)) ||
        Object.keys(candidate).some((key) => !CONTEXT_KEYS.includes(key))
      ) {
        throw contextError();
      }

      let city = null;
      if (candidate.city !== null) {
        city = assertCity(candidate.city);
      }

      parseDate(candidate.checkin);
      parseDate(candidate.checkout);
      const today = formatDate(clock());
      if (
        compareDates(candidate.checkin, today) < 0 ||
        compareDates(candidate.checkout, candidate.checkin) <= 0 ||
        compareDates(candidate.checkout, addDays(candidate.checkin, 30)) > 0 ||
        !Number.isInteger(candidate.guests) ||
        candidate.guests < 1 ||
        candidate.guests > 10
      ) {
        throw contextError();
      }

      return {
        city,
        checkin: candidate.checkin,
        checkout: candidate.checkout,
        guests: candidate.guests,
      };
    } catch {
      throw contextError();
    }
  }

  function persist(next) {
    wxApi.setStorageSync(storageKey, next);
    state = next;
    return state;
  }

  function initializeDefaults() {
    if (state) {
      return state;
    }
    const stored = wxApi.getStorageSync(storageKey);
    if (stored !== undefined && stored !== null && stored !== "") {
      let canonical;
      try {
        canonical = validate(stored);
      } catch {
        // Invalid persisted state is replaced with safe date defaults.
      }
      if (canonical) {
        return persist(canonical);
      }
    }
    return persist(validate(defaults()));
  }

  function get() {
    return initializeDefaults();
  }

  function set(update) {
    const snapshot = snapshotUpdate(update);
    const current = get();
    const next = validate(mergeContext(current, snapshot));
    return persist(next);
  }

  function clear() {
    return persist(validate(defaults()));
  }

  return {
    clear,
    get,
    initializeDefaults,
    set,
  };
}

let defaultStore;

function getDefaultStore() {
  if (!defaultStore) {
    defaultStore = createSearchStore({
      wxApi: {
        getStorageSync(key) {
          return globalThis.wx.getStorageSync(key);
        },
        setStorageSync(key, value) {
          return globalThis.wx.setStorageSync(key, value);
        },
      },
      storageKey: DEFAULT_STORAGE_KEY,
    });
  }
  return defaultStore;
}

module.exports = {
  clear() {
    return getDefaultStore().clear();
  },
  createSearchStore,
  get() {
    return getDefaultStore().get();
  },
  initializeDefaults() {
    return getDefaultStore().initializeDefaults();
  },
  set(update) {
    return getDefaultStore().set(update);
  },
};

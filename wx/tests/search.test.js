import { describe, expect, it, vi } from "vitest";

import searchModule from "../stores/search.js";

const { createSearchStore } = searchModule;
const city = {
  id: "11111111-1111-4111-8111-111111111111",
  code: "hangzhou",
  name: "杭州",
};

function setup(initial) {
  let stored = initial;
  const wxApi = {
    getStorageSync: vi.fn(() => stored),
    setStorageSync: vi.fn((_key, value) => {
      stored = value;
    }),
  };
  const store = createSearchStore({
    wxApi,
    storageKey: "search",
    clock: () => new Date(2026, 6, 29, 18),
  });
  return { store, stored: () => stored, wxApi };
}

describe("search store", () => {
  it("initializes tomorrow/after-tomorrow defaults", () => {
    const { store, stored } = setup();
    expect(store.initializeDefaults()).toEqual({
      city: null,
      checkin: "2026-07-30",
      checkout: "2026-07-31",
      guests: 2,
    });
    expect(stored()).toEqual(store.get());
  });

  it("loads and persists a valid search context without coordinates", () => {
    const initial = {
      city,
      checkin: "2026-07-30",
      checkout: "2026-08-02",
      guests: 2,
    };
    const { store, stored } = setup(initial);
    expect(store.initializeDefaults()).toEqual(initial);
    const result = store.set({
      city: { ...city, longitude: 120.1, latitude: 30.2 },
      guests: 3,
    });
    expect(result.city).toEqual(city);
    expect(stored()).toEqual(result);
    expect(JSON.stringify(stored())).not.toContain("longitude");
  });

  it.each([
    { checkin: "2026-07-28" },
    { checkout: "2026-07-30" },
    { checkout: "2026-08-30" },
    { guests: 0 },
    { guests: 1.5 },
    { guests: 11 },
    { city: { ...city, id: "bad" } },
    { city: { ...city, code: "c".repeat(33) } },
    { city: { ...city, name: "城".repeat(81) } },
    { city: { ...city, code: " \t " } },
    { city: Object.assign(Object.create({ inherited: true }), city) },
    { longitude: 120.1 },
  ])("rejects invalid updates atomically: %o", (update) => {
    const { store, stored } = setup();
    const original = store.initializeDefaults();
    expect(() => store.set(update)).toThrowError(
      expect.objectContaining({
        code: "SEARCH_CONTEXT_INVALID",
        message: "Invalid search context",
      }),
    );
    expect(store.get()).toEqual(original);
    expect(stored()).toEqual(original);
  });

  it("replaces a persisted context with an oversized city using safe defaults", () => {
    const { store, stored } = setup({
      city: { ...city, name: "城".repeat(81) },
      checkin: "2026-07-30",
      checkout: "2026-08-02",
      guests: 3,
    });

    expect(store.initializeDefaults()).toEqual({
      city: null,
      checkin: "2026-07-30",
      checkout: "2026-07-31",
      guests: 2,
    });
    expect(stored()).toEqual(store.get());
  });

  it.each([
    [
      "throwing value getter",
      () =>
        Object.defineProperty({}, "guests", {
          enumerable: true,
          get() {
            throw new Error("private value getter");
          },
        }),
    ],
    [
      "throwing ownKeys trap",
      () =>
        new Proxy(
          { guests: 3 },
          {
            ownKeys() {
              throw new Error("private ownKeys trap");
            },
          },
        ),
    ],
    [
      "throwing descriptor trap",
      () =>
        new Proxy(
          { guests: 3 },
          {
            getOwnPropertyDescriptor() {
              throw new Error("private descriptor trap");
            },
          },
        ),
    ],
  ])("maps a hostile %s update to SEARCH_CONTEXT_INVALID atomically", (_label, createUpdate) => {
    const { store, stored, wxApi } = setup();
    const original = store.initializeDefaults();
    wxApi.setStorageSync.mockClear();

    expect(() => store.set(createUpdate())).toThrowError(
      expect.objectContaining({
        code: "SEARCH_CONTEXT_INVALID",
        message: "Invalid search context",
      }),
    );
    expect(store.get()).toEqual(original);
    expect(stored()).toEqual(original);
    expect(wxApi.setStorageSync).not.toHaveBeenCalled();
  });

  it("reads each allowed update key once into a canonical snapshot", () => {
    const { store } = setup();
    store.initializeDefaults();
    let reads = 0;
    const update = Object.defineProperty({}, "guests", {
      enumerable: true,
      get() {
        reads += 1;
        if (reads > 1) {
          throw new Error("update getter read twice");
        }
        return 3;
      },
    });

    expect(store.set(update)).toMatchObject({ guests: 3 });
    expect(reads).toBe(1);
  });

  it("clear restores and persists current defaults", () => {
    const { store, stored } = setup();
    store.initializeDefaults();
    store.set({ city, guests: 4 });
    expect(store.clear()).toEqual({
      city: null,
      checkin: "2026-07-30",
      checkout: "2026-07-31",
      guests: 2,
    });
    expect(stored()).toEqual(store.get());
  });

  it("keeps the prior state when persisting an update fails", () => {
    const { store, stored, wxApi } = setup();
    const original = store.initializeDefaults();
    wxApi.setStorageSync.mockImplementation(() => {
      throw new Error("storage quota exceeded");
    });

    expect(() => store.set({ city, guests: 4 })).toThrow("storage quota exceeded");
    expect(store.get()).toEqual(original);
    expect(stored()).toEqual(original);
  });

  it("keeps the prior state when persisting clear fails", () => {
    const { store, stored, wxApi } = setup();
    const original = store.initializeDefaults();
    store.set({ city, guests: 4 });
    const current = store.get();
    wxApi.setStorageSync.mockImplementation(() => {
      throw new Error("storage I/O failed");
    });

    expect(() => store.clear()).toThrow("storage I/O failed");
    expect(store.get()).toEqual(current);
    expect(stored()).toEqual(current);
    expect(store.get()).not.toEqual(original);
  });

  it("does not cache initialized state until its canonical storage write succeeds", () => {
    const initial = {
      city,
      checkin: "2026-07-30",
      checkout: "2026-08-02",
      guests: 3,
    };
    const { store, wxApi } = setup(initial);
    const write = wxApi.setStorageSync.getMockImplementation();
    wxApi.setStorageSync.mockImplementation(() => {
      throw new Error("storage quota exceeded");
    });

    expect(() => store.initializeDefaults()).toThrow("storage quota exceeded");
    wxApi.setStorageSync.mockImplementation(write);
    expect(store.get()).toEqual(initial);
    expect(wxApi.setStorageSync).toHaveBeenCalledTimes(2);
  });
});

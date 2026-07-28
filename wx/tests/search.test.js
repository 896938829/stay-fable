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
});

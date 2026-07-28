import { describe, expect, it, vi } from "vitest";

import dateLogic from "../pages/date-guest-select/date-guest-select.logic.js";
import datePage from "../pages/date-guest-select/date-guest-select.js";

const { changeCheckin, changeCheckout, changeGuests } = dateLogic;
const { createDateGuestPage } = datePage;
const context = {
  city: null,
  checkin: "2026-07-30",
  checkout: "2026-08-02",
  guests: 2,
};

function pageContext(definition) {
  return {
    data: structuredClone(definition.data),
    setData(update) {
      this.data = { ...this.data, ...update };
    },
    ...definition,
  };
}

describe("date and guest logic", () => {
  it("moves checkout to the following day when checkin catches it", () => {
    expect(changeCheckin(context, "2026-08-02", "2026-07-29")).toMatchObject({
      checkin: "2026-08-02",
      checkout: "2026-08-03",
    });
  });

  it("caps checkout at 30 nights when checkin moves earlier", () => {
    expect(
      changeCheckin(
        { ...context, checkin: "2026-08-20", checkout: "2026-09-19" },
        "2026-07-30",
        "2026-07-29",
      ),
    ).toMatchObject({
      checkin: "2026-07-30",
      checkout: "2026-08-29",
    });
  });

  it("rejects past checkin and checkout beyond the 30-night boundary", () => {
    expect(() => changeCheckin(context, "2026-07-28", "2026-07-29")).toThrow();
    expect(() => changeCheckout(context, "2026-08-30")).toThrow();
    expect(changeCheckout(context, "2026-08-29").checkout).toBe("2026-08-29");
  });

  it("clamps guests to the 1 through 10 range", () => {
    expect(changeGuests({ ...context, guests: 1 }, -1).guests).toBe(1);
    expect(changeGuests({ ...context, guests: 10 }, 1).guests).toBe(10);
    expect(changeGuests(context, 1).guests).toBe(3);
  });
});

describe("date and guest page", () => {
  it("registers its native page definition", async () => {
    globalThis.Page = vi.fn();
    await import("../pages/date-guest-select/date-guest-select.js?registration=date");
    expect(globalThis.Page).toHaveBeenCalledOnce();
    expect(globalThis.Page.mock.calls[0][0]).toMatchObject({
      data: { guests: 2, saving: false },
      save: expect.any(Function),
    });
  });

  it("loads canonical context and saves the complete update atomically", () => {
    const searchStore = {
      get: vi.fn(() => context),
      set: vi.fn(() => ({ ...context, guests: 3 })),
    };
    const wxApi = { navigateBack: vi.fn(), showToast: vi.fn() };
    const page = pageContext(
      createDateGuestPage({
        clock: () => new Date(2026, 6, 29, 18),
        getApp: () => ({ globalData: { searchStore } }),
        wxApi,
      }),
    );
    page.onLoad.call(page);
    page.incrementGuests.call(page);
    page.save.call(page);

    expect(searchStore.set).toHaveBeenCalledWith({
      checkin: "2026-07-30",
      checkout: "2026-08-02",
      guests: 3,
    });
    expect(wxApi.navigateBack).toHaveBeenCalledWith({ delta: 1 });
  });

  it("shows a safe error and makes no partial write when save validation fails", () => {
    const searchStore = {
      get: vi.fn(() => context),
      set: vi.fn(() => {
        throw Object.assign(new Error("private context"), { details: "secret" });
      }),
    };
    const wxApi = { navigateBack: vi.fn(), showToast: vi.fn() };
    const page = pageContext(
      createDateGuestPage({
        clock: () => new Date(2026, 6, 29, 18),
        getApp: () => ({ globalData: { searchStore } }),
        wxApi,
      }),
    );
    page.onLoad.call(page);
    page.save.call(page);

    expect(searchStore.set).toHaveBeenCalledOnce();
    expect(wxApi.navigateBack).not.toHaveBeenCalled();
    expect(wxApi.showToast).toHaveBeenCalledWith({
      title: "日期或人数设置无效，请检查",
      icon: "none",
    });
    expect(JSON.stringify(page.data)).not.toContain("private");
  });
});

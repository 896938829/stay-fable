import { describe, expect, it, vi } from "vitest";

import cityPage from "../pages/city-select/city-select.js";

const { createCitySelectPage } = cityPage;
const cities = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    code: "hangzhou",
    name: "杭州",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    code: "suzhou",
    name: "苏州",
  },
];

function pageContext(definition) {
  return {
    data: structuredClone(definition.data),
    setData(update) {
      this.data = { ...this.data, ...update };
    },
    ...definition,
  };
}

describe("city select page", () => {
  it("registers its native page definition", async () => {
    globalThis.Page = vi.fn();
    await import("../pages/city-select/city-select.js?registration=city");
    expect(globalThis.Page).toHaveBeenCalledOnce();
    expect(globalThis.Page.mock.calls[0][0]).toMatchObject({
      data: { status: "loading", cities: [] },
      loadCities: expect.any(Function),
    });
  });

  it("loads canonical cities and represents the empty state", async () => {
    const locationService = { listCities: vi.fn(async () => cities) };
    const page = pageContext(
      createCitySelectPage({
        getApp: () => ({ globalData: { searchStore: {} } }),
        locationService,
        wxApi: {},
      }),
    );
    await page.onLoad.call(page);
    expect(page.data).toMatchObject({ status: "list", cities });

    locationService.listCities.mockResolvedValueOnce([]);
    await page.loadCities.call(page);
    expect(page.data).toMatchObject({ status: "empty", cities: [] });
  });

  it("retries a failed load and retains a previously safe list on later failure", async () => {
    const locationService = {
      listCities: vi
        .fn()
        .mockRejectedValueOnce({ code: "NETWORK_REQUEST_FAILED", message: "private" })
        .mockResolvedValueOnce(cities)
        .mockRejectedValueOnce({ message: "request body private" }),
    };
    const page = pageContext(
      createCitySelectPage({
        getApp: () => ({ globalData: { searchStore: {} } }),
        locationService,
        wxApi: {},
      }),
    );

    await page.onLoad.call(page);
    expect(page.data).toMatchObject({
      status: "error",
      errorMessage: "网络连接不稳定，请重试",
    });
    await page.retry.call(page);
    expect(page.data).toMatchObject({ status: "list", cities });
    await page.retry.call(page);
    expect(page.data).toMatchObject({
      status: "list",
      cities,
      notice: "服务暂时不可用，请重试",
    });
  });

  it("chooses only a city found by id in the loaded canonical list", async () => {
    const searchStore = { set: vi.fn() };
    const wxApi = { navigateBack: vi.fn(), showToast: vi.fn() };
    const page = pageContext(
      createCitySelectPage({
        getApp: () => ({ globalData: { searchStore } }),
        locationService: { listCities: vi.fn(async () => cities) },
        wxApi,
      }),
    );
    await page.onLoad.call(page);

    page.chooseCity.call(page, {
      currentTarget: {
        dataset: {
          id: cities[1].id,
          city: { ...cities[1], name: "伪造城市", secret: "private" },
        },
      },
    });
    expect(searchStore.set).toHaveBeenCalledWith({ city: cities[1] });
    expect(wxApi.navigateBack).toHaveBeenCalledWith({ delta: 1 });

    searchStore.set.mockClear();
    page.chooseCity.call(page, { currentTarget: { dataset: { id: "unknown" } } });
    expect(searchStore.set).not.toHaveBeenCalled();
  });
});

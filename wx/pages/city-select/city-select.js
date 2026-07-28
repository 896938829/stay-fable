"use strict";

const SAFE_ERROR_MESSAGES = {
  AUTH_LOGIN_FAILED: "登录暂时失败，请重试",
  AUTH_REAUTHENTICATION_FAILED: "登录暂时失败，请重试",
  CITY_NOT_SUPPORTED: "该城市暂未开通",
  NETWORK: "网络连接不稳定，请重试",
  NETWORK_REQUEST_FAILED: "网络连接不稳定，请重试",
};

function safeErrorMessage(error) {
  return SAFE_ERROR_MESSAGES[error && error.code] || "服务暂时不可用，请重试";
}

function createCitySelectPage(dependencies = {}) {
  const wxApi = dependencies.wxApi || globalThis.wx;
  const getApplication = dependencies.getApp || globalThis.getApp;
  const locationService = dependencies.locationService || require("../../services/location");

  return {
    data: {
      status: "loading",
      cities: [],
      errorMessage: "",
      notice: "",
    },

    onLoad() {
      return this.loadCities();
    },

    async loadCities() {
      const retainedCities = this.data.cities;
      this.setData({
        status: retainedCities.length ? "list" : "loading",
        errorMessage: "",
        notice: "",
      });

      try {
        const cities = await locationService.listCities();
        this.setData({
          cities,
          status: cities.length ? "list" : "empty",
          errorMessage: "",
          notice: "",
        });
      } catch (error) {
        const message = safeErrorMessage(error);
        if (retainedCities.length) {
          this.setData({ status: "list", notice: message });
        } else {
          this.setData({ status: "error", errorMessage: message });
        }
      }
    },

    retry() {
      return this.loadCities();
    },

    chooseCity(event) {
      const id = event && event.currentTarget && event.currentTarget.dataset.id;
      const city = this.data.cities.find((candidate) => candidate.id === id);
      if (!city) {
        wxApi.showToast?.({ title: "城市信息已更新，请重试", icon: "none" });
        return;
      }

      try {
        getApplication().globalData.searchStore.set({ city });
        wxApi.navigateBack({ delta: 1 });
      } catch {
        wxApi.showToast?.({ title: "城市选择失败，请重试", icon: "none" });
      }
    },
  };
}

const definition = createCitySelectPage();
if (typeof Page === "function") {
  Page(definition);
}

module.exports = {
  createCitySelectPage,
};

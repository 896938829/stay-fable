"use strict";

const { addDays, formatDate } = require("../../utils/date");
const { changeCheckin, changeCheckout, changeGuests } = require("./date-guest-select.logic");

function createDateGuestPage(dependencies = {}) {
  const wxApi = dependencies.wxApi || globalThis.wx;
  const getApplication = dependencies.getApp || globalThis.getApp;
  const clock = dependencies.clock || (() => new Date());

  function showInvalid() {
    wxApi.showToast({
      title: "日期或人数设置无效，请检查",
      icon: "none",
    });
  }

  function updateContext(page, context) {
    page.setData({
      checkin: context.checkin,
      checkout: context.checkout,
      guests: context.guests,
      checkoutMin: formatDate(addDays(context.checkin, 1)),
      checkoutMax: formatDate(addDays(context.checkin, 30)),
    });
  }

  return {
    data: {
      status: "loading",
      errorMessage: "",
      today: "",
      checkin: "",
      checkout: "",
      checkoutMin: "",
      checkoutMax: "",
      guests: 2,
      saving: false,
    },

    onLoad() {
      this.setData({ today: formatDate(clock()) });
      return this.loadContext();
    },

    loadContext() {
      try {
        const context = getApplication().globalData.searchStore.get();
        updateContext(this, context);
        this.setData({ status: "ready", errorMessage: "" });
      } catch {
        this.setData({
          status: "error",
          errorMessage: "搜索条件读取失败，请重试",
        });
      }
    },

    retry() {
      try {
        getApplication().globalData.searchStore.clear();
      } catch {
        this.setData({
          status: "error",
          errorMessage: "搜索条件读取失败，请重试",
        });
        return;
      }
      this.loadContext();
    },

    changeCheckin(event) {
      try {
        updateContext(
          this,
          changeCheckin(
            {
              checkin: this.data.checkin,
              checkout: this.data.checkout,
              guests: this.data.guests,
            },
            event.detail.value,
            this.data.today,
          ),
        );
      } catch {
        showInvalid();
      }
    },

    changeCheckout(event) {
      try {
        updateContext(
          this,
          changeCheckout(
            {
              checkin: this.data.checkin,
              checkout: this.data.checkout,
              guests: this.data.guests,
            },
            event.detail.value,
          ),
        );
      } catch {
        showInvalid();
      }
    },

    decrementGuests() {
      updateContext(
        this,
        changeGuests(
          {
            checkin: this.data.checkin,
            checkout: this.data.checkout,
            guests: this.data.guests,
          },
          -1,
        ),
      );
    },

    incrementGuests() {
      updateContext(
        this,
        changeGuests(
          {
            checkin: this.data.checkin,
            checkout: this.data.checkout,
            guests: this.data.guests,
          },
          1,
        ),
      );
    },

    save() {
      if (this.data.saving || this.data.status !== "ready") {
        return;
      }
      this.setData({ saving: true });
      try {
        getApplication().globalData.searchStore.set({
          checkin: this.data.checkin,
          checkout: this.data.checkout,
          guests: this.data.guests,
        });
        wxApi.navigateBack({ delta: 1 });
      } catch {
        showInvalid();
      } finally {
        this.setData({ saving: false });
      }
    },
  };
}

const definition = createDateGuestPage();
if (typeof Page === "function") {
  Page(definition);
}

module.exports = {
  createDateGuestPage,
};

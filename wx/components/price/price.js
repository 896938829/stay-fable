"use strict";

const { formatMoney } = require("../../utils/money");

const definition = {
  properties: {
    cents: { type: Number, value: 0 },
    prefix: { type: String, value: "每晚" },
    suffix: { type: String, value: "起" },
  },
  data: {
    available: true,
    formatted: "¥0.00",
  },
  observers: {
    cents(cents) {
      if (!Number.isSafeInteger(cents) || cents < 0) {
        this.setData({
          available: false,
          formatted: "价格暂不可用",
        });
        return;
      }
      this.setData({
        available: true,
        formatted: formatMoney(cents),
      });
    },
  },
};

if (typeof Component === "function") {
  Component(definition);
}

module.exports = definition;

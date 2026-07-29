"use strict";

const { formatMoney } = require("../../utils/money");

const definition = {
  properties: {
    cents: { type: Number, value: 0 },
    prefix: { type: String, value: "每晚" },
    suffix: { type: String, value: "起" },
  },
  data: {
    formatted: "¥0.00",
  },
  observers: {
    cents(cents) {
      const safeCents =
        Number.isSafeInteger(cents) && cents >= 0 ? cents : 0;
      this.setData({
        formatted: formatMoney(safeCents),
      });
    },
  },
};

if (typeof Component === "function") {
  Component(definition);
}

module.exports = definition;

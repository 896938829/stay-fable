"use strict";

const definition = {
  properties: {
    title: {
      type: String,
      value: "加载失败",
    },
    message: {
      type: String,
      value: "",
    },
    actionText: {
      type: String,
      value: "重试",
    },
  },
  methods: {
    handleRetry() {
      this.triggerEvent("retry");
    },
  },
};

if (typeof Component === "function") {
  Component(definition);
}

module.exports = definition;

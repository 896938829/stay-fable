"use strict";

const definition = {
  properties: {
    title: {
      type: String,
      value: "暂无内容",
    },
    description: {
      type: String,
      value: "",
    },
    actionText: {
      type: String,
      value: "",
    },
  },
  methods: {
    handleAction() {
      this.triggerEvent("action");
    },
  },
};

if (typeof Component === "function") {
  Component(definition);
}

module.exports = definition;

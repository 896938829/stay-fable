"use strict";

const definition = {
  properties: {
    text: {
      type: String,
      value: "正在加载",
    },
  },
};

if (typeof Component === "function") {
  Component(definition);
}

module.exports = definition;

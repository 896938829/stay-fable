import { readFile } from "node:fs/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

function loadDefinition(modulePath) {
  let definition;
  globalThis.Component = vi.fn((value) => {
    definition = value;
  });
  return import(`${modulePath}?test=${Math.random()}`).then(() => definition);
}

describe("state components", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("registers loading-state with its default text", async () => {
    const definition = await loadDefinition("../components/loading-state/loading-state.js");
    expect(definition.properties.text).toEqual({
      type: String,
      value: "正在加载",
    });
  });

  it("registers empty-state defaults and emits action", async () => {
    const definition = await loadDefinition("../components/empty-state/empty-state.js");
    expect(definition.properties).toMatchObject({
      title: { type: String, value: "暂无内容" },
      description: { type: String, value: "" },
      actionText: { type: String, value: "" },
    });
    const triggerEvent = vi.fn();
    definition.methods.handleAction.call({ triggerEvent });
    expect(triggerEvent).toHaveBeenCalledWith("action");
  });

  it("registers error-state defaults and emits retry", async () => {
    const definition = await loadDefinition("../components/error-state/error-state.js");
    expect(definition.properties).toMatchObject({
      title: { type: String, value: "加载失败" },
      message: { type: String, value: "" },
      actionText: { type: String, value: "重试" },
    });
    const triggerEvent = vi.fn();
    definition.methods.handleRetry.call({ triggerEvent });
    expect(triggerEvent).toHaveBeenCalledWith("retry");
  });

  it.each(["loading-state", "empty-state", "error-state"])(
    "uses WeChat aria-role in %s",
    async (name) => {
      const wxml = await readFile(
        new URL(`../components/${name}/${name}.wxml`, import.meta.url),
        "utf8",
      );

      expect(wxml).toContain("aria-role=");
      expect(wxml).not.toMatch(/\srole=/);
    },
  );
});

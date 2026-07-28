import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "./app";

afterEach(cleanup);

describe("App", () => {
  it("does not pass the removed message prop to Ant Design Alert", () => {
    const source = readFileSync(join(process.cwd(), "src", "app.tsx"), "utf8");

    expect(source).toContain('title="基础环境已就绪"');
    expect(source).not.toContain('message="基础环境已就绪"');
  });

  it("renders the foundation-ready management shell", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Stay Fable 管理平台" })).toBeVisible();
    expect(screen.getByText("基础环境已就绪")).toBeVisible();
  });
});

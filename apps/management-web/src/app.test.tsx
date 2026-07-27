import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "./app";

describe("App", () => {
  it("renders the foundation-ready management shell", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Stay Fable 管理平台" })).toBeVisible();
    expect(screen.getByText("基础环境已就绪")).toBeVisible();
  });
});

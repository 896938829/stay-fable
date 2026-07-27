import { render, screen } from "@testing-library/react";

import { App } from "./app";

describe("App", () => {
  it("renders the foundation-ready management shell", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Stay Fable 管理平台" })).toBeInTheDocument();
    expect(screen.getByText("基础环境已就绪")).toBeInTheDocument();
  });
});

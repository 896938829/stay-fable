import { createQueryClient } from "./query-client";

describe("createQueryClient", () => {
  it("uses the management shell retry defaults", () => {
    const options = createQueryClient().getDefaultOptions();

    expect(options.queries).toMatchObject({
      retry: 1,
      staleTime: 30_000,
    });
    expect(options.mutations).toMatchObject({
      retry: false,
    });
  });
});

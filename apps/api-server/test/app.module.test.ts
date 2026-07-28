import { RequestMethod } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { LOGGER_ROUTES } from "../src/logger-routes.js";

describe("AppModule logging middleware", () => {
  it("uses the NestJS 11 named wildcard syntax", () => {
    expect(LOGGER_ROUTES).toEqual([{ path: "{*path}", method: RequestMethod.ALL }]);
  });
});

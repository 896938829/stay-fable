import { describe, expect, test } from "vitest";

import {
  requireSafeDatabaseIntegrationUrl,
  unsafeDatabaseIntegrationUrlError,
} from "./database-integration-guard.js";

describe("database integration URL guard", () => {
  test.each([
    "postgresql://user:password@localhost:5432/stay_fable_test",
    "postgresql://user:password@127.0.0.1:5432/stay_fable_ci",
    "postgresql://user:password@[::1]:5432/stay_fable_test",
  ])("allows loopback test database URL %s", (databaseUrl) => {
    expect(requireSafeDatabaseIntegrationUrl(databaseUrl)).toBe(databaseUrl);
  });

  test.each([
    undefined,
    "not-a-url",
    "postgresql://user:password@database.internal:5432/stay_fable_test",
    "postgresql://user:password@127.0.0.1:5432/stay_fable",
  ])("rejects unsafe database URL %s with a fixed diagnostic", (databaseUrl) => {
    expect(() => requireSafeDatabaseIntegrationUrl(databaseUrl)).toThrowError(
      unsafeDatabaseIntegrationUrlError,
    );
  });
});

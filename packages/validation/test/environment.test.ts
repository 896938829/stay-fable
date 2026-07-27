import { describe, expect, it } from "vitest";

import { parseRuntimeEnvironment } from "../src/environment.js";

const productionEnvironment = (databaseUrl: string) => ({
  NODE_ENV: "production",
  DATABASE_URL: databaseUrl,
  REDIS_URL: "redis://localhost:6379",
});

const expectTlsError = (databaseUrl: string) => {
  let thrown: unknown;

  try {
    parseRuntimeEnvironment(productionEnvironment(databaseUrl));
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toBe("Production DATABASE_URL must require TLS");
};

describe("parseRuntimeEnvironment", () => {
  it("rejects a production DATABASE_URL that disables TLS", () => {
    expectTlsError("postgresql://user:password@localhost:5432/stay_fable?sslmode=disable");
  });

  it("accepts a production DATABASE_URL whose sslmode is require", () => {
    expect(
      parseRuntimeEnvironment(
        productionEnvironment(
          "postgresql://user:password@localhost:5432/stay_fable?sslmode=require",
        ),
      ),
    ).toMatchObject({
      NODE_ENV: "production",
      PORT: 3000,
    });
  });

  it.each([
    [
      "an unrelated query value contains the required text",
      "postgresql://user:password@localhost:5432/stay_fable?sslmode=disable&note=sslmode=require",
    ],
    [
      "a differently named parameter contains the required text",
      "postgresql://user:password@localhost:5432/stay_fable?notsslmode=require",
    ],
    [
      "credentials contain the required text",
      "postgresql://sslmode=require@localhost:5432/stay_fable",
    ],
  ])("rejects production TLS when %s", (_scenario, databaseUrl) => {
    expectTlsError(databaseUrl);
  });
});

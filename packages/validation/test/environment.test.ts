import { describe, expect, it } from "vitest";

import { parseRuntimeEnvironment, validateDatabaseUrlPolicy } from "../src/environment.js";

const productionEnvironment = (databaseUrl: string, redisUrl = "rediss://localhost:6380") => ({
  NODE_ENV: "production",
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  IDENTITY_PROVIDER: "code2session",
  ENABLE_MOCK_PAYMENT: "false",
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
    "postgresql://user:password@localhost:5432/stay_fable?sslmode=require",
    "postgres://user:password@localhost:5432/stay_fable?sslmode=require",
  ])("accepts production PostgreSQL and secure Redis URLs: %s", (databaseUrl) => {
    expect(parseRuntimeEnvironment(productionEnvironment(databaseUrl))).toMatchObject({
      DATABASE_URL: databaseUrl,
      REDIS_URL: "rediss://localhost:6380",
    });
  });

  it.each([
    ["HTTPS", "https://user:secret@database.example.test/stay_fable"],
    ["MySQL", "mysql://user:secret@database.example.test/stay_fable"],
  ])("rejects a %s DATABASE_URL without exposing credentials", (_scheme, databaseUrl) => {
    let thrown: unknown;

    try {
      parseRuntimeEnvironment({
        NODE_ENV: "development",
        DATABASE_URL: databaseUrl,
        REDIS_URL: "redis://localhost:6379",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(
      "DATABASE_URL must use postgres: or postgresql: protocol",
    );
    expect((thrown as Error).message).not.toContain("user");
    expect((thrown as Error).message).not.toContain("secret");
  });

  it("rejects an HTTPS REDIS_URL without exposing credentials", () => {
    let thrown: unknown;

    try {
      parseRuntimeEnvironment({
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://localhost:5432/stay_fable",
        REDIS_URL: "https://user:secret@redis.example.test",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("REDIS_URL must use redis: or rediss: protocol");
    expect((thrown as Error).message).not.toContain("user");
    expect((thrown as Error).message).not.toContain("secret");
  });

  it("allows redis: in development", () => {
    expect(
      parseRuntimeEnvironment({
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://localhost:5432/stay_fable",
        REDIS_URL: "redis://localhost:6379",
      }).REDIS_URL,
    ).toBe("redis://localhost:6379");
  });

  it("applies safe identity, payment, session, and location defaults", () => {
    expect(
      parseRuntimeEnvironment({
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://localhost:5432/stay_fable",
        REDIS_URL: "redis://localhost:6379",
      }),
    ).toMatchObject({
      IDENTITY_PROVIDER: "mock",
      ENABLE_MOCK_PAYMENT: false,
      SESSION_ACCESS_TTL_SECONDS: 7200,
      SESSION_REFRESH_TTL_SECONDS: 2_592_000,
      LOCATION_MAX_DISTANCE_METERS: 100_000,
    });
  });

  it.each([
    ["true", true],
    ["false", false],
  ])("parses ENABLE_MOCK_PAYMENT=%s", (input, expected) => {
    expect(
      parseRuntimeEnvironment({
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://localhost:5432/stay_fable",
        REDIS_URL: "redis://localhost:6379",
        ENABLE_MOCK_PAYMENT: input,
      }).ENABLE_MOCK_PAYMENT,
    ).toBe(expected);
  });

  it("rejects non-boolean environment strings for ENABLE_MOCK_PAYMENT", () => {
    expect(() =>
      parseRuntimeEnvironment({
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://localhost:5432/stay_fable",
        REDIS_URL: "redis://localhost:6379",
        ENABLE_MOCK_PAYMENT: "yes",
      }),
    ).toThrow();
  });

  it.each([
    ["SESSION_ACCESS_TTL_SECONDS", 59],
    ["SESSION_ACCESS_TTL_SECONDS", 86_401],
    ["SESSION_REFRESH_TTL_SECONDS", 3_599],
    ["SESSION_REFRESH_TTL_SECONDS", 7_776_001],
    ["LOCATION_MAX_DISTANCE_METERS", 999],
    ["LOCATION_MAX_DISTANCE_METERS", 500_001],
  ])("rejects %s outside its supported range", (name, value) => {
    expect(() =>
      parseRuntimeEnvironment({
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://localhost:5432/stay_fable",
        REDIS_URL: "redis://localhost:6379",
        [name]: value,
      }),
    ).toThrow();
  });

  it("rejects the mock identity provider in production with a stable message", () => {
    expect(() =>
      parseRuntimeEnvironment({
        ...productionEnvironment("postgresql://localhost:5432/stay_fable?sslmode=require"),
        IDENTITY_PROVIDER: "mock",
      }),
    ).toThrow("Production IDENTITY_PROVIDER must be code2session");
  });

  it("rejects mock payment in production with a stable message", () => {
    expect(() =>
      parseRuntimeEnvironment({
        ...productionEnvironment("postgresql://localhost:5432/stay_fable?sslmode=require"),
        ENABLE_MOCK_PAYMENT: "true",
      }),
    ).toThrow("Production ENABLE_MOCK_PAYMENT must be false");
  });

  it("rejects redis: in production", () => {
    expect(() =>
      parseRuntimeEnvironment(
        productionEnvironment(
          "postgresql://localhost:5432/stay_fable?sslmode=require",
          "redis://localhost:6379",
        ),
      ),
    ).toThrow("Production REDIS_URL must use rediss: protocol");
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
    [
      "sslmode is repeated after the required value",
      "postgresql://localhost:5432/stay_fable?sslmode=require&sslmode=disable",
    ],
    [
      "sslmode is repeated before the required value",
      "postgresql://localhost:5432/stay_fable?sslmode=disable&sslmode=require",
    ],
    [
      "a repeated sslmode parameter name is percent-encoded",
      "postgresql://localhost:5432/stay_fable?sslmode=require&%73slmode=disable",
    ],
  ])("rejects production TLS when %s", (_scenario, databaseUrl) => {
    expectTlsError(databaseUrl);
  });
});

describe("validateDatabaseUrlPolicy", () => {
  it.each(["postgres:", "postgresql:"])(
    "accepts the %s protocol outside production",
    (protocol) => {
      const databaseUrl = `${protocol}//user:secret@localhost:5432/stay_fable?sslmode=disable`;

      expect(validateDatabaseUrlPolicy("development", databaseUrl)).toBe(databaseUrl);
    },
  );

  it("requires exactly one sslmode=require value in production", () => {
    const databaseUrl = "postgresql://user:secret@localhost:5432/stay_fable?sslmode=require";

    expect(validateDatabaseUrlPolicy("production", databaseUrl)).toBe(databaseUrl);
  });

  it.each([
    "postgresql://user:secret@localhost:5432/stay_fable",
    "postgresql://user:secret@localhost:5432/stay_fable?sslmode=disable",
    "postgresql://user:secret@localhost:5432/stay_fable?sslmode=require&sslmode=require",
    "postgresql://user:secret@localhost:5432/stay_fable?sslmode=require&sslmode=disable",
  ])("rejects an unsafe production TLS policy without exposing the URL: %s", (databaseUrl) => {
    let thrown: unknown;

    try {
      validateDatabaseUrlPolicy("production", databaseUrl);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Production DATABASE_URL must require TLS");
    expect((thrown as Error).message).not.toMatch(/user|secret|localhost/);
  });

  it.each([
    ["invalid syntax", "not a database url"],
    ["wrong protocol", "https://user:secret@database.example.test/stay_fable"],
  ])("rejects %s with a safe protocol message", (_scenario, databaseUrl) => {
    let thrown: unknown;

    try {
      validateDatabaseUrlPolicy("development", databaseUrl);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      "DATABASE_URL must use postgres: or postgresql: protocol",
    );
    expect((thrown as Error).message).not.toMatch(/user|secret|database\.example/);
  });
});

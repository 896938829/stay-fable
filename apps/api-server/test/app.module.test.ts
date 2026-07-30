import { RequestMethod } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { BookingModule } from "../src/booking/booking.module.js";
import { DevPaymentsController } from "../src/booking/dev-payments.controller.js";
import { MockPaymentModule } from "../src/booking/mock-payment.module.js";
import { DatabaseModule } from "../src/database/database.module.js";
import { IdentityModule } from "../src/identity/identity.module.js";
import { LOGGER_ROUTES } from "../src/logger-routes.js";

describe("AppModule logging middleware", () => {
  it("uses the NestJS 11 named wildcard syntax", () => {
    expect(LOGGER_ROUTES).toEqual([{ path: "{*path}", method: RequestMethod.ALL }]);
  });

  it("redacts identity secrets and exact coordinates from request bodies", async () => {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = "postgresql://localhost:5432/stay_fable";
    process.env.REDIS_URL = "redis://localhost:6379";
    const { AppModule } = await import("../src/app.module.js");
    const imports = Reflect.getMetadata("imports", AppModule) as Array<{
      providers?: Array<{
        useValue?: {
          pinoHttp?: {
            redact?: {
              paths?: string[];
            };
          };
        };
      }>;
    }>;
    const paths = imports
      .flatMap((item) => item.providers ?? [])
      .map((provider) => provider.useValue?.pinoHttp?.redact?.paths)
      .find((value): value is string[] => value !== undefined);

    expect(paths).toEqual(
      expect.arrayContaining([
        "req.body.code",
        "req.body.refresh_token",
        "req.body.longitude",
        "req.body.latitude",
        'req.headers["idempotency-key"]',
      ]),
    );
  });

  it("imports the catalog module without instantiating live dependencies", async () => {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = "postgresql://localhost:5432/stay_fable";
    process.env.REDIS_URL = "redis://localhost:6379";
    const [{ AppModule }, { CatalogModule }] = await Promise.all([
      import("../src/app.module.js"),
      import("../src/catalog/catalog.module.js"),
    ]);
    const imports = Reflect.getMetadata("imports", AppModule) as unknown[];

    expect(imports).toContain(CatalogModule);
  });

  it("conditionally registers the mock payment controller from shared runtime parsing", () => {
    const base = {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://localhost:5432/stay_fable",
      REDIS_URL: "redis://localhost:6379",
      IDENTITY_PROVIDER: "mock",
    };
    const disabled = MockPaymentModule.forRoot({
      ...base,
      ENABLE_MOCK_PAYMENT: "false",
    });
    const enabled = MockPaymentModule.forRoot({
      ...base,
      ENABLE_MOCK_PAYMENT: "true",
    });

    expect(disabled.imports).toEqual([]);
    expect(disabled.controllers).toEqual([]);
    expect(enabled.imports).toEqual([BookingModule, DatabaseModule, IdentityModule]);
    expect(enabled.controllers).toEqual([DevPaymentsController]);
  });

  it("rejects enabling mock payment in production during module construction", () => {
    expect(() =>
      MockPaymentModule.forRoot({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://localhost:5432/stay_fable?sslmode=require",
        REDIS_URL: "rediss://localhost:6379",
        IDENTITY_PROVIDER: "code2session",
        ENABLE_MOCK_PAYMENT: "true",
      }),
    ).toThrow("Production ENABLE_MOCK_PAYMENT must be false");
  });

  it("adds exactly one conditional mock-payment dynamic module to AppModule", async () => {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = "postgresql://localhost:5432/stay_fable";
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.IDENTITY_PROVIDER = "mock";
    process.env.ENABLE_MOCK_PAYMENT = "false";
    const { AppModule } = await import("../src/app.module.js");
    const imports = Reflect.getMetadata("imports", AppModule) as Array<{
      module?: unknown;
      imports?: unknown[];
      controllers?: unknown[];
    }>;
    const matches = imports.filter((entry) => entry?.module === MockPaymentModule);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.imports).toEqual([]);
    expect(matches[0]?.controllers).toEqual([]);
  });
});

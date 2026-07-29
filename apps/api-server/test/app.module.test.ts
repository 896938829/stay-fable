import { RequestMethod } from "@nestjs/common";
import { describe, expect, it } from "vitest";

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
});

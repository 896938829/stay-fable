import { describe, expect, it } from "vitest";

import { DatabaseModule } from "../src/database/database.module.js";
import { IdentityModule } from "../src/identity/identity.module.js";
import { LocationController } from "../src/location/location.controller.js";
import { LocationModule } from "../src/location/location.module.js";
import { LocationService } from "../src/location/location.service.js";

describe("LocationModule", () => {
  it("reuses database and identity dependencies and exposes the location API", () => {
    expect(Reflect.getMetadata("imports", LocationModule)).toEqual([
      DatabaseModule,
      IdentityModule,
    ]);
    expect(Reflect.getMetadata("controllers", LocationModule)).toEqual([LocationController]);
    expect(Reflect.getMetadata("providers", LocationModule)).toEqual([LocationService]);
    expect(Reflect.getMetadata("exports", LocationModule)).toEqual([LocationService]);
  });

  it("is imported by the root application module", async () => {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = "postgresql://localhost:5432/stay_fable";
    process.env.REDIS_URL = "redis://localhost:6379";
    const { AppModule } = await import("../src/app.module.js");

    expect(Reflect.getMetadata("imports", AppModule)).toContain(LocationModule);
  });
});

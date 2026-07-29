import type { INestApplication } from "@nestjs/common";
import { SwaggerModule } from "@nestjs/swagger";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configureApplication, OPEN_API_CONFIG } from "../src/application-configuration.js";
import { SessionAuthGuard } from "../src/identity/session-auth.guard.js";
import { PricingModule } from "../src/pricing/pricing.module.js";
import { QuotesController } from "../src/pricing/quotes.controller.js";
import { QuotesService } from "../src/pricing/quotes.service.js";

type Schema = {
  additionalProperties?: boolean;
  enum?: string[];
  format?: string;
  items?: Schema;
  maximum?: number;
  minimum?: number;
  pattern?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  type?: string;
  $ref?: string;
};
type Operation = {
  requestBody?: { content?: { "application/json"?: { schema?: Schema } } };
  responses?: Record<string, { content?: { "application/json"?: { schema?: Schema } } }>;
  security?: Array<Record<string, string[]>>;
};
type Document = {
  paths: Record<string, { post?: Operation }>;
  components?: { schemas?: Record<string, Schema> };
};

describe("Booking slice OpenAPI", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("documents only the authenticated strict quote POST contract for this task", async () => {
    const module = await Test.createTestingModule({
      controllers: [QuotesController],
      providers: [{ provide: QuotesService, useValue: { create: vi.fn() } }],
    })
      .overrideGuard(SessionAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    configureApplication(app, "production");
    await app.init();
    const document = SwaggerModule.createDocument(app, OPEN_API_CONFIG) as unknown as Document;
    expect(Object.keys(document.paths)).toEqual(["/api/v1/quotes"]);
    expect(document.paths).not.toHaveProperty("/api/v1/bookings");
    const operation = document.paths["/api/v1/quotes"]?.post;
    expect(operation?.security).toEqual([{ session: [] }]);
    expect(operation?.requestBody?.content?.["application/json"]?.schema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["room_type_id", "checkin", "checkout", "guests"],
      properties: {
        room_type_id: { type: "string", format: "uuid" },
        checkin: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        checkout: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        guests: { type: "integer", minimum: 1, maximum: 10 },
      },
    });
    expect(operation?.responses?.["201"]?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/QuoteEnvelopeDto",
    });
    for (const status of ["400", "401", "403", "404", "422", "429", "503"]) {
      expect(operation?.responses?.[status]?.content?.["application/json"]?.schema).toEqual({
        $ref: "#/components/schemas/QuoteErrorEnvelopeDto",
      });
    }

    const schemas = document.components?.schemas;
    expect(schemas?.QuoteEnvelopeDto?.required).toEqual(["data", "request_id"]);
    expect(schemas?.QuoteResponseDto?.required).toEqual([
      "quote_id",
      "property",
      "room_type",
      "checkin",
      "checkout",
      "nights",
      "guests",
      "nightly_prices",
      "total_price_cents",
      "currency",
      "booking_policy",
      "expires_at",
    ]);
    expect(schemas?.QuoteResponseDto?.properties?.nightly_prices).toMatchObject({
      type: "array",
      items: { $ref: "#/components/schemas/QuoteNightlyPriceDto" },
      minItems: 1,
      maxItems: 30,
    });
    expect(schemas?.QuoteNightlyPriceDto?.properties?.sale_price_cents?.maximum).toBe(
      2_147_483_647,
    );
    expect(schemas?.QuoteNightlyPriceDto?.properties?.rack_price_cents?.maximum).toBe(
      2_147_483_647,
    );
    expect(schemas?.QuoteResponseDto?.properties?.total_price_cents?.maximum).toBe(2_147_483_647);
    expect(JSON.stringify(schemas?.QuoteResponseDto)).not.toMatch(
      /inventory|fingerprint|user_id|version|held|sold/,
    );
  });

  it("keeps the production module wiring explicit without exposing bookings early", async () => {
    const previousEnvironment = {
      DATABASE_URL: process.env.DATABASE_URL,
      REDIS_URL: process.env.REDIS_URL,
      IDENTITY_PROVIDER: process.env.IDENTITY_PROVIDER,
    };
    process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:5432/test";
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    process.env.IDENTITY_PROVIDER = "mock";
    try {
      const { AppModule } = await import("../src/app.module.js");
      const appImports = Reflect.getMetadata("imports", AppModule) as unknown[];
      const pricingControllers = Reflect.getMetadata("controllers", PricingModule) as unknown[];
      expect(appImports).toContain(PricingModule);
      expect(pricingControllers).toEqual([QuotesController]);
    } finally {
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

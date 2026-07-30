import type { INestApplication } from "@nestjs/common";
import { SwaggerModule } from "@nestjs/swagger";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configureApplication, OPEN_API_CONFIG } from "../src/application-configuration.js";
import { BookingActionsController } from "../src/booking/booking-actions.controller.js";
import { BookingLifecycleService } from "../src/booking/booking-lifecycle.service.js";
import { BookingModule } from "../src/booking/booking.module.js";
import { BookingQueryController } from "../src/booking/booking-query.controller.js";
import { BookingQueryService } from "../src/booking/booking-query.service.js";
import { BookingsController } from "../src/booking/bookings.controller.js";
import { BookingsService } from "../src/booking/bookings.service.js";
import { SessionAuthGuard } from "../src/identity/session-auth.guard.js";
import { PricingModule } from "../src/pricing/pricing.module.js";
import { QuotesController } from "../src/pricing/quotes.controller.js";
import { QuotesService } from "../src/pricing/quotes.service.js";

type Schema = {
  additionalProperties?: boolean;
  enum?: string[];
  format?: string;
  items?: Schema;
  maxLength?: number;
  maximum?: number;
  minLength?: number;
  minimum?: number;
  pattern?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  type?: string;
  $ref?: string;
};
type Operation = {
  parameters?: Array<{
    in?: string;
    name?: string;
    required?: boolean;
    schema?: Schema;
  }>;
  requestBody?: { content?: { "application/json"?: { schema?: Schema } } };
  responses?: Record<string, { content?: { "application/json"?: { schema?: Schema } } }>;
  security?: Array<Record<string, string[]>>;
};
type Document = {
  paths: Record<string, { get?: Operation; post?: Operation }>;
  components?: { schemas?: Record<string, Schema> };
};

describe("Booking slice OpenAPI", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("documents only the authenticated strict quote and booking contracts", async () => {
    const module = await Test.createTestingModule({
      controllers: [
        QuotesController,
        BookingsController,
        BookingQueryController,
        BookingActionsController,
      ],
      providers: [
        { provide: QuotesService, useValue: { create: vi.fn() } },
        { provide: BookingsService, useValue: { create: vi.fn() } },
        {
          provide: BookingQueryService,
          useValue: { listOwned: vi.fn(), getOwned: vi.fn() },
        },
        { provide: BookingLifecycleService, useValue: { cancel: vi.fn() } },
      ],
    })
      .overrideGuard(SessionAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    configureApplication(app, "production");
    await app.init();
    const document = SwaggerModule.createDocument(app, OPEN_API_CONFIG) as unknown as Document;
    expect(Object.keys(document.paths).sort()).toEqual([
      "/api/v1/bookings",
      "/api/v1/bookings/{bookingId}",
      "/api/v1/bookings/{bookingId}/cancel",
      "/api/v1/quotes",
    ]);
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

    const bookingOperation = document.paths["/api/v1/bookings"]?.post;
    expect(bookingOperation?.security).toEqual([{ session: [] }]);
    expect(bookingOperation?.parameters).toContainEqual({
      in: "header",
      name: "Idempotency-Key",
      required: true,
      schema: {
        type: "string",
        pattern: "^[A-Za-z0-9._~-]{32,80}$",
        minLength: 32,
        maxLength: 80,
      },
    });
    expect(bookingOperation?.requestBody?.content?.["application/json"]?.schema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["quote_id"],
      properties: {
        quote_id: { type: "string", format: "uuid" },
      },
    });
    for (const status of ["200", "201"]) {
      expect(bookingOperation?.responses?.[status]?.content?.["application/json"]?.schema).toEqual({
        $ref: "#/components/schemas/BookingEnvelopeDto",
      });
    }
    for (const status of ["400", "401", "403", "503"]) {
      expect(bookingOperation?.responses?.[status]?.content?.["application/json"]?.schema).toEqual({
        $ref: "#/components/schemas/BookingErrorEnvelopeDto",
      });
    }
    expect(bookingOperation?.responses?.["409"]?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/BookingConflictErrorEnvelopeDto",
    });
    expect(bookingOperation?.responses?.["429"]?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/BookingRateLimitErrorEnvelopeDto",
    });
    expect(schemas?.BookingEnvelopeDto?.required).toEqual(["data", "request_id"]);
    expect(schemas?.BookingResponseDto?.required).toEqual([
      "booking_id",
      "quote_id",
      "booking_number",
      "status",
      "property_name",
      "room_type_name",
      "checkin",
      "checkout",
      "nights",
      "guests",
      "total_price_cents",
      "currency",
      "expires_at",
      "created_at",
    ]);
    expect(schemas?.QuoteChangedDetailsDto?.required).toEqual([
      "previous_total_price_cents",
      "replacement_quote",
    ]);
    expect(schemas?.QuoteChangedDetailsDto?.properties?.replacement_quote).toEqual({
      $ref: "#/components/schemas/QuoteResponseDto",
    });
    expect(schemas?.BookingErrorDto?.properties).not.toHaveProperty("details");
    expect(schemas?.BookingConflictErrorDto?.required).toEqual(["code", "message"]);
    expect(schemas?.BookingConflictErrorDto?.properties?.details).toEqual({
      $ref: "#/components/schemas/QuoteChangedDetailsDto",
    });
    expect(schemas?.BookingRateLimitErrorDto?.required).toEqual(["code", "message", "details"]);
    expect(schemas?.RateLimitDetailsDto?.required).toEqual(["retry_after_seconds"]);
    expect(schemas?.RateLimitDetailsDto?.properties?.retry_after_seconds).toEqual({
      type: "integer",
      minimum: 1,
      maximum: 60,
    });
    expect(JSON.stringify(schemas?.BookingResponseDto)).not.toMatch(
      /inventory|fingerprint|user_id|version|history|held|sold/,
    );

    const listOperation = document.paths["/api/v1/bookings"]?.get;
    expect(listOperation?.security).toEqual([{ session: [] }]);
    expect(listOperation?.parameters).toEqual([
      {
        in: "query",
        name: "limit",
        required: false,
        schema: { type: "integer", default: 10, minimum: 1, maximum: 20 },
      },
      {
        in: "query",
        name: "cursor",
        required: false,
        schema: {
          type: "string",
          minLength: 1,
          maxLength: 512,
          pattern: "^[A-Za-z0-9_-]+$",
        },
      },
    ]);
    expect(listOperation?.responses?.["200"]?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/BookingListEnvelopeDto",
    });

    const detailOperation = document.paths["/api/v1/bookings/{bookingId}"]?.get;
    expect(detailOperation?.security).toEqual([{ session: [] }]);
    expect(detailOperation?.parameters).toEqual([
      {
        in: "path",
        name: "bookingId",
        required: true,
        schema: { format: "uuid", type: "string" },
      },
    ]);
    expect(detailOperation?.responses?.["200"]?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/BookingDetailEnvelopeDto",
    });
    expect(detailOperation?.responses?.["404"]?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/BookingLifecycleErrorEnvelopeDto",
    });

    const cancelOperation = document.paths["/api/v1/bookings/{bookingId}/cancel"]?.post;
    expect(cancelOperation?.security).toEqual([{ session: [] }]);
    expect(cancelOperation?.parameters).toEqual([
      {
        in: "path",
        name: "bookingId",
        required: true,
        schema: { format: "uuid", type: "string" },
      },
    ]);
    expect(cancelOperation?.requestBody?.content?.["application/json"]?.schema).toEqual({
      type: "object",
      additionalProperties: false,
    });
    expect(cancelOperation?.responses?.["200"]?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/BookingDetailEnvelopeDto",
    });
    for (const status of ["400", "401", "403", "404", "409", "503"]) {
      expect(cancelOperation?.responses?.[status]?.content?.["application/json"]?.schema).toEqual({
        $ref: "#/components/schemas/BookingLifecycleErrorEnvelopeDto",
      });
    }
    expect(cancelOperation?.responses?.["429"]?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/BookingRateLimitErrorEnvelopeDto",
    });

    expect(schemas?.BookingListItemDto?.required).toEqual([
      "booking_id",
      "booking_number",
      "status",
      "property_name",
      "room_type_name",
      "checkin",
      "checkout",
      "nights",
      "guests",
      "total_price_cents",
      "currency",
      "expires_at",
      "payment_deadline_passed",
      "created_at",
      "updated_at",
    ]);
    expect(schemas?.BookingDetailDto?.required).toEqual([
      ...schemas!.BookingListItemDto!.required!,
      "nightly_prices",
      "booking_policy",
      "latest_payment",
      "status_history",
      "allowed_actions",
    ]);
    expect(schemas?.BookingListResponseDto?.properties?.items).toMatchObject({
      type: "array",
      maxItems: 20,
      items: { $ref: "#/components/schemas/BookingListItemDto" },
    });
    expect(schemas?.BookingDetailDto?.properties?.status_history).toMatchObject({
      type: "array",
      maxItems: 100,
      items: { $ref: "#/components/schemas/BookingStatusHistoryItemDto" },
    });
    expect(schemas?.BookingDetailDto?.properties?.allowed_actions?.items?.enum).toEqual([
      "CANCEL",
      "MOCK_PAY_SUCCESS",
      "MOCK_PAY_FAILURE",
    ]);
    const lifecycleSchemas = JSON.stringify({
      list: schemas?.BookingListItemDto,
      detail: schemas?.BookingDetailDto,
      payment: schemas?.BookingPaymentSummaryDto,
      history: schemas?.BookingStatusHistoryItemDto,
    });
    expect(lifecycleSchemas).not.toMatch(
      /user_id|quote_id|idempotency|hold|inventory|actor_user|fingerprint|version/i,
    );
  });

  it("wires the booking module and exports its query service", async () => {
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
      const bookingControllers = Reflect.getMetadata("controllers", BookingModule) as unknown[];
      expect(appImports).toContain(PricingModule);
      expect(appImports).toContain(BookingModule);
      expect(pricingControllers).toEqual([QuotesController]);
      const bookingExports = Reflect.getMetadata("exports", BookingModule) as unknown[];
      expect(bookingControllers).toEqual([
        BookingsController,
        BookingQueryController,
        BookingActionsController,
      ]);
      expect(bookingExports).toContain(BookingQueryService);
      expect(bookingExports).toContain(BookingLifecycleService);
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

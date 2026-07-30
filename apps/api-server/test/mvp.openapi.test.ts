import type { INestApplication } from "@nestjs/common";
import { SwaggerModule } from "@nestjs/swagger";
import { Test } from "@nestjs/testing";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configureApplication, OPEN_API_CONFIG } from "../src/application-configuration.js";
import { BookingActionsController } from "../src/booking/booking-actions.controller.js";
import { BookingLifecycleService } from "../src/booking/booking-lifecycle.service.js";
import { BookingQueryController } from "../src/booking/booking-query.controller.js";
import { BookingQueryService } from "../src/booking/booking-query.service.js";
import { BookingsController } from "../src/booking/bookings.controller.js";
import { BookingsService } from "../src/booking/bookings.service.js";
import { DevPaymentsController } from "../src/booking/dev-payments.controller.js";
import { MockPaymentModule } from "../src/booking/mock-payment.module.js";
import { MockPaymentService } from "../src/booking/mock-payment.service.js";
import { CatalogController } from "../src/catalog/catalog.controller.js";
import { CatalogService } from "../src/catalog/catalog.service.js";
import { AuthController } from "../src/identity/auth.controller.js";
import { AuthService } from "../src/identity/auth.service.js";
import { SessionAuthGuard } from "../src/identity/session-auth.guard.js";
import { LocationController } from "../src/location/location.controller.js";
import { LocationService } from "../src/location/location.service.js";
import { QuotesController } from "../src/pricing/quotes.controller.js";
import { QuotesService } from "../src/pricing/quotes.service.js";

type Schema = {
  additionalProperties?: boolean;
  allOf?: Schema[];
  anyOf?: Schema[];
  enum?: string[];
  format?: string;
  items?: Schema;
  maxLength?: number;
  maximum?: number;
  minLength?: number;
  minimum?: number;
  properties?: Record<string, Schema>;
  oneOf?: Schema[];
  required?: string[];
  type?: string;
  $ref?: string;
};
type Operation = {
  parameters?: Array<{ in?: string; name?: string; required?: boolean; schema?: Schema }>;
  requestBody?: { content?: { "application/json"?: { schema?: Schema } } };
  responses?: Record<string, { content?: { "application/json"?: { schema?: Schema } } }>;
  security?: Array<Record<string, string[]>>;
};
type Document = {
  paths: Record<string, { get?: Operation; post?: Operation }>;
  components?: { schemas?: Record<string, Schema> };
};
type ContractEdge = { kind: "items" | "ref"; target: string };
type ContractShape = {
  fields: readonly string[];
  edges: Readonly<Record<string, ContractEdge>>;
};

const require = createRequire(import.meta.url);
const WX_CONTRACT_SHAPES = require("../../../wx/services/contract-shapes.js") as Readonly<
  Record<string, ContractShape>
>;

function schemaReference(schema: Schema | undefined, location: string): ContractEdge | undefined {
  if (schema?.$ref !== undefined) {
    return { kind: "ref", target: schema.$ref.split("/").at(-1) ?? "" };
  }
  if (schema?.items?.$ref !== undefined) {
    return { kind: "items", target: schema.items.$ref.split("/").at(-1) ?? "" };
  }
  const composed = [...(schema?.allOf ?? []), ...(schema?.anyOf ?? []), ...(schema?.oneOf ?? [])]
    .map((member) => schemaReference(member, location))
    .filter((edge): edge is ContractEdge => edge !== undefined);
  expect(composed.length, `${location} has ambiguous composed references`).toBeLessThanOrEqual(1);
  return composed[0];
}

function assertContractSchemaGraph(
  roots: ReadonlyArray<readonly [string, Schema | undefined]>,
  schemas: Record<string, Schema>,
  contractShapes: Readonly<Record<string, ContractShape>>,
): Set<string> {
  const visited = new Set<string>();
  const active = new Set<string>();
  const walk = (schema: Schema | undefined, location: string): void => {
    expect(schema, location).toBeDefined();
    const edge = schemaReference(schema, location);
    expect(edge, `${location} must reference a DTO`).toBeDefined();
    if (edge === undefined) return;
    const schemaName = edge.target;
    expect(schemaName, location).not.toBe("");
    if (active.has(schemaName)) {
      throw new Error(`Cyclic public schema reference at ${location} -> ${schemaName}`);
    }
    if (visited.has(schemaName)) return;
    active.add(schemaName);
    const expected = contractShapes[schemaName];
    expect(expected, `${location} -> ${schemaName}`).toBeDefined();
    const resolved = schemas[schemaName];
    expect(resolved?.required, `${schemaName}.required`).toEqual(expected?.fields);
    expect(Object.keys(resolved?.properties ?? {}), `${schemaName}.properties`).toEqual(
      expected?.fields,
    );
    const actualEdges: Record<string, ContractEdge> = {};
    for (const [field, propertySchema] of Object.entries(resolved?.properties ?? {})) {
      const propertyEdge = schemaReference(propertySchema, `${schemaName}.${field}`);
      if (propertyEdge !== undefined) actualEdges[field] = propertyEdge;
    }
    expect(actualEdges, `${schemaName} nested reference edges`).toEqual(expected?.edges);
    for (const [field, expectedEdge] of Object.entries(expected?.edges ?? {})) {
      const propertySchema = resolved?.properties?.[field];
      walk(
        expectedEdge.kind === "items" ? propertySchema?.items : propertySchema,
        `${schemaName}.${field}`,
      );
    }
    active.delete(schemaName);
    visited.add(schemaName);
  };
  for (const [route, schema] of roots) walk(schema, route);
  return visited;
}

const requiredProductionRoutes = {
  "/api/v1/auth/session/refresh": "post",
  "/api/v1/auth/wechat/login": "post",
  "/api/v1/bookings": ["get", "post"],
  "/api/v1/bookings/{bookingId}": "get",
  "/api/v1/bookings/{bookingId}/cancel": "post",
  "/api/v1/location/resolve": "post",
  "/api/v1/properties": "get",
  "/api/v1/properties/{propertyId}": "get",
  "/api/v1/quotes": "post",
  "/api/v1/room-types/{roomTypeId}": "get",
} as const;

const responseSchema = (operation: Operation | undefined, status: string) =>
  operation?.responses?.[status]?.content?.["application/json"]?.schema;

describe("MVP aggregate OpenAPI contract", () => {
  let app: INestApplication | undefined;
  const originalEnvironment = {
    DATABASE_URL: process.env.DATABASE_URL,
    ENABLE_MOCK_PAYMENT: process.env.ENABLE_MOCK_PAYMENT,
    IDENTITY_PROVIDER: process.env.IDENTITY_PROVIDER,
    NODE_ENV: process.env.NODE_ENV,
    REDIS_URL: process.env.REDIS_URL,
  };

  afterEach(async () => {
    await app?.close();
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  const createControllerDocument = async (includeDevelopmentPayment = false): Promise<Document> => {
    const controllers = [
      AuthController,
      LocationController,
      CatalogController,
      QuotesController,
      BookingsController,
      BookingQueryController,
      BookingActionsController,
      ...(includeDevelopmentPayment ? [DevPaymentsController] : []),
    ];
    const module = await Test.createTestingModule({
      controllers,
      providers: [
        { provide: AuthService, useValue: { login: vi.fn(), refresh: vi.fn() } },
        { provide: LocationService, useValue: { listCities: vi.fn(), resolve: vi.fn() } },
        {
          provide: CatalogService,
          useValue: { listProperties: vi.fn(), getProperty: vi.fn(), getRoomType: vi.fn() },
        },
        { provide: QuotesService, useValue: { create: vi.fn() } },
        { provide: BookingsService, useValue: { create: vi.fn() } },
        {
          provide: BookingQueryService,
          useValue: { listOwned: vi.fn(), getOwned: vi.fn() },
        },
        { provide: BookingLifecycleService, useValue: { cancel: vi.fn() } },
        { provide: MockPaymentService, useValue: { simulate: vi.fn() } },
      ],
    })
      .overrideGuard(SessionAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    configureApplication(app, "production");
    await app.init();
    return SwaggerModule.createDocument(app, OPEN_API_CONFIG) as unknown as Document;
  };

  const createRootDocument = async (
    nodeEnvironment: "development" | "production",
    enableMockPayment: boolean,
  ): Promise<Document> => {
    process.env.NODE_ENV = nodeEnvironment;
    process.env.DATABASE_URL =
      nodeEnvironment === "production"
        ? "postgresql://localhost:5432/stay_fable?sslmode=require"
        : "postgresql://localhost:5432/stay_fable";
    process.env.REDIS_URL =
      nodeEnvironment === "production" ? "rediss://localhost:6379" : "redis://localhost:6379";
    process.env.IDENTITY_PROVIDER = nodeEnvironment === "production" ? "code2session" : "mock";
    process.env.ENABLE_MOCK_PAYMENT = String(enableMockPayment);
    vi.resetModules();
    const [{ AppModule }, { DatabaseService }, { REDIS_CLIENT }, { WECHAT_IDENTITY_PROVIDER }] =
      await Promise.all([
        import("../src/app.module.js"),
        import("../src/database/database.service.js"),
        import("../src/infrastructure/redis/redis.service.js"),
        import("../src/identity/wechat-identity.provider.js"),
      ]);
    const redis = {
      ping: vi.fn(() => Promise.resolve("PONG")),
      quit: vi.fn(() => Promise.resolve("OK")),
      get: vi.fn(() => Promise.resolve(null)),
      set: vi.fn(() => Promise.resolve("OK")),
      eval: vi.fn(() => Promise.resolve(null)),
      del: vi.fn(() => Promise.resolve(0)),
      pttl: vi.fn(() => Promise.resolve(1_000)),
    };
    const module = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DatabaseService)
      .useValue({ check: vi.fn(() => Promise.resolve()) })
      .overrideProvider(REDIS_CLIENT)
      .useValue(redis)
      .overrideProvider(WECHAT_IDENTITY_PROVIDER)
      .useValue({
        exchange: vi.fn(() =>
          Promise.resolve({
            provider: "WECHAT",
            subject: "test-subject",
          }),
        ),
      })
      .compile();
    app = module.createNestApplication();
    configureApplication(app, nodeEnvironment);
    await app.init();
    return SwaggerModule.createDocument(app, OPEN_API_CONFIG) as unknown as Document;
  };

  it("publishes every MVP route with the intended method and bearer boundary", async () => {
    const document = await createRootDocument("production", false);
    for (const [path, methods] of Object.entries(requiredProductionRoutes)) {
      const expectedMethods = typeof methods === "string" ? [methods] : methods;
      for (const method of expectedMethods) {
        const operation = document.paths[path]?.[method];
        expect(operation, `${method.toUpperCase()} ${path}`).toBeDefined();
        if (!path.startsWith("/api/v1/auth/")) {
          expect(operation?.security, `${method.toUpperCase()} ${path}`).toEqual([{ session: [] }]);
        }
      }
    }
    expect(document.paths["/api/v1/auth/wechat/login"]?.post?.security).toBeUndefined();
    expect(document.paths["/api/v1/auth/session/refresh"]?.post?.security).toBeUndefined();
  });

  it("locks exact write bodies, idempotency headers, statuses, and response envelopes", async () => {
    const document = await createRootDocument("development", true);
    const login = document.paths["/api/v1/auth/wechat/login"]?.post;
    const refresh = document.paths["/api/v1/auth/session/refresh"]?.post;
    const resolve = document.paths["/api/v1/location/resolve"]?.post;
    const quote = document.paths["/api/v1/quotes"]?.post;
    const booking = document.paths["/api/v1/bookings"]?.post;
    const cancel = document.paths["/api/v1/bookings/{bookingId}/cancel"]?.post;
    const payment = document.paths["/api/v1/dev/payments/{bookingId}/simulate"]?.post;

    expect(login?.requestBody?.content?.["application/json"]?.schema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["code"],
      properties: {
        code: { type: "string", minLength: 8, maxLength: 128 },
      },
    });
    expect(refresh?.requestBody?.content?.["application/json"]?.schema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["refresh_token"],
      properties: {
        refresh_token: { type: "string", minLength: 32 },
      },
    });
    expect(resolve?.requestBody?.content?.["application/json"]?.schema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["longitude", "latitude"],
      properties: {
        longitude: { type: "number", minimum: -180, maximum: 180 },
        latitude: { type: "number", minimum: -90, maximum: 90 },
      },
    });
    expect(quote?.requestBody?.content?.["application/json"]?.schema).toEqual({
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
    expect(booking?.requestBody?.content?.["application/json"]?.schema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["quote_id"],
      properties: { quote_id: { type: "string", format: "uuid" } },
    });
    expect(cancel?.requestBody?.content?.["application/json"]?.schema).toEqual({
      type: "object",
      additionalProperties: false,
    });
    expect(payment?.requestBody?.content?.["application/json"]?.schema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["outcome"],
      properties: { outcome: { type: "string", enum: ["SUCCEED", "FAIL"] } },
    });
    for (const operation of [booking, payment]) {
      expect(operation?.parameters).toContainEqual({
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
    }
    expect(responseSchema(booking, "200")).toEqual({
      $ref: "#/components/schemas/BookingEnvelopeDto",
    });
    expect(responseSchema(booking, "201")).toEqual({
      $ref: "#/components/schemas/BookingEnvelopeDto",
    });
    expect(responseSchema(payment, "200")).toEqual({
      $ref: "#/components/schemas/BookingDetailEnvelopeDto",
    });
    expect(responseSchema(payment, "201")).toEqual({
      $ref: "#/components/schemas/BookingDetailEnvelopeDto",
    });
    expect(responseSchema(quote, "201")).toEqual({
      $ref: "#/components/schemas/QuoteEnvelopeDto",
    });
    expect(responseSchema(cancel, "200")).toEqual({
      $ref: "#/components/schemas/BookingDetailEnvelopeDto",
    });
    const successEnvelopes: Array<[Operation | undefined, string, string]> = [
      [login, "201", "AuthSessionEnvelopeDto"],
      [refresh, "201", "AuthSessionEnvelopeDto"],
      [resolve, "200", "ResolvedLocationEnvelopeDto"],
      [document.paths["/api/v1/properties"]?.get, "200", "PropertyListEnvelopeDto"],
      [document.paths["/api/v1/properties/{propertyId}"]?.get, "200", "PropertyDetailEnvelopeDto"],
      [document.paths["/api/v1/room-types/{roomTypeId}"]?.get, "200", "RoomTypeDetailEnvelopeDto"],
      [document.paths["/api/v1/bookings"]?.get, "200", "BookingListEnvelopeDto"],
      [document.paths["/api/v1/bookings/{bookingId}"]?.get, "200", "BookingDetailEnvelopeDto"],
    ];
    for (const [operation, status, envelope] of successEnvelopes) {
      expect(responseSchema(operation, status)).toEqual({
        $ref: `#/components/schemas/${envelope}`,
      });
    }
    for (const operation of [quote, booking, cancel, payment]) {
      expect(responseSchema(operation, "400")?.$ref).toMatch(/ErrorEnvelopeDto$/);
      expect(responseSchema(operation, "401")?.$ref).toMatch(/ErrorEnvelopeDto$/);
      expect(responseSchema(operation, "403")?.$ref).toMatch(/ErrorEnvelopeDto$/);
      expect(responseSchema(operation, "503")?.$ref).toMatch(/ErrorEnvelopeDto$/);
    }
  });

  it("excludes mock payment from production registration and documents it only when enabled", async () => {
    const production = MockPaymentModule.forRoot({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://localhost:5432/stay_fable?sslmode=require",
      REDIS_URL: "rediss://localhost:6379",
      IDENTITY_PROVIDER: "code2session",
      ENABLE_MOCK_PAYMENT: "false",
    });
    const development = MockPaymentModule.forRoot({
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://localhost:5432/stay_fable",
      REDIS_URL: "redis://localhost:6379",
      IDENTITY_PROVIDER: "mock",
      ENABLE_MOCK_PAYMENT: "true",
    });
    expect(production.controllers).toEqual([]);
    expect(production.imports).toEqual([]);
    expect(development.controllers).toEqual([DevPaymentsController]);

    const productionDocument = await createRootDocument("production", false);
    expect(productionDocument.paths).not.toHaveProperty(
      "/api/v1/dev/payments/{bookingId}/simulate",
    );
    await app?.close();
    app = undefined;
    const developmentDocument = await createRootDocument("development", true);
    const developmentPayment =
      developmentDocument.paths["/api/v1/dev/payments/{bookingId}/simulate"]?.post;
    expect(developmentPayment).toBeDefined();
    expect(developmentPayment?.security).toEqual([{ session: [] }]);
  });

  it("keeps every booking-facing response schema free of internal ownership and inventory fields", async () => {
    const document = await createControllerDocument(true);
    const schemas = document.components?.schemas ?? {};
    const publicBookingSchemas = Object.fromEntries(
      Object.entries(schemas).filter(([name]) =>
        /Quote|Booking|Payment|Property|RoomType/.test(name),
      ),
    );
    const serialized = JSON.stringify(publicBookingSchemas);
    expect(serialized).not.toMatch(
      /user_id|userId|actor_user_id|hold_id|inventory_id|inventory_version|held_inventory|sold_inventory|total_inventory|internal_uuid/i,
    );
    expect(schemas.BookingDetailDto?.required).toEqual(
      expect.arrayContaining([
        "booking_id",
        "nightly_prices",
        "latest_payment",
        "status_history",
        "allowed_actions",
      ]),
    );
    expect(schemas.BookingDetailDto?.properties?.allowed_actions?.items?.enum).toEqual([
      "CANCEL",
      "MOCK_PAY_SUCCESS",
      "MOCK_PAY_FAILURE",
    ]);
  });

  it("keeps the OpenAPI field and nested-reference graph equal to the runtime WeChat contract", async () => {
    const document = await createRootDocument("development", true);
    const schemas = document.components?.schemas ?? {};
    const publicSuccessSchemas: Array<[string, Schema | undefined]> = [
      ["login-201", responseSchema(document.paths["/api/v1/auth/wechat/login"]?.post, "201")],
      ["refresh-201", responseSchema(document.paths["/api/v1/auth/session/refresh"]?.post, "201")],
      ["location-200", responseSchema(document.paths["/api/v1/location/resolve"]?.post, "200")],
      ["property-list-200", responseSchema(document.paths["/api/v1/properties"]?.get, "200")],
      [
        "property-detail-200",
        responseSchema(document.paths["/api/v1/properties/{propertyId}"]?.get, "200"),
      ],
      [
        "room-detail-200",
        responseSchema(document.paths["/api/v1/room-types/{roomTypeId}"]?.get, "200"),
      ],
      ["quote-201", responseSchema(document.paths["/api/v1/quotes"]?.post, "201")],
      ["booking-200", responseSchema(document.paths["/api/v1/bookings"]?.post, "200")],
      ["booking-201", responseSchema(document.paths["/api/v1/bookings"]?.post, "201")],
      ["booking-list-200", responseSchema(document.paths["/api/v1/bookings"]?.get, "200")],
      [
        "booking-detail-200",
        responseSchema(document.paths["/api/v1/bookings/{bookingId}"]?.get, "200"),
      ],
      [
        "cancel-200",
        responseSchema(document.paths["/api/v1/bookings/{bookingId}/cancel"]?.post, "200"),
      ],
      [
        "dev-payment-200",
        responseSchema(document.paths["/api/v1/dev/payments/{bookingId}/simulate"]?.post, "200"),
      ],
      [
        "dev-payment-201",
        responseSchema(document.paths["/api/v1/dev/payments/{bookingId}/simulate"]?.post, "201"),
      ],
    ];
    const visited = assertContractSchemaGraph(publicSuccessSchemas, schemas, WX_CONTRACT_SHAPES);
    expect([...visited].sort()).toEqual(Object.keys(WX_CONTRACT_SHAPES).sort());
  });

  it("rejects a cyclic public schema graph on the active traversal path", () => {
    const recursiveShapes = {
      RecursiveDto: {
        fields: ["next"],
        edges: { next: { kind: "ref", target: "RecursiveDto" } },
      },
    } as const;
    const recursiveSchemas = {
      RecursiveDto: {
        type: "object",
        required: ["next"],
        properties: { next: { $ref: "#/components/schemas/RecursiveDto" } },
      },
    };
    expect(() =>
      assertContractSchemaGraph(
        [["recursive-root", { $ref: "#/components/schemas/RecursiveDto" }]],
        recursiveSchemas,
        recursiveShapes,
      ),
    ).toThrow("Cyclic public schema reference");
  });

  it("rejects swapped nested DTO edges and keeps the runtime contract immutable", async () => {
    expect(Object.isFrozen(WX_CONTRACT_SHAPES)).toBe(true);
    expect(Object.isFrozen(WX_CONTRACT_SHAPES.QuoteResponseDto)).toBe(true);
    expect(Object.isFrozen(WX_CONTRACT_SHAPES.QuoteResponseDto?.fields)).toBe(true);
    expect(Object.isFrozen(WX_CONTRACT_SHAPES.QuoteResponseDto?.edges)).toBe(true);

    const document = await createRootDocument("development", true);
    const quoteSchema = responseSchema(document.paths["/api/v1/quotes"]?.post, "201");
    const swappedShapes = {
      ...WX_CONTRACT_SHAPES,
      QuoteResponseDto: {
        ...WX_CONTRACT_SHAPES.QuoteResponseDto,
        edges: {
          ...WX_CONTRACT_SHAPES.QuoteResponseDto?.edges,
          property: { kind: "ref", target: "QuoteRoomTypeDto" },
          room_type: { kind: "ref", target: "QuotePropertyDto" },
        },
      },
    } as Readonly<Record<string, ContractShape>>;
    expect(() =>
      assertContractSchemaGraph(
        [["quote-201-swapped", quoteSchema]],
        document.components?.schemas ?? {},
        swappedShapes,
      ),
    ).toThrow();
  });
});

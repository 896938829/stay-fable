import type { INestApplication } from "@nestjs/common";
import { SwaggerModule } from "@nestjs/swagger";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OPEN_API_CONFIG } from "../src/application-configuration.js";
import { SessionAuthGuard } from "../src/identity/session-auth.guard.js";
import { LocationController } from "../src/location/location.controller.js";
import { LocationService } from "../src/location/location.service.js";

interface TestSchema {
  format?: string;
  items?: TestSchema;
  maximum?: number;
  minimum?: number;
  properties?: Record<string, TestSchema>;
  required?: string[];
  type?: string;
  $ref?: string;
}

interface TestDocument {
  paths: Record<
    string,
    {
      get?: {
        responses?: Record<string, { content?: { "application/json"?: { schema?: TestSchema } } }>;
        security?: Array<Record<string, string[]>>;
      };
      post?: {
        requestBody?: {
          content?: { "application/json"?: { schema?: TestSchema } };
        };
        responses?: Record<string, { content?: { "application/json"?: { schema?: TestSchema } } }>;
        security?: Array<Record<string, string[]>>;
      };
    }
  >;
  components?: {
    schemas?: Record<string, TestSchema>;
    securitySchemes?: Record<
      string,
      {
        bearerFormat?: string;
        scheme?: string;
        type?: string;
      }
    >;
  };
}

describe("LocationController OpenAPI", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("documents runtime request and envelope response schemas", async () => {
    const module = await Test.createTestingModule({
      controllers: [LocationController],
      providers: [
        {
          provide: LocationService,
          useValue: { listCities: vi.fn(), resolve: vi.fn() },
        },
      ],
    })
      .overrideGuard(SessionAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    await app.init();

    const document = SwaggerModule.createDocument(app, OPEN_API_CONFIG) as unknown as TestDocument;

    expect(
      document.paths["/cities"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema,
    ).toEqual({ $ref: "#/components/schemas/CitiesEnvelopeDto" });
    expect(
      document.paths["/location/resolve"]?.post?.responses?.["200"]?.content?.["application/json"]
        ?.schema,
    ).toEqual({ $ref: "#/components/schemas/ResolvedLocationEnvelopeDto" });
    expect(
      document.paths["/location/resolve"]?.post?.requestBody?.content?.["application/json"]?.schema,
    ).toEqual({ $ref: "#/components/schemas/ResolveLocationDto" });

    const schemas = document.components?.schemas;
    expect(schemas?.ResolveLocationDto?.required).toEqual(["longitude", "latitude"]);
    expect(schemas?.ResolveLocationDto?.properties?.longitude).toMatchObject({
      type: "number",
      minimum: -180,
      maximum: 180,
    });
    expect(schemas?.ResolveLocationDto?.properties?.latitude).toMatchObject({
      type: "number",
      minimum: -90,
      maximum: 90,
    });
    expect(schemas?.CitiesEnvelopeDto?.required).toEqual(["data", "request_id"]);
    expect(schemas?.CitiesEnvelopeDto?.properties?.data).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/CityResponseDto" },
    });
    expect(schemas?.CityResponseDto?.properties?.id?.format).toBe("uuid");
    expect(schemas?.ResolvedLocationResponseDto?.properties?.distance_meters).toMatchObject({
      type: "integer",
      minimum: 0,
    });
    expect(schemas?.ResolvedLocationEnvelopeDto?.required).toEqual(["data", "request_id"]);
    expect(document.components?.securitySchemes?.session).toEqual({
      type: "http",
      scheme: "bearer",
      bearerFormat: "opaque",
    });
    expect(document.paths["/cities"]?.get?.security).toEqual([{ session: [] }]);
    expect(document.paths["/location/resolve"]?.post?.security).toEqual([{ session: [] }]);
  });
});

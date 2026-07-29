import type { INestApplication } from "@nestjs/common";
import { SwaggerModule } from "@nestjs/swagger";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OPEN_API_CONFIG } from "../src/application-configuration.js";
import { CatalogController } from "../src/catalog/catalog.controller.js";
import { CatalogService } from "../src/catalog/catalog.service.js";
import { SessionAuthGuard } from "../src/identity/session-auth.guard.js";

interface TestSchema {
  default?: unknown;
  enum?: string[];
  format?: string;
  items?: TestSchema;
  maxLength?: number;
  maximum?: number;
  minLength?: number;
  minimum?: number;
  nullable?: boolean;
  properties?: Record<string, TestSchema>;
  required?: string[];
  type?: string;
  $ref?: string;
}

interface TestParameter {
  in?: string;
  name?: string;
  required?: boolean;
  schema?: TestSchema;
}

interface TestOperation {
  parameters?: TestParameter[];
  responses?: Record<string, { content?: { "application/json"?: { schema?: TestSchema } } }>;
  security?: Array<Record<string, string[]>>;
}

interface TestDocument {
  paths: Record<string, { get?: TestOperation }>;
  components?: {
    schemas?: Record<string, TestSchema>;
  };
}

const findParameter = (operation: TestOperation | undefined, name: string) =>
  operation?.parameters?.find((parameter) => parameter.name === name);

const responseSchema = (operation: TestOperation | undefined, status: string) =>
  operation?.responses?.[status]?.content?.["application/json"]?.schema;

describe("CatalogController OpenAPI", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  const createDocument = async () => {
    const module = await Test.createTestingModule({
      controllers: [CatalogController],
      providers: [
        {
          provide: CatalogService,
          useValue: {
            listProperties: vi.fn(),
            getProperty: vi.fn(),
            getRoomType: vi.fn(),
          },
        },
      ],
    })
      .overrideGuard(SessionAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    await app.init();

    return SwaggerModule.createDocument(app, OPEN_API_CONFIG) as unknown as TestDocument;
  };

  it("documents the three local paths, bearer security, and complete query constraints", async () => {
    const document = await createDocument();
    const list = document.paths["/properties"]?.get;
    const property = document.paths["/properties/{propertyId}"]?.get;
    const room = document.paths["/room-types/{roomTypeId}"]?.get;

    expect(Object.keys(document.paths).sort()).toEqual([
      "/properties",
      "/properties/{propertyId}",
      "/room-types/{roomTypeId}",
    ]);
    expect(list?.security).toEqual([{ session: [] }]);
    expect(property?.security).toEqual([{ session: [] }]);
    expect(room?.security).toEqual([{ session: [] }]);

    expect(findParameter(list, "city_id")).toMatchObject({
      in: "query",
      required: true,
      schema: { type: "string", format: "uuid" },
    });
    for (const name of ["checkin", "checkout"]) {
      expect(findParameter(list, name)).toMatchObject({
        in: "query",
        required: true,
        schema: { type: "string" },
      });
    }
    expect(findParameter(list, "guests")).toMatchObject({
      required: true,
      schema: { type: "integer", minimum: 1, maximum: 10 },
    });
    expect(findParameter(list, "property_type")).toMatchObject({
      required: false,
      schema: { type: "string", enum: ["HOTEL", "HOMESTAY", "FARM_STAY"] },
    });
    expect(findParameter(list, "page_size")).toMatchObject({
      required: false,
      schema: { type: "integer", minimum: 1, maximum: 20, default: 10 },
    });
    expect(findParameter(list, "cursor")).toMatchObject({
      required: false,
      schema: { type: "string", minLength: 1, maxLength: 256 },
    });

    expect(findParameter(property, "propertyId")).toMatchObject({
      in: "path",
      required: true,
      schema: { type: "string", format: "uuid" },
    });
    expect(findParameter(room, "roomTypeId")).toMatchObject({
      in: "path",
      required: true,
      schema: { type: "string", format: "uuid" },
    });
    for (const operation of [property, room]) {
      expect(operation?.parameters?.map(({ name }) => name)).toEqual(
        expect.arrayContaining(["checkin", "checkout", "guests"]),
      );
      expect(findParameter(operation, "guests")?.schema).toMatchObject({
        type: "integer",
        minimum: 1,
        maximum: 10,
      });
    }
  });

  it("documents success envelopes and every applicable safe error envelope", async () => {
    const document = await createDocument();
    const list = document.paths["/properties"]?.get;
    const property = document.paths["/properties/{propertyId}"]?.get;
    const room = document.paths["/room-types/{roomTypeId}"]?.get;

    expect(responseSchema(list, "200")).toEqual({
      $ref: "#/components/schemas/PropertyListEnvelopeDto",
    });
    expect(responseSchema(property, "200")).toEqual({
      $ref: "#/components/schemas/PropertyDetailEnvelopeDto",
    });
    expect(responseSchema(room, "200")).toEqual({
      $ref: "#/components/schemas/RoomTypeDetailEnvelopeDto",
    });
    for (const status of ["400", "401", "503"]) {
      expect(responseSchema(list, status)).toEqual({
        $ref: "#/components/schemas/ApiErrorEnvelopeDto",
      });
      expect(responseSchema(property, status)).toEqual({
        $ref: "#/components/schemas/ApiErrorEnvelopeDto",
      });
      expect(responseSchema(room, status)).toEqual({
        $ref: "#/components/schemas/ApiErrorEnvelopeDto",
      });
    }
    for (const operation of [list, property, room]) {
      expect(responseSchema(operation, "403")).toEqual({
        $ref: "#/components/schemas/ApiErrorEnvelopeDto",
      });
    }
    expect(responseSchema(property, "404")).toEqual({
      $ref: "#/components/schemas/ApiErrorEnvelopeDto",
    });
    expect(responseSchema(room, "404")).toEqual({
      $ref: "#/components/schemas/ApiErrorEnvelopeDto",
    });
    expect(responseSchema(room, "422")).toEqual({
      $ref: "#/components/schemas/ApiErrorEnvelopeDto",
    });
  });

  it("documents complete shared response shapes without operational inventory", async () => {
    const document = await createDocument();
    const schemas = document.components?.schemas;

    expect(schemas?.PropertyListEnvelopeDto?.required).toEqual(["data", "request_id"]);
    expect(schemas?.PropertyListResponseDto?.required).toEqual(["items", "next_cursor"]);
    expect(schemas?.PropertyListResponseDto?.properties?.next_cursor).toMatchObject({
      type: "string",
      nullable: true,
      minLength: 1,
      maxLength: 256,
    });
    expect(schemas?.PropertyListItemDto?.required).toEqual([
      "id",
      "type",
      "name",
      "city",
      "cover_url",
      "short_description",
      "facility_highlights",
      "from_nightly_price_cents",
      "currency",
      "available_room_type_count",
    ]);
    expect(schemas?.PropertyListItemDto?.properties?.id?.format).toBe("uuid");
    expect(schemas?.PropertyListItemDto?.properties?.currency?.enum).toEqual(["CNY"]);
    expect(schemas?.PropertyListItemDto?.properties?.from_nightly_price_cents).toMatchObject({
      type: "integer",
      minimum: 0,
    });
    expect(schemas?.PropertyListItemDto?.properties?.available_room_type_count).toMatchObject({
      type: "integer",
      minimum: 1,
    });
    expect(schemas?.PropertyListItemDto?.properties).not.toHaveProperty("room_types");
    expect(schemas?.PropertyListItemDto?.properties).not.toHaveProperty("rooms");
    expect(JSON.stringify(schemas?.PropertyListItemDto)).not.toMatch(/inventory/);

    expect(schemas?.PropertyDetailResponseDto?.required).toEqual([
      "id",
      "type",
      "name",
      "city",
      "address",
      "description",
      "policies",
      "cover_url",
      "media",
      "facilities",
      "room_types",
    ]);
    expect(schemas?.PropertyDetailResponseDto?.properties?.room_types).toMatchObject({
      type: "array",
      items: { $ref: "#/components/schemas/RoomTypeSummaryDto" },
    });
    expect(schemas?.NightlyPriceDto?.required).toEqual([
      "business_date",
      "sale_price_cents",
      "rack_price_cents",
      "currency",
    ]);
    expect(schemas?.NightlyPriceDto?.properties?.sale_price_cents).toMatchObject({
      type: "integer",
      minimum: 0,
    });
    expect(schemas?.RoomTypeDetailResponseDto?.required).toEqual([
      "id",
      "name",
      "bed_type",
      "area_sqm",
      "max_guests",
      "cover_url",
      "currency",
      "property",
      "description",
      "booking_policy",
      "nightly_prices",
    ]);
    expect(schemas?.RoomTypeDetailResponseDto?.properties?.nightly_prices).toMatchObject({
      type: "array",
      items: { $ref: "#/components/schemas/NightlyPriceDto" },
    });
    expect(JSON.stringify(schemas?.RoomTypeDetailResponseDto)).not.toMatch(/inventory|held|sold/);
    expect(schemas?.ApiErrorEnvelopeDto?.required).toEqual(["error", "request_id"]);
    expect(schemas?.ApiErrorDto?.required).toEqual(["code", "message"]);
  });
});

import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthController } from "../src/identity/auth.controller.js";
import { AuthService } from "../src/identity/auth.service.js";

interface TestSchema {
  format?: string;
  properties?: Record<string, TestSchema>;
  required?: string[];
  type?: string;
  $ref?: string;
}

interface TestDocument {
  paths: Record<
    string,
    {
      post?: {
        security?: Array<Record<string, string[]>>;
        responses?: Record<
          string,
          {
            content?: {
              "application/json"?: {
                schema?: TestSchema;
              };
            };
          }
        >;
      };
    }
  >;
  components?: {
    schemas?: Record<string, TestSchema>;
  };
}

describe("AuthController OpenAPI", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("documents both 201 responses as the complete global auth envelope", async () => {
    const module = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: {
            login: vi.fn(),
            refresh: vi.fn(),
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();

    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("test").setVersion("test").build(),
    ) as unknown as TestDocument;

    for (const path of ["/auth/wechat/login", "/auth/session/refresh"]) {
      expect(document.paths[path]?.post?.security).toBeUndefined();
      expect(
        document.paths[path]?.post?.responses?.["201"]?.content?.["application/json"]?.schema,
      ).toEqual({ $ref: "#/components/schemas/AuthSessionEnvelopeDto" });
    }

    const schemas = document.components?.schemas;
    expect(schemas?.AuthSessionEnvelopeDto?.required).toEqual(["data", "request_id"]);
    expect(schemas?.AuthSessionEnvelopeDto?.properties?.data).toEqual({
      $ref: "#/components/schemas/AuthSessionResponseDto",
    });
    expect(schemas?.AuthSessionResponseDto?.required).toEqual([
      "access_token",
      "access_expires_in",
      "refresh_token",
      "refresh_expires_in",
      "user",
    ]);
    expect(schemas?.AuthSessionResponseDto?.properties?.user).toEqual({
      $ref: "#/components/schemas/AuthSessionUserDto",
    });
    expect(schemas?.AuthSessionResponseDto?.properties?.access_expires_in?.type).toBe("integer");
    expect(schemas?.AuthSessionResponseDto?.properties?.refresh_expires_in?.type).toBe("integer");
    expect(schemas?.AuthSessionUserDto?.required).toEqual(["id"]);
    expect(schemas?.AuthSessionUserDto?.properties?.id?.format).toBe("uuid");
  });
});

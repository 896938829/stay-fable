import { Body, Controller, Get, type INestApplication, Post } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Expose } from "class-transformer";
import { IsString } from "class-validator";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { configureApplication } from "../src/application-configuration.js";

class SmokeRequest {
  @Expose()
  @IsString()
  name!: string;
}

@Controller("health")
class HealthProbeController {
  @Get("live")
  live() {
    return { status: "ok", service: "api-server" };
  }

  @Get("ready")
  ready() {
    return { status: "ok", service: "api-server" };
  }
}

@Controller("smoke")
class SmokeController {
  @Post()
  create(@Body() body: SmokeRequest) {
    return {
      transformed: body instanceof SmokeRequest,
      name: body.name,
    };
  }
}

describe("API bootstrap configuration", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("enables runtime validation and transformation without opening a port", async () => {
    const module = await Test.createTestingModule({
      controllers: [HealthProbeController, SmokeController],
    }).compile();

    app = module.createNestApplication();
    configureApplication(app, "production");
    await app.init();

    const server = app.getHttpServer() as Parameters<typeof request>[0];

    await request(server)
      .post("/api/v1/smoke")
      .send({ name: "Fable", unexpected: true })
      .expect(400);

    const response = await request(server)
      .post("/api/v1/smoke")
      .send({ name: "Fable" })
      .expect(201);

    expect(response.body).toEqual({
      data: {
        transformed: true,
        name: "Fable",
      },
      request_id: response.headers["x-request-id"],
    });
    expect(response.headers["x-request-id"]).toMatch(/^req_[a-f0-9]{32}$/);

    await request(server)
      .get("/health/live")
      .expect(200)
      .expect({ status: "ok", service: "api-server" });
    await request(server)
      .get("/health/ready")
      .expect(200)
      .expect({ status: "ok", service: "api-server" });
    await request(server).get("/api/v1/health/live").expect(404);
    await request(server).get("/api/v1/health/ready").expect(404);
  });
});

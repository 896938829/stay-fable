import { Controller, Get, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { configureApplication } from "../src/application-configuration.js";
import { BusinessException } from "../src/common/http/business.exception.js";

@Controller("contract-probe")
class ContractProbeController {
  @Get("ok")
  ok() {
    return { value: 1 };
  }

  @Get("bad")
  bad(): never {
    throw new BusinessException(400, "CITY_NOT_SUPPORTED", "当前城市暂未开通");
  }
}

describe("API response contract", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  const createApp = async () => {
    const module = await Test.createTestingModule({
      controllers: [ContractProbeController],
    }).compile();

    app = module.createNestApplication();
    configureApplication(app, "production");
    await app.init();

    return app;
  };

  it("wraps successful responses and preserves a valid request id", async () => {
    const runningApp = await createApp();
    const response = await request(runningApp.getHttpServer() as Parameters<typeof request>[0])
      .get("/api/v1/contract-probe/ok")
      .set("x-request-id", "req_test_123")
      .expect(200);

    expect(response.headers["x-request-id"]).toBe("req_test_123");
    expect(response.body).toEqual({
      data: { value: 1 },
      request_id: "req_test_123",
    });
  });

  it("returns stable business errors without implementation details", async () => {
    const runningApp = await createApp();
    const response = await request(runningApp.getHttpServer() as Parameters<typeof request>[0])
      .get("/api/v1/contract-probe/bad")
      .set("x-request-id", "req_test_456")
      .expect(400);

    expect(response.headers["x-request-id"]).toBe("req_test_456");
    expect(response.body).toEqual({
      error: {
        code: "CITY_NOT_SUPPORTED",
        message: "当前城市暂未开通",
      },
      request_id: "req_test_456",
    });
    expect(response.body).not.toHaveProperty("stack");
  });

  it("replaces invalid request ids with a generated stable id", async () => {
    const runningApp = await createApp();
    const response = await request(runningApp.getHttpServer() as Parameters<typeof request>[0])
      .get("/api/v1/contract-probe/ok")
      .set("x-request-id", "bad id")
      .expect(200);

    expect(response.headers["x-request-id"]).toMatch(/^req_[a-f0-9]{32}$/);
    expect(response.body).toEqual({
      data: { value: 1 },
      request_id: response.headers["x-request-id"],
    });
  });
});

import {
  Controller,
  Get,
  HttpException,
  type INestApplication,
  Logger,
  Post,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

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

  @Get("http-error")
  httpError(): never {
    throw new HttpException("rate limiter implementation detail", 429);
  }

  @Get("unknown-error")
  unknownError(): never {
    throw new Error("database connection failed");
  }

  @Post("bad-request")
  badRequest(): never {
    throw new HttpException("other route validation detail", 400);
  }
}

describe("API response contract", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
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

  it("generates a request id when the header is missing", async () => {
    const runningApp = await createApp();
    const response = await request(runningApp.getHttpServer() as Parameters<typeof request>[0])
      .get("/api/v1/contract-probe/ok")
      .expect(200);

    expect(response.headers["x-request-id"]).toMatch(/^req_[a-f0-9]{32}$/);
    expect(response.body).toEqual({
      data: { value: 1 },
      request_id: response.headers["x-request-id"],
    });
  });

  it("sanitizes ordinary HTTP exceptions", async () => {
    const runningApp = await createApp();
    const response = await request(runningApp.getHttpServer() as Parameters<typeof request>[0])
      .get("/api/v1/contract-probe/http-error")
      .set("x-request-id", "req_http_123")
      .expect(429);

    expect(response.body).toEqual({
      error: {
        code: "TOO_MANY_REQUESTS",
        message: "请求处理失败",
      },
      request_id: "req_http_123",
    });
  });

  it("keeps ordinary POST 400 errors unchanged outside the exact quote route", async () => {
    const runningApp = await createApp();
    const response = await request(runningApp.getHttpServer() as Parameters<typeof request>[0])
      .post("/api/v1/contract-probe/bad-request")
      .set("x-request-id", "req_other_400")
      .expect(400);

    expect(response.body).toEqual({
      error: {
        code: "BAD_REQUEST",
        message: "请求处理失败",
      },
      request_id: "req_other_400",
    });
  });

  it("logs unknown exception roots while returning a sanitized response", async () => {
    const errorSpy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const runningApp = await createApp();
    const response = await request(runningApp.getHttpServer() as Parameters<typeof request>[0])
      .get("/api/v1/contract-probe/unknown-error")
      .set("x-request-id", "req_error_123")
      .set("authorization", "Bearer secret-token")
      .expect(500);

    expect(response.body).toEqual({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "服务暂时不可用",
      },
      request_id: "req_error_123",
    });
    expect(errorSpy).toHaveBeenCalledWith({
      request_id: "req_error_123",
      error: {
        name: "Error",
        message: "database connection failed",
        stack: expect.stringContaining("database connection failed") as unknown,
      },
    });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("secret-token");
  });
});

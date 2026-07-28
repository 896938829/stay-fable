import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configureApplication } from "../src/application-configuration.js";
import { AuthController } from "../src/identity/auth.controller.js";
import { AuthService } from "../src/identity/auth.service.js";

const session = {
  access_token: "a".repeat(32),
  access_expires_in: 120,
  refresh_token: "r".repeat(32),
  refresh_expires_in: 600,
  user: { id: "018f47b6-0f58-7f52-8a35-3f92a6f34762" },
};

describe("AuthController", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  const createApp = async () => {
    const auth = {
      login: vi.fn(() => Promise.resolve(session)),
      refresh: vi.fn(() => Promise.resolve(session)),
    };
    const module = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: auth }],
    }).compile();
    app = module.createNestApplication();
    configureApplication(app, "production");
    await app.init();
    return { auth, server: app.getHttpServer() as Parameters<typeof request>[0] };
  };

  it("logs in with a contract-valid WeChat code", async () => {
    const { auth, server } = await createApp();

    const response = await request(server)
      .post("/api/v1/auth/wechat/login")
      .send({ code: "mock:abc" })
      .expect(201);

    expect((response.body as { data: unknown }).data).toEqual(session);
    expect(auth.login).toHaveBeenCalledWith("mock:abc");
  });

  it("rejects login codes outside the contract boundary", async () => {
    const { auth, server } = await createApp();

    await request(server).post("/api/v1/auth/wechat/login").send({ code: "short" }).expect(400);

    expect(auth.login).not.toHaveBeenCalled();
  });

  it("rotates a contract-valid refresh token", async () => {
    const { auth, server } = await createApp();
    const refreshToken = "r".repeat(32);

    const response = await request(server)
      .post("/api/v1/auth/session/refresh")
      .send({ refresh_token: refreshToken })
      .expect(201);

    expect((response.body as { data: unknown }).data).toEqual(session);
    expect(auth.refresh).toHaveBeenCalledWith(refreshToken);
  });
});

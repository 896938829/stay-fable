import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, it } from "vitest";

import { HealthController } from "../src/health/health.controller.js";
import { HealthService } from "../src/health/health.service.js";

describe("HealthController", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("reports that the API process is live", async () => {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthService,
          useValue: {
            live: () => ({ status: "ok", service: "api-server" }),
          },
        },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();

    await request(app.getHttpServer() as Parameters<typeof request>[0])
      .get("/health/live")
      .expect(200)
      .expect({ status: "ok", service: "api-server" });
  });

  it("returns 503 with normalized dependency checks and remains live", async () => {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthService,
          useValue: {
            live: () => ({ status: "ok", service: "api-server" }),
            ready: () =>
              Promise.resolve({
                status: "unavailable",
                service: "api-server",
                checks: { database: "down", redis: "down" },
              }),
          },
        },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
    const server = app.getHttpServer() as Parameters<typeof request>[0];

    await request(server)
      .get("/health/ready")
      .expect(503)
      .expect({
        status: "unavailable",
        service: "api-server",
        checks: { database: "down", redis: "down" },
      });
    await request(server)
      .get("/health/live")
      .expect(200)
      .expect({ status: "ok", service: "api-server" });
  });
});

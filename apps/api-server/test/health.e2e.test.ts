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
});

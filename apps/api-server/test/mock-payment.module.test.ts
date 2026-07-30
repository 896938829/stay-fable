import { ConfigModule } from "@nestjs/config";
import { Test, type TestingModule } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";

import { DevPaymentsController } from "../src/booking/dev-payments.controller.js";
import { MockPaymentModule } from "../src/booking/mock-payment.module.js";
import { validateRuntimeConfig } from "../src/config/runtime-config.js";
import { DatabaseService } from "../src/database/database.service.js";
import { REDIS_CLIENT } from "../src/infrastructure/redis/redis.service.js";

describe("MockPaymentModule dependency boundaries", () => {
  it("compiles the enabled controller with the real SessionAuthGuard", async () => {
    const environment = {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://localhost:5432/stay_fable_test",
      REDIS_URL: "redis://localhost:6379",
      IDENTITY_PROVIDER: "mock",
      ENABLE_MOCK_PAYMENT: "true",
    };
    const redis = {
      ping: vi.fn(() => Promise.resolve("PONG")),
      quit: vi.fn(() => Promise.resolve("OK")),
      get: vi.fn(() => Promise.resolve(null)),
      set: vi.fn(() => Promise.resolve("OK")),
      eval: vi.fn(() => Promise.resolve(null)),
      del: vi.fn(() => Promise.resolve(0)),
      pttl: vi.fn(() => Promise.resolve(1_000)),
    };
    let module: TestingModule | undefined;
    try {
      module = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            ignoreEnvFile: true,
            validate: () => validateRuntimeConfig(environment),
          }),
          MockPaymentModule.forRoot(environment),
        ],
      })
        .overrideProvider(DatabaseService)
        .useValue({})
        .overrideProvider(REDIS_CLIENT)
        .useValue(redis)
        .compile();

      expect(module.get(DevPaymentsController)).toBeInstanceOf(DevPaymentsController);
    } finally {
      await module?.close();
    }
  });
});

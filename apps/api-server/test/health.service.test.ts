import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabaseService } from "../src/database/database.service.js";
import { HealthService } from "../src/health/health.service.js";

const redisMock = vi.hoisted(() => ({
  status: "end",
  quit: vi.fn(() => Promise.resolve("OK")),
}));

vi.mock("ioredis", () => ({
  Redis: class {
    get status(): string {
      return redisMock.status;
    }

    quit = redisMock.quit;
  },
}));

describe("HealthService shutdown", () => {
  beforeEach(() => {
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    redisMock.status = "end";
    redisMock.quit.mockClear();
  });

  it("does not quit an already closed Redis client", async () => {
    const service = new HealthService({} as DatabaseService);

    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    expect(redisMock.quit).not.toHaveBeenCalled();
  });

  it("quits an active Redis client once", async () => {
    redisMock.status = "ready";
    const service = new HealthService({} as DatabaseService);

    await service.onModuleDestroy();

    expect(redisMock.quit).toHaveBeenCalledOnce();
  });
});

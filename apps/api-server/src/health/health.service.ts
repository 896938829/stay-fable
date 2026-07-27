import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { HealthResponse } from "@stay-fable/api-contracts/health";
import { Redis } from "ioredis";

import { DatabaseService } from "../database/database.service.js";

const requireRedisUrl = (): string => {
  const redisUrl = process.env.REDIS_URL;

  if (redisUrl === undefined || redisUrl.length === 0) {
    throw new Error("REDIS_URL is required");
  }

  return redisUrl;
};

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly redis = new Redis(requireRedisUrl(), {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
  });

  constructor(private readonly database: DatabaseService) {}

  live(): HealthResponse {
    return {
      status: "ok",
      service: "api-server",
    };
  }

  async ready(): Promise<HealthResponse> {
    await this.database.check();

    if (this.redis.status === "wait") {
      await this.redis.connect();
    }

    await this.redis.ping();

    return {
      status: "ok",
      service: "api-server",
      checks: {
        database: "up",
        redis: "up",
      },
    };
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis.status !== "end") {
      await this.redis.quit();
    }
  }
}

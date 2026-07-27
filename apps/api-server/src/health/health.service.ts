import { Injectable } from "@nestjs/common";
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
export class HealthService {
  constructor(private readonly database: DatabaseService) {}

  live(): HealthResponse {
    return {
      status: "ok",
      service: "api-server",
    };
  }

  async ready(): Promise<HealthResponse> {
    const checks: Record<"database" | "redis", "up" | "down"> = {
      database: "down",
      redis: "down",
    };

    try {
      await this.database.check();
      checks.database = "up";
    } catch {
      checks.database = "down";
    }

    let redis: Redis | undefined;
    try {
      redis = new Redis(requireRedisUrl(), {
        commandTimeout: 1_000,
        connectTimeout: 1_000,
        enableOfflineQueue: false,
        lazyConnect: true,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
      });
      redis.on("error", () => undefined);
      await redis.connect();
      await redis.ping();
      checks.redis = "up";
    } catch {
      checks.redis = "down";
    } finally {
      redis?.disconnect();
    }

    return {
      status: checks.database === "up" && checks.redis === "up" ? "ok" : "unavailable",
      service: "api-server",
      checks,
    };
  }
}

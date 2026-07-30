import { createHash } from "node:crypto";

import { Injectable } from "@nestjs/common";

import { BusinessException } from "../http/business.exception.js";
import { RedisService } from "../../infrastructure/redis/redis.service.js";

const WINDOW_MILLISECONDS = 60_000;
const USER_ID_MAX_LENGTH = 128;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type WriteScope = "quotes" | "bookings";

interface RateLimitConfig {
  scope: WriteScope;
  limit: number;
  digestPrefix?: string;
}

const QUOTE_RATE_LIMIT: RateLimitConfig = { scope: "quotes", limit: 30 };
const BOOKING_RATE_LIMIT: RateLimitConfig = { scope: "bookings", limit: 10 };
const BOOKING_CANCELLATION_RATE_LIMIT: RateLimitConfig = {
  scope: "bookings",
  limit: 6,
  digestPrefix: "booking-cancellation\u0000",
};

const unavailable = (): BusinessException =>
  new BusinessException(503, "BOOKING_SERVICE_UNAVAILABLE", "预订服务暂时不可用，请稍后重试");

const rateLimited = (ttlMilliseconds: number): BusinessException =>
  new BusinessException(429, "RATE_LIMITED", "操作过于频繁，请稍后重试", {
    retry_after_seconds: Math.min(60, Math.max(1, Math.ceil(ttlMilliseconds / 1000))),
  });

const isUserId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= USER_ID_MAX_LENGTH &&
  UUID_PATTERN.test(value);

interface RateLimitResult {
  count: number;
  ttlMilliseconds: number;
}

const parseRateLimitResult = (value: unknown): RateLimitResult | null => {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }

    const { count, ttlMilliseconds } = value as { count?: unknown; ttlMilliseconds?: unknown };
    if (
      typeof count === "number" &&
      Number.isSafeInteger(count) &&
      count > 0 &&
      typeof ttlMilliseconds === "number" &&
      Number.isSafeInteger(ttlMilliseconds) &&
      ttlMilliseconds > 0 &&
      ttlMilliseconds <= WINDOW_MILLISECONDS
    ) {
      return { count, ttlMilliseconds };
    }
    return null;
  } catch {
    return null;
  }
};

@Injectable()
export class WriteRateLimitService {
  constructor(private readonly redis: RedisService) {}

  async checkQuotes(userId: string): Promise<void> {
    await this.check(userId, QUOTE_RATE_LIMIT);
  }

  async checkBookings(userId: string): Promise<void> {
    await this.check(userId, BOOKING_RATE_LIMIT);
  }

  async checkBookingCancellation(userId: string): Promise<void> {
    await this.check(userId, BOOKING_CANCELLATION_RATE_LIMIT);
  }

  private async check(userId: string, config: RateLimitConfig): Promise<void> {
    if (!isUserId(userId)) {
      throw unavailable();
    }

    let result: unknown;
    try {
      const userHash = createHash("sha256")
        .update(config.digestPrefix ?? "")
        .update(userId)
        .digest("hex");
      result = await this.redis.executeRateLimit(
        `rate-limit:${config.scope}:${userHash}`,
        config.limit,
        WINDOW_MILLISECONDS,
      );
    } catch {
      throw unavailable();
    }

    const snapshot = parseRateLimitResult(result);
    if (snapshot === null) {
      throw unavailable();
    }

    if (snapshot.count > config.limit) {
      throw rateLimited(snapshot.ttlMilliseconds);
    }
  }
}

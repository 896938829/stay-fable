import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

export const REDIS_CLIENT = Symbol("REDIS_CLIENT");

export interface RedisClient {
  ping: () => Promise<unknown>;
  quit: () => Promise<unknown>;
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, expiryMode: "EX", ttlSeconds: number) => Promise<unknown>;
  eval: (script: string, numberOfKeys: number, ...arguments_: string[]) => Promise<unknown>;
  del: (key: string) => Promise<unknown>;
  pttl: (key: string) => Promise<number>;
}

const CONSUME_JSON_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if value then
  redis.call('DEL', KEYS[1])
end
return value
`.trim();

const RATE_LIMIT_KEY_PATTERN = /^rate-limit:(quotes|bookings):[a-f0-9]{64}$/;

const parseStoredJson = <T>(value: string | null): T | null => {
  if (value === null) {
    return null;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error("Stored JSON is invalid");
  }
};

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private static readonly RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  local expirySet = redis.call('PEXPIRE', KEYS[1], ARGV[1])
  if expirySet ~= 1 then
    return { count, 0 }
  end
  ttl = redis.call('PTTL', KEYS[1])
end
return { count, ttl }
`.trim();

  constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisClient) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.redis.ping();
    } catch {
      throw new Error("Redis initialization failed");
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      throw new Error("Redis shutdown failed");
    }
  }

  async getJson<T>(key: string): Promise<T | null> {
    let value: string | null;

    try {
      value = await this.redis.get(key);
    } catch {
      throw new Error("Redis operation failed");
    }

    return parseStoredJson<T>(value);
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    let serializedValue: string;

    try {
      serializedValue = JSON.stringify(value);
    } catch {
      throw new Error("Value cannot be serialized");
    }

    if (typeof serializedValue !== "string") {
      throw new Error("Value cannot be serialized");
    }

    try {
      await this.redis.set(key, serializedValue, "EX", ttlSeconds);
    } catch {
      throw new Error("Redis operation failed");
    }
  }

  async consumeJson<T>(key: string): Promise<T | null> {
    let value: unknown;

    try {
      value = await this.redis.eval(CONSUME_JSON_SCRIPT, 1, key);
    } catch {
      throw new Error("Redis operation failed");
    }

    if (value !== null && typeof value !== "string") {
      throw new Error("Stored JSON is invalid");
    }

    return parseStoredJson<T>(value);
  }

  async executeSessionScript(
    script: string,
    keys: string[],
    arguments_: string[],
  ): Promise<string> {
    try {
      const result = await this.redis.eval(script, keys.length, ...keys, ...arguments_);
      if (typeof result !== "string") {
        throw new Error("Invalid session script result");
      }
      return result;
    } catch {
      throw new Error("Redis session script failed");
    }
  }

  async executeRateLimit(
    key: string,
    limit: number,
    windowMilliseconds: number,
  ): Promise<{ count: number; ttlMilliseconds: number }> {
    try {
      if (
        typeof key !== "string" ||
        !RATE_LIMIT_KEY_PATTERN.test(key) ||
        !Number.isSafeInteger(limit) ||
        limit <= 0 ||
        !Number.isSafeInteger(windowMilliseconds) ||
        windowMilliseconds <= 0
      ) {
        throw new Error("Invalid rate limit input");
      }

      const result = await this.redis.eval(
        RedisService.RATE_LIMIT_SCRIPT,
        1,
        key,
        String(windowMilliseconds),
      );
      if (!Array.isArray(result)) {
        throw new Error("Invalid rate limit result");
      }

      const length = result.length;
      if (length !== 2) {
        throw new Error("Invalid rate limit result");
      }

      const count: unknown = result[0];
      const ttlMilliseconds: unknown = result[1];
      if (
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count <= 0 ||
        typeof ttlMilliseconds !== "number" ||
        !Number.isSafeInteger(ttlMilliseconds) ||
        ttlMilliseconds <= 0 ||
        ttlMilliseconds > windowMilliseconds
      ) {
        throw new Error("Invalid rate limit result");
      }

      return { count, ttlMilliseconds };
    } catch {
      throw new Error("Redis rate limit failed");
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch {
      throw new Error("Redis operation failed");
    }
  }

  async ttlMilliseconds(key: string): Promise<number> {
    try {
      return await this.redis.pttl(key);
    } catch {
      throw new Error("Redis operation failed");
    }
  }
}

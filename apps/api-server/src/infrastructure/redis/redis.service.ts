import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

export const REDIS_CLIENT = Symbol("REDIS_CLIENT");

export interface RedisClient {
  ping: () => Promise<unknown>;
  quit: () => Promise<unknown>;
  get: (key: string) => Promise<string | null>;
  set: (
    key: string,
    value: string,
    expiryMode: "EX",
    ttlSeconds: number,
  ) => Promise<unknown>;
  eval: (script: string, numberOfKeys: number, key: string) => Promise<unknown>;
  del: (key: string) => Promise<unknown>;
}

const CONSUME_JSON_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if value then
  redis.call('DEL', KEYS[1])
end
return value
`.trim();

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

  async delete(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch {
      throw new Error("Redis operation failed");
    }
  }
}

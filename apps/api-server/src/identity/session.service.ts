import { createHash, randomBytes } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AuthSession } from "@stay-fable/api-contracts/auth";

import { CLOCK, type Clock } from "../common/clock/clock.js";
import { BusinessException } from "../common/http/business.exception.js";
import { RedisService } from "../infrastructure/redis/redis.service.js";

export const TOKEN_GENERATOR = Symbol("TOKEN_GENERATOR");

export interface TokenGenerator {
  generate(): string;
}

export const randomTokenGenerator: TokenGenerator = {
  generate: () => randomBytes(32).toString("base64url"),
};

interface StoredSessionBase {
  userId: string;
  familyId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface StoredAccessSession extends StoredSessionBase {
  kind: "access";
}

export interface StoredRefreshSession extends StoredSessionBase {
  kind: "refresh";
  accessKey: string;
}

export type StoredSession = StoredAccessSession | StoredRefreshSession;

const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");
const accessKey = (token: string): string => `session:access:${tokenHash(token)}`;
const refreshKey = (token: string): string => `session:refresh:${tokenHash(token)}`;

const refreshRejected = (): BusinessException =>
  new BusinessException(401, "AUTH_REFRESH_REJECTED", "刷新凭证无效或已过期");
const accessExpired = (): BusinessException =>
  new BusinessException(401, "AUTH_SESSION_EXPIRED", "登录状态已过期，请重新登录");

const hasBaseFields = (value: unknown): value is StoredSessionBase => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<StoredSessionBase>;
  return (
    typeof candidate.userId === "string" &&
    typeof candidate.familyId === "string" &&
    typeof candidate.issuedAt === "number" &&
    typeof candidate.expiresAt === "number"
  );
};

@Injectable()
export class SessionService {
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
    @Inject(TOKEN_GENERATOR) private readonly tokenGenerator: TokenGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.accessTtlSeconds = config.getOrThrow<number>("SESSION_ACCESS_TTL_SECONDS");
    this.refreshTtlSeconds = config.getOrThrow<number>("SESSION_REFRESH_TTL_SECONDS");
  }

  async issue(userId: string, familyId?: string): Promise<AuthSession> {
    const accessToken = this.tokenGenerator.generate();
    const refreshToken = this.tokenGenerator.generate();
    const createdFamilyId = familyId ?? tokenHash(refreshToken);
    const issuedAt = this.clock.now().getTime();
    const storedAccessKey = accessKey(accessToken);
    const storedRefreshKey = refreshKey(refreshToken);
    const accessRecord: StoredAccessSession = {
      kind: "access",
      userId,
      familyId: createdFamilyId,
      issuedAt,
      expiresAt: issuedAt + this.accessTtlSeconds * 1000,
    };
    const refreshRecord: StoredRefreshSession = {
      kind: "refresh",
      userId,
      familyId: createdFamilyId,
      issuedAt,
      expiresAt: issuedAt + this.refreshTtlSeconds * 1000,
      accessKey: storedAccessKey,
    };

    await this.redis.setJson(storedAccessKey, accessRecord, this.accessTtlSeconds);
    try {
      await this.redis.setJson(storedRefreshKey, refreshRecord, this.refreshTtlSeconds);
    } catch (error) {
      try {
        await this.redis.delete(storedAccessKey);
      } catch {
        // Best-effort rollback; preserve the original write failure.
      }
      throw error;
    }

    return {
      access_token: accessToken,
      access_expires_in: this.accessTtlSeconds,
      refresh_token: refreshToken,
      refresh_expires_in: this.refreshTtlSeconds,
      user: { id: userId },
    };
  }

  async refresh(token: string): Promise<AuthSession> {
    try {
      const record = await this.redis.consumeJson<unknown>(refreshKey(token));
      if (
        !hasBaseFields(record) ||
        (record as { kind?: unknown }).kind !== "refresh" ||
        typeof (record as { accessKey?: unknown }).accessKey !== "string" ||
        record.expiresAt <= this.clock.now().getTime()
      ) {
        throw refreshRejected();
      }

      const refreshRecord = record as StoredRefreshSession;
      await this.redis.delete(refreshRecord.accessKey);
      return await this.issue(refreshRecord.userId, refreshRecord.familyId);
    } catch {
      throw refreshRejected();
    }
  }

  async resolveAccess(token: string): Promise<{ userId: string }> {
    const key = accessKey(token);
    try {
      const record = await this.redis.getJson<unknown>(key);
      if (
        !hasBaseFields(record) ||
        (record as { kind?: unknown }).kind !== "access" ||
        record.expiresAt <= this.clock.now().getTime()
      ) {
        try {
          await this.redis.delete(key);
        } catch {
          // Authentication failure remains stable even if cleanup fails.
        }
        throw accessExpired();
      }

      return { userId: record.userId };
    } catch (error) {
      if (error instanceof BusinessException) {
        throw error;
      }
      throw accessExpired();
    }
  }
}

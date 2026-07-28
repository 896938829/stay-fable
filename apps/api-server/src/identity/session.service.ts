import { createHash, randomBytes } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AuthSession } from "@stay-fable/api-contracts/auth";

import { CLOCK, type Clock } from "../common/clock/clock.js";
import { BusinessException } from "../common/http/business.exception.js";
import { RedisService } from "../infrastructure/redis/redis.service.js";
import {
  INSPECT_REFRESH_SCRIPT,
  ISSUE_SESSION_SCRIPT,
  REVOKE_FAMILY_BY_ID_SCRIPT,
  REVOKE_FAMILY_SCRIPT,
  ROTATE_SESSION_SCRIPT,
} from "./session-scripts.js";

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

export interface StoredFamilySession extends StoredSessionBase {
  kind: "family";
  accessKey: string;
  refreshKey: string;
}

export interface UsedRefreshTombstone {
  kind: "used-refresh";
  userId: string;
  familyId: string;
}

export type StoredSession =
  StoredAccessSession | StoredRefreshSession | StoredFamilySession | UsedRefreshTombstone;

export interface RefreshInspection {
  userId: string;
  familyId: string;
}

const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");
const accessKey = (token: string): string => `session:access:${tokenHash(token)}`;
const refreshKey = (token: string): string => `session:refresh:${tokenHash(token)}`;
const usedRefreshKey = (token: string): string => `session:used-refresh:${tokenHash(token)}`;
const familyKey = (familyId: string): string => `session:family:${familyId}`;

const refreshRejected = (): BusinessException =>
  new BusinessException(401, "AUTH_REFRESH_REJECTED", "刷新凭证无效或已过期");
const accessExpired = (): BusinessException =>
  new BusinessException(401, "AUTH_SESSION_EXPIRED", "登录状态已过期，请重新登录");
const sessionUnavailable = (): BusinessException =>
  new BusinessException(503, "AUTH_SESSION_SERVICE_UNAVAILABLE", "登录服务暂时不可用，请稍后重试");

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

const isAccessRecord = (value: unknown): value is StoredAccessSession =>
  hasBaseFields(value) && (value as { kind?: unknown }).kind === "access";

const isRefreshRecord = (value: unknown): value is StoredRefreshSession =>
  hasBaseFields(value) &&
  (value as { kind?: unknown }).kind === "refresh" &&
  typeof (value as { accessKey?: unknown }).accessKey === "string";

const parseInspection = (result: string): StoredRefreshSession | null => {
  try {
    const parsed = JSON.parse(result) as { status?: unknown; record?: unknown };
    return parsed.status === "ACTIVE" && isRefreshRecord(parsed.record) ? parsed.record : null;
  } catch {
    return null;
  }
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

  async issue(userId: string): Promise<AuthSession> {
    const accessToken = this.tokenGenerator.generate();
    const refreshToken = this.tokenGenerator.generate();
    const createdFamilyId = tokenHash(refreshToken);
    const issuedAt = this.clock.now().getTime();
    const storedAccessKey = accessKey(accessToken);
    const storedRefreshKey = refreshKey(refreshToken);
    const expiresAt = issuedAt + this.refreshTtlSeconds * 1000;
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
      expiresAt,
      accessKey: storedAccessKey,
    };
    const familyRecord: StoredFamilySession = {
      kind: "family",
      userId,
      familyId: createdFamilyId,
      issuedAt,
      expiresAt,
      accessKey: storedAccessKey,
      refreshKey: storedRefreshKey,
    };

    try {
      const result = await this.redis.executeSessionScript(
        ISSUE_SESSION_SCRIPT,
        [storedAccessKey, storedRefreshKey, familyKey(createdFamilyId)],
        [
          JSON.stringify(accessRecord),
          JSON.stringify(refreshRecord),
          JSON.stringify(familyRecord),
          String(this.accessTtlSeconds * 1000),
          String(this.refreshTtlSeconds * 1000),
          String(issuedAt),
        ],
      );
      if (result !== "OK") {
        throw sessionUnavailable();
      }
    } catch {
      throw sessionUnavailable();
    }

    return this.response(accessToken, refreshToken, userId);
  }

  async inspectRefresh(token: string): Promise<RefreshInspection> {
    let result: string;
    try {
      result = await this.redis.executeSessionScript(
        INSPECT_REFRESH_SCRIPT,
        [refreshKey(token), usedRefreshKey(token)],
        [String(this.clock.now().getTime())],
      );
    } catch {
      throw sessionUnavailable();
    }

    const record = parseInspection(result);
    if (record === null) {
      throw refreshRejected();
    }
    return { userId: record.userId, familyId: record.familyId };
  }

  async refresh(token: string, inspected?: RefreshInspection): Promise<AuthSession> {
    // AuthService supplies an inspected active family. Without one we still execute the
    // rotation script so a used-refresh tombstone can atomically revoke its active family.
    const active = inspected ?? { userId: "", familyId: "" };
    const replayProbe = tokenHash(token);
    const newAccessToken =
      inspected === undefined ? `replay-access-${replayProbe}` : this.tokenGenerator.generate();
    const newRefreshToken =
      inspected === undefined ? `replay-refresh-${replayProbe}` : this.tokenGenerator.generate();
    const issuedAt = this.clock.now().getTime();
    const newAccessKey = accessKey(newAccessToken);
    const newRefreshKey = refreshKey(newRefreshToken);
    const accessRecord: StoredAccessSession = {
      kind: "access",
      userId: active.userId,
      familyId: active.familyId,
      issuedAt,
      expiresAt: issuedAt + this.accessTtlSeconds * 1000,
    };
    const refreshRecord: StoredRefreshSession = {
      kind: "refresh",
      userId: active.userId,
      familyId: active.familyId,
      issuedAt,
      expiresAt: issuedAt + this.refreshTtlSeconds * 1000,
      accessKey: newAccessKey,
    };
    const familyRecord: StoredFamilySession = {
      kind: "family",
      userId: active.userId,
      familyId: active.familyId,
      issuedAt,
      expiresAt: issuedAt + this.refreshTtlSeconds * 1000,
      accessKey: newAccessKey,
      refreshKey: newRefreshKey,
    };
    const tombstone: UsedRefreshTombstone = {
      kind: "used-refresh",
      userId: active.userId,
      familyId: active.familyId,
    };

    let result: string;
    try {
      result = await this.redis.executeSessionScript(
        ROTATE_SESSION_SCRIPT,
        [refreshKey(token), usedRefreshKey(token), newAccessKey, newRefreshKey],
        [
          String(issuedAt),
          JSON.stringify(accessRecord),
          JSON.stringify(refreshRecord),
          JSON.stringify(familyRecord),
          JSON.stringify(tombstone),
          String(this.accessTtlSeconds * 1000),
          String(this.refreshTtlSeconds * 1000),
        ],
      );
    } catch {
      throw sessionUnavailable();
    }

    if (result !== "OK") {
      throw refreshRejected();
    }
    return this.response(newAccessToken, newRefreshToken, active.userId);
  }

  async revokeFamilyByRefresh(token: string): Promise<void> {
    try {
      const result = await this.redis.executeSessionScript(
        REVOKE_FAMILY_SCRIPT,
        [refreshKey(token), usedRefreshKey(token)],
        [String(this.clock.now().getTime())],
      );
      if (result !== "REVOKED") {
        throw sessionUnavailable();
      }
    } catch {
      throw sessionUnavailable();
    }
  }

  async revokeFamily(familyId: string): Promise<void> {
    try {
      const result = await this.redis.executeSessionScript(
        REVOKE_FAMILY_BY_ID_SCRIPT,
        [familyKey(familyId)],
        [String(this.clock.now().getTime())],
      );
      if (result !== "REVOKED") {
        throw sessionUnavailable();
      }
    } catch {
      throw sessionUnavailable();
    }
  }

  async resolveAccess(token: string): Promise<{ userId: string; familyId: string }> {
    const key = accessKey(token);
    let record: unknown;
    try {
      record = await this.redis.getJson<unknown>(key);
    } catch {
      throw sessionUnavailable();
    }

    if (!isAccessRecord(record) || record.expiresAt <= this.clock.now().getTime()) {
      try {
        await this.redis.delete(key);
      } catch {
        // Cleanup is best effort; the authentication result remains expired.
      }
      throw accessExpired();
    }

    return { userId: record.userId, familyId: record.familyId };
  }

  private response(accessToken: string, refreshToken: string, userId: string): AuthSession {
    return {
      access_token: accessToken,
      access_expires_in: this.accessTtlSeconds,
      refresh_token: refreshToken,
      refresh_expires_in: this.refreshTtlSeconds,
      user: { id: userId },
    };
  }
}

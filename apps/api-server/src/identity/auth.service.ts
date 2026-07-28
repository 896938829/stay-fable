import { Inject, Injectable } from "@nestjs/common";
import type { AuthSession } from "@stay-fable/api-contracts/auth";

import { BusinessException } from "../common/http/business.exception.js";
import { DatabaseService } from "../database/database.service.js";
import { SessionService } from "./session.service.js";
import {
  WECHAT_IDENTITY_PROVIDER,
  type WechatIdentity,
  type WechatIdentityProvider,
} from "./wechat-identity.provider.js";

interface AuthUser {
  id: string;
  status: "ACTIVE" | "DISABLED";
  sessionVersion: number;
}

const identityLookup = (identity: WechatIdentity) => ({
  where: {
    provider_providerSubject: {
      provider: identity.provider,
      providerSubject: identity.subject,
    },
  },
  select: { user: { select: { id: true, status: true, sessionVersion: true } } },
});

const isUniqueConflict = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "P2002";

const requireEnabled = (user: AuthUser): AuthUser => {
  if (user.status === "DISABLED") {
    throw new BusinessException(403, "AUTH_USER_DISABLED", "账号已被停用");
  }
  return user;
};

const disabledUser = (): BusinessException =>
  new BusinessException(403, "AUTH_USER_DISABLED", "账号已被停用");
const refreshRejected = (): BusinessException =>
  new BusinessException(401, "AUTH_REFRESH_REJECTED", "刷新凭证无效或已过期");
const sessionUnavailable = (): BusinessException =>
  new BusinessException(503, "AUTH_SESSION_SERVICE_UNAVAILABLE", "登录服务暂时不可用，请稍后重试");

@Injectable()
export class AuthService {
  constructor(
    @Inject(WECHAT_IDENTITY_PROVIDER)
    private readonly identityProvider: WechatIdentityProvider,
    private readonly database: DatabaseService,
    private readonly sessions: SessionService,
  ) {}

  async login(code: string): Promise<AuthSession> {
    const identity = await this.identityProvider.exchange(code);
    let user: AuthUser;

    try {
      user = await this.database.$transaction(async (transaction) => {
        const existing = await transaction.userIdentity.findUnique(identityLookup(identity));
        if (existing !== null) {
          return existing.user;
        }

        return transaction.user.create({
          data: {
            identities: {
              create: {
                provider: identity.provider,
                providerSubject: identity.subject,
              },
            },
          },
          select: { id: true, status: true, sessionVersion: true },
        });
      });
    } catch (error) {
      if (!isUniqueConflict(error)) {
        throw error;
      }

      const winner = await this.database.userIdentity.findUnique(identityLookup(identity));
      if (winner === null) {
        throw error;
      }
      user = winner.user;
    }

    const enabledUser = requireEnabled(user);
    return this.sessions.issue(enabledUser.id, enabledUser.sessionVersion);
  }

  async refresh(refreshToken: string): Promise<AuthSession> {
    let inspected;
    try {
      inspected = await this.sessions.inspectRefresh(refreshToken);
    } catch (error) {
      if (
        error instanceof BusinessException &&
        error.getStatus() === 401 &&
        error.code === "AUTH_REFRESH_REJECTED"
      ) {
        return this.sessions.refresh(refreshToken);
      }
      throw error;
    }

    const before = await this.readSessionUser(inspected.userId);
    if (before === null || before.status === "DISABLED") {
      await this.sessions.revokeFamilyByRefresh(refreshToken);
      throw disabledUser();
    }
    if (before.sessionVersion !== inspected.sessionVersion) {
      await this.sessions.revokeFamilyByRefresh(refreshToken);
      throw refreshRejected();
    }

    const rotated = await this.sessions.refresh(refreshToken, inspected);
    let after: { status: "ACTIVE" | "DISABLED"; sessionVersion: number } | null;
    try {
      after = await this.readSessionUser(inspected.userId);
    } catch (error) {
      await this.sessions.revokeFamily(inspected.familyId);
      throw error;
    }
    if (after === null || after.status === "DISABLED") {
      await this.sessions.revokeFamily(inspected.familyId);
      throw disabledUser();
    }
    if (after.sessionVersion !== inspected.sessionVersion) {
      await this.sessions.revokeFamily(inspected.familyId);
      throw refreshRejected();
    }

    return rotated;
  }

  private async readSessionUser(
    userId: string,
  ): Promise<{ status: "ACTIVE" | "DISABLED"; sessionVersion: number } | null> {
    try {
      return await this.database.user.findUnique({
        where: { id: userId },
        select: { status: true, sessionVersion: true },
      });
    } catch {
      throw sessionUnavailable();
    }
  }
}

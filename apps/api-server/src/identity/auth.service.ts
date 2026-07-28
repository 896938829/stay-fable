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
}

const identityLookup = (identity: WechatIdentity) => ({
  where: {
    provider_providerSubject: {
      provider: identity.provider,
      providerSubject: identity.subject,
    },
  },
  select: { user: { select: { id: true, status: true } } },
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
          select: { id: true, status: true },
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

    return this.sessions.issue(requireEnabled(user).id);
  }

  refresh(refreshToken: string): Promise<AuthSession> {
    return this.sessions.refresh(refreshToken);
  }
}

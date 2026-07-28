import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";

import { BusinessException } from "../common/http/business.exception.js";
import { DatabaseService } from "../database/database.service.js";
import { SessionService } from "./session.service.js";

interface GuardRequest {
  headers: {
    authorization?: string;
  };
  user?: {
    id: string;
  };
}

const expiredSession = (): BusinessException =>
  new BusinessException(401, "AUTH_SESSION_EXPIRED", "登录状态已过期，请重新登录");
const disabledUser = (): BusinessException =>
  new BusinessException(403, "AUTH_USER_DISABLED", "账号已被停用");

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly database: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<GuardRequest>();
    const match = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? "");
    if (match === null) {
      throw expiredSession();
    }

    const token = match[1];
    if (token === undefined) {
      throw expiredSession();
    }

    const resolved = await this.sessions.resolveAccess(token);
    const user = await this.database.user.findUnique({
      where: { id: resolved.userId },
      select: { status: true },
    });
    if (user === null || user.status === "DISABLED") {
      await this.sessions.revokeFamily(resolved.familyId);
      throw disabledUser();
    }

    request.user = { id: resolved.userId };
    return true;
  }
}

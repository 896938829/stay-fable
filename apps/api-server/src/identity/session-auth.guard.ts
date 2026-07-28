import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";

import { BusinessException } from "../common/http/business.exception.js";
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

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

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
    request.user = { id: resolved.userId };
    return true;
  }
}

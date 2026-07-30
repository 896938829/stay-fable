import { Body, Controller, Post } from "@nestjs/common";
import { ApiBody, ApiCreatedResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { AuthSession } from "@stay-fable/api-contracts/auth";

import { AuthService } from "./auth.service.js";
import { AuthSessionEnvelopeDto } from "./dto/auth-session-response.dto.js";
import { RefreshSessionDto } from "./dto/refresh-session.dto.js";
import { WechatLoginDto } from "./dto/wechat-login.dto.js";

const wechatLoginRequestSchema = {
  type: "object" as const,
  additionalProperties: false,
  required: ["code"],
  properties: {
    code: { type: "string" as const, minLength: 8, maxLength: 128 },
  },
};

const refreshSessionRequestSchema = {
  type: "object" as const,
  additionalProperties: false,
  required: ["refresh_token"],
  properties: {
    refresh_token: { type: "string" as const, minLength: 32 },
  },
};

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("wechat/login")
  @ApiOperation({ summary: "Exchange a WeChat login code for a session" })
  @ApiBody({ schema: wechatLoginRequestSchema })
  @ApiCreatedResponse({ description: "Session issued", type: AuthSessionEnvelopeDto })
  login(@Body() body: WechatLoginDto): Promise<AuthSession> {
    return this.auth.login(body.code);
  }

  @Post("session/refresh")
  @ApiOperation({ summary: "Rotate a refresh token and session" })
  @ApiBody({ schema: refreshSessionRequestSchema })
  @ApiCreatedResponse({ description: "Session rotated", type: AuthSessionEnvelopeDto })
  refresh(@Body() body: RefreshSessionDto): Promise<AuthSession> {
    return this.auth.refresh(body.refresh_token);
  }
}

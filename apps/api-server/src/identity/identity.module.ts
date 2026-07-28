import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { CLOCK, systemClock } from "../common/clock/clock.js";
import { DatabaseModule } from "../database/database.module.js";
import { RedisModule } from "../infrastructure/redis/redis.module.js";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { MockWechatIdentityProvider } from "./mock-wechat-identity.provider.js";
import { randomTokenGenerator, SessionService, TOKEN_GENERATOR } from "./session.service.js";
import { SessionAuthGuard } from "./session-auth.guard.js";
import {
  unsupportedWechatIdentityProviderError,
  WECHAT_IDENTITY_PROVIDER,
  type WechatIdentityProvider,
} from "./wechat-identity.provider.js";

@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionService,
    SessionAuthGuard,
    { provide: CLOCK, useValue: systemClock },
    { provide: TOKEN_GENERATOR, useValue: randomTokenGenerator },
    {
      provide: WECHAT_IDENTITY_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): WechatIdentityProvider => {
        if (config.getOrThrow<string>("IDENTITY_PROVIDER") === "mock") {
          return new MockWechatIdentityProvider();
        }
        throw new Error(unsupportedWechatIdentityProviderError);
      },
    },
  ],
  exports: [SessionAuthGuard, SessionService],
})
export class IdentityModule {}

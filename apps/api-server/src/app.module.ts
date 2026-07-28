import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { LoggerModule } from "nestjs-pino";

import { validateRuntimeConfig } from "./config/runtime-config.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthController } from "./health/health.controller.js";
import { HealthService } from "./health/health.service.js";
import { IdentityModule } from "./identity/identity.module.js";
import { RedisModule } from "./infrastructure/redis/redis.module.js";
import { LOGGER_ROUTES } from "./logger-routes.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateRuntimeConfig,
    }),
    LoggerModule.forRoot({
      forRoutes: LOGGER_ROUTES,
      pinoHttp: {
        redact: {
          paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            "req.body.code",
            "req.body.password",
            "req.body.idCardNumber",
            "req.body.refresh_token",
          ],
          censor: "[REDACTED]",
        },
      },
    }),
    RedisModule,
    DatabaseModule,
    IdentityModule,
  ],
  controllers: [HealthController],
  providers: [HealthService],
})
export class AppModule {}

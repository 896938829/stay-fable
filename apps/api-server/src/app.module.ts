import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { LoggerModule } from "nestjs-pino";

import { validateRuntimeConfig } from "./config/runtime-config.js";
import { DatabaseService } from "./database/database.service.js";
import { HealthController } from "./health/health.controller.js";
import { HealthService } from "./health/health.service.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateRuntimeConfig,
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        redact: {
          paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            "req.body.password",
            "req.body.idCardNumber",
          ],
          censor: "[REDACTED]",
        },
      },
    }),
  ],
  controllers: [HealthController],
  providers: [DatabaseService, HealthService],
})
export class AppModule {}

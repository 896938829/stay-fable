import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";

import { REDIS_CLIENT, RedisService, type RedisClient } from "./redis.service.js";

@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): RedisClient =>
        new Redis(configService.getOrThrow<string>("REDIS_URL")),
    },
    RedisService,
  ],
  exports: [RedisService],
})
export class RedisModule {}

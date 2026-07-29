import { Module } from "@nestjs/common";

import { CLOCK, systemClock } from "../common/clock/clock.js";
import { WriteRateLimitService } from "../common/rate-limit/write-rate-limit.service.js";
import { DatabaseModule } from "../database/database.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { RedisModule } from "../infrastructure/redis/redis.module.js";
import { QuoteRepository } from "./quote.repository.js";
import { QuotesController } from "./quotes.controller.js";
import { QuotesService } from "./quotes.service.js";

@Module({
  imports: [DatabaseModule, RedisModule, IdentityModule],
  controllers: [QuotesController],
  providers: [
    QuoteRepository,
    QuotesService,
    WriteRateLimitService,
    { provide: CLOCK, useValue: systemClock },
  ],
  exports: [QuotesService, WriteRateLimitService],
})
export class PricingModule {}

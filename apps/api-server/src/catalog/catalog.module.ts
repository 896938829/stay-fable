import { Module } from "@nestjs/common";

import { CLOCK, systemClock } from "../common/clock/clock.js";
import { DatabaseModule } from "../database/database.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { CatalogController } from "./catalog.controller.js";
import { CatalogRepository } from "./catalog.repository.js";
import { CatalogService } from "./catalog.service.js";

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [CatalogController],
  providers: [
    CatalogRepository,
    CatalogService,
    {
      provide: CLOCK,
      useValue: systemClock,
    },
  ],
})
export class CatalogModule {}

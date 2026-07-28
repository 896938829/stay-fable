import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { LocationController } from "./location.controller.js";
import { LocationService } from "./location.service.js";

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [LocationController],
  providers: [LocationService],
  exports: [LocationService],
})
export class LocationModule {}

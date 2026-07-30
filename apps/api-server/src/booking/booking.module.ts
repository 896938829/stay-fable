import { Module } from "@nestjs/common";

import { CLOCK, systemClock } from "../common/clock/clock.js";
import { DatabaseModule } from "../database/database.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { PricingModule } from "../pricing/pricing.module.js";
import { BOOKING_NUMBER_GENERATOR, createBookingNumberGenerator } from "./booking-number.js";
import { BookingActionsController } from "./booking-actions.controller.js";
import { BookingLifecycleRepository } from "./booking-lifecycle.repository.js";
import { BookingLifecycleService } from "./booking-lifecycle.service.js";
import { BookingQueryController } from "./booking-query.controller.js";
import { BookingQueryRepository } from "./booking-query.repository.js";
import { BookingQueryService } from "./booking-query.service.js";
import { BookingRepository } from "./booking.repository.js";
import { BookingsController } from "./bookings.controller.js";
import { BookingsService } from "./bookings.service.js";

@Module({
  imports: [DatabaseModule, IdentityModule, PricingModule],
  controllers: [BookingsController, BookingQueryController, BookingActionsController],
  providers: [
    BookingRepository,
    BookingsService,
    BookingQueryRepository,
    BookingQueryService,
    BookingLifecycleRepository,
    BookingLifecycleService,
    { provide: CLOCK, useValue: systemClock },
    { provide: BOOKING_NUMBER_GENERATOR, useFactory: createBookingNumberGenerator },
  ],
  exports: [BookingsService, BookingQueryService, BookingLifecycleService],
})
export class BookingModule {}

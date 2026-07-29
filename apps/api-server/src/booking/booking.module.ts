import { Module } from "@nestjs/common";

import { CLOCK, systemClock } from "../common/clock/clock.js";
import { DatabaseModule } from "../database/database.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { PricingModule } from "../pricing/pricing.module.js";
import { BOOKING_NUMBER_GENERATOR, createBookingNumberGenerator } from "./booking-number.js";
import { BookingRepository } from "./booking.repository.js";
import { BookingsService } from "./bookings.service.js";

@Module({
  imports: [DatabaseModule, IdentityModule, PricingModule],
  providers: [
    BookingRepository,
    BookingsService,
    { provide: CLOCK, useValue: systemClock },
    { provide: BOOKING_NUMBER_GENERATOR, useFactory: createBookingNumberGenerator },
  ],
  exports: [BookingsService],
})
export class BookingModule {}

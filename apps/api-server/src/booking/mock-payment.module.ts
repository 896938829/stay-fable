import { type DynamicModule, Module } from "@nestjs/common";
import { parseRuntimeEnvironment } from "@stay-fable/validation";

import { IdentityModule } from "../identity/identity.module.js";
import { BookingModule } from "./booking.module.js";
import { DevPaymentsController } from "./dev-payments.controller.js";

@Module({})
export class MockPaymentModule {
  static forRoot(environment: Record<string, unknown>): DynamicModule {
    const config = parseRuntimeEnvironment(environment);
    const enabled = config.NODE_ENV !== "production" && config.ENABLE_MOCK_PAYMENT;
    return {
      module: MockPaymentModule,
      imports: enabled ? [BookingModule, IdentityModule] : [],
      controllers: enabled ? [DevPaymentsController] : [],
    };
  }
}

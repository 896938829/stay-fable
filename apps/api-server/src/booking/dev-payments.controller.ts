import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  Body,
  Controller,
  Param,
  Post,
  Query,
  Req,
  Res,
  type PipeTransform,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { idempotencyKeySchema } from "@stay-fable/api-contracts/booking";
import {
  type BookingDetail,
  type SimulatePaymentRequest,
  simulatePaymentRequestSchema,
} from "@stay-fable/api-contracts/booking-lifecycle";
import type { Request, Response } from "express";

import { BusinessException } from "../common/http/business.exception.js";
import { CurrentUser, type AuthenticatedUser } from "../identity/current-user.js";
import { SessionAuthGuard } from "../identity/session-auth.guard.js";
import {
  BookingDetailEnvelopeDto,
  BookingLifecycleErrorEnvelopeDto,
} from "./dto/booking-lifecycle-response.dto.js";
import { BookingRateLimitErrorEnvelopeDto } from "./dto/booking-response.dto.js";
import { MockPaymentService, type MockPaymentResult } from "./mock-payment.service.js";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const invalidRequest = (): BusinessException =>
  new BusinessException(400, "PAYMENT_REQUEST_INVALID", "支付请求无效");

const exactEmptyRecord = (value: unknown): Record<string, never> => {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      nodeTypes.isProxy(value) ||
      (Reflect.getPrototypeOf(value) !== Object.prototype &&
        Reflect.getPrototypeOf(value) !== null) ||
      Reflect.ownKeys(value).length !== 0
    ) {
      throw invalidRequest();
    }
    return Object.create(null) as Record<string, never>;
  } catch {
    throw invalidRequest();
  }
};

export const parsePaymentIdempotencyHeader = (rawHeaders: unknown): string => {
  try {
    if (
      !Array.isArray(rawHeaders) ||
      nodeTypes.isProxy(rawHeaders) ||
      rawHeaders.length % 2 !== 0
    ) {
      throw invalidRequest();
    }
    const matches: unknown[] = [];
    for (let index = 0; index < rawHeaders.length; index += 2) {
      const nameDescriptor = Reflect.getOwnPropertyDescriptor(rawHeaders, String(index));
      const valueDescriptor = Reflect.getOwnPropertyDescriptor(rawHeaders, String(index + 1));
      if (
        nameDescriptor === undefined ||
        valueDescriptor === undefined ||
        !Object.hasOwn(nameDescriptor, "value") ||
        !Object.hasOwn(valueDescriptor, "value") ||
        typeof nameDescriptor.value !== "string"
      ) {
        throw invalidRequest();
      }
      if (nameDescriptor.value.toLowerCase() === "idempotency-key") {
        matches.push(valueDescriptor.value);
      }
    }
    if (matches.length !== 1) {
      throw invalidRequest();
    }
    const parsed = idempotencyKeySchema.safeParse(matches[0]);
    if (!parsed.success) {
      throw invalidRequest();
    }
    return parsed.data;
  } catch {
    throw invalidRequest();
  }
};

export class MockPaymentBodyPipe implements PipeTransform<unknown, SimulatePaymentRequest> {
  transform(value: unknown): SimulatePaymentRequest {
    try {
      const parsed = simulatePaymentRequestSchema.safeParse(value);
      if (!parsed.success) {
        throw invalidRequest();
      }
      return parsed.data;
    } catch {
      throw invalidRequest();
    }
  }
}

export class MockPaymentQueryPipe implements PipeTransform<unknown, Record<string, never>> {
  transform(value: unknown): Record<string, never> {
    return exactEmptyRecord(value);
  }
}

export class MockPaymentBookingIdPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (typeof value !== "string" || !UUID_V4_PATTERN.test(value)) {
      throw invalidRequest();
    }
    return value;
  }
}

const paymentRequestSchema = {
  type: "object" as const,
  additionalProperties: false,
  required: ["outcome"],
  properties: {
    outcome: { type: "string" as const, enum: ["SUCCEED", "FAIL"] },
  },
};

@ApiTags("booking")
@ApiBearerAuth("session")
@Controller("dev/payments")
@UseGuards(SessionAuthGuard)
export class DevPaymentsController {
  private readonly inFlight = new Map<string, Promise<MockPaymentResult>>();

  constructor(private readonly payments: MockPaymentService) {}

  @Post(":bookingId/simulate")
  @ApiOperation({ summary: "Simulate an idempotent booking payment in non-production runtimes" })
  @ApiParam({ name: "bookingId", type: String, format: "uuid" })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    schema: {
      type: "string",
      pattern: "^[A-Za-z0-9._~-]{32,80}$",
      minLength: 32,
      maxLength: 80,
    },
  })
  @ApiBody({ schema: paymentRequestSchema })
  @ApiCreatedResponse({
    description: "Mock payment succeeded",
    type: BookingDetailEnvelopeDto,
  })
  @ApiOkResponse({
    description: "Successful mock payment replayed",
    type: BookingDetailEnvelopeDto,
  })
  @ApiBadRequestResponse({
    description: "Invalid payment request",
    type: BookingLifecycleErrorEnvelopeDto,
  })
  @ApiUnauthorizedResponse({
    description: "Authentication required",
    type: BookingLifecycleErrorEnvelopeDto,
  })
  @ApiForbiddenResponse({
    description: "User account disabled",
    type: BookingLifecycleErrorEnvelopeDto,
  })
  @ApiNotFoundResponse({
    description: "Booking not found",
    type: BookingLifecycleErrorEnvelopeDto,
  })
  @ApiConflictResponse({
    description: "Payment failed, expired, reused, or already processed",
    type: BookingLifecycleErrorEnvelopeDto,
  })
  @ApiTooManyRequestsResponse({
    description: "Mock payment rate limited",
    type: BookingRateLimitErrorEnvelopeDto,
  })
  @ApiServiceUnavailableResponse({
    description: "Booking lifecycle temporarily unavailable",
    type: BookingLifecycleErrorEnvelopeDto,
  })
  async simulate(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
    @Param("bookingId", new MockPaymentBookingIdPipe()) bookingId: string,
    @Body(new MockPaymentBodyPipe()) body: SimulatePaymentRequest,
    @Query(new MockPaymentQueryPipe()) _query: Record<string, never>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BookingDetail> {
    void _query;
    const idempotencyKey = parsePaymentIdempotencyHeader(request.rawHeaders);
    const inFlightKey = createHash("sha256")
      .update("mock-payment-request\u0000")
      .update(user.id)
      .update("\u0000")
      .update(bookingId)
      .update("\u0000")
      .update(idempotencyKey)
      .update("\u0000")
      .update(body.outcome)
      .digest("hex");
    let operation = this.inFlight.get(inFlightKey);
    if (operation === undefined) {
      operation = this.payments.simulate(user.id, bookingId, idempotencyKey, body);
      this.inFlight.set(inFlightKey, operation);
      void operation
        .finally(() => {
          if (this.inFlight.get(inFlightKey) === operation) {
            this.inFlight.delete(inFlightKey);
          }
        })
        .catch(() => undefined);
    }
    const result = await operation;
    response.status(result.replayed ? 200 : 201);
    return result.booking;
  }
}

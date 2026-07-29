import { Body, Controller, Post, Req, Res, UseGuards } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { idempotencyKeySchema, type BookingSummary } from "@stay-fable/api-contracts/booking";
import type { Request, Response } from "express";
import { types as nodeTypes } from "node:util";

import { BusinessException } from "../common/http/business.exception.js";
import { CurrentUser, type AuthenticatedUser } from "../identity/current-user.js";
import { SessionAuthGuard } from "../identity/session-auth.guard.js";
import { BookingsService } from "./bookings.service.js";
import {
  BookingConflictErrorEnvelopeDto,
  BookingEnvelopeDto,
  BookingErrorEnvelopeDto,
  BookingRateLimitErrorEnvelopeDto,
} from "./dto/booking-response.dto.js";
import { CreateBookingPipe } from "./dto/create-booking.dto.js";

const bookingRequestSchema = {
  type: "object" as const,
  additionalProperties: false,
  required: ["quote_id"],
  properties: {
    quote_id: { type: "string" as const, format: "uuid" },
  },
};

const invalidIdempotencyKey = (): BusinessException =>
  new BusinessException(400, "IDEMPOTENCY_KEY_INVALID", "请求标识无效");

export const parseIdempotencyHeader = (rawHeaders: unknown): string => {
  try {
    if (
      !Array.isArray(rawHeaders) ||
      nodeTypes.isProxy(rawHeaders) ||
      rawHeaders.length % 2 !== 0
    ) {
      throw invalidIdempotencyKey();
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
        throw invalidIdempotencyKey();
      }
      if (nameDescriptor.value.toLowerCase() === "idempotency-key") {
        matches.push(valueDescriptor.value);
      }
    }
    if (matches.length !== 1) {
      throw invalidIdempotencyKey();
    }
    const parsed = idempotencyKeySchema.safeParse(matches[0]);
    if (!parsed.success) {
      throw invalidIdempotencyKey();
    }
    return parsed.data;
  } catch {
    throw invalidIdempotencyKey();
  }
};

@ApiTags("booking")
@ApiBearerAuth("session")
@Controller("bookings")
@UseGuards(SessionAuthGuard)
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Post()
  @ApiOperation({ summary: "Create or replay a pending booking" })
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
  @ApiBody({ schema: bookingRequestSchema })
  @ApiCreatedResponse({ description: "Booking created", type: BookingEnvelopeDto })
  @ApiOkResponse({ description: "Booking replayed", type: BookingEnvelopeDto })
  @ApiBadRequestResponse({
    description: "Invalid booking request or idempotency key",
    type: BookingErrorEnvelopeDto,
  })
  @ApiUnauthorizedResponse({
    description: "Authentication required",
    type: BookingErrorEnvelopeDto,
  })
  @ApiForbiddenResponse({ description: "User account disabled", type: BookingErrorEnvelopeDto })
  @ApiConflictResponse({
    description: "Booking conflict",
    type: BookingConflictErrorEnvelopeDto,
  })
  @ApiTooManyRequestsResponse({
    description: "Booking rate limited",
    type: BookingRateLimitErrorEnvelopeDto,
  })
  @ApiServiceUnavailableResponse({
    description: "Booking service temporarily unavailable",
    type: BookingErrorEnvelopeDto,
  })
  async createBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
    @Body(new CreateBookingPipe()) body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BookingSummary> {
    const idempotencyKey = parseIdempotencyHeader(request.rawHeaders);
    const result = await this.bookings.create(user.id, idempotencyKey, body);
    response.status(result.replayed ? 200 : 201);
    return result.booking;
  }
}

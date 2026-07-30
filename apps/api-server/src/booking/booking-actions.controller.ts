import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  type PipeTransform,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import type { BookingDetail } from "@stay-fable/api-contracts/booking-lifecycle";
import { types as nodeTypes } from "node:util";

import { BusinessException } from "../common/http/business.exception.js";
import { CurrentUser, type AuthenticatedUser } from "../identity/current-user.js";
import { SessionAuthGuard } from "../identity/session-auth.guard.js";
import { BookingLifecycleService } from "./booking-lifecycle.service.js";
import { BookingRateLimitErrorEnvelopeDto } from "./dto/booking-response.dto.js";
import {
  BookingDetailEnvelopeDto,
  BookingLifecycleErrorEnvelopeDto,
} from "./dto/booking-lifecycle-response.dto.js";

const badRequest = (): BusinessException =>
  new BusinessException(400, "BAD_REQUEST", "请求处理失败");

export class CancelBookingPipe implements PipeTransform<unknown, Record<string, never>> {
  transform(value: unknown): Record<string, never> {
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
        throw badRequest();
      }
      return Object.create(null) as Record<string, never>;
    } catch {
      throw badRequest();
    }
  }
}

export class CancelBookingQueryPipe implements PipeTransform<unknown, Record<string, never>> {
  transform(value: unknown): Record<string, never> {
    return new CancelBookingPipe().transform(value);
  }
}

@ApiTags("booking")
@ApiBearerAuth("session")
@Controller("bookings")
@UseGuards(SessionAuthGuard)
export class BookingActionsController {
  constructor(private readonly lifecycle: BookingLifecycleService) {}

  @Post(":bookingId/cancel")
  @HttpCode(200)
  @ApiOperation({ summary: "Cancel or replay cancellation of an owned pending booking" })
  @ApiParam({ name: "bookingId", type: String, format: "uuid" })
  @ApiBody({ schema: { type: "object", additionalProperties: false } })
  @ApiOkResponse({ description: "Final cancelled booking detail", type: BookingDetailEnvelopeDto })
  @ApiBadRequestResponse({
    description: "Invalid cancellation request",
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
    description: "Booking expired or not cancellable",
    type: BookingLifecycleErrorEnvelopeDto,
  })
  @ApiTooManyRequestsResponse({
    description: "Booking cancellation rate limited",
    type: BookingRateLimitErrorEnvelopeDto,
  })
  @ApiServiceUnavailableResponse({
    description: "Booking lifecycle temporarily unavailable",
    type: BookingLifecycleErrorEnvelopeDto,
  })
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param("bookingId", new ParseUUIDPipe({ version: "4" })) bookingId: string,
    @Body(new CancelBookingPipe()) body: Record<string, never>,
    @Query(new CancelBookingQueryPipe()) _query: Record<string, never>,
  ): Promise<BookingDetail> {
    void _query;
    return (await this.lifecycle.cancel(user.id, bookingId, body)).booking;
  }
}

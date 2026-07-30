import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiPropertyOptional,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import type {
  BookingDetail,
  BookingListResponse,
} from "@stay-fable/api-contracts/booking-lifecycle";
import { Type } from "class-transformer";
import { Allow, IsInt, IsOptional, Max, Min } from "class-validator";

import { CurrentUser, type AuthenticatedUser } from "../identity/current-user.js";
import { SessionAuthGuard } from "../identity/session-auth.guard.js";
import {
  BookingDetailEnvelopeDto,
  BookingLifecycleErrorEnvelopeDto,
  BookingListEnvelopeDto,
} from "./dto/booking-lifecycle-response.dto.js";
import { BookingQueryService } from "./booking-query.service.js";

class BookingListQueryDto {
  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: 20, default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit = 10;

  @ApiPropertyOptional({
    type: String,
    minLength: 1,
    maxLength: 512,
    pattern: "^[A-Za-z0-9_-]+$",
  })
  @Allow()
  cursor?: unknown;
}

@ApiTags("booking")
@ApiBearerAuth("session")
@Controller("bookings")
@UseGuards(SessionAuthGuard)
export class BookingQueryController {
  constructor(private readonly bookings: BookingQueryService) {}

  @Get()
  @ApiOperation({ summary: "List the authenticated user's bookings" })
  @ApiOkResponse({ description: "Owned bookings", type: BookingListEnvelopeDto })
  @ApiBadRequestResponse({
    description: "Invalid list query or cursor",
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
  @ApiServiceUnavailableResponse({
    description: "Booking lifecycle temporarily unavailable",
    type: BookingLifecycleErrorEnvelopeDto,
  })
  listOwned(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: BookingListQueryDto,
  ): Promise<BookingListResponse> {
    return this.bookings.listOwned(user.id, {
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
  }

  @Get(":bookingId")
  @ApiOperation({ summary: "Get an owned booking" })
  @ApiParam({ name: "bookingId", type: String, format: "uuid" })
  @ApiOkResponse({ description: "Owned booking detail", type: BookingDetailEnvelopeDto })
  @ApiBadRequestResponse({
    description: "Invalid booking identifier",
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
  @ApiServiceUnavailableResponse({
    description: "Booking lifecycle temporarily unavailable",
    type: BookingLifecycleErrorEnvelopeDto,
  })
  getOwned(
    @CurrentUser() user: AuthenticatedUser,
    @Param("bookingId", new ParseUUIDPipe({ version: "4" })) bookingId: string,
  ): Promise<BookingDetail> {
    return this.bookings.getOwned(user.id, bookingId);
  }
}

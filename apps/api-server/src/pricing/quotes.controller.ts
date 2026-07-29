import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from "@nestjs/swagger";
import type { QuoteResponseData } from "@stay-fable/api-contracts/booking";

import { CurrentUser, type AuthenticatedUser } from "../identity/current-user.js";
import { SessionAuthGuard } from "../identity/session-auth.guard.js";
import { QuoteRequestPipe } from "./dto/quote-request.dto.js";
import { QuoteEnvelopeDto, QuoteErrorEnvelopeDto } from "./dto/quote-response.dto.js";
import { QuotesService } from "./quotes.service.js";

const quoteRequestSchema = {
  type: "object" as const,
  additionalProperties: false,
  required: ["room_type_id", "checkin", "checkout", "guests"],
  properties: {
    room_type_id: { type: "string" as const, format: "uuid" },
    checkin: { type: "string" as const, pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    checkout: { type: "string" as const, pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    guests: { type: "integer" as const, minimum: 1, maximum: 10 },
  },
};

@ApiTags("booking")
@ApiBearerAuth("session")
@Controller()
@UseGuards(SessionAuthGuard)
export class QuotesController {
  constructor(private readonly quotes: QuotesService) {}

  @Post("quotes")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Create a five-minute room quote" })
  @ApiBody({ schema: quoteRequestSchema })
  @ApiCreatedResponse({ description: "Quote created", type: QuoteEnvelopeDto })
  @ApiBadRequestResponse({ description: "Invalid quote request", type: QuoteErrorEnvelopeDto })
  @ApiUnauthorizedResponse({ description: "Authentication required", type: QuoteErrorEnvelopeDto })
  @ApiForbiddenResponse({ description: "User account disabled", type: QuoteErrorEnvelopeDto })
  @ApiNotFoundResponse({ description: "Room type not available", type: QuoteErrorEnvelopeDto })
  @ApiUnprocessableEntityResponse({
    description: "Guest capacity exceeded",
    type: QuoteErrorEnvelopeDto,
  })
  @ApiTooManyRequestsResponse({ description: "Quote rate limited", type: QuoteErrorEnvelopeDto })
  @ApiServiceUnavailableResponse({
    description: "Booking service temporarily unavailable",
    type: QuoteErrorEnvelopeDto,
  })
  createQuote(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new QuoteRequestPipe()) body: unknown,
  ): Promise<QuoteResponseData> {
    return this.quotes.create(user.id, body);
  }
}

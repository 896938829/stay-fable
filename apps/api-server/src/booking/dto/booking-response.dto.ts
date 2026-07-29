import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

import { QuoteResponseDto } from "../../pricing/dto/quote-response.dto.js";

const POSTGRES_INTEGER_MAX = 2_147_483_647;

export class BookingResponseDto {
  @ApiProperty({ format: "uuid" })
  booking_id!: string;

  @ApiProperty({ pattern: "^SF[0-9]{8}[A-F0-9]{12}$" })
  booking_number!: string;

  @ApiProperty({ enum: ["PENDING_PAYMENT"] })
  status!: "PENDING_PAYMENT";

  @ApiProperty({ minLength: 1, maxLength: 120 })
  property_name!: string;

  @ApiProperty({ minLength: 1, maxLength: 120 })
  room_type_name!: string;

  @ApiProperty({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })
  checkin!: string;

  @ApiProperty({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })
  checkout!: string;

  @ApiProperty({ type: "integer", minimum: 1, maximum: 30 })
  nights!: number;

  @ApiProperty({ type: "integer", minimum: 1, maximum: 10 })
  guests!: number;

  @ApiProperty({ type: "integer", minimum: 0, maximum: POSTGRES_INTEGER_MAX })
  total_price_cents!: number;

  @ApiProperty({ enum: ["CNY"] })
  currency!: "CNY";

  @ApiProperty({ type: String, format: "date-time" })
  expires_at!: string;

  @ApiProperty({ type: String, format: "date-time" })
  created_at!: string;
}

export class BookingEnvelopeDto {
  @ApiProperty({ type: BookingResponseDto })
  data!: BookingResponseDto;

  @ApiProperty()
  request_id!: string;
}

export class QuoteChangedDetailsDto {
  @ApiProperty({ type: "integer", minimum: 0, maximum: POSTGRES_INTEGER_MAX })
  previous_total_price_cents!: number;

  @ApiProperty({ type: QuoteResponseDto })
  replacement_quote!: QuoteResponseDto;
}

export class BookingErrorDto {
  @ApiProperty()
  code!: string;

  @ApiProperty()
  message!: string;
}

export class BookingErrorEnvelopeDto {
  @ApiProperty({ type: BookingErrorDto })
  error!: BookingErrorDto;

  @ApiProperty()
  request_id!: string;
}

export class BookingConflictErrorDto {
  @ApiProperty()
  code!: string;

  @ApiProperty()
  message!: string;

  @ApiPropertyOptional({ type: QuoteChangedDetailsDto })
  details?: QuoteChangedDetailsDto;
}

export class BookingConflictErrorEnvelopeDto {
  @ApiProperty({ type: BookingConflictErrorDto })
  error!: BookingConflictErrorDto;

  @ApiProperty()
  request_id!: string;
}

export class RateLimitDetailsDto {
  @ApiProperty({ type: "integer", minimum: 1, maximum: 60 })
  retry_after_seconds!: number;
}

export class BookingRateLimitErrorDto {
  @ApiProperty()
  code!: string;

  @ApiProperty()
  message!: string;

  @ApiProperty({ type: RateLimitDetailsDto })
  details!: RateLimitDetailsDto;
}

export class BookingRateLimitErrorEnvelopeDto {
  @ApiProperty({ type: BookingRateLimitErrorDto })
  error!: BookingRateLimitErrorDto;

  @ApiProperty()
  request_id!: string;
}

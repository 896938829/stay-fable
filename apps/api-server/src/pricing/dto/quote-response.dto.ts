import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class QuotePropertyDto {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty({ minLength: 1, maxLength: 120 })
  name!: string;
}

export class QuoteRoomTypeDto {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty({ minLength: 1, maxLength: 120 })
  name!: string;

  @ApiProperty({ maxLength: 500 })
  cover_url!: string;
}

export class QuoteNightlyPriceDto {
  @ApiProperty({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })
  business_date!: string;

  @ApiProperty({ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  sale_price_cents!: number;

  @ApiProperty({ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  rack_price_cents!: number;

  @ApiProperty({ enum: ["CNY"] })
  currency!: "CNY";
}

export class QuoteResponseDto {
  @ApiProperty({ format: "uuid" })
  quote_id!: string;

  @ApiProperty({ type: QuotePropertyDto })
  property!: QuotePropertyDto;

  @ApiProperty({ type: QuoteRoomTypeDto })
  room_type!: QuoteRoomTypeDto;

  @ApiProperty({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })
  checkin!: string;

  @ApiProperty({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })
  checkout!: string;

  @ApiProperty({ type: "integer", minimum: 1, maximum: 30 })
  nights!: number;

  @ApiProperty({ type: "integer", minimum: 1, maximum: 10 })
  guests!: number;

  @ApiProperty({ type: QuoteNightlyPriceDto, isArray: true, minItems: 1, maxItems: 30 })
  nightly_prices!: QuoteNightlyPriceDto[];

  @ApiProperty({ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  total_price_cents!: number;

  @ApiProperty({ enum: ["CNY"] })
  currency!: "CNY";

  @ApiProperty({ minLength: 1, maxLength: 2_000 })
  booking_policy!: string;

  @ApiProperty({ type: String, format: "date-time" })
  expires_at!: string;
}

export class QuoteEnvelopeDto {
  @ApiProperty({ type: QuoteResponseDto })
  data!: QuoteResponseDto;

  @ApiProperty()
  request_id!: string;
}

export class QuoteErrorDto {
  @ApiProperty()
  code!: string;

  @ApiProperty()
  message!: string;

  @ApiPropertyOptional({ type: Object })
  details?: Record<string, unknown>;
}

export class QuoteErrorEnvelopeDto {
  @ApiProperty({ type: QuoteErrorDto })
  error!: QuoteErrorDto;

  @ApiProperty()
  request_id!: string;
}

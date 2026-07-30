import { ApiProperty } from "@nestjs/swagger";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const BOOKING_STATUSES = ["PENDING_PAYMENT", "PAID", "CONFIRMED", "CANCELLED", "CLOSED"] as const;

export class BookingListItemDto {
  @ApiProperty({ format: "uuid" })
  booking_id!: string;

  @ApiProperty({ pattern: "^SF[0-9]{8}[A-F0-9]{12}$" })
  booking_number!: string;

  @ApiProperty({ enum: BOOKING_STATUSES })
  status!: (typeof BOOKING_STATUSES)[number];

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

  @ApiProperty()
  payment_deadline_passed!: boolean;

  @ApiProperty({ type: String, format: "date-time" })
  created_at!: string;

  @ApiProperty({ type: String, format: "date-time" })
  updated_at!: string;
}

export class BookingListResponseDto {
  @ApiProperty({ type: BookingListItemDto, isArray: true, maxItems: 20 })
  items!: BookingListItemDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    minLength: 1,
    maxLength: 512,
    pattern: "^[A-Za-z0-9_-]+$",
  })
  next_cursor!: string | null;
}

export class BookingListEnvelopeDto {
  @ApiProperty({ type: BookingListResponseDto })
  data!: BookingListResponseDto;

  @ApiProperty()
  request_id!: string;
}

export class BookingNightlyPriceDto {
  @ApiProperty({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })
  business_date!: string;

  @ApiProperty({ type: "integer", minimum: 0, maximum: POSTGRES_INTEGER_MAX })
  sale_price_cents!: number;

  @ApiProperty({ type: "integer", minimum: 0, maximum: POSTGRES_INTEGER_MAX })
  rack_price_cents!: number;

  @ApiProperty({ enum: ["CNY"] })
  currency!: "CNY";
}

export class BookingPaymentSummaryDto {
  @ApiProperty({ pattern: "^SFP[0-9]{8}[A-F0-9]{12}$" })
  payment_number!: string;

  @ApiProperty({ enum: ["SUCCEEDED", "FAILED"] })
  status!: "SUCCEEDED" | "FAILED";

  @ApiProperty({ type: String, format: "date-time" })
  processed_at!: string;
}

export class BookingStatusHistoryItemDto {
  @ApiProperty({ enum: BOOKING_STATUSES, nullable: true })
  from_status!: (typeof BOOKING_STATUSES)[number] | null;

  @ApiProperty({ enum: BOOKING_STATUSES })
  to_status!: (typeof BOOKING_STATUSES)[number];

  @ApiProperty({ minLength: 1, maxLength: 120 })
  reason!: string;

  @ApiProperty({ enum: ["USER", "SYSTEM"] })
  actor_type!: "USER" | "SYSTEM";

  @ApiProperty({ type: String, format: "date-time" })
  created_at!: string;
}

export class BookingDetailDto extends BookingListItemDto {
  @ApiProperty({ type: BookingNightlyPriceDto, isArray: true, minItems: 1, maxItems: 30 })
  nightly_prices!: BookingNightlyPriceDto[];

  @ApiProperty({ minLength: 1, maxLength: 2_000 })
  booking_policy!: string;

  @ApiProperty({ type: BookingPaymentSummaryDto, nullable: true })
  latest_payment!: BookingPaymentSummaryDto | null;

  @ApiProperty({ type: BookingStatusHistoryItemDto, isArray: true, maxItems: 100 })
  status_history!: BookingStatusHistoryItemDto[];

  @ApiProperty({
    type: "array",
    maxItems: 3,
    items: {
      type: "string",
      enum: ["CANCEL", "MOCK_PAY_SUCCESS", "MOCK_PAY_FAILURE"],
    },
  })
  allowed_actions!: Array<"CANCEL" | "MOCK_PAY_SUCCESS" | "MOCK_PAY_FAILURE">;
}

export class BookingDetailEnvelopeDto {
  @ApiProperty({ type: BookingDetailDto })
  data!: BookingDetailDto;

  @ApiProperty()
  request_id!: string;
}

export class BookingLifecycleErrorDto {
  @ApiProperty()
  code!: string;

  @ApiProperty()
  message!: string;
}

export class BookingLifecycleErrorEnvelopeDto {
  @ApiProperty({ type: BookingLifecycleErrorDto })
  error!: BookingLifecycleErrorDto;

  @ApiProperty()
  request_id!: string;
}

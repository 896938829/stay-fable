import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

const PROPERTY_TYPES = ["HOTEL", "HOMESTAY", "FARM_STAY"] as const;
const CURRENCIES = ["CNY"] as const;

export class CatalogCityDto {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  name!: string;
}

export class CatalogMediaDto {
  @ApiProperty({ enum: ["IMAGE"] })
  type!: "IMAGE";

  @ApiProperty({ maxLength: 500 })
  url!: string;

  @ApiProperty({ minLength: 1, maxLength: 120 })
  alt!: string;
}

export class CatalogFacilityDto {
  @ApiProperty({ minLength: 1 })
  code!: string;

  @ApiProperty({ minLength: 1 })
  name!: string;
}

export class PropertyListItemDto {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty({ enum: PROPERTY_TYPES })
  type!: (typeof PROPERTY_TYPES)[number];

  @ApiProperty({ minLength: 1, maxLength: 120 })
  name!: string;

  @ApiProperty({ type: CatalogCityDto })
  city!: CatalogCityDto;

  @ApiProperty({ maxLength: 500 })
  cover_url!: string;

  @ApiProperty({ minLength: 1, maxLength: 240 })
  short_description!: string;

  @ApiProperty({ type: String, isArray: true, maxItems: 4 })
  facility_highlights!: string[];

  @ApiProperty({ type: "integer", minimum: 0 })
  from_nightly_price_cents!: number;

  @ApiProperty({ enum: CURRENCIES })
  currency!: "CNY";

  @ApiProperty({ type: "integer", minimum: 1 })
  available_room_type_count!: number;
}

export class PropertyListResponseDto {
  @ApiProperty({ type: PropertyListItemDto, isArray: true })
  items!: PropertyListItemDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    minLength: 1,
    maxLength: 256,
  })
  next_cursor!: string | null;
}

export class RoomTypeSummaryDto {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty({ minLength: 1, maxLength: 120 })
  name!: string;

  @ApiProperty({ minLength: 1, maxLength: 120 })
  bed_type!: string;

  @ApiProperty({ type: "number", minimum: 0, exclusiveMinimum: true })
  area_sqm!: number;

  @ApiProperty({ type: "integer", minimum: 1, maximum: 10 })
  max_guests!: number;

  @ApiProperty({ maxLength: 500 })
  cover_url!: string;

  @ApiProperty({ minLength: 1, maxLength: 500 })
  policy_summary!: string;

  @ApiProperty({ type: "integer", minimum: 0 })
  from_nightly_price_cents!: number;

  @ApiProperty({ enum: CURRENCIES })
  currency!: "CNY";
}

export class PropertyDetailResponseDto {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty({ enum: PROPERTY_TYPES })
  type!: (typeof PROPERTY_TYPES)[number];

  @ApiProperty({ minLength: 1, maxLength: 120 })
  name!: string;

  @ApiProperty({ type: CatalogCityDto })
  city!: CatalogCityDto;

  @ApiProperty({ minLength: 1, maxLength: 240 })
  address!: string;

  @ApiProperty({ minLength: 1, maxLength: 2000 })
  description!: string;

  @ApiProperty({ minLength: 1, maxLength: 2000 })
  policies!: string;

  @ApiProperty({ maxLength: 500 })
  cover_url!: string;

  @ApiProperty({ type: CatalogMediaDto, isArray: true, maxItems: 20 })
  media!: CatalogMediaDto[];

  @ApiProperty({ type: CatalogFacilityDto, isArray: true, maxItems: 50 })
  facilities!: CatalogFacilityDto[];

  @ApiProperty({ type: RoomTypeSummaryDto, isArray: true, minItems: 0, maxItems: 50 })
  room_types!: RoomTypeSummaryDto[];
}

export class NightlyPriceDto {
  @ApiProperty({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })
  business_date!: string;

  @ApiProperty({ type: "integer", minimum: 0 })
  sale_price_cents!: number;

  @ApiProperty({ type: "integer", minimum: 0 })
  rack_price_cents!: number;

  @ApiProperty({ enum: CURRENCIES })
  currency!: "CNY";
}

export class RoomTypePropertySummaryDto {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty({ enum: PROPERTY_TYPES })
  type!: (typeof PROPERTY_TYPES)[number];

  @ApiProperty({ minLength: 1, maxLength: 120 })
  name!: string;

  @ApiProperty({ type: CatalogCityDto })
  city!: CatalogCityDto;
}

export class RoomTypeDetailResponseDto {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty({ minLength: 1, maxLength: 120 })
  name!: string;

  @ApiProperty({ minLength: 1, maxLength: 120 })
  bed_type!: string;

  @ApiProperty({ type: "number", minimum: 0, exclusiveMinimum: true })
  area_sqm!: number;

  @ApiProperty({ type: "integer", minimum: 1, maximum: 10 })
  max_guests!: number;

  @ApiProperty({ maxLength: 500 })
  cover_url!: string;

  @ApiProperty({ enum: CURRENCIES })
  currency!: "CNY";

  @ApiProperty({ type: RoomTypePropertySummaryDto })
  property!: RoomTypePropertySummaryDto;

  @ApiProperty({ minLength: 1, maxLength: 2000 })
  description!: string;

  @ApiProperty({ minLength: 1, maxLength: 2000 })
  booking_policy!: string;

  @ApiProperty({ type: NightlyPriceDto, isArray: true, minItems: 1, maxItems: 30 })
  nightly_prices!: NightlyPriceDto[];
}

export class PropertyListEnvelopeDto {
  @ApiProperty({ type: PropertyListResponseDto })
  data!: PropertyListResponseDto;

  @ApiProperty()
  request_id!: string;
}

export class PropertyDetailEnvelopeDto {
  @ApiProperty({ type: PropertyDetailResponseDto })
  data!: PropertyDetailResponseDto;

  @ApiProperty()
  request_id!: string;
}

export class RoomTypeDetailEnvelopeDto {
  @ApiProperty({ type: RoomTypeDetailResponseDto })
  data!: RoomTypeDetailResponseDto;

  @ApiProperty()
  request_id!: string;
}

export class ApiErrorDto {
  @ApiProperty()
  code!: string;

  @ApiProperty()
  message!: string;

  @ApiPropertyOptional({
    description: "Safe structured error details when the error supports them",
    type: Object,
  })
  details?: Record<string, unknown>;
}

export class ApiErrorEnvelopeDto {
  @ApiProperty({ type: ApiErrorDto })
  error!: ApiErrorDto;

  @ApiProperty()
  request_id!: string;
}

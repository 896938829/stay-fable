import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from "class-validator";

const CATALOG_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PROPERTY_TYPES = ["HOTEL", "HOMESTAY", "FARM_STAY"] as const;

export class AvailabilityQueryDto {
  @ApiProperty({ type: String, pattern: "^\\d{4}-\\d{2}-\\d{2}$", example: "2026-07-30" })
  @IsString()
  @Matches(CATALOG_DATE_PATTERN)
  checkin!: string;

  @ApiProperty({ type: String, pattern: "^\\d{4}-\\d{2}-\\d{2}$", example: "2026-08-01" })
  @IsString()
  @Matches(CATALOG_DATE_PATTERN)
  checkout!: string;

  @ApiProperty({ type: "integer", minimum: 1, maximum: 10 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  guests!: number;
}

export class PropertyListQueryDto extends AvailabilityQueryDto {
  @ApiProperty({ format: "uuid" })
  @IsUUID()
  city_id!: string;

  @ApiPropertyOptional({ enum: PROPERTY_TYPES })
  @IsOptional()
  @IsEnum(PROPERTY_TYPES)
  property_type?: (typeof PROPERTY_TYPES)[number];

  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: 20, default: 10 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  page_size = 10;

  @ApiPropertyOptional({ minLength: 1, maxLength: 256 })
  @IsOptional()
  @IsString()
  @Length(1, 256)
  cursor?: string;
}

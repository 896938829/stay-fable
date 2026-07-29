import { ApiProperty } from "@nestjs/swagger";
import { IsInt, IsString, IsUUID, Matches, Max, Min } from "class-validator";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class CreateQuoteRequestDto {
  @ApiProperty({ format: "uuid" })
  @IsUUID()
  room_type_id!: string;

  @ApiProperty({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", example: "2026-08-01" })
  @IsString()
  @Matches(DATE_PATTERN)
  checkin!: string;

  @ApiProperty({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", example: "2026-08-03" })
  @IsString()
  @Matches(DATE_PATTERN)
  checkout!: string;

  @ApiProperty({ type: "integer", minimum: 1, maximum: 10 })
  @IsInt()
  @Min(1)
  @Max(10)
  guests!: number;
}

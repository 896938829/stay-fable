import type { PipeTransform } from "@nestjs/common";
import { ApiProperty } from "@nestjs/swagger";
import { plainToInstance } from "class-transformer";
import { IsInt, IsString, IsUUID, Matches, Max, Min, validateSync } from "class-validator";

import { BusinessException } from "../../common/http/business.exception.js";

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

const invalidQuoteRequest = (): BusinessException =>
  new BusinessException(400, "QUOTE_REQUEST_INVALID", "报价请求无效，请检查入住信息");

const quoteRequestKeys = ["room_type_id", "checkin", "checkout", "guests"] as const;

export class QuoteRequestPipe implements PipeTransform<unknown, CreateQuoteRequestDto> {
  transform(value: unknown): CreateQuoteRequestDto {
    try {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw invalidQuoteRequest();
      }
      const prototype = Reflect.getPrototypeOf(value);
      const ownKeys = Reflect.ownKeys(value);
      if (
        (prototype !== Object.prototype && prototype !== null) ||
        ownKeys.length !== quoteRequestKeys.length ||
        ownKeys.some(
          (key) =>
            typeof key !== "string" || !quoteRequestKeys.some((expectedKey) => expectedKey === key),
        )
      ) {
        throw invalidQuoteRequest();
      }

      const trusted = Object.create(null) as Record<(typeof quoteRequestKeys)[number], unknown>;
      for (const key of quoteRequestKeys) {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, "value")
        ) {
          throw invalidQuoteRequest();
        }
        trusted[key] = descriptor.value;
      }

      const dto = plainToInstance(CreateQuoteRequestDto, trusted);
      const errors = validateSync(dto, {
        forbidNonWhitelisted: true,
        forbidUnknownValues: true,
        whitelist: true,
      });
      if (errors.length > 0) {
        throw invalidQuoteRequest();
      }
      return dto;
    } catch {
      throw invalidQuoteRequest();
    }
  }
}

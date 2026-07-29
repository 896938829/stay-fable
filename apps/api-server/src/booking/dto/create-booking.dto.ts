import type { PipeTransform } from "@nestjs/common";
import { ApiProperty } from "@nestjs/swagger";
import { plainToInstance } from "class-transformer";
import { IsUUID, validateSync } from "class-validator";
import { types as nodeTypes } from "node:util";

import { BusinessException } from "../../common/http/business.exception.js";

export class CreateBookingRequestDto {
  @ApiProperty({ format: "uuid" })
  @IsUUID()
  quote_id!: string;
}

const invalidBookingRequest = (): BusinessException =>
  new BusinessException(400, "BOOKING_REQUEST_INVALID", "下单请求无效");

const bookingRequestKeys = ["quote_id"] as const;

export class CreateBookingPipe implements PipeTransform<unknown, CreateBookingRequestDto> {
  transform(value: unknown): CreateBookingRequestDto {
    try {
      if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        nodeTypes.isProxy(value)
      ) {
        throw invalidBookingRequest();
      }
      const prototype = Reflect.getPrototypeOf(value);
      const ownKeys = Reflect.ownKeys(value);
      if (
        (prototype !== Object.prototype && prototype !== null) ||
        ownKeys.length !== bookingRequestKeys.length ||
        ownKeys.some(
          (key) =>
            typeof key !== "string" ||
            !bookingRequestKeys.some((expectedKey) => expectedKey === key),
        )
      ) {
        throw invalidBookingRequest();
      }
      const descriptor = Reflect.getOwnPropertyDescriptor(value, "quote_id");
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")
      ) {
        throw invalidBookingRequest();
      }
      const trusted = Object.assign(Object.create(null) as object, {
        quote_id: descriptor.value as unknown,
      });
      const dto = plainToInstance(CreateBookingRequestDto, trusted);
      const errors = validateSync(dto, {
        forbidNonWhitelisted: true,
        forbidUnknownValues: true,
        whitelist: true,
      });
      if (errors.length > 0) {
        throw invalidBookingRequest();
      }
      return dto;
    } catch {
      throw invalidBookingRequest();
    }
  }
}

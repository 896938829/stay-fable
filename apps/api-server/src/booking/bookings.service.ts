import { Inject, Injectable } from "@nestjs/common";
import {
  bookingSummarySchema,
  createBookingRequestSchema,
  idempotencyKeySchema,
  quoteChangedDetailsSchema,
  type BookingSummary,
} from "@stay-fable/api-contracts/booking";

import { CLOCK, type Clock } from "../common/clock/clock.js";
import { BusinessException } from "../common/http/business.exception.js";
import { WriteRateLimitService } from "../common/rate-limit/write-rate-limit.service.js";
import { BOOKING_NUMBER_GENERATOR, type BookingNumberGenerator } from "./booking-number.js";
import {
  BookingNumberConflictError,
  BookingRepository,
  type CreateBookingResult,
} from "./booking.repository.js";

const UUID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;

export interface BookingCreationResult {
  replayed: boolean;
  booking: BookingSummary;
}

const unavailable = (): BusinessException =>
  new BusinessException(503, "BOOKING_SERVICE_UNAVAILABLE", "预订服务暂时不可用，请稍后重试");
const invalidRequest = (): BusinessException =>
  new BusinessException(400, "BOOKING_REQUEST_INVALID", "下单请求无效");
const domainError = (code: string, message: string, details?: unknown): BusinessException =>
  new BusinessException(409, code, message, details);

@Injectable()
export class BookingsService {
  constructor(
    private readonly repository: BookingRepository,
    private readonly rateLimit: WriteRateLimitService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(BOOKING_NUMBER_GENERATOR) private readonly bookingNumbers: BookingNumberGenerator,
  ) {}

  async create(
    userId: string,
    idempotencyKey: unknown,
    body: unknown,
  ): Promise<BookingCreationResult> {
    const parsedBody = createBookingRequestSchema.safeParse(body);
    const parsedKey = idempotencyKeySchema.safeParse(idempotencyKey);
    if (!UUID_PATTERN.test(userId) || !parsedBody.success || !parsedKey.success) {
      throw invalidRequest();
    }

    await this.checkRateLimit(userId);
    const now = this.captureNow();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let bookingNumber: string;
      try {
        bookingNumber = this.bookingNumbers.next(now);
      } catch {
        throw unavailable();
      }

      let result: CreateBookingResult;
      try {
        result = await this.repository.createFromQuote({
          userId,
          quoteId: parsedBody.data.quote_id,
          idempotencyKey: parsedKey.data,
          bookingNumber,
          now: new Date(Date.prototype.getTime.call(now)),
        });
      } catch (error) {
        if (error instanceof BookingNumberConflictError && attempt === 0) {
          continue;
        }
        throw unavailable();
      }
      return this.mapResult(result, parsedBody.data.quote_id);
    }
    throw unavailable();
  }

  private async checkRateLimit(userId: string): Promise<void> {
    try {
      await this.rateLimit.checkBookings(userId);
    } catch (error) {
      if (
        error instanceof BusinessException &&
        (error.code === "RATE_LIMITED" || error.code === "BOOKING_SERVICE_UNAVAILABLE")
      ) {
        throw error;
      }
      throw unavailable();
    }
  }

  private captureNow(): Date {
    try {
      const now = this.clock.now();
      if (!(now instanceof Date) || !Number.isFinite(Date.prototype.getTime.call(now))) {
        throw new Error("Invalid clock");
      }
      return new Date(Date.prototype.getTime.call(now));
    } catch {
      throw unavailable();
    }
  }

  private mapResult(result: CreateBookingResult, requestedQuoteId: string): BookingCreationResult {
    if (result.kind === "CREATED" || result.kind === "REPLAYED") {
      const booking = bookingSummarySchema.safeParse(result.booking);
      if (!booking.success || booking.data.quote_id !== requestedQuoteId) {
        throw unavailable();
      }
      return { replayed: result.kind === "REPLAYED", booking: booking.data };
    }
    if (result.kind === "QUOTE_EXPIRED") {
      throw domainError("QUOTE_EXPIRED", "报价已失效，请重新获取");
    }
    if (result.kind === "QUOTE_ALREADY_USED") {
      throw domainError("QUOTE_ALREADY_USED", "报价已被使用");
    }
    if (result.kind === "INVENTORY_UNAVAILABLE") {
      throw domainError("INVENTORY_UNAVAILABLE", "房型库存不足");
    }
    const details = quoteChangedDetailsSchema.safeParse(result.details);
    if (!details.success) {
      throw unavailable();
    }
    throw domainError("QUOTE_CHANGED", "报价已发生变化，请确认新价格", details.data);
  }
}

import { Inject, Injectable } from "@nestjs/common";
import {
  type BookingDetail,
  bookingDetailSchema,
  cancelBookingRequestSchema,
} from "@stay-fable/api-contracts/booking-lifecycle";
import { types as nodeTypes } from "node:util";

import { CLOCK, type Clock } from "../common/clock/clock.js";
import { BusinessException } from "../common/http/business.exception.js";
import { WriteRateLimitService } from "../common/rate-limit/write-rate-limit.service.js";
import {
  BookingLifecycleRepository,
  type CancelOwnedBookingResult,
} from "./booking-lifecycle.repository.js";
import { BookingQueryService } from "./booking-query.service.js";

const UUID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;

export interface BookingCancellationResult {
  replayed: boolean;
  booking: BookingDetail;
}

const badRequest = (): BusinessException =>
  new BusinessException(400, "BAD_REQUEST", "请求处理失败");
const notFound = (): BusinessException =>
  new BusinessException(404, "BOOKING_NOT_FOUND", "订单不存在");
const notCancellable = (): BusinessException =>
  new BusinessException(409, "BOOKING_NOT_CANCELLABLE", "当前订单状态不可取消");
const expired = (): BusinessException =>
  new BusinessException(409, "BOOKING_EXPIRED", "订单已超过付款期限");
const unavailable = (): BusinessException =>
  new BusinessException(503, "BOOKING_LIFECYCLE_UNAVAILABLE", "订单服务暂时不可用，请稍后重试");

const readExactRecord = (
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  ) {
    throw unavailable();
  }
  const prototype = Reflect.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    throw unavailable();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value")
    ) {
      throw unavailable();
    }
    result[key] = descriptor.value;
  }
  return result;
};

const captureNow = (clock: Clock): Date => {
  try {
    const value = clock.now();
    if (
      typeof value !== "object" ||
      value === null ||
      nodeTypes.isProxy(value) ||
      Reflect.getPrototypeOf(value) !== Date.prototype
    ) {
      throw unavailable();
    }
    const milliseconds = Date.prototype.getTime.call(value);
    if (!Number.isFinite(milliseconds)) {
      throw unavailable();
    }
    return new Date(milliseconds);
  } catch {
    throw unavailable();
  }
};

const readRepositoryResult = (
  value: unknown,
  requestedBookingId: string,
): CancelOwnedBookingResult => {
  const record = readExactRecord(
    value,
    (() => {
      try {
        const descriptor =
          typeof value === "object" && value !== null && !nodeTypes.isProxy(value)
            ? Reflect.getOwnPropertyDescriptor(value, "kind")
            : undefined;
        const kind: unknown =
          descriptor !== undefined && Object.hasOwn(descriptor, "value")
            ? (descriptor as { value?: unknown }).value
            : undefined;
        return kind === "CANCELLED" || kind === "REPLAYED" || kind === "EXPIRED"
          ? ["kind", "bookingId"]
          : ["kind"];
      } catch {
        return ["kind"];
      }
    })(),
  );
  const kind = record.kind;
  if (kind === "CANCELLED" || kind === "REPLAYED" || kind === "EXPIRED") {
    if (record.bookingId !== requestedBookingId) {
      throw unavailable();
    }
    return { kind, bookingId: requestedBookingId };
  }
  if (kind === "NOT_FOUND" || kind === "NOT_CANCELLABLE") {
    return { kind };
  }
  throw unavailable();
};

const cloneRateLimitError = (error: unknown): BusinessException | null => {
  try {
    if (
      !(error instanceof BusinessException) ||
      error.code !== "RATE_LIMITED" ||
      error.getStatus() !== 429
    ) {
      return null;
    }
    const details = readExactRecord(error.details, ["retry_after_seconds"]);
    const retryAfterSeconds = details.retry_after_seconds;
    if (
      typeof retryAfterSeconds !== "number" ||
      !Number.isSafeInteger(retryAfterSeconds) ||
      retryAfterSeconds < 1 ||
      retryAfterSeconds > 60
    ) {
      return null;
    }
    return new BusinessException(429, "RATE_LIMITED", "操作过于频繁，请稍后重试", {
      retry_after_seconds: retryAfterSeconds,
    });
  } catch {
    return null;
  }
};

@Injectable()
export class BookingLifecycleService {
  constructor(
    private readonly repository: BookingLifecycleRepository,
    private readonly rateLimit: WriteRateLimitService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly query: BookingQueryService,
  ) {}

  async cancel(
    userId: string,
    bookingId: unknown,
    body: unknown,
  ): Promise<BookingCancellationResult> {
    let validBody: boolean;
    try {
      validBody = cancelBookingRequestSchema.safeParse(body).success;
    } catch {
      throw badRequest();
    }
    if (
      !UUID_PATTERN.test(userId) ||
      typeof bookingId !== "string" ||
      !UUID_PATTERN.test(bookingId) ||
      !validBody
    ) {
      throw badRequest();
    }

    try {
      await this.rateLimit.checkBookingCancellation(userId);
    } catch (error) {
      const rateLimitError = cloneRateLimitError(error);
      if (rateLimitError !== null) {
        throw rateLimitError;
      }
      throw unavailable();
    }
    const now = captureNow(this.clock);

    let result: CancelOwnedBookingResult;
    try {
      result = readRepositoryResult(
        await this.repository.cancelOwnedBooking({
          userId,
          bookingId,
          now: new Date(now),
        }),
        bookingId,
      );
    } catch {
      throw unavailable();
    }

    if (result.kind === "NOT_FOUND") {
      throw notFound();
    }
    if (result.kind === "NOT_CANCELLABLE") {
      throw notCancellable();
    }
    if (result.kind === "EXPIRED") {
      throw expired();
    }

    try {
      const parsed = bookingDetailSchema.safeParse(await this.query.getOwned(userId, bookingId));
      if (
        !parsed.success ||
        parsed.data.booking_id !== bookingId ||
        parsed.data.status !== "CANCELLED" ||
        parsed.data.allowed_actions.length !== 0
      ) {
        throw unavailable();
      }
      return { replayed: result.kind === "REPLAYED", booking: parsed.data };
    } catch {
      throw unavailable();
    }
  }
}

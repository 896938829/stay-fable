import { Inject, Injectable } from "@nestjs/common";
import { idempotencyKeySchema } from "@stay-fable/api-contracts/booking";
import {
  type BookingDetail,
  bookingDetailSchema,
  simulatePaymentRequestSchema,
} from "@stay-fable/api-contracts/booking-lifecycle";
import { types as nodeTypes } from "node:util";

import { CLOCK, type Clock } from "../common/clock/clock.js";
import { BusinessException } from "../common/http/business.exception.js";
import { WriteRateLimitService } from "../common/rate-limit/write-rate-limit.service.js";
import {
  BookingLifecycleRepository,
  PaymentNumberConflictError,
  type SimulateMockPaymentResult,
} from "./booking-lifecycle.repository.js";
import { BookingQueryService } from "./booking-query.service.js";
import { PAYMENT_NUMBER_GENERATOR, type PaymentNumberGenerator } from "./payment-number.js";

const UUID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
const PAYMENT_NUMBER_PATTERN = /^SFP[0-9]{8}[A-F0-9]{12}$/;

export interface MockPaymentResult {
  replayed: boolean;
  booking: BookingDetail;
}

const invalidRequest = (): BusinessException =>
  new BusinessException(400, "PAYMENT_REQUEST_INVALID", "支付请求无效");
const notFound = (): BusinessException =>
  new BusinessException(404, "BOOKING_NOT_FOUND", "订单不存在");
const expired = (): BusinessException =>
  new BusinessException(409, "BOOKING_EXPIRED", "订单已超过付款期限");
const alreadyProcessed = (): BusinessException =>
  new BusinessException(409, "BOOKING_ALREADY_PROCESSED", "订单已处理");
const keyReused = (): BusinessException =>
  new BusinessException(409, "IDEMPOTENCY_KEY_REUSED", "请求标识已用于其他支付结果");
const paymentFailed = (): BusinessException =>
  new BusinessException(409, "MOCK_PAYMENT_FAILED", "模拟支付失败");
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

const readRepositoryResult = (
  value: unknown,
  requestedBookingId: string,
): SimulateMockPaymentResult => {
  let kind: unknown;
  try {
    const descriptor =
      typeof value === "object" && value !== null && !nodeTypes.isProxy(value)
        ? Reflect.getOwnPropertyDescriptor(value, "kind")
        : undefined;
    kind =
      descriptor !== undefined && Object.hasOwn(descriptor, "value")
        ? (descriptor as { value?: unknown }).value
        : undefined;
  } catch {
    throw unavailable();
  }
  if (kind === "SUCCEEDED" || kind === "FAILED") {
    const record = readExactRecord(value, ["kind", "replayed", "bookingId"]);
    if (typeof record.replayed !== "boolean" || record.bookingId !== requestedBookingId) {
      throw unavailable();
    }
    return { kind, replayed: record.replayed, bookingId: requestedBookingId };
  }
  if (kind === "EXPIRED") {
    const record = readExactRecord(value, ["kind", "bookingId"]);
    if (record.bookingId !== requestedBookingId) {
      throw unavailable();
    }
    return { kind, bookingId: requestedBookingId };
  }
  const record = readExactRecord(value, ["kind"]);
  if (
    record.kind === "NOT_FOUND" ||
    record.kind === "ALREADY_PROCESSED" ||
    record.kind === "IDEMPOTENCY_KEY_REUSED"
  ) {
    return { kind: record.kind };
  }
  throw unavailable();
};

@Injectable()
export class MockPaymentService {
  constructor(
    private readonly repository: BookingLifecycleRepository,
    private readonly rateLimit: WriteRateLimitService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYMENT_NUMBER_GENERATOR)
    private readonly paymentNumbers: PaymentNumberGenerator,
    private readonly query: BookingQueryService,
  ) {}

  async simulate(
    userId: unknown,
    bookingId: unknown,
    idempotencyKey: unknown,
    body: unknown,
  ): Promise<MockPaymentResult> {
    let parsedBody: ReturnType<typeof simulatePaymentRequestSchema.safeParse>;
    let parsedKey: ReturnType<typeof idempotencyKeySchema.safeParse>;
    try {
      parsedBody = simulatePaymentRequestSchema.safeParse(body);
      parsedKey = idempotencyKeySchema.safeParse(idempotencyKey);
    } catch {
      throw invalidRequest();
    }
    if (
      typeof userId !== "string" ||
      !UUID_PATTERN.test(userId) ||
      typeof bookingId !== "string" ||
      !UUID_PATTERN.test(bookingId) ||
      !parsedKey.success ||
      !parsedBody.success
    ) {
      throw invalidRequest();
    }

    try {
      await this.rateLimit.checkMockPayment(userId);
    } catch (error) {
      const rateLimitError = cloneRateLimitError(error);
      if (rateLimitError !== null) {
        throw rateLimitError;
      }
      throw unavailable();
    }
    const now = captureNow(this.clock);

    let result: SimulateMockPaymentResult | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let paymentNumber: string;
      try {
        paymentNumber = this.paymentNumbers.next(new Date(now));
        if (!PAYMENT_NUMBER_PATTERN.test(paymentNumber)) {
          throw unavailable();
        }
      } catch {
        throw unavailable();
      }
      try {
        result = readRepositoryResult(
          await this.repository.simulateMockPayment({
            userId,
            bookingId,
            idempotencyKey: parsedKey.data,
            outcome: parsedBody.data.outcome,
            paymentNumber,
            now: new Date(now),
          }),
          bookingId,
        );
        break;
      } catch (error) {
        if (error instanceof PaymentNumberConflictError && attempt === 0) {
          continue;
        }
        throw unavailable();
      }
    }
    if (result === undefined) {
      throw unavailable();
    }
    if (result.kind === "NOT_FOUND") {
      throw notFound();
    }
    if (result.kind === "EXPIRED") {
      throw expired();
    }
    if (result.kind === "ALREADY_PROCESSED") {
      throw alreadyProcessed();
    }
    if (result.kind === "IDEMPOTENCY_KEY_REUSED") {
      throw keyReused();
    }
    if (result.kind === "FAILED") {
      throw paymentFailed();
    }
    if (result.kind !== "SUCCEEDED") {
      throw unavailable();
    }

    try {
      const parsed = bookingDetailSchema.safeParse(await this.query.getOwned(userId, bookingId));
      if (
        !parsed.success ||
        parsed.data.booking_id !== bookingId ||
        parsed.data.status !== "CONFIRMED" ||
        parsed.data.allowed_actions.length !== 0 ||
        parsed.data.latest_payment?.status !== "SUCCEEDED"
      ) {
        throw unavailable();
      }
      return { replayed: result.replayed, booking: parsed.data };
    } catch {
      throw unavailable();
    }
  }
}

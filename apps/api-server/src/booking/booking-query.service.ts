import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  type BookingDetail,
  bookingDetailSchema,
  type BookingListItem,
  bookingListQuerySchema,
  type BookingListResponse,
  bookingListResponseSchema,
} from "@stay-fable/api-contracts/booking-lifecycle";
import { types as nodeTypes } from "node:util";

import { CLOCK, type Clock } from "../common/clock/clock.js";
import { BusinessException } from "../common/http/business.exception.js";
import { decodeBookingCursor, encodeBookingCursor } from "./booking-cursor.js";
import {
  BookingQueryRepository,
  type BookingListRepositoryInput,
} from "./booking-query.repository.js";

const UUID_PATTERN =
  /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;

const badRequest = (): BusinessException =>
  new BusinessException(400, "BAD_REQUEST", "请求处理失败");
const bookingNotFound = (): BusinessException =>
  new BusinessException(404, "BOOKING_NOT_FOUND", "订单不存在");
const lifecycleUnavailable = (): BusinessException =>
  new BusinessException(503, "BOOKING_LIFECYCLE_UNAVAILABLE", "订单服务暂时不可用，请稍后重试");

const listRowKeys = [
  "id",
  "bookingNumber",
  "status",
  "propertySnapshot",
  "roomTypeSnapshot",
  "checkin",
  "checkout",
  "guests",
  "totalPriceCents",
  "currency",
  "expiresAt",
  "createdAt",
  "updatedAt",
] as const;
const detailRowKeys = [
  ...listRowKeys,
  "nightlyPrices",
  "bookingPolicy",
  "latestPayment",
  "statusHistory",
] as const;

const readExactObject = (
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  ) {
    throw lifecycleUnavailable();
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw lifecycleUnavailable();
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    throw lifecycleUnavailable();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true
    ) {
      throw lifecycleUnavailable();
    }
    result[key] = descriptor.value;
  }
  return result;
};

const readArray = (value: unknown, maximum: number): unknown[] => {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || value.length > maximum) {
    throw lifecycleUnavailable();
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string") ||
    keys.length !== value.length + 1 ||
    !keys.includes("length")
  ) {
    throw lifecycleUnavailable();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      throw lifecycleUnavailable();
    }
    result.push(descriptor.value);
  }
  return result;
};

const readString = (value: unknown): string => {
  if (typeof value !== "string") {
    throw lifecycleUnavailable();
  }
  return value;
};

const readInteger = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw lifecycleUnavailable();
  }
  return value;
};

const readInstant = (value: unknown): { date: Date; iso: string } => {
  if (
    typeof value !== "object" ||
    value === null ||
    nodeTypes.isProxy(value) ||
    Reflect.getPrototypeOf(value) !== Date.prototype
  ) {
    throw lifecycleUnavailable();
  }
  const milliseconds = Date.prototype.getTime.call(value);
  if (!Number.isFinite(milliseconds)) {
    throw lifecycleUnavailable();
  }
  const date = new Date(milliseconds);
  return { date, iso: date.toISOString() };
};

const calendarNights = (checkin: string, checkout: string): number => {
  const start = Date.parse(`${checkin}T00:00:00.000Z`);
  const end = Date.parse(`${checkout}T00:00:00.000Z`);
  return (end - start) / 86_400_000;
};

const mapListRow = (
  value: unknown,
  now: Date,
): { item: BookingListItem; cursor: { createdAt: string; id: string } } => {
  const row = readExactObject(value, listRowKeys);
  const property = readExactObject(row.propertySnapshot, ["id", "name"]);
  const roomType = readExactObject(row.roomTypeSnapshot, ["id", "name", "cover_url"]);
  const expiresAt = readInstant(row.expiresAt);
  const createdAt = readInstant(row.createdAt);
  const updatedAt = readInstant(row.updatedAt);
  const checkin = readString(row.checkin);
  const checkout = readString(row.checkout);
  const item = {
    booking_id: readString(row.id),
    booking_number: readString(row.bookingNumber),
    status: readString(row.status),
    property_name: readString(property.name),
    room_type_name: readString(roomType.name),
    checkin,
    checkout,
    nights: calendarNights(checkin, checkout),
    guests: readInteger(row.guests),
    total_price_cents: readInteger(row.totalPriceCents),
    currency: readString(row.currency),
    expires_at: expiresAt.iso,
    payment_deadline_passed: expiresAt.date.getTime() <= now.getTime(),
    created_at: createdAt.iso,
    updated_at: updatedAt.iso,
  };
  return {
    item: item as BookingListItem,
    cursor: { createdAt: createdAt.iso, id: readString(row.id) },
  };
};

const mapNightlyPrices = (value: unknown): unknown[] =>
  readArray(value, 30).map((entry) => {
    const night = readExactObject(entry, [
      "business_date",
      "sale_price_cents",
      "rack_price_cents",
      "currency",
    ]);
    return {
      business_date: readString(night.business_date),
      sale_price_cents: readInteger(night.sale_price_cents),
      rack_price_cents: readInteger(night.rack_price_cents),
      currency: readString(night.currency),
    };
  });

const mapPayment = (value: unknown): unknown => {
  if (value === null) {
    return null;
  }
  const payment = readExactObject(value, ["paymentNumber", "status", "processedAt"]);
  return {
    payment_number: readString(payment.paymentNumber),
    status: readString(payment.status),
    processed_at: readInstant(payment.processedAt).iso,
  };
};

const mapHistory = (value: unknown): unknown[] =>
  readArray(value, 100).map((entry) => {
    const history = readExactObject(entry, [
      "fromStatus",
      "toStatus",
      "reason",
      "actorType",
      "createdAt",
    ]);
    return {
      from_status: history.fromStatus === null ? null : readString(history.fromStatus),
      to_status: readString(history.toStatus),
      reason: readString(history.reason),
      actor_type: readString(history.actorType),
      created_at: readInstant(history.createdAt).iso,
    };
  });

const captureNow = (clock: Clock): Date => {
  const value = clock.now();
  return readInstant(value).date;
};

const decodeCursorFromQuery = (
  query: unknown,
): ReturnType<typeof decodeBookingCursor> | undefined => {
  try {
    if (typeof query !== "object" || query === null || Array.isArray(query)) {
      return undefined;
    }
    if (nodeTypes.isProxy(query)) {
      throw badRequest();
    }
    const keys = Reflect.ownKeys(query);
    if (!keys.includes("cursor")) {
      return undefined;
    }
    const descriptor = Reflect.getOwnPropertyDescriptor(query, "cursor");
    return decodeBookingCursor(
      descriptor !== undefined && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined,
    );
  } catch (error) {
    if (error instanceof BusinessException && error.code === "ORDER_CURSOR_INVALID") {
      throw error;
    }
    throw badRequest();
  }
};

@Injectable()
export class BookingQueryService {
  constructor(
    private readonly repository: BookingQueryRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly config: ConfigService,
  ) {}

  async listOwned(userId: string, query: unknown): Promise<BookingListResponse> {
    const after = decodeCursorFromQuery(query);
    let parsed: ReturnType<typeof bookingListQuerySchema.safeParse>;
    try {
      parsed = bookingListQuerySchema.safeParse(query);
    } catch {
      throw badRequest();
    }
    if (!parsed.success) {
      throw badRequest();
    }
    const input: BookingListRepositoryInput = {
      limit: parsed.data.limit,
      ...(after === undefined ? {} : { after }),
    };
    try {
      if (!UUID_PATTERN.test(userId)) {
        throw lifecycleUnavailable();
      }
      const now = captureNow(this.clock);
      const rawRows = await this.repository.listOwned(userId, input);
      const rows = readArray(rawRows, parsed.data.limit + 1);
      const mapped = rows.map((row) => mapListRow(row, now));
      const returned = mapped.slice(0, parsed.data.limit);
      const last = returned.at(-1);
      return bookingListResponseSchema.parse({
        items: returned.map(({ item }) => item),
        next_cursor:
          mapped.length > parsed.data.limit && last !== undefined
            ? encodeBookingCursor(last.cursor)
            : null,
      });
    } catch {
      throw lifecycleUnavailable();
    }
  }

  async getOwned(userId: string, bookingId: unknown): Promise<BookingDetail> {
    if (typeof bookingId !== "string" || !UUID_PATTERN.test(bookingId)) {
      throw badRequest();
    }
    let now: Date;
    let raw: Awaited<ReturnType<BookingQueryRepository["findOwned"]>>;
    try {
      if (!UUID_PATTERN.test(userId)) {
        throw lifecycleUnavailable();
      }
      now = captureNow(this.clock);
      raw = await this.repository.findOwned(userId, bookingId);
    } catch {
      throw lifecycleUnavailable();
    }
    if (raw === null) {
      throw bookingNotFound();
    }
    try {
      const row = readExactObject(raw, detailRowKeys);
      const base = mapListRow(
        Object.fromEntries(listRowKeys.map((key) => [key, row[key]])),
        now,
      ).item;
      const mockEnabled = this.config.getOrThrow<boolean>("ENABLE_MOCK_PAYMENT");
      if (typeof mockEnabled !== "boolean") {
        throw lifecycleUnavailable();
      }
      const pendingAndLive =
        base.status === "PENDING_PAYMENT" &&
        readInstant(row.expiresAt).date.getTime() > now.getTime();
      return bookingDetailSchema.parse({
        ...base,
        nightly_prices: mapNightlyPrices(row.nightlyPrices),
        booking_policy: readString(row.bookingPolicy),
        latest_payment: mapPayment(row.latestPayment),
        status_history: mapHistory(row.statusHistory),
        allowed_actions: pendingAndLive
          ? ["CANCEL", ...(mockEnabled ? (["MOCK_PAY_SUCCESS", "MOCK_PAY_FAILURE"] as const) : [])]
          : [],
      });
    } catch {
      throw lifecycleUnavailable();
    }
  }
}

import { Inject, Injectable } from "@nestjs/common";
import {
  createQuoteRequestSchema,
  quoteResponseDataSchema,
  type QuoteResponseData,
} from "@stay-fable/api-contracts/booking";

import { CLOCK, type Clock } from "../common/clock/clock.js";
import { BusinessException } from "../common/http/business.exception.js";
import { WriteRateLimitService } from "../common/rate-limit/write-rate-limit.service.js";
import { parseCatalogDateRange } from "../catalog/catalog-date-range.js";
import { createQuoteFingerprint } from "./quote-fingerprint.js";
import { QuoteRepository } from "./quote.repository.js";

const UUID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;

const invalidRequest = (): BusinessException =>
  new BusinessException(400, "QUOTE_REQUEST_INVALID", "报价请求无效，请检查入住信息");
const unavailable = (): BusinessException =>
  new BusinessException(503, "BOOKING_SERVICE_UNAVAILABLE", "预订服务暂时不可用，请稍后重试");
const roomUnavailable = (): BusinessException =>
  new BusinessException(404, "ROOM_NOT_AVAILABLE", "房型当前不可预订");
const capacityExceeded = (): BusinessException =>
  new BusinessException(422, "ROOM_CAPACITY_EXCEEDED", "入住人数超过房型容量");

const isValidDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.getTime());

@Injectable()
export class QuotesService {
  constructor(
    private readonly repository: QuoteRepository,
    private readonly rateLimit: WriteRateLimitService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async create(userId: string, request: unknown): Promise<QuoteResponseData> {
    const parsed = createQuoteRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw invalidRequest();
    }
    if (!UUID_PATTERN.test(userId)) {
      throw unavailable();
    }

    await this.rateLimit.checkQuotes(userId);

    let capturedAt: Date;
    try {
      capturedAt = this.clock.now();
      if (!isValidDate(capturedAt)) {
        throw new Error("Invalid clock");
      }
      capturedAt = new Date(capturedAt.getTime());
    } catch {
      throw unavailable();
    }

    let range;
    try {
      range = parseCatalogDateRange(parsed.data.checkin, parsed.data.checkout, {
        now: () => new Date(capturedAt.getTime()),
      });
    } catch (error) {
      if (error instanceof BusinessException && error.getStatus() === 400) {
        throw invalidRequest();
      }
      throw unavailable();
    }

    try {
      const lookup = await this.repository.findQuoteInput(parsed.data.room_type_id, {
        ...range,
        guests: parsed.data.guests,
      });
      if (lookup.status === "NOT_AVAILABLE") {
        throw roomUnavailable();
      }
      if (lookup.status === "CAPACITY_EXCEEDED") {
        throw capacityExceeded();
      }
      if (
        lookup.nightlyPrices.length !== range.nights ||
        lookup.nightlyPrices.some((night) => !night.available)
      ) {
        throw roomUnavailable();
      }

      let totalPriceCents = 0;
      for (const nightlyPrice of lookup.nightlyPrices) {
        totalPriceCents += nightlyPrice.salePriceCents;
        if (!Number.isSafeInteger(totalPriceCents)) {
          throw unavailable();
        }
      }

      const propertySnapshot = {
        id: lookup.property.id,
        name: lookup.property.name,
      };
      const roomTypeSnapshot = {
        id: lookup.roomType.id,
        name: lookup.roomType.name,
        cover_url: lookup.roomType.coverUrl,
      };
      const nightlyPrices = lookup.nightlyPrices.map((nightlyPrice) => ({
        business_date: nightlyPrice.businessDate,
        sale_price_cents: nightlyPrice.salePriceCents,
        rack_price_cents: nightlyPrice.rackPriceCents,
        currency: "CNY" as const,
      }));
      const expiresAt = new Date(capturedAt.getTime() + 5 * 60_000);
      const fingerprint = createQuoteFingerprint({
        property: propertySnapshot,
        roomType: {
          id: lookup.roomType.id,
          name: lookup.roomType.name,
          coverUrl: lookup.roomType.coverUrl,
        },
        checkin: range.checkin,
        checkout: range.checkout,
        guests: parsed.data.guests,
        bookingPolicy: lookup.roomType.bookingPolicy,
        nightlyPrices: lookup.nightlyPrices.map(
          ({ businessDate, salePriceCents, rackPriceCents }) => ({
            businessDate,
            salePriceCents,
            rackPriceCents,
          }),
        ),
      });

      const record = await this.repository.createQuote({
        userId,
        propertyId: lookup.property.id,
        roomTypeId: lookup.roomType.id,
        checkin: range.checkin,
        checkout: range.checkout,
        guests: parsed.data.guests,
        propertySnapshot,
        roomTypeSnapshot,
        nightlyPrices,
        bookingPolicySnapshot: lookup.roomType.bookingPolicy,
        totalPriceCents,
        currency: "CNY",
        fingerprint,
        expiresAt,
      });
      if (
        !UUID_PATTERN.test(record.id) ||
        !isValidDate(record.createdAt) ||
        !isValidDate(record.expiresAt) ||
        record.expiresAt.getTime() !== expiresAt.getTime()
      ) {
        throw unavailable();
      }

      const response = quoteResponseDataSchema.safeParse({
        quote_id: record.id,
        property: propertySnapshot,
        room_type: roomTypeSnapshot,
        checkin: range.checkin,
        checkout: range.checkout,
        nights: range.nights,
        guests: parsed.data.guests,
        nightly_prices: nightlyPrices,
        total_price_cents: totalPriceCents,
        currency: "CNY",
        booking_policy: lookup.roomType.bookingPolicy,
        expires_at: record.expiresAt.toISOString(),
      });
      if (!response.success) {
        throw unavailable();
      }
      return response.data;
    } catch (error) {
      if (error instanceof BusinessException) {
        throw error;
      }
      throw unavailable();
    }
  }
}

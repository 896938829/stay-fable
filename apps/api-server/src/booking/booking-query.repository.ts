import { Inject, Injectable } from "@nestjs/common";

import { DatabaseService } from "../database/database.service.js";
import { Prisma } from "../generated/prisma/client.js";

export interface BookingQueryDatabase {
  $queryRaw<T = unknown>(query: Prisma.Sql): PromiseLike<T>;
}

export interface BookingListRepositoryInput {
  limit: number;
  after?: {
    createdAt: string;
    id: string;
  };
}

export interface BookingListRepositoryRow {
  id: string;
  bookingNumber: string;
  status: string;
  propertySnapshot: unknown;
  roomTypeSnapshot: unknown;
  checkin: string;
  checkout: string;
  guests: unknown;
  totalPriceCents: unknown;
  currency: string;
  expiresAt: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface BookingDetailRepositoryRow extends BookingListRepositoryRow {
  nightlyPrices: unknown;
  bookingPolicy: string;
  latestPayment: unknown;
  statusHistory: unknown;
}

const baseSelection = Prisma.sql`
  booking."id"::text AS "id",
  booking."booking_number" AS "bookingNumber",
  booking."status"::text AS "status",
  booking."property_snapshot" AS "propertySnapshot",
  booking."room_type_snapshot" AS "roomTypeSnapshot",
  booking."checkin_date"::text AS "checkin",
  booking."checkout_date"::text AS "checkout",
  booking."guests" AS "guests",
  booking."total_price_cents" AS "totalPriceCents",
  booking."currency" AS "currency",
  booking."expires_at" AS "expiresAt",
  booking."created_at" AS "createdAt",
  booking."updated_at" AS "updatedAt"
`;

@Injectable()
export class BookingQueryRepository {
  constructor(
    @Inject(DatabaseService)
    private readonly database: BookingQueryDatabase,
  ) {}

  listOwned(
    userId: string,
    input: BookingListRepositoryInput,
  ): PromiseLike<BookingListRepositoryRow[]> {
    const afterCreatedAt = input.after?.createdAt ?? null;
    const afterId = input.after?.id ?? null;
    return this.database.$queryRaw<BookingListRepositoryRow[]>(Prisma.sql`
      SELECT ${baseSelection}
      FROM "booking" booking
      WHERE booking."user_id" = ${userId}::uuid
        AND (
          ${afterCreatedAt}::timestamptz IS NULL
          OR (booking."created_at", booking."id")
            < (${afterCreatedAt}::timestamptz, ${afterId}::uuid)
        )
      ORDER BY booking."created_at" DESC, booking."id" DESC
      LIMIT ${input.limit + 1}
    `);
  }

  async findOwned(userId: string, bookingId: string): Promise<BookingDetailRepositoryRow | null> {
    const bookings = await this.database.$queryRaw<
      Array<BookingListRepositoryRow & { bookingPolicy: string; nightlyPrices: unknown }>
    >(Prisma.sql`
      SELECT
        ${baseSelection},
        booking."nightly_prices" AS "nightlyPrices",
        booking."booking_policy_snapshot" AS "bookingPolicy"
      FROM "booking" booking
      WHERE booking."id" = ${bookingId}::uuid
        AND booking."user_id" = ${userId}::uuid
      LIMIT 1
    `);
    const booking = bookings[0];
    if (booking === undefined) {
      return null;
    }

    const payments = await this.database.$queryRaw<
      Array<{ paymentNumber: string; processedAt: unknown; status: string }>
    >(Prisma.sql`
      SELECT
        payment."payment_number" AS "paymentNumber",
        payment."status"::text AS "status",
        payment."processed_at" AS "processedAt"
      FROM "payment" payment
      WHERE payment."booking_id" = ${bookingId}::uuid
      ORDER BY payment."created_at" DESC, payment."id" DESC
      LIMIT 1
    `);
    const statusHistory = await this.database.$queryRaw<
      Array<{
        actorType: string;
        createdAt: unknown;
        fromStatus: string | null;
        reason: string;
        toStatus: string;
      }>
    >(Prisma.sql`
      SELECT
        history."from_status"::text AS "fromStatus",
        history."to_status"::text AS "toStatus",
        history."reason" AS "reason",
        history."actor_type" AS "actorType",
        history."created_at" AS "createdAt"
      FROM "booking_status_history" history
      WHERE history."booking_id" = ${bookingId}::uuid
      ORDER BY history."created_at" ASC, history."id" ASC
      LIMIT 100
    `);

    return {
      ...booking,
      latestPayment: payments[0] ?? null,
      statusHistory,
    };
  }
}

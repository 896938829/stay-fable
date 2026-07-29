import { Injectable } from "@nestjs/common";
import type { PropertyType } from "@stay-fable/api-contracts/catalog";

import { DatabaseService } from "../database/database.service.js";
import { Prisma } from "../generated/prisma/client.js";

export interface CatalogAvailabilityInput {
  checkin: string;
  checkout: string;
  nights: number;
  guests: number;
}

export interface CatalogListInput extends CatalogAvailabilityInput {
  cityId: string;
  propertyType?: PropertyType;
  pageSize: number;
  after?: { displayOrder: number; propertyId: string };
}

export interface CatalogListRow {
  id: string;
  type: PropertyType;
  name: string;
  cityId: string;
  cityCode: string;
  cityName: string;
  coverUrl: string;
  shortDescription: string;
  displayOrder: number;
  fromNightlyPriceCents: number;
  availableRoomTypeCount: number;
}

export interface CatalogListResult {
  rows: CatalogListRow[];
  nextAfter: { displayOrder: number; propertyId: string } | null;
}

export interface CatalogFacilityRow {
  code: string;
  name: string;
}

export interface CatalogMediaRow {
  type: "IMAGE";
  url: string;
  alt: string;
}

export interface CatalogRoomSummaryRow {
  id: string;
  name: string;
  bedType: string;
  areaSqm: number;
  maxGuests: number;
  coverUrl: string;
  bookingPolicy: string;
  fromNightlyPriceCents: number;
}

export interface CatalogPropertyDetailRow {
  id: string;
  type: PropertyType;
  name: string;
  cityId: string;
  cityCode: string;
  cityName: string;
  address: string;
  description: string;
  policies: string;
  coverUrl: string;
  media: CatalogMediaRow[];
  facilities: CatalogFacilityRow[];
  roomTypes: CatalogRoomSummaryRow[];
}

export interface CatalogNightlyPriceRow {
  businessDate: string;
  salePriceCents: number;
  rackPriceCents: number;
}

export interface CatalogRoomDetailRow {
  id: string;
  name: string;
  bedType: string;
  areaSqm: number;
  maxGuests: number;
  coverUrl: string;
  description: string;
  bookingPolicy: string;
  propertyId: string;
  propertyType: PropertyType;
  propertyName: string;
  cityId: string;
  cityCode: string;
  cityName: string;
  nightlyPrices: CatalogNightlyPriceRow[];
}

export type CatalogRoomLookup =
  | { status: "NOT_AVAILABLE" }
  | { status: "CAPACITY_EXCEEDED" }
  | { status: "AVAILABLE"; room: CatalogRoomDetailRow };

type DatabaseInteger = bigint | number | Prisma.Decimal;
type DatabaseDecimal = number | Prisma.Decimal;

type ListDatabaseRow = Omit<
  CatalogListRow,
  "type" | "displayOrder" | "fromNightlyPriceCents" | "availableRoomTypeCount"
> & {
  type: string;
  displayOrder: DatabaseInteger;
  fromNightlyPriceCents: DatabaseInteger;
  availableRoomTypeCount: DatabaseInteger;
};

type FacilityHighlightDatabaseRow = {
  propertyId: string;
  name: string;
};

type PropertyRoomDatabaseRow = {
  id: string;
  type: string;
  name: string;
  cityId: string;
  cityCode: string;
  cityName: string;
  address: string;
  description: string;
  policies: string;
  coverUrl: string;
  roomId: string;
  roomName: string;
  bedType: string;
  areaSqm: DatabaseDecimal;
  maxGuests: DatabaseInteger;
  roomCoverUrl: string;
  bookingPolicy: string;
  roomDisplayOrder: DatabaseInteger;
  fromNightlyPriceCents: DatabaseInteger;
};

type MediaDatabaseRow = {
  type: string;
  url: string;
  alt: string;
};

type FacilityDatabaseRow = CatalogFacilityRow;

type RoomBaseDatabaseRow = {
  id: string;
  name: string;
  bedType: string;
  areaSqm: DatabaseDecimal;
  maxGuests: DatabaseInteger;
  coverUrl: string;
  description: string;
  bookingPolicy: string;
  roomStatus: string;
  propertyId: string;
  propertyType: string;
  propertyName: string;
  propertyStatus: string;
  cityId: string;
  cityCode: string;
  cityName: string;
  cityEnabled: boolean;
};

type NightlyPriceDatabaseRow = {
  businessDate: string;
  salePriceCents: DatabaseInteger;
  rackPriceCents: DatabaseInteger;
};

const toPropertyType = (value: string): PropertyType => {
  if (value === "HOTEL" || value === "HOMESTAY" || value === "FARM_STAY") {
    return value;
  }

  throw new Error(`Unexpected property type from database: ${value}`);
};

const toSafeInteger = (value: DatabaseInteger, column: string): number => {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted)) {
    throw new Error(`Unexpected unsafe integer in database column ${column}`);
  }

  if (value instanceof Prisma.Decimal && !new Prisma.Decimal(converted).equals(value)) {
    throw new Error(`Unexpected inexact integer in database column ${column}`);
  }

  return converted;
};

const toPositiveDecimal = (value: DatabaseDecimal, column: string): number => {
  const converted = Number(value);
  if (!Number.isFinite(converted) || converted <= 0) {
    throw new Error(`Unexpected non-positive decimal in database column ${column}`);
  }

  if (value instanceof Prisma.Decimal && !new Prisma.Decimal(converted).equals(value)) {
    throw new Error(`Unexpected inexact decimal in database column ${column}`);
  }

  return converted;
};

const toMediaType = (value: string): "IMAGE" => {
  if (value !== "IMAGE") {
    throw new Error(`Unexpected property media type from database: ${value}`);
  }

  return value;
};

@Injectable()
export class CatalogRepository {
  constructor(private readonly database: DatabaseService) {}

  async listProperties(input: CatalogListInput): Promise<CatalogListResult> {
    const propertyType = input.propertyType ?? null;
    const afterDisplayOrder = input.after?.displayOrder ?? null;
    const afterPropertyId = input.after?.propertyId ?? null;
    const databaseRows = await this.database.$queryRaw<ListDatabaseRow[]>(
      Prisma.sql`
        WITH requested_dates AS (
          SELECT generate_series(
            ${input.checkin}::date,
            ${input.checkout}::date - 1,
            interval '1 day'
          )::date AS business_date
        ),
        eligible_rooms AS (
          SELECT
            room."id",
            room."property_id",
            MIN(price."sale_price_cents")::integer AS "fromNightlyPriceCents"
          FROM "room_type" room
          CROSS JOIN requested_dates requested
          JOIN "daily_price" price
            ON price."room_type_id" = room."id"
           AND price."business_date" = requested.business_date
          JOIN "daily_inventory" inventory
            ON inventory."room_type_id" = room."id"
           AND inventory."business_date" = requested.business_date
          WHERE room."status" = 'ON_SALE'::"RoomTypeStatus"
            AND room."max_guests" >= ${input.guests}
            AND inventory."total_inventory"
                - inventory."held_inventory"
                - inventory."sold_inventory" > 0
          GROUP BY room."id", room."property_id"
          HAVING COUNT(*) = ${input.nights}
        ),
        available_properties AS (
          SELECT
            "property_id",
            MIN("fromNightlyPriceCents")::integer AS "fromNightlyPriceCents",
            COUNT(*)::bigint AS "availableRoomTypeCount"
          FROM eligible_rooms
          GROUP BY "property_id"
        )
        SELECT
          property."id"::text AS "id",
          property."type"::text AS "type",
          property."name_zh" AS "name",
          city."id"::text AS "cityId",
          city."code" AS "cityCode",
          city."name_zh" AS "cityName",
          property."cover_url" AS "coverUrl",
          property."short_description_zh" AS "shortDescription",
          property."display_order" AS "displayOrder",
          available."fromNightlyPriceCents",
          available."availableRoomTypeCount"
        FROM "property" property
        JOIN "city" city
          ON city."id" = property."city_id"
         AND city."enabled" = true
        JOIN available_properties available
          ON available."property_id" = property."id"
        WHERE property."city_id" = ${input.cityId}::uuid
          AND property."status" = 'OPEN'::"PropertyStatus"
          AND (
            ${propertyType}::"PropertyType" IS NULL
            OR property."type" = ${propertyType}::"PropertyType"
          )
          AND (
            ${afterDisplayOrder}::integer IS NULL
            OR (property."display_order", property."id")
              > (${afterDisplayOrder}::integer, ${afterPropertyId}::uuid)
          )
        ORDER BY property."display_order" ASC, property."id" ASC
        LIMIT ${input.pageSize + 1}
      `,
    );
    const hasNextPage = databaseRows.length > input.pageSize;
    const rows = databaseRows.slice(0, input.pageSize).map((row) => this.mapListRow(row));
    const lastReturned = rows.at(-1);

    return {
      rows,
      nextAfter:
        hasNextPage && lastReturned !== undefined
          ? {
              displayOrder: lastReturned.displayOrder,
              propertyId: lastReturned.id,
            }
          : null,
    };
  }

  async listFacilityHighlights(propertyIds: string[]): Promise<Map<string, string[]>> {
    if (propertyIds.length === 0) {
      return new Map();
    }

    const rows = await this.database.$queryRaw<FacilityHighlightDatabaseRow[]>(
      Prisma.sql`
        SELECT
          link."property_id"::text AS "propertyId",
          facility."name_zh" AS "name"
        FROM "property_facility" link
        JOIN "facility" facility ON facility."id" = link."facility_id"
        WHERE link."property_id" IN (
          ${Prisma.join(propertyIds.map((propertyId) => Prisma.sql`${propertyId}::uuid`))}
        )
        ORDER BY link."property_id" ASC, facility."display_order" ASC, facility."id" ASC
      `,
    );
    const highlights = new Map<string, string[]>();
    for (const row of rows) {
      const propertyHighlights = highlights.get(row.propertyId) ?? [];
      if (propertyHighlights.length < 4) {
        propertyHighlights.push(row.name);
        highlights.set(row.propertyId, propertyHighlights);
      }
    }

    return highlights;
  }

  async findProperty(
    propertyId: string,
    input: CatalogAvailabilityInput,
  ): Promise<CatalogPropertyDetailRow | null> {
    const propertyRooms = await this.database.$queryRaw<PropertyRoomDatabaseRow[]>(
      Prisma.sql`
        WITH requested_dates AS (
          SELECT generate_series(
            ${input.checkin}::date,
            ${input.checkout}::date - 1,
            interval '1 day'
          )::date AS business_date
        ),
        eligible_rooms AS (
          SELECT
            room."id",
            MIN(price."sale_price_cents")::integer AS "fromNightlyPriceCents"
          FROM "room_type" room
          CROSS JOIN requested_dates requested
          JOIN "daily_price" price
            ON price."room_type_id" = room."id"
           AND price."business_date" = requested.business_date
          JOIN "daily_inventory" inventory
            ON inventory."room_type_id" = room."id"
           AND inventory."business_date" = requested.business_date
          WHERE room."property_id" = ${propertyId}::uuid
            AND room."status" = 'ON_SALE'::"RoomTypeStatus"
            AND room."max_guests" >= ${input.guests}
            AND inventory."total_inventory"
                - inventory."held_inventory"
                - inventory."sold_inventory" > 0
          GROUP BY room."id"
          HAVING COUNT(*) = ${input.nights}
        )
        SELECT
          property."id"::text AS "id",
          property."type"::text AS "type",
          property."name_zh" AS "name",
          city."id"::text AS "cityId",
          city."code" AS "cityCode",
          city."name_zh" AS "cityName",
          property."address_zh" AS "address",
          property."description_zh" AS "description",
          property."policies_zh" AS "policies",
          property."cover_url" AS "coverUrl",
          room."id"::text AS "roomId",
          room."name_zh" AS "roomName",
          room."bed_type_zh" AS "bedType",
          room."area_sqm" AS "areaSqm",
          room."max_guests" AS "maxGuests",
          room."cover_url" AS "roomCoverUrl",
          room."booking_policy_zh" AS "bookingPolicy",
          room."display_order" AS "roomDisplayOrder",
          eligible."fromNightlyPriceCents"
        FROM "property" property
        JOIN "city" city
          ON city."id" = property."city_id"
         AND city."enabled" = true
        JOIN "room_type" room ON room."property_id" = property."id"
        JOIN eligible_rooms eligible ON eligible."id" = room."id"
        WHERE property."id" = ${propertyId}::uuid
          AND property."status" = 'OPEN'::"PropertyStatus"
        ORDER BY room."display_order" ASC, room."id" ASC
      `,
    );
    const first = propertyRooms[0];
    if (first === undefined) {
      return null;
    }

    const [mediaRows, facilityRows] = await Promise.all([
      this.database.$queryRaw<MediaDatabaseRow[]>(
        Prisma.sql`
          SELECT
            media."type"::text AS "type",
            media."url" AS "url",
            media."alt_zh" AS "alt"
          FROM "property_media" media
          WHERE media."property_id" = ${propertyId}::uuid
          ORDER BY media."display_order" ASC, media."id" ASC
        `,
      ),
      this.database.$queryRaw<FacilityDatabaseRow[]>(
        Prisma.sql`
          SELECT facility."code" AS "code", facility."name_zh" AS "name"
          FROM "property_facility" link
          JOIN "facility" facility ON facility."id" = link."facility_id"
          WHERE link."property_id" = ${propertyId}::uuid
          ORDER BY facility."display_order" ASC, facility."id" ASC
        `,
      ),
    ]);

    return {
      id: first.id,
      type: toPropertyType(first.type),
      name: first.name,
      cityId: first.cityId,
      cityCode: first.cityCode,
      cityName: first.cityName,
      address: first.address,
      description: first.description,
      policies: first.policies,
      coverUrl: first.coverUrl,
      media: mediaRows.map((row) => ({
        type: toMediaType(row.type),
        url: row.url,
        alt: row.alt,
      })),
      facilities: facilityRows,
      roomTypes: propertyRooms.map((room) => ({
        id: room.roomId,
        name: room.roomName,
        bedType: room.bedType,
        areaSqm: toPositiveDecimal(room.areaSqm, "areaSqm"),
        maxGuests: toSafeInteger(room.maxGuests, "maxGuests"),
        coverUrl: room.roomCoverUrl,
        bookingPolicy: room.bookingPolicy,
        fromNightlyPriceCents: toSafeInteger(room.fromNightlyPriceCents, "fromNightlyPriceCents"),
      })),
    };
  }

  async findRoomType(
    roomTypeId: string,
    input: CatalogAvailabilityInput,
  ): Promise<CatalogRoomLookup> {
    const baseRows = await this.database.$queryRaw<RoomBaseDatabaseRow[]>(
      Prisma.sql`
        SELECT
          room."id"::text AS "id",
          room."name_zh" AS "name",
          room."bed_type_zh" AS "bedType",
          room."area_sqm" AS "areaSqm",
          room."max_guests" AS "maxGuests",
          room."cover_url" AS "coverUrl",
          room."description_zh" AS "description",
          room."booking_policy_zh" AS "bookingPolicy",
          room."status"::text AS "roomStatus",
          property."id"::text AS "propertyId",
          property."type"::text AS "propertyType",
          property."name_zh" AS "propertyName",
          property."status"::text AS "propertyStatus",
          city."id"::text AS "cityId",
          city."code" AS "cityCode",
          city."name_zh" AS "cityName",
          city."enabled" AS "cityEnabled"
        FROM "room_type" room
        JOIN "property" property ON property."id" = room."property_id"
        JOIN "city" city ON city."id" = property."city_id"
        WHERE room."id" = ${roomTypeId}::uuid
      `,
    );
    const base = baseRows[0];
    if (
      base === undefined ||
      !base.cityEnabled ||
      base.propertyStatus !== "OPEN" ||
      base.roomStatus !== "ON_SALE"
    ) {
      return { status: "NOT_AVAILABLE" };
    }

    const maxGuests = toSafeInteger(base.maxGuests, "maxGuests");
    if (maxGuests < input.guests) {
      return { status: "CAPACITY_EXCEEDED" };
    }

    const nightlyRows = await this.database.$queryRaw<NightlyPriceDatabaseRow[]>(
      Prisma.sql`
        WITH requested_dates AS (
          SELECT generate_series(
            ${input.checkin}::date,
            ${input.checkout}::date - 1,
            interval '1 day'
          )::date AS business_date
        )
        SELECT
          requested.business_date::text AS "businessDate",
          price."sale_price_cents" AS "salePriceCents",
          price."rack_price_cents" AS "rackPriceCents"
        FROM requested_dates requested
        JOIN "daily_price" price
          ON price."room_type_id" = ${roomTypeId}::uuid
         AND price."business_date" = requested.business_date
        JOIN "daily_inventory" inventory
          ON inventory."room_type_id" = ${roomTypeId}::uuid
         AND inventory."business_date" = requested.business_date
         AND inventory."total_inventory"
             - inventory."held_inventory"
             - inventory."sold_inventory" > 0
        ORDER BY requested.business_date ASC
      `,
    );
    if (nightlyRows.length !== input.nights) {
      return { status: "NOT_AVAILABLE" };
    }

    return {
      status: "AVAILABLE",
      room: {
        id: base.id,
        name: base.name,
        bedType: base.bedType,
        areaSqm: toPositiveDecimal(base.areaSqm, "areaSqm"),
        maxGuests,
        coverUrl: base.coverUrl,
        description: base.description,
        bookingPolicy: base.bookingPolicy,
        propertyId: base.propertyId,
        propertyType: toPropertyType(base.propertyType),
        propertyName: base.propertyName,
        cityId: base.cityId,
        cityCode: base.cityCode,
        cityName: base.cityName,
        nightlyPrices: nightlyRows.map((row) => ({
          businessDate: row.businessDate,
          salePriceCents: toSafeInteger(row.salePriceCents, "salePriceCents"),
          rackPriceCents: toSafeInteger(row.rackPriceCents, "rackPriceCents"),
        })),
      },
    };
  }

  private mapListRow(row: ListDatabaseRow): CatalogListRow {
    return {
      id: row.id,
      type: toPropertyType(row.type),
      name: row.name,
      cityId: row.cityId,
      cityCode: row.cityCode,
      cityName: row.cityName,
      coverUrl: row.coverUrl,
      shortDescription: row.shortDescription,
      displayOrder: toSafeInteger(row.displayOrder, "displayOrder"),
      fromNightlyPriceCents: toSafeInteger(row.fromNightlyPriceCents, "fromNightlyPriceCents"),
      availableRoomTypeCount: toSafeInteger(row.availableRoomTypeCount, "availableRoomTypeCount"),
    };
  }
}

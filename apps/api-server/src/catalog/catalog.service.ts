import { Inject, Injectable } from "@nestjs/common";
import {
  type PropertyDetail,
  propertyDetailSchema,
  type PropertyListResponse,
  propertyListResponseSchema,
  type RoomTypeDetail,
  roomTypeDetailSchema,
} from "@stay-fable/api-contracts/catalog";

import { CLOCK, type Clock } from "../common/clock/clock.js";
import { BusinessException } from "../common/http/business.exception.js";
import { decodeCatalogCursor, encodeCatalogCursor } from "./catalog-cursor.js";
import { parseCatalogDateRange } from "./catalog-date-range.js";
import { CatalogRepository } from "./catalog.repository.js";
import type { AvailabilityQueryDto, PropertyListQueryDto } from "./dto/catalog-query.dto.js";

@Injectable()
export class CatalogService {
  constructor(
    private readonly repository: CatalogRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async listProperties(query: PropertyListQueryDto): Promise<PropertyListResponse> {
    const range = parseCatalogDateRange(query.checkin, query.checkout, this.clock);
    const after = query.cursor === undefined ? undefined : decodeCatalogCursor(query.cursor);
    const result = await this.repository.listProperties({
      cityId: query.city_id,
      ...range,
      guests: query.guests,
      ...(query.property_type === undefined ? {} : { propertyType: query.property_type }),
      pageSize: query.page_size ?? 10,
      ...(after === undefined ? {} : { after }),
    });
    const propertyIds = result.rows.map((row) => row.id);
    const highlights =
      propertyIds.length === 0
        ? new Map<string, string[]>()
        : await this.repository.listFacilityHighlights(propertyIds);

    return propertyListResponseSchema.parse({
      items: result.rows.map((row) => ({
        id: row.id,
        type: row.type,
        name: row.name,
        city: {
          id: row.cityId,
          code: row.cityCode,
          name: row.cityName,
        },
        cover_url: row.coverUrl,
        short_description: row.shortDescription,
        facility_highlights: highlights.get(row.id) ?? [],
        from_nightly_price_cents: row.fromNightlyPriceCents,
        currency: "CNY",
        available_room_type_count: row.availableRoomTypeCount,
      })),
      next_cursor: result.nextAfter === null ? null : encodeCatalogCursor(result.nextAfter),
    });
  }

  async getProperty(propertyId: string, query: AvailabilityQueryDto): Promise<PropertyDetail> {
    const range = parseCatalogDateRange(query.checkin, query.checkout, this.clock);
    const property = await this.repository.findProperty(propertyId, {
      ...range,
      guests: query.guests,
    });
    if (property === null) {
      throw new BusinessException(404, "PROPERTY_NOT_AVAILABLE", "住宿当前不可预订");
    }

    return propertyDetailSchema.parse({
      id: property.id,
      type: property.type,
      name: property.name,
      city: {
        id: property.cityId,
        code: property.cityCode,
        name: property.cityName,
      },
      address: property.address,
      description: property.description,
      policies: property.policies,
      cover_url: property.coverUrl,
      media: property.media,
      facilities: property.facilities,
      room_types: property.roomTypes.map((room) => ({
        id: room.id,
        name: room.name,
        bed_type: room.bedType,
        area_sqm: room.areaSqm,
        max_guests: room.maxGuests,
        cover_url: room.coverUrl,
        policy_summary: room.bookingPolicy,
        from_nightly_price_cents: room.fromNightlyPriceCents,
        currency: "CNY",
      })),
    });
  }

  async getRoomType(roomTypeId: string, query: AvailabilityQueryDto): Promise<RoomTypeDetail> {
    const range = parseCatalogDateRange(query.checkin, query.checkout, this.clock);
    const lookup = await this.repository.findRoomType(roomTypeId, {
      ...range,
      guests: query.guests,
    });
    if (lookup.status === "CAPACITY_EXCEEDED") {
      throw new BusinessException(422, "ROOM_CAPACITY_EXCEEDED", "入住人数超过房型容量");
    }
    if (lookup.status === "NOT_AVAILABLE") {
      throw new BusinessException(404, "ROOM_NOT_AVAILABLE", "房型当前不可预订");
    }

    const room = lookup.room;
    return roomTypeDetailSchema.parse({
      id: room.id,
      name: room.name,
      bed_type: room.bedType,
      area_sqm: room.areaSqm,
      max_guests: room.maxGuests,
      cover_url: room.coverUrl,
      currency: "CNY",
      property: {
        id: room.propertyId,
        type: room.propertyType,
        name: room.propertyName,
        city: {
          id: room.cityId,
          code: room.cityCode,
          name: room.cityName,
        },
      },
      description: room.description,
      booking_policy: room.bookingPolicy,
      nightly_prices: room.nightlyPrices.map((nightlyPrice) => ({
        business_date: nightlyPrice.businessDate,
        sale_price_cents: nightlyPrice.salePriceCents,
        rack_price_cents: nightlyPrice.rackPriceCents,
        currency: "CNY",
      })),
    });
  }
}

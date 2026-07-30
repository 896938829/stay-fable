"use strict";

function ref(target) {
  return { kind: "ref", target };
}

function items(target) {
  return { kind: "items", target };
}

const shapes = {
  AuthSessionResponseDto: {
    fields: ["access_token", "access_expires_in", "refresh_token", "refresh_expires_in", "user"],
    edges: { user: ref("AuthSessionUserDto") },
  },
  AuthSessionUserDto: { fields: ["id"], edges: {} },
  AuthSessionEnvelopeDto: {
    fields: ["data", "request_id"],
    edges: { data: ref("AuthSessionResponseDto") },
  },
  BookingDetailEnvelopeDto: {
    fields: ["data", "request_id"],
    edges: { data: ref("BookingDetailDto") },
  },
  BookingDetailDto: {
    fields: [
      "booking_id",
      "booking_number",
      "status",
      "property_name",
      "room_type_name",
      "checkin",
      "checkout",
      "nights",
      "guests",
      "total_price_cents",
      "currency",
      "expires_at",
      "payment_deadline_passed",
      "created_at",
      "updated_at",
      "nightly_prices",
      "booking_policy",
      "latest_payment",
      "status_history",
      "allowed_actions",
    ],
    edges: {
      nightly_prices: items("BookingNightlyPriceDto"),
      latest_payment: ref("BookingPaymentSummaryDto"),
      status_history: items("BookingStatusHistoryItemDto"),
    },
  },
  BookingListItemDto: {
    fields: [
      "booking_id",
      "booking_number",
      "status",
      "property_name",
      "room_type_name",
      "checkin",
      "checkout",
      "nights",
      "guests",
      "total_price_cents",
      "currency",
      "expires_at",
      "payment_deadline_passed",
      "created_at",
      "updated_at",
    ],
    edges: {},
  },
  BookingListResponseDto: {
    fields: ["items", "next_cursor"],
    edges: { items: items("BookingListItemDto") },
  },
  BookingListEnvelopeDto: {
    fields: ["data", "request_id"],
    edges: { data: ref("BookingListResponseDto") },
  },
  BookingNightlyPriceDto: {
    fields: ["business_date", "sale_price_cents", "rack_price_cents", "currency"],
    edges: {},
  },
  BookingPaymentSummaryDto: {
    fields: ["payment_number", "status", "processed_at"],
    edges: {},
  },
  BookingResponseDto: {
    fields: [
      "booking_id",
      "quote_id",
      "booking_number",
      "status",
      "property_name",
      "room_type_name",
      "checkin",
      "checkout",
      "nights",
      "guests",
      "total_price_cents",
      "currency",
      "expires_at",
      "created_at",
    ],
    edges: {},
  },
  BookingEnvelopeDto: {
    fields: ["data", "request_id"],
    edges: { data: ref("BookingResponseDto") },
  },
  BookingStatusHistoryItemDto: {
    fields: ["from_status", "to_status", "reason", "actor_type", "created_at"],
    edges: {},
  },
  CatalogCityDto: { fields: ["id", "code", "name"], edges: {} },
  CatalogFacilityDto: { fields: ["code", "name"], edges: {} },
  CatalogMediaDto: { fields: ["type", "url", "alt"], edges: {} },
  CityResponseDto: { fields: ["id", "code", "name"], edges: {} },
  NightlyPriceDto: {
    fields: ["business_date", "sale_price_cents", "rack_price_cents", "currency"],
    edges: {},
  },
  PropertyDetailResponseDto: {
    fields: [
      "id",
      "type",
      "name",
      "city",
      "address",
      "description",
      "policies",
      "cover_url",
      "media",
      "facilities",
      "room_types",
    ],
    edges: {
      city: ref("CatalogCityDto"),
      media: items("CatalogMediaDto"),
      facilities: items("CatalogFacilityDto"),
      room_types: items("RoomTypeSummaryDto"),
    },
  },
  PropertyDetailEnvelopeDto: {
    fields: ["data", "request_id"],
    edges: { data: ref("PropertyDetailResponseDto") },
  },
  PropertyListItemDto: {
    fields: [
      "id",
      "type",
      "name",
      "city",
      "cover_url",
      "short_description",
      "facility_highlights",
      "from_nightly_price_cents",
      "currency",
      "available_room_type_count",
    ],
    edges: { city: ref("CatalogCityDto") },
  },
  PropertyListResponseDto: {
    fields: ["items", "next_cursor"],
    edges: { items: items("PropertyListItemDto") },
  },
  PropertyListEnvelopeDto: {
    fields: ["data", "request_id"],
    edges: { data: ref("PropertyListResponseDto") },
  },
  QuoteNightlyPriceDto: {
    fields: ["business_date", "sale_price_cents", "rack_price_cents", "currency"],
    edges: {},
  },
  QuotePropertyDto: { fields: ["id", "name"], edges: {} },
  QuoteResponseDto: {
    fields: [
      "quote_id",
      "property",
      "room_type",
      "checkin",
      "checkout",
      "nights",
      "guests",
      "nightly_prices",
      "total_price_cents",
      "currency",
      "booking_policy",
      "expires_at",
    ],
    edges: {
      property: ref("QuotePropertyDto"),
      room_type: ref("QuoteRoomTypeDto"),
      nightly_prices: items("QuoteNightlyPriceDto"),
    },
  },
  QuoteEnvelopeDto: {
    fields: ["data", "request_id"],
    edges: { data: ref("QuoteResponseDto") },
  },
  QuoteRoomTypeDto: { fields: ["id", "name", "cover_url"], edges: {} },
  ResolvedLocationResponseDto: {
    fields: ["city", "distance_meters"],
    edges: { city: ref("CityResponseDto") },
  },
  ResolvedLocationEnvelopeDto: {
    fields: ["data", "request_id"],
    edges: { data: ref("ResolvedLocationResponseDto") },
  },
  RoomTypeDetailResponseDto: {
    fields: [
      "id",
      "name",
      "bed_type",
      "area_sqm",
      "max_guests",
      "cover_url",
      "currency",
      "property",
      "description",
      "booking_policy",
      "nightly_prices",
    ],
    edges: {
      property: ref("RoomTypePropertySummaryDto"),
      nightly_prices: items("NightlyPriceDto"),
    },
  },
  RoomTypeDetailEnvelopeDto: {
    fields: ["data", "request_id"],
    edges: { data: ref("RoomTypeDetailResponseDto") },
  },
  RoomTypePropertySummaryDto: {
    fields: ["id", "type", "name", "city"],
    edges: { city: ref("CatalogCityDto") },
  },
  RoomTypeSummaryDto: {
    fields: [
      "id",
      "name",
      "bed_type",
      "area_sqm",
      "max_guests",
      "cover_url",
      "policy_summary",
      "from_nightly_price_cents",
      "currency",
    ],
    edges: {},
  },
};

for (const shape of Object.values(shapes)) {
  Object.freeze(shape.fields);
  for (const edge of Object.values(shape.edges)) {
    Object.freeze(edge);
  }
  Object.freeze(shape.edges);
  Object.freeze(shape);
}

module.exports = Object.freeze(shapes);

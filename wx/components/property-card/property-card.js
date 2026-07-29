"use strict";

const {
  isSafeCatalogResourceUrl,
} = require("../../services/contracts");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TYPE_LABELS = {
  HOTEL: "酒店",
  HOMESTAY: "民宿",
  FARM_STAY: "农家乐",
};

function boundedText(value, maximum, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized !== "" && normalized.length <= maximum
    ? normalized
    : fallback;
}

function safeCoverUrl(value) {
  return isSafeCatalogResourceUrl(value) ? value : "";
}

function propertyTypeLabel(type) {
  return Object.prototype.hasOwnProperty.call(TYPE_LABELS, type)
    ? TYPE_LABELS[type]
    : "旅店";
}

function facilityHighlights(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const facilities = [];
  const seen = new Set();
  for (const item of value) {
    const normalized = boundedText(item, 80, "");
    if (normalized === "" || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    facilities.push(normalized);
    if (facilities.length === 4) {
      break;
    }
  }
  return facilities;
}

function isAvailablePrice(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function viewModelFor(property) {
  const source =
    property !== null && typeof property === "object" && !Array.isArray(property)
      ? property
      : {};
  const id =
    typeof source.id === "string" && UUID_PATTERN.test(source.id)
      ? source.id
      : "";
  const name = boundedText(source.name, 120, "旅店信息暂不可用");
  const facilities = facilityHighlights(source.facility_highlights);
  const priceAvailable = isAvailablePrice(source.from_nightly_price_cents);

  return {
    id,
    typeLabel: propertyTypeLabel(source.type),
    name,
    description: boundedText(source.short_description, 240, "暂无简介"),
    coverUrl: safeCoverUrl(source.cover_url),
    coverAlt:
      name === "旅店信息暂不可用" ? "旅店封面" : `${name}封面`,
    facilities,
    availableCount:
      Number.isSafeInteger(source.available_room_type_count) &&
      source.available_room_type_count > 0
        ? source.available_room_type_count
        : 0,
    priceCents: priceAvailable ? source.from_nightly_price_cents : null,
    priceAvailable,
    interactive: id !== "" && priceAvailable,
  };
}

const definition = {
  properties: {
    property: {
      type: Object,
      value: null,
    },
  },
  data: {
    coverFailed: false,
    viewModel: viewModelFor(null),
  },
  observers: {
    property(property) {
      this.setData({
        coverFailed: false,
        viewModel: viewModelFor(property),
      });
    },
  },
  methods: {
    handleCoverError(event) {
      const failedUrl = event?.currentTarget?.dataset?.src;
      const currentUrl = this.data?.viewModel?.coverUrl;
      if (
        typeof failedUrl !== "string" ||
        failedUrl === "" ||
        failedUrl !== currentUrl
      ) {
        return;
      }
      this.setData({
        coverFailed: true,
      });
    },
    handleTap() {
      const property = this.data.property;
      if (
        property === null ||
        typeof property !== "object" ||
        typeof property.id !== "string" ||
        !UUID_PATTERN.test(property.id) ||
        !isAvailablePrice(property.from_nightly_price_cents)
      ) {
        return;
      }
      this.triggerEvent("propertytap", { id: property.id });
    },
  },
};

if (typeof Component === "function") {
  Component(definition);
}

module.exports = definition;

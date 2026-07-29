"use strict";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_IMAGE_PATTERN =
  /^\/images\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
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
  if (typeof value !== "string" || value.length > 500) {
    return "";
  }
  if (value.startsWith("/images/")) {
    return LOCAL_IMAGE_PATTERN.test(value) &&
      value.split("/").every((segment) => segment !== "..")
      ? value
      : "";
  }
  return value.startsWith("https://") && !/[\s\\]/.test(value) ? value : "";
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
  const facilities = Array.isArray(source.facility_highlights)
    ? source.facility_highlights
        .map((item) => boundedText(item, 80, ""))
        .filter(Boolean)
        .slice(0, 4)
    : [];

  return {
    id,
    typeLabel: TYPE_LABELS[source.type] || "旅店",
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
    priceCents:
      Number.isSafeInteger(source.from_nightly_price_cents) &&
      source.from_nightly_price_cents >= 0
        ? source.from_nightly_price_cents
        : 0,
    interactive: id !== "",
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
    viewModel: viewModelFor(null),
  },
  observers: {
    property(property) {
      this.setData({
        viewModel: viewModelFor(property),
      });
    },
  },
  methods: {
    handleTap() {
      const property = this.data.property;
      if (
        property === null ||
        typeof property !== "object" ||
        typeof property.id !== "string" ||
        !UUID_PATTERN.test(property.id)
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

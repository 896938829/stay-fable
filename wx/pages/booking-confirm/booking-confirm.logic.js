"use strict";

const { formatMoney } = require("../../utils/money");

function remainingSeconds(expiresAt, now) {
  const expires = Date.parse(expiresAt);
  const current = typeof now === "number" ? now : Number(now);
  if (!Number.isFinite(expires) || !Number.isFinite(current)) {
    return 0;
  }
  return Math.max(0, Math.ceil((expires - current) / 1000));
}

function createQuoteView(quote, now) {
  const seconds = remainingSeconds(quote.expires_at, now);
  return {
    quoteId: quote.quote_id,
    property: {
      id: quote.property.id,
      name: quote.property.name,
    },
    roomType: {
      id: quote.room_type.id,
      name: quote.room_type.name,
      coverUrl: quote.room_type.cover_url,
    },
    checkin: quote.checkin,
    checkout: quote.checkout,
    nights: quote.nights,
    guests: quote.guests,
    nightlyPrices: quote.nightly_prices.map((night) => ({
      businessDate: night.business_date,
      salePriceCents: night.sale_price_cents,
      salePriceLabel: formatMoney(night.sale_price_cents),
      rackPriceCents: night.rack_price_cents,
      rackPriceLabel: formatMoney(night.rack_price_cents),
    })),
    totalPriceCents: quote.total_price_cents,
    totalPriceLabel: formatMoney(quote.total_price_cents),
    currency: quote.currency,
    bookingPolicy: quote.booking_policy,
    expiresAt: quote.expires_at,
    remainingSeconds: seconds,
    expired: seconds === 0,
  };
}

function createBookingView(booking) {
  return {
    bookingId: booking.booking_id,
    quoteId: booking.quote_id,
    bookingNumber: booking.booking_number,
    status: booking.status,
    propertyName: booking.property_name,
    roomTypeName: booking.room_type_name,
    checkin: booking.checkin,
    checkout: booking.checkout,
    nights: booking.nights,
    guests: booking.guests,
    totalPriceCents: booking.total_price_cents,
    totalPriceLabel: formatMoney(booking.total_price_cents),
    currency: booking.currency,
    expiresAt: booking.expires_at,
    createdAt: booking.created_at,
  };
}

function quoteChangedView(previousTotal, replacementQuote, now) {
  const replacement = createQuoteView(replacementQuote, now);
  return {
    previousTotalPriceCents: previousTotal,
    previousTotalPriceLabel: formatMoney(previousTotal),
    newTotalPriceCents: replacement.totalPriceCents,
    newTotalPriceLabel: replacement.totalPriceLabel,
    replacementQuote: replacement,
  };
}

module.exports = {
  createBookingView,
  createQuoteView,
  quoteChangedView,
  remainingSeconds,
};

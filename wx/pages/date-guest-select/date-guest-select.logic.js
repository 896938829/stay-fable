"use strict";

const { addDays, compareDates, formatDate, parseDate } = require("../../utils/date");

function invalidSelection() {
  const error = new Error("Invalid date or guest selection");
  error.code = "SEARCH_CONTEXT_INVALID";
  return error;
}

function changeCheckin(context, checkin, today) {
  try {
    parseDate(checkin);
    if (compareDates(checkin, today) < 0) {
      throw invalidSelection();
    }
    const latestCheckout = formatDate(addDays(checkin, 30));
    let checkout = context.checkout;
    if (compareDates(checkout, checkin) <= 0) {
      checkout = formatDate(addDays(checkin, 1));
    } else if (compareDates(checkout, latestCheckout) > 0) {
      checkout = latestCheckout;
    }
    return {
      ...context,
      checkin,
      checkout,
    };
  } catch {
    throw invalidSelection();
  }
}

function changeCheckout(context, checkout) {
  try {
    parseDate(checkout);
    if (
      compareDates(checkout, context.checkin) <= 0 ||
      compareDates(checkout, addDays(context.checkin, 30)) > 0
    ) {
      throw invalidSelection();
    }
    return { ...context, checkout };
  } catch {
    throw invalidSelection();
  }
}

function changeGuests(context, amount) {
  const guests = Math.min(10, Math.max(1, context.guests + amount));
  return { ...context, guests };
}

module.exports = {
  changeCheckin,
  changeCheckout,
  changeGuests,
};

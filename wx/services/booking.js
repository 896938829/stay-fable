"use strict";

const {
  assertBookingResponse,
  assertQuoteChangedDetails,
  assertQuoteResponse,
} = require("./contracts");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~-]{32,80}$/;

function bookingError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function invalidInput() {
  return bookingError("INVALID_BOOKING_INPUT", "Invalid booking input");
}

function invalidOptions() {
  return bookingError("INVALID_BOOKING_OPTIONS", "Invalid booking options");
}

function invalidEnvironment() {
  return bookingError(
    "INVALID_BOOKING_ENVIRONMENT",
    "Invalid booking environment",
  );
}

function cancelled() {
  return bookingError(
    "BOOKING_OPERATION_CANCELLED",
    "Booking operation cancelled",
  );
}

function plainOrNullPrototype(value) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readExactInput(value, keys) {
  try {
    if (!plainOrNullPrototype(value)) {
      throw invalidInput();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== keys.length
    ) {
      throw invalidInput();
    }
    const snapshot = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        throw invalidInput();
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    throw invalidInput();
  }
}

function parseDate(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    throw invalidInput();
  }
  const [year, month, day] = value.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const maximum = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > maximum) {
    throw invalidInput();
  }
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const dayOfYear =
    Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  return (
    era * 146097 +
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear
  );
}

function assertUuid(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw invalidInput();
  }
}

function snapshotQuoteInput(value) {
  const snapshot = readExactInput(value, [
    "room_type_id",
    "checkin",
    "checkout",
    "guests",
  ]);
  assertUuid(snapshot.room_type_id);
  const nights = parseDate(snapshot.checkout) - parseDate(snapshot.checkin);
  if (
    nights < 1 ||
    nights > 30 ||
    !Number.isInteger(snapshot.guests) ||
    snapshot.guests < 1 ||
    snapshot.guests > 10
  ) {
    throw invalidInput();
  }
  return snapshot;
}

function snapshotBookingInput(value) {
  const snapshot = readExactInput(value, ["quote_id"]);
  assertUuid(snapshot.quote_id);
  return snapshot;
}

function snapshotOptions(value) {
  if (value === undefined) {
    return Object.freeze({ isActive: () => true });
  }
  try {
    if (!plainOrNullPrototype(value)) {
      throw invalidOptions();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const descriptor = descriptors.isActive;
    if (
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== 1 ||
      !descriptor ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
      typeof descriptor.value !== "function"
    ) {
      throw invalidOptions();
    }
    return Object.freeze({ isActive: descriptor.value });
  } catch {
    throw invalidOptions();
  }
}

function assertActive(isActive) {
  let active;
  try {
    active = isActive();
  } catch {
    throw cancelled();
  }
  if (active !== true) {
    throw cancelled();
  }
}

function snapshotPost(environment) {
  try {
    if (!plainOrNullPrototype(environment)) {
      throw invalidEnvironment();
    }
    const descriptor = Object.getOwnPropertyDescriptor(environment, "post");
    if (
      !descriptor ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
      typeof descriptor.value !== "function"
    ) {
      throw invalidEnvironment();
    }
    return descriptor.value.bind(environment);
  } catch {
    throw invalidEnvironment();
  }
}

function createBookingService(requestClient) {
  const post = snapshotPost(requestClient);

  return {
    async createQuote(input, options) {
      const body = snapshotQuoteInput(input);
      const { isActive } = snapshotOptions(options);
      assertActive(isActive);
      const data = await post("/quotes", body, Object.freeze({ retry: false }));
      assertActive(isActive);
      return assertQuoteResponse(data, body.room_type_id);
    },

    async createBooking(input, idempotencyKey, options) {
      const body = snapshotBookingInput(input);
      if (
        typeof idempotencyKey !== "string" ||
        !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)
      ) {
        throw invalidInput();
      }
      const operation = snapshotOptions(options);
      assertActive(operation.isActive);
      try {
        const data = await post(
          "/bookings",
          body,
          Object.freeze({
            header: Object.freeze({ "Idempotency-Key": idempotencyKey }),
            retry: false,
          }),
        );
        assertActive(operation.isActive);
        return assertBookingResponse(data, body.quote_id);
      } catch (error) {
        assertActive(operation.isActive);
        if (error?.code === "QUOTE_CHANGED") {
          error.details = assertQuoteChangedDetails(error.details);
        }
        throw error;
      }
    },
  };
}

let defaultService;

function getDefaultService() {
  if (!defaultService) {
    defaultService = createBookingService(require("./request"));
  }
  return defaultService;
}

module.exports = {
  createBookingService,
  createQuote(input, options) {
    return getDefaultService().createQuote(input, options);
  },
  createBooking(input, idempotencyKey, options) {
    return getDefaultService().createBooking(input, idempotencyKey, options);
  },
};

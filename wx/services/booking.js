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
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_ERROR_MESSAGES = Object.freeze({
  AUTH_REAUTHENTICATION_FAILED: "Authentication failed",
  AUTH_SESSION_CHANGED: "Authentication session changed",
  AUTH_SESSION_EXPIRED: "Authentication session expired",
  AUTH_SESSION_OPERATION_CANCELLED: "Authentication operation cancelled",
  AUTH_SESSION_SERVICE_UNAVAILABLE: "Authentication service unavailable",
  AUTH_USER_DISABLED: "Authentication account unavailable",
  BOOKING_REQUEST_INVALID: "Booking request invalid",
  BOOKING_SERVICE_UNAVAILABLE: "Booking service unavailable",
  IDEMPOTENCY_KEY_INVALID: "Idempotency key invalid",
  INVALID_API_RESPONSE: "Invalid API response",
  INVALID_REQUEST_PATH: "Invalid request path",
  INVENTORY_UNAVAILABLE: "Inventory unavailable",
  NETWORK_REQUEST_FAILED: "Network request failed",
  QUOTE_ALREADY_USED: "Quote already used",
  QUOTE_CHANGED: "Quote changed",
  QUOTE_EXPIRED: "Quote expired",
  QUOTE_REQUEST_INVALID: "Quote request invalid",
  RATE_LIMITED: "Rate limited",
  ROOM_CAPACITY_EXCEEDED: "Room capacity exceeded",
  ROOM_NOT_AVAILABLE: "Room not available",
});
const SAFE_ERROR_KEYS = [
  "stack",
  "message",
  "name",
  "code",
  "statusCode",
  "requestId",
  "details",
];

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

function invalidApiResponse() {
  return bookingError("INVALID_API_RESPONSE", "Invalid API response");
}

function unavailable() {
  return bookingError(
    "BOOKING_SERVICE_UNAVAILABLE",
    "Booking service unavailable",
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

function snapshotExpectedQuote(value) {
  try {
    if (!plainOrNullPrototype(value)) {
      throw invalidOptions();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (
      Object.getOwnPropertySymbols(value).length !== 0 ||
      keys.some(
        (key) => key !== "property_id" && key !== "room_type_id",
      )
    ) {
      throw invalidOptions();
    }
    const property = descriptors.property_id;
    const room = descriptors.room_type_id;
    if (
      (property &&
        !Object.prototype.hasOwnProperty.call(property, "value")) ||
      (room && !Object.prototype.hasOwnProperty.call(room, "value"))
    ) {
      throw invalidOptions();
    }
    if (
      !property ||
      !room ||
      typeof property.value !== "string" ||
      !UUID_PATTERN.test(property.value) ||
      typeof room.value !== "string" ||
      !UUID_PATTERN.test(room.value)
    ) {
      return undefined;
    }
    return Object.freeze({
      property_id: property.value,
      room_type_id: room.value,
    });
  } catch {
    throw invalidOptions();
  }
}

function snapshotOptions(value, allowExpectedQuote) {
  if (value === undefined) {
    return Object.freeze({
      isActive: () => true,
      expectedQuote: undefined,
    });
  }
  try {
    if (!plainOrNullPrototype(value)) {
      throw invalidOptions();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    const allowed = allowExpectedQuote
      ? ["isActive", "expectedQuote"]
      : ["isActive"];
    if (
      Object.getOwnPropertySymbols(value).length !== 0 ||
      keys.some((key) => !allowed.includes(key))
    ) {
      throw invalidOptions();
    }
    const active = descriptors.isActive;
    const expected = descriptors.expectedQuote;
    if (
      (active &&
        (!Object.prototype.hasOwnProperty.call(active, "value") ||
          typeof active.value !== "function")) ||
      (expected &&
        !Object.prototype.hasOwnProperty.call(expected, "value"))
    ) {
      throw invalidOptions();
    }
    return Object.freeze({
      isActive: active ? active.value : () => true,
      expectedQuote: expected
        ? snapshotExpectedQuote(expected.value)
        : undefined,
    });
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

function snapshotDependencyError(value) {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      return undefined;
    }
    const prototype = Object.getPrototypeOf(value);
    if (
      prototype !== Error.prototype &&
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (
      Object.getOwnPropertySymbols(value).length !== 0 ||
      keys.some((key) => !SAFE_ERROR_KEYS.includes(key))
    ) {
      return undefined;
    }
    const code = descriptors.code;
    if (
      !code ||
      !Object.prototype.hasOwnProperty.call(code, "value") ||
      typeof code.value !== "string" ||
      !Object.prototype.hasOwnProperty.call(SAFE_ERROR_MESSAGES, code.value)
    ) {
      return undefined;
    }
    const status = descriptors.statusCode;
    const request = descriptors.requestId;
    if (
      (status &&
        (!Object.prototype.hasOwnProperty.call(status, "value") ||
          !Number.isInteger(status.value) ||
          status.value < 400 ||
          status.value > 599)) ||
      (request &&
        (!Object.prototype.hasOwnProperty.call(request, "value") ||
          typeof request.value !== "string" ||
          !REQUEST_ID_PATTERN.test(request.value)))
    ) {
      return undefined;
    }
    const details = descriptors.details;
    return {
      code: code.value,
      statusCode: status ? status.value : undefined,
      requestId: request ? request.value : undefined,
      details:
        details && Object.prototype.hasOwnProperty.call(details, "value")
          ? details.value
          : undefined,
      detailsValid:
        !details || Object.prototype.hasOwnProperty.call(details, "value"),
    };
  } catch {
    return undefined;
  }
}

function assertRateLimitDetails(value) {
  try {
    if (!plainOrNullPrototype(value)) {
      throw invalidApiResponse();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const retry = descriptors.retry_after_seconds;
    if (
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).length !== 1 ||
      !retry ||
      !Object.prototype.hasOwnProperty.call(retry, "value") ||
      !Number.isInteger(retry.value) ||
      retry.value < 1 ||
      retry.value > 60
    ) {
      throw invalidApiResponse();
    }
    return { retry_after_seconds: retry.value };
  } catch {
    throw invalidApiResponse();
  }
}

function normalizeDependencyError(value, expectedQuote) {
  const snapshot = snapshotDependencyError(value);
  if (!snapshot) {
    return unavailable();
  }
  const error = bookingError(
    snapshot.code,
    SAFE_ERROR_MESSAGES[snapshot.code],
  );
  if (snapshot.statusCode !== undefined) {
    error.statusCode = snapshot.statusCode;
  }
  if (snapshot.requestId !== undefined) {
    error.requestId = snapshot.requestId;
  }
  if (snapshot.code === "QUOTE_CHANGED") {
    if (!snapshot.detailsValid) {
      throw invalidApiResponse();
    }
    error.details = assertQuoteChangedDetails(
      snapshot.details,
      expectedQuote,
    );
  } else if (snapshot.code === "RATE_LIMITED") {
    if (!snapshot.detailsValid) {
      throw invalidApiResponse();
    }
    error.details = assertRateLimitDetails(snapshot.details);
  }
  return error;
}

function createBookingService(requestClient) {
  const post = snapshotPost(requestClient);

  return {
    async createQuote(input, options) {
      const body = snapshotQuoteInput(input);
      const { isActive } = snapshotOptions(options, false);
      assertActive(isActive);
      let data;
      try {
        data = await post("/quotes", body, Object.freeze({ retry: false }));
      } catch (error) {
        assertActive(isActive);
        throw normalizeDependencyError(error);
      }
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
      const operation = snapshotOptions(options, true);
      assertActive(operation.isActive);
      let data;
      try {
        data = await post(
          "/bookings",
          body,
          Object.freeze({
            header: Object.freeze({ "Idempotency-Key": idempotencyKey }),
            retry: false,
          }),
        );
      } catch (error) {
        assertActive(operation.isActive);
        throw normalizeDependencyError(error, operation.expectedQuote);
      }
      assertActive(operation.isActive);
      return assertBookingResponse(data, body.quote_id);
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

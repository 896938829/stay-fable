"use strict";

const {
  assertBookingDetail,
  assertBookingListResponse,
} = require("./contracts");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~-]{32,80}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_ERROR_MESSAGES = Object.freeze({
  AUTH_REAUTHENTICATION_FAILED: "Authentication failed",
  AUTH_SESSION_CHANGED: "Authentication session changed",
  AUTH_SESSION_EXPIRED: "Authentication session expired",
  AUTH_SESSION_OPERATION_CANCELLED: "Authentication operation cancelled",
  AUTH_SESSION_SERVICE_UNAVAILABLE: "Authentication service unavailable",
  AUTH_USER_DISABLED: "Authentication account unavailable",
  BOOKING_ALREADY_PROCESSED: "Booking already processed",
  BOOKING_EXPIRED: "Booking expired",
  BOOKING_LIFECYCLE_UNAVAILABLE: "Booking lifecycle unavailable",
  BOOKING_NOT_CANCELLABLE: "Booking not cancellable",
  BOOKING_NOT_FOUND: "Booking not found",
  IDEMPOTENCY_KEY_REUSED: "Idempotency key reused",
  INVALID_API_RESPONSE: "Invalid API response",
  INVALID_REQUEST_PATH: "Invalid request path",
  MOCK_PAYMENT_FAILED: "Mock payment failed",
  NETWORK_REQUEST_FAILED: "Network request failed",
  ORDER_CURSOR_INVALID: "Order cursor invalid",
  PAYMENT_REQUEST_INVALID: "Payment request invalid",
  RATE_LIMITED: "Rate limited",
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

function orderError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function invalidInput() {
  return orderError("INVALID_ORDER_INPUT", "Invalid order input");
}

function invalidOptions() {
  return orderError("INVALID_ORDER_OPTIONS", "Invalid order options");
}

function invalidEnvironment() {
  return orderError(
    "INVALID_ORDER_ENVIRONMENT",
    "Invalid order environment",
  );
}

function cancelled() {
  return orderError(
    "BOOKING_OPERATION_CANCELLED",
    "Booking operation cancelled",
  );
}

function unavailable() {
  return orderError(
    "BOOKING_LIFECYCLE_UNAVAILABLE",
    "Booking lifecycle unavailable",
  );
}

function plainOrNullPrototype(value) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotRecord(value, allowedKeys, errorFactory) {
  try {
    if (!plainOrNullPrototype(value)) {
      throw errorFactory();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (
      Object.getOwnPropertySymbols(value).length !== 0 ||
      keys.some((key) => !allowedKeys.includes(key))
    ) {
      throw errorFactory();
    }
    const snapshot = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        throw errorFactory();
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    throw errorFactory();
  }
}

function snapshotQuery(value) {
  if (value === undefined) {
    return Object.freeze({ limit: 10, cursor: undefined });
  }
  const snapshot = snapshotRecord(
    value,
    ["limit", "cursor"],
    invalidInput,
  );
  const limit = snapshot.limit === undefined ? 10 : snapshot.limit;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 20 ||
    (snapshot.cursor !== undefined &&
      (typeof snapshot.cursor !== "string" ||
        !CURSOR_PATTERN.test(snapshot.cursor)))
  ) {
    throw invalidInput();
  }
  return Object.freeze({ limit, cursor: snapshot.cursor });
}

function snapshotPaymentInput(value) {
  const snapshot = snapshotRecord(value, ["outcome"], invalidInput);
  if (
    Object.keys(snapshot).length !== 1 ||
    !["SUCCEED", "FAIL"].includes(snapshot.outcome)
  ) {
    throw invalidInput();
  }
  return Object.freeze({ outcome: snapshot.outcome });
}

function snapshotOptions(value, allowRetry) {
  if (value === undefined) {
    return Object.freeze({ isActive: () => true, retry: false });
  }
  const snapshot = snapshotRecord(
    value,
    allowRetry ? ["isActive", "retry"] : ["isActive"],
    invalidOptions,
  );
  if (
    (snapshot.isActive !== undefined &&
      typeof snapshot.isActive !== "function") ||
    (snapshot.retry !== undefined && typeof snapshot.retry !== "boolean")
  ) {
    throw invalidOptions();
  }
  return Object.freeze({
    isActive: snapshot.isActive || (() => true),
    retry: allowRetry && snapshot.retry === true,
  });
}

function snapshotId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw invalidInput();
  }
  return value;
}

function snapshotEnvironment(environment) {
  try {
    if (!plainOrNullPrototype(environment)) {
      throw invalidEnvironment();
    }
    const descriptors = Object.getOwnPropertyDescriptors(environment);
    const get = descriptors.get;
    const post = descriptors.post;
    if (
      !get ||
      !post ||
      !Object.prototype.hasOwnProperty.call(get, "value") ||
      !Object.prototype.hasOwnProperty.call(post, "value") ||
      typeof get.value !== "function" ||
      typeof post.value !== "function"
    ) {
      throw invalidEnvironment();
    }
    return Object.freeze({
      get: get.value.bind(environment),
      post: post.value.bind(environment),
    });
  } catch {
    throw invalidEnvironment();
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
    if (
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.keys(descriptors).some(
        (key) => !SAFE_ERROR_KEYS.includes(key),
      )
    ) {
      return undefined;
    }
    const code = descriptors.code;
    if (
      !code ||
      !Object.prototype.hasOwnProperty.call(code, "value") ||
      typeof code.value !== "string" ||
      !Object.prototype.hasOwnProperty.call(
        SAFE_ERROR_MESSAGES,
        code.value,
      )
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
    return {
      code: code.value,
      statusCode: status ? status.value : undefined,
      requestId: request ? request.value : undefined,
    };
  } catch {
    return undefined;
  }
}

function normalizeDependencyError(value) {
  const snapshot = snapshotDependencyError(value);
  if (!snapshot) {
    return unavailable();
  }
  const error = orderError(
    snapshot.code,
    SAFE_ERROR_MESSAGES[snapshot.code],
  );
  if (snapshot.statusCode !== undefined) {
    error.statusCode = snapshot.statusCode;
  }
  if (snapshot.requestId !== undefined) {
    error.requestId = snapshot.requestId;
  }
  return error;
}

function assertBookingIdentity(value, bookingId) {
  const detail = assertBookingDetail(value);
  if (detail.booking_id !== bookingId) {
    throw orderError("INVALID_API_RESPONSE", "Invalid API response");
  }
  return detail;
}

function createOrdersService(requestClient) {
  const { get, post } = snapshotEnvironment(requestClient);

  async function run(operation, isActive, validate) {
    assertActive(isActive);
    let data;
    try {
      data = await operation();
    } catch (error) {
      assertActive(isActive);
      throw normalizeDependencyError(error);
    }
    assertActive(isActive);
    return validate(data);
  }

  return {
    async listBookings(query, options) {
      const input = snapshotQuery(query);
      const operation = snapshotOptions(options, true);
      const cursor =
        input.cursor === undefined
          ? ""
          : `&cursor=${encodeURIComponent(input.cursor)}`;
      return run(
        () =>
          get(`/bookings?limit=${encodeURIComponent(String(input.limit))}${cursor}`, {
            retry: operation.retry,
          }),
        operation.isActive,
        assertBookingListResponse,
      );
    },

    async getBooking(bookingId, options) {
      const id = snapshotId(bookingId);
      const operation = snapshotOptions(options, true);
      return run(
        () =>
          get(`/bookings/${encodeURIComponent(id)}`, {
            retry: operation.retry,
          }),
        operation.isActive,
        (data) => assertBookingIdentity(data, id),
      );
    },

    async cancelBooking(bookingId, options) {
      const id = snapshotId(bookingId);
      const operation = snapshotOptions(options, false);
      return run(
        () =>
          post(
            `/bookings/${encodeURIComponent(id)}/cancel`,
            Object.freeze({}),
            Object.freeze({ retry: false }),
          ),
        operation.isActive,
        (data) => assertBookingIdentity(data, id),
      );
    },

    async simulatePayment(bookingId, input, idempotencyKey, options) {
      const id = snapshotId(bookingId);
      const body = snapshotPaymentInput(input);
      if (
        typeof idempotencyKey !== "string" ||
        !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)
      ) {
        throw invalidInput();
      }
      const operation = snapshotOptions(options, false);
      return run(
        () =>
          post(
            `/dev/payments/${encodeURIComponent(id)}/simulate`,
            body,
            Object.freeze({
              header: Object.freeze({
                "Idempotency-Key": idempotencyKey,
              }),
              retry: false,
            }),
          ),
        operation.isActive,
        (data) => assertBookingIdentity(data, id),
      );
    },
  };
}

let defaultService;

function getDefaultService() {
  if (!defaultService) {
    defaultService = createOrdersService(require("./request"));
  }
  return defaultService;
}

module.exports = {
  createOrdersService,
  listBookings(query, options) {
    return getDefaultService().listBookings(query, options);
  },
  getBooking(bookingId, options) {
    return getDefaultService().getBooking(bookingId, options);
  },
  cancelBooking(bookingId, options) {
    return getDefaultService().cancelBooking(bookingId, options);
  },
  simulatePayment(bookingId, input, idempotencyKey, options) {
    return getDefaultService().simulatePayment(
      bookingId,
      input,
      idempotencyKey,
      options,
    );
  },
};

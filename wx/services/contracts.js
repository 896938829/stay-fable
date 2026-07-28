"use strict";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function invalidResponse() {
  const error = new Error("Invalid API response");
  error.code = "INVALID_API_RESPONSE";
  return error;
}

function isObject(value) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonemptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function assertRequestId(value) {
  if (!isNonemptyString(value) || !REQUEST_ID_PATTERN.test(value)) {
    throw invalidResponse();
  }
}

function assertEnvelope(value) {
  if (!isObject(value) || !Object.prototype.hasOwnProperty.call(value, "data")) {
    throw invalidResponse();
  }
  assertRequestId(value.request_id);
  return value;
}

function assertAuthSession(value) {
  if (
    !isObject(value) ||
    typeof value.access_token !== "string" ||
    value.access_token.length < 32 ||
    !isPositiveInteger(value.access_expires_in) ||
    typeof value.refresh_token !== "string" ||
    value.refresh_token.length < 32 ||
    !isPositiveInteger(value.refresh_expires_in) ||
    !isObject(value.user) ||
    typeof value.user.id !== "string" ||
    !UUID_PATTERN.test(value.user.id)
  ) {
    throw invalidResponse();
  }
  return value;
}

function assertCity(value) {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    !isNonemptyString(value.code) ||
    !isNonemptyString(value.name)
  ) {
    throw invalidResponse();
  }
  return value;
}

function assertResolvedLocation(value) {
  if (
    !isObject(value) ||
    !Object.prototype.hasOwnProperty.call(value, "city") ||
    !Number.isInteger(value.distance_meters) ||
    value.distance_meters < 0
  ) {
    throw invalidResponse();
  }
  assertCity(value.city);
  return value;
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function assertApiErrorResponse(value) {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["error", "request_id"]) ||
    !isObject(value.error) ||
    !hasOnlyKeys(value.error, ["code", "message", "details"]) ||
    !isNonemptyString(value.error.code) ||
    !isNonemptyString(value.error.message)
  ) {
    throw invalidResponse();
  }
  assertRequestId(value.request_id);
  return value;
}

module.exports = {
  assertApiErrorResponse,
  assertAuthSession,
  assertCity,
  assertEnvelope,
  assertResolvedLocation,
};

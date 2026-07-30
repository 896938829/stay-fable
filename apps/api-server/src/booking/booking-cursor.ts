import { Buffer } from "node:buffer";
import { types as nodeTypes } from "node:util";

import { BusinessException } from "../common/http/business.exception.js";

export interface BookingCursor {
  createdAt: string;
  id: string;
}

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const UTC_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.(\d{1,3}))?Z$/;
const UUID_PATTERN =
  /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;

const invalidCursor = (): BusinessException =>
  new BusinessException(400, "ORDER_CURSOR_INVALID", "订单分页游标无效");

const isUtcInstant = (value: unknown): value is string => {
  if (typeof value !== "string" || !UTC_INSTANT_PATTERN.test(value)) {
    return false;
  }
  const normalized = value.includes(".")
    ? value.replace(/\.(\d{1,3})Z$/, (_match, fraction: string) => `.${fraction.padEnd(3, "0")}Z`)
    : value.replace(/Z$/, ".000Z");
  const instant = new Date(value);
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === normalized;
};

const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_PATTERN.test(value);

const readCursor = (value: unknown): BookingCursor => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  ) {
    throw invalidCursor();
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidCursor();
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2 ||
    !keys.includes("createdAt") ||
    !keys.includes("id") ||
    keys.some((key) => typeof key !== "string")
  ) {
    throw invalidCursor();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const createdAt = descriptors.createdAt;
  const id = descriptors.id;
  if (
    createdAt === undefined ||
    id === undefined ||
    !Object.hasOwn(createdAt, "value") ||
    !Object.hasOwn(id, "value") ||
    !isUtcInstant(createdAt.value) ||
    !isUuid(id.value)
  ) {
    throw invalidCursor();
  }
  return { createdAt: createdAt.value, id: id.value };
};

export const encodeBookingCursor = (value: BookingCursor): string => {
  try {
    return Buffer.from(JSON.stringify(readCursor(value)), "utf8").toString("base64url");
  } catch {
    throw invalidCursor();
  }
};

export const decodeBookingCursor = (value: unknown): BookingCursor => {
  try {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 512 ||
      !BASE64URL_PATTERN.test(value)
    ) {
      throw invalidCursor();
    }
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length === 0 || bytes.length > 512 || bytes.toString("base64url") !== value) {
      throw invalidCursor();
    }
    const json = bytes.toString("utf8");
    if (!Buffer.from(json, "utf8").equals(bytes)) {
      throw invalidCursor();
    }
    return readCursor(JSON.parse(json) as unknown);
  } catch {
    throw invalidCursor();
  }
};

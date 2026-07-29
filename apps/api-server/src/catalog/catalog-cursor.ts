import { Buffer } from "node:buffer";

import { BusinessException } from "../common/http/business.exception.js";

interface CatalogCursorPayload {
  version: 1;
  display_order: number;
  property_id: string;
}

interface CatalogCursorInput {
  displayOrder: number;
  propertyId: string;
}

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const UUID_PATTERN =
  /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;

const invalidCursor = (): BusinessException =>
  new BusinessException(400, "CATALOG_CURSOR_INVALID", "分页游标无效");

const isDisplayOrder = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isPropertyId = (value: unknown): value is string =>
  typeof value === "string" && UUID_PATTERN.test(value);

const hasExactKeys = (value: object, expectedKeys: readonly string[]): boolean => {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index])
  );
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
};

const validateEncoderInput = (value: unknown): CatalogCursorInput => {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["displayOrder", "propertyId"]) ||
    !isDisplayOrder(value.displayOrder) ||
    !isPropertyId(value.propertyId)
  ) {
    throw invalidCursor();
  }

  return { displayOrder: value.displayOrder, propertyId: value.propertyId };
};

const isCursorPayload = (value: unknown): value is CatalogCursorPayload =>
  isPlainObject(value) &&
  hasExactKeys(value, ["display_order", "property_id", "version"]) &&
  value.version === 1 &&
  isDisplayOrder(value.display_order) &&
  isPropertyId(value.property_id);

export const encodeCatalogCursor = (input: CatalogCursorInput): string => {
  const validInput = validateEncoderInput(input);
  const payload: CatalogCursorPayload = {
    version: 1,
    display_order: validInput.displayOrder,
    property_id: validInput.propertyId,
  };

  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
};

export const decodeCatalogCursor = (value: string): CatalogCursorInput => {
  try {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 256 ||
      !BASE64URL_PATTERN.test(value)
    ) {
      throw invalidCursor();
    }

    const bytes = Buffer.from(value, "base64url");
    if (bytes.length > 512 || bytes.toString("base64url") !== value) {
      throw invalidCursor();
    }

    const json = bytes.toString("utf8");
    if (!Buffer.from(json, "utf8").equals(bytes)) {
      throw invalidCursor();
    }

    const payload: unknown = JSON.parse(json);
    if (!isCursorPayload(payload)) {
      throw invalidCursor();
    }

    return { displayOrder: payload.display_order, propertyId: payload.property_id };
  } catch {
    throw invalidCursor();
  }
};

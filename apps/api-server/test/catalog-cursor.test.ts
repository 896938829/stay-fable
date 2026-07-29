import { describe, expect, it } from "vitest";

import { BusinessException } from "../src/common/http/business.exception.js";
import { decodeCatalogCursor, encodeCatalogCursor } from "../src/catalog/catalog-cursor.js";

const propertyId = "10000000-0000-4000-8000-000000000001";

const encodedJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
const encodedText = (value: string): string => Buffer.from(value, "utf8").toString("base64url");

const expectInvalid = (callback: () => unknown) => {
  let thrown: unknown;
  try {
    callback();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(BusinessException);
  expect(thrown).toMatchObject({ status: 400, code: "CATALOG_CURSOR_INVALID" });
};

describe("catalog cursors", () => {
  it("round-trips its deterministic versioned UTF-8 payload", () => {
    const input = { displayOrder: 12, propertyId };
    const cursor = encodeCatalogCursor(input);

    expect(cursor).toBe(
      Buffer.from(
        JSON.stringify({ version: 1, display_order: 12, property_id: propertyId }),
        "utf8",
      ).toString("base64url"),
    );
    expect(decodeCatalogCursor(cursor)).toEqual(input);
  });

  it("accepts zero and the largest safe display order", () => {
    for (const displayOrder of [0, Number.MAX_SAFE_INTEGER]) {
      expect(decodeCatalogCursor(encodeCatalogCursor({ displayOrder, propertyId }))).toEqual({
        displayOrder,
        propertyId,
      });
    }
  });

  it("rejects invalid cursor encoder input", () => {
    for (const input of [
      { displayOrder: -1, propertyId },
      { displayOrder: 1.5, propertyId },
      { displayOrder: Number.MAX_SAFE_INTEGER + 1, propertyId },
      { displayOrder: 1, propertyId: "not-a-uuid" },
    ]) {
      expectInvalid(() => encodeCatalogCursor(input));
    }
  });

  it("rejects malformed, non-canonical, and oversized cursor strings", () => {
    expectInvalid(() => decodeCatalogCursor(""));
    expectInvalid(() => decodeCatalogCursor("a".repeat(257)));
    expectInvalid(() => decodeCatalogCursor("abc+def"));
    expectInvalid(() => decodeCatalogCursor("AB"));
  });

  it("rejects invalid UTF-8 and non-JSON payloads", () => {
    expectInvalid(() => decodeCatalogCursor(Buffer.from([0xff]).toString("base64url")));
    expectInvalid(() => decodeCatalogCursor(Buffer.from("not json", "utf8").toString("base64url")));
  });

  it("rejects payloads that are not the exact version-one cursor object", () => {
    for (const payload of [
      null,
      [],
      { version: 1, display_order: 0, property_id: propertyId, extra: true },
      { version: 1, display_order: 0 },
      { version: 2, display_order: 0, property_id: propertyId },
      { version: 1, display_order: -1, property_id: propertyId },
      { version: 1, display_order: 1.5, property_id: propertyId },
      { version: 1, display_order: Number.MAX_SAFE_INTEGER + 1, property_id: propertyId },
      { version: 1, display_order: 0, property_id: "not-a-uuid" },
    ]) {
      expectInvalid(() => decodeCatalogCursor(encodedJson(payload)));
    }

    expectInvalid(() =>
      decodeCatalogCursor(
        encodedText(
          '{"version":1,"display_order":0,"property_id":"10000000-0000-4000-8000-000000000001","__proto__":{"polluted":true}}',
        ),
      ),
    );
  });
});

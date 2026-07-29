import { describe, expect, it } from "vitest";

import type { Clock } from "../src/common/clock/clock.js";
import { BusinessException } from "../src/common/http/business.exception.js";
import { parseCatalogDateRange } from "../src/catalog/catalog-date-range.js";

const clockAt = (instant: string): Clock => ({ now: () => new Date(instant) });

const expectRejected = (
  callback: () => unknown,
  code: "CATALOG_DATE_RANGE_INVALID" | "CATALOG_CHECKIN_IN_PAST" | "CATALOG_STAY_TOO_LONG",
) => {
  let thrown: unknown;
  try {
    callback();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(BusinessException);
  expect(thrown).toMatchObject({ status: 400, code });
};

describe("parseCatalogDateRange", () => {
  it("uses Asia/Shanghai business-day boundaries instead of the server timezone", () => {
    expect(
      parseCatalogDateRange("2026-07-28", "2026-07-29", clockAt("2026-07-28T15:59:59Z")),
    ).toEqual({ checkin: "2026-07-28", checkout: "2026-07-29", nights: 1 });

    expectRejected(
      () => parseCatalogDateRange("2026-07-28", "2026-07-29", clockAt("2026-07-28T16:00:00Z")),
      "CATALOG_CHECKIN_IN_PAST",
    );
  });

  it("allows today and stays of one through thirty nights", () => {
    const clock = clockAt("2026-07-28T16:00:00Z");

    expect(parseCatalogDateRange("2026-07-29", "2026-07-30", clock)).toEqual({
      checkin: "2026-07-29",
      checkout: "2026-07-30",
      nights: 1,
    });
    expect(parseCatalogDateRange("2026-07-29", "2026-08-28", clock)).toEqual({
      checkin: "2026-07-29",
      checkout: "2026-08-28",
      nights: 30,
    });
  });

  it("rejects a checkin before the current business day", () => {
    expectRejected(
      () => parseCatalogDateRange("2026-07-28", "2026-07-29", clockAt("2026-07-28T16:00:00Z")),
      "CATALOG_CHECKIN_IN_PAST",
    );
  });

  it("rejects a stay longer than thirty nights", () => {
    expectRejected(
      () => parseCatalogDateRange("2026-07-29", "2026-08-29", clockAt("2026-07-28T16:00:00Z")),
      "CATALOG_STAY_TOO_LONG",
    );
  });

  it("accepts a real leap day and rejects invalid calendar dates", () => {
    const clock = clockAt("2024-02-28T16:00:00Z");
    expect(parseCatalogDateRange("2024-02-29", "2024-03-01", clock)).toMatchObject({ nights: 1 });

    for (const [checkin, checkout] of [
      ["2023-02-29", "2023-03-01"],
      ["2026-04-31", "2026-05-01"],
      ["0000-01-01", "0000-01-02"],
      ["2026-7-29", "2026-07-30"],
      ["2026-07-29T00:00:00Z", "2026-07-30"],
    ] as const) {
      expectRejected(
        () => parseCatalogDateRange(checkin, checkout, clockAt("2026-07-28T16:00:00Z")),
        "CATALOG_DATE_RANGE_INVALID",
      );
    }
  });

  it("rejects an empty or reversed half-open range", () => {
    const clock = clockAt("2026-07-28T16:00:00Z");
    for (const [checkin, checkout] of [
      ["2026-07-29", "2026-07-29"],
      ["2026-07-30", "2026-07-29"],
    ] as const) {
      expectRejected(
        () => parseCatalogDateRange(checkin, checkout, clock),
        "CATALOG_DATE_RANGE_INVALID",
      );
    }
  });
});

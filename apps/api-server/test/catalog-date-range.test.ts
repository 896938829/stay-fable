import { describe, expect, it } from "vitest";

import type { Clock } from "../src/common/clock/clock.js";
import { BusinessException } from "../src/common/http/business.exception.js";
import { parseCatalogDateRange } from "../src/catalog/catalog-date-range.js";

const clockAt = (instant: string): Clock => ({ now: () => new Date(instant) });

const expectRejected = (
  callback: () => unknown,
  code:
    | "CATALOG_DATE_RANGE_INVALID"
    | "CATALOG_CHECKIN_IN_PAST"
    | "CATALOG_STAY_TOO_LONG"
    | "CATALOG_CLOCK_UNAVAILABLE",
  status = 400,
) => {
  let thrown: unknown;
  try {
    callback();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(BusinessException);
  expect(thrown).toMatchObject({ status, code });
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

  it.each([
    ["malformed dates", "2026-7-29", "2026-07-30", "CATALOG_DATE_RANGE_INVALID"],
    ["an empty range", "2026-07-29", "2026-07-29", "CATALOG_DATE_RANGE_INVALID"],
    ["an overlong range", "2026-07-29", "2026-08-29", "CATALOG_STAY_TOO_LONG"],
  ] as const)("prioritizes $0 over a failing business clock", (_label, checkin, checkout, code) => {
    expectRejected(
      () =>
        parseCatalogDateRange(checkin, checkout, {
          now: () => {
            throw new Error("clock unavailable");
          },
        }),
      code,
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

  it("applies Gregorian century leap-year rules", () => {
    expectRejected(
      () => parseCatalogDateRange("1900-02-29", "1900-03-01", clockAt("1900-02-27T16:00:00Z")),
      "CATALOG_DATE_RANGE_INVALID",
    );
    expect(
      parseCatalogDateRange("2000-02-29", "2000-03-01", clockAt("2000-02-28T16:00:00Z")),
    ).toMatchObject({
      nights: 1,
    });
  });

  it("rejects an invalid checkout when checkin is valid", () => {
    for (const checkout of ["2026-02-29", "2026-07-32", "2026-7-30", "0000-01-01"] as const) {
      expectRejected(
        () => parseCatalogDateRange("2026-07-29", checkout, clockAt("2026-07-28T16:00:00Z")),
        "CATALOG_DATE_RANGE_INVALID",
      );
    }
  });

  it("classifies an invalid business clock date as a temporary service failure", () => {
    expectRejected(
      () =>
        parseCatalogDateRange("2026-07-29", "2026-07-30", {
          now: () => new Date("not a date"),
        }),
      "CATALOG_CLOCK_UNAVAILABLE",
      503,
    );
  });

  it("classifies a throwing clock as a temporary service failure", () => {
    expectRejected(
      () =>
        parseCatalogDateRange("2026-07-29", "2026-07-30", {
          now: () => {
            throw new Error("clock unavailable");
          },
        }),
      "CATALOG_CLOCK_UNAVAILABLE",
      503,
    );
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

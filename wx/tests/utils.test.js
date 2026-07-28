import { afterEach, describe, expect, it } from "vitest";

import dateUtils from "../utils/date.js";
import idempotency from "../utils/idempotency.js";
import money from "../utils/money.js";

const { addDays, compareDates, formatDate, getDefaultDates, parseDate } = dateUtils;
const { createIdempotencyManager } = idempotency;
const { formatMoney } = money;
const originalTimezone = process.env.TZ;

afterEach(() => {
  process.env.TZ = originalTimezone;
});

describe("local date utilities", () => {
  it("parses and formats YYYY-MM-DD without UTC conversion", () => {
    process.env.TZ = "America/Los_Angeles";
    const value = parseDate("2026-03-08");
    expect(value.getFullYear()).toBe(2026);
    expect(value.getMonth()).toBe(2);
    expect(value.getDate()).toBe(8);
    expect(formatDate(value)).toBe("2026-03-08");
  });

  it("adds calendar days across DST boundaries", () => {
    process.env.TZ = "America/Los_Angeles";
    expect(formatDate(addDays(parseDate("2026-03-08"), 1))).toBe("2026-03-09");
    expect(compareDates("2026-03-09", "2026-03-08")).toBe(1);
  });

  it("rejects invalid calendar dates and returns tomorrow/after-tomorrow defaults", () => {
    expect(() => parseDate("2026-02-30")).toThrow();
    expect(getDefaultDates(() => new Date(2026, 6, 29, 23, 30))).toEqual({
      checkin: "2026-07-30",
      checkout: "2026-07-31",
    });
  });
});

describe("money", () => {
  it.each([
    [0, "¥0.00"],
    [1, "¥0.01"],
    [12345, "¥123.45"],
  ])("formats %i integer cents", (cents, expected) => {
    expect(formatMoney(cents)).toBe(expected);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid cents: %s", (value) => {
    expect(() => formatMoney(value)).toThrow();
  });
});

describe("idempotency manager", () => {
  it("keeps a key stable per scope and changes it after clear", () => {
    let index = 0;
    const manager = createIdempotencyManager({
      generator: () => `${String(++index).padStart(32, "a")}`,
    });
    const first = manager.get("booking:create");
    expect(manager.get("booking:create")).toBe(first);
    manager.clear("booking:create");
    expect(manager.get("booking:create")).not.toBe(first);
  });

  it("uses the callback-based WeChat cryptographic API and validates generated keys", async () => {
    const manager = createIdempotencyManager({
      wxApi: {
        getRandomValues(options) {
          expect(options.length).toBe(32);
          const bytes = new Uint8Array(options.length);
          bytes.fill(7);
          options.success({ randomValues: bytes.buffer });
        },
      },
    });
    await expect(manager.get("pay")).resolves.toMatch(/^[A-Za-z0-9._~-]{32,80}$/);
    expect(() =>
      createIdempotencyManager({ generator: () => "short" }).get("pay"),
    ).toThrow();
  });
});

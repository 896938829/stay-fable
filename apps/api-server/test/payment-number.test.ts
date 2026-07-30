import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import { createPaymentNumberGenerator } from "../src/booking/payment-number.js";

const NOW = new Date("2026-07-30T23:59:59.999Z");

describe("payment number generator", () => {
  it("uses one six-byte cryptographic source and the UTC calendar date", () => {
    const randomBytes = vi.fn(() => Buffer.from("a1b2c3d4e5f6", "hex"));
    const generator = createPaymentNumberGenerator(randomBytes);

    expect(generator.next(NOW)).toBe("SFP20260730A1B2C3D4E5F6");
    expect(randomBytes).toHaveBeenCalledOnce();
    expect(randomBytes).toHaveBeenCalledWith(6);
  });

  it("always returns the strict 23-character public format", () => {
    expect(createPaymentNumberGenerator().next(NOW)).toMatch(/^SFP[0-9]{8}[A-F0-9]{12}$/);
  });

  it.each([
    ["invalid date", () => createPaymentNumberGenerator().next(new Date(Number.NaN))],
    [
      "hostile date",
      () => createPaymentNumberGenerator().next(Object.create(Date.prototype) as Date),
    ],
    ["short random read", () => createPaymentNumberGenerator(() => Buffer.alloc(5)).next(NOW)],
    ["long random read", () => createPaymentNumberGenerator(() => Buffer.alloc(7)).next(NOW)],
    [
      "hostile random output",
      () => createPaymentNumberGenerator(() => new Proxy(Buffer.alloc(6), {})).next(NOW),
    ],
  ])("fails closed for %s", (_label, operation) => {
    expect(operation).toThrow("Payment number unavailable");
  });
});

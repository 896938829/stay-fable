import { createHash, type HashOptions } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

const cryptoFault = vi.hoisted(() => ({ enabled: false }));
type CreateHash = (algorithm: string, options?: HashOptions) => ReturnType<typeof createHash>;

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<{ createHash: CreateHash }>();
  return {
    ...actual,
    createHash: (algorithm: string, options?: HashOptions) => {
      if (cryptoFault.enabled) {
        throw new Error("crypto unavailable");
      }
      return actual.createHash(algorithm, options);
    },
  };
});

import {
  createQuoteFingerprint,
  type QuoteFingerprintInput,
} from "../src/pricing/quote-fingerprint.js";

const propertyId = "10000000-0000-4000-8000-000000000001";
const roomTypeId = "20000000-0000-4000-8000-000000000002";

const makeInput = (): QuoteFingerprintInput => ({
  property: { id: propertyId, name: "Lake House" },
  roomType: { id: roomTypeId, name: "Lake View", coverUrl: "/images/rooms/lake.jpg" },
  checkin: "2026-07-29",
  checkout: "2026-07-31",
  guests: 2,
  bookingPolicy: "No pets.",
  nightlyPrices: [
    { businessDate: "2026-07-29", salePriceCents: 12000, rackPriceCents: 15000 },
    { businessDate: "2026-07-30", salePriceCents: 11000, rackPriceCents: 15000 },
  ],
});

const freezeDeep = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      freezeDeep(child);
    }
  }
  return value;
};

const expectInvalid = (input: unknown) => {
  expect(() => createQuoteFingerprint(input as QuoteFingerprintInput)).toThrow(
    "Invalid quote fingerprint input",
  );
  try {
    createQuoteFingerprint(input as QuoteFingerprintInput);
  } catch (error) {
    expect(error).toEqual(new Error("Invalid quote fingerprint input"));
  }
};

describe("createQuoteFingerprint", () => {
  it("hashes the specified canonical UTF-8 JSON payload with a stable known vector", () => {
    const input = makeInput();

    expect(createQuoteFingerprint(input)).toBe(
      "421f2c65cb96373675c33eb8bdbad31ae43dfbe616552da2903ff140aef25613",
    );
    expect(createQuoteFingerprint(input)).toMatch(/^[a-f0-9]{64}$/);

    // This independent construction deliberately does not call the implementation.
    const canonicalPayload = [
      roomTypeId,
      propertyId,
      "2026-07-29",
      "2026-07-31",
      2,
      [propertyId, "Lake House"],
      [roomTypeId, "Lake View", "/images/rooms/lake.jpg"],
      "No pets.",
      [
        ["2026-07-29", 12000, 15000],
        ["2026-07-30", 11000, 15000],
      ],
    ];
    expect(
      createHash("sha256").update(JSON.stringify(canonicalPayload), "utf8").digest("hex"),
    ).toBe("421f2c65cb96373675c33eb8bdbad31ae43dfbe616552da2903ff140aef25613");
  });

  it("is independent of object key order and nightly input order without mutating frozen input", () => {
    const input = freezeDeep({
      nightlyPrices: [
        { rackPriceCents: 15000, salePriceCents: 11000, businessDate: "2026-07-30" },
        { salePriceCents: 12000, businessDate: "2026-07-29", rackPriceCents: 15000 },
      ],
      bookingPolicy: "No pets.",
      guests: 2,
      checkout: "2026-07-31",
      checkin: "2026-07-29",
      roomType: { coverUrl: "/images/rooms/lake.jpg", name: "Lake View", id: roomTypeId },
      property: { name: "Lake House", id: propertyId },
    });
    const before = JSON.stringify(input);

    expect(createQuoteFingerprint(input)).toBe(createQuoteFingerprint(makeInput()));
    expect(JSON.stringify(input)).toBe(before);
  });

  it("changes when each quoted canonical field changes", () => {
    const baseline = createQuoteFingerprint(makeInput());
    const variants: QuoteFingerprintInput[] = [
      { ...makeInput(), property: { id: propertyId, name: "Other house" } },
      {
        ...makeInput(),
        roomType: { id: roomTypeId, name: "Other room", coverUrl: "/images/rooms/lake.jpg" },
      },
      {
        ...makeInput(),
        checkin: "2026-07-30",
        checkout: "2026-08-01",
        nightlyPrices: [
          { businessDate: "2026-07-30", salePriceCents: 12000, rackPriceCents: 15000 },
          { businessDate: "2026-07-31", salePriceCents: 11000, rackPriceCents: 15000 },
        ],
      },
      { ...makeInput(), guests: 3 },
      { ...makeInput(), bookingPolicy: "No smoking." },
      {
        ...makeInput(),
        nightlyPrices: [
          { businessDate: "2026-07-29", salePriceCents: 12001, rackPriceCents: 15000 },
          { businessDate: "2026-07-30", salePriceCents: 11000, rackPriceCents: 15000 },
        ],
      },
    ];

    for (const variant of variants) {
      expect(createQuoteFingerprint(variant)).not.toBe(baseline);
    }
  });

  it("rejects unknown fields at every object level rather than incorporating them", () => {
    const root = { ...makeInput(), inventoryVersion: 7 };
    const property = { ...makeInput(), property: { ...makeInput().property, updated_at: "now" } };
    const roomType = { ...makeInput(), roomType: { ...makeInput().roomType, held: 1 } };
    const nightly = {
      ...makeInput(),
      nightlyPrices: [{ ...makeInput().nightlyPrices[0]!, sold: 1 }, makeInput().nightlyPrices[1]!],
    };

    for (const input of [root, property, roomType, nightly]) {
      expectInvalid(input);
    }
  });

  it("rejects invalid schemas, prices, and bounded quote fields", () => {
    const invalidInputs: unknown[] = [
      { ...makeInput(), property: { id: "not-a-uuid", name: "Lake House" } },
      { ...makeInput(), property: { id: propertyId, name: "  " } },
      {
        ...makeInput(),
        roomType: { id: roomTypeId, name: "Lake View", coverUrl: "http://bad.example/a" },
      },
      { ...makeInput(), guests: 0 },
      { ...makeInput(), bookingPolicy: " ".repeat(2001) },
    ];

    for (const input of invalidInputs) {
      expectInvalid(input);
    }
  });

  it.each([
    ["negative sale price", { salePriceCents: -1 }],
    ["rack price below sale price", { salePriceCents: 2, rackPriceCents: 1 }],
    [
      "unsafe integer price",
      {
        salePriceCents: Number.MAX_SAFE_INTEGER + 1,
        rackPriceCents: Number.MAX_SAFE_INTEGER + 1,
      },
    ],
  ])("rejects a %s after validating a complete two-night stay", (_label, priceChange) => {
    const input = makeInput();
    input.nightlyPrices[0] = { ...input.nightlyPrices[0]!, ...priceChange };

    expectInvalid(input);
  });

  it("rejects an unsafe aggregate sale total even when each nightly price is safe", () => {
    const input = makeInput();
    input.nightlyPrices = input.nightlyPrices.map((nightlyPrice) => ({
      ...nightlyPrice,
      salePriceCents: Number.MAX_SAFE_INTEGER,
      rackPriceCents: Number.MAX_SAFE_INTEGER,
    }));

    expectInvalid(input);
  });

  it("requires a contiguous half-open Gregorian nightly range including edge years and leap years", () => {
    expect(
      createQuoteFingerprint({
        ...makeInput(),
        checkin: "0001-02-28",
        checkout: "0001-03-01",
        nightlyPrices: [{ businessDate: "0001-02-28", salePriceCents: 1, rackPriceCents: 1 }],
      }),
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(
      createQuoteFingerprint({
        ...makeInput(),
        checkin: "2000-02-28",
        checkout: "2000-03-01",
        nightlyPrices: [
          { businessDate: "2000-02-28", salePriceCents: 1, rackPriceCents: 1 },
          { businessDate: "2000-02-29", salePriceCents: 1, rackPriceCents: 1 },
        ],
      }),
    ).toMatch(/^[a-f0-9]{64}$/);

    for (const input of [
      { ...makeInput(), checkout: "2026-07-29" },
      {
        ...makeInput(),
        checkout: "2026-08-29",
        nightlyPrices: Array.from({ length: 31 }, (_, index) => ({
          businessDate: `2026-07-${String(29 + index).padStart(2, "0")}`,
          salePriceCents: 1,
          rackPriceCents: 1,
        })),
      },
      { ...makeInput(), checkin: "1900-02-29" },
      {
        ...makeInput(),
        nightlyPrices: [
          { businessDate: "2026-07-29", salePriceCents: 1, rackPriceCents: 1 },
          { businessDate: "2026-07-31", salePriceCents: 1, rackPriceCents: 1 },
        ],
      },
      {
        ...makeInput(),
        nightlyPrices: [
          { businessDate: "2026-07-29", salePriceCents: 1, rackPriceCents: 1 },
          { businessDate: "2026-07-29", salePriceCents: 1, rackPriceCents: 1 },
        ],
      },
    ]) {
      expectInvalid(input);
    }
  });

  it("never exposes values from hostile accessors", () => {
    const secret = "do-not-disclose-this-secret";
    for (const key of ["bookingPolicy", "inventoryVersion"] as const) {
      const input = makeInput() as unknown as Record<string, unknown>;
      Object.defineProperty(input, key, {
        enumerable: true,
        get: () => {
          throw new Error(secret);
        },
      });

      let thrown: unknown;
      try {
        createQuoteFingerprint(input as unknown as QuoteFingerprintInput);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toEqual(new Error("Invalid quote fingerprint input"));
      expect(String((thrown as Error).message)).not.toContain(secret);
    }
  });

  it("rejects unknown keys before reading any property descriptors", () => {
    let descriptorReads = 0;
    const input = new Proxy(makeInput(), {
      ownKeys: (target) => [...Reflect.ownKeys(target), "inventoryVersion"],
      getOwnPropertyDescriptor: (target, key) => {
        descriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    expectInvalid(input);
    expect(descriptorReads).toBe(0);
  });

  it("contains hostile reflection failures without leaking their details", () => {
    const secret = "reflection-do-not-disclose";
    const input = new Proxy(makeInput(), {
      ownKeys: () => {
        throw new Error(secret);
      },
    });

    let thrown: unknown;
    try {
      createQuoteFingerprint(input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toEqual(new Error("Invalid quote fingerprint input"));
    expect(String((thrown as Error).message)).not.toContain(secret);
  });

  it("does not misclassify crypto failures as invalid input", () => {
    cryptoFault.enabled = true;
    try {
      expect(() => createQuoteFingerprint(makeInput())).toThrow("crypto unavailable");
    } finally {
      cryptoFault.enabled = false;
    }
  });
});

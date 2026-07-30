import { describe, expect, it } from "vitest";

import * as catalogSeedData from "../prisma/catalog-seed-data.js";
import * as seedModule from "../prisma/seed.js";

const { catalogDailySupply, catalogRoomTypes } = catalogSeedData;

const createCatalogDailySupply = (startDate: string) => {
  const factory = (
    catalogSeedData as unknown as {
      createCatalogDailySupply?: (value: string) => typeof catalogDailySupply;
    }
  ).createCatalogDailySupply;
  expect(factory, "catalog daily supply factory must be exported").toBeTypeOf("function");
  return factory!(startDate);
};

const resolveCatalogDailySupply = (environment: Record<string, string>) => {
  const resolver = (
    seedModule as unknown as {
      resolveCatalogDailySupply?: (value: Record<string, string>) => typeof catalogDailySupply;
    }
  ).resolveCatalogDailySupply;
  expect(resolver, "catalog daily supply environment resolver must be exported").toBeTypeOf(
    "function",
  );
  return resolver!(environment);
};

describe("createCatalogDailySupply", () => {
  it("creates exactly sixty UTC business days for every room from a real leap day", () => {
    const supply = createCatalogDailySupply("2024-02-29");

    expect(supply).toHaveLength(catalogRoomTypes.length * 60);
    for (const room of catalogRoomTypes) {
      const roomSupply = supply.filter(({ roomTypeId }) => roomTypeId === room.id);
      expect(roomSupply).toHaveLength(60);
      expect(roomSupply[0]?.businessDate).toBe("2024-02-29");
      expect(roomSupply[1]?.businessDate).toBe("2024-03-01");
      expect(roomSupply[59]?.businessDate).toBe("2024-04-28");
    }
  });

  it("preserves the deterministic seven-day price offsets and inventory", () => {
    const supply = createCatalogDailySupply("2030-01-01");
    const room = catalogRoomTypes[0];
    const roomSupply = supply.filter(({ roomTypeId }) => roomTypeId === room?.id);

    expect(roomSupply[0]).toMatchObject({
      salePriceCents: room?.basePriceCents,
      rackPriceCents: (room?.basePriceCents ?? 0) + 6_000,
      totalInventory: room?.inventory,
    });
    expect(roomSupply[6]?.salePriceCents).toBe((room?.basePriceCents ?? 0) + 6_000);
    expect(roomSupply[7]?.salePriceCents).toBe(room?.basePriceCents);
  });

  it("allows the final four-digit-year window and ends exactly on 9999-12-31", () => {
    const supply = createCatalogDailySupply("9999-11-02");
    const firstRoomSupply = supply.filter(
      ({ roomTypeId }) => roomTypeId === catalogRoomTypes[0]?.id,
    );

    expect(firstRoomSupply).toHaveLength(60);
    expect(firstRoomSupply[0]?.businessDate).toBe("9999-11-02");
    expect(firstRoomSupply[59]?.businessDate).toBe("9999-12-31");
  });

  it.each([
    "2023-02-29",
    "1900-02-29",
    "2026-04-31",
    "0000-01-01",
    "2026-7-30",
    "2026-07-30T00:00:00Z",
    "",
  ])("rejects invalid or noncanonical start date %j", (startDate) => {
    expect(() => createCatalogDailySupply(startDate)).toThrow(
      "catalog supply start date must be a real YYYY-MM-DD date",
    );
  });

  it.each(["9999-11-03", "9999-12-31"])(
    "rejects start date %s because its sixty-day window leaves the four-digit year range",
    (startDate) => {
      expect(() => createCatalogDailySupply(startDate)).toThrow(
        "catalog supply start date must leave the full 60-day window within four-digit years",
      );
    },
  );

  it("keeps the exported default supply fixed at the historical test baseline", () => {
    expect(catalogDailySupply[0]?.businessDate).toBe("2026-07-30");
    expect(catalogDailySupply).toEqual(createCatalogDailySupply("2026-07-30"));
  });
});

describe("resolveCatalogDailySupply", () => {
  it("uses the fixed supply unless the dedicated environment variable is explicitly present", () => {
    expect(resolveCatalogDailySupply({})).toBe(catalogDailySupply);
  });

  it("uses a validated explicit catalog start date without mutating the default export", () => {
    const supply = resolveCatalogDailySupply({
      STAY_FABLE_CATALOG_START_DATE: "2032-02-29",
    });

    expect(supply[0]?.businessDate).toBe("2032-02-29");
    expect(supply[59]?.businessDate).toBe("2032-04-28");
    expect(catalogDailySupply[0]?.businessDate).toBe("2026-07-30");
  });

  it("rejects an explicitly present empty or invalid environment value", () => {
    expect(() => resolveCatalogDailySupply({ STAY_FABLE_CATALOG_START_DATE: "" })).toThrow(
      "catalog supply start date must be a real YYYY-MM-DD date",
    );
    expect(() =>
      resolveCatalogDailySupply({ STAY_FABLE_CATALOG_START_DATE: "2032-02-30" }),
    ).toThrow("catalog supply start date must be a real YYYY-MM-DD date");
  });
});

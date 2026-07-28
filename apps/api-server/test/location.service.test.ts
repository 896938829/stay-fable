/* eslint-disable @typescript-eslint/unbound-method */
import type { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";

import type { BusinessException } from "../src/common/http/business.exception.js";
import type { DatabaseService } from "../src/database/database.service.js";
import { Prisma } from "../src/generated/prisma/client.js";
import { LocationService } from "../src/location/location.service.js";

const hangzhou = {
  id: "10000000-0000-4000-8000-000000000001",
  code: "330100",
  name: "杭州",
};

const createHarness = (
  nearestRows: Array<{
    id: string;
    code: string;
    name: string;
    distance_meters: number;
  }> = [{ ...hangzhou, distance_meters: 0 }],
  maximumDistance = 100_000,
) => {
  const findMany = vi.fn(() =>
    Promise.resolve([
      { id: hangzhou.id, code: hangzhou.code, nameZh: hangzhou.name },
      {
        id: "10000000-0000-4000-8000-000000000002",
        code: "520100",
        nameZh: "贵阳",
      },
    ]),
  );
  const queryRaw = vi.fn((query: Prisma.Sql) => {
    void query;
    return Promise.resolve(nearestRows);
  });
  const database = {
    city: { findMany },
    $queryRaw: queryRaw,
  } as unknown as DatabaseService;
  const config = {
    getOrThrow: vi.fn(() => maximumDistance),
  } as unknown as ConfigService;

  return {
    service: new LocationService(database, config),
    findMany,
    queryRaw,
    config,
  };
};

describe("LocationService", () => {
  it("lists only enabled cities in display order without selecting geography", async () => {
    const { service, findMany } = createHarness();

    await expect(service.listCities()).resolves.toEqual([
      hangzhou,
      {
        id: "10000000-0000-4000-8000-000000000002",
        code: "520100",
        name: "贵阳",
      },
    ]);
    expect(findMany).toHaveBeenCalledWith({
      where: { enabled: true },
      orderBy: [{ displayOrder: "asc" }, { id: "asc" }],
      select: { id: true, code: true, nameZh: true },
    });
  });

  it("resolves the nearest enabled city with a parameterized Prisma Sql query", async () => {
    const { service, queryRaw } = createHarness([{ ...hangzhou, distance_meters: 123 }]);
    const longitude = 120.155_123_456;
    const latitude = 30.274_123_456;

    await expect(service.resolve({ longitude, latitude })).resolves.toEqual({
      city: hangzhou,
      distance_meters: 123,
    });

    expect(queryRaw).toHaveBeenCalledOnce();
    const query = queryRaw.mock.calls[0]?.[0];
    expect(query).toBeInstanceOf(Prisma.Sql);
    expect(query?.values).toEqual([longitude, latitude]);
    expect(query?.sql).toContain("ST_Distance");
    expect(query?.sql).toContain("ST_MakePoint");
    expect(query?.sql).toContain("<->");
    expect(query?.sql).toContain('"enabled" = true');
    expect(query?.sql).toContain("LIMIT 1");
    expect(query?.sql).not.toContain(String(longitude));
    expect(query?.sql).not.toContain(String(latitude));
  });

  it("accepts a city exactly at the configured maximum distance", async () => {
    const { service, config } = createHarness([{ ...hangzhou, distance_meters: 100_000 }], 100_000);

    await expect(service.resolve({ longitude: 121, latitude: 30 })).resolves.toMatchObject({
      city: hangzhou,
      distance_meters: 100_000,
    });
    expect(config.getOrThrow).toHaveBeenCalledWith("LOCATION_MAX_DISTANCE_METERS");
  });

  it.each([
    { label: "no enabled city", rows: [] },
    { label: "nearest city is too far away", rows: [{ ...hangzhou, distance_meters: 100_001 }] },
  ])("rejects unsupported locations when $label", async ({ rows }) => {
    const { service } = createHarness(rows);

    await expect(service.resolve({ longitude: 0, latitude: 0 })).rejects.toMatchObject({
      code: "CITY_NOT_SUPPORTED",
      message: "当前城市暂未开通",
    } satisfies Partial<BusinessException>);
    await expect(service.resolve({ longitude: 0, latitude: 0 })).rejects.toHaveProperty(
      "status",
      422,
    );
  });
});

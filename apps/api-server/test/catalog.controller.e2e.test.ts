import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configureApplication } from "../src/application-configuration.js";
import { CLOCK } from "../src/common/clock/clock.js";
import { BusinessException } from "../src/common/http/business.exception.js";
import { CatalogController } from "../src/catalog/catalog.controller.js";
import { CatalogRepository } from "../src/catalog/catalog.repository.js";
import { CatalogService } from "../src/catalog/catalog.service.js";
import { SessionAuthGuard } from "../src/identity/session-auth.guard.js";

const CITY_ID = "10000000-0000-4000-8000-000000000001";
const PROPERTY_ID = "20000000-0000-4000-8000-000000000001";
const ROOM_ID = "30000000-0000-4000-8000-000000000001";
const availabilityQuery = "checkin=2026-07-30&checkout=2026-08-01&guests=2";
const listItem = {
  id: PROPERTY_ID,
  type: "HOTEL",
  name: "西湖云栖酒店",
  city: { id: CITY_ID, code: "330100", name: "杭州" },
  cover_url: "/images/catalog/hotel.jpg",
  short_description: "在西湖边住进一段安静时光。",
  facility_highlights: ["无线网络"],
  from_nightly_price_cents: 42_800,
  currency: "CNY",
  available_room_type_count: 2,
};

describe("CatalogController", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const createApp = async (authenticated = true) => {
    const catalog = {
      listProperties: vi.fn(() => Promise.resolve({ items: [listItem], next_cursor: null })),
      getProperty: vi.fn(() => Promise.resolve({ id: PROPERTY_ID })),
      getRoomType: vi.fn(() => Promise.resolve({ id: ROOM_ID })),
    };
    const module = await Test.createTestingModule({
      controllers: [CatalogController],
      providers: [{ provide: CatalogService, useValue: catalog }],
    })
      .overrideGuard(SessionAuthGuard)
      .useValue({
        canActivate: () => {
          if (!authenticated) {
            throw new BusinessException(401, "AUTH_SESSION_EXPIRED", "登录状态已过期，请重新登录");
          }
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    configureApplication(app, "production");
    await app.init();

    return {
      catalog,
      server: app.getHttpServer() as Parameters<typeof request>[0],
    };
  };

  const createRealServiceApp = async () => {
    const repository = {
      listProperties: vi.fn(),
      listFacilityHighlights: vi.fn(),
      findProperty: vi.fn(),
      findRoomType: vi.fn(),
    };
    const module = await Test.createTestingModule({
      controllers: [CatalogController],
      providers: [
        CatalogService,
        { provide: CatalogRepository, useValue: repository },
        {
          provide: CLOCK,
          useValue: { now: () => new Date("2026-07-29T04:00:00.000Z") },
        },
      ],
    })
      .overrideGuard(SessionAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    configureApplication(app, "production");
    await app.init();

    return {
      repository,
      server: app.getHttpServer() as Parameters<typeof request>[0],
    };
  };

  it("returns the list in the global envelope and never adds room collections", async () => {
    const { catalog, server } = await createApp();

    const response = await request(server)
      .get(`/api/v1/properties?city_id=${CITY_ID}&${availabilityQuery}`)
      .expect(200);

    expect(response.body).toMatchObject({
      data: { items: [listItem], next_cursor: null },
    });
    expect(response.body).toHaveProperty("request_id");
    expect(JSON.stringify(response.body)).not.toMatch(/room_types|rooms|inventory/);
    expect(catalog.listProperties).toHaveBeenCalledWith({
      city_id: CITY_ID,
      checkin: "2026-07-30",
      checkout: "2026-08-01",
      guests: 2,
      page_size: 10,
    });
  });

  it("transforms numeric query fields and accepts valid optional filters", async () => {
    const { catalog, server } = await createApp();

    await request(server)
      .get(
        `/api/v1/properties?city_id=${CITY_ID}&${availabilityQuery}&property_type=HOMESTAY&page_size=7&cursor=abc`,
      )
      .expect(200);

    expect(catalog.listProperties).toHaveBeenCalledWith({
      city_id: CITY_ID,
      checkin: "2026-07-30",
      checkout: "2026-08-01",
      guests: 2,
      property_type: "HOMESTAY",
      page_size: 7,
      cursor: "abc",
    });
  });

  it("accepts a valid city UUID without imposing a UUID version", async () => {
    const { catalog, server } = await createApp();
    const versionOneCityId = "10000000-0000-1000-8000-000000000001";

    await request(server)
      .get(`/api/v1/properties?city_id=${versionOneCityId}&${availabilityQuery}`)
      .expect(200);

    expect(catalog.listProperties).toHaveBeenCalledWith(
      expect.objectContaining({ city_id: versionOneCityId }),
    );
  });

  it("routes property and room detail requests with UUID paths and availability", async () => {
    const { catalog, server } = await createApp();

    await request(server).get(`/api/v1/properties/${PROPERTY_ID}?${availabilityQuery}`).expect(200);
    await request(server).get(`/api/v1/room-types/${ROOM_ID}?${availabilityQuery}`).expect(200);

    expect(catalog.getProperty).toHaveBeenCalledWith(PROPERTY_ID, {
      checkin: "2026-07-30",
      checkout: "2026-08-01",
      guests: 2,
    });
    expect(catalog.getRoomType).toHaveBeenCalledWith(ROOM_ID, {
      checkin: "2026-07-30",
      checkout: "2026-08-01",
      guests: 2,
    });
  });

  it.each([
    `city_id=${CITY_ID}&${availabilityQuery}&unknown=value`,
    `city_id=not-a-uuid&${availabilityQuery}`,
    `city_id=${CITY_ID}&checkin=2026-7-30&checkout=2026-08-01&guests=2`,
    `city_id=${CITY_ID}&checkin=2026-07-30&checkout=2026-8-01&guests=2`,
    `city_id=${CITY_ID}&checkin=2026-07-30&checkout=2026-08-01&guests=0`,
    `city_id=${CITY_ID}&checkin=2026-07-30&checkout=2026-08-01&guests=11`,
    `city_id=${CITY_ID}&checkin=2026-07-30&checkout=2026-08-01&guests=2.5`,
    `city_id=${CITY_ID}&checkin=2026-07-30&checkout=2026-08-01&guests=true`,
    `city_id=${CITY_ID}&checkin=2026-07-30&checkout=2026-08-01&guests=%20`,
    `city_id=${CITY_ID}&${availabilityQuery}&property_type=HOSTEL`,
    `city_id=${CITY_ID}&${availabilityQuery}&page_size=0`,
    `city_id=${CITY_ID}&${availabilityQuery}&page_size=21`,
    `city_id=${CITY_ID}&${availabilityQuery}&page_size=1.5`,
    `city_id=${CITY_ID}&${availabilityQuery}&cursor=`,
  ])("rejects invalid list query %s before service access", async (queryString) => {
    const { catalog, server } = await createApp();

    await request(server).get(`/api/v1/properties?${queryString}`).expect(400);

    expect(catalog.listProperties).not.toHaveBeenCalled();
  });

  it("rejects repeated numeric query fields as arrays", async () => {
    const { catalog, server } = await createApp();

    await request(server)
      .get(`/api/v1/properties?city_id=${CITY_ID}&${availabilityQuery}&guests=3`)
      .expect(400);

    expect(catalog.listProperties).not.toHaveBeenCalled();
  });

  it.each([
    `/api/v1/properties/not-a-uuid?${availabilityQuery}`,
    `/api/v1/room-types/not-a-uuid?${availabilityQuery}`,
    `/api/v1/properties/${PROPERTY_ID}?checkin=2026-07-30&checkout=2026-08-01&guests=NaN`,
    `/api/v1/room-types/${ROOM_ID}?checkin=2026-07-30&checkout=2026-08-01&guests=false`,
  ])("rejects invalid detail input %s before service access", async (path) => {
    const { catalog, server } = await createApp();

    await request(server).get(path).expect(400);

    expect(catalog.getProperty).not.toHaveBeenCalled();
    expect(catalog.getRoomType).not.toHaveBeenCalled();
  });

  it("preserves stable business errors in the API error envelope", async () => {
    const { catalog, server } = await createApp();
    catalog.getProperty.mockRejectedValue(
      new BusinessException(404, "PROPERTY_NOT_AVAILABLE", "住宿当前不可预订"),
    );

    const response = await request(server)
      .get(`/api/v1/properties/${PROPERTY_ID}?${availabilityQuery}`)
      .expect(404);

    expect(response.body).toMatchObject({
      error: { code: "PROPERTY_NOT_AVAILABLE", message: "住宿当前不可预订" },
    });
    expect(response.body).toHaveProperty("request_id");
  });

  it("rejects a malformed cursor through the real catalog service before repository access", async () => {
    const { repository, server } = await createRealServiceApp();

    const response = await request(server)
      .get(`/api/v1/properties?city_id=${CITY_ID}&${availabilityQuery}&cursor=not-a-cursor`)
      .expect(400);

    expect(response.body).toMatchObject({
      error: { code: "CATALOG_CURSOR_INVALID", message: "分页游标无效" },
    });
    expect(response.body).toHaveProperty("request_id");
    for (const method of Object.values(repository)) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it("is protected by session authentication", async () => {
    expect(Reflect.getMetadata("__guards__", CatalogController)).toContain(SessionAuthGuard);
    const { catalog, server } = await createApp(false);

    const response = await request(server)
      .get(`/api/v1/properties?city_id=${CITY_ID}&${availabilityQuery}`)
      .expect(401);

    expect(response.body).toMatchObject({ error: { code: "AUTH_SESSION_EXPIRED" } });
    expect(catalog.listProperties).not.toHaveBeenCalled();
  });
});

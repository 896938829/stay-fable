import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configureApplication } from "../src/application-configuration.js";
import { SessionAuthGuard } from "../src/identity/session-auth.guard.js";
import { LocationController } from "../src/location/location.controller.js";
import { LocationService } from "../src/location/location.service.js";

const hangzhou = {
  id: "10000000-0000-4000-8000-000000000001",
  code: "330100",
  name: "杭州",
};

describe("LocationController", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  const createApp = async () => {
    const location = {
      listCities: vi.fn(() => Promise.resolve([hangzhou])),
      resolve: vi.fn(() =>
        Promise.resolve({
          city: hangzhou,
          distance_meters: 12,
        }),
      ),
    };
    const module = await Test.createTestingModule({
      controllers: [LocationController],
      providers: [{ provide: LocationService, useValue: location }],
    })
      .overrideGuard(SessionAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    configureApplication(app, "production");
    await app.init();

    return {
      location,
      server: app.getHttpServer() as Parameters<typeof request>[0],
    };
  };

  it("returns operating cities in the global envelope", async () => {
    const { location, server } = await createApp();

    const response = await request(server).get("/api/v1/cities").expect(200);

    expect((response.body as { data: unknown }).data).toEqual([hangzhou]);
    expect(response.body).toHaveProperty("request_id");
    expect(location.listCities).toHaveBeenCalledOnce();
  });

  it("accepts JSON numbers before resolving a location", async () => {
    const { location, server } = await createApp();

    const response = await request(server)
      .post("/api/v1/location/resolve")
      .send({ longitude: 120.1551, latitude: 30.2741 })
      .expect(200);

    expect((response.body as { data: unknown }).data).toEqual({
      city: hangzhou,
      distance_meters: 12,
    });
    expect(location.resolve).toHaveBeenCalledWith({
      longitude: 120.1551,
      latitude: 30.2741,
    });
  });

  it.each([
    { longitude: -180, latitude: -90 },
    { longitude: 180, latitude: 90 },
  ])("accepts JSON numbers at coordinate boundaries", async (coordinates) => {
    const { location, server } = await createApp();

    await request(server).post("/api/v1/location/resolve").send(coordinates).expect(200);

    expect(location.resolve).toHaveBeenCalledWith(coordinates);
  });

  it.each(["", " ", "120.1", true, false])("rejects non-number longitude %j", async (longitude) => {
    const { location, server } = await createApp();

    await request(server)
      .post("/api/v1/location/resolve")
      .send({ longitude, latitude: 30.2741 })
      .expect(400);

    expect(location.resolve).not.toHaveBeenCalled();
  });

  it.each(["", " ", "30.1", true, false])("rejects non-number latitude %j", async (latitude) => {
    const { location, server } = await createApp();

    await request(server)
      .post("/api/v1/location/resolve")
      .send({ longitude: 120.1551, latitude })
      .expect(400);

    expect(location.resolve).not.toHaveBeenCalled();
  });

  it.each([
    { longitude: 180.000_001, latitude: 0 },
    { longitude: -180.000_001, latitude: 0 },
    { longitude: 0, latitude: 90.000_001 },
    { longitude: 0, latitude: -90.000_001 },
    { latitude: 30.2741 },
    { longitude: 120.1551 },
  ])("rejects out-of-bounds or incomplete coordinates", async (coordinates) => {
    const { location, server } = await createApp();

    await request(server).post("/api/v1/location/resolve").send(coordinates).expect(400);

    expect(location.resolve).not.toHaveBeenCalled();
  });
});

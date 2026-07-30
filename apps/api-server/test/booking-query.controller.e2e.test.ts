import type { CanActivate, ExecutionContext, INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configureApplication } from "../src/application-configuration.js";
import { BookingQueryController } from "../src/booking/booking-query.controller.js";
import { BookingQueryService } from "../src/booking/booking-query.service.js";
import { BusinessException } from "../src/common/http/business.exception.js";
import { SessionAuthGuard } from "../src/identity/session-auth.guard.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const BOOKING_ID = "30000000-0000-4000-8000-000000000001";
const listResponse = {
  items: [
    {
      booking_id: BOOKING_ID,
      booking_number: "SF20260730A1B2C3D4E5F6",
      status: "PENDING_PAYMENT",
      property_name: "西湖云栖酒店",
      room_type_name: "湖景大床房",
      checkin: "2026-08-01",
      checkout: "2026-08-03",
      nights: 2,
      guests: 2,
      total_price_cents: 121_600,
      currency: "CNY",
      expires_at: "2026-07-30T02:15:00.000Z",
      payment_deadline_passed: false,
      created_at: "2026-07-30T02:00:00.000Z",
      updated_at: "2026-07-30T02:01:00.000Z",
    },
  ],
  next_cursor: null,
};
const detailResponse = {
  ...listResponse.items[0],
  nightly_prices: [
    {
      business_date: "2026-08-01",
      sale_price_cents: 58_800,
      rack_price_cents: 68_800,
      currency: "CNY",
    },
    {
      business_date: "2026-08-02",
      sale_price_cents: 62_800,
      rack_price_cents: 72_800,
      currency: "CNY",
    },
  ],
  booking_policy: "入住前一天 18:00 前可免费取消",
  latest_payment: null,
  status_history: [],
  allowed_actions: ["CANCEL"],
};

describe("BookingQueryController", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const createApp = async (auth: "allowed" | "unauthorized" = "allowed") => {
    const service = {
      listOwned: vi.fn(() => Promise.resolve(listResponse)),
      getOwned: vi.fn(() => Promise.resolve(detailResponse)),
    };
    const guard: CanActivate = {
      canActivate(context: ExecutionContext) {
        if (auth === "unauthorized") {
          throw new BusinessException(401, "AUTH_SESSION_EXPIRED", "登录状态已过期，请重新登录");
        }
        context.switchToHttp().getRequest<{ user?: { id: string } }>().user = { id: USER_ID };
        return true;
      },
    };
    const module = await Test.createTestingModule({
      controllers: [BookingQueryController],
      providers: [{ provide: BookingQueryService, useValue: service }],
    })
      .overrideGuard(SessionAuthGuard)
      .useValue(guard)
      .compile();
    app = module.createNestApplication();
    configureApplication(app, "production");
    await app.init();
    return { service, server: app.getHttpServer() as Parameters<typeof request>[0] };
  };

  it("lists the authenticated user's bookings in the global envelope", async () => {
    const { service, server } = await createApp();
    const response = await request(server)
      .get("/api/v1/bookings?limit=10")
      .set("Authorization", "Bearer test")
      .expect(200);
    expect(response.body).toMatchObject({ data: listResponse });
    const responseBody = response.body as { request_id: string };
    expect(responseBody.request_id).toMatch(/^req_/);
    expect(service.listOwned).toHaveBeenCalledWith(USER_ID, { limit: 10 });
  });

  it("gets an authenticated user's booking detail in the global envelope", async () => {
    const { service, server } = await createApp();
    const response = await request(server)
      .get(`/api/v1/bookings/${BOOKING_ID}`)
      .set("Authorization", "Bearer test")
      .expect(200);
    expect(response.body).toMatchObject({ data: detailResponse });
    expect(service.getOwned).toHaveBeenCalledWith(USER_ID, BOOKING_ID);
    const responseBody = response.body as { data: unknown };
    expect(JSON.stringify(responseBody.data)).not.toMatch(/user|quote|idempotency|inventory|hold/i);
  });

  it("preserves the uniform cross-user not-found response", async () => {
    const { service, server } = await createApp();
    service.getOwned.mockRejectedValueOnce(
      new BusinessException(404, "BOOKING_NOT_FOUND", "订单不存在"),
    );
    const response = await request(server)
      .get(`/api/v1/bookings/${BOOKING_ID}`)
      .set("Authorization", "Bearer other-user")
      .expect(404);
    expect(response.body).toMatchObject({
      error: { code: "BOOKING_NOT_FOUND", message: "订单不存在" },
    });
    expect(response.body).toHaveProperty("request_id");
  });

  it.each([
    ["/api/v1/bookings?limit=0", "invalid lower limit"],
    ["/api/v1/bookings?limit=21", "invalid upper limit"],
    ["/api/v1/bookings?limit=10&sort=asc", "unknown query"],
  ])("strictly rejects %s (%s) before service access", async (path) => {
    const { service, server } = await createApp();
    const response = await request(server)
      .get(path)
      .set("Authorization", "Bearer test")
      .expect(400);
    expect(response.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(response.body).toHaveProperty("request_id");
    expect(service.listOwned).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", "/api/v1/bookings?cursor=", ""],
    ["invalid characters", "/api/v1/bookings?cursor=bad%20cursor", "bad cursor"],
    ["too long", `/api/v1/bookings?cursor=${"A".repeat(513)}`, "A".repeat(513)],
    ["array", "/api/v1/bookings?cursor=one&cursor=two", "one"],
    [
      "bad JSON",
      `/api/v1/bookings?cursor=${Buffer.from("not-json").toString("base64url")}`,
      Buffer.from("not-json").toString("base64url"),
    ],
  ])(
    "returns ORDER_CURSOR_INVALID without reflecting an %s cursor",
    async (_label, path, value) => {
      const { service, server } = await createApp();
      service.listOwned.mockRejectedValueOnce(
        new BusinessException(400, "ORDER_CURSOR_INVALID", "订单分页游标无效"),
      );
      const response = await request(server)
        .get(path)
        .set("Authorization", "Bearer test")
        .expect(400);
      expect(response.body).toMatchObject({
        error: { code: "ORDER_CURSOR_INVALID", message: "订单分页游标无效" },
      });
      expect(response.body).toHaveProperty("request_id");
      if (value.length > 0) {
        expect(JSON.stringify(response.body)).not.toContain(value);
      }
      expect(service.listOwned).toHaveBeenCalledOnce();
    },
  );

  it("strictly rejects a malformed booking path before service access", async () => {
    const { service, server } = await createApp();
    const response = await request(server)
      .get("/api/v1/bookings/not-a-uuid")
      .set("Authorization", "Bearer test")
      .expect(400);
    expect(response.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(response.body).toHaveProperty("request_id");
    expect(service.getOwned).not.toHaveBeenCalled();
  });

  it("runs authentication before query and path validation", async () => {
    const { service, server } = await createApp("unauthorized");
    for (const path of ["/api/v1/bookings?unknown=true", "/api/v1/bookings/not-a-uuid"]) {
      const response = await request(server).get(path).expect(401);
      expect(response.body).toMatchObject({ error: { code: "AUTH_SESSION_EXPIRED" } });
    }
    expect(service.listOwned).not.toHaveBeenCalled();
    expect(service.getOwned).not.toHaveBeenCalled();
  });

  it("does not reflect an invalid cursor in the error envelope", async () => {
    const cursor = Buffer.from(
      JSON.stringify({ createdAt: "cursor-secret", id: BOOKING_ID }),
    ).toString("base64url");
    const { service, server } = await createApp();
    service.listOwned.mockRejectedValueOnce(
      new BusinessException(400, "ORDER_CURSOR_INVALID", "订单分页游标无效"),
    );
    const response = await request(server)
      .get(`/api/v1/bookings?cursor=${cursor}`)
      .set("Authorization", "Bearer test")
      .expect(400);
    expect(response.body).toMatchObject({ error: { code: "ORDER_CURSOR_INVALID" } });
    expect(JSON.stringify(response.body)).not.toContain(cursor);
    expect(JSON.stringify(response.body)).not.toContain("cursor-secret");
  });

  it("is guarded by SessionAuthGuard", () => {
    expect(Reflect.getMetadata("__guards__", BookingQueryController)).toContain(SessionAuthGuard);
  });
});

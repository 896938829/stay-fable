import type { CanActivate, ExecutionContext, INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configureApplication } from "../src/application-configuration.js";
import {
  BookingActionsController,
  CancelBookingPipe,
} from "../src/booking/booking-actions.controller.js";
import { BookingLifecycleService } from "../src/booking/booking-lifecycle.service.js";
import { BusinessException } from "../src/common/http/business.exception.js";
import { SessionAuthGuard } from "../src/identity/session-auth.guard.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const BOOKING_ID = "30000000-0000-4000-8000-000000000001";
const booking = {
  booking_id: BOOKING_ID,
  booking_number: "SF20260730A1B2C3D4E5F6",
  status: "CANCELLED",
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
  updated_at: "2026-07-30T02:05:00.000Z",
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
  allowed_actions: [],
};

describe("BookingActionsController", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const createApp = async (authorized = true) => {
    const service = {
      cancel: vi.fn(() => Promise.resolve({ replayed: false, booking })),
    };
    const guard: CanActivate = {
      canActivate(context: ExecutionContext) {
        if (!authorized) {
          throw new BusinessException(401, "AUTH_SESSION_EXPIRED", "登录状态已过期，请重新登录");
        }
        context.switchToHttp().getRequest<{ user?: { id: string } }>().user = { id: USER_ID };
        return true;
      },
    };
    const module = await Test.createTestingModule({
      controllers: [BookingActionsController],
      providers: [{ provide: BookingLifecycleService, useValue: service }],
    })
      .overrideGuard(SessionAuthGuard)
      .useValue(guard)
      .compile();
    app = module.createNestApplication();
    configureApplication(app, "production");
    await app.init();
    return { server: app.getHttpServer() as Parameters<typeof request>[0], service };
  };

  it.each([
    ["first cancellation", false],
    ["replay", true],
  ])("returns HTTP 200 for %s", async (_label, replayed) => {
    const { server, service } = await createApp();
    service.cancel.mockResolvedValueOnce({ replayed, booking });
    const response = await request(server)
      .post(`/api/v1/bookings/${BOOKING_ID}/cancel`)
      .set("Authorization", "Bearer test")
      .send({})
      .expect(200);
    expect(response.body).toMatchObject({ data: booking });
    const responseBody = response.body as { request_id: string };
    expect(responseBody.request_id).toMatch(/^req_/);
    expect(service.cancel).toHaveBeenCalledWith(USER_ID, BOOKING_ID, {});
  });

  it("rejects unknown body or query fields and malformed paths before service access", async () => {
    const { server, service } = await createApp();
    await request(server)
      .post(`/api/v1/bookings/${BOOKING_ID}/cancel`)
      .set("Authorization", "Bearer test")
      .send({ unexpected: true })
      .expect(400);
    await request(server)
      .post("/api/v1/bookings/not-a-uuid/cancel")
      .set("Authorization", "Bearer test")
      .send({})
      .expect(400);
    await request(server)
      .post(`/api/v1/bookings/${BOOKING_ID}/cancel?unexpected=secret`)
      .set("Authorization", "Bearer test")
      .send({})
      .expect(400);
    expect(service.cancel).not.toHaveBeenCalled();
  });

  it("runs authentication before body and path validation", async () => {
    const { server, service } = await createApp(false);
    for (const [path, body] of [
      [`/api/v1/bookings/${BOOKING_ID}/cancel`, { unexpected: true }],
      ["/api/v1/bookings/not-a-uuid/cancel", {}],
    ] as const) {
      const response = await request(server)
        .post(path)
        .set("Authorization", "Bearer test")
        .send(body)
        .expect(401);
      expect(response.body).toMatchObject({ error: { code: "AUTH_SESSION_EXPIRED" } });
    }
    expect(service.cancel).not.toHaveBeenCalled();
  });

  it("preserves stable lifecycle errors without reflecting internal data", async () => {
    const { server, service } = await createApp();
    service.cancel.mockRejectedValueOnce(
      new BusinessException(503, "BOOKING_LIFECYCLE_UNAVAILABLE", "订单服务暂时不可用，请稍后重试"),
    );
    const response = await request(server)
      .post(`/api/v1/bookings/${BOOKING_ID}/cancel`)
      .set("Authorization", "Bearer test")
      .send({})
      .expect(503);
    expect(response.body).toMatchObject({
      error: {
        code: "BOOKING_LIFECYCLE_UNAVAILABLE",
        message: "订单服务暂时不可用，请稍后重试",
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/inventory|hold|idempotency/i);
  });

  it.each([
    ["getter", Object.defineProperty({}, "secret", { enumerable: true, get: () => "secret" })],
    ["proxy", new Proxy({}, { ownKeys: () => ["secret"] })],
    ["symbol", { [Symbol("secret")]: true }],
  ])("fails closed without invoking hostile %s body data", (_label, body) => {
    const pipe = new CancelBookingPipe();
    expect(() => pipe.transform(body)).toThrowError(
      expect.objectContaining({ status: 400, code: "BAD_REQUEST" }),
    );
  });

  it("is guarded by SessionAuthGuard", () => {
    expect(Reflect.getMetadata("__guards__", BookingActionsController)).toContain(SessionAuthGuard);
  });
});

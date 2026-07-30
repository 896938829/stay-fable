import type { CanActivate, ExecutionContext, INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configureApplication } from "../src/application-configuration.js";
import {
  DevPaymentsController,
  MockPaymentBodyPipe,
  parsePaymentIdempotencyHeader,
} from "../src/booking/dev-payments.controller.js";
import { MockPaymentModule } from "../src/booking/mock-payment.module.js";
import { MockPaymentService } from "../src/booking/mock-payment.service.js";
import { BusinessException } from "../src/common/http/business.exception.js";
import { SessionAuthGuard } from "../src/identity/session-auth.guard.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const BOOKING_ID = "30000000-0000-4000-8000-000000000001";
const IDEMPOTENCY_KEY = "mock-payment-key-1234567890_ABCDEF";
const booking = {
  booking_id: BOOKING_ID,
  booking_number: "SF20260730A1B2C3D4E5F6",
  status: "CONFIRMED",
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
  latest_payment: {
    payment_number: "SFP20260730A1B2C3D4E5F6",
    status: "SUCCEEDED",
    processed_at: "2026-07-30T02:05:00.000Z",
  },
  status_history: [],
  allowed_actions: [],
};

describe("DevPaymentsController", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const createApp = async (authorized = true) => {
    const payments = {
      simulate: vi.fn(() => Promise.resolve({ replayed: false, booking })),
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
      controllers: [DevPaymentsController],
      providers: [{ provide: MockPaymentService, useValue: payments }],
    })
      .overrideGuard(SessionAuthGuard)
      .useValue(guard)
      .compile();
    app = module.createNestApplication();
    configureApplication(app, "production");
    await app.init();
    return { payments, server: app.getHttpServer() as Parameters<typeof request>[0] };
  };

  it.each([
    [false, 201],
    [true, 200],
  ])("returns the strict confirmed detail with replayed=%s", async (replayed, status) => {
    const { payments, server } = await createApp();
    payments.simulate.mockResolvedValueOnce({ replayed, booking });
    const response = await request(server)
      .post(`/api/v1/dev/payments/${BOOKING_ID}/simulate`)
      .set("Authorization", "Bearer test")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send({ outcome: "SUCCEED" })
      .expect(status);
    expect(response.body).toMatchObject({ data: booking });
    expect((response.body as { request_id: string }).request_id).toMatch(/^req_/);
    expect(payments.simulate).toHaveBeenCalledWith(USER_ID, BOOKING_ID, IDEMPOTENCY_KEY, {
      outcome: "SUCCEED",
    });
    expect(JSON.stringify(response.body)).not.toMatch(/idempotency|user_id|inventory|hold/i);
  });

  it("returns the stable failed-payment conflict", async () => {
    const { payments, server } = await createApp();
    payments.simulate.mockRejectedValueOnce(
      new BusinessException(409, "MOCK_PAYMENT_FAILED", "模拟支付失败"),
    );
    const response = await request(server)
      .post(`/api/v1/dev/payments/${BOOKING_ID}/simulate`)
      .set("Authorization", "Bearer test")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send({ outcome: "FAIL" })
      .expect(409);
    expect(response.body).toMatchObject({
      error: { code: "MOCK_PAYMENT_FAILED", message: "模拟支付失败" },
    });
  });

  it("coalesces concurrent duplicate clicks into one service call", async () => {
    const { payments, server } = await createApp();
    payments.simulate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ replayed: false, booking }), 20);
        }),
    );
    const send = () =>
      request(server)
        .post(`/api/v1/dev/payments/${BOOKING_ID}/simulate`)
        .set("Authorization", "Bearer test")
        .set("Idempotency-Key", IDEMPOTENCY_KEY)
        .send({ outcome: "SUCCEED" });
    const [first, second] = await Promise.all([send(), send()]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(payments.simulate).toHaveBeenCalledOnce();
  });

  it("rejects missing, malformed, merged, and duplicate idempotency headers", async () => {
    const { payments, server } = await createApp();
    const values: Array<string | undefined | string[]> = [
      undefined,
      "short",
      `${IDEMPOTENCY_KEY},${IDEMPOTENCY_KEY}`,
      [IDEMPOTENCY_KEY, IDEMPOTENCY_KEY],
    ];
    for (const value of values) {
      let operation = request(server)
        .post(`/api/v1/dev/payments/${BOOKING_ID}/simulate`)
        .set("Authorization", "Bearer test")
        .send({ outcome: "SUCCEED" });
      if (value !== undefined) {
        operation = operation.set("Idempotency-Key", value as unknown as string);
      }
      await operation.expect(400);
    }
    expect(payments.simulate).not.toHaveBeenCalled();
  });

  it("rejects malformed paths, bodies, and non-empty query objects", async () => {
    const { payments, server } = await createApp();
    for (const [path, body] of [
      ["/api/v1/dev/payments/not-a-uuid/simulate", { outcome: "SUCCEED" }],
      [`/api/v1/dev/payments/${BOOKING_ID}/simulate`, { outcome: "UNKNOWN" }],
      [`/api/v1/dev/payments/${BOOKING_ID}/simulate`, { outcome: "SUCCEED", secret: true }],
      [`/api/v1/dev/payments/${BOOKING_ID}/simulate?secret=true`, { outcome: "SUCCEED" }],
    ] as const) {
      await request(server)
        .post(path)
        .set("Authorization", "Bearer test")
        .set("Idempotency-Key", IDEMPOTENCY_KEY)
        .send(body)
        .expect(400);
    }
    expect(payments.simulate).not.toHaveBeenCalled();
  });

  it("runs authentication before header, path, body, and query validation", async () => {
    const { payments, server } = await createApp(false);
    await request(server)
      .post("/api/v1/dev/payments/not-a-uuid/simulate?secret=true")
      .send({ outcome: "UNKNOWN", secret: true })
      .expect(401);
    expect(payments.simulate).not.toHaveBeenCalled();
  });

  it.each([
    ["getter", Object.defineProperty({}, "outcome", { get: () => "SUCCEED" })],
    ["proxy", new Proxy({}, { ownKeys: () => ["outcome"] })],
    ["symbol", { outcome: "SUCCEED", [Symbol("secret")]: true }],
  ])("fails closed without invoking hostile %s body data", (_label, body) => {
    const pipe = new MockPaymentBodyPipe();
    expect(() => pipe.transform(body)).toThrowError(
      expect.objectContaining({ status: 400, code: "PAYMENT_REQUEST_INVALID" }),
    );
  });

  it("rejects hostile raw header containers without reflecting values", () => {
    expect(() =>
      parsePaymentIdempotencyHeader(
        new Proxy([], {
          ownKeys: () => {
            throw new Error("header-secret");
          },
        }),
      ),
    ).toThrowError(expect.objectContaining({ status: 400, code: "PAYMENT_REQUEST_INVALID" }));
  });

  it("does not register the route when the dynamic module is disabled", async () => {
    const module = await Test.createTestingModule({
      imports: [
        MockPaymentModule.forRoot({
          NODE_ENV: "test",
          DATABASE_URL: "postgresql://localhost:5432/stay_fable",
          REDIS_URL: "redis://localhost:6379",
          IDENTITY_PROVIDER: "mock",
          ENABLE_MOCK_PAYMENT: "false",
        }),
      ],
    }).compile();
    app = module.createNestApplication();
    configureApplication(app, "production");
    await app.init();
    await request(app.getHttpServer() as Parameters<typeof request>[0])
      .post(`/api/v1/dev/payments/${BOOKING_ID}/simulate`)
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send({ outcome: "SUCCEED" })
      .expect(404);
  });
});

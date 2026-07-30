import type { CanActivate, ExecutionContext, INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configureApplication } from "../src/application-configuration.js";
import { BookingsController, parseIdempotencyHeader } from "../src/booking/bookings.controller.js";
import { CreateBookingPipe } from "../src/booking/dto/create-booking.dto.js";
import { BookingsService } from "../src/booking/bookings.service.js";
import { BusinessException } from "../src/common/http/business.exception.js";
import { SessionAuthGuard } from "../src/identity/session-auth.guard.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const QUOTE_ID = "20000000-0000-4000-8000-000000000001";
const IDEMPOTENCY_KEY = "booking-key-1234567890_ABCDEFGHIJ";
const body = { quote_id: QUOTE_ID };
const booking = {
  booking_id: "30000000-0000-4000-8000-000000000001",
  quote_id: QUOTE_ID,
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
  created_at: "2026-07-30T02:00:00.000Z",
};

describe("BookingsController", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const createApp = async (auth: "allowed" | "unauthorized" | "forbidden" = "allowed") => {
    const bookings = {
      create: vi.fn(() => Promise.resolve({ replayed: false, booking })),
    };
    const guard: CanActivate = {
      canActivate(context: ExecutionContext) {
        if (auth === "unauthorized") {
          throw new BusinessException(401, "AUTH_SESSION_EXPIRED", "登录状态已过期，请重新登录");
        }
        if (auth === "forbidden") {
          throw new BusinessException(403, "AUTH_ACCOUNT_DISABLED", "当前账号不可用");
        }
        context.switchToHttp().getRequest<{ user?: { id: string } }>().user = { id: USER_ID };
        return true;
      },
    };
    const module = await Test.createTestingModule({
      controllers: [BookingsController],
      providers: [{ provide: BookingsService, useValue: bookings }],
    })
      .overrideGuard(SessionAuthGuard)
      .useValue(guard)
      .compile();
    app = module.createNestApplication();
    configureApplication(app, "production");
    await app.init();
    return { bookings, server: app.getHttpServer() as Parameters<typeof request>[0] };
  };

  it.each([
    [false, 201],
    [true, 200],
  ])("returns a strict booking envelope with replayed=%s", async (replayed, status) => {
    const { bookings, server } = await createApp();
    bookings.create.mockResolvedValueOnce({ replayed, booking });
    const response = await request(server)
      .post("/api/v1/bookings")
      .set("Authorization", "Bearer test")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send(body)
      .expect(status);
    expect(response.body).toMatchObject({ data: booking });
    const responseBody = response.body as { data: unknown; request_id: string };
    expect(responseBody.request_id).toMatch(/^req_/);
    expect(bookings.create).toHaveBeenCalledWith(USER_ID, IDEMPOTENCY_KEY, body);
    expect(JSON.stringify(responseBody.data)).not.toMatch(
      /user|inventory|history|fingerprint|held|sold/,
    );
  });

  it.each([
    ["missing", undefined],
    ["too short", "short"],
    ["illegal characters", "booking key 1234567890 ABCDEFGHIJ"],
    ["comma merged", `${IDEMPOTENCY_KEY},${IDEMPOTENCY_KEY}`],
    ["too long", "a".repeat(81)],
  ])("rejects an %s idempotency header without service access", async (_name, value) => {
    const { bookings, server } = await createApp();
    let operation = request(server).post("/api/v1/bookings").send(body);
    if (value !== undefined) {
      operation = operation.set("Idempotency-Key", value);
    }
    const response = await operation.expect(400);
    expect(response.body).toMatchObject({
      error: { code: "IDEMPOTENCY_KEY_INVALID", message: "请求标识无效" },
    });
    expect(response.body).toHaveProperty("request_id");
    if (value !== undefined) {
      expect(JSON.stringify(response.body)).not.toContain(value);
    }
    expect(bookings.create).not.toHaveBeenCalled();
  });

  it.each([` ${IDEMPOTENCY_KEY}`, `${IDEMPOTENCY_KEY} `])(
    "does not trim or normalize the raw idempotency value",
    (value) => {
      expect(() => parseIdempotencyHeader(["Idempotency-Key", value])).toThrowError(
        expect.objectContaining({ code: "IDEMPOTENCY_KEY_INVALID" }),
      );
    },
  );

  it("rejects an array-valued raw idempotency header", () => {
    expect(() => parseIdempotencyHeader(["Idempotency-Key", [IDEMPOTENCY_KEY]])).toThrowError(
      expect.objectContaining({ code: "IDEMPOTENCY_KEY_INVALID" }),
    );
  });

  it("rejects duplicate raw Idempotency-Key header lines", async () => {
    const { bookings, server } = await createApp();
    const response = await request(server)
      .post("/api/v1/bookings")
      .set("Idempotency-Key", [IDEMPOTENCY_KEY, IDEMPOTENCY_KEY] as unknown as string)
      .send(body)
      .expect(400);
    expect(response.body).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_INVALID" } });
    expect(bookings.create).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown", { ...body, total_price_cents: 1 }],
    ["invalid UUID", { quote_id: "not-a-uuid" }],
    ["null", null],
    ["array", [body]],
  ])("rejects an %s body with a stable booking error", async (_name, invalidBody) => {
    const { bookings, server } = await createApp();
    const response = await request(server)
      .post("/api/v1/bookings")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send(invalidBody ?? undefined)
      .expect(400);
    expect(response.body).toMatchObject({
      error: { code: "BOOKING_REQUEST_INVALID", message: "下单请求无效" },
    });
    expect(response.body).toHaveProperty("request_id");
    expect(bookings.create).not.toHaveBeenCalled();
  });

  it("maps malformed JSON to the stable booking request error", async () => {
    const { bookings, server } = await createApp();
    const response = await request(server)
      .post("/api/v1/bookings")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .set("Content-Type", "application/json")
      .send('{"quote_id":')
      .expect(400);
    expect(response.body).toMatchObject({ error: { code: "BOOKING_REQUEST_INVALID" } });
    expect(response.body).toHaveProperty("request_id");
    expect(bookings.create).not.toHaveBeenCalled();
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "rejects a JSON parsed %s own key",
    async (key) => {
      const { bookings, server } = await createApp();
      const response = await request(server)
        .post("/api/v1/bookings")
        .set("Idempotency-Key", IDEMPOTENCY_KEY)
        .set("Content-Type", "application/json")
        .send(`{"quote_id":"${QUOTE_ID}","${key}":{"polluted":true}}`)
        .expect(400);
      expect(response.body).toMatchObject({ error: { code: "BOOKING_REQUEST_INVALID" } });
      expect(bookings.create).not.toHaveBeenCalled();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    },
  );

  it.each([
    [
      "accessor",
      Object.defineProperty({}, "quote_id", {
        enumerable: true,
        get: () => {
          throw new Error("accessor-secret");
        },
      }),
    ],
    [
      "proxy",
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error("proxy-secret");
          },
        },
      ),
    ],
  ])("sanitizes a hostile %s without reading it", (_name, hostile) => {
    let captured: unknown;
    try {
      new CreateBookingPipe().transform(hostile);
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({
      code: "BOOKING_REQUEST_INVALID",
      message: "下单请求无效",
    });
    expect(JSON.stringify(captured)).not.toMatch(/accessor-secret|proxy-secret/);
  });

  it.each([
    ["unauthorized", 401, "AUTH_SESSION_EXPIRED"],
    ["forbidden", 403, "AUTH_ACCOUNT_DISABLED"],
  ] as const)("runs the %s guard before body and header processing", async (auth, status, code) => {
    const { bookings, server } = await createApp(auth);
    const response = await request(server)
      .post("/api/v1/bookings")
      .send({ unknown: true })
      .expect(status);
    expect(response.body).toMatchObject({ error: { code } });
    expect(bookings.create).not.toHaveBeenCalled();
  });

  it.each([
    [409, "QUOTE_EXPIRED"],
    [409, "QUOTE_ALREADY_USED"],
    [409, "INVENTORY_UNAVAILABLE"],
    [503, "BOOKING_SERVICE_UNAVAILABLE"],
  ])("preserves safe %s %s errors", async (status, code) => {
    const { bookings, server } = await createApp();
    bookings.create.mockRejectedValueOnce(new BusinessException(status, code, "安全提示"));
    const response = await request(server)
      .post("/api/v1/bookings")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send(body)
      .expect(status);
    expect(response.body).toMatchObject({ error: { code, message: "安全提示" } });
    expect(response.body).toHaveProperty("request_id");
  });

  it("preserves bounded rate-limit details", async () => {
    const details = { retry_after_seconds: 37 };
    const { bookings, server } = await createApp();
    bookings.create.mockRejectedValueOnce(
      new BusinessException(429, "RATE_LIMITED", "请求过于频繁，请稍后重试", details),
    );
    const response = await request(server)
      .post("/api/v1/bookings")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send(body)
      .expect(429);
    expect(response.body).toMatchObject({
      error: {
        code: "RATE_LIMITED",
        message: "请求过于频繁，请稍后重试",
        details,
      },
    });
    expect(response.body).toHaveProperty("request_id");
  });

  it("preserves the strict replacement quote details for QUOTE_CHANGED", async () => {
    const details = {
      previous_total_price_cents: 121_600,
      replacement_quote: {
        quote_id: "40000000-0000-4000-8000-000000000001",
        property: { id: "50000000-0000-4000-8000-000000000001", name: "西湖云栖酒店" },
        room_type: {
          id: "60000000-0000-4000-8000-000000000001",
          name: "湖景大床房",
          cover_url: "/images/catalog/room.jpg",
        },
        checkin: "2026-08-01",
        checkout: "2026-08-03",
        nights: 2,
        guests: 2,
        nightly_prices: [
          {
            business_date: "2026-08-01",
            sale_price_cents: 60_000,
            rack_price_cents: 68_800,
            currency: "CNY",
          },
          {
            business_date: "2026-08-02",
            sale_price_cents: 64_000,
            rack_price_cents: 72_800,
            currency: "CNY",
          },
        ],
        total_price_cents: 124_000,
        currency: "CNY",
        booking_policy: "入住前一天 18:00 前可免费取消",
        expires_at: "2026-07-30T02:06:00.000Z",
      },
    };
    const { bookings, server } = await createApp();
    bookings.create.mockRejectedValueOnce(
      new BusinessException(409, "QUOTE_CHANGED", "报价已发生变化，请确认新价格", details),
    );
    const response = await request(server)
      .post("/api/v1/bookings")
      .set("Idempotency-Key", IDEMPOTENCY_KEY)
      .send(body)
      .expect(409);
    expect(response.body).toMatchObject({
      error: { code: "QUOTE_CHANGED", details },
    });
  });
});

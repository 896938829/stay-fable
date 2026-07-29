import type { CanActivate, ExecutionContext, INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configureApplication } from "../src/application-configuration.js";
import { BusinessException } from "../src/common/http/business.exception.js";
import { SessionAuthGuard } from "../src/identity/session-auth.guard.js";
import { QuoteRequestPipe } from "../src/pricing/dto/quote-request.dto.js";
import { QuotesController } from "../src/pricing/quotes.controller.js";
import { QuotesService } from "../src/pricing/quotes.service.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const ROOM_TYPE_ID = "20000000-0000-4000-8000-000000000001";
const QUOTE_ID = "30000000-0000-4000-8000-000000000001";
const PROPERTY_ID = "40000000-0000-4000-8000-000000000001";
const body = {
  room_type_id: ROOM_TYPE_ID,
  checkin: "2026-08-01",
  checkout: "2026-08-03",
  guests: 2,
};
const quote = {
  quote_id: QUOTE_ID,
  property: { id: PROPERTY_ID, name: "西湖云栖酒店" },
  room_type: {
    id: ROOM_TYPE_ID,
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
  total_price_cents: 121_600,
  currency: "CNY",
  booking_policy: "入住前一天 18:00 前可免费取消",
  expires_at: "2026-07-30T02:05:00.000Z",
};

describe("QuotesController", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const createApp = async (authenticated = true) => {
    const quotes = { create: vi.fn(() => Promise.resolve(quote)) };
    const guard: CanActivate = {
      canActivate(context: ExecutionContext) {
        if (!authenticated) {
          throw new BusinessException(401, "AUTH_SESSION_EXPIRED", "登录状态已过期，请重新登录");
        }
        context.switchToHttp().getRequest<{ user?: { id: string } }>().user = { id: USER_ID };
        return true;
      },
    };
    const module = await Test.createTestingModule({
      controllers: [QuotesController],
      providers: [{ provide: QuotesService, useValue: quotes }],
    })
      .overrideGuard(SessionAuthGuard)
      .useValue(guard)
      .compile();
    app = module.createNestApplication();
    configureApplication(app, "production");
    await app.init();
    return { quotes, server: app.getHttpServer() as Parameters<typeof request>[0] };
  };

  it("creates an authenticated quote in the global 201 envelope without internal fields", async () => {
    const { quotes, server } = await createApp();
    const response = await request(server)
      .post("/api/v1/quotes")
      .set("Authorization", "Bearer test")
      .send(body)
      .expect(201);

    expect(response.body).toMatchObject({ data: quote });
    const responseBody = response.body as unknown as { data: unknown; request_id: string };
    expect(responseBody.request_id).toMatch(/^req_/);
    expect(quotes.create).toHaveBeenCalledWith(USER_ID, body);
    expect(JSON.stringify(responseBody.data)).not.toMatch(
      /inventory|fingerprint|user_id|version|held|sold/,
    );
  });

  it("requires an authenticated session before calling the service", async () => {
    const { quotes, server } = await createApp(false);
    const response = await request(server).post("/api/v1/quotes").send(body).expect(401);
    const responseBody = response.body as unknown as { error: { code: string } };
    expect(responseBody.error.code).toBe("AUTH_SESSION_EXPIRED");
    expect(quotes.create).not.toHaveBeenCalled();
  });

  it("accepts a legal non-v4 UUID at the transport boundary", async () => {
    const { quotes, server } = await createApp();
    const versionSevenRoomId = "20000000-0000-7000-8000-000000000001";
    await request(server)
      .post("/api/v1/quotes")
      .send({ ...body, room_type_id: versionSevenRoomId })
      .expect(201);
    expect(quotes.create).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ room_type_id: versionSevenRoomId }),
    );
  });

  it.each([
    ["unknown field", { ...body, unknown: true }],
    ["invalid UUID", { ...body, room_type_id: "not-a-uuid" }],
    ["malformed date", { ...body, checkin: "2026/08/01" }],
    ["guest count below range", { ...body, guests: 0 }],
    ["fractional guest count", { ...body, guests: 1.5 }],
    ["string guest count", { ...body, guests: "2" }],
    ["null body", null],
    ["array body", [body]],
  ])("maps a transport failure for %s to the stable quote error", async (_name, invalidBody) => {
    const { quotes, server } = await createApp();
    const response = await request(server)
      .post("/api/v1/quotes")
      .send(invalidBody ?? undefined)
      .expect(400);
    expect(response.body).toMatchObject({
      error: {
        code: "QUOTE_REQUEST_INVALID",
        message: "报价请求无效，请检查入住信息",
      },
    });
    expect(response.body).toHaveProperty("request_id");
    expect(quotes.create).not.toHaveBeenCalled();
  });

  it("lets the service reject a structurally valid but impossible calendar date", async () => {
    const { quotes, server } = await createApp();
    quotes.create.mockRejectedValue(
      new BusinessException(400, "QUOTE_REQUEST_INVALID", "报价请求无效，请检查入住信息"),
    );
    const response = await request(server)
      .post("/api/v1/quotes")
      .send({ ...body, checkin: "2026-02-30" })
      .expect(400);
    expect(response.body).toMatchObject({ error: { code: "QUOTE_REQUEST_INVALID" } });
    expect(quotes.create).toHaveBeenCalledOnce();
  });

  it("maps truncated JSON rejected by the body parser to the stable quote error", async () => {
    const { quotes, server } = await createApp();
    const response = await request(server)
      .post("/api/v1/quotes")
      .set("Content-Type", "application/json")
      .send('{"room_type_id":')
      .expect(400);
    expect(response.body).toMatchObject({
      error: {
        code: "QUOTE_REQUEST_INVALID",
        message: "报价请求无效，请检查入住信息",
      },
    });
    expect(response.body).toHaveProperty("request_id");
    expect(quotes.create).not.toHaveBeenCalled();
  });

  it.each([
    ["__proto__", '{"__proto__":{"polluted":true}}'],
    ["constructor", '{"constructor":{"prototype":{"polluted":true}}}'],
    ["prototype", '{"prototype":{"polluted":true}}'],
    ["ordinary extra", '{"extra":true}'],
  ])("rejects a JSON parsed %s own key without prototype pollution", (_name, extraJson) => {
    const hostile = JSON.parse(
      `${JSON.stringify(body).slice(0, -1)},${extraJson.slice(1)}`,
    ) as object;
    const pipe = new QuoteRequestPipe();
    expect(() => pipe.transform(hostile)).toThrowError(
      expect.objectContaining({
        code: "QUOTE_REQUEST_INVALID",
        message: "报价请求无效，请检查入住信息",
      }),
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects an enumerable accessor without reading it", () => {
    let getterReads = 0;
    const hostile = Object.defineProperty({ ...body }, "guests", {
      configurable: true,
      enumerable: true,
      get: () => {
        getterReads += 1;
        return 2;
      },
    });
    expect(() => new QuoteRequestPipe().transform(hostile)).toThrowError(
      expect.objectContaining({ code: "QUOTE_REQUEST_INVALID" }),
    );
    expect(getterReads).toBe(0);
  });

  it("accepts an exact null-prototype data record", () => {
    const input = Object.assign(Object.create(null) as object, body);
    expect(new QuoteRequestPipe().transform(input)).toEqual(body);
  });

  it.each([
    [
      "accessor",
      Object.defineProperty({ ...body }, "guests", {
        configurable: true,
        enumerable: true,
        get: () => {
          throw new Error("accessor-secret");
        },
      }),
    ],
    [
      "proxy trap",
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error("proxy-secret");
          },
        },
      ),
    ],
  ])("sanitizes a hostile %s body without invoking the service", (_name, hostile) => {
    const pipe = new QuoteRequestPipe();
    let captured: unknown;
    try {
      pipe.transform(hostile);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(BusinessException);
    expect(captured).toMatchObject({
      code: "QUOTE_REQUEST_INVALID",
      message: "报价请求无效，请检查入住信息",
    });
    expect(JSON.stringify(captured)).not.toMatch(/accessor-secret|proxy-secret/);
  });

  it.each([
    [404, "ROOM_NOT_AVAILABLE"],
    [422, "ROOM_CAPACITY_EXCEEDED"],
    [429, "RATE_LIMITED"],
    [503, "BOOKING_SERVICE_UNAVAILABLE"],
  ])("preserves safe %s business errors", async (status, code) => {
    const { quotes, server } = await createApp();
    quotes.create.mockRejectedValue(new BusinessException(status, code, "安全提示"));
    const response = await request(server).post("/api/v1/quotes").send(body).expect(status);
    expect(response.body).toMatchObject({ error: { code, message: "安全提示" } });
    expect(response.body).toHaveProperty("request_id");
  });
});

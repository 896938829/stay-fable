/* eslint-disable @typescript-eslint/unbound-method */
import type { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";

import type { Clock } from "../src/common/clock/clock.js";
import { BusinessException } from "../src/common/http/business.exception.js";
import { decodeBookingCursor, encodeBookingCursor } from "../src/booking/booking-cursor.js";
import {
  BookingQueryRepository,
  type BookingQueryDatabase,
} from "../src/booking/booking-query.repository.js";
import { BookingQueryService } from "../src/booking/booking-query.service.js";
import type { Prisma } from "../src/generated/prisma/client.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "10000000-0000-4000-8000-000000000002";
const BOOKING_ID = "30000000-0000-4000-8000-000000000001";
const NEXT_BOOKING_ID = "30000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-07-30T02:05:00.000Z");

const baseRow = {
  id: BOOKING_ID,
  bookingNumber: "SF20260730A1B2C3D4E5F6",
  status: "PENDING_PAYMENT",
  propertySnapshot: {
    id: "50000000-0000-4000-8000-000000000001",
    name: "西湖云栖酒店",
  },
  roomTypeSnapshot: {
    id: "60000000-0000-4000-8000-000000000001",
    name: "湖景大床房",
    cover_url: "/images/catalog/room.jpg",
  },
  checkin: "2026-08-01",
  checkout: "2026-08-03",
  guests: 2,
  totalPriceCents: 121_600,
  currency: "CNY",
  expiresAt: new Date("2026-07-30T02:15:00.000Z"),
  createdAt: new Date("2026-07-30T02:00:00.000Z"),
  updatedAt: new Date("2026-07-30T02:01:00.000Z"),
};

const detailRow = {
  ...baseRow,
  nightlyPrices: [
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
  bookingPolicy: "入住前一天 18:00 前可免费取消",
  latestPayment: {
    paymentNumber: "SFP20260730A1B2C3D4E5F6",
    status: "SUCCEEDED",
    processedAt: new Date("2026-07-30T02:02:00.000Z"),
  },
  statusHistory: [
    {
      fromStatus: null,
      toStatus: "PENDING_PAYMENT",
      reason: "BOOKING_CREATED",
      actorType: "USER",
      createdAt: new Date("2026-07-30T02:00:00.000Z"),
    },
  ],
};

const createHarness = (
  options: {
    mockEnabled?: boolean;
    listRows?: unknown;
    detail?: unknown;
  } = {},
) => {
  const repository = {
    listOwned: vi.fn(() => Promise.resolve(options.listRows ?? [baseRow])),
    findOwned: vi.fn(() =>
      Promise.resolve(Object.hasOwn(options, "detail") ? options.detail : detailRow),
    ),
  };
  const clock: Clock = { now: vi.fn(() => new Date(NOW)) };
  const config = {
    getOrThrow: vi.fn((key: string) => {
      expect(key).toBe("ENABLE_MOCK_PAYMENT");
      return options.mockEnabled ?? false;
    }),
  } as unknown as ConfigService;
  return {
    repository,
    clock,
    config,
    service: new BookingQueryService(
      repository as unknown as BookingQueryRepository,
      clock,
      config,
    ),
  };
};

describe("booking cursor", () => {
  it("round-trips exact base64url JSON createdAt and id values", () => {
    const input = { createdAt: "2026-07-30T02:00:00.000Z", id: BOOKING_ID };
    const encoded = encodeBookingCursor(input);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))).toEqual(input);
    expect(decodeBookingCursor(encoded)).toEqual(input);
  });

  it("accepts a valid UTC instant without a fractional second", () => {
    const input = { createdAt: "2026-07-30T02:00:00Z", id: BOOKING_ID };
    expect(decodeBookingCursor(encodeBookingCursor(input))).toEqual(input);
  });

  it.each([
    ["not canonical base64url", "e30="],
    ["not JSON", Buffer.from("secret-cursor").toString("base64url")],
    [
      "extra key",
      Buffer.from(
        JSON.stringify({
          createdAt: "2026-07-30T02:00:00.000Z",
          id: BOOKING_ID,
          secret: true,
        }),
      ).toString("base64url"),
    ],
    [
      "non-UTC instant",
      Buffer.from(
        JSON.stringify({ createdAt: "2026-07-30T10:00:00+08:00", id: BOOKING_ID }),
      ).toString("base64url"),
    ],
    [
      "invalid calendar instant",
      Buffer.from(
        JSON.stringify({ createdAt: "2026-02-30T02:00:00.000Z", id: BOOKING_ID }),
      ).toString("base64url"),
    ],
    [
      "invalid UUID",
      Buffer.from(
        JSON.stringify({ createdAt: "2026-07-30T02:00:00.000Z", id: "not-a-uuid" }),
      ).toString("base64url"),
    ],
  ])("returns a stable non-reflective error for %s", (_label, cursor) => {
    let captured: unknown;
    try {
      decodeBookingCursor(cursor);
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({
      status: 400,
      code: "ORDER_CURSOR_INVALID",
      message: "订单分页游标无效",
    });
    expect(JSON.stringify(captured)).not.toContain(cursor);
    expect(JSON.stringify(captured)).not.toContain("secret-cursor");
  });
});

describe("BookingQueryRepository", () => {
  it("uses owner-only tuple pagination, descending order, and limit plus one", async () => {
    const queryRaw = vi.fn((query: Prisma.Sql) => {
      void query;
      return Promise.resolve([]);
    });
    const repository = new BookingQueryRepository({
      $queryRaw: queryRaw,
    } as BookingQueryDatabase);
    await repository.listOwned(USER_ID, {
      limit: 2,
      after: { createdAt: "2026-07-30T02:00:00.000Z", id: BOOKING_ID },
    });
    const query = queryRaw.mock.calls[0]?.[0] as Prisma.Sql;
    const sql = query.sql.replaceAll(/\s+/g, " ");
    expect(sql).toContain('WHERE booking."user_id" = ');
    expect(sql).toContain('(booking."created_at", booking."id") < (');
    expect(sql).toContain('ORDER BY booking."created_at" DESC, booking."id" DESC');
    expect(sql).toContain("LIMIT");
    expect(query.values).toEqual([
      USER_ID,
      "2026-07-30T02:00:00.000Z",
      "2026-07-30T02:00:00.000Z",
      BOOKING_ID,
      3,
    ]);
    expect(sql).not.toMatch(/idempotency|quote_id|inventory|hold|user\./i);
  });

  it("looks up details by booking id and owner and caps history at 100", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([baseRow])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const repository = new BookingQueryRepository({
      $queryRaw: queryRaw,
    } as BookingQueryDatabase);
    await repository.findOwned(USER_ID, BOOKING_ID);
    expect(queryRaw).toHaveBeenCalledTimes(3);
    const [bookingSql, paymentSql, historySql] = queryRaw.mock.calls.map(([query]) =>
      (query as Prisma.Sql).sql.replaceAll(/\s+/g, " "),
    );
    expect(bookingSql).toContain('booking."id" =');
    expect(bookingSql).toContain('booking."user_id" =');
    expect(paymentSql).toContain('ORDER BY payment."created_at" DESC, payment."id" DESC');
    expect(paymentSql).toContain("LIMIT 1");
    expect(historySql).toContain("LIMIT 100");
    expect(`${bookingSql}${paymentSql}${historySql}`).not.toMatch(
      /idempotency|actor_user_id|inventory|hold|quote_id|JOIN "user"/i,
    );
  });
});

describe("BookingQueryService", () => {
  it("filters every list call by the current user and emits a next cursor from limit plus one", async () => {
    const second = {
      ...baseRow,
      id: NEXT_BOOKING_ID,
      bookingNumber: "SF20260730A1B2C3D4E5F7",
      createdAt: new Date("2026-07-30T01:00:00.000Z"),
    };
    const extra = {
      ...baseRow,
      id: "30000000-0000-4000-8000-000000000003",
      bookingNumber: "SF20260730A1B2C3D4E5F8",
      createdAt: new Date("2026-07-30T00:00:00.000Z"),
    };
    const { service, repository, clock } = createHarness({ listRows: [baseRow, second, extra] });
    const result = await service.listOwned(USER_ID, { limit: "2" });
    expect(repository.listOwned).toHaveBeenCalledWith(USER_ID, { limit: 2 });
    expect(result.items.map(({ booking_id }) => booking_id)).toEqual([BOOKING_ID, NEXT_BOOKING_ID]);
    expect(result.next_cursor).not.toBeNull();
    expect(decodeBookingCursor(result.next_cursor!)).toEqual({
      createdAt: "2026-07-30T01:00:00.000Z",
      id: NEXT_BOOKING_ID,
    });
    expect(clock.now).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toMatch(/user_id|quote_id|idempotency|inventory|hold/i);
  });

  it("decodes a valid cursor and always sends the current user to the repository", async () => {
    const cursor = encodeBookingCursor({
      createdAt: "2026-07-30T02:00:00.000Z",
      id: BOOKING_ID,
    });
    const { service, repository } = createHarness({ listRows: [] });
    await service.listOwned(OTHER_USER_ID, { limit: 10, cursor });
    expect(repository.listOwned).toHaveBeenCalledWith(OTHER_USER_ID, {
      limit: 10,
      after: { createdAt: "2026-07-30T02:00:00.000Z", id: BOOKING_ID },
    });
  });

  it("maps payment and history while preserving owner-only detail lookup", async () => {
    const { service, repository, clock } = createHarness({ mockEnabled: true });
    const result = await service.getOwned(USER_ID, BOOKING_ID);
    expect(repository.findOwned).toHaveBeenCalledWith(USER_ID, BOOKING_ID);
    expect(result.latest_payment).toEqual({
      payment_number: "SFP20260730A1B2C3D4E5F6",
      status: "SUCCEEDED",
      processed_at: "2026-07-30T02:02:00.000Z",
    });
    expect(result.status_history).toEqual([
      {
        from_status: null,
        to_status: "PENDING_PAYMENT",
        reason: "BOOKING_CREATED",
        actor_type: "USER",
        created_at: "2026-07-30T02:00:00.000Z",
      },
    ]);
    expect(result.allowed_actions).toEqual(["CANCEL", "MOCK_PAY_SUCCESS", "MOCK_PAY_FAILURE"]);
    expect(clock.now).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toMatch(/user_id|quote_id|idempotency|inventory|hold/i);
  });

  it("omits payment actions when mock payment is disabled", async () => {
    const { service } = createHarness({ mockEnabled: false });
    await expect(service.getOwned(USER_ID, BOOKING_ID)).resolves.toMatchObject({
      allowed_actions: ["CANCEL"],
    });
  });

  it.each([
    ["expired", { expiresAt: new Date(NOW) }],
    ["already paid", { status: "PAID" }],
  ])("returns no actions for an %s booking", async (_label, override) => {
    const { service } = createHarness({ detail: { ...detailRow, ...override }, mockEnabled: true });
    await expect(service.getOwned(USER_ID, BOOKING_ID)).resolves.toMatchObject({
      allowed_actions: [],
    });
  });

  it("uses the same not-found response for missing and cross-user details", async () => {
    const { service } = createHarness({ detail: null });
    await expect(service.getOwned(OTHER_USER_ID, BOOKING_ID)).rejects.toMatchObject({
      status: 404,
      code: "BOOKING_NOT_FOUND",
      message: "订单不存在",
    });
  });

  it("treats an undefined repository detail as unavailable rather than not found", async () => {
    const { service } = createHarness({ detail: undefined });
    await expect(service.getOwned(OTHER_USER_ID, BOOKING_ID)).rejects.toMatchObject({
      status: 503,
      code: "BOOKING_LIFECYCLE_UNAVAILABLE",
    });
  });

  it("returns a stable cursor error without repository access or cursor reflection", async () => {
    const cursor = Buffer.from(
      JSON.stringify({ createdAt: "not-an-instant", id: BOOKING_ID }),
    ).toString("base64url");
    const { service, repository } = createHarness();
    let captured: unknown;
    try {
      await service.listOwned(USER_ID, { cursor });
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({ status: 400, code: "ORDER_CURSOR_INVALID" });
    expect(repository.listOwned).not.toHaveBeenCalled();
    expect(JSON.stringify(captured)).not.toContain(cursor);
  });

  it.each([
    ["empty", ""],
    ["wrong type", 42],
    ["array", ["cursor"]],
    ["too long", "A".repeat(513)],
    ["bad base64 JSON", Buffer.from("not-json").toString("base64url")],
    [
      "wrong keys",
      Buffer.from(JSON.stringify({ createdAt: "2026-07-30T02:00:00.000Z" })).toString("base64url"),
    ],
  ])("classifies a present but %s cursor as ORDER_CURSOR_INVALID", async (_label, cursor) => {
    const { service, repository } = createHarness();
    let captured: unknown;
    try {
      await service.listOwned(USER_ID, { cursor });
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({ status: 400, code: "ORDER_CURSOR_INVALID" });
    expect(repository.listOwned).not.toHaveBeenCalled();
    if (typeof cursor === "string" && cursor.length > 0) {
      expect(JSON.stringify(captured)).not.toContain(cursor);
    }
  });

  it("rejects an accessor cursor without invoking or reflecting it", async () => {
    let reads = 0;
    const query = Object.defineProperty({}, "cursor", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("cursor-getter-secret");
      },
    });
    const { service, repository } = createHarness();
    let captured: unknown;
    try {
      await service.listOwned(USER_ID, query);
    } catch (error) {
      captured = error;
    }
    expect(reads).toBe(0);
    expect(captured).toMatchObject({ status: 400, code: "ORDER_CURSOR_INVALID" });
    expect(JSON.stringify(captured)).not.toContain("cursor-getter-secret");
    expect(repository.listOwned).not.toHaveBeenCalled();
  });

  it("rejects a proxy query as a generic safe BAD_REQUEST", async () => {
    const query = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("query-proxy-secret");
        },
      },
    );
    const { service, repository } = createHarness();
    let captured: unknown;
    try {
      await service.listOwned(USER_ID, query);
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({
      status: 400,
      code: "BAD_REQUEST",
      message: "请求处理失败",
    });
    expect(JSON.stringify(captured)).not.toContain("query-proxy-secret");
    expect(repository.listOwned).not.toHaveBeenCalled();
  });

  it("uses generic BAD_REQUEST for non-cursor query and direct booking id validation", async () => {
    const { service, repository } = createHarness();
    await expect(service.listOwned(USER_ID, { limit: 0 })).rejects.toMatchObject({
      status: 400,
      code: "BAD_REQUEST",
      message: "请求处理失败",
    });
    await expect(service.getOwned(USER_ID, "not-a-uuid")).rejects.toMatchObject({
      status: 400,
      code: "BAD_REQUEST",
      message: "请求处理失败",
    });
    expect(repository.listOwned).not.toHaveBeenCalled();
    expect(repository.findOwned).not.toHaveBeenCalled();
  });

  it("does not trust a repository-spoofed BOOKING_NOT_FOUND or leak its secret", async () => {
    const { service, repository } = createHarness();
    repository.findOwned.mockRejectedValueOnce(
      new BusinessException(404, "BOOKING_NOT_FOUND", "repository-secret"),
    );
    let captured: unknown;
    try {
      await service.getOwned(USER_ID, BOOKING_ID);
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({
      status: 503,
      code: "BOOKING_LIFECYCLE_UNAVAILABLE",
      message: "订单服务暂时不可用，请稍后重试",
    });
    expect(JSON.stringify(captured)).not.toContain("repository-secret");
  });

  it.each([
    [
      "getter",
      Object.defineProperty({ ...detailRow }, "propertySnapshot", {
        enumerable: true,
        get: () => {
          throw new Error("getter-secret");
        },
      }),
    ],
    [
      "proxy",
      new Proxy(detailRow, {
        get: () => {
          throw new Error("proxy-secret");
        },
      }),
    ],
    ["symbol", { ...detailRow, [Symbol("secret")]: true }],
    ["extra", { ...detailRow, unexpected: true }],
    ["deep", { ...detailRow, propertySnapshot: { nested: { nested: { nested: detailRow } } } }],
  ])(
    "sanitizes hostile repository %s output into a safe business failure",
    async (_label, detail) => {
      const { service } = createHarness({ detail });
      let captured: unknown;
      try {
        await service.getOwned(USER_ID, BOOKING_ID);
      } catch (error) {
        captured = error;
      }
      expect(captured).toMatchObject({
        status: 503,
        code: "BOOKING_LIFECYCLE_UNAVAILABLE",
        message: "订单服务暂时不可用，请稍后重试",
      });
      expect(JSON.stringify(captured)).not.toMatch(/getter-secret|proxy-secret/);
    },
  );
});

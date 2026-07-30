/* eslint-disable @typescript-eslint/unbound-method */
import { describe, expect, it, vi } from "vitest";

import type { Clock } from "../src/common/clock/clock.js";
import { BusinessException } from "../src/common/http/business.exception.js";
import type { WriteRateLimitService } from "../src/common/rate-limit/write-rate-limit.service.js";
import {
  BookingLifecycleRepository,
  type BookingLifecycleDatabase,
  type BookingLifecycleTransaction,
} from "../src/booking/booking-lifecycle.repository.js";
import { BookingLifecycleService } from "../src/booking/booking-lifecycle.service.js";
import type { BookingQueryService } from "../src/booking/booking-query.service.js";
import type { Prisma } from "../src/generated/prisma/client.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "10000000-0000-4000-8000-000000000002";
const BOOKING_ID = "30000000-0000-4000-8000-000000000001";
const ROOM_TYPE_ID = "60000000-0000-4000-8000-000000000001";
const HOLD_IDS = ["70000000-0000-4000-8000-000000000001", "70000000-0000-4000-8000-000000000002"];
const NOW = new Date("2026-07-30T02:05:00.000Z");

const cancelledDetail = {
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
  status_history: [
    {
      from_status: "PENDING_PAYMENT",
      to_status: "CANCELLED",
      reason: "USER_CANCELLED",
      actor_type: "USER",
      created_at: "2026-07-30T02:05:00.000Z",
    },
  ],
  allowed_actions: [],
};

const queryText = (query: Prisma.Sql): string => query.sql.replaceAll(/\s+/g, " ");

const bookingRow = (overrides: Record<string, unknown> = {}) => ({
  id: BOOKING_ID,
  status: "PENDING_PAYMENT",
  roomTypeId: ROOM_TYPE_ID,
  checkin: "2026-08-01",
  checkout: "2026-08-03",
  expiresAt: new Date("2026-07-30T02:15:00.000Z"),
  ...overrides,
});

const holds = [
  { id: HOLD_IDS[0], roomTypeId: ROOM_TYPE_ID, businessDate: "2026-08-01" },
  { id: HOLD_IDS[1], roomTypeId: ROOM_TYPE_ID, businessDate: "2026-08-02" },
];
const inventories = [
  { roomTypeId: ROOM_TYPE_ID, businessDate: "2026-08-01" },
  { roomTypeId: ROOM_TYPE_ID, businessDate: "2026-08-02" },
];

const successfulTransactionResults = (booking = bookingRow()): unknown[] => [
  [booking],
  holds,
  inventories,
  [inventories[0]],
  [inventories[1]],
  [{ id: HOLD_IDS[0] }, { id: HOLD_IDS[1] }],
  [{ id: BOOKING_ID }],
  [{ id: "80000000-0000-4000-8000-000000000001" }],
];

const createLifecycleDatabase = (results: unknown[]) => {
  let index = 0;
  let rollbackCount = 0;
  let commitCount = 0;
  const transaction = {
    $queryRaw: vi.fn(() => Promise.resolve(results[index++])),
  } as unknown as BookingLifecycleTransaction;
  const database = {
    get commitCount() {
      return commitCount;
    },
    get rollbackCount() {
      return rollbackCount;
    },
    $transaction: vi.fn(
      async <T>(operation: (client: BookingLifecycleTransaction) => Promise<T>) => {
        try {
          const result = await operation(transaction);
          commitCount += 1;
          return result;
        } catch (error) {
          rollbackCount += 1;
          throw error;
        }
      },
    ),
  } as unknown as BookingLifecycleDatabase & {
    commitCount: number;
    rollbackCount: number;
  };
  return { database, transaction };
};

describe("BookingLifecycleRepository.cancelOwnedBooking", () => {
  it("locks and releases every night in the fixed transaction order before cancelling", async () => {
    const { database, transaction } = createLifecycleDatabase(successfulTransactionResults());
    const repository = new BookingLifecycleRepository(database);

    await expect(
      repository.cancelOwnedBooking({ userId: USER_ID, bookingId: BOOKING_ID, now: NOW }),
    ).resolves.toEqual({ kind: "CANCELLED", bookingId: BOOKING_ID });

    expect(database.$transaction).toHaveBeenCalledOnce();
    expect(database.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "ReadCommitted",
    });
    expect(database.commitCount).toBe(1);
    expect(database.rollbackCount).toBe(0);
    const queries = vi.mocked(transaction.$queryRaw).mock.calls.map(([query]) => queryText(query));
    expect(queries).toHaveLength(8);
    expect(queries[0]).toMatch(/FROM "booking".*user_id.*FOR UPDATE/);
    expect(queries[1]).toMatch(
      /FROM "inventory_hold".*status.*HELD.*ORDER BY .*business_date.*ASC.*id.*ASC.*FOR UPDATE/,
    );
    expect(queries[2]).toMatch(/FROM "daily_inventory".*ORDER BY .*business_date.*ASC.*FOR UPDATE/);
    expect(queries[3]).toContain('"held_inventory" = "held_inventory" - 1');
    expect(queries[3]).toContain('"held_inventory" > 0');
    expect(queries[4]).toContain('"held_inventory" = "held_inventory" - 1');
    expect(queries[5]).toMatch(/UPDATE "inventory_hold".*status.*RELEASED/);
    expect(queries[6]).toMatch(/UPDATE "booking".*status.*PENDING_PAYMENT/);
    expect(queries[7]).toContain('INSERT INTO "booking_status_history"');
    expect((vi.mocked(transaction.$queryRaw).mock.calls[6]?.[0] as Prisma.Sql).values).toContain(
      "CANCELLED",
    );
    expect((vi.mocked(transaction.$queryRaw).mock.calls[7]?.[0] as Prisma.Sql).values).toEqual(
      expect.arrayContaining(["CANCELLED", "USER_CANCELLED", "USER", USER_ID]),
    );
  });

  it("replays an already cancelled booking without releasing inventory or writing history", async () => {
    const { database, transaction } = createLifecycleDatabase([
      [bookingRow({ status: "CANCELLED" })],
    ]);
    const repository = new BookingLifecycleRepository(database);

    await expect(
      repository.cancelOwnedBooking({ userId: USER_ID, bookingId: BOOKING_ID, now: NOW }),
    ).resolves.toEqual({ kind: "REPLAYED", bookingId: BOOKING_ID });
    expect(transaction.$queryRaw).toHaveBeenCalledOnce();
    expect(database.commitCount).toBe(1);
  });

  it.each([
    ["missing or cross-user", [], { kind: "NOT_FOUND" }],
    ["confirmed", [bookingRow({ status: "CONFIRMED" })], { kind: "NOT_CANCELLABLE" }],
    ["closed", [bookingRow({ status: "CLOSED" })], { kind: "NOT_CANCELLABLE" }],
    ["paid", [bookingRow({ status: "PAID" })], { kind: "NOT_CANCELLABLE" }],
  ])("returns the exact terminal result for %s", async (_label, rows, expected) => {
    const { database, transaction } = createLifecycleDatabase([rows]);
    const repository = new BookingLifecycleRepository(database);
    await expect(
      repository.cancelOwnedBooking({ userId: USER_ID, bookingId: BOOKING_ID, now: NOW }),
    ).resolves.toEqual(expected);
    expect(transaction.$queryRaw).toHaveBeenCalledOnce();
  });

  it("commits an expired pending booking as CLOSED with SYSTEM timeout history", async () => {
    const expired = bookingRow({ expiresAt: new Date(NOW) });
    const { database, transaction } = createLifecycleDatabase(
      successfulTransactionResults(expired),
    );
    const repository = new BookingLifecycleRepository(database);

    await expect(
      repository.cancelOwnedBooking({ userId: USER_ID, bookingId: BOOKING_ID, now: NOW }),
    ).resolves.toEqual({ kind: "EXPIRED", bookingId: BOOKING_ID });
    expect(database.commitCount).toBe(1);
    expect((vi.mocked(transaction.$queryRaw).mock.calls[6]?.[0] as Prisma.Sql).values).toContain(
      "CLOSED",
    );
    const historyValues = (vi.mocked(transaction.$queryRaw).mock.calls[7]?.[0] as Prisma.Sql)
      .values;
    expect(historyValues).toEqual(
      expect.arrayContaining(["CLOSED", "PAYMENT_TIMEOUT", "SYSTEM", null]),
    );
    expect(historyValues).not.toContain(USER_ID);
  });

  it.each([
    ["missing held night", [bookingRow()], holds.slice(0, 1)],
    ["missing inventory night", [bookingRow()], holds, inventories.slice(0, 1)],
    ["conditional inventory miss", [bookingRow()], holds, inventories, [inventories[0]], []],
    [
      "hold release count mismatch",
      [bookingRow()],
      holds,
      inventories,
      [inventories[0]],
      [inventories[1]],
      [{ id: HOLD_IDS[0] }],
    ],
  ])("throws a rollback sentinel for %s", async (_label, ...results) => {
    const { database } = createLifecycleDatabase(results);
    const repository = new BookingLifecycleRepository(database);
    await expect(
      repository.cancelOwnedBooking({ userId: USER_ID, bookingId: BOOKING_ID, now: NOW }),
    ).rejects.toThrow();
    expect(database.commitCount).toBe(0);
    expect(database.rollbackCount).toBe(1);
  });

  it("rolls back duplicate released hold rows before booking and history writes", async () => {
    const duplicateReleaseResults = [
      [bookingRow()],
      holds,
      inventories,
      [inventories[0]],
      [inventories[1]],
      [{ id: HOLD_IDS[0] }, { id: HOLD_IDS[1] }, { id: HOLD_IDS[0] }],
    ];
    const { database, transaction } = createLifecycleDatabase(duplicateReleaseResults);
    const repository = new BookingLifecycleRepository(database);

    await expect(
      repository.cancelOwnedBooking({ userId: USER_ID, bookingId: BOOKING_ID, now: NOW }),
    ).rejects.toThrow();

    expect(database.commitCount).toBe(0);
    expect(database.rollbackCount).toBe(1);
    const queries = vi.mocked(transaction.$queryRaw).mock.calls.map(([query]) => queryText(query));
    expect(queries).toHaveLength(6);
    expect(queries).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining('UPDATE "booking"'),
        expect.stringContaining('INSERT INTO "booking_status_history"'),
      ]),
    );

    const serviceDatabase = createLifecycleDatabase(duplicateReleaseResults);
    const query = { getOwned: vi.fn() };
    const service = new BookingLifecycleService(
      new BookingLifecycleRepository(serviceDatabase.database),
      {
        checkBookingCancellation: vi.fn(() => Promise.resolve()),
      } as unknown as WriteRateLimitService,
      { now: () => new Date(NOW) },
      query as unknown as BookingQueryService,
    );

    await expect(service.cancel(USER_ID, BOOKING_ID, {})).rejects.toMatchObject({
      status: 503,
      code: "BOOKING_LIFECYCLE_UNAVAILABLE",
    });
    expect(serviceDatabase.database.rollbackCount).toBe(1);
    expect(serviceDatabase.transaction.$queryRaw).toHaveBeenCalledTimes(6);
    expect(query.getOwned).not.toHaveBeenCalled();
  });

  it.each([
    ["getter row", [Object.defineProperty(bookingRow(), "status", { get: () => "CANCELLED" })]],
    ["proxy row", [new Proxy(bookingRow(), { ownKeys: () => ["secret"] })]],
    ["symbol row", [{ ...bookingRow(), [Symbol("secret")]: true }]],
  ])("fails closed for hostile database %s", async (_label, rows) => {
    const { database } = createLifecycleDatabase([rows]);
    const repository = new BookingLifecycleRepository(database);
    await expect(
      repository.cancelOwnedBooking({ userId: USER_ID, bookingId: BOOKING_ID, now: NOW }),
    ).rejects.toThrow();
    expect(database.rollbackCount).toBe(1);
  });
});

const createServiceHarness = (result: unknown = { kind: "CANCELLED", bookingId: BOOKING_ID }) => {
  const repository = {
    cancelOwnedBooking: vi.fn(() => Promise.resolve(result)),
  };
  const rateLimit = {
    checkBookingCancellation: vi.fn(() => Promise.resolve()),
  };
  const clock: Clock = { now: vi.fn(() => new Date(NOW)) };
  const query = {
    getOwned: vi.fn(() => Promise.resolve(cancelledDetail)),
  };
  const service = new BookingLifecycleService(
    repository as unknown as BookingLifecycleRepository,
    rateLimit as unknown as WriteRateLimitService,
    clock,
    query as unknown as BookingQueryService,
  );
  return { clock, query, rateLimit, repository, service };
};

describe("BookingLifecycleService.cancel", () => {
  it.each([
    ["CANCELLED", false],
    ["REPLAYED", true],
  ] as const)("returns one shared detail projection for %s", async (kind, replayed) => {
    const { clock, query, rateLimit, repository, service } = createServiceHarness({
      kind,
      bookingId: BOOKING_ID,
    });
    await expect(service.cancel(USER_ID, BOOKING_ID, {})).resolves.toEqual({
      replayed,
      booking: cancelledDetail,
    });
    expect(rateLimit.checkBookingCancellation).toHaveBeenCalledWith(USER_ID);
    expect(clock.now).toHaveBeenCalledOnce();
    expect(repository.cancelOwnedBooking).toHaveBeenCalledWith({
      userId: USER_ID,
      bookingId: BOOKING_ID,
      now: NOW,
    });
    expect(query.getOwned).toHaveBeenCalledWith(USER_ID, BOOKING_ID);
    expect(vi.mocked(query.getOwned).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(repository.cancelOwnedBooking).mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    [{ kind: "NOT_FOUND" }, 404, "BOOKING_NOT_FOUND"],
    [{ kind: "NOT_CANCELLABLE" }, 409, "BOOKING_NOT_CANCELLABLE"],
    [{ kind: "EXPIRED", bookingId: BOOKING_ID }, 409, "BOOKING_EXPIRED"],
  ])(
    "maps $0.kind to its stable domain error without querying a detail",
    async (result, status, code) => {
      const { query, service } = createServiceHarness(result);
      await expect(service.cancel(USER_ID, BOOKING_ID, {})).rejects.toMatchObject({ status, code });
      expect(query.getOwned).not.toHaveBeenCalled();
    },
  );

  it("rate limits after valid input and before repository access", async () => {
    const { rateLimit, repository, service } = createServiceHarness();
    vi.mocked(rateLimit.checkBookingCancellation).mockRejectedValueOnce(
      new BusinessException(429, "RATE_LIMITED", "操作过于频繁，请稍后重试", {
        retry_after_seconds: 7,
      }),
    );
    await expect(service.cancel(USER_ID, BOOKING_ID, {})).rejects.toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
      details: { retry_after_seconds: 7 },
    });
    expect(repository.cancelOwnedBooking).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid user", "not-a-uuid", BOOKING_ID, {}],
    ["invalid booking", USER_ID, "not-a-uuid", {}],
    ["non-empty body", USER_ID, BOOKING_ID, { unexpected: true }],
    [
      "hostile body",
      USER_ID,
      BOOKING_ID,
      Object.defineProperty({}, "secret", { enumerable: true, get: () => "secret" }),
    ],
  ])("rejects %s before rate limiting", async (_label, userId, bookingId, body) => {
    const { rateLimit, service } = createServiceHarness();
    await expect(service.cancel(userId, bookingId, body)).rejects.toMatchObject({
      status: 400,
      code: "BAD_REQUEST",
    });
    expect(rateLimit.checkBookingCancellation).not.toHaveBeenCalled();
  });

  it("maps Redis, clock, repository and projection failures to one safe 503", async () => {
    const secrets = ["redis-secret", "clock-secret", "repository-secret", "projection-secret"];
    const cases: Array<() => ReturnType<typeof createServiceHarness>> = [
      () => {
        const harness = createServiceHarness();
        vi.mocked(harness.rateLimit.checkBookingCancellation).mockRejectedValueOnce(
          new Error(secrets[0]),
        );
        return harness;
      },
      () => {
        const harness = createServiceHarness();
        vi.mocked(harness.clock.now).mockImplementationOnce(() => {
          throw new Error(secrets[1]);
        });
        return harness;
      },
      () => {
        const harness = createServiceHarness();
        vi.mocked(harness.repository.cancelOwnedBooking).mockRejectedValueOnce(
          new BusinessException(404, "BOOKING_NOT_FOUND", secrets[2]!),
        );
        return harness;
      },
      () => {
        const harness = createServiceHarness();
        vi.mocked(harness.query.getOwned).mockRejectedValueOnce(new Error(secrets[3]));
        return harness;
      },
    ];
    for (const create of cases) {
      const { service } = create();
      let captured: unknown;
      try {
        await service.cancel(USER_ID, BOOKING_ID, {});
      } catch (error) {
        captured = error;
      }
      expect(captured).toMatchObject({
        status: 503,
        code: "BOOKING_LIFECYCLE_UNAVAILABLE",
      });
      expect(JSON.stringify(captured)).not.toMatch(
        /redis-secret|clock-secret|repository-secret|projection-secret/,
      );
    }
  });

  it.each([
    ["getter", Object.defineProperty({}, "kind", { enumerable: true, get: () => "CANCELLED" })],
    ["proxy", new Proxy({}, { ownKeys: () => ["secret"] })],
    ["symbol", { kind: "CANCELLED", bookingId: BOOKING_ID, [Symbol("secret")]: true }],
    ["unknown kind", { kind: "UNKNOWN" }],
    ["wrong booking", { kind: "CANCELLED", bookingId: OTHER_USER_ID }],
  ])("fails closed for hostile repository %s output", async (_label, result) => {
    const { query, service } = createServiceHarness(result);
    await expect(service.cancel(USER_ID, BOOKING_ID, {})).rejects.toMatchObject({
      status: 503,
      code: "BOOKING_LIFECYCLE_UNAVAILABLE",
    });
    expect(query.getOwned).not.toHaveBeenCalled();
  });

  it("validates the final shared query projection before returning it", async () => {
    const { query, service } = createServiceHarness();
    vi.mocked(query.getOwned).mockResolvedValueOnce({
      ...cancelledDetail,
      idempotency_key: "secret",
    } as never);
    await expect(service.cancel(USER_ID, BOOKING_ID, {})).rejects.toMatchObject({
      status: 503,
      code: "BOOKING_LIFECYCLE_UNAVAILABLE",
    });
  });
});

/* eslint-disable @typescript-eslint/unbound-method */
import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  BookingLifecycleRepository,
  type BookingLifecycleDatabase,
  type BookingLifecycleTransaction,
  PaymentNumberConflictError,
} from "../src/booking/booking-lifecycle.repository.js";
import { MockPaymentService } from "../src/booking/mock-payment.service.js";
import type { PaymentNumberGenerator } from "../src/booking/payment-number.js";
import type { BookingQueryService } from "../src/booking/booking-query.service.js";
import type { Clock } from "../src/common/clock/clock.js";
import { BusinessException } from "../src/common/http/business.exception.js";
import { WriteRateLimitService } from "../src/common/rate-limit/write-rate-limit.service.js";
import { Prisma } from "../src/generated/prisma/client.js";
import type { RedisService } from "../src/infrastructure/redis/redis.service.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "10000000-0000-4000-8000-000000000002";
const BOOKING_ID = "30000000-0000-4000-8000-000000000001";
const ROOM_TYPE_ID = "60000000-0000-4000-8000-000000000001";
const HOLD_IDS = ["70000000-0000-4000-8000-000000000001", "70000000-0000-4000-8000-000000000002"];
const HISTORY_IDS = [
  "80000000-0000-4000-8000-000000000001",
  "80000000-0000-4000-8000-000000000002",
];
const PAYMENT_ID = "90000000-0000-4000-8000-000000000001";
const IDEMPOTENCY_KEY = "mock-payment-key-1234567890_ABCDEF";
const OTHER_KEY = "mock-payment-key-1234567890_ABCDEG";
const PAYMENT_NUMBER = "SFP20260730A1B2C3D4E5F6";
const PAYMENT_NUMBER_2 = "SFP20260730A1B2C3D4E5F7";
const NOW = new Date("2026-07-30T02:05:00.000Z");

const confirmedDetail = {
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
    payment_number: PAYMENT_NUMBER,
    status: "SUCCEEDED",
    processed_at: "2026-07-30T02:05:00.000Z",
  },
  status_history: [
    {
      from_status: "PENDING_PAYMENT",
      to_status: "PAID",
      reason: "MOCK_PAYMENT_SUCCEEDED",
      actor_type: "USER",
      created_at: "2026-07-30T02:05:00.000Z",
    },
    {
      from_status: "PAID",
      to_status: "CONFIRMED",
      reason: "PAYMENT_CONFIRMED",
      actor_type: "SYSTEM",
      created_at: "2026-07-30T02:05:00.000Z",
    },
  ],
  allowed_actions: [],
};

const bookingRow = (overrides: Record<string, unknown> = {}) => ({
  id: BOOKING_ID,
  status: "PENDING_PAYMENT",
  roomTypeId: ROOM_TYPE_ID,
  checkin: "2026-08-01",
  checkout: "2026-08-03",
  expiresAt: new Date("2026-07-30T02:15:00.000Z"),
  totalPriceCents: 121_600,
  currency: "CNY",
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

const successResults = (): unknown[] => [
  [],
  [bookingRow()],
  [],
  holds,
  inventories,
  [inventories[0]],
  [inventories[1]],
  [{ id: HOLD_IDS[0] }, { id: HOLD_IDS[1] }],
  [{ id: PAYMENT_ID, paymentNumber: PAYMENT_NUMBER }],
  [{ id: BOOKING_ID }],
  [{ id: HISTORY_IDS[0] }],
  [{ id: BOOKING_ID }],
  [{ id: HISTORY_IDS[1] }],
];

const queryText = (query: Prisma.Sql): string => query.sql.replaceAll(/\s+/g, " ");

const createLifecycleDatabase = (results: unknown[]) => {
  let index = 0;
  let commits = 0;
  let rollbacks = 0;
  const transaction = {
    $queryRaw: vi.fn(() => Promise.resolve(results[index++])),
  } as unknown as BookingLifecycleTransaction;
  const database = {
    get commits() {
      return commits;
    },
    get rollbacks() {
      return rollbacks;
    },
    $transaction: vi.fn(
      async <T>(operation: (client: BookingLifecycleTransaction) => Promise<T>) => {
        try {
          const result = await operation(transaction);
          commits += 1;
          return result;
        } catch (error) {
          rollbacks += 1;
          throw error;
        }
      },
    ),
  } as unknown as BookingLifecycleDatabase & { commits: number; rollbacks: number };
  return { database, transaction };
};

describe("BookingLifecycleRepository.simulateMockPayment", () => {
  it("uses the fixed success lock/write order and commits CONFIRMED atomically", async () => {
    const { database, transaction } = createLifecycleDatabase(successResults());
    const repository = new BookingLifecycleRepository(database);

    await expect(
      repository.simulateMockPayment({
        userId: USER_ID,
        bookingId: BOOKING_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        outcome: "SUCCEED",
        paymentNumber: PAYMENT_NUMBER,
        now: NOW,
      }),
    ).resolves.toEqual({ kind: "SUCCEEDED", replayed: false, bookingId: BOOKING_ID });

    expect(database.commits).toBe(1);
    expect(database.rollbacks).toBe(0);
    const calls = vi.mocked(transaction.$queryRaw).mock.calls;
    const queries = calls.map(([query]) => queryText(query));
    expect(queries).toHaveLength(13);
    expect(queries[0]).toContain("pg_advisory_xact_lock");
    expect(queries[0]).toContain("hashtextextended");
    expect(queries[1]).toMatch(/FROM "booking".*user_id.*FOR UPDATE/);
    expect(queries[2]).toMatch(/FROM "payment".*idempotency_key/);
    expect(queries[3]).toMatch(
      /FROM "inventory_hold".*HELD.*ORDER BY .*business_date.*ASC.*id.*ASC.*FOR UPDATE/,
    );
    expect(queries[4]).toMatch(/FROM "daily_inventory".*ORDER BY .*business_date.*ASC.*FOR UPDATE/);
    expect(queries[5]).toContain('"held_inventory" = "held_inventory" - 1');
    expect(queries[5]).toContain('"sold_inventory" = "sold_inventory" + 1');
    expect(queries[7]).toMatch(/UPDATE "inventory_hold".*CONSUMED/);
    expect(queries[8]).toMatch(/INSERT INTO "payment"/);
    expect(queries[9]).toMatch(/UPDATE "booking".*BookingStatus/);
    expect(queries[10]).toMatch(/INSERT INTO "booking_status_history"/);
    expect(queries[11]).toMatch(/UPDATE "booking".*BookingStatus/);
    expect(queries[12]).toMatch(/INSERT INTO "booking_status_history"/);
    expect((calls[0]?.[0] as Prisma.Sql).values).toEqual(
      expect.arrayContaining([BOOKING_ID, IDEMPOTENCY_KEY]),
    );
    expect((calls[8]?.[0] as Prisma.Sql).values).toEqual(
      expect.arrayContaining([
        BOOKING_ID,
        PAYMENT_NUMBER,
        "SUCCEEDED",
        "SUCCEED",
        121_600,
        "CNY",
        IDEMPOTENCY_KEY,
      ]),
    );
    expect((calls[10]?.[0] as Prisma.Sql).values).toEqual(
      expect.arrayContaining([
        "PENDING_PAYMENT",
        "PAID",
        "MOCK_PAYMENT_SUCCEEDED",
        "USER",
        USER_ID,
      ]),
    );
    expect((calls[12]?.[0] as Prisma.Sql).values).toEqual(
      expect.arrayContaining(["PAID", "CONFIRMED", "PAYMENT_CONFIRMED", "SYSTEM", null]),
    );
    expect((calls[9]?.[0] as Prisma.Sql).values).toEqual(
      expect.arrayContaining(["PENDING_PAYMENT", "PAID"]),
    );
    expect((calls[11]?.[0] as Prisma.Sql).values).toEqual(
      expect.arrayContaining(["PAID", "CONFIRMED"]),
    );
    for (const [query] of calls) {
      expect(query.sql).not.toContain(USER_ID);
      expect(query.sql).not.toContain(IDEMPOTENCY_KEY);
    }
  });

  it("records a failed payment without touching booking, holds, or inventory", async () => {
    const results = [[], [bookingRow()], [], [{ id: PAYMENT_ID, paymentNumber: PAYMENT_NUMBER }]];
    const { database, transaction } = createLifecycleDatabase(results);
    const repository = new BookingLifecycleRepository(database);

    await expect(
      repository.simulateMockPayment({
        userId: USER_ID,
        bookingId: BOOKING_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        outcome: "FAIL",
        paymentNumber: PAYMENT_NUMBER,
        now: NOW,
      }),
    ).resolves.toEqual({ kind: "FAILED", replayed: false, bookingId: BOOKING_ID });

    const queries = vi.mocked(transaction.$queryRaw).mock.calls.map(([query]) => queryText(query));
    expect(queries).toHaveLength(4);
    expect(queries[3]).toMatch(/INSERT INTO "payment"/);
    expect((vi.mocked(transaction.$queryRaw).mock.calls[3]?.[0] as Prisma.Sql).values).toEqual(
      expect.arrayContaining(["FAILED", "FAIL", 121_600, "CNY"]),
    );
    expect(queries.join(" ")).not.toMatch(
      /UPDATE "booking"|UPDATE "inventory_hold"|UPDATE "daily_inventory"|booking_status_history/,
    );
  });

  it.each([
    ["SUCCEED", "SUCCEEDED", "SUCCEEDED"],
    ["FAIL", "FAILED", "FAILED"],
  ] as const)("replays an existing same-key %s payment", async (outcome, status, kind) => {
    const { database, transaction } = createLifecycleDatabase([
      [],
      [bookingRow({ status: status === "SUCCEEDED" ? "CONFIRMED" : "PENDING_PAYMENT" })],
      [{ requestedOutcome: outcome, status, paymentNumber: PAYMENT_NUMBER }],
    ]);
    const repository = new BookingLifecycleRepository(database);

    await expect(
      repository.simulateMockPayment({
        userId: USER_ID,
        bookingId: BOOKING_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        outcome,
        paymentNumber: PAYMENT_NUMBER_2,
        now: NOW,
      }),
    ).resolves.toEqual({ kind, replayed: true, bookingId: BOOKING_ID });
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it("rejects reusing the same key with a different requested outcome", async () => {
    const { database } = createLifecycleDatabase([
      [],
      [bookingRow()],
      [{ requestedOutcome: "FAIL", status: "FAILED", paymentNumber: PAYMENT_NUMBER }],
    ]);
    const repository = new BookingLifecycleRepository(database);
    await expect(
      repository.simulateMockPayment({
        userId: USER_ID,
        bookingId: BOOKING_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        outcome: "SUCCEED",
        paymentNumber: PAYMENT_NUMBER_2,
        now: NOW,
      }),
    ).resolves.toEqual({ kind: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("returns NOT_FOUND before exposing another user's booking", async () => {
    const { database, transaction } = createLifecycleDatabase([[], []]);
    const repository = new BookingLifecycleRepository(database);
    await expect(
      repository.simulateMockPayment({
        userId: OTHER_USER_ID,
        bookingId: BOOKING_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        outcome: "SUCCEED",
        paymentNumber: PAYMENT_NUMBER,
        now: NOW,
      }),
    ).resolves.toEqual({ kind: "NOT_FOUND" });
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("returns ALREADY_PROCESSED for a terminal booking with a different key", async () => {
    const { database, transaction } = createLifecycleDatabase([
      [],
      [bookingRow({ status: "CONFIRMED" })],
      [],
    ]);
    const repository = new BookingLifecycleRepository(database);
    await expect(
      repository.simulateMockPayment({
        userId: USER_ID,
        bookingId: BOOKING_ID,
        idempotencyKey: OTHER_KEY,
        outcome: "SUCCEED",
        paymentNumber: PAYMENT_NUMBER,
        now: NOW,
      }),
    ).resolves.toEqual({ kind: "ALREADY_PROCESSED" });
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it("closes and releases an expired pending booking before returning EXPIRED", async () => {
    const results = [
      [],
      [bookingRow({ expiresAt: new Date(NOW) })],
      [],
      holds,
      inventories,
      [inventories[0]],
      [inventories[1]],
      [{ id: HOLD_IDS[0] }, { id: HOLD_IDS[1] }],
      [{ id: BOOKING_ID }],
      [{ id: HISTORY_IDS[0] }],
    ];
    const { database, transaction } = createLifecycleDatabase(results);
    const repository = new BookingLifecycleRepository(database);
    await expect(
      repository.simulateMockPayment({
        userId: USER_ID,
        bookingId: BOOKING_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        outcome: "SUCCEED",
        paymentNumber: PAYMENT_NUMBER,
        now: NOW,
      }),
    ).resolves.toEqual({ kind: "EXPIRED", bookingId: BOOKING_ID });
    expect(database.commits).toBe(1);
    const calls = vi.mocked(transaction.$queryRaw).mock.calls;
    expect(calls.map(([query]) => queryText(query)).join(" ")).not.toContain(
      'INSERT INTO "payment"',
    );
    expect((calls[8]?.[0] as Prisma.Sql).values).toContain("CLOSED");
    expect((calls[9]?.[0] as Prisma.Sql).values).toEqual(
      expect.arrayContaining(["PAYMENT_TIMEOUT", "SYSTEM", null]),
    );
  });

  it.each([
    ["missing hold", [[], [bookingRow()], [], holds.slice(0, 1)]],
    [
      "conditional inventory miss",
      [[], [bookingRow()], [], holds, inventories, [inventories[0]], []],
    ],
    [
      "duplicate consumed rows",
      [
        [],
        [bookingRow()],
        [],
        holds,
        inventories,
        [inventories[0]],
        [inventories[1]],
        [{ id: HOLD_IDS[0] }, { id: HOLD_IDS[1] }, { id: HOLD_IDS[0] }],
      ],
    ],
  ])("rolls back all staged success writes for %s", async (_label, results) => {
    const { database } = createLifecycleDatabase(results);
    const repository = new BookingLifecycleRepository(database);
    await expect(
      repository.simulateMockPayment({
        userId: USER_ID,
        bookingId: BOOKING_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        outcome: "SUCCEED",
        paymentNumber: PAYMENT_NUMBER,
        now: NOW,
      }),
    ).rejects.toThrow();
    expect(database.commits).toBe(0);
    expect(database.rollbacks).toBe(1);
  });

  it.each([
    ["getter", [Object.defineProperty(bookingRow(), "status", { get: () => "CONFIRMED" })]],
    ["proxy", [new Proxy(bookingRow(), { ownKeys: () => ["secret"] })]],
    ["symbol", [{ ...bookingRow(), [Symbol("secret")]: true }]],
  ])("fails closed for hostile booking rows using a %s", async (_label, bookingRows) => {
    const { database } = createLifecycleDatabase([[], bookingRows]);
    const repository = new BookingLifecycleRepository(database);
    await expect(
      repository.simulateMockPayment({
        userId: USER_ID,
        bookingId: BOOKING_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        outcome: "SUCCEED",
        paymentNumber: PAYMENT_NUMBER,
        now: NOW,
      }),
    ).rejects.toThrow();
    expect(database.rollbacks).toBe(1);
  });

  it.each([
    [
      "P2002 fields",
      new Prisma.PrismaClientKnownRequestError("safe", {
        code: "P2002",
        clientVersion: "7.9.0",
        meta: { target: ["payment_number"] },
      }),
    ],
    [
      "flat P2010 constraint name",
      new Prisma.PrismaClientKnownRequestError("safe", {
        code: "P2010",
        clientVersion: "7.9.0",
        meta: { code: "23505", constraint: "payment_payment_number_key" },
      }),
    ],
    [
      "flat P2010 strict message with no constraint",
      new Prisma.PrismaClientKnownRequestError("safe", {
        code: "P2010",
        clientVersion: "7.9.0",
        meta: {
          code: "23505",
          message: 'duplicate key value violates unique constraint "payment_payment_number_key"',
        },
      }),
    ],
    [
      "nested P2010 constraint fields",
      new Prisma.PrismaClientKnownRequestError("safe", {
        code: "P2010",
        clientVersion: "7.9.0",
        meta: {
          driverAdapterError: {
            cause: {
              originalCode: "23505",
              kind: "UniqueConstraintViolation",
              constraint: { fields: ["payment_number"] },
            },
          },
        },
      }),
    ],
  ])("classifies confirmed %s payment-number metadata as retryable", async (_label, conflict) => {
    const database = {
      $transaction: vi.fn(() => Promise.reject(conflict)),
    } as unknown as BookingLifecycleDatabase;
    const repository = new BookingLifecycleRepository(database);
    await expect(
      repository.simulateMockPayment({
        userId: USER_ID,
        bookingId: BOOKING_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        outcome: "SUCCEED",
        paymentNumber: PAYMENT_NUMBER,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(PaymentNumberConflictError);
    expect(database.$transaction).toHaveBeenCalledOnce();
  });

  it.each([
    ["same-key", ["booking_id", "idempotency_key"], "SUCCEEDED"],
    ["partial-success", ["booking_id"], "ALREADY_PROCESSED"],
  ])(
    "retries one confirmed %s unique race and returns canonical state",
    async (_label, target, expectedKind) => {
      const conflict = new Prisma.PrismaClientKnownRequestError("safe", {
        code: "P2002",
        clientVersion: "7.9.0",
        meta: { target },
      });
      const replayResults =
        expectedKind === "SUCCEEDED"
          ? [
              [],
              [bookingRow({ status: "CONFIRMED" })],
              [
                {
                  requestedOutcome: "SUCCEED",
                  status: "SUCCEEDED",
                  paymentNumber: PAYMENT_NUMBER,
                },
              ],
            ]
          : [[], [bookingRow({ status: "CONFIRMED" })], []];
      let resultIndex = 0;
      let transactionCount = 0;
      const transaction = {
        $queryRaw: vi.fn(() => Promise.resolve(replayResults[resultIndex++])),
      } as unknown as BookingLifecycleTransaction;
      const database = {
        $transaction: vi.fn(
          async <T>(operation: (client: BookingLifecycleTransaction) => Promise<T>) => {
            transactionCount += 1;
            if (transactionCount === 1) {
              throw conflict;
            }
            return operation(transaction);
          },
        ),
      } as unknown as BookingLifecycleDatabase;
      const repository = new BookingLifecycleRepository(database);

      await expect(
        repository.simulateMockPayment({
          userId: USER_ID,
          bookingId: BOOKING_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
          outcome: "SUCCEED",
          paymentNumber: PAYMENT_NUMBER_2,
          now: NOW,
        }),
      ).resolves.toMatchObject({ kind: expectedKind });
      expect(database.$transaction).toHaveBeenCalledTimes(2);
    },
  );

  it("does not classify an unknown Prisma unique target", async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError("unknown-secret", {
      code: "P2002",
      clientVersion: "7.9.0",
      meta: { target: ["unknown_column"] },
    });
    const database = {
      $transaction: vi.fn(() => Promise.reject(conflict)),
    } as unknown as BookingLifecycleDatabase;
    const repository = new BookingLifecycleRepository(database);
    await expect(
      repository.simulateMockPayment({
        userId: USER_ID,
        bookingId: BOOKING_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        outcome: "SUCCEED",
        paymentNumber: PAYMENT_NUMBER,
        now: NOW,
      }),
    ).rejects.toBe(conflict);
    expect(database.$transaction).toHaveBeenCalledOnce();
  });
});

const createServiceHarness = (
  repositoryResult: unknown = {
    kind: "SUCCEEDED",
    replayed: false,
    bookingId: BOOKING_ID,
  },
) => {
  const repository = {
    simulateMockPayment: vi.fn((input: unknown) => {
      void input;
      return Promise.resolve(repositoryResult);
    }),
  };
  const rateLimit = {
    checkMockPayment: vi.fn(() => Promise.resolve()),
  };
  const clock: Clock = { now: vi.fn(() => new Date(NOW)) };
  const paymentNumbers: PaymentNumberGenerator = {
    next: vi.fn(() => PAYMENT_NUMBER),
  };
  const query = {
    getOwned: vi.fn(() => Promise.resolve(confirmedDetail)),
  };
  const service = new MockPaymentService(
    repository as unknown as BookingLifecycleRepository,
    rateLimit as unknown as WriteRateLimitService,
    clock,
    paymentNumbers,
    query as unknown as BookingQueryService,
  );
  return { clock, paymentNumbers, query, rateLimit, repository, service };
};

describe("MockPaymentService.simulate", () => {
  it.each([false, true])(
    "returns the canonical confirmed projection with replayed=%s",
    async (replayed) => {
      const { clock, paymentNumbers, query, rateLimit, repository, service } = createServiceHarness(
        {
          kind: "SUCCEEDED",
          replayed,
          bookingId: BOOKING_ID,
        },
      );
      await expect(
        service.simulate(USER_ID, BOOKING_ID, IDEMPOTENCY_KEY, { outcome: "SUCCEED" }),
      ).resolves.toEqual({ replayed, booking: confirmedDetail });
      expect(rateLimit.checkMockPayment).toHaveBeenCalledWith(USER_ID);
      expect(clock.now).toHaveBeenCalledOnce();
      expect(paymentNumbers.next).toHaveBeenCalledWith(NOW);
      expect(repository.simulateMockPayment).toHaveBeenCalledWith({
        userId: USER_ID,
        bookingId: BOOKING_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        outcome: "SUCCEED",
        paymentNumber: PAYMENT_NUMBER,
        now: NOW,
      });
      expect(query.getOwned).toHaveBeenCalledWith(USER_ID, BOOKING_ID);
    },
  );

  it.each([false, true])(
    "maps first and replayed failed payments to the same safe conflict",
    async (replayed) => {
      const { query, service } = createServiceHarness({
        kind: "FAILED",
        replayed,
        bookingId: BOOKING_ID,
      });
      await expect(
        service.simulate(USER_ID, BOOKING_ID, IDEMPOTENCY_KEY, { outcome: "FAIL" }),
      ).rejects.toMatchObject({ status: 409, code: "MOCK_PAYMENT_FAILED" });
      expect(query.getOwned).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ kind: "NOT_FOUND" }, 404, "BOOKING_NOT_FOUND"],
    [{ kind: "EXPIRED", bookingId: BOOKING_ID }, 409, "BOOKING_EXPIRED"],
    [{ kind: "ALREADY_PROCESSED" }, 409, "BOOKING_ALREADY_PROCESSED"],
    [{ kind: "IDEMPOTENCY_KEY_REUSED" }, 409, "IDEMPOTENCY_KEY_REUSED"],
  ])("maps $0.kind to a stable domain error", async (result, status, code) => {
    const { query, service } = createServiceHarness(result);
    await expect(
      service.simulate(USER_ID, BOOKING_ID, IDEMPOTENCY_KEY, { outcome: "SUCCEED" }),
    ).rejects.toMatchObject({ status, code });
    expect(query.getOwned).not.toHaveBeenCalled();
  });

  it("retries one payment-number collision with a fresh number and one captured clock", async () => {
    const { clock, paymentNumbers, repository, service } = createServiceHarness();
    vi.mocked(paymentNumbers.next)
      .mockReturnValueOnce(PAYMENT_NUMBER)
      .mockReturnValueOnce(PAYMENT_NUMBER_2);
    vi.mocked(repository.simulateMockPayment)
      .mockRejectedValueOnce(new PaymentNumberConflictError())
      .mockResolvedValueOnce({
        kind: "SUCCEEDED",
        replayed: false,
        bookingId: BOOKING_ID,
      });

    await expect(
      service.simulate(USER_ID, BOOKING_ID, IDEMPOTENCY_KEY, { outcome: "SUCCEED" }),
    ).resolves.toMatchObject({ replayed: false, booking: { status: "CONFIRMED" } });
    expect(clock.now).toHaveBeenCalledOnce();
    expect(paymentNumbers.next).toHaveBeenCalledTimes(2);
    expect(repository.simulateMockPayment).toHaveBeenCalledTimes(2);
    expect(vi.mocked(repository.simulateMockPayment).mock.calls[1]?.[0]).toMatchObject({
      paymentNumber: PAYMENT_NUMBER_2,
      now: NOW,
    });
  });

  it("fails unavailable after a second payment-number collision", async () => {
    const { query, repository, service } = createServiceHarness();
    vi.mocked(repository.simulateMockPayment).mockRejectedValue(new PaymentNumberConflictError());
    await expect(
      service.simulate(USER_ID, BOOKING_ID, IDEMPOTENCY_KEY, { outcome: "SUCCEED" }),
    ).rejects.toMatchObject({ status: 503, code: "BOOKING_LIFECYCLE_UNAVAILABLE" });
    expect(repository.simulateMockPayment).toHaveBeenCalledTimes(2);
    expect(query.getOwned).not.toHaveBeenCalled();
  });

  it.each([
    [
      "flat",
      new Prisma.PrismaClientKnownRequestError("safe", {
        code: "P2010",
        clientVersion: "7.9.0",
        meta: {
          code: "23505",
          constraint: "unknown_constraint",
          message: 'duplicate key value violates unique constraint "payment_payment_number_key"',
        },
      }),
    ],
    [
      "nested",
      new Prisma.PrismaClientKnownRequestError("safe", {
        code: "P2010",
        clientVersion: "7.9.0",
        meta: {
          driverAdapterError: {
            cause: {
              originalCode: "23505",
              kind: "UniqueConstraintViolation",
              constraint: { fields: ["unknown_column"] },
              originalMessage:
                'duplicate key value violates unique constraint "payment_payment_number_key"',
            },
          },
        },
      }),
    ],
  ])(
    "fails closed for conflicting %s P2010 constraint metadata without a fresh payment number",
    async (_label, conflict) => {
      const database = {
        $transaction: vi.fn(() => Promise.reject(conflict)),
      } as unknown as BookingLifecycleDatabase;
      const repository = new BookingLifecycleRepository(database);
      const rateLimit = {
        checkMockPayment: vi.fn(() => Promise.resolve()),
      };
      const clock: Clock = { now: vi.fn(() => new Date(NOW)) };
      const paymentNumbers: PaymentNumberGenerator = {
        next: vi.fn(() => PAYMENT_NUMBER),
      };
      const query = {
        getOwned: vi.fn(() => Promise.resolve(confirmedDetail)),
      };
      const service = new MockPaymentService(
        repository,
        rateLimit as unknown as WriteRateLimitService,
        clock,
        paymentNumbers,
        query as unknown as BookingQueryService,
      );

      await expect(
        service.simulate(USER_ID, BOOKING_ID, IDEMPOTENCY_KEY, { outcome: "SUCCEED" }),
      ).rejects.toMatchObject({ status: 503, code: "BOOKING_LIFECYCLE_UNAVAILABLE" });
      expect(database.$transaction).toHaveBeenCalledOnce();
      expect(paymentNumbers.next).toHaveBeenCalledOnce();
      expect(query.getOwned).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["invalid user", "not-a-uuid", BOOKING_ID, IDEMPOTENCY_KEY, { outcome: "SUCCEED" }],
    ["invalid path", USER_ID, "not-a-uuid", IDEMPOTENCY_KEY, { outcome: "SUCCEED" }],
    ["invalid key", USER_ID, BOOKING_ID, "short", { outcome: "SUCCEED" }],
    [
      "unknown body field",
      USER_ID,
      BOOKING_ID,
      IDEMPOTENCY_KEY,
      { outcome: "SUCCEED", secret: true },
    ],
    ["invalid outcome", USER_ID, BOOKING_ID, IDEMPOTENCY_KEY, { outcome: "UNKNOWN" }],
  ])("rejects %s before rate limiting", async (_label, user, booking, key, body) => {
    const { rateLimit, service } = createServiceHarness();
    await expect(service.simulate(user, booking, key, body)).rejects.toMatchObject({
      status: 400,
      code: "PAYMENT_REQUEST_INVALID",
    });
    expect(rateLimit.checkMockPayment).not.toHaveBeenCalled();
  });

  it("preserves only a bounded sanitized rate-limit error", async () => {
    const { rateLimit, repository, service } = createServiceHarness();
    vi.mocked(rateLimit.checkMockPayment).mockRejectedValueOnce(
      new BusinessException(429, "RATE_LIMITED", "internal-secret", {
        retry_after_seconds: 9,
      }),
    );
    let captured: unknown;
    try {
      await service.simulate(USER_ID, BOOKING_ID, IDEMPOTENCY_KEY, { outcome: "FAIL" });
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
      details: { retry_after_seconds: 9 },
    });
    expect(JSON.stringify(captured)).not.toContain("internal-secret");
    expect(repository.simulateMockPayment).not.toHaveBeenCalled();
  });

  it("maps a Redis rate-limit failure to safe unavailable without repository access", async () => {
    const { rateLimit, repository, service } = createServiceHarness();
    vi.mocked(rateLimit.checkMockPayment).mockRejectedValueOnce(new Error("redis-secret"));
    let captured: unknown;
    try {
      await service.simulate(USER_ID, BOOKING_ID, IDEMPOTENCY_KEY, { outcome: "FAIL" });
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({
      status: 503,
      code: "BOOKING_LIFECYCLE_UNAVAILABLE",
    });
    expect(JSON.stringify(captured)).not.toContain("redis-secret");
    expect(repository.simulateMockPayment).not.toHaveBeenCalled();
  });

  it("maps unknown repository and projection failures to one safe unavailable error", async () => {
    for (const source of ["repository-secret", "projection-secret"]) {
      const harness = createServiceHarness();
      if (source.startsWith("repository")) {
        vi.mocked(harness.repository.simulateMockPayment).mockRejectedValueOnce(new Error(source));
      } else {
        vi.mocked(harness.query.getOwned).mockRejectedValueOnce(new Error(source));
      }
      let captured: unknown;
      try {
        await harness.service.simulate(USER_ID, BOOKING_ID, IDEMPOTENCY_KEY, {
          outcome: "SUCCEED",
        });
      } catch (error) {
        captured = error;
      }
      expect(captured).toMatchObject({
        status: 503,
        code: "BOOKING_LIFECYCLE_UNAVAILABLE",
      });
      expect(JSON.stringify(captured)).not.toContain(source);
    }
  });

  it.each([
    ["getter", Object.defineProperty({}, "kind", { enumerable: true, get: () => "SUCCEEDED" })],
    ["proxy", new Proxy({}, { ownKeys: () => ["secret"] })],
    [
      "symbol",
      {
        kind: "SUCCEEDED",
        replayed: false,
        bookingId: BOOKING_ID,
        [Symbol("secret")]: true,
      },
    ],
    ["wrong booking", { kind: "SUCCEEDED", replayed: false, bookingId: OTHER_USER_ID }],
  ])("fails closed for hostile repository %s output", async (_label, result) => {
    const { query, service } = createServiceHarness(result);
    await expect(
      service.simulate(USER_ID, BOOKING_ID, IDEMPOTENCY_KEY, { outcome: "SUCCEED" }),
    ).rejects.toMatchObject({ status: 503, code: "BOOKING_LIFECYCLE_UNAVAILABLE" });
    expect(query.getOwned).not.toHaveBeenCalled();
  });

  it("rejects a non-CONFIRMED or expanded public projection after commit", async () => {
    const { query, service } = createServiceHarness();
    vi.mocked(query.getOwned).mockResolvedValueOnce({
      ...confirmedDetail,
      idempotency_key: IDEMPOTENCY_KEY,
    } as never);
    await expect(
      service.simulate(USER_ID, BOOKING_ID, IDEMPOTENCY_KEY, { outcome: "SUCCEED" }),
    ).rejects.toMatchObject({ status: 503, code: "BOOKING_LIFECYCLE_UNAVAILABLE" });
  });
});

describe("mock-payment rate-limit domain", () => {
  it("uses a ten-request domain-separated user digest without raw identifiers", async () => {
    const redis = {
      executeRateLimit: vi.fn(() => Promise.resolve({ count: 1, ttlMilliseconds: 60_000 })),
    };
    const service = new WriteRateLimitService(redis as unknown as RedisService);

    await service.checkBookings(USER_ID);
    await service.checkBookingCancellation(USER_ID);
    await service.checkMockPayment(USER_ID);

    const bookingKey = `rate-limit:bookings:${createHash("sha256").update(USER_ID).digest("hex")}`;
    const cancellationKey = `rate-limit:bookings:${createHash("sha256")
      .update("booking-cancellation\u0000")
      .update(USER_ID)
      .digest("hex")}`;
    const mockPaymentKey = `rate-limit:bookings:${createHash("sha256")
      .update("mock-payment\u0000")
      .update(USER_ID)
      .digest("hex")}`;
    expect(redis.executeRateLimit.mock.calls).toEqual([
      [bookingKey, 10, 60_000],
      [cancellationKey, 6, 60_000],
      [mockPaymentKey, 10, 60_000],
    ]);
    expect(new Set([bookingKey, cancellationKey, mockPaymentKey]).size).toBe(3);
    expect(JSON.stringify(redis.executeRateLimit.mock.calls)).not.toContain(USER_ID);
  });
});

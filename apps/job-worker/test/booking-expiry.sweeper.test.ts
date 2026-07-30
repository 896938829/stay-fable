import { describe, expect, it, vi } from "vitest";

import {
  type BookingExpiryRepository,
  type BookingExpiryResult,
} from "../src/booking-expiry.repository.js";
import {
  BookingExpirySweeper,
  type BookingExpiryTimer,
  type WorkerClock,
} from "../src/booking-expiry.sweeper.js";
import type { DatabaseClient, DatabasePool } from "../src/database.js";
import { createSystemWorker } from "../src/worker.js";

const NOW = new Date("2030-01-01T00:20:00.000Z");
type CloseNextExpired = (now: Date) => Promise<BookingExpiryResult>;
type QueryInput = string | { text: string; values?: unknown[] };

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
};

const createHarness = (
  closeNextExpired = vi.fn<CloseNextExpired>(() => Promise.resolve({ kind: "NONE" })),
) => {
  const repository = { closeNextExpired } as unknown as BookingExpiryRepository;
  const now = vi.fn(() => new Date(NOW));
  const clock: WorkerClock = { now };
  const callbacks: Array<() => void> = [];
  const setInterval = vi.fn<(callback: () => void) => unknown>((callback) => {
    callbacks.push(callback);
    return { timer: callbacks.length };
  });
  const clearInterval = vi.fn();
  const timer: BookingExpiryTimer = {
    setInterval,
    clearInterval,
  };
  const logger = { error: vi.fn(), info: vi.fn() };
  const sweeper = new BookingExpirySweeper(repository, clock, timer, 5_000, logger);
  return { callbacks, clearInterval, closeNextExpired, logger, now, setInterval, sweeper };
};

describe("BookingExpirySweeper", () => {
  it("captures one now, continues after one failure, and stops on NONE", async () => {
    const closeNextExpired = vi
      .fn<CloseNextExpired>()
      .mockResolvedValueOnce({ kind: "CLOSED", bookingNumber: "SF20300101ABCDEF123456" })
      .mockRejectedValueOnce(
        new Error(
          "postgresql://dbuser:secret@database/order/10000000-0000-4000-8000-000000000001?key=raw",
        ),
      )
      .mockResolvedValueOnce({ kind: "CLOSED", bookingNumber: "SF20300101ABCDEF123457" })
      .mockResolvedValueOnce({ kind: "NONE" });
    const { logger, now, sweeper } = createHarness(closeNextExpired);

    await sweeper.tick();

    expect(now).toHaveBeenCalledOnce();
    expect(closeNextExpired).toHaveBeenCalledTimes(4);
    for (const [now] of closeNextExpired.mock.calls) {
      expect(now).toEqual(NOW);
    }
    expect(logger.info).toHaveBeenCalledWith(
      { failedCount: 1, processedCount: 2 },
      "booking expiry sweep completed",
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/dbuser|secret|10000000|key=raw/);
  });

  it("processes at most 25 bookings in one tick", async () => {
    const closeNextExpired = vi.fn<CloseNextExpired>(() =>
      Promise.resolve({ kind: "CLOSED", bookingNumber: "SF20300101ABCDEF123456" }),
    );
    const { logger, sweeper } = createHarness(closeNextExpired);

    await sweeper.tick();

    expect(closeNextExpired).toHaveBeenCalledTimes(25);
    expect(logger.info).toHaveBeenCalledWith(
      { failedCount: 0, processedCount: 25 },
      "booking expiry sweep completed",
    );
  });

  it("coalesces overlapping ticks", async () => {
    const gate = createDeferred<{ kind: "NONE" }>();
    const closeNextExpired = vi.fn<CloseNextExpired>(() => gate.promise);
    const { sweeper } = createHarness(closeNextExpired);

    const first = sweeper.tick();
    const second = sweeper.tick();
    expect(closeNextExpired).toHaveBeenCalledOnce();

    gate.resolve({ kind: "NONE" });
    await Promise.all([first, second]);
    expect(closeNextExpired).toHaveBeenCalledOnce();
  });

  it("starts one immediate tick before arming the interval and interval ticks do not overlap", async () => {
    const gate = createDeferred<{ kind: "NONE" }>();
    const order: string[] = [];
    const closeNextExpired = vi.fn<CloseNextExpired>(() => {
      order.push("tick");
      return gate.promise;
    });
    const { callbacks, clearInterval, setInterval, sweeper } = createHarness(closeNextExpired);
    setInterval.mockImplementation((callback) => {
      order.push("interval");
      callbacks.push(callback);
      return "timer";
    });

    sweeper.start();

    expect(order).toEqual(["tick", "interval"]);
    callbacks[0]?.();
    expect(closeNextExpired).toHaveBeenCalledOnce();
    gate.resolve({ kind: "NONE" });
    await sweeper.stop();
    expect(clearInterval).toHaveBeenCalledWith("timer");
  });

  it("stop clears the interval and waits for the active tick", async () => {
    const gate = createDeferred<{ kind: "NONE" }>();
    const { clearInterval, sweeper } = createHarness(vi.fn<CloseNextExpired>(() => gate.promise));
    sweeper.start();
    let stopped = false;

    const stopping = sweeper.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();

    expect(clearInterval).toHaveBeenCalledOnce();
    expect(stopped).toBe(false);
    gate.resolve({ kind: "NONE" });
    await stopping;
    expect(stopped).toBe(true);
  });

  it.each([999, 60_001, 1_000.5])("rejects an unsafe %s ms interval", (interval) => {
    const repository = {
      closeNextExpired: vi.fn(),
    } as unknown as BookingExpiryRepository;
    const clock: WorkerClock = { now: () => new Date(NOW) };
    const timer: BookingExpiryTimer = {
      setInterval: vi.fn(),
      clearInterval: vi.fn(),
    };

    expect(() => new BookingExpirySweeper(repository, clock, timer, interval, console)).toThrow(
      "Invalid booking expiry interval",
    );
  });

  it("wires the production worker to the real immediate sweeper", async () => {
    const query = vi
      .fn<(queryInput: QueryInput) => Promise<{ rows: unknown[] }>>()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    const connect = vi.fn(() => Promise.resolve({ query, release } as unknown as DatabaseClient));
    const pool = {
      connect,
      end: vi.fn(() => Promise.resolve()),
    } as unknown as DatabasePool;
    const connection = {
      status: "ready",
      quit: vi.fn(() => Promise.resolve("OK")),
    };
    const worker = {
      close: vi.fn(() => Promise.resolve()),
      on: vi.fn(() => worker),
    };

    const resources = await createSystemWorker(
      {
        NODE_ENV: "test",
        REDIS_URL: "redis://127.0.0.1:6379",
        DATABASE_URL: "postgresql://127.0.0.1/stay_fable",
        BOOKING_EXPIRY_POLL_MS: "1000",
      },
      {
        logger: { error: vi.fn(), info: vi.fn() },
        createPool: vi.fn(() => pool),
        createConnection: vi.fn(() => connection),
        createWorker: vi.fn(() => worker),
      },
    );

    await vi.waitFor(() => {
      expect(connect).toHaveBeenCalledOnce();
    });
    await resources.sweeper.stop();
    expect(query.mock.calls.map(([value]) => value)).toEqual([
      "BEGIN",
      expect.objectContaining({ values: [expect.any(Date), []] }),
      "COMMIT",
    ]);
  });
});

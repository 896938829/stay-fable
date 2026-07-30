import {
  bookingExpiryExclusionFrom,
  BookingExpiryRepository,
  type BookingExpiryExclusion,
} from "./booking-expiry.repository.js";
import type { DatabasePool } from "./database.js";

export interface WorkerClock {
  now(): Date;
}

export interface BookingExpiryTimer {
  clearInterval(handle: unknown): void;
  setInterval(callback: () => void, milliseconds: number): unknown;
}

interface BookingExpiryLogger {
  error(bindings: object, message: string): void;
  info(bindings: object, message: string): void;
}

const MAX_BOOKINGS_PER_TICK = 25;
const MINIMUM_INTERVAL_MS = 1_000;
const MAXIMUM_INTERVAL_MS = 60_000;

const systemClock: WorkerClock = {
  now: () => new Date(),
};

const systemTimer: BookingExpiryTimer = {
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class BookingExpirySweeper {
  private activeTick: Promise<void> | undefined;
  private intervalHandle: unknown;
  private started = false;

  constructor(
    private readonly repository: Pick<BookingExpiryRepository, "closeNextExpired">,
    private readonly clock: WorkerClock,
    private readonly timer: BookingExpiryTimer,
    private readonly pollMilliseconds: number,
    private readonly logger: BookingExpiryLogger,
  ) {
    if (
      !Number.isSafeInteger(pollMilliseconds) ||
      pollMilliseconds < MINIMUM_INTERVAL_MS ||
      pollMilliseconds > MAXIMUM_INTERVAL_MS
    ) {
      throw new Error("Invalid booking expiry interval");
    }
  }

  tick(): Promise<void> {
    if (this.activeTick !== undefined) {
      return this.activeTick;
    }
    const running = this.runTick();
    const tracked = running.finally(() => {
      if (this.activeTick === tracked) {
        this.activeTick = undefined;
      }
    });
    this.activeTick = tracked;
    return tracked;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    void this.tick();
    this.intervalHandle = this.timer.setInterval(() => {
      void this.tick();
    }, this.pollMilliseconds);
  }

  async stop(): Promise<void> {
    if (this.started) {
      this.started = false;
      this.timer.clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
    await this.activeTick;
  }

  private async runTick(): Promise<void> {
    const now = this.clock.now();
    const exclusions: BookingExpiryExclusion[] = [];
    let failedCount = 0;
    let processedCount = 0;

    for (let attempt = 0; attempt < MAX_BOOKINGS_PER_TICK; attempt += 1) {
      try {
        const result = await this.repository.closeNextExpired(now, [...exclusions]);
        if (result.kind === "NONE") {
          break;
        }
        processedCount += 1;
      } catch (error) {
        failedCount += 1;
        const exclusion = bookingExpiryExclusionFrom(error);
        if (exclusion !== undefined && !exclusions.includes(exclusion)) {
          exclusions.push(exclusion);
        }
        this.logger.error({}, "booking expiry close failed");
      }
    }

    this.logger.info({ failedCount, processedCount }, "booking expiry sweep completed");
  }
}

export const createBookingExpirySweeper = (
  pool: DatabasePool,
  pollMilliseconds: number,
  logger: BookingExpiryLogger,
): BookingExpirySweeper =>
  new BookingExpirySweeper(
    new BookingExpiryRepository(pool),
    systemClock,
    systemTimer,
    pollMilliseconds,
    logger,
  );

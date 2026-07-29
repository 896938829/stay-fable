import { randomBytes as cryptographicRandomBytes } from "node:crypto";
import { types as nodeTypes } from "node:util";

export interface BookingNumberGenerator {
  next(now: Date): string;
}

export const BOOKING_NUMBER_GENERATOR = Symbol("BOOKING_NUMBER_GENERATOR");

type RandomBytesSource = (size: number) => Buffer;

const unavailable = (): never => {
  throw new Error("Booking number unavailable");
};

export const createBookingNumberGenerator = (
  randomBytes: RandomBytesSource = cryptographicRandomBytes,
): BookingNumberGenerator => ({
  next(now: Date): string {
    try {
      if (
        !(now instanceof Date) ||
        nodeTypes.isProxy(now) ||
        Reflect.getPrototypeOf(now) !== Date.prototype
      ) {
        return unavailable();
      }
      const epoch = Date.prototype.getTime.call(now);
      if (!Number.isFinite(epoch)) {
        return unavailable();
      }
      const bytes: unknown = randomBytes(6);
      if (
        !Buffer.isBuffer(bytes) ||
        nodeTypes.isProxy(bytes) ||
        Reflect.getPrototypeOf(bytes) !== Buffer.prototype ||
        bytes.length !== 6
      ) {
        return unavailable();
      }
      const date = new Date(epoch);
      const utcYear = date.getUTCFullYear();
      if (utcYear < 1 || utcYear > 9_999) {
        return unavailable();
      }
      const year = String(utcYear).padStart(4, "0");
      const month = String(date.getUTCMonth() + 1).padStart(2, "0");
      const day = String(date.getUTCDate()).padStart(2, "0");
      return `SF${year}${month}${day}${bytes.toString("hex").toUpperCase()}`;
    } catch {
      return unavailable();
    }
  },
});

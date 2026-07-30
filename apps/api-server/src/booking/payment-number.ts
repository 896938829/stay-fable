import { Buffer } from "node:buffer";
import { randomBytes as cryptographicRandomBytes } from "node:crypto";
import { types as nodeTypes } from "node:util";

export interface PaymentNumberGenerator {
  next(now: Date): string;
}

export const PAYMENT_NUMBER_GENERATOR = Symbol("PAYMENT_NUMBER_GENERATOR");

type RandomBytesSource = (size: number) => Buffer;
const bufferToStringDescriptor = Reflect.getOwnPropertyDescriptor(Buffer.prototype, "toString");
const bufferToStringValue: unknown =
  bufferToStringDescriptor !== undefined && Object.hasOwn(bufferToStringDescriptor, "value")
    ? bufferToStringDescriptor.value
    : undefined;
const bufferToString = bufferToStringValue as (this: Buffer, encoding: BufferEncoding) => string;

const unavailable = (): never => {
  throw new Error("Payment number unavailable");
};

export const createPaymentNumberGenerator = (
  randomBytes: RandomBytesSource = cryptographicRandomBytes,
): PaymentNumberGenerator => ({
  next(now: Date): string {
    try {
      if (
        typeof now !== "object" ||
        now === null ||
        nodeTypes.isProxy(now) ||
        Reflect.getPrototypeOf(now) !== Date.prototype
      ) {
        return unavailable();
      }
      const milliseconds = Date.prototype.getTime.call(now);
      if (!Number.isFinite(milliseconds)) {
        return unavailable();
      }
      const bytes: unknown = randomBytes(6);
      if (
        !Buffer.isBuffer(bytes) ||
        nodeTypes.isProxy(bytes) ||
        Reflect.getPrototypeOf(bytes) !== Buffer.prototype ||
        bytes.length !== 6 ||
        typeof bufferToStringValue !== "function"
      ) {
        return unavailable();
      }
      const date = new Date(milliseconds);
      const year = date.getUTCFullYear();
      if (year < 1 || year > 9_999) {
        return unavailable();
      }
      const month = String(date.getUTCMonth() + 1).padStart(2, "0");
      const day = String(date.getUTCDate()).padStart(2, "0");
      return `SFP${String(year).padStart(4, "0")}${month}${day}${bufferToString
        .call(bytes, "hex")
        .toUpperCase()}`;
    } catch {
      return unavailable();
    }
  },
});

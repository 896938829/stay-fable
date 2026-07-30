import { describe, expect, it, vi } from "vitest";

import bookingModule from "../services/booking.js";
import requestModule from "../services/request.js";

const { createBookingService } = bookingModule;
const { createRequestClient } = requestModule;

const IDS = {
  property: "10000000-0000-4000-8000-000000000001",
  roomType: "20000000-0000-4000-8000-000000000001",
  quote: "30000000-0000-4000-8000-000000000001",
  booking: "40000000-0000-4000-8000-000000000001",
};
const idempotencyKey = "booking-scope-1234567890_ABCDEFGHIJ";
const quoteInput = {
  room_type_id: IDS.roomType,
  checkin: "2026-08-01",
  checkout: "2026-08-03",
  guests: 2,
};
const quote = {
  quote_id: IDS.quote,
  property: { id: IDS.property, name: "西湖云栖酒店" },
  room_type: {
    id: IDS.roomType,
    name: "湖景大床房",
    cover_url: "/images/catalog/hangzhou-hotel-room-1.jpg",
  },
  checkin: quoteInput.checkin,
  checkout: quoteInput.checkout,
  nights: 2,
  guests: quoteInput.guests,
  nightly_prices: [
    {
      business_date: "2026-08-01",
      sale_price_cents: 58800,
      rack_price_cents: 68800,
      currency: "CNY",
    },
    {
      business_date: "2026-08-02",
      sale_price_cents: 62800,
      rack_price_cents: 72800,
      currency: "CNY",
    },
  ],
  total_price_cents: 121600,
  currency: "CNY",
  booking_policy: "入住前一天 18:00 前可免费取消",
  expires_at: "2026-07-30T02:05:00.000Z",
};
const booking = {
  booking_id: IDS.booking,
  booking_number: "SF20260730A1B2C3D4E5F6",
  status: "PENDING_PAYMENT",
  property_name: quote.property.name,
  room_type_name: quote.room_type.name,
  checkin: quote.checkin,
  checkout: quote.checkout,
  nights: quote.nights,
  guests: quote.guests,
  total_price_cents: quote.total_price_cents,
  currency: "CNY",
  expires_at: "2026-07-30T02:15:00.000Z",
  created_at: "2026-07-30T02:00:00.000Z",
};

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function serviceWith(postImplementation) {
  const requestClient = { post: vi.fn(postImplementation) };
  return { requestClient, service: createBookingService(requestClient) };
}

describe("booking service", () => {
  it("posts only quote input fields with retry disabled and validates the response binding", async () => {
    const { requestClient, service } = serviceWith(async () => quote);

    await expect(
      service.createQuote({ ...quoteInput }),
    ).resolves.toEqual(quote);
    expect(requestClient.post).toHaveBeenCalledWith(
      "/quotes",
      quoteInput,
      { retry: false },
    );
  });

  it("posts only quote ID and idempotency header with booking retry disabled", async () => {
    const { requestClient, service } = serviceWith(async () => booking);

    await expect(
      service.createBooking({ quote_id: IDS.quote }, idempotencyKey),
    ).resolves.toEqual(booking);
    expect(requestClient.post).toHaveBeenCalledWith(
      "/bookings",
      { quote_id: IDS.quote },
      {
        header: { "Idempotency-Key": idempotencyKey },
        retry: false,
      },
    );
  });

  it("snapshots input, callback, and request environment before any await", async () => {
    const pending = deferred();
    const calls = [];
    const environment = Object.create(null);
    Object.defineProperty(environment, "post", {
      enumerable: true,
      value(path, body, options) {
        calls.push({ path, body, options });
        return pending.promise;
      },
    });
    const service = createBookingService(environment);
    const mutable = { ...quoteInput };
    const options = Object.create(null);
    Object.defineProperty(options, "isActive", {
      enumerable: true,
      writable: true,
      value: () => true,
    });

    const result = service.createQuote(mutable, options);
    mutable.guests = 10;
    options.isActive = () => false;
    pending.resolve(quote);

    await expect(result).resolves.toEqual(quote);
    expect(calls[0]).toEqual({
      path: "/quotes",
      body: quoteInput,
      options: { retry: false },
    });
  });

  it("rejects input, callback, and environment accessors or inherited prototypes without requests", async () => {
    let getterReads = 0;
    const inputGetter = { ...quoteInput };
    Object.defineProperty(inputGetter, "guests", {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error("private getter");
      },
    });
    const optionsGetter = {};
    Object.defineProperty(optionsGetter, "isActive", {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error("private getter");
      },
    });
    const requestClient = { post: vi.fn(async () => quote) };
    const service = createBookingService(requestClient);

    await expect(service.createQuote(inputGetter)).rejects.toMatchObject({
      code: "INVALID_BOOKING_INPUT",
    });
    await expect(service.createQuote(quoteInput, optionsGetter)).rejects.toMatchObject({
      code: "INVALID_BOOKING_OPTIONS",
    });
    await expect(
      service.createQuote(Object.assign(Object.create({ guests: 10 }), quoteInput)),
    ).rejects.toMatchObject({ code: "INVALID_BOOKING_INPUT" });
    expect(() =>
      createBookingService(Object.create({ post: async () => quote })),
    ).toThrow(expect.objectContaining({ code: "INVALID_BOOKING_ENVIRONMENT" }));
    const getterEnvironment = {};
    Object.defineProperty(getterEnvironment, "post", {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error("private getter");
      },
    });
    expect(() => createBookingService(getterEnvironment)).toThrow(
      expect.objectContaining({ code: "INVALID_BOOKING_ENVIRONMENT" }),
    );
    expect(getterReads).toBe(0);
    expect(requestClient.post).not.toHaveBeenCalled();
  });

  it("rejects unknown request fields and invalid idempotency keys before requesting", async () => {
    const { requestClient, service } = serviceWith(async () => booking);

    await expect(
      service.createQuote({ ...quoteInput, total_price_cents: 1 }),
    ).rejects.toMatchObject({ code: "INVALID_BOOKING_INPUT" });
    await expect(
      service.createBooking({ quote_id: IDS.quote, status: "PENDING_PAYMENT" }, idempotencyKey),
    ).rejects.toMatchObject({ code: "INVALID_BOOKING_INPUT" });
    await expect(
      service.createBooking({ quote_id: IDS.quote }, "too-short"),
    ).rejects.toMatchObject({ code: "INVALID_BOOKING_INPUT" });
    expect(requestClient.post).not.toHaveBeenCalled();
  });

  it("preserves one booking body and idempotency key across the controlled 401 replay", async () => {
    let accessToken = "old-access-token";
    const attempts = [];
    const wxApi = {
      request: vi.fn((options) => {
        attempts.push({
          body: options.data,
          key: options.header["Idempotency-Key"],
        });
        if (options.header.Authorization === "Bearer old-access-token") {
          options.success({
            statusCode: 401,
            data: {
              error: { code: "UNAUTHORIZED", message: "Expired" },
              request_id: "booking_401",
            },
          });
        } else {
          options.success({
            statusCode: 201,
            data: { data: booking, request_id: "booking_201" },
          });
        }
      }),
    };
    const client = createRequestClient({
      wxApi,
      getRuntimeConfig: () => ({ apiBaseUrl: "https://api.example.com" }),
      getSession: () => ({
        access_token: accessToken,
        user: { id: IDS.property },
      }),
      refreshSession: async () => {
        accessToken = "new-access-token";
      },
      createRequestId: async () => "request_booking",
    });
    const service = createBookingService(client);

    await expect(
      service.createBooking({ quote_id: IDS.quote }, idempotencyKey),
    ).resolves.toEqual(booking);
    expect(attempts).toHaveLength(2);
    expect(attempts[0].body).toBe(attempts[1].body);
    expect(attempts.map(({ key }) => key)).toEqual([idempotencyKey, idempotencyKey]);
    expect(attempts[0].body).toEqual({ quote_id: IDS.quote });
  });

  it("rejects a late response after cancellation without publishing its data", async () => {
    const pending = deferred();
    let active = true;
    const { service } = serviceWith(() => pending.promise);
    const operation = service.createQuote(quoteInput, { isActive: () => active });
    active = false;
    pending.resolve(quote);

    await expect(operation).rejects.toMatchObject({
      code: "BOOKING_OPERATION_CANCELLED",
      message: "Booking operation cancelled",
    });
  });
});

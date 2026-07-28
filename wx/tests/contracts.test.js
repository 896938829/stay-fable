import { describe, expect, it, vi } from "vitest";

import contracts from "../services/contracts.js";
import authModule from "../services/auth.js";
import locationModule from "../services/location.js";

const {
  assertApiErrorResponse,
  assertAuthSession,
  assertCity,
  assertEnvelope,
  assertResolvedLocation,
} = contracts;
const { createAuthService } = authModule;
const { createLocationService } = locationModule;

const city = {
  id: "11111111-1111-4111-8111-111111111111",
  code: "hangzhou",
  name: "杭州",
};
const session = {
  access_token: "a".repeat(32),
  access_expires_in: 120,
  refresh_token: "r".repeat(32),
  refresh_expires_in: 600,
  user: { id: "22222222-2222-4222-8222-222222222222" },
};

function expectInvalid(callback, secret = "") {
  try {
    callback();
    throw new Error("expected validation to fail");
  } catch (error) {
    expect(error.code).toBe("INVALID_API_RESPONSE");
    expect(error.message).toBe("Invalid API response");
    if (secret) {
      expect(error.message).not.toContain(secret);
    }
  }
}

describe("API contracts", () => {
  it("accepts an envelope with any present data value", () => {
    expect(assertEnvelope({ data: null, request_id: "req_123" })).toEqual({
      data: null,
      request_id: "req_123",
    });
  });

  it.each([
    null,
    [],
    {},
    { data: 1, request_id: "" },
    { data: 1, request_id: "not valid!" },
  ])("rejects malformed envelopes safely", (value) => {
    expectInvalid(() => assertEnvelope(value));
  });

  it("validates the backend auth session fields", () => {
    const value = assertAuthSession({
      ...session,
      code: "temporary-secret",
      user: { ...session.user, secret: "private" },
    });
    expect(value).toEqual(session);
    expect(value).not.toBe(session);
    expect(JSON.stringify(value)).not.toContain("temporary-secret");
    expect(JSON.stringify(value)).not.toContain("private");
    for (const invalid of [
      { ...session, access_token: "secret-short" },
      { ...session, access_expires_in: 0 },
      { ...session, refresh_expires_in: 1.5 },
      { ...session, user: { id: "not-a-uuid" } },
    ]) {
      expectInvalid(() => assertAuthSession(invalid), "secret-short");
    }
  });

  it("validates cities and resolved locations", () => {
    expect(assertCity({ ...city, longitude: 120, secret: "private" })).toEqual(city);
    expect(
      assertResolvedLocation({
        city: { ...city, latitude: 30 },
        distance_meters: 0,
        secret: "private",
      }),
    ).toEqual({
      city,
      distance_meters: 0,
    });
    expectInvalid(() => assertCity({ ...city, name: "" }));
    expectInvalid(() => assertResolvedLocation({ city, distance_meters: -1 }));
    expectInvalid(() => assertResolvedLocation({ city }));
  });

  it("accepts only the stable API error response shape", () => {
    const response = {
      error: { code: "NOT_FOUND", message: "Missing", details: { field: "city" } },
      request_id: "req_error",
    };
    expect(assertApiErrorResponse(response)).toBe(response);
    for (const invalid of [
      { ...response, extra: true },
      { error: { code: "", message: "Missing" }, request_id: "req_error" },
      { error: { code: "BAD", message: "", secret: "token" }, request_id: "req_error" },
    ]) {
      expectInvalid(() => assertApiErrorResponse(invalid), "token");
    }
  });
});

describe("contract-aware services", () => {
  it("uses fixed unauthenticated auth endpoints and validates sessions", async () => {
    const calls = [];
    const requestClient = {
      post: async (...args) => {
        calls.push(args);
        return session;
      },
    };
    const auth = createAuthService(requestClient);
    await expect(auth.login("temporary-code")).resolves.toEqual(session);
    await expect(auth.refresh("r".repeat(32))).resolves.toEqual(session);
    expect(calls).toEqual([
      ["/auth/wechat/login", { code: "temporary-code" }, { auth: false, retry: false }],
      [
        "/auth/session/refresh",
        { refresh_token: "r".repeat(32) },
        { auth: false, retry: false },
      ],
    ]);
  });

  it("validates city and resolved-location response data", async () => {
    const get = vi.fn(async () => [{ ...city, longitude: 120.1, secret: "private" }]);
    const post = vi.fn(async (_path, data) => {
      expect(data).toEqual({ longitude: 120.1, latitude: 30.2 });
      return { city, distance_meters: 8 };
    });
    const requestClient = {
      get,
      post,
    };
    const location = createLocationService(requestClient);
    await expect(location.listCities()).resolves.toEqual([city]);
    await expect(location.resolve({ longitude: 120.1, latitude: 30.2 })).resolves.toEqual({
      city,
      distance_meters: 8,
    });
    await expect(location.resolve({ longitude: "120.1", latitude: 30.2 })).rejects.toMatchObject({
      code: "INVALID_LOCATION_INPUT",
    });
    for (const coordinates of [
      { longitude: 180.1, latitude: 30 },
      { longitude: -180.1, latitude: 30 },
      { longitude: 120, latitude: 90.1 },
      { longitude: 120, latitude: -90.1 },
    ]) {
      await expect(location.resolve(coordinates)).rejects.toMatchObject({
        code: "INVALID_LOCATION_INPUT",
        message: "Invalid location input",
      });
    }
    expect(post).toHaveBeenCalledOnce();
  });
});

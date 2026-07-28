import { afterEach, describe, expect, it, vi } from "vitest";

import runtime from "../config/runtime.js";
import requestModule from "../services/request.js";
import authModule from "../services/auth.js";
import locationModule from "../services/location.js";

const { getRuntimeConfig } = runtime;
const { createRequestClient } = requestModule;
const { createAuthService } = authModule;
const { createLocationService } = locationModule;

afterEach(() => {
  vi.unstubAllGlobals();
});

function wxApi(envVersion, extConfig) {
  return {
    getAccountInfoSync() {
      return { miniProgram: { envVersion } };
    },
    getExtConfigSync() {
      return extConfig;
    },
  };
}

describe("runtime config", () => {
  it("uses the local fallback in develop", () => {
    expect(getRuntimeConfig(wxApi("develop", {}))).toEqual({
      apiBaseUrl: "http://127.0.0.1:3000/api/v1",
      envVersion: "develop",
    });
  });

  it.each([undefined, ""])("treats a missing envVersion as develop: %s", (envVersion) => {
    expect(getRuntimeConfig(wxApi(envVersion, {}))).toEqual({
      apiBaseUrl: "http://127.0.0.1:3000/api/v1",
      envVersion: "develop",
    });
  });

  it.each([
    ["https://API.Example.com:8443", "https://api.example.com:8443/api/v1"],
    ["https://api.example.com/base/", "https://api.example.com/base/api/v1"],
    ["https://api.example.com/base/api/v1", "https://api.example.com/base/api/v1"],
    [
      "https://api.example.com/%E4%BD%8F%E5%AE%BF",
      "https://api.example.com/%E4%BD%8F%E5%AE%BF/api/v1",
    ],
  ])("canonicalizes a configured deployment origin or path: %s", (apiBaseUrl, expected) => {
    for (const urlGlobal of [globalThis.URL, undefined]) {
      vi.stubGlobal("URL", urlGlobal);
      expect(getRuntimeConfig(wxApi("trial", { apiBaseUrl }))).toEqual({
        apiBaseUrl: expected,
        envVersion: "trial",
      });
    }
  });

  it.each(["trial", "release"])("requires HTTPS configuration in %s", (envVersion) => {
    expect(() => getRuntimeConfig(wxApi(envVersion, {}))).toThrow(
      "apiBaseUrl is required outside develop",
    );
    expect(() =>
      getRuntimeConfig(wxApi(envVersion, { apiBaseUrl: "http://api.example.com" })),
    ).toThrow("apiBaseUrl is required outside develop");
  });

  it.each([
    "https://user:pass@example.com",
    "https://example.com/#secret",
    "https://example.com/path?secret=value",
    "ftp://example.com",
    "not-a-url",
    "https://999.999.999.999",
    "https://[:]",
    "https://[:::1]",
    "https://example.com/a/../secret",
    "https://example.com/a/%2e%2e/secret",
    "https://example.com/a/%252e%252e/secret",
    "https://example.com/safe%2fsecret",
    "https://example.com/safe%252fsecret",
    "https://example.com/safe%5csecret",
    "https://example.com/safe%255csecret",
    "https://example.com/a//b",
  ])("rejects unsafe URLs: %s", (apiBaseUrl) => {
    for (const urlGlobal of [globalThis.URL, undefined]) {
      vi.stubGlobal("URL", urlGlobal);
      expect(() => getRuntimeConfig(wxApi("develop", { apiBaseUrl }))).toThrow();
    }
  });

  it("allows explicit HTTP only for loopback during develop", () => {
    expect(
      getRuntimeConfig(wxApi("develop", { apiBaseUrl: "http://localhost:4000/" })),
    ).toEqual({ apiBaseUrl: "http://localhost:4000/api/v1", envVersion: "develop" });
    expect(() =>
      getRuntimeConfig(wxApi("develop", { apiBaseUrl: "http://192.168.1.8:4000" })),
    ).toThrow();
  });

  it("does not require the browser URL global at runtime", () => {
    vi.stubGlobal("URL", undefined);
    expect(
      getRuntimeConfig(wxApi("release", { apiBaseUrl: "https://api.example.com/v1/" })),
    ).toEqual({
      apiBaseUrl: "https://api.example.com/v1/api/v1",
      envVersion: "release",
    });
  });

  it("routes auth and location services through the canonical API prefix", async () => {
    const request = vi.fn((options) => {
      const data = options.url.endsWith("/auth/wechat/login")
        ? {
            access_token: "a".repeat(32),
            access_expires_in: 120,
            refresh_token: "r".repeat(32),
            refresh_expires_in: 600,
            user: { id: "11111111-1111-4111-8111-111111111111" },
          }
        : [];
      options.success({ statusCode: 200, data: { data, request_id: "req_server" } });
    });
    const client = createRequestClient({
      wxApi: { request },
      getRuntimeConfig: () => getRuntimeConfig(wxApi("trial", { apiBaseUrl: "https://api.test" })),
      getSession: () => null,
      refreshSession: vi.fn(),
      createRequestId: () => "req_client",
    });

    await createAuthService(client).login("temporary-code");
    await createLocationService(client).listCities();

    expect(request.mock.calls.map(([options]) => options.url)).toEqual([
      "https://api.test/api/v1/auth/wechat/login",
      "https://api.test/api/v1/cities",
    ]);
  });

  it.each([
    "https://api.test/base?secret=value",
    "https://api.test/base/%2e%2e/secret",
  ])("rejects an unsafe configured base before making an API request: %s", async (apiBaseUrl) => {
    const request = vi.fn((options) =>
      options.success({ statusCode: 200, data: { data: [], request_id: "req_server" } }),
    );
    const client = createRequestClient({
      wxApi: { request },
      getRuntimeConfig: () => getRuntimeConfig(wxApi("trial", { apiBaseUrl })),
      getSession: () => null,
      refreshSession: vi.fn(),
      createRequestId: () => "req_client",
    });

    await expect(createLocationService(client).listCities()).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});

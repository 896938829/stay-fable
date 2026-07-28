import { afterEach, describe, expect, it, vi } from "vitest";

import runtime from "../config/runtime.js";

const { getRuntimeConfig } = runtime;

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
      apiBaseUrl: "http://127.0.0.1:3000",
      envVersion: "develop",
    });
  });

  it.each([undefined, ""])("treats a missing envVersion as develop: %s", (envVersion) => {
    expect(getRuntimeConfig(wxApi(envVersion, {}))).toEqual({
      apiBaseUrl: "http://127.0.0.1:3000",
      envVersion: "develop",
    });
  });

  it("normalizes a configured HTTPS base URL", () => {
    expect(
      getRuntimeConfig(wxApi("trial", { apiBaseUrl: "https://api.example.com///" })),
    ).toEqual({ apiBaseUrl: "https://api.example.com", envVersion: "trial" });
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
    "ftp://example.com",
    "not-a-url",
  ])("rejects unsafe URLs: %s", (apiBaseUrl) => {
    expect(() => getRuntimeConfig(wxApi("develop", { apiBaseUrl }))).toThrow();
  });

  it("allows explicit HTTP only for loopback during develop", () => {
    expect(
      getRuntimeConfig(wxApi("develop", { apiBaseUrl: "http://localhost:4000/" })),
    ).toEqual({ apiBaseUrl: "http://localhost:4000", envVersion: "develop" });
    expect(() =>
      getRuntimeConfig(wxApi("develop", { apiBaseUrl: "http://192.168.1.8:4000" })),
    ).toThrow();
  });

  it("does not require the browser URL global at runtime", () => {
    vi.stubGlobal("URL", undefined);
    expect(
      getRuntimeConfig(wxApi("release", { apiBaseUrl: "https://api.example.com/v1/" })),
    ).toEqual({ apiBaseUrl: "https://api.example.com/v1", envVersion: "release" });
  });
});

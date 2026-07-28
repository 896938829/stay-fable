"use strict";

const DEVELOP_FALLBACK = "http://127.0.0.1:3000";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function requiredError() {
  return new Error("apiBaseUrl is required outside develop");
}

function parseUrl(value) {
  if (typeof globalThis.URL === "function") {
    return new globalThis.URL(value);
  }
  const match =
    /^(https?):\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?(?:\/[^#\s]*)?$/i.exec(
      value,
    );
  const port = match && match[3] ? Number(match[3]) : undefined;
  if (!match || (port !== undefined && port > 65535)) {
    throw new Error("Invalid URL");
  }
  return {
    hash: "",
    hostname: match[2].replace(/^\[|\]$/g, ""),
    password: "",
    protocol: `${match[1].toLowerCase()}:`,
    username: "",
  };
}

function normalizeApiBaseUrl(value, envVersion, explicit) {
  if (typeof value !== "string" || value.trim() === "") {
    if (envVersion === "develop" && !explicit) {
      return DEVELOP_FALLBACK;
    }
    throw requiredError();
  }

  let parsed;
  try {
    parsed = parseUrl(value.trim());
  } catch {
    if (envVersion !== "develop") {
      throw requiredError();
    }
    throw new Error("apiBaseUrl must be a valid HTTP URL");
  }

  const isHttp = parsed.protocol === "http:";
  const isHttps = parsed.protocol === "https:";
  const hasUnsafeParts = parsed.username !== "" || parsed.password !== "" || parsed.hash !== "";
  const allowedDevelopHttp =
    envVersion === "develop" && isHttp && LOOPBACK_HOSTS.has(parsed.hostname);

  if (!isHttp && !isHttps) {
    throw new Error("apiBaseUrl must use HTTP or HTTPS");
  }
  if (hasUnsafeParts) {
    throw new Error("apiBaseUrl must not contain credentials or a hash");
  }
  if (!isHttps && !allowedDevelopHttp) {
    if (envVersion !== "develop") {
      throw requiredError();
    }
    throw new Error("apiBaseUrl must use HTTPS except for develop loopback");
  }

  return value.trim().replace(/\/+$/, "");
}

function getRuntimeConfig(wxApi) {
  const api = wxApi || globalThis.wx;
  const accountInfo = api.getAccountInfoSync();
  const envVersion = accountInfo && accountInfo.miniProgram && accountInfo.miniProgram.envVersion;
  const extConfig =
    typeof api.getExtConfigSync === "function" ? api.getExtConfigSync() || {} : {};
  const explicit =
    Object.prototype.hasOwnProperty.call(extConfig, "apiBaseUrl") &&
    extConfig.apiBaseUrl !== undefined &&
    extConfig.apiBaseUrl !== null &&
    extConfig.apiBaseUrl !== "";

  return {
    apiBaseUrl: normalizeApiBaseUrl(extConfig.apiBaseUrl, envVersion, explicit),
    envVersion,
  };
}

module.exports = {
  getRuntimeConfig,
};

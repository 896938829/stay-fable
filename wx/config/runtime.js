"use strict";

const API_PREFIX = "/api/v1";
const DEVELOP_FALLBACK = `http://127.0.0.1:3000${API_PREFIX}`;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function requiredError() {
  return new Error("apiBaseUrl is required outside develop");
}

function isValidIpv4(value) {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every(
      (part) =>
        /^(?:0|[1-9][0-9]{0,2})$/.test(part) && Number(part) >= 0 && Number(part) <= 255,
    )
  );
}

function isValidIpv6(value) {
  const halves = value.split("::");
  if (halves.length > 2) {
    return false;
  }
  const left = halves[0] === "" ? [] : halves[0].split(":");
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1].split(":");
  const segments = [...left, ...right];
  if (segments.some((segment) => segment === "")) {
    return false;
  }

  let units = 0;
  for (const [index, segment] of segments.entries()) {
    if (segment.includes(".")) {
      if (index !== segments.length - 1 || !isValidIpv4(segment)) {
        return false;
      }
      units += 2;
    } else {
      if (!/^[0-9a-f]{1,4}$/i.test(segment)) {
        return false;
      }
      units += 1;
    }
  }
  return halves.length === 2 ? units < 8 : units === 8;
}

function parseUrl(value) {
  const match = /^(https?):\/\/([^/?#]+)(\/[^?#]*)?$/i.exec(value);
  if (!match || match[2].includes("@")) {
    throw new Error("Invalid URL");
  }

  let hostname;
  let renderedHost;
  let portText = "";
  if (match[2].startsWith("[")) {
    const hostMatch = /^\[([0-9a-f:.]+)\](?::([0-9]{1,5}))?$/i.exec(match[2]);
    if (!hostMatch || !isValidIpv6(hostMatch[1])) {
      throw new Error("Invalid URL");
    }
    hostname = hostMatch[1].toLowerCase();
    renderedHost = `[${hostname}]`;
    portText = hostMatch[2] || "";
  } else {
    const hostMatch =
      /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,5}))?$/i.exec(match[2]);
    if (
      !hostMatch ||
      hostMatch[1].length > 253 ||
      hostMatch[1].includes("..") ||
      hostMatch[1]
        .split(".")
        .some(
          (label) => label.length > 63 || label.startsWith("-") || label.endsWith("-"),
        ) ||
      (/^[0-9.]+$/.test(hostMatch[1]) && !isValidIpv4(hostMatch[1]))
    ) {
      throw new Error("Invalid URL");
    }
    hostname = hostMatch[1].toLowerCase();
    renderedHost = hostname;
    portText = hostMatch[2] || "";
  }

  if (portText !== "" && (Number(portText) < 1 || Number(portText) > 65535)) {
    throw new Error("Invalid URL");
  }

  return {
    authority: `${renderedHost}${portText ? `:${portText}` : ""}`,
    hostname,
    pathname: canonicalizePath(match[3] || ""),
    protocol: `${match[1].toLowerCase()}:`,
  };
}

function canonicalizePath(pathname) {
  if (pathname === "" || pathname === "/") {
    return "";
  }
  let candidate = pathname;
  for (let depth = 0; depth <= pathname.length; depth += 1) {
    const segments = candidate.split("/");
    if (
      candidate.includes("//") ||
      candidate.includes("\\") ||
      /%2f|%5c/i.test(candidate) ||
      segments.includes(".") ||
      segments.includes("..")
    ) {
      throw new Error("Invalid URL");
    }
    let decoded;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      throw new Error("Invalid URL");
    }
    if (decoded === candidate) {
      break;
    }
    candidate = decoded;
  }

  const withoutTrailingSlash = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return withoutTrailingSlash
    .split("/")
    .map((segment, index) => {
      if (index === 0) {
        return "";
      }
      try {
        return encodeURIComponent(decodeURIComponent(segment));
      } catch {
        throw new Error("Invalid URL");
      }
    })
    .join("/");
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
  const allowedDevelopHttp =
    envVersion === "develop" && isHttp && LOOPBACK_HOSTS.has(parsed.hostname);

  if (!isHttp && !isHttps) {
    throw new Error("apiBaseUrl must use HTTP or HTTPS");
  }
  if (!isHttps && !allowedDevelopHttp) {
    if (envVersion !== "develop") {
      throw requiredError();
    }
    throw new Error("apiBaseUrl must use HTTPS except for develop loopback");
  }

  const basePath = parsed.pathname.endsWith(API_PREFIX)
    ? parsed.pathname
    : `${parsed.pathname}${API_PREFIX}`;
  return `${parsed.protocol}//${parsed.authority}${basePath}`;
}

function getRuntimeConfig(wxApi) {
  const api = wxApi || globalThis.wx;
  const accountInfo = api.getAccountInfoSync();
  const reportedEnvVersion =
    accountInfo && accountInfo.miniProgram && accountInfo.miniProgram.envVersion;
  const envVersion =
    typeof reportedEnvVersion === "string" && reportedEnvVersion.trim() !== ""
      ? reportedEnvVersion
      : "develop";
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

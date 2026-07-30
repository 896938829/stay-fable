"use strict";

const path = require("node:path");
const { types } = require("node:util");

const SHA_1_PATTERN = /^[a-f0-9]{40}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TIMEOUT_MS = 30_000;
// Trust boundary: callers must provide project-owned, read-only adapters.
// JavaScript cannot prove an arbitrary function is pure; adapters must honor
// the supplied AbortSignal and must not retain or act after it is aborted.
const READ_ONLY_ADAPTER_METHODS = Object.freeze([
  "readCandidate",
  "readWechatIde",
  "readTestAccountCount",
  "readApiHealth",
  "readClockDate",
  "readSeedWindow",
  "readBaseline",
]);

function isPlainRecord(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    types.isProxy(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasDataProperties(value, requiredKeys) {
  if (!isPlainRecord(value)) {
    return false;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of requiredKeys) {
    const descriptor = descriptors[key];
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.get === "function" ||
      typeof descriptor.set === "function"
    ) {
      return false;
    }
  }
  return true;
}

function hasExactDataProperties(value, requiredKeys) {
  if (!hasDataProperties(value, requiredKeys)) {
    return false;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return (
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.keys(descriptors).length === requiredKeys.length
  );
}

function isSha1(value) {
  return typeof value === "string" && SHA_1_PATTERN.test(value);
}

function isSafeAbsolutePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !value.includes("\0") &&
    path.isAbsolute(value)
  );
}

function normalizedPath(value) {
  const resolved = path.normalize(path.resolve(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isIsoDate(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value;
}

function shiftIsoDate(value, days) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function blocked(status, reason) {
  return {
    schemaVersion: 1,
    status,
    reason,
    executionBoundary: {
      state: "READ_ONLY_PREFLIGHT",
      interactionStarted: false,
    },
  };
}

function validateOptions(options) {
  if (
    !hasDataProperties(options, [
      "expectedProjectPath",
      "expectedCommit",
      "expectedWxTree",
      "executionDate",
      "timeoutMs",
    ])
  ) {
    return false;
  }
  return (
    isSafeAbsolutePath(options.expectedProjectPath) &&
    isSha1(options.expectedCommit) &&
    isSha1(options.expectedWxTree) &&
    isIsoDate(options.executionDate) &&
    Number.isSafeInteger(options.timeoutMs) &&
    options.timeoutMs > 0 &&
    options.timeoutMs <= MAX_TIMEOUT_MS
  );
}

function validateDependencies(dependencies) {
  if (!isPlainRecord(dependencies)) {
    return false;
  }
  const descriptors = Object.getOwnPropertyDescriptors(dependencies);
  return (
    Object.getOwnPropertySymbols(dependencies).length === 0 &&
    Object.keys(descriptors).length ===
      READ_ONLY_ADAPTER_METHODS.length &&
    READ_ONLY_ADAPTER_METHODS.every(
      (name) =>
        descriptors[name] &&
        Object.hasOwn(descriptors[name], "value") &&
        typeof descriptors[name].value === "function",
    )
  );
}

async function readWithTimeout(reader, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() =>
        reader(Object.freeze({ signal: controller.signal })),
      ),
      new Promise((resolve, reject) => {
        timer = setTimeout(
          () => {
            controller.abort();
            reject(new Error("preflight read timed out"));
          },
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    controller.abort();
  }
}

async function runPreflight(options, dependencies) {
  if (!validateOptions(options) || !validateDependencies(dependencies)) {
    return blocked(
      "BLOCKED_AUTOMATOR_RC",
      "PREFLIGHT_CONFIGURATION_INVALID",
    );
  }
  const config = Object.freeze({
    expectedProjectPath: options.expectedProjectPath,
    expectedCommit: options.expectedCommit,
    expectedWxTree: options.expectedWxTree,
    executionDate: options.executionDate,
    timeoutMs: options.timeoutMs,
  });
  const readers = Object.freeze(
    Object.fromEntries(
      READ_ONLY_ADAPTER_METHODS.map((name) => [
        name,
        Object.getOwnPropertyDescriptor(dependencies, name).value,
      ]),
    ),
  );

  try {
    const candidate = await readWithTimeout(
      readers.readCandidate,
      config.timeoutMs,
    );
    if (
      !hasDataProperties(candidate, ["commit", "wxTree", "clean"]) ||
      !isSha1(candidate.commit) ||
      !isSha1(candidate.wxTree) ||
      typeof candidate.clean !== "boolean"
    ) {
      return blocked("BLOCKED_AUTOMATOR_RC", "PREFLIGHT_READ_FAILED");
    }
    const candidateSnapshot = Object.freeze({
      commit: candidate.commit,
      wxTree: candidate.wxTree,
      clean: candidate.clean,
    });
    if (
      candidateSnapshot.commit !== config.expectedCommit ||
      candidateSnapshot.wxTree !== config.expectedWxTree ||
      candidateSnapshot.clean !== true
    ) {
      return blocked("BLOCKED_AUTOMATOR_RC", "CANDIDATE_MISMATCH");
    }

    const wechatide = await readWithTimeout(
      readers.readWechatIde,
      config.timeoutMs,
    );
    if (
      !hasDataProperties(wechatide, [
        "versionRelation",
        "loginValid",
        "tokenRequired",
        "tokenAvailable",
        "projectPath",
      ])
    ) {
      return blocked("BLOCKED_AUTOMATOR_RC", "PREFLIGHT_READ_FAILED");
    }
    const supportedVersion = wechatide.versionRelation === "equal";
    const usableToken =
      wechatide.tokenRequired === false ||
      wechatide.tokenAvailable === true;
    const exactProject =
      isSafeAbsolutePath(wechatide.projectPath) &&
      normalizedPath(wechatide.projectPath) ===
        normalizedPath(config.expectedProjectPath);
    if (
      !supportedVersion ||
      wechatide.loginValid !== true ||
      typeof wechatide.tokenRequired !== "boolean" ||
      typeof wechatide.tokenAvailable !== "boolean" ||
      !usableToken ||
      !exactProject
    ) {
      return blocked(
        "BLOCKED_AUTOMATOR_RC",
        "WECHATIDE_CONTEXT_INVALID",
      );
    }

    const accountCount = await readWithTimeout(
      readers.readTestAccountCount,
      config.timeoutMs,
    );
    if (
      !Number.isSafeInteger(accountCount) ||
      accountCount < 0 ||
      accountCount > 100
    ) {
      return blocked("BLOCKED_AUTOMATOR_RC", "PREFLIGHT_READ_FAILED");
    }
    if (accountCount === 0) {
      return blocked(
        "BLOCKED_TEST_ACCOUNT",
        "TEST_ACCOUNT_UNAVAILABLE",
      );
    }

    let health;
    try {
      health = await readWithTimeout(
        readers.readApiHealth,
        config.timeoutMs,
      );
    } catch {
      return blocked("BLOCKED_API", "API_NOT_READY");
    }
    if (
      !hasExactDataProperties(health, [
        "transport",
        "host",
        "liveEndpoint",
        "readyEndpoint",
        "live",
        "ready",
      ]) ||
      health.transport !== "HTTP_LOOPBACK" ||
      !["127.0.0.1", "::1"].includes(health.host) ||
      health.liveEndpoint !== "/health/live" ||
      health.readyEndpoint !== "/health/ready" ||
      health.live !== true ||
      health.ready !== true
    ) {
      return blocked("BLOCKED_API", "API_NOT_READY");
    }

    let clockDate;
    try {
      clockDate = await readWithTimeout(
        readers.readClockDate,
        config.timeoutMs,
      );
    } catch {
      return blocked(
        "BLOCKED_DATA_WINDOW",
        "SEED_WINDOW_UNAVAILABLE",
      );
    }
    if (
      !isIsoDate(clockDate) ||
      clockDate !== config.executionDate
    ) {
      return blocked(
        "BLOCKED_DATA_WINDOW",
        "SEED_WINDOW_UNAVAILABLE",
      );
    }

    let seedWindow;
    try {
      seedWindow = await readWithTimeout(
        readers.readSeedWindow,
        config.timeoutMs,
      );
    } catch {
      return blocked(
        "BLOCKED_DATA_WINDOW",
        "SEED_WINDOW_UNAVAILABLE",
      );
    }
    if (!hasDataProperties(seedWindow, ["available"])) {
      return blocked("BLOCKED_AUTOMATOR_RC", "PREFLIGHT_READ_FAILED");
    }
    if (seedWindow.available !== true) {
      return blocked(
        "BLOCKED_DATA_WINDOW",
        "SEED_WINDOW_UNAVAILABLE",
      );
    }
    if (
      !hasExactDataProperties(seedWindow, [
        "available",
        "start",
        "end",
      ]) ||
      !isIsoDate(seedWindow.start) ||
      !isIsoDate(seedWindow.end) ||
      seedWindow.start !== shiftIsoDate(config.executionDate, 1) ||
      seedWindow.end !== shiftIsoDate(config.executionDate, 3)
    ) {
      return blocked(
        "BLOCKED_DATA_WINDOW",
        "SEED_WINDOW_UNAVAILABLE",
      );
    }
    const seedSnapshot = Object.freeze({
      start: seedWindow.start,
      end: seedWindow.end,
    });

    const baseline = await readWithTimeout(
      readers.readBaseline,
      config.timeoutMs,
    );
    if (
      !hasDataProperties(baseline, [
        "consoleErrors",
        "networkFailures",
      ]) ||
      !Number.isSafeInteger(baseline.consoleErrors) ||
      baseline.consoleErrors < 0 ||
      baseline.consoleErrors > 10_000 ||
      !Number.isSafeInteger(baseline.networkFailures) ||
      baseline.networkFailures < 0 ||
      baseline.networkFailures > 10_000
    ) {
      return blocked("BLOCKED_AUTOMATOR_RC", "PREFLIGHT_READ_FAILED");
    }
    if (
      baseline.consoleErrors !== 0 ||
      baseline.networkFailures !== 0
    ) {
      return blocked("FAILED_PRODUCT", "RUNTIME_BASELINE_FAILED");
    }

    return {
      schemaVersion: 1,
      status: "READY",
      reason: "PREFLIGHT_READY",
      candidate: {
        commit: candidateSnapshot.commit,
        wxTree: candidateSnapshot.wxTree,
      },
      seedWindow: {
        start: seedSnapshot.start,
        end: seedSnapshot.end,
      },
      checks: {
        candidate: "PASS",
        wechatide: "PASS",
        testAccount: "PASS",
        api: "PASS",
        dataWindow: "PASS",
        baseline: "PASS",
      },
      executionBoundary: {
        state: "READ_ONLY_PREFLIGHT",
        interactionStarted: false,
      },
    };
  } catch {
    return blocked("BLOCKED_AUTOMATOR_RC", "PREFLIGHT_READ_FAILED");
  }
}

module.exports = {
  READ_ONLY_ADAPTER_METHODS,
  runPreflight,
};

"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const {
  link,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  rmdir,
  stat,
  writeFile,
} = require("node:fs/promises");
const path = require("node:path");
const automator = require("miniprogram-automator");

const HOME_SELECTOR = ".home";
const SEARCH_ACTION_SELECTOR = ".search-button";
const PROPERTY_LIST_SELECTOR = ".property-list-page";
const PROPERTY_RESULTS_SELECTOR = ".property-results";
const FILTER_SELECTOR = ".filter";
const PROPERTY_CARD_SELECTOR = "property-card";
const PROPERTY_CARD_ACTION_SELECTOR = ".property-card__tap-target";
const PROPERTY_DETAIL_SELECTOR = ".property-detail-page";
const ROOM_ACTION_SELECTOR = ".room-card__action";
const ROOM_DETAIL_SELECTOR = ".room-detail-page";
const NIGHTLY_PRICE_SELECTOR = ".nightly-list__item";
const BOOKING_HINT_SELECTOR = ".detail-section__hint";
const ROOM_SELECTION_SELECTOR = ".selection-bar__action";
const HOMESTAY_TYPE = "HOMESTAY";
const BOOKING_NOTICE = Object.freeze({
  title: "预订功能即将开放",
  content: "报价与预订将在下一开发切片开放",
  showCancel: false,
});
const BOOKING_MODAL_PROBE_STATE_KEY =
  "__stayFableCatalogBookingModalProbeState";
const ACTION_TIMEOUT_MS = 10_000;
const WORKFLOW_TIMEOUT_MS = 120_000;
const WINDOWS_CLI_CONNECT_TIMEOUT_MS = 20_000;
const WINDOWS_CLI_CLEANUP_TIMEOUT_MS = 2_000;
const WINDOWS_CLI_FORCE_CLEANUP_TIMEOUT_MS = 250;
const WINDOWS_CLI_EXIT_GRACE_MS = 1_000;
const WINDOWS_CLI_POST_CONNECT_MS = 5_000;
const WINDOWS_CLI_BOOTSTRAP =
  "const e=process.argv[1],a=process.argv.slice(2).filter(function(x){return x!=='--electron'});if(!process.env.cwd)process.env.cwd=process.cwd();process.argv=[process.execPath,'--ms-enable-electron-run-as-node',e,'--electron'].concat(a);require(e)";
const WINDOWS_CLI_ENTRY_PARTS = [
  "resources",
  "app.asar.unpacked",
  "js",
  "common",
  "cli",
  "index.js",
];
const WINDOWS_ELECTRON_RUNTIME = "微信开发者工具.exe";
const WINDOWS_CONTROLLED_ENVIRONMENT_KEYS = new Set([
  "CWD",
  "ELECTRON",
  "ELECTRON_RUN_AS_NODE",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
  "NODE_CHANNEL_FD",
  "NODE_CHANNEL_SERIALIZATION_MODE",
]);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CATALOG_SEARCH_FIXTURE = Object.freeze({
  city: Object.freeze({
    id: "10000000-0000-4000-8000-000000000001",
    code: "330100",
    name: "杭州",
  }),
  checkin: "2026-07-30",
  checkout: "2026-08-01",
  guests: 3,
});
const FAILURE_STEPS = new Set([
  "arguments",
  "launch",
  "fixture",
  "home",
  "property-list",
  "homestay-filter",
  "restore-all",
  "property-detail",
  "room-detail",
  "booking-notice",
  "return-to-list",
  "workflow",
  "cleanup",
]);
const SAFE_PAGE_ROUTE_PATTERN =
  /^pages\/[a-z0-9-]+\/[a-z0-9-]+$/;
const UNSAFE_EVIDENCE_MARKERS = [
  ["access", "token"].join("_"),
  ["refresh", "token"].join("_"),
  ["author", "ization"].join(""),
  ["bear", "er"].join(""),
  ["app", "id"].join(""),
  ["long", "itude"].join(""),
  ["lat", "itude"].join(""),
];

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function createCancellationContext(controller = new AbortController()) {
  return {
    abort(reason) {
      if (!controller.signal.aborted) {
        controller.abort(reason);
      }
    },
    signal: controller.signal,
    throwIfAborted() {
      if (controller.signal.aborted) {
        throw new Error("catalog automation cancelled");
      }
    },
  };
}

function withTimeout(
  label,
  task,
  timeoutMs = ACTION_TIMEOUT_MS,
  context,
) {
  let timer;
  const operation = Promise.resolve().then(task);
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => {
        context?.abort?.();
        reject(new Error(`${label} timed out`));
      },
      timeoutMs,
    );
  });
  return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runInteraction(
  context,
  label,
  operation,
  timeoutMs = ACTION_TIMEOUT_MS,
) {
  context.throwIfAborted();
  const result = await withTimeout(
    label,
    operation,
    timeoutMs,
    context,
  );
  context.throwIfAborted();
  return result;
}

function invalidArguments() {
  return new Error("catalog automator arguments are invalid");
}

function parseCliArguments(arguments_) {
  if (
    !Array.isArray(arguments_) ||
    ![2, 4].includes(arguments_.length) ||
    arguments_.some(
      (argument) => typeof argument !== "string" || argument === "",
    ) ||
    (arguments_.length === 4 && arguments_[2] !== "--cli-path")
  ) {
    throw invalidArguments();
  }
  return {
    projectPath: arguments_[0],
    evidenceDirectory: arguments_[1],
    cliPath: arguments_.length === 4 ? arguments_[3] : undefined,
  };
}

function absolutePath(value) {
  return (
    typeof value === "string" &&
    value !== "" &&
    (path.win32.isAbsolute(value) || path.posix.isAbsolute(value))
  );
}

function controlledCliPath(environment) {
  try {
    return environment &&
      typeof environment === "object" &&
      typeof environment.WECHAT_DEVTOOLS_CLI_PATH === "string"
      ? environment.WECHAT_DEVTOOLS_CLI_PATH
      : undefined;
  } catch {
    return undefined;
  }
}

function buildLaunchOptions(projectPath, explicitCliPath, environment = {}) {
  const cliPath =
    explicitCliPath === undefined
      ? controlledCliPath(environment)
      : explicitCliPath;
  if (!absolutePath(projectPath) || !absolutePath(cliPath)) {
    throw new Error("WeChat DevTools CLI path is required");
  }
  return { cliPath, projectPath };
}

function isWindowsBatchCli(cliPath, platform = process.platform) {
  return (
    platform === "win32" &&
    typeof cliPath === "string" &&
    path.extname(cliPath).toLowerCase() === ".bat"
  );
}

async function resolveRegularFile(candidate, label) {
  try {
    const canonicalPath = await realpath(candidate);
    const file = await stat(canonicalPath);
    if (!file.isFile()) {
      throw new Error("not a regular file");
    }
    return canonicalPath;
  } catch {
    throw new Error(`WeChat DevTools ${label} is unavailable`);
  }
}

async function resolveWindowsCliRuntime(cliPath) {
  if (
    typeof cliPath !== "string" ||
    path.extname(cliPath).toLowerCase() !== ".bat"
  ) {
    throw new Error("WeChat DevTools batch CLI is unavailable");
  }
  const canonicalCliPath = await resolveRegularFile(cliPath, "batch CLI");
  if (path.extname(canonicalCliPath).toLowerCase() !== ".bat") {
    throw new Error("WeChat DevTools batch CLI is unavailable");
  }
  const installRoot = await realpath(path.dirname(canonicalCliPath));
  const cliEntryPath = await resolveRegularFile(
    path.join(installRoot, ...WINDOWS_CLI_ENTRY_PARTS),
    "CLI entry",
  );
  if (!isWithin(installRoot, cliEntryPath)) {
    throw new Error("WeChat DevTools CLI entry is unavailable");
  }
  const electronPath = await resolveRegularFile(
    path.join(installRoot, WINDOWS_ELECTRON_RUNTIME),
    "Electron runtime",
  );
  if (!isWithin(installRoot, electronPath)) {
    throw new Error("WeChat DevTools Electron runtime is unavailable");
  }
  return {
    cliEntryPath,
    electronPath,
    installRoot,
  };
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = require("node:net").createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        address && typeof address === "object" ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
        } else if (!Number.isInteger(port) || port <= 0) {
          reject(new Error("automation port is unavailable"));
        } else {
          resolve(port);
        }
      });
    });
  });
}

async function launchWindowsBatchMiniProgram(
  automatorApi,
  options,
  dependencies = {},
) {
  if (typeof automatorApi?.connect !== "function") {
    throw new Error("automator connect API is unavailable");
  }
  const resolveRuntime =
    dependencies.resolveWindowsCliRuntime || resolveWindowsCliRuntime;
  const selectPort = dependencies.allocatePort || allocatePort;
  const spawnProcess = dependencies.spawnProcess || spawn;
  const wait = dependencies.sleep || sleep;
  const environment = dependencies.environment || process.env;
  const runtime = await resolveRuntime(options.cliPath);
  const cliEnvironment = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!WINDOWS_CONTROLLED_ENVIRONMENT_KEYS.has(key.toUpperCase())) {
      cliEnvironment[key] = value;
    }
  }
  cliEnvironment.ELECTRON_RUN_AS_NODE = "1";
  cliEnvironment.cwd = options.cwd || process.cwd();

  const connectTimeoutMs =
    dependencies.connectTimeoutMs ?? WINDOWS_CLI_CONNECT_TIMEOUT_MS;
  const cleanupTimeoutMs =
    dependencies.cleanupTimeoutMs ?? WINDOWS_CLI_CLEANUP_TIMEOUT_MS;
  const forceCleanupTimeoutMs =
    dependencies.forceCleanupTimeoutMs ??
    WINDOWS_CLI_FORCE_CLEANUP_TIMEOUT_MS;
  const signal = dependencies.signal;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (signal?.aborted) {
      throw new Error("catalog automation launch cancelled");
    }
    const port = await selectPort();
    if (signal?.aborted) {
      throw new Error("catalog automation launch cancelled");
    }
    const cliArguments = [
      "-e",
      WINDOWS_CLI_BOOTSTRAP,
      runtime.cliEntryPath,
      "auto",
      "--project",
      options.projectPath,
      "--auto-port",
      String(port),
    ];
    let child;
    try {
      child = spawnProcess(runtime.electronPath, cliArguments, {
        cwd: runtime.installRoot,
        env: cliEnvironment,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      throw new Error("WeChat DevTools CLI exited unexpectedly");
    }
    const state = observeChildProcess(child);
    child.unref();
    const deadline = Date.now() + connectTimeoutMs;
    let retryEarlyCliFailure = false;
    let launchError;

    while (!launchError && Date.now() < deadline) {
      const outcome = await connectWithinDeadline(
        automatorApi,
        port,
        deadline,
        signal,
        state,
        dependencies.exitGraceMs ?? WINDOWS_CLI_EXIT_GRACE_MS,
      );
      if (outcome.kind === "connected") {
        const postConnect = await waitAfterConnect(
          wait,
          dependencies.postConnectMs ?? WINDOWS_CLI_POST_CONNECT_MS,
          signal,
          state,
        );
        if (postConnect === "ready") {
          return outcome.miniprogram;
        }
        disconnectMiniProgram(outcome.miniprogram);
        launchError =
          postConnect === "aborted"
            ? new Error("catalog automation launch cancelled")
            : childLaunchError(state);
        break;
      }
      if (outcome.kind === "aborted") {
        launchError = new Error("catalog automation launch cancelled");
        break;
      }
      if (outcome.kind === "child-error") {
        launchError = childLaunchError(state);
        break;
      }
      if (outcome.kind === "child-exit") {
        if (state.exitCode === 0 && state.errorCode === undefined) {
          launchError = new Error(
            "WeChat DevTools project window must be closed before automation launch",
          );
        } else {
          retryEarlyCliFailure =
            typeof state.exitCode === "number" && state.exitCode !== 0;
          launchError = childLaunchError(state);
        }
        break;
      }
      if (outcome.kind === "timeout") {
        launchError = new Error(
          "WeChat DevTools automation endpoint is unavailable",
        );
        break;
      }
      await wait(
        Math.min(
          dependencies.pollIntervalMs ?? 200,
          Math.max(0, deadline - Date.now()),
        ),
      );
    }

    launchError ||= new Error(
      "WeChat DevTools automation endpoint is unavailable",
    );
    const childStopped = await stopChildProcess(
      child,
      state,
      cleanupTimeoutMs,
      forceCleanupTimeoutMs,
    );
    if (retryEarlyCliFailure && attempt === 0 && childStopped) {
      continue;
    }
    throw launchError;
  }
  throw new Error("WeChat DevTools automation endpoint is unavailable");
}

function observeChildProcess(child) {
  let settleFailure;
  let settleTerminal;
  const state = {
    errorCode: undefined,
    exitCode: undefined,
    exited: false,
    failure: new Promise((resolve) => {
      settleFailure = resolve;
    }),
    terminal: new Promise((resolve) => {
      settleTerminal = resolve;
    }),
  };
  const settle = () => {
    if (!state.exited) {
      state.exited = true;
      settleTerminal();
    }
  };
  let failureObserved = false;
  child.on("error", (error) => {
    state.errorCode =
      typeof error?.code === "string" ? error.code : "UNKNOWN";
    if (!failureObserved) {
      failureObserved = true;
      settleFailure();
    }
  });
  child.once("exit", (code) => {
    state.exitCode = code;
    settle();
  });
  child.once("close", (code) => {
    if (state.exitCode === undefined) {
      state.exitCode = code;
    }
    settle();
  });
  return state;
}

function disconnectMiniProgram(miniprogram) {
  try {
    miniprogram?.disconnect?.();
  } catch {
    // Disconnect is best effort after a launch path has been abandoned.
  }
}

async function connectWithinDeadline(
  automatorApi,
  port,
  deadline,
  signal,
  state,
  cleanExitGraceMs,
) {
  if (signal?.aborted) {
    return { kind: "aborted" };
  }
  const remainingMs = Math.max(0, deadline - Date.now());
  if (remainingMs === 0) {
    return { kind: "timeout" };
  }
  const connection = Promise.resolve().then(() =>
    automatorApi.connect({
      wsEndpoint: `ws://127.0.0.1:${port}`,
    }),
  );
  const observedConnection = connection.then(
    (miniprogram) => ({ kind: "connected", miniprogram }),
    (error) => ({ error, kind: "connection-error" }),
  );
  let timer;
  let onAbort;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), remainingMs);
  });
  const aborted = new Promise((resolve) => {
    if (!signal) {
      return;
    }
    onAbort = () => resolve({ kind: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
  });
  let outcome = await Promise.race([
    observedConnection,
    timeout,
    aborted,
    state.failure.then(() => ({ kind: "child-error" })),
    state.terminal.then(() => ({ kind: "child-exit" })),
  ]);
  if (
    outcome.kind === "child-exit" &&
    state.exitCode === 0 &&
    state.errorCode === undefined &&
    cleanExitGraceMs > 0
  ) {
    let graceTimer;
    const grace = new Promise((resolve) => {
      graceTimer = setTimeout(
        () => resolve({ kind: "child-exit" }),
        Math.min(cleanExitGraceMs, Math.max(0, deadline - Date.now())),
      );
    });
    const afterCleanExit = await Promise.race([
      observedConnection,
      aborted,
      grace,
    ]);
    clearTimeout(graceTimer);
    outcome =
      afterCleanExit.kind === "connected" ||
      afterCleanExit.kind === "aborted"
        ? afterCleanExit
        : { kind: "child-exit" };
  }
  clearTimeout(timer);
  if (signal && onAbort) {
    signal.removeEventListener("abort", onAbort);
  }
  if (outcome.kind !== "connected") {
    connection.then(disconnectMiniProgram, () => undefined);
  }
  return outcome;
}

async function waitAfterConnect(wait, milliseconds, signal, state) {
  if (signal?.aborted) {
    return "aborted";
  }
  let onAbort;
  const aborted = new Promise((resolve) => {
    if (!signal) {
      return;
    }
    onAbort = () => resolve("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const outcome = await Promise.race([
    Promise.resolve().then(() => wait(milliseconds)).then(() => "ready"),
    aborted,
    state.failure.then(() => "child-error"),
    state.terminal.then(() =>
      state.exitCode === 0 && state.errorCode === undefined
        ? new Promise(() => {})
        : "child-exit",
    ),
  ]);
  if (signal && onAbort) {
    signal.removeEventListener("abort", onAbort);
  }
  return outcome;
}

async function stopChildProcess(
  child,
  state,
  timeoutMs,
  forceTimeoutMs,
) {
  if (state.exited) {
    return true;
  }
  const softKillAccepted = requestChildTermination(child);
  if (await waitForChildTerminal(state, timeoutMs)) {
    return true;
  }
  const forceKillAccepted = requestChildTermination(child, "SIGKILL");
  if (await waitForChildTerminal(state, forceTimeoutMs)) {
    return true;
  }
  if (!softKillAccepted || !forceKillAccepted || !state.exited) {
    throw new Error("WeChat DevTools CLI cleanup failed");
  }
  return true;
}

function requestChildTermination(child, signal) {
  try {
    return signal === undefined
      ? child.kill() !== false
      : child.kill(signal) !== false;
  } catch {
    return false;
  }
}

async function waitForChildTerminal(state, timeoutMs) {
  if (state.exited) {
    return true;
  }
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
  });
  const stopped = await Promise.race([
    state.terminal.then(() => true),
    timedOut,
  ]);
  clearTimeout(timer);
  return stopped;
}

function childLaunchError() {
  return new Error("WeChat DevTools CLI exited unexpectedly");
}

function selectDefaultAutomatorApi(
  automatorApi,
  options,
  dependencies = {},
) {
  if (
    !isWindowsBatchCli(
      options.cliPath,
      dependencies.platform ?? process.platform,
    )
  ) {
    return automatorApi;
  }
  let activeLaunch;
  return {
    launch(launchOptions) {
      const controller = new AbortController();
      const launched = launchWindowsBatchMiniProgram(
        automatorApi,
        launchOptions,
        { ...dependencies, signal: controller.signal },
      );
      activeLaunch = { controller, launched };
      launched.then(
        () => {
          if (activeLaunch?.launched === launched) {
            activeLaunch = undefined;
          }
        },
        () => {
          if (activeLaunch?.launched === launched) {
            activeLaunch = undefined;
          }
        },
      );
      return launched;
    },
    async cancelLaunch() {
      const launch = activeLaunch;
      if (!launch) {
        return;
      }
      launch.controller.abort();
      try {
        await launch.launched;
      } catch {
        // The outer launch timeout remains the public failure.
      }
    },
  };
}

function launchMiniProgram(
  automatorApi,
  options,
  timeoutMs = ACTION_TIMEOUT_MS * 3,
) {
  let launchIsActive = true;
  const launched = Promise.resolve().then(() => automatorApi.launch(options));
  launched
    .then((miniprogram) => {
      if (!launchIsActive) {
        return closeMiniProgram(miniprogram).catch(() => undefined);
      }
      return undefined;
    })
    .catch(() => undefined);
  return withTimeout("launch mini-program", () => launched, timeoutMs)
    .catch(async (error) => {
      if (
        error?.message === "launch mini-program timed out" &&
        typeof automatorApi.cancelLaunch === "function"
      ) {
        await automatorApi.cancelLaunch();
      }
      throw error;
    })
    .finally(() => {
      launchIsActive = false;
    });
}

async function closeMiniProgram(
  miniprogram,
  timeoutMs = ACTION_TIMEOUT_MS,
) {
  try {
    await withTimeout(
      "close mini-program",
      () => miniprogram.close(),
      timeoutMs,
    );
  } catch (error) {
    try {
      if (typeof miniprogram.disconnect === "function") {
        miniprogram.disconnect();
      }
    } catch {
      // The bounded graceful-close error remains the safe public failure.
    }
    throw error;
  }
}

function createStepTracker() {
  let step = "launch";
  return {
    enter(nextStep) {
      step = FAILURE_STEPS.has(nextStep) ? nextStep : "workflow";
    },
    get step() {
      return step;
    },
  };
}

function safePageRoute(value) {
  try {
    const route =
      typeof value === "string" ? value.replace(/^\/+/, "") : "";
    return SAFE_PAGE_ROUTE_PATTERN.test(route) ? route : "unknown";
  } catch {
    return "unknown";
  }
}

function catalogFailure(step, currentPage, evidencePaths) {
  const error = new Error("catalog automation failed");
  error.step = FAILURE_STEPS.has(step) ? step : "workflow";
  error.currentPage = safePageRoute(currentPage);
  error.evidencePaths = Array.isArray(evidencePaths)
    ? [...evidencePaths]
    : [];
  return error;
}

function formatCatalogFailure(error) {
  const evidencePaths = Array.isArray(error?.evidencePaths)
    ? error.evidencePaths.filter(
        (value) =>
          typeof value === "string" &&
          /^catalog-[A-Za-z0-9_-]+\/[0-9A-Za-z_-]+\.(?:png|tree\.wxml)$/.test(
            value,
          ),
      )
    : [];
  return {
    status: "fail",
    message: "catalog automation failed",
    step: FAILURE_STEPS.has(error?.step) ? error.step : "workflow",
    currentPage: safePageRoute(error?.currentPage),
    evidencePaths,
  };
}

async function prepareCatalogHome(miniprogram, context, options = {}) {
  const cancellation = context || createCancellationContext();
  const timeoutMs = options.timeoutMs ?? ACTION_TIMEOUT_MS;
  const original = await captureCatalogSearch(
    miniprogram,
    cancellation,
    timeoutMs,
  );
  options.onOriginal?.(original);
  const apply = startCatalogFixtureApply(miniprogram);
  options.onApply?.(apply);
  await waitForCatalogFixtureApply(apply, cancellation, timeoutMs);
  await runInteraction(
    cancellation,
    "open home",
    () => miniprogram.reLaunch("/pages/home/home"),
    timeoutMs,
  );
  return original;
}

async function captureCatalogSearch(
  miniprogram,
  context,
  timeoutMs = ACTION_TIMEOUT_MS,
) {
  const cancellation = context || createCancellationContext();
  return runInteraction(
    cancellation,
    "capture catalog search",
    () =>
      miniprogram.evaluate(() => {
        const store = getApp().globalData.searchStore;
        const original =
          typeof store.get === "function" ? store.get() : undefined;
        return {
          hasValue: original !== undefined && original !== null,
          value: original,
        };
      }),
    timeoutMs,
  );
}

function startCatalogFixtureApply(miniprogram) {
  const token = randomUUID();
  const serializedFixture = JSON.stringify(CATALOG_SEARCH_FIXTURE);
  const settled = Promise.resolve()
    .then(() =>
      miniprogram.evaluate((fixtureToken, serializedValue) => {
        const value = JSON.parse(serializedValue);
        const runtime = globalThis;
        const stateKey = "__stayFableCatalogFixtureState";
        const state =
          runtime[stateKey] ||
          (runtime[stateKey] = {
            cancelled: Object.create(null),
          });
        if (state.cancelled[fixtureToken] === true) {
          return { status: "skipped" };
        }
        const store = getApp().globalData.searchStore;
        const stored = store.set(value);
        return {
          fixture: {
            city: {
              id: stored.city.id,
              code: stored.city.code,
              name: stored.city.name,
            },
            checkin: stored.checkin,
            checkout: stored.checkout,
            guests: stored.guests,
          },
          status: "applied",
        };
      }, token, serializedFixture),
    )
    .then((result) => {
      if (result && result.status === "skipped") {
        return result;
      }
      assert.equal(result && result.status, "applied");
      assert.deepEqual(result.fixture, CATALOG_SEARCH_FIXTURE);
      return result;
    });
  settled.catch(() => undefined);
  return { settled, token };
}

async function waitForCatalogFixtureApply(
  apply,
  context,
  timeoutMs = ACTION_TIMEOUT_MS,
) {
  const cancellation = context || createCancellationContext();
  return runInteraction(
    cancellation,
    "apply catalog fixture",
    () => apply.settled,
    timeoutMs,
  );
}

async function restoreCatalogSearch(
  miniprogram,
  apply,
  original,
  context,
  timeoutMs = ACTION_TIMEOUT_MS,
) {
  const cancellation = context || createCancellationContext();
  const serializedSnapshot = JSON.stringify(original);
  cancellation.throwIfAborted();
  await withTimeout(
    "restore catalog search",
    () =>
      miniprogram.evaluate((fixtureToken, serializedValue) => {
        const snapshot = JSON.parse(serializedValue);
        const runtime = globalThis;
        const stateKey = "__stayFableCatalogFixtureState";
        const state =
          runtime[stateKey] ||
          (runtime[stateKey] = {
            cancelled: Object.create(null),
          });
        state.cancelled[fixtureToken] = true;
        const store = getApp().globalData.searchStore;
        return snapshot.hasValue
          ? store.set(snapshot.value)
          : store.clear();
      }, apply.token, serializedSnapshot),
    timeoutMs,
    cancellation,
  );
  cancellation.throwIfAborted();
}

function requireElement(
  container,
  selector,
  context,
  options = {},
) {
  return pollUntil(
    "required element",
    () => container.$(selector),
    (element) => element !== null && element !== undefined,
    context,
    options,
  );
}

async function waitForPage(
  miniprogram,
  expectedPath,
  rootSelector,
  context,
  options = {},
) {
  const cancellation = context || createCancellationContext();
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const timeoutMs = options.timeoutMs ?? ACTION_TIMEOUT_MS;
  return withTimeout(
    `open ${expectedPath}`,
    async () => {
      while (true) {
        cancellation.throwIfAborted();
        const page = await miniprogram.currentPage();
        cancellation.throwIfAborted();
        if (
          page &&
          page.path.replace(/^\/+/, "") === expectedPath &&
          (await page.$(rootSelector))
        ) {
          cancellation.throwIfAborted();
          const data = await page.data();
          cancellation.throwIfAborted();
          return { data, page };
        }
        await sleep(pollIntervalMs);
      }
    },
    timeoutMs,
    cancellation,
  );
}

function waitForData(
  page,
  predicate,
  label,
  context,
  options = {},
) {
  return pollUntil(
    label,
    () => page.data(),
    predicate,
    context,
    options,
  );
}

async function pollUntil(
  label,
  operation,
  predicate,
  context,
  options = {},
) {
  const cancellation = context || createCancellationContext();
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const timeoutMs = options.timeoutMs ?? ACTION_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    cancellation.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      cancellation.abort();
      throw new Error(`${label} timed out`);
    }
    const value = await withTimeout(
      label,
      operation,
      remaining,
      cancellation,
    );
    cancellation.throwIfAborted();
    if (predicate(value)) {
      return value;
    }
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
}

function waitForElementCount(
  page,
  selector,
  expectedCount,
  context,
  options = {},
) {
  return pollUntil(
    "nightly price rows",
    () => page.$$(selector),
    (rows) => Array.isArray(rows) && rows.length === expectedCount,
    context,
    options,
  );
}

function startBookingModalProbeInstall(miniprogram) {
  const token = randomUUID();
  const settled = Promise.resolve()
    .then(() =>
      miniprogram.evaluate((stateKey, probeToken) => {
        const runtime = globalThis;
        const wxApi = runtime.wx;
        if (!wxApi || typeof wxApi.showModal !== "function") {
          return false;
        }
        const state =
          runtime[stateKey] ||
          (runtime[stateKey] = {
            cancelled: Object.create(null),
            probes: Object.create(null),
          });
        if (state.cancelled[probeToken] === true) {
          return false;
        }
        const prior = state.probes[probeToken];
        if (
          prior &&
          typeof prior.original === "function" &&
          wxApi.showModal === prior.wrapped
        ) {
          wxApi.showModal = prior.original;
        }
        const original = wxApi.showModal;
        const probe = {
          latest: null,
          original,
          wrapped: null,
        };
        const wrapped = function (options) {
          const candidate =
            options && typeof options === "object" ? options : {};
          probe.latest = {
            title:
              typeof candidate.title === "string" ? candidate.title : "",
            content:
              typeof candidate.content === "string"
                ? candidate.content
                : "",
            showCancel: candidate.showCancel === true,
          };
          return Reflect.apply(original, this, arguments);
        };
        probe.wrapped = wrapped;
        state.probes[probeToken] = probe;
        wxApi.showModal = wrapped;
        return true;
      }, BOOKING_MODAL_PROBE_STATE_KEY, token),
    )
    .then((installed) => {
      if (installed !== true) {
        throw new Error("booking modal probe unavailable");
      }
      return true;
    });
  settled.catch(() => undefined);
  return { settled, token };
}

async function installBookingModalProbe(
  miniprogram,
  context,
  timeoutMs = ACTION_TIMEOUT_MS,
) {
  const cancellation = context || createCancellationContext();
  const install = startBookingModalProbeInstall(miniprogram);
  await runInteraction(
    cancellation,
    "install booking modal probe",
    () => install.settled,
    timeoutMs,
  );
  return install;
}

function readBookingModalProbe(
  miniprogram,
  install,
  context,
  timeoutMs = ACTION_TIMEOUT_MS,
) {
  const cancellation = context || createCancellationContext();
  const token = install && install.token;
  return runInteraction(
    cancellation,
    "read booking modal probe",
    () =>
      miniprogram.evaluate((stateKey, probeToken) => {
        const state = globalThis[stateKey];
        const probe = state && state.probes[probeToken];
        return probe && probe.latest ? probe.latest : null;
      }, BOOKING_MODAL_PROBE_STATE_KEY, token),
    timeoutMs,
  );
}

async function restoreBookingModalProbe(
  miniprogram,
  install,
  context,
  timeoutMs = ACTION_TIMEOUT_MS,
) {
  const cancellation = context || createCancellationContext();
  const token = install && install.token;
  await runInteraction(
    cancellation,
    "restore booking modal probe",
    () =>
      miniprogram.evaluate((stateKey, probeToken) => {
        const runtime = globalThis;
        const state =
          runtime[stateKey] ||
          (runtime[stateKey] = {
            cancelled: Object.create(null),
            probes: Object.create(null),
          });
        state.cancelled[probeToken] = true;
        const probe = state.probes[probeToken];
        if (
          probe &&
          runtime.wx &&
          runtime.wx.showModal === probe.wrapped &&
          typeof probe.original === "function"
        ) {
          runtime.wx.showModal = probe.original;
        }
        delete state.probes[probeToken];
        return true;
      }, BOOKING_MODAL_PROBE_STATE_KEY, token),
    timeoutMs,
  );
}

async function withBookingModalProbe(
  miniprogram,
  context,
  operation,
  options = {},
) {
  const install = startBookingModalProbeInstall(miniprogram);
  let primaryFailure = null;
  try {
    await runInteraction(
      context || createCancellationContext(),
      "install booking modal probe",
      () => install.settled,
      options.timeoutMs ?? ACTION_TIMEOUT_MS,
    );
    return await operation(install);
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const restoreAfterSettle = install.settled.finally(() =>
      restoreBookingModalProbe(
        miniprogram,
        install,
        createCancellationContext(),
        options.timeoutMs ?? ACTION_TIMEOUT_MS,
      ),
    );
    restoreAfterSettle.catch(() => undefined);
    try {
      await withTimeout(
        "late booking modal probe install",
        () => install.settled,
        options.lateSettleMs ??
          options.timeoutMs ??
          ACTION_TIMEOUT_MS,
      );
    } catch {
      // The token tombstone below prevents a later install from wrapping.
    }
    try {
      await restoreBookingModalProbe(
        miniprogram,
        install,
        createCancellationContext(),
        options.timeoutMs ?? ACTION_TIMEOUT_MS,
      );
    } catch (error) {
      if (primaryFailure === null) {
        throw error;
      }
    }
  }
}

function confirmBookingModal(miniprogram, context, options = {}) {
  const cancellation = context || createCancellationContext();
  return pollUntil(
    "booking modal probe",
    () =>
      readBookingModalProbe(
        miniprogram,
        options.install,
        cancellation,
        options.timeoutMs ?? ACTION_TIMEOUT_MS,
      ),
    (probe) =>
      probe !== null &&
      probe.title === BOOKING_NOTICE.title &&
      probe.content === BOOKING_NOTICE.content &&
      probe.showCancel === BOOKING_NOTICE.showCancel,
    cancellation,
    options,
  ).then(() =>
    pollUntil(
    "confirm booking notice",
    async () => {
      try {
        return {
          confirmed: true,
          value: await miniprogram.native().confirmModal(),
        };
      } catch {
        return { confirmed: false };
      }
    },
    (result) => result.confirmed,
      cancellation,
    options,
    ).then((result) => result.value),
  );
}

function assertSafeEvidence(source) {
  const normalized = String(source).toLowerCase();
  for (const marker of UNSAFE_EVIDENCE_MARKERS) {
    assert.equal(
      normalized.includes(marker),
      false,
      "sensitive marker found in page evidence",
    );
  }
}

function relativeEvidencePath(evidenceRoot, filePath) {
  const relative = path.relative(evidenceRoot, filePath);
  assert.equal(isWithin(evidenceRoot, filePath), true);
  return relative.split(path.sep).join("/");
}

async function publishTempFile(
  temporaryPath,
  filePath,
  context,
) {
  context.throwIfAborted();
  let linked = false;
  try {
    await link(temporaryPath, filePath);
    linked = true;
    context.throwIfAborted();
  } catch (error) {
    if (linked) {
      await rm(filePath, { force: true });
    }
    throw error;
  }
}

async function bestEffortRemove(
  filePath,
  removeFile = rm,
  attempts = 3,
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await removeFile(filePath, { force: true });
      return;
    } catch (error) {
      if (
        !["EBUSY", "EPERM"].includes(error?.code) ||
        attempt === attempts - 1
      ) {
        return;
      }
      await sleep(10);
    }
  }
}

async function writeTree(
  evidenceRoot,
  evidenceParent,
  name,
  source,
  evidencePaths,
  context,
) {
  assertSafeEvidence(source);
  const filePath = path.join(evidenceRoot, `${name}.tree.wxml`);
  const temporaryPath = path.join(
    evidenceRoot,
    `.${name}.${randomUUID()}.tmp`,
  );
  context.throwIfAborted();
  try {
    await writeFile(temporaryPath, source, {
      encoding: "utf8",
      flag: "wx",
    });
    context.throwIfAborted();
    await publishTempFile(temporaryPath, filePath, context);
    evidencePaths.push(relativeEvidencePath(evidenceParent, filePath));
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function capturePage(
  miniprogram,
  page,
  rootSelector,
  evidenceRoot,
  name,
  evidencePaths,
  context,
  options = {},
) {
  const cancellation = context || createCancellationContext();
  const evidenceParent = options.evidenceParent || evidenceRoot;
  const removeFile = options.removeFile || rm;
  const timeoutMs = options.timeoutMs ?? ACTION_TIMEOUT_MS;
  cancellation.throwIfAborted();
  const root = await requireElement(page, rootSelector, cancellation);
  cancellation.throwIfAborted();
  const tree = await withTimeout(
    `${name} page tree`,
    () => root.outerWxml(),
    timeoutMs,
    cancellation,
  );
  cancellation.throwIfAborted();
  await writeTree(
    evidenceRoot,
    evidenceParent,
    name,
    tree,
    evidencePaths,
    cancellation,
  );

  const screenshotPath = path.join(evidenceRoot, `${name}.png`);
  const temporaryPath = path.join(
    evidenceRoot,
    `.${name}.${randomUUID()}.tmp`,
  );
  cancellation.throwIfAborted();
  const screenshot = Promise.resolve().then(() =>
    miniprogram.screenshot({ path: temporaryPath }),
  );
  let screenshotCompleted = false;
  try {
    await withTimeout(
      `${name} screenshot`,
      () => screenshot,
      timeoutMs,
      cancellation,
    );
    screenshotCompleted = true;
    cancellation.throwIfAborted();
    await publishTempFile(temporaryPath, screenshotPath, cancellation);
    evidencePaths.push(
      relativeEvidencePath(evidenceParent, screenshotPath),
    );
  } catch (error) {
    if (!screenshotCompleted) {
      screenshot
        .finally(() => bestEffortRemove(temporaryPath, removeFile))
        .catch(() => undefined);
    }
    await bestEffortRemove(temporaryPath, removeFile);
    throw error;
  } finally {
    if (screenshotCompleted) {
      await bestEffortRemove(temporaryPath, removeFile);
    }
  }
}

async function captureComponent(
  component,
  evidenceRoot,
  name,
  evidencePaths,
  context,
  options = {},
) {
  const cancellation = context || createCancellationContext();
  const tree = await withTimeout(
    `${name} component tree`,
    () => component.wxml(),
    options.timeoutMs ?? ACTION_TIMEOUT_MS,
    cancellation,
  );
  cancellation.throwIfAborted();
  await writeTree(
    evidenceRoot,
    options.evidenceParent || evidenceRoot,
    name,
    tree,
    evidencePaths,
    cancellation,
  );
}

async function filterElement(page, type, context) {
  const filters = await runInteraction(context, "catalog filters", () =>
    page.$$(FILTER_SELECTOR),
  );
  for (const filter of filters) {
    const filterType = await runInteraction(
      context,
      "catalog filter type",
      () => filter.attribute("data-type"),
    );
    if (filterType === type) {
      return filter;
    }
  }
  return null;
}

function safeSearchSnapshot(search) {
  assert.ok(search && typeof search === "object");
  assert.ok(search.city && typeof search.city === "object");
  const snapshot = {
    city: {
      id: search.city.id,
      code: search.city.code,
      name: search.city.name,
    },
    checkin: search.checkin,
    checkout: search.checkout,
    guests: search.guests,
  };
  assert.match(snapshot.checkin, DATE_PATTERN);
  assert.match(snapshot.checkout, DATE_PATTERN);
  assert.deepEqual(snapshot, CATALOG_SEARCH_FIXTURE);
  return {
    cityId: snapshot.city.id,
    cityCode: search.city.code,
    cityName: search.city.name,
    checkin: search.checkin,
    checkout: search.checkout,
    guests: search.guests,
  };
}

function assertPropertyOnlyItems(items) {
  assert.ok(Array.isArray(items) && items.length > 0);
  for (const item of items) {
    assert.ok(item && typeof item === "object");
    assert.equal(typeof item.id, "string");
    for (const forbidden of [
      "room_types",
      "roomTypes",
      "nightly_prices",
      "nightlyPrices",
    ]) {
      assert.equal(Object.prototype.hasOwnProperty.call(item, forbidden), false);
    }
  }
}

async function catalogWorkflow(
  miniprogram,
  artifact,
  stepTracker,
  context,
) {
  const { evidenceParent, evidencePaths, evidenceRoot } = artifact;
  let current = await waitForPage(
    miniprogram,
    "pages/home/home",
    HOME_SELECTOR,
    context,
  );
  assert.equal(current.data.status, "ready");
  const expectedSearch = safeSearchSnapshot(current.data.search);
  await capturePage(
    miniprogram,
    current.page,
    HOME_SELECTOR,
    evidenceRoot,
    "01-home-ready",
    evidencePaths,
    context,
    { evidenceParent },
  );

  const searchAction = await requireElement(
    current.page,
    SEARCH_ACTION_SELECTOR,
    context,
  );
  await runInteraction(context, "search properties", () =>
    searchAction.tap(),
  );
  stepTracker.enter("property-list");
  current = await waitForPage(
    miniprogram,
    "pages/property-list/property-list",
    PROPERTY_LIST_SELECTOR,
    context,
  );
  current.data = await waitForData(
    current.page,
    (data) => data.status === "list",
    "property list data",
    context,
  );
  assertPropertyOnlyItems(current.data.items);
  assert.equal(
    await runInteraction(context, "room card absence", () =>
      current.page.$(".room-card"),
    ),
    null,
  );
  await requireElement(current.page, PROPERTY_RESULTS_SELECTOR, context);
  await capturePage(
    miniprogram,
    current.page,
    PROPERTY_LIST_SELECTOR,
    evidenceRoot,
    "02-property-list-all",
    evidencePaths,
    context,
    { evidenceParent },
  );

  const homestay = await filterElement(
    current.page,
    HOMESTAY_TYPE,
    context,
  );
  assert.ok(homestay, "HOMESTAY filter missing");
  stepTracker.enter("homestay-filter");
  await runInteraction(context, "select HOMESTAY", () => homestay.tap());
  current.data = await waitForData(
    current.page,
    (data) => data.activeType === HOMESTAY_TYPE && data.status === "list",
    "HOMESTAY results",
    context,
  );
  assertPropertyOnlyItems(current.data.items);
  assert.ok(current.data.items.every((item) => item.type === HOMESTAY_TYPE));
  await capturePage(
    miniprogram,
    current.page,
    PROPERTY_LIST_SELECTOR,
    evidenceRoot,
    "03-property-list-homestay",
    evidencePaths,
    context,
    { evidenceParent },
  );

  const all = await filterElement(current.page, "", context);
  assert.ok(all, "all-properties filter missing");
  stepTracker.enter("restore-all");
  await runInteraction(context, "restore all properties", () => all.tap());
  current.data = await waitForData(
    current.page,
    (data) => data.activeType === "" && data.status === "list",
    "restored property results",
    context,
  );
  assertPropertyOnlyItems(current.data.items);

  const propertyCards = await runInteraction(context, "property cards", () =>
    current.page.$$(PROPERTY_CARD_SELECTOR),
  );
  assert.ok(propertyCards.length > 0, "property card missing");
  const propertyCard = propertyCards[0];
  await captureComponent(
    propertyCard,
    evidenceRoot,
    "04-first-property-card",
    evidencePaths,
    context,
    { evidenceParent },
  );
  const propertyAction = await runInteraction(
    context,
    "property card action",
    () => propertyCard.$(PROPERTY_CARD_ACTION_SELECTOR),
  );
  assert.ok(propertyAction, "property card action missing");
  await runInteraction(context, "open property", () =>
    propertyAction.tap(),
  );

  stepTracker.enter("property-detail");
  current = await waitForPage(
    miniprogram,
    "pages/property-detail/property-detail",
    PROPERTY_DETAIL_SELECTOR,
    context,
  );
  current.data = await waitForData(
    current.page,
    (data) => data.status === "success" && data.property !== null,
    "property detail data",
    context,
  );
  assert.ok(current.data.property.roomTypes.length > 0);
  await capturePage(
    miniprogram,
    current.page,
    PROPERTY_DETAIL_SELECTOR,
    evidenceRoot,
    "05-property-detail",
    evidencePaths,
    context,
    { evidenceParent },
  );

  const roomAction = await requireElement(
    current.page,
    ROOM_ACTION_SELECTOR,
    context,
  );
  await runInteraction(context, "open room", () => roomAction.tap());
  stepTracker.enter("room-detail");
  current = await waitForPage(
    miniprogram,
    "pages/room-detail/room-detail",
    ROOM_DETAIL_SELECTOR,
    context,
  );
  current.data = await waitForData(
    current.page,
    (data) => data.status === "success" && data.roomType !== null,
    "room detail data",
    context,
  );
  assert.ok(current.data.roomType.nightlyPrices.length > 0);
  const nightlyRows = await waitForElementCount(
    current.page,
    NIGHTLY_PRICE_SELECTOR,
    current.data.roomType.nightlyPrices.length,
    context,
  );
  assert.equal(nightlyRows.length, current.data.roomType.nightlyPrices.length);
  const bookingHint = await requireElement(
    current.page,
    BOOKING_HINT_SELECTOR,
    context,
  );
  assert.match(
    await runInteraction(context, "booking hint text", () =>
      bookingHint.text(),
    ),
    /下一切片/,
  );
  await capturePage(
    miniprogram,
    current.page,
    ROOM_DETAIL_SELECTOR,
    evidenceRoot,
    "06-room-detail",
    evidencePaths,
    context,
    { evidenceParent },
  );

  const roomSelection = await requireElement(
    current.page,
    ROOM_SELECTION_SELECTOR,
    context,
  );
  stepTracker.enter("booking-notice");
  await withBookingModalProbe(miniprogram, context, async (install) => {
    await runInteraction(context, "show booking notice", () =>
      roomSelection.tap(),
    );
    await confirmBookingModal(miniprogram, context, { install });
  });

  stepTracker.enter("return-to-list");
  await runInteraction(context, "return to property", () =>
    miniprogram.navigateBack(),
  );
  await waitForPage(
    miniprogram,
    "pages/property-detail/property-detail",
    PROPERTY_DETAIL_SELECTOR,
    context,
  );
  await runInteraction(context, "return to list", () =>
    miniprogram.navigateBack(),
  );
  current = await waitForPage(
    miniprogram,
    "pages/property-list/property-list",
    PROPERTY_LIST_SELECTOR,
    context,
  );
  const restoredSearch = await runInteraction(
    context,
    "read restored search",
    () =>
    miniprogram.evaluate(() => {
      const search = getApp().globalData.searchStore.get();
      return {
        cityId: search.city.id,
        cityCode: search.city.code,
        cityName: search.city.name,
        checkin: search.checkin,
        checkout: search.checkout,
        guests: search.guests,
      };
    }),
  );
  assert.deepEqual(restoredSearch, expectedSearch);
  assert.equal(current.data.searchSummary.cityLabel, expectedSearch.cityName);
  assert.equal(current.data.searchSummary.guestsLabel, "3人");
  assert.equal(
    current.data.searchSummary.dateLabel,
    `${expectedSearch.checkin} 至 ${expectedSearch.checkout}`,
  );
  await capturePage(
    miniprogram,
    current.page,
    PROPERTY_LIST_SELECTOR,
    evidenceRoot,
    "08-returned-property-list",
    evidencePaths,
    context,
    { evidenceParent },
  );

  return {
    city: expectedSearch.cityName,
    checkin: expectedSearch.checkin,
    checkout: expectedSearch.checkout,
    guests: expectedSearch.guests,
    propertyCount: current.data.items.length,
    bookingModalConfirmed: true,
    evidencePaths,
  };
}

async function run(
  projectPath,
  evidenceDirectory,
  cliPath,
  dependencies = {},
) {
  const evidencePaths = [];
  const stepTracker = createStepTracker();
  const timeouts = {
    actionMs: dependencies.timeouts?.actionMs ?? ACTION_TIMEOUT_MS,
    closeMs: dependencies.timeouts?.closeMs ?? ACTION_TIMEOUT_MS,
    evidenceMs:
      dependencies.timeouts?.evidenceMs ?? ACTION_TIMEOUT_MS,
    lateSettleMs:
      dependencies.timeouts?.lateSettleMs ?? ACTION_TIMEOUT_MS,
    workflowMs:
      dependencies.timeouts?.workflowMs ?? WORKFLOW_TIMEOUT_MS,
  };
  let projectRoot;
  let evidenceParent;
  let evidenceRoot;
  let launchOptions;
  try {
    assert.ok(
      path.isAbsolute(projectPath || ""),
      "absolute projectPath is required",
    );
    assert.ok(evidenceDirectory, "evidenceDirectory is required");
    projectRoot = await realpath(projectPath);
    launchOptions = buildLaunchOptions(
      projectRoot,
      cliPath,
      dependencies.environment || process.env,
    );
    const requestedEvidenceRoot = path.resolve(evidenceDirectory);
    assert.equal(
      isWithin(projectRoot, requestedEvidenceRoot),
      false,
      "evidenceDirectory must be outside the mini-program project",
    );
    await mkdir(requestedEvidenceRoot, { recursive: true });
    evidenceParent = await realpath(requestedEvidenceRoot);
    assert.equal(
      isWithin(projectRoot, evidenceParent),
      false,
      "evidenceDirectory must be outside the mini-program project",
    );
    evidenceRoot = await mkdtemp(
      path.join(evidenceParent, "catalog-"),
    );
    evidenceRoot = await realpath(evidenceRoot);
  } catch {
    throw catalogFailure("arguments", "unknown", evidencePaths);
  }
  const artifact = { evidenceParent, evidencePaths, evidenceRoot };
  let miniprogram;
  try {
    const automatorApi =
      dependencies.automatorApi ||
      selectDefaultAutomatorApi(automator, launchOptions, {
        ...dependencies.windowsLauncher,
        environment: dependencies.environment || process.env,
      });
    miniprogram = await launchMiniProgram(
      automatorApi,
      launchOptions,
    );
  } catch {
    if (evidencePaths.length === 0) {
      try {
        await rmdir(evidenceRoot);
      } catch {
        // Launch failure remains the safe public result.
      }
    }
    throw catalogFailure("launch", "unknown", evidencePaths);
  }
  let result;
  let failure = null;
  let currentPage = "unknown";
  let originalSearch;
  let fixtureApply;
  const workflowContext = createCancellationContext();
  try {
    stepTracker.enter("fixture");
    originalSearch = await prepareCatalogHome(
      miniprogram,
      workflowContext,
      {
        onOriginal(original) {
          originalSearch = original;
        },
        onApply(apply) {
          fixtureApply = apply;
        },
        timeoutMs: timeouts.actionMs,
      },
    );
    stepTracker.enter("home");
    const workflow = dependencies.workflow || catalogWorkflow;
    result = await withTimeout(
      "catalog workflow",
      () =>
        workflow(
          miniprogram,
          artifact,
          stepTracker,
          workflowContext,
        ),
      timeouts.workflowMs,
      workflowContext,
    );
    workflowContext.throwIfAborted();
  } catch {
    workflowContext.abort();
    const evidenceContext = createCancellationContext();
    try {
      await withTimeout(
        "failure evidence",
        async () => {
          evidenceContext.throwIfAborted();
          const page = await miniprogram.currentPage();
          evidenceContext.throwIfAborted();
          currentPage = safePageRoute(page && page.path);
          if (page) {
            let root = null;
            for (const selector of [
              ROOM_DETAIL_SELECTOR,
              PROPERTY_DETAIL_SELECTOR,
              PROPERTY_LIST_SELECTOR,
              HOME_SELECTOR,
            ]) {
              evidenceContext.throwIfAborted();
              root = await page.$(selector);
              evidenceContext.throwIfAborted();
              if (root) {
                break;
              }
            }
            if (root) {
              const rootClass = await root.attribute("class");
              evidenceContext.throwIfAborted();
              await capturePage(
                miniprogram,
                page,
                `.${rootClass.split(/\s+/)[0]}`,
                evidenceRoot,
                "99-failure",
                evidencePaths,
                evidenceContext,
                {
                  evidenceParent,
                  timeoutMs: timeouts.evidenceMs,
                },
              );
            }
          }
        },
        timeouts.evidenceMs,
        evidenceContext,
      );
    } catch {
      evidenceContext.abort();
      // A failed evidence capture must not mask the workflow failure.
    }
    failure = catalogFailure(
      stepTracker.step,
      currentPage,
      evidencePaths,
    );
  }
  let tombstoneRestored =
    originalSearch === undefined || fixtureApply === undefined;
  if (originalSearch !== undefined && fixtureApply !== undefined) {
    let restoreQueue = Promise.resolve();
    const restoreOriginalSearch = () => {
      const restoration = restoreQueue.then(() =>
        restoreCatalogSearch(
          miniprogram,
          fixtureApply,
          originalSearch,
          createCancellationContext(),
          timeouts.actionMs,
        ),
      );
      restoreQueue = restoration.catch(() => undefined);
      return restoration;
    };
    try {
      await restoreOriginalSearch();
      tombstoneRestored = true;
    } catch {
      // A second bounded restore attempt follows after apply settlement.
    }
    try {
      await withTimeout(
        "late fixture apply",
        () => fixtureApply.settled,
        timeouts.lateSettleMs,
      );
    } catch {
      // The successful tombstone restore prevents a queued apply from writing.
    }
    try {
      await restoreOriginalSearch();
      tombstoneRestored = true;
    } catch {
      // A prior successful restore already made this fixture token harmless.
    }
  }
  if (!tombstoneRestored) {
    failure = catalogFailure("cleanup", currentPage, evidencePaths);
  }
  try {
    await closeMiniProgram(miniprogram, timeouts.closeMs);
  } catch {
    if (failure === null) {
      failure = catalogFailure("cleanup", currentPage, evidencePaths);
    }
  }
  if (failure !== null) {
    throw failure;
  }
  return result;
}

if (require.main === module) {
  let cliArguments;
  try {
    cliArguments = parseCliArguments(process.argv.slice(2));
  } catch (error) {
    console.error(
      JSON.stringify({
        status: "fail",
        message: error.message,
        step: "arguments",
        currentPage: "unknown",
        evidencePaths: [],
      }),
    );
    process.exitCode = 1;
  }
  const execution = cliArguments
    ? run(
        cliArguments.projectPath,
        cliArguments.evidenceDirectory,
        cliArguments.cliPath,
      )
    : Promise.resolve();
  execution
    .then((result) =>
      result
        ? console.log(JSON.stringify({ status: "pass", ...result }))
        : undefined,
    )
    .catch((error) => {
      console.error(JSON.stringify(formatCatalogFailure(error)));
      process.exitCode = 1;
    });
}

module.exports = {
  CATALOG_SEARCH_FIXTURE,
  buildLaunchOptions,
  closeMiniProgram,
  createCancellationContext,
  launchMiniProgram,
  parseCliArguments,
  prepareCatalogHome,
  restoreCatalogSearch,
  requireElement,
  run,
  waitForData,
  waitForPage,
  capturePage,
  confirmBookingModal,
  installBookingModalProbe,
  launchWindowsBatchMiniProgram,
  restoreBookingModalProbe,
  resolveWindowsCliRuntime,
  selectDefaultAutomatorApi,
  withBookingModalProbe,
  formatCatalogFailure,
  publishTempFile,
  waitForElementCount,
};

import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
let lifecycle = {};
try {
  lifecycle = require("../automator/slice-5-booking-lifecycle.js");
} catch {}

const COMMIT = "1".repeat(40);
const WX_TREE = "2".repeat(40);
const EXECUTION_DATE = "2026-07-30";
const START = "2026-07-31";
const END = "2026-08-02";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function pngChunkData(bytes, wantedType) {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === wantedType) {
      return Buffer.from(bytes.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }
  throw new Error(`missing ${wantedType}`);
}

const UNDECODABLE_PNG = Buffer.concat([
  PNG.subarray(0, 8),
  PNG.subarray(8, 33),
  pngChunk("IDAT", deflateSync(Buffer.from([5, 0, 0]))),
  pngChunk("IEND", Buffer.alloc(0)),
]);
const PNG_IHDR = pngChunkData(PNG, "IHDR");
const PNG_IDAT = pngChunkData(PNG, "IDAT");
const PNG_SIGNATURE = PNG.subarray(0, 8);
const PNG_IEND = pngChunk("IEND", Buffer.alloc(0));
const INDEXED_IHDR = Buffer.from(PNG_IHDR);
INDEXED_IHDR[8] = 8;
INDEXED_IHDR[9] = 3;
const PNG_WITHOUT_PLTE = Buffer.concat([
  PNG_SIGNATURE,
  pngChunk("IHDR", INDEXED_IHDR),
  pngChunk("IDAT", deflateSync(Buffer.from([0, 0]))),
  PNG_IEND,
]);
const PNG_WITH_UNKNOWN_CRITICAL = Buffer.concat([
  PNG_SIGNATURE,
  pngChunk("IHDR", PNG_IHDR),
  pngChunk("ABCD", Buffer.alloc(0)),
  pngChunk("IDAT", PNG_IDAT),
  PNG_IEND,
]);
const PNG_WITH_DUPLICATE_IHDR = Buffer.concat([
  PNG_SIGNATURE,
  pngChunk("IHDR", PNG_IHDR),
  pngChunk("IHDR", PNG_IHDR),
  pngChunk("IDAT", PNG_IDAT),
  PNG_IEND,
]);
const PNG_WITH_SPLIT_IDAT = Buffer.concat([
  PNG_SIGNATURE,
  pngChunk("IHDR", PNG_IHDR),
  pngChunk("IDAT", PNG_IDAT.subarray(0, 2)),
  pngChunk("tEXt", Buffer.from("safe")),
  pngChunk("IDAT", PNG_IDAT.subarray(2)),
  PNG_IEND,
]);
const SHALLOW_INDEXED_IHDR = Buffer.from(INDEXED_IHDR);
SHALLOW_INDEXED_IHDR[8] = 1;
const PNG_WITH_OVERSIZED_PLTE = Buffer.concat([
  PNG_SIGNATURE,
  pngChunk("IHDR", SHALLOW_INDEXED_IHDR),
  pngChunk("PLTE", Buffer.alloc(9)),
  pngChunk("IDAT", deflateSync(Buffer.from([0, 0]))),
  PNG_IEND,
]);
const PNG_WITH_ZLIB_TRAILING_BYTES = Buffer.concat([
  PNG_SIGNATURE,
  pngChunk("IHDR", PNG_IHDR),
  pngChunk("IDAT", Buffer.concat([PNG_IDAT, Buffer.from("trailing")])),
  PNG_IEND,
]);

function postLedger(overrides = {}) {
  const counts = {
    quote: 1,
    booking: 2,
    paymentFailure: 3,
    paymentSuccess: 4,
    cancel: 5,
    ...(overrides.counts || {}),
  };
  return {
    schemaVersion: 1,
    candidate: { commit: COMMIT, wxTree: WX_TREE },
    executionDate: EXECUTION_DATE,
    revision: 1,
    totalPosts: Object.values(counts).reduce((sum, value) => sum + value, 0),
    unknownPosts: 0,
    counts,
    paymentRetry: {
      outcome: "SUCCEED",
      attempts: 1,
      sameScope: true,
      sameCredential: true,
    },
    ...overrides,
    counts,
  };
}
const temporaryRoots = [];

async function temporaryDirectories() {
  const root = await mkdtemp(path.join(tmpdir(), "stay-fable-slice5-test-"));
  temporaryRoots.push(root);
  return {
    temporaryDirectory: path.join(root, "temporary"),
    evidenceDirectory: path.join(root, "evidence"),
  };
}

function options(directories, overrides = {}) {
  return {
    candidate: { commit: COMMIT, wxTree: WX_TREE },
    preflight: {
      schemaVersion: 1,
      status: "READY",
      reason: "PREFLIGHT_READY",
      candidate: { commit: COMMIT, wxTree: WX_TREE },
      seedWindow: { start: START, end: END },
      executionBoundary: {
        state: "READ_ONLY_PREFLIGHT",
        interactionStarted: false,
      },
    },
    executionDate: EXECUTION_DATE,
    toolVersion: "0.3.5",
    timeoutMs: 500,
    ...directories,
    ...overrides,
  };
}

async function runCliWithLaunchProbe(
  directories,
  { ledgerContents, runnerOptions = options(directories) },
) {
  await mkdir(directories.temporaryDirectory, { recursive: true });
  const optionsPath = path.join(
    directories.temporaryDirectory,
    "run-options.json",
  );
  const ledgerPath = path.join(directories.temporaryDirectory, "ledger.json");
  const preloadPath = path.join(
    directories.temporaryDirectory,
    "launch-probe.cjs",
  );
  const launchLogPath = path.join(
    directories.temporaryDirectory,
    "launch-count.log",
  );
  await Promise.all([
    writeFile(optionsPath, JSON.stringify(runnerOptions)),
    writeFile(
      ledgerPath,
      typeof ledgerContents === "string"
        ? ledgerContents
        : JSON.stringify(ledgerContents),
    ),
    writeFile(
      preloadPath,
      [
        'const fs = require("node:fs");',
        'const Module = require("node:module");',
        "const originalLoad = Module._load;",
        "Module._load = function (request, parent, isMain) {",
        '  if (request === "miniprogram-automator") {',
        "    return {",
        "      launch: async function () {",
        '        fs.appendFileSync(process.env.STAY_FABLE_LAUNCH_LOG, "launch\\n");',
        '        throw new Error("unexpected Automator launch");',
        "      },",
        "    };",
        "  }",
        "  return originalLoad.call(this, request, parent, isMain);",
        "};",
      ].join("\n"),
    ),
  ]);
  const execution = spawnSync(
    process.execPath,
    [
      "--require",
      preloadPath,
      path.resolve("wx/automator/slice-5-booking-lifecycle.js"),
      "--run-options",
      optionsPath,
      "--post-ledger",
      ledgerPath,
      "--cli-path",
      "C:\\WeChatDevTools\\cli.bat",
      "--project-path",
      path.resolve("wx"),
    ],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        STAY_FABLE_LAUNCH_LOG: launchLogPath,
      },
    },
  );
  let launchCount = 0;
  try {
    launchCount = (await readFile(launchLogPath, "utf8"))
      .split("\n")
      .filter(Boolean).length;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { execution, launchCount };
}

function evidenceManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    candidate: { commit: COMMIT, wxTree: WX_TREE },
    executionDate: EXECUTION_DATE,
    seedWindow: { start: START, end: END },
    toolVersion: "0.3.5",
    steps: Array.from({ length: 10 }, (_, index) => ({
      number: index + 1,
      status: "PASS",
    })),
    postDeltas: [
      { action: "quote:first", delta: { quote: 1 } },
      { action: "booking:first", delta: { booking: 1 } },
      { action: "payment:failure", delta: { paymentFailure: 1 } },
      { action: "payment:success", delta: { paymentSuccess: 1 } },
      { action: "orders:refresh", delta: {} },
      { action: "quote:second", delta: { quote: 1 } },
      { action: "booking:second", delta: { booking: 1 } },
      { action: "cancel:second", delta: { cancel: 1 } },
    ],
    cleanup: "CLOSED",
    ...overrides,
  };
}

function createPhysicalFake(overrides = {}) {
  let page = "pages/home/home";
  let quoteCount = 0;
  let bookingCount = 0;
  let orderOpenCount = 0;
  const counts = {
    quote: 0,
    booking: 0,
    paymentFailure: 0,
    paymentSuccess: 0,
    cancel: 0,
  };
  const operations = [];
  const transition = {
    ".field-row#1": "pages/date-guest-select/date-guest-select",
    ".save-button": "pages/home/home",
    ".search-button": "pages/property-list/property-list",
    ".property-card__tap-target": "pages/property-detail/property-detail",
    ".room-card__action": "pages/room-detail/room-detail",
    ".selection-bar__action": "pages/booking-confirm/booking-confirm",
    ".action-bar__button": "pages/booking-confirm/booking-confirm",
    ".created-card__action--primary": "pages/order-detail/order-detail",
    '[data-action="MOCK_PAY_FAILURE"]': "pages/order-detail/order-detail",
    '[data-action="MOCK_PAY_SUCCESS"]': "pages/order-detail/order-detail",
    '[data-action="CANCEL"]': "pages/order-detail/order-detail",
    '[aria-label="订单"]': "pages/order-list/order-list",
    '[aria-label="首页"]': "pages/home/home",
    ".order-row__action": "pages/order-detail/order-detail",
  };
  const session = {
    currentPage: vi.fn(async () => page),
    input: vi.fn(async ({ selector, index, value }) => {
      operations.push({ action: "input", selector, index, value });
    }),
    tap: vi.fn(async ({
      selector,
      index,
      outcome,
      scope,
      surface = "page",
    }) => {
      const key = index === undefined ? selector : `${selector}#${index}`;
      operations.push({
        action: "tap",
        selector,
        index,
        ...(outcome === undefined ? {} : { outcome }),
        ...(scope === undefined ? {} : { scope }),
        surface,
      });
      if (overrides.failSelector === selector) {
        const error = new Error("physical action failed");
        error.code = overrides.failCode ?? "AUTOMATOR_ACTION_FAILED";
        throw error;
      }
      if (selector === ".selection-bar__action") {
        counts.quote += 1;
        quoteCount += 1;
      } else if (selector === ".action-bar__button") {
        counts.booking += 1;
        bookingCount += 1;
      } else if (selector === '[data-action="MOCK_PAY_FAILURE"]') {
        counts.paymentFailure += 1;
      } else if (selector === '[data-action="MOCK_PAY_SUCCESS"]') {
        counts.paymentSuccess += 1;
      } else if (selector === '[data-action="CANCEL"]') {
        counts.cancel += 1;
      } else if (selector === ".order-row__action") {
        orderOpenCount += 1;
      }
      page = transition[key] ?? transition[selector] ?? page;
    }),
    readPostCounts: vi.fn(async () => ({ ...counts })),
    readVisibleText: vi.fn(async (selector) => {
      if (selector === ".summary-card__status") {
        if (counts.cancel === 1) return "已取消";
        if (counts.paymentSuccess === 1) return "已确认";
        return "待支付";
      }
      return "";
    }),
    readPaymentContinuity: vi.fn(async () => ({
      sameScope: true,
      sameCredential: true,
    })),
    captureScreenshot: vi.fn(async ({ name }) => ({
      name,
      bytes: PNG,
      visibleText: name === "confirmed" ? "订单已确认" : "订单已取消",
    })),
    close: vi.fn(async () => {}),
  };
  return {
    launch: vi.fn(async () => ({ id: "physical-launch" })),
    connect: vi.fn(async () => session),
    session,
    counts,
    operations,
    get quoteCount() {
      return quoteCount;
    },
    get bookingCount() {
      return bookingCount;
    },
    get orderOpenCount() {
      return orderOpenCount;
    },
  };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
  vi.useRealTimers();
});

describe("Slice 5 physical booking lifecycle Automator", () => {
  it("exports only the physical runner and safe evidence writer", () => {
    expect(Object.keys(lifecycle)).toEqual([
      "runBookingLifecycle",
      "writeSafeEvidence",
    ]);
    expect(lifecycle.createMiniprogramAutomatorDependencies).toBeUndefined();
  });

  it("rejects mismatched, unknown, and arithmetically invalid CLI ledgers before SDK launch", async () => {
    for (const ledgerContents of [
      postLedger({
        candidate: { commit: "3".repeat(40), wxTree: WX_TREE },
      }),
      postLedger({ executionDate: "2026-07-31" }),
      postLedger({ unknownPosts: 1 }),
      postLedger({ totalPosts: 999 }),
      postLedger({
        paymentRetry: {
          outcome: "FAIL",
          attempts: 2,
          sameScope: true,
          sameCredential: true,
        },
      }),
    ]) {
      const directories = await temporaryDirectories();
      const { execution, launchCount } = await runCliWithLaunchProbe(
        directories,
        { ledgerContents },
      );

      expect(execution.status).toBe(1);
      expect(JSON.parse(execution.stdout)).toEqual({
        schemaVersion: 1,
        status: "BLOCKED_AUTOMATOR_RC",
        reason: "POST_LEDGER_UNAVAILABLE",
      });
      expect(execution.stderr).toBe("");
      expect(launchCount).toBe(0);
    }
  });

  it("blocks a valid CLI ledger on unavailable picker before captured SDK launch", async () => {
    const directories = await temporaryDirectories();
    const { execution, launchCount } = await runCliWithLaunchProbe(
      directories,
      { ledgerContents: postLedger() },
    );

    expect(execution.status).toBe(1);
    expect(JSON.parse(execution.stdout)).toEqual({
      schemaVersion: 1,
      status: "BLOCKED_AUTOMATOR_RC",
      reason: "PICKER_PHYSICAL_UNAVAILABLE",
    });
    expect(execution.stderr).toBe("");
    expect(launchCount).toBe(0);
  });

  it("blocks malformed and partial CLI ledgers before captured SDK launch", async () => {
    const valid = JSON.stringify(postLedger());
    for (const ledgerContents of [
      '{"quote":0',
      valid.replace(`"revision":1`, `"revision":1,"revision":1`),
      `${valid}${" ".repeat(70_000)}`,
    ]) {
      const directories = await temporaryDirectories();
      const { execution, launchCount } = await runCliWithLaunchProbe(
        directories,
        { ledgerContents },
      );

      expect(execution.status).toBe(1);
      expect(JSON.parse(execution.stdout)).toEqual({
        schemaVersion: 1,
        status: "BLOCKED_AUTOMATOR_RC",
        reason: "POST_LEDGER_UNAVAILABLE",
      });
      expect(execution.stderr).toBe("");
      expect(launchCount).toBe(0);
    }
  });

  it("runs the real CLI entry path and blocks unsupported picker before IDE launch", async () => {
    const directories = await temporaryDirectories();
    await mkdir(directories.temporaryDirectory, { recursive: true });
    const optionsPath = path.join(
      directories.temporaryDirectory,
      "run-options.json",
    );
    const ledgerPath = path.join(
      directories.temporaryDirectory,
      "ledger.json",
    );
    await writeFile(optionsPath, JSON.stringify(options(directories)));
    await writeFile(ledgerPath, JSON.stringify(postLedger()));
    const execution = spawnSync(
      process.execPath,
      [
        path.resolve("wx/automator/slice-5-booking-lifecycle.js"),
        "--run-options",
        optionsPath,
        "--post-ledger",
        ledgerPath,
        "--cli-path",
        "C:\\WeChatDevTools\\cli.bat",
        "--project-path",
        path.resolve("wx"),
      ],
      { cwd: path.resolve("."), encoding: "utf8", timeout: 10_000 },
    );

    expect(execution.status).toBe(1);
    expect(JSON.parse(execution.stdout)).toEqual({
      schemaVersion: 1,
      status: "BLOCKED_AUTOMATOR_RC",
      reason: "PICKER_PHYSICAL_UNAVAILABLE",
    });
    expect(execution.stderr).toBe("");
  });

  it("rejects duplicate-key and oversized CLI JSON with one exact safe result", async () => {
    const directories = await temporaryDirectories();
    await mkdir(directories.temporaryDirectory, { recursive: true });
    const optionsPath = path.join(
      directories.temporaryDirectory,
      "run-options.json",
    );
    const ledgerPath = path.join(
      directories.temporaryDirectory,
      "ledger.json",
    );
    await writeFile(ledgerPath, JSON.stringify(postLedger()));
    const base = JSON.stringify(options(directories));
    for (const contents of [
      base.replace(
        `"commit":"${COMMIT}"`,
        `"commit":"${COMMIT}","commit":"${COMMIT}"`,
      ),
      `${base}${" ".repeat(70_000)}`,
    ]) {
      await writeFile(optionsPath, contents);
      const execution = spawnSync(
        process.execPath,
        [
          path.resolve("wx/automator/slice-5-booking-lifecycle.js"),
          "--run-options",
          optionsPath,
          "--post-ledger",
          ledgerPath,
          "--cli-path",
          "C:\\WeChatDevTools\\cli.bat",
          "--project-path",
          path.resolve("wx"),
        ],
        { cwd: path.resolve("."), encoding: "utf8", timeout: 10_000 },
      );
      expect(execution.status).toBe(1);
      expect(execution.stdout).toBe(
        `${JSON.stringify({
          schemaVersion: 1,
          status: "BLOCKED_AUTOMATOR_RC",
          reason: "AUTOMATOR_CONFIGURATION_INVALID",
        })}\n`,
      );
      expect(execution.stderr).toBe("");
    }
  });

  it("does not launch when candidate and READY preflight snapshots disagree", async () => {
    const directories = await temporaryDirectories();
    const fake = createPhysicalFake();
    const result = await lifecycle.runBookingLifecycle(
      options(directories, {
        candidate: { commit: "3".repeat(40), wxTree: WX_TREE },
      }),
      fake,
    );

    expect(result).toEqual({
      schemaVersion: 1,
      status: "BLOCKED_AUTOMATOR_RC",
      reason: "CANDIDATE_PREFLIGHT_MISMATCH",
    });
    expect(fake.launch).not.toHaveBeenCalled();
  });

  it("bounds launch and connect and closes a launched handle on connect timeout", async () => {
    const directories = await temporaryDirectories();
    const launchHandle = { close: vi.fn(async () => {}) };
    const launchTimeout = await lifecycle.runBookingLifecycle(
      options(directories, { timeoutMs: 10 }),
      {
        launch: vi.fn(() => new Promise(() => {})),
        connect: vi.fn(),
      },
    );
    expect(launchTimeout.reason).toBe("LAUNCH_TIMEOUT");

    const connectTimeout = await lifecycle.runBookingLifecycle(
      options(directories, { timeoutMs: 10 }),
      {
        launch: vi.fn(async () => launchHandle),
        connect: vi.fn(() => new Promise(() => {})),
      },
    );
    expect(connectTimeout.reason).toBe("CONNECT_TIMEOUT");
    expect(launchHandle.close).toHaveBeenCalledOnce();
  });

  it("reclaims handles that resolve after launch or connect already timed out", async () => {
    const directories = await temporaryDirectories();
    const lateLaunch = { close: vi.fn(async () => {}) };
    let resolveLaunch;
    const launchRun = lifecycle.runBookingLifecycle(
      options(directories, { timeoutMs: 10 }),
      {
        launch: vi.fn(
          () => new Promise((resolve) => {
            resolveLaunch = resolve;
          }),
        ),
        connect: vi.fn(),
      },
    );
    expect((await launchRun).reason).toBe("LAUNCH_TIMEOUT");
    resolveLaunch(lateLaunch);
    await vi.waitFor(() =>
      expect(lateLaunch.close).toHaveBeenCalledOnce(),
    );

    const lateSession = { close: vi.fn(async () => {}) };
    let resolveConnect;
    const connectRun = lifecycle.runBookingLifecycle(
      options(directories, { timeoutMs: 10 }),
      {
        launch: vi.fn(async () => ({ close: vi.fn(async () => {}) })),
        connect: vi.fn(
          () => new Promise((resolve) => {
            resolveConnect = resolve;
          }),
        ),
      },
    );
    expect((await connectRun).reason).toBe("CONNECT_TIMEOUT");
    resolveConnect(lateSession);
    await vi.waitFor(() =>
      expect(lateSession.close).toHaveBeenCalledOnce(),
    );
  });

  it("stops at the first physical failure and never attempts a later element", async () => {
    const directories = await temporaryDirectories();
    const fake = createPhysicalFake({ failSelector: ".search-button" });
    const result = await lifecycle.runBookingLifecycle(
      options(directories),
      fake,
    );

    expect(result.status).toBe("BLOCKED_AUTOMATOR_RC");
    expect(result.reason).toBe("PHYSICAL_ACTION_FAILED");
    expect(
      fake.operations.filter(
        (operation) =>
          operation.selector === ".property-card__tap-target",
      ),
    ).toHaveLength(0);
    expect(fake.session.close).toHaveBeenCalledOnce();
  });

  it("bounds terminal cleanup and never publishes PASS evidence after close stalls", async () => {
    const directories = await temporaryDirectories();
    const fake = createPhysicalFake();
    fake.session.close.mockImplementation(() => new Promise(() => {}));
    const result = await lifecycle.runBookingLifecycle(
      options(directories, { timeoutMs: 10 }),
      fake,
    );

    expect(result).toEqual({
      schemaVersion: 1,
      status: "BLOCKED_AUTOMATOR_RC",
      reason: "CLEANUP_FAILED",
    });
    await expect(readdir(directories.evidenceDirectory)).rejects.toThrow();
  });

  it("runs the ten-step lifecycle only through formal element tap and input operations", async () => {
    const directories = await temporaryDirectories();
    const fake = createPhysicalFake();
    const result = await lifecycle.runBookingLifecycle(
      options(directories),
      fake,
    );

    expect(result).toEqual({
      schemaVersion: 1,
      status: "BLOCKED_PHYSICAL_UAT",
      reason: "RUNNER_CONTRACT_ONLY",
    });
    expect(fake.operations).toContainEqual({
      action: "input",
      selector: "picker",
      index: 0,
      value: START,
    });
    expect(fake.operations).toContainEqual({
      action: "input",
      selector: "picker",
      index: 1,
      value: END,
    });
    expect(
      fake.operations.filter(
        (operation) =>
          operation.action === "tap" &&
          operation.selector === ".stepper__button" &&
          operation.index === 1,
      ),
    ).toHaveLength(2);
    expect(fake.operations).toContainEqual({
      action: "tap",
      selector: '[aria-label="订单"]',
      index: undefined,
      surface: "native-tab",
    });
    expect(fake.operations).toContainEqual({
      action: "tap",
      selector: '[aria-label="首页"]',
      index: undefined,
      surface: "native-tab",
    });
    expect(fake.quoteCount).toBe(2);
    expect(fake.bookingCount).toBe(2);
    expect(fake.orderOpenCount).toBe(1);
    expect(fake.counts).toEqual({
      quote: 2,
      booking: 2,
      paymentFailure: 1,
      paymentSuccess: 1,
      cancel: 1,
    });
    await expect(readdir(directories.evidenceDirectory)).rejects.toThrow();
    expect(JSON.stringify(result)).not.toMatch(
      /idempotency|authorization|bearer|token|uuid|key/i,
    );
    expect(fake.session.close).toHaveBeenCalledOnce();
  });

  it("stops an unknown write without retrying or starting later writes", async () => {
    const directories = await temporaryDirectories();
    const fake = createPhysicalFake({
      failSelector: '[data-action="MOCK_PAY_SUCCESS"]',
      failCode: "WRITE_OUTCOME_UNKNOWN",
    });
    const result = await lifecycle.runBookingLifecycle(
      options(directories),
      fake,
    );

    expect(result.status).toBe("FAILED_PRODUCT");
    expect(result.reason).toBe("WRITE_OUTCOME_UNKNOWN");
    expect(
      fake.operations.filter(
        (operation) =>
          operation.selector === '[data-action="MOCK_PAY_SUCCESS"]',
      ),
    ).toHaveLength(1);
    expect(fake.counts.cancel).toBe(0);
  });

  it("turns an ordinary timed-out write into terminal unknown outcome and never retries it", async () => {
    const directories = await temporaryDirectories();
    const fake = createPhysicalFake();
    const originalTap = fake.session.tap.getMockImplementation();
    let resolveWrite;
    fake.session.tap.mockImplementation(async (input) => {
      if (input.selector === ".selection-bar__action") {
        await new Promise((resolve) => {
          resolveWrite = resolve;
        });
        fake.counts.quote += 1;
        return;
      }
      return originalTap(input);
    });
    const run = lifecycle.runBookingLifecycle(
      options(directories, { timeoutMs: 20 }),
      fake,
    );
    const result = await run;
    expect(result).toMatchObject({
      status: "FAILED_PRODUCT",
      reason: "WRITE_OUTCOME_UNKNOWN",
    });
    resolveWrite?.();
    await Promise.resolve();
    expect(fake.session.tap.mock.calls.filter(
      ([value]) => value.selector === ".selection-bar__action",
    )).toHaveLength(1);
    await expect(readdir(directories.evidenceDirectory)).rejects.toThrow();
  });

  it("treats a partial ledger read after a physical write as terminal unknown", async () => {
    const directories = await temporaryDirectories();
    const fake = createPhysicalFake();
    const originalCounts =
      fake.session.readPostCounts.getMockImplementation();
    let countReads = 0;
    fake.session.readPostCounts.mockImplementation(async (input) => {
      countReads += 1;
      if (countReads === 2) {
        const error = new Error("partial atomic snapshot");
        error.code = "POST_LEDGER_UNAVAILABLE";
        throw error;
      }
      return originalCounts(input);
    });
    const result = await lifecycle.runBookingLifecycle(
      options(directories),
      fake,
    );

    expect(result).toMatchObject({
      status: "FAILED_PRODUCT",
      reason: "WRITE_OUTCOME_UNKNOWN",
    });
    expect(fake.counts.quote).toBe(1);
    expect(fake.counts.booking).toBe(0);
  });

  it("uses one explicit payment retry scope without exposing its key in evidence", async () => {
    const directories = await temporaryDirectories();
    const fake = createPhysicalFake();
    const result = await lifecycle.runBookingLifecycle(
      options(directories),
      fake,
    );
    const paymentOperations = fake.operations.filter((operation) =>
      operation.selector?.startsWith('[data-action="MOCK_PAY_'),
    );

    expect(paymentOperations).toHaveLength(2);
    expect(
      paymentOperations.map((operation) => operation.scope),
    ).toEqual([
      "MOCK_PAYMENT_FAIL",
      "MOCK_PAYMENT_SUCCEED",
    ]);
    expect(
      paymentOperations.map((operation) => operation.outcome),
    ).toEqual(["FAIL", "SUCCEED"]);
    expect(fake.session.readPaymentContinuity).toHaveBeenCalledWith({
      scope: "MOCK_PAYMENT_SUCCEED",
      attempts: 1,
      signal: expect.any(AbortSignal),
    });
    expect(result.reason).toBe("RUNNER_CONTRACT_ONLY");
    expect(JSON.stringify(result)).not.toContain("Idempotency-Key");
    expect(JSON.stringify(result)).not.toContain("idempotencyKey");
  });

  it("manually retries an unknown SUCCEED result once with the same scope and credential", async () => {
    const directories = await temporaryDirectories();
    const fake = createPhysicalFake();
    let successAttempts = 0;
    const originalTap = fake.session.tap.getMockImplementation();
    fake.session.tap.mockImplementation(async (input) => {
      if (input.selector === '[data-action="MOCK_PAY_SUCCESS"]') {
        successAttempts += 1;
        fake.operations.push({
          action: "tap",
          selector: input.selector,
          index: input.index,
          outcome: input.outcome,
          scope: input.scope,
          surface: input.surface ?? "page",
        });
        if (successAttempts === 2) fake.counts.paymentSuccess += 1;
        return;
      }
      return originalTap(input);
    });
    fake.session.readVisibleText.mockImplementation(async (selector) => {
      if (selector === ".action-notice") {
        return successAttempts === 1
          ? "支付结果待确认，请使用同一支付请求重试"
          : "";
      }
      if (selector !== ".summary-card__status") return "";
      if (fake.counts.cancel === 1) return "已取消";
      if (fake.counts.paymentSuccess === 1) return "已确认";
      return "待支付";
    });

    const result = await lifecycle.runBookingLifecycle(options(directories), fake);
    const retries = fake.operations.filter(
      (operation) =>
        operation.selector === '[data-action="MOCK_PAY_SUCCESS"]',
    );
    expect(result.reason).toBe("RUNNER_CONTRACT_ONLY");
    expect(retries).toHaveLength(2);
    expect(retries.map(({ scope }) => scope)).toEqual([
      "MOCK_PAYMENT_SUCCEED",
      "MOCK_PAYMENT_SUCCEED",
    ]);
    expect(fake.session.readPaymentContinuity).toHaveBeenCalledWith({
      scope: "MOCK_PAYMENT_SUCCEED",
      attempts: 2,
      signal: expect.any(AbortSignal),
    });
    expect(fake.session.readVisibleText).toHaveBeenCalledWith(
      ".action-notice",
      { signal: expect.any(AbortSignal) },
    );
    expect(JSON.stringify(result)).not.toMatch(/credential|key/i);
  });

  it("does not write evidence after a timed-out screenshot resolves late", async () => {
    const directories = await temporaryDirectories();
    const fake = createPhysicalFake();
    let resolveScreenshot;
    fake.session.captureScreenshot.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveScreenshot = resolve;
        }),
    );
    const run = lifecycle.runBookingLifecycle(
      options(directories, { timeoutMs: 100 }),
      fake,
    );
    const result = await run;
    resolveScreenshot?.({
      name: "confirmed",
      bytes: PNG,
      visibleText: "订单已确认",
    });
    await Promise.resolve();

    expect(result.reason).toBe("EVIDENCE_CAPTURE_TIMEOUT");
    await expect(readdir(directories.evidenceDirectory)).rejects.toThrow();
    expect(fake.session.close).toHaveBeenCalledOnce();
  });

  it("does not allow an injected writer to publish after runner failure", async () => {
    const directories = await temporaryDirectories();
    const fake = createPhysicalFake();
    const injected = vi.fn(async () => {
      await mkdir(directories.evidenceDirectory, { recursive: true });
      await writeFile(path.join(directories.evidenceDirectory, "late.txt"), "late");
    });
    const result = await lifecycle.runBookingLifecycle(
      options(directories),
      {
        ...fake,
        writeEvidence: injected,
      },
    );

    expect(result.reason).toBe("RUNNER_CONTRACT_ONLY");
    expect(injected).not.toHaveBeenCalled();
    expect(fake.session.close).toHaveBeenCalledOnce();
    await expect(access(path.join(directories.evidenceDirectory, "late.txt")))
      .rejects.toThrow();
  });

  it("writes only allowlisted encoded screenshots and a hash-only safe manifest", async () => {
    const directories = await temporaryDirectories();
    await writeFile(
      path.join(directories.temporaryDirectory, "preview-qr.png"),
      PNG,
      { recursive: false },
    ).catch(async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(directories.temporaryDirectory, { recursive: true });
      await writeFile(
        path.join(directories.temporaryDirectory, "preview-qr.png"),
        PNG,
      );
      await writeFile(
        path.join(directories.temporaryDirectory, "raw-network.json"),
        "{}",
      );
      await writeFile(
        path.join(directories.temporaryDirectory, "raw-console.log"),
        "secret",
      );
    });
    const written = await lifecycle.writeSafeEvidence({
      temporaryDirectory: directories.temporaryDirectory,
      evidenceDirectory: directories.evidenceDirectory,
      manifest: evidenceManifest(),
      screenshots: [
        { name: "confirmed", bytes: PNG, visibleText: "订单已确认" },
        { name: "cancelled", bytes: PNG, visibleText: "订单已取消" },
      ],
    });

    expect(written.screenshots).toEqual([
      {
        path: "confirmed.png",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      {
        path: "cancelled.png",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    expect(await readdir(directories.evidenceDirectory)).toEqual([
      "cancelled.png",
      "confirmed.png",
      "manifest.json",
    ]);
    const manifest = await readFile(
      path.join(directories.evidenceDirectory, "manifest.json"),
      "utf8",
    );
    expect(manifest).not.toMatch(
      /authorization|bearer|token|idempotency|appid|qr|network|console|uuid/i,
    );
    expect(await readdir(directories.temporaryDirectory)).toEqual([
      "preview-qr.png",
      "raw-console.log",
      "raw-network.json",
    ]);
  });

  it("removes only its owned nested runtime artifacts on success and failure", async () => {
    for (const failSelector of [undefined, ".search-button"]) {
      const directories = await temporaryDirectories();
      await mkdir(path.join(directories.temporaryDirectory, "caller", "raw"), {
        recursive: true,
      });
      await writeFile(
        path.join(directories.temporaryDirectory, "caller", "raw", "network.json"),
        "keep",
      );
      const fake = createPhysicalFake({ failSelector });
      await lifecycle.runBookingLifecycle(options(directories), fake);
      expect(await readdir(directories.temporaryDirectory)).toEqual(["caller"]);
      expect(
        await readFile(
          path.join(directories.temporaryDirectory, "caller", "raw", "network.json"),
          "utf8",
        ),
      ).toBe("keep");
    }
  });

  it("rejects invalid image encoding and sensitive visible text without publishing", async () => {
    for (const screenshot of [
      {
        name: "confirmed",
        bytes: Buffer.from("not an image"),
        visibleText: "订单已确认",
      },
      {
        name: "confirmed",
        bytes: Buffer.concat([
          Buffer.from("89504e470d0a1a0a", "hex"),
          Buffer.from("forged payload"),
          Buffer.from("49454e44ae426082", "hex"),
        ]),
        visibleText: "订单已确认",
      },
      {
        name: "confirmed",
        bytes: PNG,
        visibleText:
          "Authorization Bearer secret 10000000-0000-4000-8000-000000000001",
      },
      {
        name: "confirmed",
        bytes: Buffer.from(PNG.map((byte, index) => (
          index === 45 ? byte ^ 0xff : byte
        ))),
        visibleText: "订单已确认",
      },
      {
        name: "confirmed",
        bytes: UNDECODABLE_PNG,
        visibleText: "订单已确认",
      },
      ...[
        PNG_WITHOUT_PLTE,
        PNG_WITH_UNKNOWN_CRITICAL,
        PNG_WITH_DUPLICATE_IHDR,
        PNG_WITH_SPLIT_IDAT,
        PNG_WITH_OVERSIZED_PLTE,
        PNG_WITH_ZLIB_TRAILING_BYTES,
      ].map((bytes) => ({
        name: "confirmed",
        bytes,
        visibleText: "订单已确认",
      })),
      {
        name: "confirmed",
        bytes: PNG,
        visibleText: "password=not-safe",
      },
    ]) {
      const directories = await temporaryDirectories();
      await expect(
        lifecycle.writeSafeEvidence({
          temporaryDirectory: directories.temporaryDirectory,
          evidenceDirectory: directories.evidenceDirectory,
          manifest: evidenceManifest(),
          screenshots: [
            screenshot,
            {
              name: "cancelled",
              bytes: PNG,
              visibleText: "订单已取消",
            },
          ],
        }),
      ).rejects.toThrow("unsafe evidence");
      await expect(readdir(directories.evidenceDirectory)).rejects.toThrow();
    }
  });

  it("does not publish when evidence cancellation is already terminal", async () => {
    const directories = await temporaryDirectories();
    const controller = new AbortController();
    controller.abort();
    await expect(
      lifecycle.writeSafeEvidence({
        temporaryDirectory: directories.temporaryDirectory,
        evidenceDirectory: directories.evidenceDirectory,
        manifest: evidenceManifest(),
        screenshots: [
          { name: "confirmed", bytes: PNG, visibleText: "订单已确认" },
          { name: "cancelled", bytes: PNG, visibleText: "订单已取消" },
        ],
        signal: controller.signal,
      }),
    ).rejects.toThrow("evidence cancelled");
    await expect(readdir(directories.evidenceDirectory)).rejects.toThrow();
  });

  it("rejects unknown manifest fields and accessors without invoking them", async () => {
    let reads = 0;
    for (const manifest of [
      evidenceManifest({ rawNetwork: true }),
      (() => {
        const value = evidenceManifest();
        Object.defineProperty(value, "cleanup", {
          enumerable: true,
          get() {
            reads += 1;
            throw new Error("manifest secret");
          },
        });
        return value;
      })(),
    ]) {
      const directories = await temporaryDirectories();
      await expect(
        lifecycle.writeSafeEvidence({
          temporaryDirectory: directories.temporaryDirectory,
          evidenceDirectory: directories.evidenceDirectory,
          manifest,
          screenshots: [
            { name: "confirmed", bytes: PNG, visibleText: "订单已确认" },
            { name: "cancelled", bytes: PNG, visibleText: "订单已取消" },
          ],
        }),
      ).rejects.toThrow("unsafe evidence");
    }
    expect(reads).toBe(0);
  });

  it("snapshots exact runner options before awaiting or launching", async () => {
    const directories = await temporaryDirectories();
    const fake = createPhysicalFake();
    let reads = 0;
    const unsafe = options(directories);
    Object.defineProperty(unsafe, "candidate", {
      enumerable: true,
      get() {
        reads += 1;
        return { commit: COMMIT, wxTree: WX_TREE };
      },
    });
    const result = await lifecycle.runBookingLifecycle(unsafe, fake);
    expect(result.reason).toBe("AUTOMATOR_CONFIGURATION_INVALID");
    expect(reads).toBe(0);
    expect(fake.launch).not.toHaveBeenCalled();

    const unknown = options(directories, { unexpected: true });
    expect((await lifecycle.runBookingLifecycle(unknown, fake)).reason)
      .toBe("AUTOMATOR_CONFIGURATION_INVALID");
    expect(fake.launch).not.toHaveBeenCalled();
  });

  it("rejects non-string candidate primitives without coercion", async () => {
    const directories = await temporaryDirectories();
    const fake = createPhysicalFake();
    let reads = 0;
    const coercible = {};
    Object.defineProperty(coercible, Symbol.toPrimitive, {
      get() {
        reads += 1;
        return () => COMMIT;
      },
    });
    for (const commit of [Symbol("commit"), coercible]) {
      const result = await lifecycle.runBookingLifecycle(
        options(directories, {
          candidate: { commit, wxTree: WX_TREE },
        }),
        fake,
      );
      expect(result.reason).toBe("AUTOMATOR_CONFIGURATION_INVALID");
    }
    expect(reads).toBe(0);
    expect(fake.launch).not.toHaveBeenCalled();
  });

  it("rejects unsafe writer input descriptors and constrained tool versions", async () => {
    const directories = await temporaryDirectories();
    const screenshot = {
      name: "confirmed",
      bytes: PNG,
      visibleText: "订单已确认",
      extra: true,
    };
    await expect(
      lifecycle.writeSafeEvidence({
        temporaryDirectory: directories.temporaryDirectory,
        evidenceDirectory: directories.evidenceDirectory,
        manifest: evidenceManifest(),
        screenshots: [
          screenshot,
          { name: "cancelled", bytes: PNG, visibleText: "订单已取消" },
        ],
      }),
    ).rejects.toThrow("unsafe evidence");
    await expect(
      lifecycle.writeSafeEvidence({
        temporaryDirectory: directories.temporaryDirectory,
        evidenceDirectory: directories.evidenceDirectory,
        manifest: evidenceManifest({ toolVersion: "../password" }),
        screenshots: [
          { name: "confirmed", bytes: PNG, visibleText: "订单已确认" },
          { name: "cancelled", bytes: PNG, visibleText: "订单已取消" },
        ],
      }),
    ).rejects.toThrow("unsafe evidence");
  });
});

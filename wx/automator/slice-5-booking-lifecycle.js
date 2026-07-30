"use strict";

const { createHash } = require("node:crypto");
const { inflateSync } = require("node:zlib");
const {
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  writeFile,
} = require("node:fs/promises");
const path = require("node:path");
const { types } = require("node:util");
const capturedAutomatorApi = require("miniprogram-automator");
const capturedAutomatorLaunch =
  capturedAutomatorApi.launch.bind(capturedAutomatorApi);

const SHA_1_PATTERN = /^[a-f0-9]{40}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SCREENSHOT_NAMES = Object.freeze(["confirmed", "cancelled"]);
const COUNT_KEYS = Object.freeze([
  "quote",
  "booking",
  "paymentFailure",
  "paymentSuccess",
  "cancel",
]);
const MANIFEST_ACTIONS = Object.freeze([
  ["quote:first", "quote"],
  ["booking:first", "booking"],
  ["payment:failure", "paymentFailure"],
  ["payment:success", "paymentSuccess"],
  ["orders:refresh", null],
  ["quote:second", "quote"],
  ["booking:second", "booking"],
  ["cancel:second", "cancel"],
]);
const SENSITIVE_PATTERN =
  /authorization|bearer\s+|token|secret|password|idempotency|appid|(?:^|[^a-z])qr(?:[^a-z]|$)|longitude|latitude|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const TOOL_VERSION_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,31})$/;
const MAX_PNG_BYTES = 5 * 1024 * 1024;
const MAX_PNG_CHUNKS = 128;
const MAX_PNG_DIMENSION = 4096;
const MAX_PNG_PIXELS = 16_777_216;
const attestedPhysicalSessions = new WeakSet();
const PNG_CHANNELS = Object.freeze({
  0: 1,
  2: 3,
  3: 1,
  4: 2,
  6: 4,
});
const PNG_BIT_DEPTHS = Object.freeze({
  0: Object.freeze([1, 2, 4, 8, 16]),
  2: Object.freeze([8, 16]),
  3: Object.freeze([1, 2, 4, 8]),
  4: Object.freeze([8, 16]),
  6: Object.freeze([8, 16]),
});

function blocked(reason, status = "BLOCKED_AUTOMATOR_RC") {
  return { schemaVersion: 1, status, reason };
}

function isPlainRecord(value) {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      types.isProxy(value) ||
      Array.isArray(value)
    ) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isAbortSignal(value) {
  try {
    return value === undefined || value instanceof AbortSignal;
  } catch {
    return false;
  }
}

function readExactRecord(value, keys) {
  if (!isPlainRecord(value)) throw new Error("unsafe evidence");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(descriptors).length !== keys.length
  ) {
    throw new Error("unsafe evidence");
  }
  const snapshot = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new Error("unsafe evidence");
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function readExactArray(value, length) {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new Error("unsafe evidence");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    descriptors.length?.value !== length ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(descriptors).length !== length + 1
  ) {
    throw new Error("unsafe evidence");
  }
  const snapshot = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new Error("unsafe evidence");
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function isIsoDate(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.valueOf()) &&
    date.toISOString().slice(0, 10) === value
  );
}

function shiftIsoDate(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function validCandidate(value) {
  return (
    isPlainRecord(value) &&
    typeof value.commit === "string" &&
    SHA_1_PATTERN.test(value.commit) &&
    typeof value.wxTree === "string" &&
    SHA_1_PATTERN.test(value.wxTree)
  );
}

function snapshotRunnerOptions(options) {
  const value = readExactRecord(options, [
    "candidate",
    "preflight",
    "executionDate",
    "toolVersion",
    "timeoutMs",
    "temporaryDirectory",
    "evidenceDirectory",
  ]);
  const candidate = readExactRecord(value.candidate, ["commit", "wxTree"]);
  const preflight = readExactRecord(value.preflight, [
    "schemaVersion",
    "status",
    "reason",
    "candidate",
    "seedWindow",
    "executionBoundary",
  ]);
  const preflightCandidate = readExactRecord(preflight.candidate, [
    "commit",
    "wxTree",
  ]);
  const seedWindow = readExactRecord(preflight.seedWindow, ["start", "end"]);
  const executionBoundary = readExactRecord(preflight.executionBoundary, [
    "state",
    "interactionStarted",
  ]);
  return Object.freeze({
    candidate: Object.freeze({ ...candidate }),
    preflight: Object.freeze({
      schemaVersion: preflight.schemaVersion,
      status: preflight.status,
      reason: preflight.reason,
      candidate: Object.freeze({ ...preflightCandidate }),
      seedWindow: Object.freeze({ ...seedWindow }),
      executionBoundary: Object.freeze({ ...executionBoundary }),
    }),
    executionDate: value.executionDate,
    toolVersion: value.toolVersion,
    timeoutMs: value.timeoutMs,
    temporaryDirectory: value.temporaryDirectory,
    evidenceDirectory: value.evidenceDirectory,
  });
}

function snapshotDependencies(dependencies) {
  if (!isPlainRecord(dependencies)) throw new Error("invalid dependencies");
  const descriptors = Object.getOwnPropertyDescriptors(dependencies);
  const launch = descriptors.launch;
  const connect = descriptors.connect;
  if (
    !launch ||
    !Object.hasOwn(launch, "value") ||
    typeof launch.value !== "function" ||
    !connect ||
    !Object.hasOwn(connect, "value") ||
    typeof connect.value !== "function"
  ) {
    throw new Error("invalid dependencies");
  }
  return Object.freeze({ launch: launch.value, connect: connect.value });
}

function validReadyPreflight(value, candidate, executionDate) {
  return (
    isPlainRecord(value) &&
    value.schemaVersion === 1 &&
    value.status === "READY" &&
    value.reason === "PREFLIGHT_READY" &&
    validCandidate(value.candidate) &&
    value.candidate.commit === candidate.commit &&
    value.candidate.wxTree === candidate.wxTree &&
    isPlainRecord(value.seedWindow) &&
    value.seedWindow.start === shiftIsoDate(executionDate, 1) &&
    value.seedWindow.end === shiftIsoDate(executionDate, 3) &&
    isPlainRecord(value.executionBoundary) &&
    value.executionBoundary.state === "READ_ONLY_PREFLIGHT" &&
    value.executionBoundary.interactionStarted === false
  );
}

function timeoutError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function bounded(code, timeoutMs, operation, reclaimLateValue) {
  const controller = new AbortController();
  let timedOut = false;
  let timer;
  const pending = Promise.resolve().then(() =>
    operation(Object.freeze({ signal: controller.signal })),
  );
  if (typeof reclaimLateValue === "function") {
    pending.then(
      async (value) => {
        if (timedOut) {
          try {
            await reclaimLateValue(value);
          } catch {}
        }
      },
      () => undefined,
    );
  }
  pending.catch(() => {});
  try {
    return await Promise.race([
      pending,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(timeoutError(code));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

function snapshotCounts(value) {
  if (!isPlainRecord(value)) throw new Error("invalid POST counters");
  const snapshot = {};
  for (const key of COUNT_KEYS) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      throw new Error("invalid POST counters");
    }
    snapshot[key] = value[key];
  }
  return Object.freeze(snapshot);
}

function changedCounts(before, after) {
  const delta = {};
  for (const key of COUNT_KEYS) {
    const change = after[key] - before[key];
    if (change !== 0) delta[key] = change;
  }
  return delta;
}

function assertWriteDelta(before, after, expectedKey) {
  const delta = changedCounts(before, after);
  if (
    Object.keys(delta).length !== 1 ||
    delta[expectedKey] !== 1
  ) {
    const error = new Error("unexpected write count");
    error.code = "WRITE_COUNT_MISMATCH";
    throw error;
  }
  return { [expectedKey]: 1 };
}

function assertNoWriteDelta(before, after) {
  if (Object.keys(changedCounts(before, after)).length !== 0) {
    const error = new Error("GET refresh produced a write");
    error.code = "WRITE_COUNT_MISMATCH";
    throw error;
  }
  return {};
}

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

async function hasImageEncoding(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length > MAX_PNG_BYTES ||
    bytes.length < 45 ||
    !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  ) {
    return false;
  }
  let offset = 8;
  let chunkIndex = 0;
  let sawImageData = false;
  let width = 0;
  let height = 0;
  let rowBytes = 0;
  let expectedDecodedBytes = 0;
  let compressedBytes = 0;
  const imageData = [];
  let colorType;
  let bitDepth;
  let sawPalette = false;
  let imageDataEnded = false;
  const uniqueChunks = new Set();
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (length > 20_000_000 || end > bytes.length) return false;
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const dataEnd = offset + 8 + length;
    const expectedCrc = bytes.readUInt32BE(dataEnd);
    if (
      !/^[A-Za-z]{4}$/.test(type) ||
      crc32(bytes.subarray(offset + 4, dataEnd)) !== expectedCrc
    ) {
      return false;
    }
    if (
      (type[0] === type[0].toUpperCase() &&
        !["IHDR", "PLTE", "IDAT", "IEND"].includes(type)) ||
      (["IHDR", "PLTE", "IEND"].includes(type) &&
        uniqueChunks.has(type))
    ) {
      return false;
    }
    if (["IHDR", "PLTE", "IEND"].includes(type)) uniqueChunks.add(type);
    if (chunkIndex === 0 && (type !== "IHDR" || length !== 13)) {
      return false;
    }
    if (chunkIndex === 0) {
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      bitDepth = bytes[offset + 16];
      colorType = bytes[offset + 17];
      const compression = bytes[offset + 18];
      const filter = bytes[offset + 19];
      const interlace = bytes[offset + 20];
      const channels = PNG_CHANNELS[colorType];
      if (
        width === 0 ||
        height === 0 ||
        width > MAX_PNG_DIMENSION ||
        height > MAX_PNG_DIMENSION ||
        width * height > MAX_PNG_PIXELS ||
        channels === undefined ||
        !PNG_BIT_DEPTHS[colorType].includes(bitDepth) ||
        compression !== 0 ||
        filter !== 0 ||
        interlace !== 0
      ) {
        return false;
      }
      rowBytes = Math.ceil((width * channels * bitDepth) / 8);
      expectedDecodedBytes = height * (rowBytes + 1);
      if (
        expectedDecodedBytes <= 0 ||
        expectedDecodedBytes > MAX_PNG_BYTES * 4
      ) {
        return false;
      }
    }
    if (type === "PLTE") {
      if (
        sawImageData ||
        length === 0 ||
        length % 3 !== 0 ||
        length > 768 ||
        [0, 4].includes(colorType) ||
        (colorType === 3 && length / 3 > 2 ** bitDepth)
      ) {
        return false;
      }
      sawPalette = true;
    }
    if (type === "IDAT") {
      if (imageDataEnded) return false;
      sawImageData = true;
      compressedBytes += length;
      if (compressedBytes > MAX_PNG_BYTES) return false;
      imageData.push(bytes.subarray(offset + 8, dataEnd));
    } else if (sawImageData && type !== "IEND") {
      imageDataEnded = true;
    }
    if (type === "IEND") {
      if (
        length !== 0 ||
        !sawImageData ||
        end !== bytes.length ||
        chunkIndex + 1 > MAX_PNG_CHUNKS
        || (colorType === 3 && !sawPalette)
      ) {
        return false;
      }
      try {
        const inflated = inflateSync(Buffer.concat(imageData), {
          maxOutputLength: expectedDecodedBytes,
          info: true,
        });
        const decoded = inflated.buffer;
        if (inflated.engine.bytesWritten !== compressedBytes) return false;
        if (decoded.length !== expectedDecodedBytes) return false;
        for (let row = 0; row < height; row += 1) {
          if (decoded[row * (rowBytes + 1)] > 4) return false;
        }
        return true;
      } catch {
        return false;
      }
    }
    offset = end;
    chunkIndex += 1;
    if (chunkIndex >= MAX_PNG_CHUNKS) return false;
  }
  return false;
}

function safeVisibleText(value) {
  return (
    typeof value === "string" &&
    value.length <= 20_000 &&
    !SENSITIVE_PATTERN.test(value)
  );
}

function snapshotManifest(manifest) {
  const value = readExactRecord(manifest, [
    "schemaVersion",
    "candidate",
    "executionDate",
    "seedWindow",
    "toolVersion",
    "steps",
    "postDeltas",
    "cleanup",
  ]);
  const candidate = readExactRecord(value.candidate, [
    "commit",
    "wxTree",
  ]);
  const seedWindow = readExactRecord(value.seedWindow, ["start", "end"]);
  const steps = readExactArray(value.steps, 10).map((entry, index) => {
    const item = readExactRecord(entry, ["number", "status"]);
    if (item.number !== index + 1 || item.status !== "PASS") {
      throw new Error("unsafe evidence");
    }
    return { number: item.number, status: item.status };
  });
  const postDeltas = readExactArray(
    value.postDeltas,
    MANIFEST_ACTIONS.length,
  ).map((entry, index) => {
    const item = readExactRecord(entry, ["action", "delta"]);
    const [expectedAction, expectedKey] = MANIFEST_ACTIONS[index];
    const delta = readExactRecord(
      item.delta,
      expectedKey === null ? [] : [expectedKey],
    );
    if (
      item.action !== expectedAction ||
      (expectedKey !== null && delta[expectedKey] !== 1)
    ) {
      throw new Error("unsafe evidence");
    }
    return {
      action: item.action,
      delta: expectedKey === null ? {} : { [expectedKey]: 1 },
    };
  });
  if (
    value.schemaVersion !== 1 ||
    typeof candidate.commit !== "string" ||
    !SHA_1_PATTERN.test(candidate.commit) ||
    typeof candidate.wxTree !== "string" ||
    !SHA_1_PATTERN.test(candidate.wxTree) ||
    !isIsoDate(value.executionDate) ||
    seedWindow.start !== shiftIsoDate(value.executionDate, 1) ||
    seedWindow.end !== shiftIsoDate(value.executionDate, 3) ||
    typeof value.toolVersion !== "string" ||
    !TOOL_VERSION_PATTERN.test(value.toolVersion) ||
    SENSITIVE_PATTERN.test(value.toolVersion) ||
    value.cleanup !== "CLOSED"
  ) {
    throw new Error("unsafe evidence");
  }
  return {
    schemaVersion: 1,
    candidate: {
      commit: candidate.commit,
      wxTree: candidate.wxTree,
    },
    executionDate: value.executionDate,
    seedWindow: {
      start: seedWindow.start,
      end: seedWindow.end,
    },
    toolVersion: value.toolVersion,
    steps,
    postDeltas,
    cleanup: "CLOSED",
  };
}

async function prepareSafeEvidence(input, publish) {
  let source;
  let manifest;
  try {
    if (!isPlainRecord(input)) throw new Error("unsafe evidence");
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Object.hasOwn(descriptors, "signal")
      ? [
          "temporaryDirectory",
          "evidenceDirectory",
          "manifest",
          "screenshots",
          "signal",
        ]
      : [
          "temporaryDirectory",
          "evidenceDirectory",
          "manifest",
          "screenshots",
        ];
    source = readExactRecord(input, keys);
    manifest = snapshotManifest(source.manifest);
  } catch {
    throw new Error("unsafe evidence");
  }
  if (
    !path.isAbsolute(source.temporaryDirectory) ||
    !path.isAbsolute(source.evidenceDirectory) ||
    path.parse(source.temporaryDirectory).root !==
      path.parse(source.evidenceDirectory).root ||
    path.resolve(source.temporaryDirectory) ===
      path.resolve(source.evidenceDirectory) ||
    !isAbortSignal(source.signal)
  ) {
    throw new Error("unsafe evidence");
  }
  let screenshotInputs;
  try {
    screenshotInputs = readExactArray(source.screenshots, 2);
  } catch {
    throw new Error("unsafe evidence");
  }
  const temporaryDirectory = path.resolve(source.temporaryDirectory);
  const evidenceDirectory = path.resolve(source.evidenceDirectory);
  const screenshots = [];
  const names = new Set();
  let published = false;
  let stagingDirectory;
  const throwIfCancelled = () => {
    if (source.signal?.aborted === true) {
      throw new Error("evidence cancelled");
    }
  };
  try {
    throwIfCancelled();
    for (const rawScreenshot of screenshotInputs) {
      let screenshot;
      try {
        screenshot = readExactRecord(rawScreenshot, [
          "name",
          "bytes",
          "visibleText",
        ]);
      } catch {
        throw new Error("unsafe evidence");
      }
      if (
        !SCREENSHOT_NAMES.includes(screenshot.name) ||
        names.has(screenshot.name) ||
        !(await hasImageEncoding(screenshot.bytes)) ||
        !safeVisibleText(screenshot.visibleText)
      ) {
        throw new Error("unsafe evidence");
      }
      throwIfCancelled();
      names.add(screenshot.name);
      screenshots.push({
        name: screenshot.name,
        bytes: Buffer.from(screenshot.bytes),
        sha256: createHash("sha256")
          .update(screenshot.bytes)
          .digest("hex"),
      });
    }
    if (
      screenshots.length !== SCREENSHOT_NAMES.length ||
      !SCREENSHOT_NAMES.every((name) => names.has(name))
    ) {
      throw new Error("unsafe evidence");
    }

    const safeManifest = {
      schemaVersion: 1,
      candidate: {
        commit: manifest.candidate.commit,
        wxTree: manifest.candidate.wxTree,
      },
      executionDate: manifest.executionDate,
      seedWindow: {
        start: manifest.seedWindow.start,
        end: manifest.seedWindow.end,
      },
      toolVersion: manifest.toolVersion,
      steps: manifest.steps.map((step) => ({
        number: step.number,
        status: step.status,
      })),
      postDeltas: manifest.postDeltas.map((entry) => ({
        action: entry.action,
        delta: { ...entry.delta },
      })),
      screenshots: screenshots.map(({ name, sha256 }) => ({
        path: `${name}.png`,
        sha256,
      })),
      cleanup: "CLOSED",
    };
    const serialized = `${JSON.stringify(safeManifest, null, 2)}\n`;
    if (SENSITIVE_PATTERN.test(serialized)) {
      throw new Error("unsafe evidence");
    }

    await mkdir(temporaryDirectory, { recursive: true });
    throwIfCancelled();
    stagingDirectory = await mkdtemp(
      path.join(temporaryDirectory, "slice5-lifecycle-"),
    );
    for (const screenshot of screenshots) {
      await writeFile(
        path.join(stagingDirectory, `${screenshot.name}.png`),
        screenshot.bytes,
      );
      throwIfCancelled();
    }
    throwIfCancelled();
    await writeFile(
      path.join(stagingDirectory, "manifest.json"),
      serialized,
      { flag: "wx" },
    );
    throwIfCancelled();
    if (!publish) {
      const preparedDirectory = stagingDirectory;
      stagingDirectory = undefined;
      return {
        manifest: JSON.parse(JSON.stringify(safeManifest)),
        stagingDirectory: preparedDirectory,
        evidenceDirectory,
      };
    }
    await rename(stagingDirectory, evidenceDirectory);
    stagingDirectory = undefined;
    published = true;
    throwIfCancelled();
    return JSON.parse(JSON.stringify(safeManifest));
  } catch (error) {
    if (published) {
      await rm(evidenceDirectory, { recursive: true, force: true });
    }
    if (
      error?.message === "unsafe evidence" ||
      error?.message === "evidence cancelled"
    ) {
      throw error;
    }
    throw new Error("unsafe evidence");
  } finally {
    if (stagingDirectory !== undefined) {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  }
}

async function writeSafeEvidence(input) {
  return prepareSafeEvidence(input, true);
}

function step(number) {
  return Object.freeze({ number, status: "PASS" });
}

async function executeBookingLifecycle(options, dependencies, runtimeDirectory) {
  if (
    !validCandidate(options.candidate) ||
    !isIsoDate(options.executionDate) ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > 30_000 ||
    typeof options.toolVersion !== "string" ||
    !path.isAbsolute(options.temporaryDirectory) ||
    !path.isAbsolute(options.evidenceDirectory)
  ) {
    return blocked("AUTOMATOR_CONFIGURATION_INVALID");
  }
  if (
    !validReadyPreflight(
      options.preflight,
      options.candidate,
      options.executionDate,
    )
  ) {
    return blocked("CANDIDATE_PREFLIGHT_MISMATCH");
  }

  let launchHandle;
  let session;
  let closeSucceeded = false;
  let flowResult;
  try {
    launchHandle = await bounded(
      "LAUNCH_TIMEOUT",
      options.timeoutMs,
      ({ signal }) => dependencies.launch({ signal }),
      async (value) => {
        if (value && typeof value.close === "function") await value.close();
        else if (value && typeof value.disconnect === "function") {
          value.disconnect();
        }
      },
    );
    session = await bounded(
      "CONNECT_TIMEOUT",
      options.timeoutMs,
      ({ signal }) => dependencies.connect(launchHandle, { signal }),
      async (value) => {
        if (value && typeof value.close === "function") await value.close();
        else if (value && typeof value.disconnect === "function") {
          value.disconnect();
        }
      },
    );
    if (
      !isPlainRecord(session) ||
      ![
        "currentPage",
        "input",
        "tap",
        "readPostCounts",
        "readVisibleText",
        "readPaymentContinuity",
        "captureScreenshot",
        "close",
      ].every((name) => typeof session[name] === "function")
    ) {
      throw new Error("invalid physical session");
    }

    const steps = [];
    const postDeltas = [];
    const screenshots = [];
    const call = (code, operation) =>
      bounded(code, options.timeoutMs, operation);
    const page = () =>
      call("PHYSICAL_ACTION_TIMEOUT", ({ signal }) =>
        session.currentPage({ signal }),
      );
    const expectPage = async (expected) => {
      if ((await page()) !== expected) {
        const error = new Error("unexpected page");
        error.code = "PHYSICAL_ACTION_FAILED";
        throw error;
      }
    };
    const tap = (selector, configuration = {}) =>
      call("PHYSICAL_ACTION_TIMEOUT", ({ signal }) =>
        session.tap({ selector, ...configuration, signal }),
      );
    const input = (selector, index, value) =>
      call("PHYSICAL_ACTION_TIMEOUT", ({ signal }) =>
        session.input({ selector, index, value, signal }),
      );
    const counts = () =>
      call("PHYSICAL_ACTION_TIMEOUT", async ({ signal }) =>
        snapshotCounts(await session.readPostCounts({ signal })),
      );
    const write = async (action, expectedKey, physicalAction) => {
      const before = await counts();
      let actionStarted = false;
      try {
        actionStarted = true;
        await physicalAction();
        const after = await counts();
        postDeltas.push({
          action,
          delta: assertWriteDelta(before, after, expectedKey),
        });
      } catch (error) {
        if (
          actionStarted &&
          ["PHYSICAL_ACTION_TIMEOUT", "POST_LEDGER_UNAVAILABLE"].includes(
            error?.code,
          )
        ) {
          try {
            await counts();
          } catch {}
          throw timeoutError("WRITE_OUTCOME_UNKNOWN");
        }
        throw error;
      }
    };

    await expectPage("pages/home/home");
    await tap(".field-row", { index: 1 });
    await expectPage("pages/date-guest-select/date-guest-select");
    await input("picker", 0, options.preflight.seedWindow.start);
    await input("picker", 1, options.preflight.seedWindow.end);
    await tap(".stepper__button", { index: 1 });
    await tap(".stepper__button", { index: 1 });
    await tap(".save-button");
    await expectPage("pages/home/home");
    steps.push(step(1));

    await tap(".search-button");
    await expectPage("pages/property-list/property-list");
    steps.push(step(2));

    await tap(".property-card__tap-target");
    await expectPage("pages/property-detail/property-detail");
    steps.push(step(3));

    await tap(".room-card__action");
    await expectPage("pages/room-detail/room-detail");
    steps.push(step(4));

    await write("quote:first", "quote", () =>
      tap(".selection-bar__action"),
    );
    await expectPage("pages/booking-confirm/booking-confirm");
    await write("booking:first", "booking", () =>
      tap(".action-bar__button"),
    );
    steps.push(step(5));

    await tap(".created-card__action--primary");
    await expectPage("pages/order-detail/order-detail");
    steps.push(step(6));

    await write("payment:failure", "paymentFailure", () =>
      tap('[data-action="MOCK_PAY_FAILURE"]', {
        outcome: "FAIL",
        scope: "MOCK_PAYMENT_FAIL",
      }),
    );
    if (
      (await call("PHYSICAL_ACTION_TIMEOUT", ({ signal }) =>
        session.readVisibleText(".summary-card__status", { signal }),
      )) !== "待支付"
    ) {
      const error = new Error("failed payment changed order status");
      error.code = "FAILED_PRODUCT";
      throw error;
    }
    steps.push(step(7));

    const successBefore = await counts();
    const paymentSuccessTap = () =>
      tap('[data-action="MOCK_PAY_SUCCESS"]', {
        outcome: "SUCCEED",
        scope: "MOCK_PAYMENT_SUCCEED",
      });
    let paymentStatus;
    let paymentAttempts;
    try {
      await paymentSuccessTap();
      const actionNotice = await call(
        "PHYSICAL_ACTION_TIMEOUT",
        ({ signal }) =>
          session.readVisibleText(".action-notice", { signal }),
      );
      paymentAttempts = 1;
      if (actionNotice.includes("支付结果待确认")) {
        assertNoWriteDelta(successBefore, await counts());
        await paymentSuccessTap();
        paymentAttempts = 2;
      }
      paymentStatus = await call(
        "PHYSICAL_ACTION_TIMEOUT",
        ({ signal }) =>
          session.readVisibleText(".summary-card__status", { signal }),
      );
      const successAfter = await counts();
      postDeltas.push({
        action: "payment:success",
        delta: assertWriteDelta(
          successBefore,
          successAfter,
          "paymentSuccess",
        ),
      });
    } catch (error) {
      if (
        ["PHYSICAL_ACTION_TIMEOUT", "POST_LEDGER_UNAVAILABLE"].includes(
          error?.code,
        )
      ) {
        throw timeoutError("WRITE_OUTCOME_UNKNOWN");
      }
      throw error;
    }
    if (paymentStatus !== "已确认") {
      const error = new Error("payment did not confirm order");
      error.code = "FAILED_PRODUCT";
      throw error;
    }
    const paymentContinuity = await call(
      "PHYSICAL_ACTION_TIMEOUT",
      ({ signal }) =>
        session.readPaymentContinuity({
          scope: "MOCK_PAYMENT_SUCCEED",
          attempts: paymentAttempts,
          signal,
        }),
    );
    if (
      !isPlainRecord(paymentContinuity) ||
      paymentContinuity.sameScope !== true ||
      paymentContinuity.sameCredential !== true
    ) {
      const error = new Error("payment retry continuity failed");
      error.code = "FAILED_PRODUCT";
      throw error;
    }
    screenshots.push(
      await call("EVIDENCE_CAPTURE_TIMEOUT", ({ signal }) =>
        session.captureScreenshot({ name: "confirmed", signal }),
      ),
    );
    steps.push(step(8));

    const refreshBefore = await counts();
    await tap('[aria-label="订单"]', { surface: "native-tab" });
    await expectPage("pages/order-list/order-list");
    await tap(".order-row__action");
    await expectPage("pages/order-detail/order-detail");
    const refreshAfter = await counts();
    postDeltas.push({
      action: "orders:refresh",
      delta: assertNoWriteDelta(refreshBefore, refreshAfter),
    });
    steps.push(step(9));

    await tap('[aria-label="首页"]', { surface: "native-tab" });
    await expectPage("pages/home/home");
    await tap(".search-button");
    await tap(".property-card__tap-target");
    await tap(".room-card__action");
    await write("quote:second", "quote", () =>
      tap(".selection-bar__action"),
    );
    await write("booking:second", "booking", () =>
      tap(".action-bar__button"),
    );
    await tap(".created-card__action--primary");
    await write("cancel:second", "cancel", () =>
      tap('[data-action="CANCEL"]'),
    );
    if (
      (await call("PHYSICAL_ACTION_TIMEOUT", ({ signal }) =>
        session.readVisibleText(".summary-card__status", { signal }),
      )) !== "已取消"
    ) {
      const error = new Error("cancel did not reach terminal status");
      error.code = "FAILED_PRODUCT";
      throw error;
    }
    screenshots.push(
      await call("EVIDENCE_CAPTURE_TIMEOUT", ({ signal }) =>
        session.captureScreenshot({ name: "cancelled", signal }),
      ),
    );
    steps.push(step(10));
    flowResult = { steps, postDeltas, screenshots };
  } catch (error) {
    const safeReasons = [
      "LAUNCH_TIMEOUT",
      "CONNECT_TIMEOUT",
      "PHYSICAL_ACTION_TIMEOUT",
      "EVIDENCE_CAPTURE_TIMEOUT",
      "WRITE_OUTCOME_UNKNOWN",
      "WRITE_COUNT_MISMATCH",
      "FAILED_PRODUCT",
      "PHYSICAL_ACTION_FAILED",
      "POST_LEDGER_UNAVAILABLE",
      "PICKER_PHYSICAL_UNAVAILABLE",
    ];
    const reason = safeReasons.includes(error?.code)
      ? error.code
      : "PHYSICAL_ACTION_FAILED";
    const status =
      reason === "WRITE_OUTCOME_UNKNOWN" ||
      reason === "WRITE_COUNT_MISMATCH" ||
      reason === "FAILED_PRODUCT"
        ? "FAILED_PRODUCT"
        : "BLOCKED_AUTOMATOR_RC";
    flowResult = { failure: blocked(reason, status) };
  } finally {
    const closer =
      session && typeof session.close === "function"
        ? () => session.close()
        : launchHandle && typeof launchHandle.close === "function"
          ? () => launchHandle.close()
          : undefined;
    if (closer) {
      try {
        await bounded("CLEANUP_TIMEOUT", options.timeoutMs, closer);
        closeSucceeded = true;
      } catch {
        flowResult = { failure: blocked("CLEANUP_FAILED") };
      }
    } else if (launchHandle === undefined) {
      closeSucceeded = true;
    }
  }

  if (flowResult?.failure) return flowResult.failure;
  if (!closeSucceeded) return blocked("CLEANUP_FAILED");
  if (!attestedPhysicalSessions.has(session)) {
    return blocked("RUNNER_CONTRACT_ONLY", "BLOCKED_PHYSICAL_UAT");
  }

  const manifest = {
    schemaVersion: 1,
    candidate: {
      commit: options.candidate.commit,
      wxTree: options.candidate.wxTree,
    },
    executionDate: options.executionDate,
    seedWindow: {
      start: options.preflight.seedWindow.start,
      end: options.preflight.seedWindow.end,
    },
    toolVersion: options.toolVersion,
    steps: flowResult.steps,
    postDeltas: flowResult.postDeltas,
    cleanup: "CLOSED",
  };
  let evidence;
  let preparedDirectory;
  try {
    const prepared = await bounded(
      "EVIDENCE_WRITE_TIMEOUT",
      options.timeoutMs,
      ({ signal }) =>
        prepareSafeEvidence({
          temporaryDirectory: runtimeDirectory,
          evidenceDirectory: options.evidenceDirectory,
          manifest,
          screenshots: flowResult.screenshots,
          signal,
        }, false),
    );
    preparedDirectory = prepared.stagingDirectory;
    await rename(preparedDirectory, options.evidenceDirectory);
    preparedDirectory = undefined;
    evidence = prepared.manifest;
  } catch {
    if (preparedDirectory !== undefined) {
      await rm(preparedDirectory, { recursive: true, force: true });
    }
    return blocked("EVIDENCE_WRITE_FAILED");
  }
  return {
    schemaVersion: 1,
    status: "PASS",
    reason: "PHYSICAL_LIFECYCLE_COMPLETE",
    steps: flowResult.steps,
    postDeltas: flowResult.postDeltas,
    paymentScope: "MOCK_PAYMENT_SUCCEED",
    evidence: {
      manifest: "manifest.json",
      screenshots: evidence.screenshots,
    },
  };
}

async function runBookingLifecycle(rawOptions, rawDependencies) {
  let options;
  let dependencies;
  try {
    options = snapshotRunnerOptions(rawOptions);
    dependencies = snapshotDependencies(rawDependencies);
  } catch {
    return blocked("AUTOMATOR_CONFIGURATION_INVALID");
  }
  if (
    !validCandidate(options.candidate) ||
    !isIsoDate(options.executionDate) ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > 30_000 ||
    !TOOL_VERSION_PATTERN.test(options.toolVersion) ||
    SENSITIVE_PATTERN.test(options.toolVersion) ||
    !path.isAbsolute(options.temporaryDirectory) ||
    !path.isAbsolute(options.evidenceDirectory)
  ) {
    return blocked("AUTOMATOR_CONFIGURATION_INVALID");
  }
  if (!validReadyPreflight(
    options.preflight,
    options.candidate,
    options.executionDate,
  )) {
    return blocked("CANDIDATE_PREFLIGHT_MISMATCH");
  }

  let runtimeDirectory;
  try {
    await mkdir(options.temporaryDirectory, { recursive: true });
    runtimeDirectory = await mkdtemp(
      path.join(options.temporaryDirectory, "slice5-owned-"),
    );
    return await executeBookingLifecycle(
      options,
      dependencies,
      runtimeDirectory,
    );
  } catch {
    return blocked("AUTOMATOR_CONFIGURATION_INVALID");
  } finally {
    if (runtimeDirectory !== undefined) {
      await rm(runtimeDirectory, { recursive: true, force: true });
    }
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted === true) throw timeoutError("OPERATION_ABORTED");
}

async function readPostLedgerSnapshot(postLedgerPath, expected, state) {
  let parsed;
  try {
    parsed = parseBoundedJson(await readBoundedUtf8(postLedgerPath));
    const value = readExactRecord(parsed, [
      "schemaVersion",
      "candidate",
      "executionDate",
      "revision",
      "totalPosts",
      "unknownPosts",
      "counts",
      "paymentRetry",
    ]);
    const candidate = readExactRecord(value.candidate, [
      "commit",
      "wxTree",
    ]);
    const countsValue = readExactRecord(value.counts, COUNT_KEYS);
    const counts = snapshotCounts(countsValue);
    const retry = readExactRecord(value.paymentRetry, [
      "outcome",
      "attempts",
      "sameScope",
      "sameCredential",
    ]);
    const totalPosts = COUNT_KEYS.reduce(
      (sum, key) => sum + counts[key],
      0,
    );
    if (
      value.schemaVersion !== 1 ||
      candidate.commit !== expected.candidate.commit ||
      candidate.wxTree !== expected.candidate.wxTree ||
      value.executionDate !== expected.executionDate ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0 ||
      value.revision < state.lastRevision ||
      value.totalPosts !== totalPosts ||
      value.unknownPosts !== 0 ||
      retry.outcome !== "SUCCEED" ||
      !Number.isSafeInteger(retry.attempts) ||
      retry.attempts < 1 ||
      retry.attempts > 2 ||
      typeof retry.sameScope !== "boolean" ||
      typeof retry.sameCredential !== "boolean"
    ) {
      throw new Error("invalid ledger");
    }
    const snapshot = Object.freeze({
      counts,
      paymentRetry: Object.freeze({ ...retry }),
    });
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          candidate,
          executionDate: value.executionDate,
          revision: value.revision,
          totalPosts: value.totalPosts,
          unknownPosts: value.unknownPosts,
          counts,
          paymentRetry: retry,
        }),
      )
      .digest("hex");
    if (
      value.revision === state.lastRevision &&
      fingerprint !== state.lastFingerprint
    ) {
      throw new Error("invalid ledger");
    }
    if (value.revision > state.lastRevision) {
      state.lastRevision = value.revision;
      state.lastFingerprint = fingerprint;
    }
    return snapshot;
  } catch {
    const error = new Error("POST ledger consumer snapshot unavailable");
    error.code = "POST_LEDGER_UNAVAILABLE";
    throw error;
  }
}

async function readBoundedUtf8(filePath, maximumBytes = 64 * 1024) {
  const handle = await open(filePath, "r");
  const bytes = Buffer.alloc(maximumBytes + 1);
  let total = 0;
  try {
    while (total <= maximumBytes) {
      const { bytesRead } = await handle.read(
        bytes,
        total,
        maximumBytes + 1 - total,
        null,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximumBytes) throw new Error("bounded input exceeded");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, total),
    );
  } finally {
    await handle.close();
  }
}

function createMiniprogramAutomatorDependencies(configuration) {
  const value = readExactRecord(configuration, [
    "candidate",
    "executionDate",
    "launchOptions",
    "postLedgerPath",
  ]);
  const candidate = readExactRecord(value.candidate, ["commit", "wxTree"]);
  const launchOptions = readExactRecord(value.launchOptions, [
    "cliPath",
    "projectPath",
  ]);
  if (
    typeof launchOptions.cliPath !== "string" ||
    launchOptions.cliPath.length === 0 ||
    typeof launchOptions.projectPath !== "string" ||
    launchOptions.projectPath.length === 0 ||
    typeof value.postLedgerPath !== "string" ||
    !path.isAbsolute(value.postLedgerPath) ||
    !validCandidate(candidate) ||
    !isIsoDate(value.executionDate)
  ) {
    throw new Error("invalid production Automator configuration");
  }
  const launchAutomator = capturedAutomatorLaunch;
  const postLedgerPath = path.resolve(value.postLedgerPath);
  const ledgerExpected = Object.freeze({
    candidate: Object.freeze({ ...candidate }),
    executionDate: value.executionDate,
  });
  const ledgerState = { lastRevision: -1 };
  const readLedger = () =>
    readPostLedgerSnapshot(
      postLedgerPath,
      ledgerExpected,
      ledgerState,
    );
  let miniProgram;
  let closed = false;

  const closeMiniProgram = async (candidate) => {
    if (!candidate || closed) return;
    closed = true;
    if (typeof candidate.close === "function") {
      await candidate.close();
    } else if (typeof candidate.disconnect === "function") {
      candidate.disconnect();
    }
  };
  const findElement = async (selector, index, signal) => {
    throwIfAborted(signal);
    const page = await miniProgram.currentPage();
    throwIfAborted(signal);
    const element =
      index === undefined
        ? await page?.$(selector)
        : (await page?.$$(selector))?.[index];
    if (!element) {
      const error = new Error("physical element unavailable");
      error.code = "PHYSICAL_ACTION_FAILED";
      throw error;
    }
    return element;
  };
  return {
    async launch({ signal }) {
      throwIfAborted(signal);
      await readLedger();
      const error = new Error("physical picker unavailable");
      error.code = "PICKER_PHYSICAL_UNAVAILABLE";
      throw error;
      throwIfAborted(signal);
      const pending = Promise.resolve().then(() =>
        launchAutomator({
          cliPath: launchOptions.cliPath,
          projectPath: launchOptions.projectPath,
        }),
      );
      pending.then(
        (candidate) => {
          if (signal?.aborted === true) {
            void closeMiniProgram(candidate).catch(() => {});
          }
        },
        () => undefined,
      );
      miniProgram = await pending;
      throwIfAborted(signal);
      return miniProgram;
    },
    async connect(handle, { signal }) {
      throwIfAborted(signal);
      if (handle !== miniProgram || !handle) {
        throw new Error("invalid Automator launch handle");
      }
      const session = {
        async currentPage({ signal: operationSignal } = {}) {
          throwIfAborted(operationSignal);
          const page = await miniProgram.currentPage();
          throwIfAborted(operationSignal);
          return page?.path;
        },
        async input({
          selector,
          index,
          value: inputValue,
          signal: operationSignal,
        }) {
          if (selector === "picker") {
            throw timeoutError("PICKER_PHYSICAL_UNAVAILABLE");
          }
          const element = await findElement(
            selector,
            index,
            operationSignal,
          );
          if (typeof element.input !== "function") {
            const error = new Error("physical input unavailable");
            error.code = "PHYSICAL_ACTION_FAILED";
            throw error;
          }
          await element.input(inputValue);
          throwIfAborted(operationSignal);
        },
        async tap({
          selector,
          index,
          surface = "page",
          signal: operationSignal,
        }) {
          throwIfAborted(operationSignal);
          if (surface === "native-tab") {
            const routes = {
              '[aria-label="订单"]': "pages/order-list/order-list",
              '[aria-label="首页"]': "pages/home/home",
            };
            const url = routes[selector];
            const nativeController = miniProgram.native?.();
            if (!url || typeof nativeController?.switchTab !== "function") {
              const error = new Error("native tab physical tap unavailable");
              error.code = "PHYSICAL_ACTION_FAILED";
              throw error;
            }
            await nativeController.switchTab({ url });
            throwIfAborted(operationSignal);
            return;
          }
          const element = await findElement(
            selector,
            index,
            operationSignal,
          );
          await element.tap();
          throwIfAborted(operationSignal);
        },
        async readPostCounts({ signal: operationSignal } = {}) {
          throwIfAborted(operationSignal);
          const ledger = await readLedger();
          throwIfAborted(operationSignal);
          return { ...ledger.counts };
        },
        async readVisibleText(selector, { signal: operationSignal } = {}) {
          const element = await findElement(
            selector,
            undefined,
            operationSignal,
          );
          const text = await element.text();
          throwIfAborted(operationSignal);
          return text;
        },
        async readPaymentContinuity({
          scope,
          attempts,
          signal: operationSignal,
        }) {
          throwIfAborted(operationSignal);
          const ledger = await readLedger();
          throwIfAborted(operationSignal);
          if (
            scope !== "MOCK_PAYMENT_SUCCEED" ||
            ledger.paymentRetry.attempts !== attempts
          ) {
            return { sameScope: false, sameCredential: false };
          }
          return {
            sameScope: ledger.paymentRetry.sameScope,
            sameCredential: ledger.paymentRetry.sameCredential,
          };
        },
        async captureScreenshot({ name, signal: operationSignal }) {
          const scan = async () => {
            throwIfAborted(operationSignal);
            const page = await miniProgram.currentPage();
            const pageShell = await page?.$(".page-shell");
            if (
              typeof pageShell?.outerWxml !== "function" ||
              typeof page?.$$ !== "function"
            ) {
              throw timeoutError("PHYSICAL_ACTION_FAILED");
            }
            const renderedWxml = await pageShell.outerWxml();
            const textElements = await page.$$("text");
            const textValues = await Promise.all(
              textElements.map((element) => element.text()),
            );
            if (
              typeof renderedWxml !== "string" ||
              !textValues.every((entry) => typeof entry === "string")
            ) {
              throw timeoutError("PHYSICAL_ACTION_FAILED");
            }
            return `${renderedWxml}\n${textValues.join("\n")}`;
          };
          const before = await scan();
          const encodedFirst = await miniProgram.screenshot();
          const after = await scan();
          const encodedSecond = await miniProgram.screenshot();
          const final = await scan();
          const firstBytes = Buffer.from(encodedFirst, "base64");
          const secondBytes = Buffer.from(encodedSecond, "base64");
          if (
            before !== after ||
            after !== final ||
            createHash("sha256").update(firstBytes).digest("hex") !==
              createHash("sha256").update(secondBytes).digest("hex")
          ) {
            throw timeoutError("PHYSICAL_ACTION_FAILED");
          }
          throwIfAborted(operationSignal);
          return {
            name,
            bytes: secondBytes,
            visibleText: final,
          };
        },
        async close() {
          await closeMiniProgram(miniProgram);
        },
      };
      attestedPhysicalSessions.add(session);
      return session;
    },
  };
}

function parseBoundedJson(text) {
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text, "utf8") > 64 * 1024
  ) {
    throw new Error("invalid JSON");
  }
  let index = 0;
  const whitespace = () => {
    while (/[\t\n\r ]/.test(text[index] || "")) index += 1;
  };
  const string = () => {
    const start = index;
    if (text[index] !== '"') throw new Error("invalid JSON");
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const character = text[index];
      index += 1;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') {
        return JSON.parse(text.slice(start, index));
      }
    }
    throw new Error("invalid JSON");
  };
  const value = (depth) => {
    if (depth > 16) throw new Error("invalid JSON");
    whitespace();
    if (text[index] === '"') return string();
    if (text[index] === "{") {
      index += 1;
      whitespace();
      const result = Object.create(null);
      const keys = new Set();
      if (text[index] === "}") {
        index += 1;
        return result;
      }
      while (index < text.length) {
        const key = string();
        if (keys.has(key) || typeof key !== "string") {
          throw new Error("invalid JSON");
        }
        keys.add(key);
        whitespace();
        if (text[index] !== ":") throw new Error("invalid JSON");
        index += 1;
        result[key] = value(depth + 1);
        whitespace();
        if (text[index] === "}") {
          index += 1;
          return result;
        }
        if (text[index] !== ",") throw new Error("invalid JSON");
        index += 1;
        whitespace();
      }
      throw new Error("invalid JSON");
    }
    if (text[index] === "[") {
      index += 1;
      whitespace();
      const result = [];
      if (text[index] === "]") {
        index += 1;
        return result;
      }
      while (index < text.length) {
        result.push(value(depth + 1));
        whitespace();
        if (text[index] === "]") {
          index += 1;
          return result;
        }
        if (text[index] !== ",") throw new Error("invalid JSON");
        index += 1;
      }
      throw new Error("invalid JSON");
    }
    for (const [token, parsed] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ]) {
      if (text.startsWith(token, index)) {
        index += token.length;
        return parsed;
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      text.slice(index),
    );
    if (!number) throw new Error("invalid JSON");
    index += number[0].length;
    return JSON.parse(number[0]);
  };
  const result = value(0);
  whitespace();
  if (index !== text.length) throw new Error("invalid JSON");
  return result;
}

async function runCommandLine(argv) {
  const names = new Set();
  const values = Object.create(null);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const argument = argv[index + 1];
    if (
      !["--run-options", "--post-ledger", "--cli-path", "--project-path"]
        .includes(name) ||
      names.has(name) ||
      typeof argument !== "string"
    ) {
      throw new Error("invalid command line");
    }
    names.add(name);
    values[name] = argument;
  }
  if (names.size !== 4) throw new Error("invalid command line");
  const optionsText = await readBoundedUtf8(
    path.resolve(values["--run-options"]),
  );
  const rawOptions = parseBoundedJson(optionsText);
  const safeOptions = snapshotRunnerOptions(rawOptions);
  const dependencies = createMiniprogramAutomatorDependencies({
    candidate: safeOptions.candidate,
    executionDate: safeOptions.executionDate,
    launchOptions: {
      cliPath: values["--cli-path"],
      projectPath: values["--project-path"],
    },
    postLedgerPath: path.resolve(values["--post-ledger"]),
  });
  return runBookingLifecycle(safeOptions, dependencies);
}

if (require.main === module) {
  runCommandLine(process.argv.slice(2)).then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = result.status === "PASS" ? 0 : 1;
    },
    () => {
      process.stdout.write(
        `${JSON.stringify(blocked("AUTOMATOR_CONFIGURATION_INVALID"))}\n`,
      );
      process.exitCode = 1;
    },
  );
}

module.exports = {
  runBookingLifecycle,
  writeSafeEvidence,
};

import { Buffer } from "node:buffer";
import { types as utilTypes } from "node:util";
import { pathToFileURL } from "node:url";

const commitPattern = /^[0-9a-f]{40}$/;
const maximumInputBytes = 16 * 1024;
const gateNames = Object.freeze([
  "check",
  "audit",
  "openapi",
  "wechatide",
  "automator",
  "manual",
  "phone",
  "wsl",
]);
const manifestKeys = Object.freeze(["commit", "wxTree", "pages", "migrations", ...gateNames]);
const nonReadyStates = Object.freeze([
  "BLOCKED_TEST_ACCOUNT",
  "BLOCKED_API",
  "BLOCKED_AUTOMATOR_RC",
  "BLOCKED_DATA_WINDOW",
  "BLOCKED_PHYSICAL_UAT",
  "BLOCKED_DEPENDENCY_AUDIT",
  "FAILED_PRODUCT",
]);
const statePriority = Object.freeze([
  "FAILED_PRODUCT",
  "BLOCKED_DEPENDENCY_AUDIT",
  "BLOCKED_TEST_ACCOUNT",
  "BLOCKED_API",
  "BLOCKED_AUTOMATOR_RC",
  "BLOCKED_DATA_WINDOW",
  "BLOCKED_PHYSICAL_UAT",
]);
const gateStates = new Set(["PASS", ...nonReadyStates]);

export const CANDIDATE_STATES = Object.freeze(["READY", ...nonReadyStates]);

function invalidManifest() {
  const error = new Error("Invalid Slice 5 candidate manifest");
  error.code = "INVALID_CANDIDATE_MANIFEST";
  return error;
}

function readExactManifest(value) {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) {
    throw invalidManifest();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidManifest();
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== manifestKeys.length ||
    ownKeys.some((key) => typeof key !== "string") ||
    manifestKeys.some((key) => !ownKeys.includes(key))
  ) {
    throw invalidManifest();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = Object.create(null);
  for (const key of manifestKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      throw invalidManifest();
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function summarizeValidatedManifest(manifest) {
  if (
    typeof manifest.commit !== "string" ||
    !commitPattern.test(manifest.commit) ||
    typeof manifest.wxTree !== "string" ||
    !commitPattern.test(manifest.wxTree) ||
    manifest.pages !== 9 ||
    manifest.migrations !== 6 ||
    gateNames.some((gate) => typeof manifest[gate] !== "string" || !gateStates.has(manifest[gate]))
  ) {
    throw invalidManifest();
  }
  const nonPass = gateNames
    .filter((gate) => manifest[gate] !== "PASS")
    .map((gate) => ({ gate, state: manifest[gate] }));
  const state =
    statePriority.find((candidate) =>
      nonPass.some(({ state: gateState }) => gateState === candidate),
    ) || "READY";

  return {
    state,
    commit: manifest.commit,
    wxTree: manifest.wxTree,
    pages: manifest.pages,
    migrations: manifest.migrations,
    passedChecks: gateNames.length - nonPass.length,
    nonPass,
  };
}

export function summarizeCandidateManifest(value) {
  try {
    return summarizeValidatedManifest(readExactManifest(value));
  } catch {
    throw invalidManifest();
  }
}

function skipJsonWhitespace(text, start) {
  let index = start;
  while (
    index < text.length &&
    (text[index] === " " || text[index] === "\t" || text[index] === "\r" || text[index] === "\n")
  ) {
    index += 1;
  }
  return index;
}

function readJsonString(text, start) {
  if (text[start] !== '"') {
    throw invalidManifest();
  }
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      const end = index + 1;
      return { end, value: JSON.parse(text.slice(start, end)) };
    }
  }
  throw invalidManifest();
}

function readJsonPrimitive(text, start) {
  if (text[start] === '"') {
    return readJsonString(text, start);
  }
  const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(start));
  if (match === null) {
    throw invalidManifest();
  }
  return {
    end: start + match[0].length,
    value: JSON.parse(match[0]),
  };
}

function parseExplicitManifestJson(text) {
  let index = skipJsonWhitespace(text, 0);
  if (text[index] !== "{") {
    throw invalidManifest();
  }
  index = skipJsonWhitespace(text, index + 1);
  const result = Object.create(null);
  const keys = new Set();
  if (text[index] === "}") {
    index = skipJsonWhitespace(text, index + 1);
    if (index !== text.length) {
      throw invalidManifest();
    }
    return result;
  }

  while (index < text.length) {
    const keyToken = readJsonString(text, index);
    if (keys.has(keyToken.value)) {
      throw invalidManifest();
    }
    keys.add(keyToken.value);
    index = skipJsonWhitespace(text, keyToken.end);
    if (text[index] !== ":") {
      throw invalidManifest();
    }
    index = skipJsonWhitespace(text, index + 1);
    const valueToken = readJsonPrimitive(text, index);
    result[keyToken.value] = valueToken.value;
    index = skipJsonWhitespace(text, valueToken.end);
    if (text[index] === "}") {
      index = skipJsonWhitespace(text, index + 1);
      if (index !== text.length) {
        throw invalidManifest();
      }
      return result;
    }
    if (text[index] !== ",") {
      throw invalidManifest();
    }
    index = skipJsonWhitespace(text, index + 1);
    if (text[index] === "}") {
      throw invalidManifest();
    }
  }
  throw invalidManifest();
}

async function readExplicitJsonInput() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text, "utf8") > maximumInputBytes) {
      throw invalidManifest();
    }
  }
  if (text.trim() === "") {
    throw invalidManifest();
  }
  return parseExplicitManifestJson(text);
}

async function runCli() {
  if (process.argv.length !== 2) {
    throw invalidManifest();
  }
  const input = await readExplicitJsonInput();
  const summary = summarizeCandidateManifest(input);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

const isCli =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isCli) {
  try {
    await runCli();
  } catch {
    process.stderr.write("SLICE5_CANDIDATE_INVALID\n");
    process.exitCode = 1;
  }
}

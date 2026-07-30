import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CANDIDATE_STATES, summarizeCandidateManifest } from "./verify-slice-5-candidate.mjs";

const commit = "a111111111111111111111111111111111111111";
const wxTree = "b222222222222222222222222222222222222222";
const nonReadyStates = [
  "BLOCKED_TEST_ACCOUNT",
  "BLOCKED_API",
  "BLOCKED_AUTOMATOR_RC",
  "BLOCKED_DATA_WINDOW",
  "BLOCKED_PHYSICAL_UAT",
  "BLOCKED_DEPENDENCY_AUDIT",
  "FAILED_PRODUCT",
];

function validManifest(overrides = {}) {
  return {
    commit,
    wxTree,
    pages: 9,
    migrations: 6,
    check: "PASS",
    audit: "PASS",
    openapi: "PASS",
    wechatide: "PASS",
    automator: "PASS",
    manual: "PASS",
    phone: "PASS",
    wsl: "PASS",
    ...overrides,
  };
}

function assertInvalid(value) {
  assert.throws(
    () => summarizeCandidateManifest(value),
    (error) =>
      error instanceof Error &&
      error.code === "INVALID_CANDIDATE_MANIFEST" &&
      error.message === "Invalid Slice 5 candidate manifest",
  );
}

test("exports the exact overall candidate-state enum", () => {
  assert.deepEqual(CANDIDATE_STATES, [
    "READY",
    "BLOCKED_TEST_ACCOUNT",
    "BLOCKED_API",
    "BLOCKED_AUTOMATOR_RC",
    "BLOCKED_DATA_WINDOW",
    "BLOCKED_PHYSICAL_UAT",
    "BLOCKED_DEPENDENCY_AUDIT",
    "FAILED_PRODUCT",
  ]);
  assert.ok(Object.isFrozen(CANDIDATE_STATES));
});

test("summarizes an all-pass fixed candidate as READY without returning raw input", () => {
  const input = validManifest();
  const summary = summarizeCandidateManifest(input);

  assert.deepEqual(summary, {
    state: "READY",
    commit,
    wxTree,
    pages: 9,
    migrations: 6,
    passedChecks: 8,
    nonPass: [],
  });
  assert.notEqual(summary, input);
  assert.deepEqual(Object.keys(summary), [
    "state",
    "commit",
    "wxTree",
    "pages",
    "migrations",
    "passedChecks",
    "nonPass",
  ]);
});

test("accepts a null-prototype manifest containing only own data", () => {
  const input = Object.assign(Object.create(null), validManifest());

  assert.equal(summarizeCandidateManifest(input).state, "READY");
});

test("preserves every blocker and product failure instead of letting PASS offset it", () => {
  const cases = [
    ["wechatide", "BLOCKED_TEST_ACCOUNT"],
    ["openapi", "BLOCKED_API"],
    ["automator", "BLOCKED_AUTOMATOR_RC"],
    ["wsl", "BLOCKED_DATA_WINDOW"],
    ["manual", "BLOCKED_PHYSICAL_UAT"],
    ["audit", "BLOCKED_DEPENDENCY_AUDIT"],
    ["check", "FAILED_PRODUCT"],
  ];

  for (const [gate, state] of cases) {
    const summary = summarizeCandidateManifest(validManifest({ [gate]: state }));
    assert.equal(summary.state, state);
    assert.equal(summary.passedChecks, 7);
    assert.deepEqual(summary.nonPass, [{ gate, state }]);
  }
});

test("uses fixed severity priority and still reports every simultaneous non-pass gate", () => {
  const summary = summarizeCandidateManifest(
    validManifest({
      check: "BLOCKED_PHYSICAL_UAT",
      audit: "BLOCKED_DEPENDENCY_AUDIT",
      openapi: "BLOCKED_API",
      wechatide: "BLOCKED_TEST_ACCOUNT",
      automator: "BLOCKED_AUTOMATOR_RC",
      manual: "BLOCKED_DATA_WINDOW",
      phone: "FAILED_PRODUCT",
    }),
  );

  assert.equal(summary.state, "FAILED_PRODUCT");
  assert.equal(summary.passedChecks, 1);
  assert.deepEqual(summary.nonPass, [
    { gate: "check", state: "BLOCKED_PHYSICAL_UAT" },
    { gate: "audit", state: "BLOCKED_DEPENDENCY_AUDIT" },
    { gate: "openapi", state: "BLOCKED_API" },
    { gate: "wechatide", state: "BLOCKED_TEST_ACCOUNT" },
    { gate: "automator", state: "BLOCKED_AUTOMATOR_RC" },
    { gate: "manual", state: "BLOCKED_DATA_WINDOW" },
    { gate: "phone", state: "FAILED_PRODUCT" },
  ]);
});

test("rejects identity, count, status, missing-key, and unknown-key drift", () => {
  for (const input of [
    validManifest({ commit: commit.toUpperCase() }),
    validManifest({ commit: "not-a-commit" }),
    validManifest({ wxTree: "not-a-tree" }),
    validManifest({ pages: 8 }),
    validManifest({ pages: "9" }),
    validManifest({ migrations: 5 }),
    validManifest({ migrations: "6" }),
    validManifest({ audit: "READY" }),
    validManifest({ audit: "BLOCKED" }),
    validManifest({ audit: "FAIL" }),
    { ...validManifest(), extra: "PASS" },
    Object.fromEntries(Object.entries(validManifest()).filter(([key]) => key !== "phone")),
  ]) {
    assertInvalid(input);
  }
});

test("rejects arrays, functions, class instances, inherited records, getters, Proxies, and symbols", () => {
  class Candidate {
    constructor() {
      Object.assign(this, validManifest());
    }
  }
  const inherited = Object.create(validManifest());
  const getter = validManifest();
  Object.defineProperty(getter, "check", {
    enumerable: true,
    get() {
      throw new Error("secret getter payload");
    },
  });
  const proxy = new Proxy(validManifest(), {
    ownKeys() {
      throw new Error("secret proxy payload");
    },
  });
  const symbol = validManifest();
  symbol[Symbol("token-secret")] = "secret-value";

  for (const input of [
    null,
    [],
    () => validManifest(),
    new Candidate(),
    inherited,
    getter,
    proxy,
    symbol,
  ]) {
    assertInvalid(input);
  }
});

test("rejects sensitive and prototype-dangerous fields without exposing their values", () => {
  const forbiddenKeys = [
    "token",
    "AppID",
    "account",
    "user",
    "orderUUID",
    "key",
    "coords",
    "inventory",
    "__proto__",
    "prototype",
    "constructor",
  ];

  for (const forbiddenKey of forbiddenKeys) {
    const input = validManifest();
    Object.defineProperty(input, forbiddenKey, {
      configurable: true,
      enumerable: true,
      value: `private-${forbiddenKey}-value`,
      writable: true,
    });
    assertInvalid(input);
  }
  for (const input of [
    validManifest({ commit: "token=private-credential" }),
    validManifest({ wxTree: "wx1234567890abcdef" }),
    validManifest({ check: "order=40000000-0000-4000-8000-000000000001" }),
    validManifest({ pages: 37 }),
  ]) {
    assertInvalid(input);
  }
});

test("does not invoke malicious traps or getters while rejecting input", () => {
  let getterReads = 0;
  let proxyTraps = 0;
  const getter = validManifest();
  Object.defineProperty(getter, "check", {
    enumerable: true,
    get() {
      getterReads += 1;
      return "PASS";
    },
  });
  const proxy = new Proxy(validManifest(), {
    getPrototypeOf() {
      proxyTraps += 1;
      return Object.prototype;
    },
    ownKeys() {
      proxyTraps += 1;
      return [];
    },
  });

  assertInvalid(getter);
  assertInvalid(proxy);
  assert.equal(getterReads, 0);
  assert.equal(proxyTraps, 0);
});

test("CLI accepts one explicit stdin JSON document and prints only the safe summary", () => {
  const result = spawnSync(process.execPath, ["scripts/verify-slice-5-candidate.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    input: JSON.stringify(validManifest({ manual: "BLOCKED_PHYSICAL_UAT" })),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    state: "BLOCKED_PHYSICAL_UAT",
    commit,
    wxTree,
    pages: 9,
    migrations: 6,
    passedChecks: 7,
    nonPass: [{ gate: "manual", state: "BLOCKED_PHYSICAL_UAT" }],
  });
});

test("CLI rejects missing or unsafe JSON with a constant non-leaking error", () => {
  const secret = "token-private-value";
  for (const options of [
    { input: "", args: [JSON.stringify(validManifest())] },
    { input: "{broken-json", args: [] },
    {
      input: JSON.stringify({ ...validManifest(), token: secret }),
      args: [],
    },
  ]) {
    const result = spawnSync(
      process.execPath,
      ["scripts/verify-slice-5-candidate.mjs", ...options.args],
      {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: { ...process.env, SLICE5_TEST_TOKEN: secret },
        input: options.input,
      },
    );

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "SLICE5_CANDIDATE_INVALID\n");
    assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
  }
});

test("CLI rejects duplicate gate keys so a later PASS cannot erase a blocker", () => {
  const base = JSON.stringify(validManifest());
  for (const input of [
    base.replace('"check":"PASS"', '"check":"FAILED_PRODUCT","check":"PASS"'),
    base.replace('"check":"PASS"', '"check":"FAILED_PRODUCT","\\u0063heck":"PASS"'),
  ]) {
    const result = spawnSync(process.execPath, ["scripts/verify-slice-5-candidate.mjs"], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      input,
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "SLICE5_CANDIDATE_INVALID\n");
  }
});

test("package exposes the fixed candidate verification command", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );

  assert.equal(
    packageJson.scripts["verify:slice5:candidate"],
    "node scripts/verify-slice-5-candidate.mjs",
  );
  assert.equal(nonReadyStates.length, 7);
});

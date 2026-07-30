import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import process from "node:process";
import test from "node:test";

import {
  automatedRepositoryCommands,
  externalRuntimeChecks,
  resolveCorepackLauncher,
  runPhaseZeroVerification,
  validateExpectedOutput,
} from "./verify-phase-0.mjs";

test("resolves the public Corepack launcher beside Node on Windows and POSIX", () => {
  assert.deepEqual(
    resolveCorepackLauncher(
      "C:\\node\\node.exe",
      "win32",
      (path) => path === "C:\\node\\corepack.cmd",
    ),
    {
      kind: "windows-cmd",
      path: "C:\\node\\corepack.cmd",
    },
  );
  assert.deepEqual(
    resolveCorepackLauncher(
      "/opt/node/bin/node",
      "linux",
      (path) => path === "/opt/node/bin/corepack",
    ),
    {
      kind: "executable",
      path: "/opt/node/bin/corepack",
    },
  );
});

test("reports the expected public Corepack launcher when it is missing", () => {
  assert.throws(
    () => resolveCorepackLauncher("/opt/node/bin/node", "linux", () => false),
    /Corepack launcher not found next to Node executable: \/opt\/node\/bin\/corepack/,
  );
});

test("runs the deterministic repository checks in the required order with audit last", async () => {
  assert.deepEqual(
    automatedRepositoryCommands.map(({ label }) => label),
    [
      "Corepack pnpm version",
      "Workspace contract",
      "Workspace contract tests",
      "Local infrastructure static contracts",
      "Container static contracts",
      "CI static contracts",
      "Phase 0 document contracts",
      "Formatting",
      "Lint",
      "Typecheck",
      "Tests",
      "Build",
      "Built API runtime smoke",
      "Built frontend artifact smoke",
      "Dependency audit",
    ],
  );

  const observed = [];
  await runPhaseZeroVerification({
    run: async (command) => {
      observed.push(command.label);
      return 0;
    },
    log: () => {},
  });

  assert.deepEqual(
    observed,
    automatedRepositoryCommands.map(({ label }) => label),
  );
  assert.equal(observed.at(-1), "Dependency audit");
});

test("runs every pnpm command through Corepack and verifies the exact pnpm version first", () => {
  const pnpmCommands = automatedRepositoryCommands.filter(({ label }) =>
    [
      "Corepack pnpm version",
      "Formatting",
      "Lint",
      "Typecheck",
      "Tests",
      "Build",
      "Dependency audit",
    ].includes(label),
  );
  for (const command of pnpmCommands) {
    if (process.platform === "win32") {
      assert.equal(command.executable.toLowerCase(), process.env.ComSpec?.toLowerCase());
      assert.deepEqual(command.arguments.slice(0, 3), ["/d", "/s", "/c"]);
      assert.match(command.arguments[3], /\\corepack\.cmd"\s+pnpm(?:\s|$)/i);
    } else {
      assert.match(command.executable, /[\\/]corepack$/);
      assert.equal(command.arguments[0], "pnpm");
    }
  }
  assert.match(pnpmCommands[0].arguments.at(-1), /pnpm(?:\s+--version$|$)/);
  assert.equal(pnpmCommands[0].expectedOutput, "11.17.0");
});

test("keeps the frozen Taro reference outside default Phase 0 commands", () => {
  for (const command of automatedRepositoryCommands) {
    const serialized = JSON.stringify(command);
    assert.doesNotMatch(serialized, /@stay-fable\/consumer-miniapp/);
    assert.doesNotMatch(serialized, /\bbuild:(?:alipay|tt|weapp)\b/);
  }
});

test("keeps root Phase 0 gate scripts free of filters for the frozen package", async () => {
  const rootPackage = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );

  for (const script of ["build", "lint", "test", "typecheck"]) {
    assert.doesNotMatch(rootPackage.scripts[script], /@stay-fable\/consumer-miniapp/);
  }
});

test("rejects an unexpected Corepack pnpm version with both versions in the message", () => {
  const command = automatedRepositoryCommands[0];

  assert.throws(
    () => validateExpectedOutput(command, "11.9.0"),
    /Corepack pnpm version expected 11\.17\.0, received 11\.9\.0/,
  );
});

test("stops immediately and rejects when any repository command fails", async () => {
  const observed = [];

  await assert.rejects(
    () =>
      runPhaseZeroVerification({
        run: async (command) => {
          observed.push(command.label);
          return command.label === "CI static contracts" ? 7 : 0;
        },
        log: () => {},
      }),
    /CI static contracts.*exit code 7/i,
  );

  assert.deepEqual(observed, [
    "Corepack pnpm version",
    "Workspace contract",
    "Workspace contract tests",
    "Local infrastructure static contracts",
    "Container static contracts",
    "CI static contracts",
  ]);
});

test("lists external runtime gates as unverified rather than accepted", () => {
  assert.ok(externalRuntimeChecks.length >= 6);
  for (const gate of externalRuntimeChecks) {
    assert.equal(gate.status, "Blocked");
    assert.doesNotMatch(gate.detail, /\b(?:passed|accepted)\b/i);
  }
});

test("prints both verification scopes even when an automated check blocks the run", async () => {
  const messages = [];

  await assert.rejects(() =>
    runPhaseZeroVerification({
      run: async () => 1,
      log: (message) => messages.push(message),
    }),
  );

  assert.ok(messages.includes("=== Automated repository checks ==="));
  assert.ok(messages.includes("=== External runtime checks (not executed by this verifier) ==="));
  assert.ok(messages.some((message) => message.startsWith("Blocked: Docker Compose")));
});

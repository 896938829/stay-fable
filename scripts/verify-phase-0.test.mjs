import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import {
  automatedRepositoryCommands,
  externalRuntimeChecks,
  runPhaseZeroVerification,
  validateExpectedOutput,
} from "./verify-phase-0.mjs";

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
      "Build Alipay mini-program",
      "Build Douyin mini-program",
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
      "Build Alipay mini-program",
      "Build Douyin mini-program",
      "Dependency audit",
    ].includes(label),
  );
  for (const command of pnpmCommands) {
    assert.equal(command.executable, process.execPath);
    assert.match(command.arguments[0], /corepack[\\/]dist[\\/]corepack\.js$/);
    assert.equal(command.arguments[1], "pnpm");
  }
  assert.deepEqual(pnpmCommands[0].arguments.slice(1), ["pnpm", "--version"]);
  assert.equal(pnpmCommands[0].expectedOutput, "11.17.0");
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

import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import {
  automatedRepositoryCommands,
  externalRuntimeChecks,
  runPhaseZeroVerification,
} from "./verify-phase-0.mjs";

test("runs the deterministic repository checks in the required order with audit last", async () => {
  assert.deepEqual(
    automatedRepositoryCommands.map(({ label }) => label),
    [
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

test("uses the Windows command processor for pnpm scripts without enabling spawn shell mode", () => {
  if (process.platform !== "win32") return;

  const pnpmCommands = automatedRepositoryCommands.filter(({ label }) =>
    ["Formatting", "Lint", "Typecheck", "Tests", "Build", "Dependency audit"].includes(label),
  );
  for (const command of pnpmCommands) {
    assert.equal(command.executable.toLowerCase(), process.env.ComSpec?.toLowerCase());
    assert.deepEqual(command.arguments.slice(0, 3), ["/d", "/s", "/c"]);
    assert.match(command.arguments[3], /^pnpm /);
  }
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

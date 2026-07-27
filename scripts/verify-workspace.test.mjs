import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const rootUrl = new URL("../", import.meta.url);

test("declares the root workspace contract", async () => {
  const root = JSON.parse(await readFile(new URL("package.json", rootUrl), "utf8"));
  const workspace = await readFile(new URL("pnpm-workspace.yaml", rootUrl), "utf8");

  assert.equal(root.private, true);
  assert.equal(root.packageManager, "pnpm@11.17.0");
  assert.match(workspace, /^\s*-\s+["']?apps\/\*["']?\s*$/m);
  assert.match(workspace, /^\s*-\s+["']?packages\/\*["']?\s*$/m);
  assert.equal(root.scripts.verify, "node scripts/verify-workspace.mjs");
  assert.equal(root.scripts.test, "node --test scripts/*.test.mjs && turbo run test");
});

test("activates reproducible pnpm project settings", async () => {
  const workspace = await readFile(new URL("pnpm-workspace.yaml", rootUrl), "utf8");
  const lockfile = await readFile(new URL("pnpm-lock.yaml", rootUrl), "utf8");

  assert.match(workspace, /^autoInstallPeers:\s+false$/m);
  assert.match(workspace, /^engineStrict:\s+true$/m);
  assert.match(workspace, /^injectWorkspacePackages:\s+true$/m);
  assert.match(workspace, /^strictPeerDependencies:\s+true$/m);
  assert.doesNotMatch(workspace, /frozenLockfile|frozen-lockfile/);
  await assert.rejects(() => readFile(new URL(".npmrc", rootUrl)), { code: "ENOENT" });
  assert.match(lockfile, /^\s+autoInstallPeers:\s+false$/m);
  assert.match(lockfile, /^\s+injectWorkspacePackages:\s+true$/m);
});

test("excludes approved generated and planning artifacts from Prettier", async () => {
  const prettierIgnore = await readFile(new URL(".prettierignore", rootUrl), "utf8");

  assert.match(prettierIgnore, /^pnpm-lock\.yaml$/m);
  assert.match(prettierIgnore, /^docs\/superpowers\/$/m);
});

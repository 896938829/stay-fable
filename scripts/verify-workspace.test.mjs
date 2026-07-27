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
});

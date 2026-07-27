import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const rootUrl = new URL("../", import.meta.url);
const root = JSON.parse(await readFile(new URL("package.json", rootUrl), "utf8"));

assert.equal(root.packageManager, "pnpm@11.17.0");
assert.equal(root.engines?.node, ">=24 <25");

const requiredPaths = [
  "apps/api-server/package.json",
  "apps/job-worker/package.json",
  "apps/management-web/package.json",
  "apps/consumer-miniapp/package.json",
  "packages/api-contracts/package.json",
  "packages/validation/package.json",
  "scripts/verify-phase-0.mjs",
  "scripts/verify-phase-0.test.mjs",
  "docs/operations/phase-0-verification.md",
  "infrastructure/cloud/cloudbase-run.md",
  "infrastructure/runbooks/backup-restore.md",
];

await Promise.all(requiredPaths.map((path) => access(new URL(path, rootUrl))));

console.log("Workspace contract verified.");

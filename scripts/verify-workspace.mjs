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
  "wx/project.config.json",
  "wx/app.json",
  "packages/api-contracts/package.json",
  "packages/validation/package.json",
  "scripts/check-wx-project.mjs",
  "scripts/check-wx-project.test.mjs",
  "scripts/verify-phase-0.mjs",
  "scripts/verify-phase-0.test.mjs",
  "scripts/api-runtime-child.mjs",
  "scripts/smoke-api-runtime.mjs",
  "scripts/smoke-frontend-artifacts.mjs",
  "docs/operations/phase-0-verification.md",
  "infrastructure/cloud/cloudbase-run.md",
  "infrastructure/runbooks/backup-restore.md",
  "AGENTS.md",
];

await Promise.all(requiredPaths.map((path) => access(new URL(path, rootUrl))));

console.log("Workspace contract verified.");

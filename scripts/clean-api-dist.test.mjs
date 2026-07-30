import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

import { assertApiDistTarget, cleanApiDist } from "./clean-api-dist.mjs";

const execFileAsync = promisify(execFile);
const rootUrl = new URL("../", import.meta.url);
const rootPath = fileURLToPath(rootUrl);
const apiDistUrl = new URL("apps/api-server/dist/", rootUrl);
const apiDistPath = fileURLToPath(apiDistUrl);
const scriptPath = fileURLToPath(new URL("scripts/clean-api-dist.mjs", rootUrl));

test("cleans only the fixed API dist target", async () => {
  await mkdir(apiDistUrl, { recursive: true });
  await writeFile(new URL("stale-sentinel.js", apiDistUrl), "stale");

  await cleanApiDist();

  await assert.rejects(() => readFile(new URL("stale-sentinel.js", apiDistUrl)), {
    code: "ENOENT",
  });
});

test("rejects the workspace root and every non-API-dist target", () => {
  assert.throws(() => assertApiDistTarget(rootPath, rootPath), /fixed API dist/);
  assert.throws(
    () => assertApiDistTarget(rootPath, fileURLToPath(new URL("apps/api-server/", rootUrl))),
    /fixed API dist/,
  );
  assert.doesNotThrow(() => assertApiDistTarget(rootPath, apiDistPath));
});

test("does not expose a command-line path argument", async () => {
  await assert.rejects(
    () =>
      execFileAsync(process.execPath, [scriptPath, rootPath], {
        cwd: rootPath,
        windowsHide: true,
      }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /does not accept arguments/);
      return true;
    },
  );
});

test.after(async () => {
  await rm(apiDistUrl, { recursive: true, force: true });
});

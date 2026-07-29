import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const powershellPath = new URL("./wsl-runtime-validation.ps1", import.meta.url);
const bashPath = new URL("./wsl-runtime-validation.sh", import.meta.url);
const bootstrapPath = new URL("./wsl-database-bootstrap.ps1", import.meta.url);

test("uses the host Prisma engine and preserves the bounded Slice 2 runtime gates", async () => {
  const [powershell, bash, bootstrap] = await Promise.all([
    readFile(powershellPath, "utf8"),
    readFile(bashPath, "utf8"),
    readFile(bootstrapPath, "utf8"),
  ]);

  assert.doesNotMatch(powershell, /deploy[^\r\n]+migration/);
  assert.doesNotMatch(bash, /artifact_root\/migration/);
  assert.doesNotMatch(bash, /docker build/);
  assert.match(bash, /wsl-database-bootstrap\.ps1/);
  assert.match(bash, /pwsh\.exe/);
  assert.match(bootstrap, /prisma:migrate/);
  assert.match(bootstrap, /prisma:seed/);
  assert.match(bootstrap, /127\.0\.0\.1/);
  assert.match(bash, /127\.0\.0\.1:3000:3000/);
  assert.match(bash, /verify-slice-1-runtime\.mjs/);
  assert.match(
    bash,
    /verify-slice-1-runtime\.mjs[\s\S]*verify-slice-2-runtime\.mjs[\s\S]*for minute in \$\(seq 1 10\)/,
  );
  assert.match(
    bash,
    /-v "\$repo_root\/scripts\/verify-slice-2-runtime\.mjs:\/verify-slice-2-runtime\.mjs:ro"/,
  );
  assert.match(bash, /node \/verify-slice-2-runtime\.mjs/);
  assert.match(bash, /for minute in \$\(seq 1 10\)/);
  assert.match(bash, /SLICE2_RUNTIME_READY http:\/\/127\.0\.0\.1:3000/);
  assert.match(bash, /SLICE2_RUNTIME_STABLE_10_MINUTES/);
  assert.match(bash, /SLICE2_RUNTIME_CLEANUP_COMPLETE/);
  assert.doesNotMatch(bash, /SLICE1_RUNTIME_(READY|STABLE_10_MINUTES|CLEANUP_COMPLETE)/);
  assert.match(bash, /compose_project='stay-fable-wsl-validation'/);
  assert.match(bash, /lock_container='stay-fable-wsl-validation-lock'/);
  assert.match(
    bash,
    /docker create --name "\$lock_container"[\s\S]*stay-fable\.validation-token=\$VALIDATION_TOKEN/,
  );
  assert.match(
    bash,
    /if \[ "\$lock_owned" = true \]; then[\s\S]*docker inspect[\s\S]*stay-fable\.validation-token[\s\S]*docker rm "\$lock_container"/,
  );
});

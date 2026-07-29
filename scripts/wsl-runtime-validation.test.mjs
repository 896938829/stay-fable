import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const powershellPath = new URL("./wsl-runtime-validation.ps1", import.meta.url);
const bashPath = new URL("./wsl-runtime-validation.sh", import.meta.url);
const bootstrapPath = new URL("./wsl-database-bootstrap.ps1", import.meta.url);
const sliceThreeVerifierPath = new URL("./verify-slice-3-runtime.mjs", import.meta.url);

test("uses the host Prisma engine and preserves the bounded Slice 2 runtime gates", async () => {
  const [powershell, bash, bootstrap, sliceThreeVerifier] = await Promise.all([
    readFile(powershellPath, "utf8"),
    readFile(bashPath, "utf8"),
    readFile(bootstrapPath, "utf8"),
    readFile(sliceThreeVerifierPath, "utf8"),
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
    /verify-slice-1-runtime\.mjs[\s\S]*verify-slice-2-runtime\.mjs[\s\S]*verify-slice-3-runtime\.mjs[\s\S]*for minute in \$\(seq 1 10\)/,
  );
  assert.match(
    bash,
    /-v "\$repo_root\/scripts\/verify-slice-2-runtime\.mjs:\/verify-slice-2-runtime\.mjs:ro"/,
  );
  assert.match(bash, /node \/verify-slice-2-runtime\.mjs/);
  assert.match(
    bash,
    /-v "\$repo_root\/scripts\/verify-slice-3-runtime\.mjs:\/verify-slice-3-runtime\.mjs:ro"/,
  );
  assert.match(
    bash,
    /docker run -d --name "\$api_container"[\s\S]*--user node --read-only[\s\S]*verify-slice-3-runtime\.mjs/,
  );
  assert.match(bash, /docker exec[\s\S]*node \/verify-slice-3-runtime\.mjs/);
  assert.match(bash, /docker exec[\s\S]*--user node[\s\S]*node \/verify-slice-3-runtime\.mjs/);
  assert.match(bash, /-e "DATABASE_URL=\$database_url"/);
  assert.match(bash, /for minute in \$\(seq 1 10\)/);
  assert.match(bash, /SLICE2_RUNTIME_READY http:\/\/127\.0\.0\.1:3000/);
  assert.match(bash, /SLICE2_RUNTIME_STABLE_10_MINUTES/);
  assert.match(bash, /SLICE2_RUNTIME_CLEANUP_COMPLETE/);
  for (const marker of [
    "SLICE3_QUOTE_CREATED",
    "SLICE3_IDEMPOTENT_REPLAY",
    "SLICE3_LAST_ROOM_SERIALIZED",
    "SLICE3_MULTI_NIGHT_ROLLED_BACK",
    "SLICE3_QUOTE_CHANGED_NO_HOLD",
    "SLICE3_QUOTE_EXPIRED_NO_HOLD",
    "SLICE3_UAT_READY",
  ]) {
    assert.match(sliceThreeVerifier, new RegExp(marker));
  }
  assert.match(sliceThreeVerifier, /mock:slice-3-runtime-owner-a/);
  assert.match(sliceThreeVerifier, /mock:slice-3-runtime-owner-b/);
  assert.match(sliceThreeVerifier, /30000000-0000-4000-8000-000000000002/);
  assert.match(sliceThreeVerifier, /barrierTimeoutMs = options\.barrierTimeoutMs \?\? 5_000/);
  assert.match(sliceThreeVerifier, /AbortSignal\.timeout/);
  assert.match(sliceThreeVerifier, /statement_timeout/);
  assert.match(sliceThreeVerifier, /lock_timeout/);
  assert.match(sliceThreeVerifier, /\$1/);
  assert.match(sliceThreeVerifier, /SLICE3_RUNTIME_VALIDATION_FAILED/);
  assert.doesNotMatch(
    sliceThreeVerifier,
    /console\.(?:log|error)\([^)]*(?:access_token|userId|sql)/,
  );
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
  assert.match(bash, /trap 'cleanup_validation \$\?' EXIT/);
  assert.match(bash, /docker compose[\s\S]*down/);
  assert.doesNotMatch(bash, /down\s+--volumes/);
  assert.doesNotMatch(bash, /rims-postgres|vigorous_jang/);
});

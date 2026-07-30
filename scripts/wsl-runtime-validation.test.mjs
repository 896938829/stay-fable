import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const powershellPath = new URL("./wsl-runtime-validation.ps1", import.meta.url);
const bashPath = new URL("./wsl-runtime-validation.sh", import.meta.url);
const bootstrapPath = new URL("./wsl-database-bootstrap.ps1", import.meta.url);
const sliceThreeVerifierPath = new URL("./verify-slice-3-runtime.mjs", import.meta.url);
const sliceFourVerifierPath = new URL("./verify-slice-4-runtime.mjs", import.meta.url);

const sliceThreeRuntimeHelper = async () => {
  const bash = (await readFile(bashPath, "utf8")).replaceAll("\r\n", "\n");
  const helper = bash.match(/run_slice_three_runtime_validation\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(helper, "Slice 3 runtime helper must be defined");
  return helper;
};

const runSliceThreeRuntimeHelper = async ({ diagnosticExit = 0, execExit }) => {
  const helper = await sliceThreeRuntimeHelper();
  const script = `
set -Eeuo pipefail
${helper}
docker() {
  printf 'DOCKER_CALL:%s\\n' "$*" >&2
  case "$1" in
    exec) return ${execExit} ;;
    inspect|logs) return ${diagnosticExit} ;;
    *) return 0 ;;
  esac
}
run_slice_three_runtime_validation api-container worker-container database-url
`;
  const command =
    process.platform === "win32"
      ? { file: "wsl.exe", arguments: ["-d", "Ubuntu-22.04", "--", "bash", "-s"] }
      : { file: "bash", arguments: ["-s"] };
  return spawnSync(command.file, command.arguments, {
    encoding: "utf8",
    input: script,
  });
};

const sliceFourRuntimeHelper = async () => {
  const bash = (await readFile(bashPath, "utf8")).replaceAll("\r\n", "\n");
  const redactor = bash.match(/redact_slice_four_diagnostics\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
  const helper = bash.match(/run_slice_four_runtime_validation\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(helper, "Slice 4 runtime helper must be defined");
  return `${redactor}\n${helper}`;
};

const runSliceFourRuntimeHelper = async ({
  diagnosticExit = 0,
  diagnosticPayload = "",
  execExit,
}) => {
  const helper = await sliceFourRuntimeHelper();
  const encodedPayload = Buffer.from(diagnosticPayload).toString("base64");
  const script = `
set -Eeuo pipefail
${helper}
docker() {
  printf 'DOCKER_CALL:%s\\n' "$*" >&2
  case "$1" in
    exec) return ${execExit} ;;
    inspect) return ${diagnosticExit} ;;
    logs)
      printf '%s' '${encodedPayload}' | base64 --decode
      return ${diagnosticExit}
      ;;
    *) return 0 ;;
  esac
}
run_slice_four_runtime_validation api-container worker-container database-url
`;
  const command =
    process.platform === "win32"
      ? { file: "wsl.exe", arguments: ["-d", "Ubuntu-22.04", "--", "bash", "-s"] }
      : { file: "bash", arguments: ["-s"] };
  return spawnSync(command.file, command.arguments, {
    encoding: "utf8",
    input: script,
  });
};

test("prints diagnostics only when Slice 3 runtime validation fails", async () => {
  const success = await runSliceThreeRuntimeHelper({ execExit: 0 });
  assert.equal(success.status, 0, success.stderr);
  assert.doesNotMatch(success.stderr, /SLICE3_RUNTIME_DIAGNOSTICS/);
  assert.doesNotMatch(success.stderr, /DOCKER_CALL:(?:inspect|logs)/);

  const failure = await runSliceThreeRuntimeHelper({ execExit: 125 });
  assert.equal(failure.status, 125, failure.stderr);
  assert.match(failure.stderr, /SLICE3_RUNTIME_DIAGNOSTICS/);
  assert.match(failure.stderr, /DOCKER_CALL:inspect/);
  assert.match(failure.stderr, /DOCKER_CALL:logs --tail 200 api-container/);
  assert.match(failure.stderr, /DOCKER_CALL:logs --tail 200 worker-container/);
});

test("diagnostic failures do not mask the original Slice 3 runtime exit code", async () => {
  const failure = await runSliceThreeRuntimeHelper({
    diagnosticExit: 42,
    execExit: 137,
  });
  assert.equal(failure.status, 137, failure.stderr);
  assert.match(failure.stderr, /SLICE3_RUNTIME_DIAGNOSTICS/);
  assert.match(failure.stderr, /DOCKER_CALL:inspect/);
  assert.match(failure.stderr, /DOCKER_CALL:logs --tail 200 api-container/);
  assert.match(failure.stderr, /DOCKER_CALL:logs --tail 200 worker-container/);
});

test("prints Slice 4 diagnostics only on failure and preserves the verifier exit code", async () => {
  const success = await runSliceFourRuntimeHelper({ execExit: 0 });
  assert.equal(success.status, 0, success.stderr);
  assert.doesNotMatch(success.stderr, /SLICE4_RUNTIME_DIAGNOSTICS/);
  assert.doesNotMatch(success.stderr, /DOCKER_CALL:(?:inspect|logs)/);

  const failure = await runSliceFourRuntimeHelper({ diagnosticExit: 42, execExit: 137 });
  assert.equal(failure.status, 137, failure.stderr);
  assert.match(failure.stderr, /SLICE4_RUNTIME_DIAGNOSTICS/);
  assert.match(failure.stderr, /DOCKER_CALL:inspect/);
  assert.match(failure.stderr, /DOCKER_CALL:logs --tail 200 api-container/);
  assert.match(failure.stderr, /DOCKER_CALL:logs --tail 200 worker-container/);
});

test("redacts identifiers and credentials from Slice 4 failure diagnostics", async () => {
  const secrets = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "slice4-secret-idempotency-key-000001",
    "opaque-access-token-secret",
    "opaque-refresh-token-secret",
    "plain-authorization-token-secret",
    "plain-token-value-secret",
    "postgres-literal-idempotency-key",
  ];
  const diagnosticPayload = [
    JSON.stringify({
      req: {
        url: `/api/v1/dev/payments/${secrets[0]}/simulate`,
        headers: {
          authorization: `Bearer ${secrets[3]}`,
          "idempotency-key": secrets[2],
        },
      },
      user_id: secrets[1],
      payment_id: secrets[0],
      access_token: secrets[3],
      refresh_token: secrets[4],
      message: "database constraint failed",
    }),
    `DETAIL: Key (booking_id, idempotency_key)=(${secrets[0]}, ${secrets[7]}) already exists.`,
    `Authorization: Bearer ${secrets[5]}`,
    `access_token: ${secrets[3]}`,
    `refresh-token: ${secrets[4]}`,
    `token: ${secrets[6]}`,
    `idempotency_key: ${secrets[2]}`,
    "tokenization worker reported an ordinary error",
    "",
  ].join("\n");
  const failure = await runSliceFourRuntimeHelper({
    diagnosticPayload,
    execExit: 137,
  });

  assert.equal(failure.status, 137, failure.stderr);
  for (const secret of secrets) {
    assert.doesNotMatch(failure.stderr, new RegExp(secret));
  }
  assert.match(failure.stderr, /database constraint failed/);
  assert.match(failure.stderr, /tokenization worker reported an ordinary error/);
  assert.match(failure.stderr, /Key \(booking_id, idempotency_key\)=/);
  assert.match(failure.stderr, /\[REDACTED_(?:UUID|SECRET)\]/);
});

test("uses the host Prisma engine and preserves the bounded Slice 2 runtime gates", async () => {
  const [powershell, bash, bootstrap, sliceThreeVerifier, sliceFourVerifier] = await Promise.all([
    readFile(powershellPath, "utf8"),
    readFile(bashPath, "utf8"),
    readFile(bootstrapPath, "utf8"),
    readFile(sliceThreeVerifierPath, "utf8"),
    readFile(sliceFourVerifierPath, "utf8"),
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
    /verify-slice-1-runtime\.mjs[\s\S]*verify-slice-2-runtime\.mjs[\s\S]*verify-slice-3-runtime\.mjs[\s\S]*verify-slice-4-runtime\.mjs[\s\S]*for minute in \$\(seq 1 10\)/,
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
  assert.match(
    bash,
    /-v "\$repo_root\/scripts\/verify-slice-4-runtime\.mjs:\/verify-slice-4-runtime\.mjs:ro"/,
  );
  assert.match(bash, /docker exec[\s\S]*--user node[\s\S]*node \/verify-slice-4-runtime\.mjs/);
  assert.match(bash, /ENABLE_MOCK_PAYMENT=true/);
  assert.match(bash, /BOOKING_EXPIRY_POLL_MS=1000/);
  assert.match(bash, /SLICE3_RUNTIME_DIAGNOSTICS/);
  assert.match(bash, /SLICE4_RUNTIME_DIAGNOSTICS/);
  assert.match(bash, /docker inspect[\s\S]*State\.Status[\s\S]*RestartCount/);
  assert.match(bash, /docker logs --tail 200 "\$slice3_api_container"/);
  assert.match(bash, /docker logs --tail 200 "\$slice3_worker_container"/);
  assert.match(bash, /-e "DATABASE_URL=\$database_url"/);
  assert.match(powershell, /verify-slice-4-runtime\.mjs/);
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
  for (const marker of [
    "SLICE4_BOOKING_QUERY_ISOLATED",
    "SLICE4_MOCK_FAILURE_IDEMPOTENT",
    "SLICE4_MOCK_SUCCESS_CONFIRMED",
    "SLICE4_CANCEL_RELEASED",
    "SLICE4_LIFECYCLE_RACE_SERIALIZED",
    "SLICE4_WORKER_EXPIRY_RELEASED",
    "SLICE4_UAT_READY http://127.0.0.1:3000",
  ]) {
    assert.match(sliceFourVerifier, new RegExp(marker.replaceAll("/", "\\/")));
  }
  assert.match(sliceFourVerifier, /mock:slice-4-runtime-owner-a/);
  assert.match(sliceFourVerifier, /mock:slice-4-runtime-owner-b/);
  assert.match(sliceFourVerifier, /workerTimeoutDefault = 30_000/);
  assert.match(sliceFourVerifier, /DELETE FROM payment USING booking/);
  assert.match(sliceFourVerifier, /DELETE FROM booking_status_history history USING booking/);
  assert.match(sliceFourVerifier, /DELETE FROM inventory_hold hold USING booking/);
  assert.match(sliceFourVerifier, /DELETE FROM user_identity/);
  assert.doesNotMatch(
    sliceFourVerifier,
    /console\.(?:log|error)\([^)]*(?:access_token|userId|bookingId|paymentId|idempotencyKey)/,
  );
  assert.match(sliceThreeVerifier, /mock:slice-3-runtime-owner-a/);
  assert.match(sliceThreeVerifier, /mock:slice-3-runtime-owner-b/);
  assert.match(sliceThreeVerifier, /30000000-0000-4000-8000-000000000002/);
  assert.match(sliceThreeVerifier, /barrierTimeoutMs = options\.barrierTimeoutMs \?\? 5_000/);
  assert.match(sliceThreeVerifier, /AbortSignal\.timeout/);
  assert.match(sliceThreeVerifier, /statement_timeout/);
  assert.match(sliceThreeVerifier, /lock_timeout/);
  assert.match(sliceThreeVerifier, /\$1/);
  assert.match(sliceThreeVerifier, /SLICE3_RUNTIME_VALIDATION_FAILED/);
  const lockHelper = sliceThreeVerifier.slice(
    sliceThreeVerifier.indexOf("const lockFixtureRows"),
    sliceThreeVerifier.indexOf("const deleteOwnerData"),
  );
  assert.ok(lockHelper.indexOf("FOR UPDATE OF property, room") >= 0);
  assert.ok(
    lockHelper.indexOf("FOR UPDATE OF price") > lockHelper.indexOf("FOR UPDATE OF property, room"),
  );
  assert.ok(
    lockHelper.indexOf("FOR UPDATE OF inventory") > lockHelper.indexOf("FOR UPDATE OF price"),
  );
  assert.match(
    sliceThreeVerifier,
    /async resetInventory[\s\S]*lockFixtureRows[\s\S]*assertNoForeignOccupancy[\s\S]*deleteOwnerData/,
  );
  assert.match(sliceThreeVerifier, /sale_price_cents = \$[0-9][\s\S]*rack_price_cents = \$[0-9]/);
  assert.match(
    sliceThreeVerifier,
    /total_inventory = \$[0-9][\s\S]*held_inventory = \$[0-9][\s\S]*sold_inventory = \$[0-9][\s\S]*version = \$[0-9]/,
  );
  assert.doesNotMatch(sliceThreeVerifier, /SET[\s\S]{0,200}version\s*=\s*\$[0-9]/);
  assert.match(sliceThreeVerifier, /version = inventory\.version \+ 1/);
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

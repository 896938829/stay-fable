import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const powershellPath = new URL("./wsl-runtime-validation.ps1", import.meta.url);
const powershellScriptPath = decodeURIComponent(powershellPath.pathname).replace(
  /^\/([A-Za-z]:)/,
  "$1",
);
const bashPath = new URL("./wsl-runtime-validation.sh", import.meta.url);
const bootstrapPath = new URL("./wsl-database-bootstrap.ps1", import.meta.url);
const bootstrapScriptPath = decodeURIComponent(bootstrapPath.pathname).replace(
  /^\/([A-Za-z]:)/,
  "$1",
);
const sliceThreeVerifierPath = new URL("./verify-slice-3-runtime.mjs", import.meta.url);
const sliceFourVerifierPath = new URL("./verify-slice-4-runtime.mjs", import.meta.url);

const wslPathHelper = async () => {
  const powershell = await readFile(powershellPath, "utf8");
  const helper = powershell.match(/function ConvertTo-WslDrvfsPath \{[\s\S]*?\r?\n\}/)?.[0];
  assert.ok(helper, "WSL drvfs path helper must be defined");
  return helper;
};

const wslPathContainmentHelper = async () => {
  const powershell = await readFile(powershellPath, "utf8");
  const helper = powershell.match(/function Test-WslPathInsideRoot \{[\s\S]*?\r?\n\}/)?.[0];
  assert.ok(helper, "WSL path containment helper must be defined");
  return helper;
};

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

const stableWindowHelpers = async () => {
  const bash = (await readFile(bashPath, "utf8")).replaceAll("\r\n", "\n");
  const gate = bash.match(/await_stable_window_gate\(\) \{[\s\S]*?\n\}/)?.[0];
  const observe = bash.match(/observe_worker_stability\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(gate, "stable-window gate helper must be defined");
  assert.ok(observe, "worker stability helper must be defined");
  return `${gate}\n${observe}`;
};

const cleanupHelper = async () => {
  const bash = (await readFile(bashPath, "utf8")).replaceAll("\r\n", "\n");
  const helper = bash.match(/cleanup_validation\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(helper, "cleanup helper must be defined");
  return helper;
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
  assert.match(bootstrap, /\[string\]\$CatalogStartDate/);
  assert.match(
    bootstrap,
    /\$env:STAY_FABLE_CATALOG_START_DATE = \$CatalogStartDate[\s\S]*prisma:seed/,
  );
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
  assert.match(
    bash,
    /-e "SLICE2_CHECKIN=\$catalog_checkin"[\s\S]*-e "SLICE2_CHECKOUT=\$catalog_checkout"[\s\S]*node \/verify-slice-2-runtime\.mjs/,
  );
  assert.match(
    bash,
    /-CatalogStartDate "\$catalog_checkin"[\s\S]*SLICE2_CHECKIN=\$catalog_checkin/,
  );
  assert.doesNotMatch(bash, /verify-slice-2-runtime\.mjs[\s\S]{0,300}(?:2026-07-30|2026-08-01)/);
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

test("starts a complete ten-minute Worker window only after the owner-bound START gate", async () => {
  const helpers = await stableWindowHelpers();
  const owner = "a".repeat(32);
  const script = `
set -Eeuo pipefail
${helpers}
gate="$(mktemp)"
rm -- "$gate"
STABLE_GATE_PATH="$gate"
STABLE_GATE_OWNER_TOKEN="${owner}"
sleep_calls=0
sleep() {
  sleep_calls=$((sleep_calls + 1))
  if [ "$sleep_calls" -eq 601 ]; then
    printf '%s\\n' "${owner} START" >"$gate"
    echo 'AUTOMATOR_TERMINAL_AFTER_601_POLLS'
  fi
}
docker() {
  case "$1:$2" in
    inspect:--format)
      case "$3" in
        *Running*) printf 'true\\n' ;;
        *RestartCount*) printf '0\\n' ;;
      esac
      ;;
    logs:*) return 0 ;;
    *) return 0 ;;
  esac
}
await_stable_window_gate
observe_worker_stability worker-container
echo 'SIMULATED_STABLE'
rm -f -- "$gate"
`;
  const command =
    process.platform === "win32"
      ? { file: "wsl.exe", arguments: ["-d", "Ubuntu-22.04", "--", "bash", "-s"] }
      : { file: "bash", arguments: ["-s"] };
  const execution = spawnSync(command.file, command.arguments, {
    encoding: "utf8",
    input: script,
    timeout: 5_000,
  });

  assert.equal(execution.status, 0, execution.stderr);
  const output = execution.stdout.trim().split(/\r?\n/);
  const terminalIndex = output.indexOf("AUTOMATOR_TERMINAL_AFTER_601_POLLS");
  const minuteLines = output.filter((line) => /^Worker observation minute \d+\/10 /.test(line));
  assert.ok(terminalIndex >= 0);
  assert.equal(minuteLines.length, 10);
  assert.equal(minuteLines[0].includes("minute 1/10"), true);
  assert.equal(minuteLines[9].includes("minute 10/10"), true);
  assert.ok(output.indexOf(minuteLines[0]) > terminalIndex);
  assert.ok(output.indexOf("SIMULATED_STABLE") > output.indexOf(minuteLines[9]));
  assert.equal(output.includes("SLICE2_RUNTIME_CLEANUP_COMPLETE"), false);
});

test("ABORT gate exits without a stable marker", async () => {
  const helpers = await stableWindowHelpers();
  const owner = "b".repeat(32);
  const script = `
set -Eeuo pipefail
${helpers}
gate="$(mktemp)"
printf '%s\\n' "${owner} ABORT" >"$gate"
STABLE_GATE_PATH="$gate"
STABLE_GATE_OWNER_TOKEN="${owner}"
if await_stable_window_gate; then
  echo 'UNEXPECTED_GATE_SUCCESS'
  exit 99
else
  status=$?
fi
rm -f -- "$gate"
exit "$status"
`;
  const command =
    process.platform === "win32"
      ? { file: "wsl.exe", arguments: ["-d", "Ubuntu-22.04", "--", "bash", "-s"] }
      : { file: "bash", arguments: ["-s"] };
  const execution = spawnSync(command.file, command.arguments, {
    encoding: "utf8",
    input: script,
  });

  assert.equal(execution.status, 125, execution.stderr);
  assert.doesNotMatch(execution.stdout, /STABLE|CLEANUP_COMPLETE|UNEXPECTED/);
});

test("owner-bound gate wait times out instead of hanging forever", async () => {
  const helpers = await stableWindowHelpers();
  const owner = "c".repeat(32);
  const script = `
set -Eeuo pipefail
${helpers}
gate="$(mktemp)"
rm -- "$gate"
STABLE_GATE_PATH="$gate"
STABLE_GATE_OWNER_TOKEN="${owner}"
STABLE_GATE_TIMEOUT_SECONDS=3
sleep() { :; }
if await_stable_window_gate; then
  echo 'UNEXPECTED_GATE_SUCCESS'
  exit 99
else
  status=$?
fi
rm -f -- "$gate"
exit "$status"
`;
  const command =
    process.platform === "win32"
      ? { file: "wsl.exe", arguments: ["-d", "Ubuntu-22.04", "--", "bash", "-s"] }
      : { file: "bash", arguments: ["-s"] };
  const execution = spawnSync(command.file, command.arguments, {
    encoding: "utf8",
    input: script,
    timeout: 5_000,
  });

  assert.equal(execution.status, 124, execution.stderr);
  assert.match(execution.stderr, /gate wait timed out/i);
  assert.doesNotMatch(execution.stdout, /STABLE|CLEANUP_COMPLETE|UNEXPECTED/);
});

test("PowerShell exposes the optional stable gate to WSL without changing default behavior", async () => {
  const [powershell, bash] = await Promise.all([
    readFile(powershellPath, "utf8"),
    readFile(bashPath, "utf8"),
  ]);

  assert.match(powershell, /\[string\]\$StableGatePath/);
  assert.match(powershell, /\[string\]\$StableGateOwnerToken/);
  assert.match(powershell, /STABLE_GATE_PATH=/);
  assert.match(powershell, /STABLE_GATE_OWNER_TOKEN=/);
  assert.match(powershell, /\[switch\]\$CleanupOnly/);
  assert.match(powershell, /CLEANUP_ONLY=true/);
  assert.match(
    powershell,
    /\$wslValidationStarted = \$true\s+wsl\.exe -d \$Distro --exec env `\s+"VALIDATION_TOKEN=\$validationToken" `\s+"REPO_ROOT=\$repoWsl" `\s+"ARTIFACT_ROOT=\$runtimeWsl"/,
  );
  assert.match(
    powershell,
    /\$runtimeOwned -and\s+\(\s+-not \$wslValidationStarted -or\s+\$wslCleanupConfirmed\s+\)/,
  );
  assert.match(bash, /printf '%s OWNER=%s\\n' "\$marker" "\$STABLE_GATE_OWNER_TOKEN"/);
  assert.match(bash, /compose_project="\$\{compose_project\}-\$\{VALIDATION_TOKEN\}"/);
  assert.match(
    bash,
    /expected_validation_root="\$validation_root"[\s\S]*if \[ "\$validation_root" != "\$expected_validation_root" \]/,
  );
  assert.match(bash, /if \[ "\$\{CLEANUP_ONLY:-false\}" = true \]/);
  assert.match(bash, /if \[ -z "\$\{STABLE_GATE_PATH:-\}" \]; then[\s\S]*return 0/);
  assert.match(
    bash,
    /SLICE2_RUNTIME_READY http:\/\/127\.0\.0\.1:3000[\s\S]*await_stable_window_gate[\s\S]*observe_worker_stability/,
  );
});

test("derives the rolling Slice 2 window from the Asia Shanghai calendar", async () => {
  const bash = (await readFile(bashPath, "utf8")).replaceAll("\r\n", "\n");
  const helper = bash.match(/set_catalog_runtime_dates\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(helper, "catalog runtime date helper must be defined");
  const script = `
set -Eeuo pipefail
${helper}
date() {
  if [ "\${TZ:-}" != 'Asia/Shanghai' ]; then
    printf 'wrong timezone: %s\\n' "\${TZ:-unset}" >&2
    return 91
  fi
  case "$*" in
    '+%F') printf '%s\\n' '2032-02-29' ;;
    '-d 2032-02-29 +2 days +%F') printf '%s\\n' '2032-03-02' ;;
    *) printf 'unexpected date arguments: %s\\n' "$*" >&2; return 92 ;;
  esac
}
set_catalog_runtime_dates
printf 'CHECKIN=%s\\nCHECKOUT=%s\\n' "$catalog_checkin" "$catalog_checkout"
`;
  const execution = spawnSync("wsl.exe", ["-d", "Ubuntu-22.04", "--exec", "bash", "-s"], {
    encoding: "utf8",
    input: script,
    timeout: 5_000,
  });

  assert.equal(execution.status, 0, execution.stderr);
  assert.match(execution.stdout, /^CHECKIN=2032-02-29$/m);
  assert.match(execution.stdout, /^CHECKOUT=2032-03-02$/m);
});

test("rejects a partially invalid rolling Slice 2 window", async () => {
  const bash = (await readFile(bashPath, "utf8")).replaceAll("\r\n", "\n");
  const helper = bash.match(/set_catalog_runtime_dates\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(helper, "catalog runtime date helper must be defined");
  const script = `
set -Eeuo pipefail
${helper}
date() {
  case "$*" in
    '+%F') printf '%s\\n' '2032-02-29' ;;
    '-d 2032-02-29 +2 days +%F') printf '%s\\n' 'not-a-date' ;;
    *) return 92 ;;
  esac
}
if set_catalog_runtime_dates; then
  printf 'INVALID_WINDOW_ACCEPTED\\n'
  exit 99
fi
`;
  const execution = spawnSync("wsl.exe", ["-d", "Ubuntu-22.04", "--exec", "bash", "-s"], {
    encoding: "utf8",
    input: script,
    timeout: 5_000,
  });

  assert.equal(execution.status, 0, execution.stderr);
  assert.match(execution.stderr, /Unable to derive the bounded Slice 2 catalog window/);
  assert.doesNotMatch(execution.stdout, /INVALID_WINDOW_ACCEPTED/);
});

test("bootstrap validates the seed date and precisely restores its prior environment state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stay-fable-bootstrap-date-"));
  try {
    const invocation = `
$ErrorActionPreference = 'Stop'
$repo = ${JSON.stringify(root)}
$global:ObservedSeedDates = [System.Collections.Generic.List[string]]::new()
function git {
  $global:LASTEXITCODE = 0
  return $repo
}
function corepack {
  $global:LASTEXITCODE = 0
  if ([string]$args[-1] -eq 'prisma:seed') {
    $observedDate = if (Test-Path Env:STAY_FABLE_CATALOG_START_DATE) {
      [string]$env:STAY_FABLE_CATALOG_START_DATE
    } else {
      '<ABSENT>'
    }
    $global:ObservedSeedDates.Add($observedDate)
  }
}
$env:STAY_FABLE_CATALOG_START_DATE = '1999-12-31'
& ${JSON.stringify(bootstrapScriptPath)} -RepoRoot $repo
if ($env:STAY_FABLE_CATALOG_START_DATE -ne '1999-12-31') {
  throw 'ambient catalog start date was not restored after default seed'
}
& ${JSON.stringify(bootstrapScriptPath)} -RepoRoot $repo -CatalogStartDate '2032-02-29'
if ($env:STAY_FABLE_CATALOG_START_DATE -ne '1999-12-31') {
  throw 'existing catalog start date was not restored'
}
Remove-Item Env:STAY_FABLE_CATALOG_START_DATE
& ${JSON.stringify(bootstrapScriptPath)} -RepoRoot $repo -CatalogStartDate '2033-03-01'
if (Test-Path Env:STAY_FABLE_CATALOG_START_DATE) {
  throw 'previously absent catalog start date was not removed'
}
foreach ($invalidDate in @('2032-02-30', '9999-11-03', '9999-12-31')) {
  try {
    & ${JSON.stringify(bootstrapScriptPath)} -RepoRoot $repo -CatalogStartDate $invalidDate
    throw "invalid catalog start date unexpectedly succeeded: $invalidDate"
  }
  catch {
    if ($_.Exception.Message -like 'invalid catalog start date unexpectedly succeeded:*') {
      throw
    }
    if ($_.Exception.Message -notmatch '(?:real YYYY-MM-DD|four-digit year)') { throw }
  }
}
$global:ObservedSeedDates | ConvertTo-Json -Compress
`;
    const execution = spawnSync("powershell.exe", ["-NoProfile", "-Command", invocation], {
      encoding: "utf8",
      timeout: 10_000,
    });

    assert.equal(execution.status, 0, execution.stderr);
    assert.deepEqual(JSON.parse(execution.stdout.trim()), ["<ABSENT>", "2032-02-29", "2033-03-01"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "uses only direct WSL exec boundaries and preserves every downstream environment value",
  { skip: process.platform !== "win32" },
  async () => {
    const powershell = await readFile(powershellPath, "utf8");
    const probe = "/mnt/e/$HOME/$(printf probe)/" + "`printf probe`";
    const owner = "a".repeat(32);
    const pythonSink = [
      "import json, os",
      "keys = json.loads(os.environ['SINK_KEYS'])",
      "print(json.dumps({key: os.environ[key] for key in keys}, sort_keys=True))",
    ].join("; ");
    const invokeSink = (values) => {
      const keys = Object.keys(values);
      return spawnSync(
        "wsl.exe",
        [
          "-d",
          "Ubuntu-22.04",
          "--exec",
          "env",
          `SINK_KEYS=${JSON.stringify(keys)}`,
          ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
          "python3",
          "-c",
          pythonSink,
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
    };
    const normalValues = {
      VALIDATION_TOKEN: owner,
      REPO_ROOT: `${probe}/repo`,
      ARTIFACT_ROOT: `${probe}/repo/.wsl-runtime`,
      STABLE_GATE_PATH: `${probe}/owner/stable-window.gate`,
      STABLE_GATE_OWNER_TOKEN: owner,
    };
    const cleanupValues = {
      VALIDATION_TOKEN: owner,
      REPO_ROOT: `${probe}/repo`,
      STABLE_GATE_OWNER_TOKEN: owner,
      CLEANUP_ONLY: "true",
    };

    const normal = invokeSink(normalValues);
    const cleanup = invokeSink(cleanupValues);

    assert.equal(normal.status, 0, normal.stderr);
    assert.deepEqual(JSON.parse(normal.stdout.trim()), normalValues);
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.deepEqual(JSON.parse(cleanup.stdout.trim()), cleanupValues);
    assert.equal(
      (powershell.match(/wsl\.exe -d \$Distro --exec env/g) ?? []).length,
      2,
      "normal and cleanup runtime calls must both use --exec env",
    );
    assert.equal(
      (powershell.match(/wsl\.exe -d \$Distro --exec wslpath/g) ?? []).length,
      1,
      "path conversion must keep its one direct --exec boundary",
    );
    assert.doesNotMatch(powershell, /wsl\.exe -d \$Distro -- (?:env|bash)\b/);
  },
);

test(
  "converts spaced and unspaced Windows paths through real WSL",
  { skip: process.platform !== "win32" },
  async () => {
    const helper = await wslPathHelper();
    const invocation = `
${helper}
$cPath = ConvertTo-WslDrvfsPath -Distro 'Ubuntu-22.04' -WindowsPath 'C:\\Users\\Public'
$ePath = ConvertTo-WslDrvfsPath -Distro 'Ubuntu-22.04' -WindowsPath 'E:\\My Work\\stay-fable'
"C_PATH=$cPath"
"E_PATH=$ePath"
`;
    const execution = spawnSync("powershell.exe", ["-NoProfile", "-Command", invocation], {
      encoding: "utf8",
      timeout: 10_000,
    });

    assert.equal(execution.status, 0, execution.stderr);
    assert.match(execution.stdout, /^C_PATH=\/mnt\/c\/Users\/Public$/m);
    assert.match(execution.stdout, /^E_PATH=\/mnt\/e\/My Work\/stay-fable$/m);
  },
);

test(
  "passes shell metacharacters literally to real WSL without shell evaluation",
  { skip: process.platform !== "win32" },
  async () => {
    const helper = await wslPathHelper();
    const specialWindowsPath = "C:\\Users\\Public\\$HOME\\$(printf probe)\\" + "`printf probe`";
    const encodedPath = Buffer.from(specialWindowsPath).toString("base64");
    const invocation = `
${helper}
$specialPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))
ConvertTo-WslDrvfsPath -Distro 'Ubuntu-22.04' -WindowsPath $specialPath
`;
    const execution = spawnSync("powershell.exe", ["-NoProfile", "-Command", invocation], {
      encoding: "utf8",
      timeout: 10_000,
    });

    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(
      execution.stdout.trim(),
      "/mnt/c/Users/Public/$HOME/$(printf probe)/" + "`printf probe`",
    );
  },
);

test("normalizes separators and passes wslpath arguments through --exec", async () => {
  const helper = await wslPathHelper();
  const invocation = `
${helper}
$global:ReceivedWslArguments = [System.Collections.Generic.List[string]]::new()
function wsl.exe {
  $global:ReceivedWslArguments.Add(($args -join [char]31))
  & $env:ComSpec /c exit 0
  if ([string]$args[-1] -like 'C:*') { return '/mnt/c/Users/Public' }
  return '/mnt/e/My Work/stay-fable'
}
$null = ConvertTo-WslDrvfsPath -Distro 'Ubuntu-22.04' -WindowsPath 'C:\\Users\\Public'
$null = ConvertTo-WslDrvfsPath -Distro 'Ubuntu-22.04' -WindowsPath 'E:\\My Work\\stay-fable'
$global:ReceivedWslArguments | ConvertTo-Json -Compress
`;
  const execution = spawnSync("powershell.exe", ["-NoProfile", "-Command", invocation], {
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.equal(execution.status, 0, execution.stderr);
  assert.deepEqual(JSON.parse(execution.stdout.trim()), [
    ["-d", "Ubuntu-22.04", "--exec", "wslpath", "-a", "C:/Users/Public"].join("\u001f"),
    ["-d", "Ubuntu-22.04", "--exec", "wslpath", "-a", "E:/My Work/stay-fable"].join("\u001f"),
  ]);
});

test("rejects null, empty, multiline, malformed, and nonzero wslpath results uniformly", async () => {
  const helper = await wslPathHelper();
  const invocation = `
${helper}
$ErrorActionPreference = 'Stop'
function wsl.exe {
  if ($global:WslResultMode -eq 'nonzero') {
    & $env:ComSpec /c exit 7
    return '/mnt/c/ignored'
  }
  & $env:ComSpec /c exit 0
  switch ($global:WslResultMode) {
    'null' { return $null }
    'empty' { return '' }
    'multiline' { return @('/mnt/c/one', '/mnt/c/two') }
    'malformed' { return 'relative/path' }
  }
}
foreach ($mode in @('null', 'empty', 'multiline', 'malformed', 'nonzero')) {
  $global:WslResultMode = $mode
  try {
    $null = ConvertTo-WslDrvfsPath -Distro 'Ubuntu-22.04' -WindowsPath 'C:\\probe' -FailureMessage 'EXPECTED_FAILURE'
    "$mode=NO_ERROR"
  }
  catch {
    "$mode=$($_.Exception.Message)"
  }
}
`;
  const execution = spawnSync("powershell.exe", ["-NoProfile", "-Command", invocation], {
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.equal(execution.status, 0, execution.stderr);
  assert.deepEqual(execution.stdout.trim().split(/\r?\n/), [
    "null=EXPECTED_FAILURE",
    "empty=EXPECTED_FAILURE",
    "multiline=EXPECTED_FAILURE",
    "malformed=EXPECTED_FAILURE",
    "nonzero=EXPECTED_FAILURE",
  ]);
});

test("accepts children of a drive root while rejecting the root itself and sibling prefixes", async () => {
  const helper = await wslPathContainmentHelper();
  const invocation = `
${helper}
@(
  (Test-WslPathInsideRoot -RootPath '/mnt/e/' -CandidatePath '/mnt/e'),
  (Test-WslPathInsideRoot -RootPath '/mnt/e/' -CandidatePath '/mnt/e/.wsl-runtime'),
  (Test-WslPathInsideRoot -RootPath '/mnt/e/' -CandidatePath '/mnt/example')
) | ConvertTo-Json -Compress
`;
  const execution = spawnSync("powershell.exe", ["-NoProfile", "-Command", invocation], {
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.equal(execution.status, 0, execution.stderr);
  assert.deepEqual(JSON.parse(execution.stdout.trim()), [false, true, false]);
});

test("gated ABORT preserves owner credentials for a successful cleanup-only retry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stay-fable-wsl-abort-"));
  try {
    const owner = "a".repeat(32);
    const ownerRoot = path.join(root, "owner");
    const gatePath = path.join(ownerRoot, "stable-window.gate");
    const verifierPath = path.join(root, "scripts", "verify-slice-4-runtime.mjs");
    const invocation = `
$ErrorActionPreference = 'Stop'
$repo = ${JSON.stringify(root)}
$ownerRoot = ${JSON.stringify(ownerRoot)}
[System.IO.Directory]::CreateDirectory((Split-Path -Parent ${JSON.stringify(verifierPath)})) | Out-Null
[System.IO.File]::WriteAllText(${JSON.stringify(verifierPath)}, '')
[System.IO.Directory]::CreateDirectory($ownerRoot) | Out-Null
[System.IO.File]::WriteAllText((Join-Path $ownerRoot '.slice5-owner'), '${owner}')
Set-Location -LiteralPath $repo
function git {
  $global:LASTEXITCODE = 0
  if ("$args" -eq 'rev-parse --show-toplevel') { return $repo }
  return ''
}
function Get-NetTCPConnection { return $null }
function corepack {
  $global:LASTEXITCODE = 0
  if ($args -contains 'deploy') {
    [System.IO.Directory]::CreateDirectory([string]$args[-1]) | Out-Null
  }
}
$global:WslMode = 'abort'
$global:RuntimeExecCalls = 0
function wsl.exe {
  if ($args -contains 'wslpath') {
    & $env:ComSpec /c exit 0
    if ([string]$args[-1] -like '*.wsl-runtime') {
      return '/mnt/e/stay-fable-test/.wsl-runtime'
    }
    return '/mnt/e/stay-fable-test'
  }
  if ($args -notcontains '--exec') {
    throw 'runtime validation must use a direct WSL exec boundary'
  }
  $global:RuntimeExecCalls++
  if ($global:WslMode -eq 'abort') {
    & $env:ComSpec /c exit 125
    return
  }
  & $env:ComSpec /c exit 0
}
try {
  & ${JSON.stringify(powershellScriptPath)} -Distro 'Ubuntu-22.04' -StableGatePath ${JSON.stringify(gatePath)} -StableGateOwnerToken '${owner}'
  throw 'gated ABORT unexpectedly succeeded'
}
catch {
  if ($_.Exception.Message -eq 'gated ABORT unexpectedly succeeded') { throw }
}
$runtimeMarker = Join-Path $repo '.wsl-runtime/.stay-fable-validation-owner'
if (-not (Test-Path -LiteralPath $runtimeMarker -PathType Leaf)) {
  throw 'fallback owner credential was deleted'
}
if ((Get-Content -LiteralPath $runtimeMarker -Raw) -ne '${owner}') {
  throw 'fallback owner credential changed'
}
$global:WslMode = 'cleanup'
$cleanupOutput = @(
  & ${JSON.stringify(powershellScriptPath)} -Distro 'Ubuntu-22.04' -StableGateOwnerToken '${owner}' -CleanupOnly
)
if ($cleanupOutput -notcontains 'SLICE5_RUNTIME_FALLBACK_CLEANUP_COMPLETE') {
  throw 'fallback completion marker missing'
}
if (Test-Path -LiteralPath (Join-Path $repo '.wsl-runtime')) {
  throw 'fallback runtime directory survived'
}
if ($global:RuntimeExecCalls -ne 2) {
  throw "expected two direct runtime exec calls, got $global:RuntimeExecCalls"
}
'GATED_ABORT_FALLBACK_CLEAN'
`;
    const execution = spawnSync("powershell.exe", ["-NoProfile", "-Command", invocation], {
      encoding: "utf8",
      timeout: 10_000,
    });

    assert.equal(execution.status, 0, execution.stderr);
    assert.match(execution.stdout, /GATED_ABORT_FALLBACK_CLEAN/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup-only removes owner-bound runtime resources when the trap never ran", async () => {
  const cleanup = await cleanupHelper();
  const owner = "d".repeat(32);
  const script = `
set -Eeuo pipefail
${cleanup}
VALIDATION_TOKEN='${owner}'
api_container=api-${owner}
worker_container=worker-${owner}
lock_container=lock-${owner}
compose_started=true
lock_owned=true
validation_root_owned=false
validation_root="$(mktemp -d)"
expected_validation_root="$validation_root"
ownership_marker="$validation_root/.owner"
printf '%s' '${owner}' >"$ownership_marker"
validation_root_owned=true
repo_root=/repo
compose_project=project-${owner}
api_exists=true
worker_exists=true
lock_exists=true
project_exists=true
runtime_marker() { :; }
rm() {
  echo "REMOVED_ROOT:$2" >&2
  command rm "$@"
}
docker() {
  case "$1 $2" in
    "inspect --format")
      printf '%s\\n' '${owner}'
      ;;
    "container inspect")
      case "$3" in
        "$api_container") [ "$api_exists" = true ] ;;
        "$worker_container") [ "$worker_exists" = true ] ;;
        *) return 1 ;;
      esac
      ;;
    "rm -f")
      echo "REMOVED:$3" >&2
      case "$3" in
        "$api_container") api_exists=false ;;
        "$worker_container") worker_exists=false ;;
      esac
      ;;
    "rm $lock_container")
      echo "REMOVED:$lock_container" >&2
      lock_exists=false
      ;;
    "compose --project-name")
      echo "COMPOSE_DOWN:$compose_project"
      project_exists=false
      ;;
    "ps -a")
      if [ "$api_exists" = true ] || [ "$worker_exists" = true ] || [ "$lock_exists" = true ]; then
        printf 'owned-resource\\n'
      fi
      ;;
    "network ls")
      if [ "$project_exists" = true ]; then printf 'owned-network\\n'; fi
      ;;
    *) return 0 ;;
  esac
}
cleanup_validation 0
if [ "$api_exists" = true ] || [ "$worker_exists" = true ] ||
  [ "$lock_exists" = true ] || [ "$project_exists" = true ] ||
  [ -e "$validation_root" ]; then
  exit 99
fi
echo 'OWNER_FALLBACK_CLEAN'
`;
  const command =
    process.platform === "win32"
      ? { file: "wsl.exe", arguments: ["-d", "Ubuntu-22.04", "--", "bash", "-s"] }
      : { file: "bash", arguments: ["-s"] };
  const execution = spawnSync(command.file, command.arguments, {
    encoding: "utf8",
    input: script,
    timeout: 5_000,
  });

  assert.equal(execution.status, 0, execution.stderr);
  assert.match(execution.stdout, /OWNER_FALLBACK_CLEAN/);
  assert.match(execution.stderr, /REMOVED:api-/);
  assert.match(execution.stderr, /REMOVED:worker-/);
  assert.match(execution.stderr, /REMOVED:lock-/);
  assert.match(execution.stderr, /REMOVED_ROOT:/);
  assert.match(execution.stdout, /COMPOSE_DOWN:project-/);
});

test("cleanup-only without an owner lock performs no destructive action", async () => {
  const bash = (await readFile(bashPath, "utf8")).replaceAll("\r\n", "\n");
  const owner = "1".repeat(32);
  const script = `
repo="$(mktemp -d)"
trap 'command rm -rf -- "$repo"' EXIT
docker() {
  case "$1 $2" in
    "container inspect") return 1 ;;
    "ps -a"|"network ls") return 0 ;;
    "rm "*|"compose "*) echo "DESTRUCTIVE:docker $*" ;;
    *) return 0 ;;
  esac
}
rm() { echo "DESTRUCTIVE:rm $*"; }
export VALIDATION_TOKEN='${owner}'
export STABLE_GATE_OWNER_TOKEN='${owner}'
export REPO_ROOT="$repo"
export CLEANUP_ONLY=true
${bash}
`;
  const command =
    process.platform === "win32"
      ? { file: "wsl.exe", arguments: ["-d", "Ubuntu-22.04", "--", "bash", "-s"] }
      : { file: "bash", arguments: ["-s"] };
  const execution = spawnSync(command.file, command.arguments, {
    encoding: "utf8",
    input: script,
    timeout: 5_000,
  });

  assert.equal(execution.status, 1, execution.stderr);
  assert.match(execution.stderr, /owner lock.*unconfirmed/i);
  assert.doesNotMatch(execution.stdout, /DESTRUCTIVE/);
});

test("foreign lock ownership prevents every destructive cleanup action", async () => {
  const cleanup = await cleanupHelper();
  const script = `
set -Eeuo pipefail
${cleanup}
VALIDATION_TOKEN='${"e".repeat(32)}'
api_container=api
worker_container=worker
lock_container=lock
compose_started=true
lock_owned=true
validation_root_owned=false
validation_root=/tmp/stay-fable-wsl-validation
expected_validation_root=/tmp/stay-fable-wsl-validation
ownership_marker="$validation_root/.owner"
repo_root=/repo
compose_project=project
runtime_marker() { :; }
docker() {
  if [ "$1" = inspect ]; then
    printf '%s\\n' '${"f".repeat(32)}'
    return 0
  fi
  case "$*" in
    *" rm "*|rm\\ *|compose\\ *down*) echo "DESTRUCTIVE:$*" ;;
  esac
  return 0
}
rm() { echo "DESTRUCTIVE:rm $*"; }
if cleanup_validation 1; then
  exit 99
else
  status=$?
fi
echo 'FOREIGN_LOCK_RETAINED'
exit "$status"
`;
  const command =
    process.platform === "win32"
      ? { file: "wsl.exe", arguments: ["-d", "Ubuntu-22.04", "--", "bash", "-s"] }
      : { file: "bash", arguments: ["-s"] };
  const execution = spawnSync(command.file, command.arguments, {
    encoding: "utf8",
    input: script,
    timeout: 5_000,
  });

  assert.equal(execution.status, 1, execution.stderr);
  assert.match(execution.stderr, /ownership label mismatch/i);
  assert.doesNotMatch(execution.stdout, /DESTRUCTIVE/);
  assert.match(execution.stdout, /FOREIGN_LOCK_RETAINED/);
});

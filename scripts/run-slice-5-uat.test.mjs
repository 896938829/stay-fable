import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./run-slice-5-uat.ps1", import.meta.url));
const repoRoot = path.dirname(path.dirname(scriptPath));
const commit = "1".repeat(40);
const wxTree = "2".repeat(40);

function quoted(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function runPowerShell(source) {
  const encoded = Buffer.from(`$ErrorActionPreference = 'Stop'\n${source}`, "utf16le").toString(
    "base64",
  );
  return spawnSync(
    process.platform === "win32" ? "powershell.exe" : "pwsh",
    ["-NoProfile", "-EncodedCommand", encoded],
    { encoding: "utf8", timeout: 30_000 },
  );
}

test("coordinates the one owned stable window without container takeover", async () => {
  const source = await readFile(scriptPath, "utf8");
  const startRuntime = source.indexOf("Start-Slice5RuntimeVerifier");
  const readyGate = source.indexOf("SLICE4_UAT_READY");
  const preflight = source.indexOf("Invoke-Slice5TrustedPreflight");
  const pickerGate = source.indexOf("Test-Slice5PhysicalPickerCapability");
  const producer = source.indexOf("Start-Slice5TrustedLedgerProducer");
  const automator = source.indexOf("Start-Slice5Automator");
  const waitRuntime = source.indexOf("Wait-Slice5RuntimeVerifier");

  assert.ok(startRuntime >= 0);
  assert.ok(readyGate > startRuntime);
  assert.ok(preflight > readyGate);
  assert.ok(pickerGate > preflight);
  assert.ok(producer > pickerGate);
  assert.ok(automator > producer);
  assert.ok(waitRuntime > automator);
  assert.match(source, /scripts[\\/]wsl-runtime-validation\.ps1/);
  assert.match(source, /git[\s\S]*rev-parse[\s\S]*HEAD:wx/);
  assert.match(source, /SLICE5_WSL_EXIT_CODE/);
  assert.match(source, /SLICE5_AUTOMATOR_EXIT_CODE/);
  assert.match(source, /finally[\s\S]*Exit-Slice5RunLock/);
  assert.match(source, /SLICE5_CLEANUP_COMPLETE/);
  assert.match(source, /function Get-Slice5LockPath[\s\S]*GetTempPath\(\)/);
  assert.doesNotMatch(source, /Enter-Slice5RunLock -LockPath \(Join-Path \$repoRoot/);
  assert.doesNotMatch(source, /docker\s+(?:stop|kill|rm)|docker\s+compose[\s\S]{0,80}\bdown\b/);
  assert.doesNotMatch(source, /StandardOutput\.ReadLine\(\)/);
  assert.match(source, /StandardOutput\.ReadLineAsync\(\)/);
  assert.match(source, /PendingReadTask/);
  assert.match(source, /TimeoutSeconds/);
  assert.doesNotMatch(source, /Stderr\.GetAwaiter\(\)\.GetResult\(\)/);
  assert.match(source, /Stderr\.IsCompleted/);
  assert.match(source, /Stop-Slice5OwnedProcessTree/);
});

test("bounds a silent verifier while waiting for UAT readiness", () => {
  const invocation = `
. ${quoted(scriptPath)}
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = (Get-Command node -ErrorAction Stop).Source
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.Arguments = Join-Slice5ProcessArguments @('-e', 'setTimeout(() => {}, 10000)')
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
if (-not $process.Start()) { throw 'silent verifier failed to start' }
$runtime = [pscustomobject]@{
  Process = $process
  Stderr = $process.StandardError.ReadToEndAsync()
  Stable = $false
  Cleanup = $false
  Ready = $false
}
$watch = [System.Diagnostics.Stopwatch]::StartNew()
$ready = Wait-Slice5RuntimeReady -Runtime $runtime -TimeoutSeconds 1
$watch.Stop()
if ($ready) { throw 'silent verifier became ready' }
if ($watch.Elapsed.TotalSeconds -gt 3) { throw 'readiness wait was not bounded' }
if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
'READY_WAIT_BOUNDED'
`;
  const execution = runPowerShell(invocation);

  assert.equal(execution.status, 0, execution.stderr);
  assert.match(execution.stdout, /READY_WAIT_BOUNDED/);
});

test("gated readiness ignores legacy and wrong-owner markers", () => {
  const owner = "d".repeat(32);
  const invocation = `
. ${quoted(scriptPath)}
$source = 'console.log("SLICE4_UAT_READY http://127.0.0.1:3000");console.log("SLICE4_UAT_READY http://127.0.0.1:3000 OWNER=wrong");setTimeout(() => console.log("SLICE4_UAT_READY http://127.0.0.1:3000 OWNER=${owner}"), 250);'
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = (Get-Command node -ErrorAction Stop).Source
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.Arguments = Join-Slice5ProcessArguments @('-e', $source)
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
if (-not $process.Start()) { throw 'marker probe failed to start' }
$runtime = [pscustomobject]@{
  Process = $process
  Stderr = $process.StandardError.ReadToEndAsync()
  PendingReadTask = $null
  OwnerToken = '${owner}'
  Stable = $false
  Cleanup = $false
  Ready = $false
}
$watch = [System.Diagnostics.Stopwatch]::StartNew()
$ready = Wait-Slice5RuntimeReady -Runtime $runtime -TimeoutSeconds 2
$watch.Stop()
if (-not $ready) { throw 'bound marker was not accepted' }
if ($watch.ElapsedMilliseconds -lt 200) { throw 'forged marker was accepted' }
$process.WaitForExit()
'OWNER_BOUND_READY_ONLY'
`;
  const execution = runPowerShell(invocation);

  assert.equal(execution.status, 0, execution.stderr);
  assert.match(execution.stdout, /OWNER_BOUND_READY_ONLY/);
});

test("reuses the pending stdout read and terminates the complete silent verifier tree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stay-fable-slice5-tree-"));
  try {
    const childPidPath = path.join(root, "child.pid");
    const parentScriptPath = path.join(root, "silent-parent.cjs");
    await writeFile(
      parentScriptPath,
      `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
fs.writeFileSync(process.argv[2], String(child.pid));
setInterval(() => {}, 1000);
`,
      "utf8",
    );
    const invocation = `
. ${quoted(scriptPath)}
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = (Get-Command node -ErrorAction Stop).Source
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.Arguments = Join-Slice5ProcessArguments @(${quoted(parentScriptPath)}, ${quoted(childPidPath)})
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
if (-not $process.Start()) { throw 'silent verifier tree failed to start' }
$runtime = [pscustomobject]@{
  Process = $process
  Stderr = $process.StandardError.ReadToEndAsync()
  Stable = $false
  Cleanup = $false
  Ready = $false
  PendingReadTask = $null
}
try {
  $ready = Wait-Slice5RuntimeReady -Runtime $runtime -TimeoutSeconds 1
  if ($ready) { throw 'silent verifier became ready' }
  $pending = $runtime.PendingReadTask
  $result = Wait-Slice5RuntimeVerifier -Runtime $runtime -TimeoutSeconds 1
  if ($result.ExitCode -ne 124) { throw 'silent verifier timeout was not preserved' }
  if ($null -eq $pending) { throw 'pending read was not retained' }
  if (-not $process.HasExited) { throw 'verifier wrapper survived' }
  $childPid = [int](Get-Content -LiteralPath ${quoted(childPidPath)} -Raw)
  if (Get-Process -Id $childPid -ErrorAction SilentlyContinue) {
    throw 'verifier child survived'
  }
  'PENDING_READ_REUSED_TREE_STOPPED'
}
finally {
  if (-not $process.HasExited) {
    & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
  }
}
`;
    const execution = runPowerShell(invocation);

    assert.equal(execution.status, 0, execution.stderr);
    assert.match(execution.stdout, /PENDING_READ_REUSED_TREE_STOPPED/);
    assert.doesNotMatch(execution.stderr, /stream is currently in use/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("full Invoke cleans a silent readiness-timeout verifier tree without stable output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stay-fable-slice5-invoke-tree-"));
  try {
    const childPidPath = path.join(root, "child.pid");
    const parentScriptPath = path.join(root, "silent-parent.cjs");
    await writeFile(
      parentScriptPath,
      `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
fs.writeFileSync(process.argv[2], String(child.pid));
setInterval(() => {}, 1000);
`,
      "utf8",
    );
    const invocation = `
. ${quoted(scriptPath)}
$script:RetainedLockPath = ${quoted(path.join(root, "run.lock"))}
function Get-Slice5LockPath {
  param($RepoRoot)
  $null = $RepoRoot
  return $script:RetainedLockPath
}
function Get-Slice5Candidate {
  return [pscustomobject]@{ commit = '${commit}'; wxTree = '${wxTree}' }
}
function Start-Slice5RuntimeVerifier {
  param($RepoRoot, $Distro, $StableGatePath, $StableGateOwnerToken)
  $null = $RepoRoot, $Distro, $StableGatePath, $StableGateOwnerToken
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = (Get-Command node -ErrorAction Stop).Source
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.Arguments = Join-Slice5ProcessArguments @(${quoted(parentScriptPath)}, ${quoted(childPidPath)})
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { throw 'silent verifier tree failed to start' }
  $script:FakeRuntime = [pscustomobject]@{
    Process = $process
    Stderr = $process.StandardError.ReadToEndAsync()
    PendingReadTask = $null
    Stable = $false
    Cleanup = $false
    Ready = $false
  }
  return $script:FakeRuntime
}
$output = @(Invoke-Slice5Uat -Distro 'Ubuntu-22.04' -ExecutionDate '2026-07-31' -RuntimeReadyTimeoutSeconds 1 -RuntimeAbortTimeoutSeconds 1)
if (-not $script:FakeRuntime.Process.HasExited) { throw 'verifier wrapper survived Invoke' }
$childPid = [int](Get-Content -LiteralPath ${quoted(childPidPath)} -Raw)
if (Get-Process -Id $childPid -ErrorAction SilentlyContinue) {
  throw 'verifier child survived Invoke'
}
$lockPath = $script:RetainedLockPath
if (Test-Path -LiteralPath $lockPath) { throw 'Invoke lock survived cleanup' }
if ($output -notcontains 'SLICE5_WSL_EXIT_CODE 124') { throw 'timeout exit marker missing' }
if ($output -notcontains 'SLICE5_AUTOMATOR_EXIT_CODE 125') { throw 'automator exit marker missing' }
if ($output -notcontains 'SLICE5_CLEANUP_COMPLETE') { throw 'cleanup marker missing' }
if ($output -contains 'SLICE5_RUNTIME_STABLE') { throw 'false stable marker emitted' }
'FULL_INVOKE_TIMEOUT_CLEAN'
`;
    const execution = runPowerShell(invocation);

    assert.equal(execution.status, 0, execution.stderr);
    assert.match(execution.stdout, /FULL_INVOKE_TIMEOUT_CLEAN/);
    assert.doesNotMatch(execution.stderr, /stream is currently in use/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("termination failure preserves the owned root and run lock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stay-fable-slice5-termination-failure-"));
  try {
    const childPidPath = path.join(root, "child.pid");
    const parentScriptPath = path.join(root, "hung-parent.cjs");
    await writeFile(
      parentScriptPath,
      `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
fs.writeFileSync(process.argv[2], String(child.pid));
setInterval(() => {}, 1000);
`,
      "utf8",
    );
    const invocation = `
. ${quoted(scriptPath)}
$script:RetainedLockPath = ${quoted(path.join(root, "run.lock"))}
function Get-Slice5LockPath {
  param($RepoRoot)
  $null = $RepoRoot
  return $script:RetainedLockPath
}
function Get-Slice5Candidate {
  return [pscustomobject]@{ commit = '${commit}'; wxTree = '${wxTree}' }
}
function Start-Slice5RuntimeVerifier {
  param($RepoRoot, $Distro, $StableGatePath, $StableGateOwnerToken)
  $null = $RepoRoot, $Distro
  $script:RetainedOwnedRoot = Split-Path -Parent $StableGatePath
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = (Get-Command node -ErrorAction Stop).Source
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.Arguments = Join-Slice5ProcessArguments @(${quoted(parentScriptPath)}, ${quoted(childPidPath)})
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { throw 'hung verifier tree failed to start' }
  $script:RetainedRuntime = [pscustomobject]@{
    Process = $process
    Stderr = $process.StandardError.ReadToEndAsync()
    PendingReadTask = $null
    OwnerToken = $StableGateOwnerToken
    Stable = $false
    Cleanup = $false
    Ready = $false
  }
  return $script:RetainedRuntime
}
function Stop-Slice5OwnedProcessTree {
  throw 'SLICE5_PROCESS_TREE_TERMINATION_FAILED'
}
$lines = [System.Collections.Generic.List[object]]::new()
$thrown = $null
try {
  Invoke-Slice5Uat -Distro 'Ubuntu-22.04' -ExecutionDate '2026-07-31' -RuntimeReadyTimeoutSeconds 1 -RuntimeAbortTimeoutSeconds 1 |
    ForEach-Object { $lines.Add($_) }
}
catch {
  $thrown = $_.Exception.Message
}
$lockPath = $script:RetainedLockPath
try {
  if (-not (Test-Path -LiteralPath $script:RetainedOwnedRoot -PathType Container)) {
    throw 'owned root was deleted after unconfirmed termination'
  }
  if (-not (Test-Path -LiteralPath $lockPath -PathType Container)) {
    throw 'run lock was released after unconfirmed termination'
  }
  if ($lines -notcontains 'SLICE5_BLOCKED PROCESS_TREE_TERMINATION_UNCONFIRMED') {
    throw "dedicated blocked marker missing: $thrown"
  }
  if ($lines -contains 'SLICE5_CLEANUP_COMPLETE') {
    throw 'cleanup completion was falsely emitted'
  }
  if ($lines -contains 'SLICE5_RUNTIME_STABLE') {
    throw 'stable marker was falsely emitted'
  }
  if (($lines | Where-Object { $_ -is [int] }) -notcontains 1) {
    throw 'termination failure did not return nonzero'
  }
  'TERMINATION_FAILURE_RETAINED'
}
finally {
  if ($null -ne $script:RetainedRuntime -and -not $script:RetainedRuntime.Process.HasExited) {
    & taskkill.exe /PID $script:RetainedRuntime.Process.Id /T /F 2>$null | Out-Null
  }
  if (Test-Path -LiteralPath $script:RetainedOwnedRoot) {
    [System.IO.Directory]::Delete($script:RetainedOwnedRoot, $true)
  }
  if (Test-Path -LiteralPath $lockPath) {
    [System.IO.Directory]::Delete($lockPath, $true)
  }
}
`;
    const execution = runPowerShell(invocation);

    assert.equal(execution.status, 0, execution.stderr);
    assert.match(execution.stdout, /TERMINATION_FAILURE_RETAINED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("signals START only after Automator terminates and ABORTs every blocked window", async () => {
  const source = await readFile(scriptPath, "utf8");
  const invokeStart = source.indexOf("Start-Slice5Automator");
  const startGate = source.indexOf("-Decision 'START'", invokeStart);
  const waitRuntime = source.indexOf("Wait-Slice5RuntimeVerifier", startGate);

  assert.ok(invokeStart >= 0);
  assert.ok(startGate > invokeStart);
  assert.ok(waitRuntime > startGate);
  assert.match(
    source,
    /if \(\$automatorExitCode -eq 0[\s\S]*?-Decision 'START'[\s\S]*?else[\s\S]*?-Decision 'ABORT'/,
  );
  assert.match(
    source,
    /finally \{[\s\S]*?if \([^)]*-not \$stableGateResolved[^)]*\)[\s\S]*?-Decision 'ABORT'[\s\S]*?Wait-Slice5RuntimeVerifier/,
  );
});

test("quotes every child-process argument and preserves paths containing spaces", () => {
  const invocation = `
. ${quoted(scriptPath)}
$joined = Join-Slice5ProcessArguments @(
  'E:\\My Work\\stay-fable\\scripts\\worker.js',
  '--project-path',
  'E:\\My Work\\stay-fable\\wx',
  'quote"inside',
  'trailing\\'
)
$joined
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = (Get-Command node -ErrorAction Stop).Source
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardOutput = $true
$startInfo.Arguments = Join-Slice5ProcessArguments @(
  '-e',
  'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
  'E:\\My Work\\stay-fable\\wx',
  'quote"inside',
  'trailing\\'
)
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
if (-not $process.Start()) { throw 'probe failed to start' }
$output = $process.StandardOutput.ReadToEnd()
$process.WaitForExit()
if ($process.ExitCode -ne 0) { throw 'probe failed' }
$output
`;
  const execution = runPowerShell(invocation);

  assert.equal(execution.status, 0, execution.stderr);
  const [joined, passedArguments] = execution.stdout.trim().split(/\r?\n/);
  assert.equal(
    joined,
    '"E:\\My Work\\stay-fable\\scripts\\worker.js" "--project-path" "E:\\My Work\\stay-fable\\wx" "quote\\"inside" "trailing\\\\"',
  );
  assert.deepEqual(JSON.parse(passedArguments), [
    "E:\\My Work\\stay-fable\\wx",
    'quote"inside',
    "trailing\\",
  ]);
});

test("places an outer hard deadline around Automator", async () => {
  const source = await readFile(scriptPath, "utf8");
  const automator = source.match(
    /function Start-Slice5Automator \{[\s\S]*?(?=\nfunction Wait-Slice5RuntimeVerifier)/,
  )?.[0];

  assert.ok(automator);
  assert.match(automator, /Wait-Slice5AutomatorProcess/);
  assert.doesNotMatch(automator, /\.WaitForExit\(\)\s*$/m);
});

test("Automator process wait dynamically terminates a hung process tree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stay-fable-automator-tree-"));
  try {
    const childPidPath = path.join(root, "child.pid");
    const parentScriptPath = path.join(root, "hung-parent.cjs");
    await writeFile(
      parentScriptPath,
      `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
fs.writeFileSync(process.argv[2], String(child.pid));
setInterval(() => {}, 1000);
`,
      "utf8",
    );
    const invocation = `
. ${quoted(scriptPath)}
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = (Get-Command node -ErrorAction Stop).Source
$startInfo.UseShellExecute = $false
$startInfo.Arguments = Join-Slice5ProcessArguments @(${quoted(parentScriptPath)}, ${quoted(childPidPath)})
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
if (-not $process.Start()) { throw 'hung automator failed to start' }
try {
  $exitCode = Wait-Slice5AutomatorProcess -Process $process -TimeoutMilliseconds 1000
}
finally {
  if (-not $process.HasExited) {
    & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
  }
}
if ($exitCode -ne 124) { throw 'hung automator timeout not preserved' }
if (-not $process.HasExited) { throw 'hung automator wrapper survived' }
$childPid = [int](Get-Content -LiteralPath ${quoted(childPidPath)} -Raw)
if (Get-Process -Id $childPid -ErrorAction SilentlyContinue) {
  throw 'hung automator child survived'
}
'AUTOMATOR_TREE_TIMEOUT_CLEAN'
`;
    const execution = runPowerShell(invocation);

    assert.equal(execution.status, 0, execution.stderr);
    assert.match(execution.stdout, /AUTOMATOR_TREE_TIMEOUT_CLEAN/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publishes evidence outside the temporary owned root", async () => {
  const source = await readFile(scriptPath, "utf8");
  const automator = source.match(
    /function Start-Slice5Automator \{[\s\S]*?(?=\nfunction Wait-Slice5RuntimeVerifier)/,
  )?.[0];

  assert.ok(automator);
  assert.match(automator, /docs[\\/]verification[\\/]evidence[\\/]slice-5-booking-lifecycle/);
  assert.doesNotMatch(automator, /\$evidencePath\s*=\s*Join-Path \$OwnedRoot/);
  assert.match(automator, /temporaryDirectory\s*=\s*\$evidenceParent/);
  assert.doesNotMatch(automator, /temporaryDirectory\s*=\s*\$OwnedRoot/);
  assert.match(automator, /evidenceDirectory\s*=\s*\$evidencePath/);
});

test("keeps completion markers behind their real gates", async () => {
  const source = await readFile(scriptPath, "utf8");

  assert.match(source, /if \(\$preflightResult\.status -ne 'READY'\)[\s\S]*?continue/);
  assert.match(source, /if \(-not \(Test-Slice5PhysicalPickerCapability\)\)[\s\S]*?continue/);
  assert.match(source, /if \(-not \$ledgerProducer\.Ready\)[\s\S]*?continue/);
  assert.match(source, /if \(\$automatorExitCode -eq 0[\s\S]*?SLICE5_AUTOMATOR_COMPLETE/);
  assert.match(
    source,
    /Wait-Slice5RuntimeVerifier[\s\S]*SLICE2_RUNTIME_STABLE_10_MINUTES[\s\S]*SLICE5_RUNTIME_STABLE/,
  );
  assert.match(source, /SLICE5_MANUAL_PENDING/);
  assert.doesNotMatch(source, /PICKER_PHYSICAL_UNAVAILABLE[\s\S]{0,400}SLICE5_AUTOMATOR_COMPLETE/);
  const preflight = source.match(
    /function Invoke-Slice5TrustedPreflight \{[\s\S]*?(?=\nfunction Test-Slice5PhysicalPickerCapability)/,
  )?.[0];
  assert.ok(preflight);
  assert.match(preflight, /Get-Slice5Candidate -RepoRoot/);
  assert.match(preflight, /CANDIDATE_MISMATCH/);
  assert.ok(preflight.indexOf("accountCount") < preflight.indexOf("automation_runtime_info"));
});

test("publishes an exact monotonic key-free ledger with durable same-volume replacement", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stay-fable-slice5-ledger-"));
  try {
    const ledgerPath = path.join(root, "post-ledger.json");
    const ownerMarker = path.join(root, ".slice5-owner");
    await writeFile(ownerMarker, "owner-token", "utf8");
    const invocation = `
. ${quoted(scriptPath)}
$state = New-Slice5LedgerState -OwnedRoot ${quoted(root)} -LedgerPath ${quoted(ledgerPath)} -OwnerToken 'owner-token' -CandidateCommit '${commit}' -CandidateWxTree '${wxTree}' -ExecutionDate '2026-07-31'
$observation = [pscustomobject]@{
  quote = 1
  booking = 2
  paymentFailure = 3
  paymentSuccess = 4
  cancel = 5
  unknownPosts = 0
  retryOutcome = 'SUCCEED'
  retryAttempts = 1
  sameScope = $true
  sameCredential = $true
}
$null = Publish-Slice5OwnedLedger -State $state -Observation $observation
$null = Publish-Slice5OwnedLedger -State $state -Observation $observation
Get-Content -LiteralPath ${quoted(ledgerPath)} -Raw
`;
    const execution = runPowerShell(invocation);
    assert.equal(execution.status, 0, execution.stderr);
    const ledger = JSON.parse(execution.stdout.trim());
    assert.deepEqual(Object.keys(ledger), [
      "schemaVersion",
      "candidate",
      "executionDate",
      "revision",
      "totalPosts",
      "unknownPosts",
      "counts",
      "paymentRetry",
    ]);
    assert.deepEqual(ledger.candidate, { commit, wxTree });
    assert.equal(ledger.executionDate, "2026-07-31");
    assert.equal(ledger.revision, 1);
    assert.equal(ledger.totalPosts, 15);
    assert.equal(ledger.unknownPosts, 0);
    assert.deepEqual(ledger.counts, {
      quote: 1,
      booking: 2,
      paymentFailure: 3,
      paymentSuccess: 4,
      cancel: 5,
    });
    assert.deepEqual(ledger.paymentRetry, {
      outcome: "SUCCEED",
      attempts: 1,
      sameScope: true,
      sameCredential: true,
    });
    assert.doesNotMatch(execution.stdout, /key|token|authorization/i);

    const source = await readFile(scriptPath, "utf8");
    assert.match(source, /FileOptions\]::WriteThrough/);
    assert.match(source, /\.Flush\(\$true\)/);
    assert.match(source, /\.Dispose\(\)/);
    assert.match(source, /File\]::Replace\(/);
    assert.match(source, /File\]::Move\([^)]*,[^)]*\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unknown, extra, and retry-secret observations without replacing the ledger", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stay-fable-slice5-ledger-"));
  try {
    const ledgerPath = path.join(root, "post-ledger.json");
    await writeFile(path.join(root, ".slice5-owner"), "owner-token", "utf8");
    const invocation = `
. ${quoted(scriptPath)}
$state = New-Slice5LedgerState -OwnedRoot ${quoted(root)} -LedgerPath ${quoted(ledgerPath)} -OwnerToken 'owner-token' -CandidateCommit '${commit}' -CandidateWxTree '${wxTree}' -ExecutionDate '2026-07-31'
$valid = [pscustomobject]@{
  quote = 0; booking = 0; paymentFailure = 0; paymentSuccess = 0; cancel = 0
  unknownPosts = 0; retryOutcome = 'SUCCEED'; retryAttempts = 1
  sameScope = $true; sameCredential = $true
}
$null = Publish-Slice5OwnedLedger -State $state -Observation $valid
$invalid = [pscustomobject]@{
  quote = 0; booking = 0; paymentFailure = 0; paymentSuccess = 0; cancel = 0
  unknownPosts = 1; retryOutcome = 'SUCCEED'; retryAttempts = 1
  sameScope = $true; sameCredential = $true
  idempotencyKey = 'must-not-persist'
}
try {
  $null = Publish-Slice5OwnedLedger -State $state -Observation $invalid
  throw 'invalid observation was accepted'
}
catch {
  if ($_.Exception.Message -eq 'invalid observation was accepted') { throw }
}
Get-Content -LiteralPath ${quoted(ledgerPath)} -Raw
`;
    const execution = runPowerShell(invocation);
    assert.equal(execution.status, 0, execution.stderr);
    const ledger = JSON.parse(execution.stdout.trim());
    assert.equal(ledger.revision, 0);
    assert.equal(ledger.unknownPosts, 0);
    assert.doesNotMatch(execution.stdout, /must-not-persist|idempotency/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses an atomic owner-bound lock and refuses foreign cleanup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stay-fable-slice5-lock-"));
  try {
    const lockPath = path.join(root, "run.lock");
    const invocation = `
. ${quoted(scriptPath)}
$lock = Enter-Slice5RunLock -LockPath ${quoted(lockPath)}
try {
  try {
    $null = Enter-Slice5RunLock -LockPath ${quoted(lockPath)}
    throw 'second lock was accepted'
  }
  catch {
    if ($_.Exception.Message -eq 'second lock was accepted') { throw }
  }
}
finally {
  Exit-Slice5RunLock -Lock $lock
}
if (Test-Path -LiteralPath ${quoted(lockPath)}) { throw 'owned lock remained' }
New-Item -ItemType Directory -Path ${quoted(lockPath)} | Out-Null
Set-Content -LiteralPath (Join-Path ${quoted(lockPath)} '.owner') -Value 'foreign' -NoNewline
try {
  Exit-Slice5RunLock -Lock $lock
  throw 'foreign lock was removed'
}
catch {
  if ($_.Exception.Message -eq 'foreign lock was removed') { throw }
}
if (-not (Test-Path -LiteralPath ${quoted(lockPath)})) { throw 'foreign lock disappeared' }
'LOCK_CONTRACT_OK'
`;
    const execution = runPowerShell(invocation);
    assert.equal(execution.status, 0, execution.stderr);
    assert.match(execution.stdout, /LOCK_CONTRACT_OK/);
    const source = await readFile(scriptPath, "utf8");
    assert.match(source, /New-Item -ItemType Directory[\s\S]{0,160}-ErrorAction Stop/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("still releases its lock when owned-root cleanup is refused", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stay-fable-slice5-cleanup-"));
  try {
    const lockPath = path.join(root, "run.lock");
    const ownedRoot = path.join(root, "owned");
    const invocation = `
. ${quoted(scriptPath)}
[System.IO.Directory]::CreateDirectory(${quoted(ownedRoot)}) | Out-Null
[System.IO.File]::WriteAllText(
  (Join-Path ${quoted(ownedRoot)} '.slice5-owner'),
  'foreign'
)
$lock = Enter-Slice5RunLock -LockPath ${quoted(lockPath)}
try {
  Invoke-Slice5Cleanup -OwnedRoot ${quoted(ownedRoot)} -OwnerToken 'expected' -Lock $lock
  throw 'cleanup failure was hidden'
}
catch {
  if ($_.Exception.Message -eq 'cleanup failure was hidden') { throw }
}
if (Test-Path -LiteralPath ${quoted(lockPath)}) { throw 'lock leaked' }
if (-not (Test-Path -LiteralPath ${quoted(ownedRoot)})) { throw 'foreign root removed' }
'CLEANUP_CONTINUED'
`;
    const execution = runPowerShell(invocation);
    assert.equal(execution.status, 0, execution.stderr);
    assert.match(execution.stdout, /CLEANUP_CONTINUED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts an absent owned root while still releasing its lock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stay-fable-slice5-null-cleanup-"));
  try {
    const lockPath = path.join(root, "run.lock");
    const invocation = `
. ${quoted(scriptPath)}
$lock = Enter-Slice5RunLock -LockPath ${quoted(lockPath)}
Invoke-Slice5Cleanup -OwnedRoot $null -OwnerToken $null -Lock $lock
if (Test-Path -LiteralPath ${quoted(lockPath)}) { throw 'lock leaked' }
'NULL_CLEANUP_COMPLETE'
`;
    const execution = runPowerShell(invocation);
    assert.equal(execution.status, 0, execution.stderr);
    assert.match(execution.stdout, /NULL_CLEANUP_COMPLETE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("streams safe markers and cleans the lock when a dirty candidate is blocked", async () => {
  const executable = process.platform === "win32" ? "powershell.exe" : "pwsh";
  const dirtyMarker = path.join(
    repoRoot,
    `.slice5-dirty-candidate-${process.pid}-${Date.now()}.test`,
  );
  await writeFile(dirtyMarker, "owned test marker\n", { flag: "wx" });
  let execution;
  try {
    execution = spawnSync(
      executable,
      ["-NoProfile", "-File", scriptPath, "-ExecutionDate", "2026-07-31"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
  } finally {
    await rm(dirtyMarker, { force: true });
  }

  assert.equal(execution.status, 1);
  assert.equal(execution.stderr.trim(), "");
  assert.match(execution.stdout, /SLICE5_BLOCKED CANDIDATE_NOT_CLEAN/);
  assert.match(execution.stdout, /SLICE5_WSL_EXIT_CODE 125/);
  assert.match(execution.stdout, /SLICE5_AUTOMATOR_EXIT_CODE 125/);
  assert.match(execution.stdout, /SLICE5_CLEANUP_COMPLETE/);
  assert.doesNotMatch(execution.stdout, /SLICE5_AUTOMATOR_COMPLETE|SLICE5_PREFLIGHT_READY/);

  const lockProbe = runPowerShell(`
. ${quoted(scriptPath)}
$lockPath = Get-Slice5LockPath -RepoRoot ${quoted(repoRoot)}
if (Test-Path -LiteralPath $lockPath) { throw 'lock leaked' }
`);
  assert.equal(lockProbe.status, 0, lockProbe.stderr);
});

test("parses as PowerShell without executing the UAT window", () => {
  const command = `
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  ${quoted(scriptPath)},
  [ref]$tokens,
  [ref]$errors
) | Out-Null
if ($errors.Count -ne 0) {
  $errors | ForEach-Object { Write-Error $_.Message }
  exit 1
}
`;
  const execution = runPowerShell(command);
  assert.equal(execution.status, 0, execution.stderr);
});

test("keeps the planned Windows PowerShell entrypoint on compatible APIs", async () => {
  const source = await readFile(scriptPath, "utf8");

  assert.doesNotMatch(source, /SHA256\]::HashData|Convert\]::ToHexString/);
  assert.doesNotMatch(source, /\.ArgumentList|ConvertFrom-Json -Depth/);
  assert.doesNotMatch(source, /File\]::Move\([^)]*,[^)]*,\s*\$true\)/);
  assert.match(source, /SHA256\]::Create\(\)/);
  assert.match(source, /File\]::Replace\(/);
  assert.match(source, /\.Arguments\s*=/);

  if (process.platform === "win32") {
    const command = `
. ${quoted(scriptPath)}
$value = Get-Slice5LockPath -RepoRoot ${quoted(path.dirname(scriptPath))}
if ([string]::IsNullOrWhiteSpace($value)) { throw 'lock path missing' }
`;
    const encoded = Buffer.from(`$ErrorActionPreference = 'Stop'\n${command}`, "utf16le").toString(
      "base64",
    );
    const execution = spawnSync("powershell.exe", ["-NoProfile", "-EncodedCommand", encoded], {
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(execution.status, 0, execution.stderr);
  }
});

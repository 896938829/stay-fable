[CmdletBinding()]
param(
  [string]$Distro = 'Ubuntu-22.04',
  [string]$ExecutionDate = (Get-Date -Format 'yyyy-MM-dd')
)

$ErrorActionPreference = 'Stop'
$script:Slice5Sha1Pattern = '^[0-9a-f]{40}$'
$script:Slice5DatePattern = '^\d{4}-\d{2}-\d{2}$'
$script:Slice5ObservationKeys = @(
  'quote',
  'booking',
  'paymentFailure',
  'paymentSuccess',
  'cancel',
  'unknownPosts',
  'retryOutcome',
  'retryAttempts',
  'sameScope',
  'sameCredential'
)

function Test-Slice5ExactProperties {
  param(
    [Parameter(Mandatory)]
    [object]$Value,
    [Parameter(Mandatory)]
    [string[]]$Names
  )

  if ($null -eq $Value) { return $false }
  $actual = @($Value.PSObject.Properties.Name)
  if ($actual.Count -ne $Names.Count) { return $false }
  foreach ($name in $Names) {
    if ($actual -notcontains $name) { return $false }
  }
  return $true
}

function Test-Slice5SafeOwnerToken {
  param([string]$Value)
  return $Value -match '^[A-Za-z0-9-]{1,128}$'
}

function Get-Slice5CanonicalPath {
  param([Parameter(Mandatory)][string]$Path)
  return [System.IO.Path]::GetFullPath($Path)
}

function ConvertTo-Slice5ProcessArgument {
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Argument)

  if ($Argument.IndexOf([char]0) -ge 0 -or $Argument -match '[\r\n]') {
    throw 'SLICE5_PROCESS_ARGUMENT_INVALID'
  }
  $builder = [System.Text.StringBuilder]::new()
  $null = $builder.Append([char]34)
  $backslashes = 0
  foreach ($character in $Argument.ToCharArray()) {
    if ($character -eq [char]92) {
      $backslashes += 1
      continue
    }
    if ($character -eq [char]34) {
      $null = $builder.Append([char]92, (2 * $backslashes) + 1)
      $null = $builder.Append([char]34)
      $backslashes = 0
      continue
    }
    if ($backslashes -gt 0) {
      $null = $builder.Append([char]92, $backslashes)
      $backslashes = 0
    }
    $null = $builder.Append($character)
  }
  if ($backslashes -gt 0) {
    $null = $builder.Append([char]92, 2 * $backslashes)
  }
  $null = $builder.Append([char]34)
  return $builder.ToString()
}

function Join-Slice5ProcessArguments {
  param([Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Arguments)

  return @(
    foreach ($argument in $Arguments) {
      ConvertTo-Slice5ProcessArgument -Argument $argument
    }
  ) -join ' '
}

function Stop-Slice5OwnedProcessTree {
  param(
    [Parameter(Mandatory)][System.Diagnostics.Process]$Process,
    [ValidateRange(1000, 60000)][int]$TimeoutMilliseconds = 10000
  )

  if ($Process.HasExited) { return }
  if ($env:OS -eq 'Windows_NT') {
    & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null
    $treeTerminationExitCode = $LASTEXITCODE
    if ($treeTerminationExitCode -ne 0 -and -not $Process.HasExited) {
      throw 'SLICE5_PROCESS_TREE_TERMINATION_FAILED'
    }
  }
  else {
    $Process.Kill()
  }
  if (-not $Process.WaitForExit($TimeoutMilliseconds)) {
    throw 'SLICE5_PROCESS_TREE_TERMINATION_FAILED'
  }
  if (-not $Process.HasExited) {
    throw 'SLICE5_PROCESS_TREE_TERMINATION_FAILED'
  }
}

function Wait-Slice5AutomatorProcess {
  param(
    [Parameter(Mandatory)][System.Diagnostics.Process]$Process,
    [ValidateRange(1000, 3600000)][int]$TimeoutMilliseconds
  )

  if ($Process.WaitForExit($TimeoutMilliseconds)) {
    return $Process.ExitCode
  }
  Stop-Slice5OwnedProcessTree -Process $Process
  return 124
}

function Get-Slice5Sha256Hex {
  param([Parameter(Mandatory)][byte[]]$Bytes)

  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    $digest = $algorithm.ComputeHash($Bytes)
  }
  finally {
    $algorithm.Dispose()
  }
  return [System.BitConverter]::ToString($digest).Replace(
    '-',
    ''
  ).ToLowerInvariant()
}

function Get-Slice5LockPath {
  param([Parameter(Mandatory)][string]$RepoRoot)

  $canonical = (Get-Slice5CanonicalPath $RepoRoot).ToLowerInvariant()
  $name = (Get-Slice5Sha256Hex (
    [System.Text.Encoding]::UTF8.GetBytes($canonical)
  )).Substring(0, 24)
  return Join-Path (
    [System.IO.Path]::GetTempPath()
  ) "stay-fable-slice5-$name.lock"
}

function Test-Slice5PathInside {
  param(
    [Parameter(Mandatory)][string]$Child,
    [Parameter(Mandatory)][string]$Parent
  )
  $parentPath = (Get-Slice5CanonicalPath $Parent).TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  )
  $childPath = Get-Slice5CanonicalPath $Child
  return $childPath.StartsWith(
    "$parentPath$([System.IO.Path]::DirectorySeparatorChar)",
    [System.StringComparison]::OrdinalIgnoreCase
  )
}

function Enter-Slice5RunLock {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$LockPath)

  $canonical = Get-Slice5CanonicalPath $LockPath
  $token = [Guid]::NewGuid().ToString('N')
  $created = $false
  try {
    New-Item -ItemType Directory -Path $canonical -ErrorAction Stop | Out-Null
    $created = $true
    $ownerPath = Join-Path $canonical '.owner'
    $stream = [System.IO.File]::Open(
      $ownerPath,
      [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::Write,
      [System.IO.FileShare]::None
    )
    try {
      $bytes = [System.Text.Encoding]::UTF8.GetBytes($token)
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush($true)
    }
    finally {
      $stream.Dispose()
    }
  }
  catch {
    if (
      $created -and
      (Test-Path -LiteralPath $canonical -PathType Container) -and
      -not (Test-Path -LiteralPath (Join-Path $canonical '.owner') -PathType Leaf)
    ) {
      try { [System.IO.Directory]::Delete($canonical, $false) } catch {}
    }
    throw 'SLICE5_RUN_LOCK_UNAVAILABLE'
  }
  return [pscustomobject]@{ Path = $canonical; Token = $token }
}

function Exit-Slice5RunLock {
  [CmdletBinding()]
  param([Parameter(Mandatory)][object]$Lock)

  if (
    -not (Test-Slice5ExactProperties $Lock @('Path', 'Token')) -or
    -not (Test-Slice5SafeOwnerToken $Lock.Token)
  ) {
    throw 'SLICE5_RUN_LOCK_OWNERSHIP_INVALID'
  }
  $lockPath = Get-Slice5CanonicalPath $Lock.Path
  $ownerPath = Join-Path $lockPath '.owner'
  if (
    -not (Test-Path -LiteralPath $ownerPath -PathType Leaf) -or
    -not [StringComparer]::Ordinal.Equals(
      (Get-Content -LiteralPath $ownerPath -Raw),
      $Lock.Token
    )
  ) {
    throw 'SLICE5_RUN_LOCK_OWNERSHIP_INVALID'
  }
  [System.IO.Directory]::Delete($lockPath, $true)
}

function New-Slice5LedgerState {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$OwnedRoot,
    [Parameter(Mandatory)][string]$LedgerPath,
    [Parameter(Mandatory)][string]$OwnerToken,
    [Parameter(Mandatory)][string]$CandidateCommit,
    [Parameter(Mandatory)][string]$CandidateWxTree,
    [Parameter(Mandatory)][string]$ExecutionDate
  )

  $root = Get-Slice5CanonicalPath $OwnedRoot
  $ledger = Get-Slice5CanonicalPath $LedgerPath
  $ownerMarker = Join-Path $root '.slice5-owner'
  if (
    -not (Test-Slice5SafeOwnerToken $OwnerToken) -or
    $CandidateCommit -notmatch $script:Slice5Sha1Pattern -or
    $CandidateWxTree -notmatch $script:Slice5Sha1Pattern -or
    $ExecutionDate -notmatch $script:Slice5DatePattern -or
    -not (Test-Slice5PathInside $ledger $root) -or
    -not [StringComparer]::OrdinalIgnoreCase.Equals(
      [System.IO.Path]::GetPathRoot($ledger),
      [System.IO.Path]::GetPathRoot($root)
    ) -or
    -not (Test-Path -LiteralPath $ownerMarker -PathType Leaf) -or
    -not [StringComparer]::Ordinal.Equals(
      (Get-Content -LiteralPath $ownerMarker -Raw),
      $OwnerToken
    )
  ) {
    throw 'SLICE5_LEDGER_OWNERSHIP_INVALID'
  }
  return [pscustomobject]@{
    OwnedRoot = $root
    LedgerPath = $ledger
    OwnerToken = $OwnerToken
    CandidateCommit = $CandidateCommit
    CandidateWxTree = $CandidateWxTree
    ExecutionDate = $ExecutionDate
    Revision = -1
    Fingerprint = $null
  }
}

function Publish-Slice5OwnedLedger {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][object]$State,
    [Parameter(Mandatory)][object]$Observation
  )

  if (
    -not (Test-Slice5ExactProperties $State @(
      'OwnedRoot',
      'LedgerPath',
      'OwnerToken',
      'CandidateCommit',
      'CandidateWxTree',
      'ExecutionDate',
      'Revision',
      'Fingerprint'
    )) -or
    -not (Test-Slice5ExactProperties $Observation $script:Slice5ObservationKeys)
  ) {
    throw 'SLICE5_LEDGER_OBSERVATION_INVALID'
  }
  foreach ($name in @(
    'quote',
    'booking',
    'paymentFailure',
    'paymentSuccess',
    'cancel',
    'unknownPosts',
    'retryAttempts'
  )) {
    if (
      $Observation.$name -isnot [int] -and
      $Observation.$name -isnot [long]
    ) {
      throw 'SLICE5_LEDGER_OBSERVATION_INVALID'
    }
    if ($Observation.$name -lt 0) {
      throw 'SLICE5_LEDGER_OBSERVATION_INVALID'
    }
  }
  if (
    $Observation.unknownPosts -ne 0 -or
    $Observation.retryOutcome -ne 'SUCCEED' -or
    $Observation.retryAttempts -lt 1 -or
    $Observation.retryAttempts -gt 2 -or
    $Observation.sameScope -isnot [bool] -or
    $Observation.sameCredential -isnot [bool]
  ) {
    throw 'SLICE5_LEDGER_OBSERVATION_INVALID'
  }

  $ownerMarker = Join-Path $State.OwnedRoot '.slice5-owner'
  if (
    -not (Test-Path -LiteralPath $ownerMarker -PathType Leaf) -or
    -not [StringComparer]::Ordinal.Equals(
      (Get-Content -LiteralPath $ownerMarker -Raw),
      $State.OwnerToken
    )
  ) {
    throw 'SLICE5_LEDGER_OWNERSHIP_INVALID'
  }

  $revision = [int64]$State.Revision + 1
  $counts = [ordered]@{
    quote = [int64]$Observation.quote
    booking = [int64]$Observation.booking
    paymentFailure = [int64]$Observation.paymentFailure
    paymentSuccess = [int64]$Observation.paymentSuccess
    cancel = [int64]$Observation.cancel
  }
  $total = 0
  foreach ($name in @(
    'quote',
    'booking',
    'paymentFailure',
    'paymentSuccess',
    'cancel'
  )) {
    $total += $counts[$name]
  }
  $document = [ordered]@{
    schemaVersion = 1
    candidate = [ordered]@{
      commit = $State.CandidateCommit
      wxTree = $State.CandidateWxTree
    }
    executionDate = $State.ExecutionDate
    revision = $revision
    totalPosts = $total
    unknownPosts = 0
    counts = $counts
    paymentRetry = [ordered]@{
      outcome = 'SUCCEED'
      attempts = [int64]$Observation.retryAttempts
      sameScope = [bool]$Observation.sameScope
      sameCredential = [bool]$Observation.sameCredential
    }
  }
  $json = $document | ConvertTo-Json -Depth 6 -Compress
  if ($json -match '(?i)authorization|bearer|token|secret|password|key') {
    throw 'SLICE5_LEDGER_OBSERVATION_INVALID'
  }
  $fingerprint = Get-Slice5Sha256Hex (
    [System.Text.Encoding]::UTF8.GetBytes($json)
  )
  $temporaryPath = Join-Path $State.OwnedRoot (
    ".post-ledger-$($State.OwnerToken)-$([Guid]::NewGuid().ToString('N')).tmp"
  )
  $backupPath = Join-Path $State.OwnedRoot (
    ".post-ledger-backup-$($State.OwnerToken)-$([Guid]::NewGuid().ToString('N')).tmp"
  )
  $stream = $null
  try {
    $stream = [System.IO.FileStream]::new(
      $temporaryPath,
      [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::Write,
      [System.IO.FileShare]::None,
      4096,
      [System.IO.FileOptions]::WriteThrough
    )
    $payload = [System.Text.UTF8Encoding]::new($false).GetBytes("$json`n")
    $stream.Write($payload, 0, $payload.Length)
    $stream.Flush($true)
    $stream.Dispose()
    $stream = $null

    if (
      -not [StringComparer]::Ordinal.Equals(
        (Get-Content -LiteralPath $ownerMarker -Raw),
        $State.OwnerToken
      )
    ) {
      throw 'SLICE5_LEDGER_OWNERSHIP_INVALID'
    }
    if (Test-Path -LiteralPath $State.LedgerPath -PathType Leaf) {
      [System.IO.File]::Replace(
        $temporaryPath,
        $State.LedgerPath,
        $backupPath
      )
      [System.IO.File]::Delete($backupPath)
    }
    else {
      [System.IO.File]::Move($temporaryPath, $State.LedgerPath)
    }
    $State.Revision = $revision
    $State.Fingerprint = $fingerprint
  }
  finally {
    if ($null -ne $stream) { $stream.Dispose() }
    if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
      [System.IO.File]::Delete($temporaryPath)
    }
    if (Test-Path -LiteralPath $backupPath -PathType Leaf) {
      [System.IO.File]::Delete($backupPath)
    }
  }
  return [pscustomobject]@{
    Revision = $revision
    Fingerprint = $fingerprint
  }
}

function Get-Slice5Candidate {
  param([Parameter(Mandatory)][string]$RepoRoot)

  Push-Location $RepoRoot
  try {
    $commit = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'candidate commit unavailable' }
    $wxTree = (& git rev-parse HEAD:wx).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'candidate wx tree unavailable' }
    $status = @(& git status --porcelain=v1 --untracked-files=all)
    if ($LASTEXITCODE -ne 0) { throw 'candidate status unavailable' }
  }
  finally {
    Pop-Location
  }
  if (
    $commit -notmatch $script:Slice5Sha1Pattern -or
    $wxTree -notmatch $script:Slice5Sha1Pattern -or
    $status.Count -ne 0
  ) {
    throw 'SLICE5_CANDIDATE_NOT_CLEAN'
  }
  return [pscustomobject]@{ commit = $commit; wxTree = $wxTree }
}

function Start-Slice5RuntimeVerifier {
  param(
    [Parameter(Mandatory)][string]$RepoRoot,
    [Parameter(Mandatory)][string]$Distro,
    [Parameter(Mandatory)][string]$StableGatePath,
    [Parameter(Mandatory)][string]$StableGateOwnerToken
  )

  $verifier = Join-Path $RepoRoot 'scripts/wsl-runtime-validation.ps1'
  if (-not (Test-Path -LiteralPath $verifier -PathType Leaf)) {
    throw 'SLICE5_RUNTIME_VERIFIER_MISSING'
  }
  if (
    $verifier.Contains('"') -or
    $Distro -notmatch '^[A-Za-z0-9._-]{1,64}$'
  ) {
    throw 'SLICE5_RUNTIME_CONFIGURATION_INVALID'
  }
  $shell = (Get-Command pwsh -ErrorAction Stop).Source
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $shell
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.CreateNoWindow = $true
  $startInfo.WorkingDirectory = $RepoRoot
  $startInfo.Arguments = Join-Slice5ProcessArguments @(
    '-NoProfile',
    '-File',
    $verifier,
    '-Distro',
    $Distro,
    '-StableGatePath',
    $StableGatePath,
    '-StableGateOwnerToken',
    $StableGateOwnerToken
  )
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { throw 'SLICE5_RUNTIME_START_FAILED' }
  return [pscustomobject]@{
    Process = $process
    Stderr = $process.StandardError.ReadToEndAsync()
    PendingReadTask = $null
    RepoRoot = $RepoRoot
    Distro = $Distro
    OwnerToken = $StableGateOwnerToken
    RequiresFallbackCleanup = $true
    Stable = $false
    Cleanup = $false
    Ready = $false
  }
}

function Invoke-Slice5RuntimeFallbackCleanup {
  param(
    [Parameter(Mandatory)][object]$Runtime,
    [ValidateRange(1000, 300000)][int]$TimeoutMilliseconds = 120000
  )

  foreach ($property in 'RepoRoot', 'Distro', 'OwnerToken') {
    if ($Runtime.PSObject.Properties.Name -notcontains $property) {
      return [pscustomobject]@{
        Complete = $false
        ProcessTreesConfirmed = $true
      }
    }
  }
  if (
    -not (Test-Slice5SafeOwnerToken $Runtime.OwnerToken) -or
    $Runtime.Distro -notmatch '^[A-Za-z0-9._-]{1,64}$'
  ) {
    return [pscustomobject]@{
      Complete = $false
      ProcessTreesConfirmed = $true
    }
  }
  $verifier = Join-Path $Runtime.RepoRoot 'scripts/wsl-runtime-validation.ps1'
  if (-not (Test-Path -LiteralPath $verifier -PathType Leaf)) {
    return [pscustomobject]@{
      Complete = $false
      ProcessTreesConfirmed = $true
    }
  }
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = (Get-Command pwsh -ErrorAction Stop).Source
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.CreateNoWindow = $true
  $startInfo.WorkingDirectory = $Runtime.RepoRoot
  $startInfo.Arguments = Join-Slice5ProcessArguments @(
    '-NoProfile',
    '-File',
    $verifier,
    '-Distro',
    $Runtime.Distro,
    '-StableGateOwnerToken',
    $Runtime.OwnerToken,
    '-CleanupOnly'
  )
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) {
    return [pscustomobject]@{
      Complete = $false
      ProcessTreesConfirmed = $true
    }
  }
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit($TimeoutMilliseconds)) {
    try {
      Stop-Slice5OwnedProcessTree -Process $process
    }
    catch {
      return [pscustomobject]@{
        Complete = $false
        ProcessTreesConfirmed = $false
      }
    }
    return [pscustomobject]@{
      Complete = $false
      ProcessTreesConfirmed = $true
    }
  }
  $output = $stdout.GetAwaiter().GetResult()
  $null = $stderr.GetAwaiter().GetResult()
  return [pscustomobject]@{
    Complete = (
      $process.ExitCode -eq 0 -and
      $output -match '(?m)^SLICE5_RUNTIME_FALLBACK_CLEANUP_COMPLETE\r?$'
    )
    ProcessTreesConfirmed = $true
  }
}

function Set-Slice5StableGate {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$OwnerToken,
    [Parameter(Mandatory)][ValidateSet('START', 'ABORT')][string]$Decision
  )

  $parent = (Resolve-Path -LiteralPath (Split-Path -Parent $Path)).Path
  $ownerMarker = Join-Path $parent '.slice5-owner'
  $expectedPath = Join-Path $parent 'stable-window.gate'
  if (
    -not (Test-Slice5SafeOwnerToken $OwnerToken) -or
    -not [StringComparer]::OrdinalIgnoreCase.Equals(
      [System.IO.Path]::GetFullPath($Path),
      [System.IO.Path]::GetFullPath($expectedPath)
    ) -or
    -not (Test-Path -LiteralPath $ownerMarker -PathType Leaf) -or
    -not [StringComparer]::Ordinal.Equals(
      (Get-Content -LiteralPath $ownerMarker -Raw),
      $OwnerToken
    )
  ) {
    throw 'SLICE5_STABLE_GATE_OWNERSHIP_INVALID'
  }
  $value = "$OwnerToken $Decision"
  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    if (-not [StringComparer]::Ordinal.Equals(
      (Get-Content -LiteralPath $Path -Raw).TrimEnd("`r", "`n"),
      $value
    )) {
      throw 'SLICE5_STABLE_GATE_ALREADY_RESOLVED'
    }
    return
  }

  $temporaryPath = Join-Path $parent (
    ".stable-window-$OwnerToken-$([Guid]::NewGuid().ToString('N')).tmp"
  )
  $bytes = [System.Text.Encoding]::UTF8.GetBytes("$value`n")
  $stream = $null
  try {
    $stream = [System.IO.FileStream]::new(
      $temporaryPath,
      [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::Write,
      [System.IO.FileShare]::None,
      4096,
      [System.IO.FileOptions]::WriteThrough
    )
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
    $stream.Dispose()
    $stream = $null
    [System.IO.File]::Move($temporaryPath, $Path)
  }
  finally {
    if ($null -ne $stream) { $stream.Dispose() }
    if (Test-Path -LiteralPath $temporaryPath) {
      [System.IO.File]::Delete($temporaryPath)
    }
  }
}

function Wait-Slice5RuntimeReady {
  param(
    [Parameter(Mandatory)][object]$Runtime,
    [ValidateRange(1, 3600)][int]$TimeoutSeconds = 1800
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ($true) {
    try {
      $line = Read-Slice5RuntimeOutputLine `
        -Runtime $Runtime `
        -Deadline $deadline
    }
    catch {
      if ($_.Exception.Message -eq 'SLICE5_RUNTIME_OUTPUT_TIMEOUT') {
        return $false
      }
      throw
    }
    if ($null -eq $line) { break }
    $readyMarker = Get-Slice5RuntimeMarker `
      -Runtime $Runtime `
      -Marker 'SLICE4_UAT_READY http://127.0.0.1:3000'
    if ($line -eq $readyMarker) {
      $Runtime.Ready = $true
      return $true
    }
    if ($line -eq (Get-Slice5RuntimeMarker `
      -Runtime $Runtime `
      -Marker 'SLICE2_RUNTIME_STABLE_10_MINUTES')) {
      $Runtime.Stable = $true
    }
    if ($line -eq (Get-Slice5RuntimeMarker `
      -Runtime $Runtime `
      -Marker 'SLICE2_RUNTIME_CLEANUP_COMPLETE')) {
      $Runtime.Cleanup = $true
    }
  }
  return $false
}

function Get-Slice5RuntimeMarker {
  param(
    [Parameter(Mandatory)][object]$Runtime,
    [Parameter(Mandatory)][string]$Marker
  )

  if (
    $Runtime.PSObject.Properties.Name -contains 'OwnerToken' -and
    -not [string]::IsNullOrWhiteSpace($Runtime.OwnerToken)
  ) {
    if (-not (Test-Slice5SafeOwnerToken $Runtime.OwnerToken)) {
      throw 'SLICE5_RUNTIME_OWNER_INVALID'
    }
    return "$Marker OWNER=$($Runtime.OwnerToken)"
  }
  return $Marker
}

function Read-Slice5RuntimeOutputLine {
  param(
    [Parameter(Mandatory)][object]$Runtime,
    [Parameter(Mandatory)][DateTime]$Deadline
  )

  if ($Runtime.PSObject.Properties.Name -notcontains 'PendingReadTask') {
    $Runtime | Add-Member -NotePropertyName PendingReadTask -NotePropertyValue $null
  }
  if ($null -eq $Runtime.PendingReadTask) {
    $Runtime.PendingReadTask = $Runtime.Process.StandardOutput.ReadLineAsync()
  }
  $readTask = $Runtime.PendingReadTask
  while (-not $readTask.Wait(250)) {
    if ([DateTime]::UtcNow -ge $Deadline) {
      throw 'SLICE5_RUNTIME_OUTPUT_TIMEOUT'
    }
  }
  $line = $readTask.GetAwaiter().GetResult()
  $Runtime.PendingReadTask = $null
  return $line
}

function Invoke-Slice5WechatideJson {
  param([Parameter(Mandatory)][string[]]$Arguments)

  $raw = & wechatide -c stay-fable-slice5 @Arguments 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'WECHATIDE_READ_FAILED' }
  $response = $raw | ConvertFrom-Json
  if ($response.ok -ne $true -or $response.result.success -ne $true) {
    throw 'WECHATIDE_READ_FAILED'
  }
  return $response.result
}

function Invoke-Slice5TrustedPreflight {
  param(
    [Parameter(Mandatory)][string]$RepoRoot,
    [Parameter(Mandatory)][object]$Candidate,
    [Parameter(Mandatory)][string]$ExecutionDate
  )

  $projectPath = Join-Path $RepoRoot 'wx'
  try {
    $currentCandidate = Get-Slice5Candidate -RepoRoot $RepoRoot
    if (
      $currentCandidate.commit -ne $Candidate.commit -or
      $currentCandidate.wxTree -ne $Candidate.wxTree
    ) {
      return [pscustomobject]@{
        schemaVersion = 1
        status = 'BLOCKED_AUTOMATOR_RC'
        reason = 'CANDIDATE_MISMATCH'
        executionBoundary = [pscustomobject]@{
          state = 'READ_ONLY_PREFLIGHT'
          interactionStarted = $false
        }
      }
    }
    $status = Invoke-Slice5WechatideJson @(
      'check_wechatide_status',
      '--skill-version',
      '0.3.5'
    )
    $accountCount = 0
    $healthReady = $false
    if (
      $status.versionRelation -in @('equal', 'agent_ahead') -and
      $status.loginExpired -eq $false -and
      $status.tokenRequired -eq $false
    ) {
      $accounts = Invoke-Slice5WechatideJson @(
        'automation_testaccount',
        '--project',
        $projectPath,
        '--action',
        'list'
      )
      $accountCount = @($accounts.accounts).Count
      if ($accountCount -gt 0) {
        $null = Invoke-Slice5WechatideJson @(
          'automation_runtime_info',
          '--project',
          $projectPath,
          '--action',
          'currentPage'
        )
        $live = Invoke-RestMethod `
          -Uri 'http://127.0.0.1:3000/health/live' `
          -TimeoutSec 2
        $ready = Invoke-RestMethod `
          -Uri 'http://127.0.0.1:3000/health/ready' `
          -TimeoutSec 2
        $healthReady = ($null -ne $live -and $null -ne $ready)
      }
    }
  }
  catch {
    return [pscustomobject]@{
      schemaVersion = 1
      status = 'BLOCKED_AUTOMATOR_RC'
      reason = 'PREFLIGHT_READ_FAILED'
      executionBoundary = [pscustomobject]@{
        state = 'READ_ONLY_PREFLIGHT'
        interactionStarted = $false
      }
    }
  }

  $snapshot = [ordered]@{
    candidate = [ordered]@{
      commit = $Candidate.commit
      wxTree = $Candidate.wxTree
      clean = $true
    }
    wechatide = [ordered]@{
      versionRelation = $status.versionRelation
      loginValid = ($status.loginExpired -eq $false)
      tokenRequired = [bool]$status.tokenRequired
      tokenAvailable = $false
      projectPath = $projectPath
    }
    accountCount = $accountCount
    health = [ordered]@{
      transport = 'HTTP_LOOPBACK'
      host = '127.0.0.1'
      liveEndpoint = '/health/live'
      readyEndpoint = '/health/ready'
      live = $healthReady
      ready = $healthReady
    }
    clockDate = $ExecutionDate
    # There is currently no authenticated, sanitized availability-observation
    # channel owned by the WSL verifier. Never infer a writable seed window.
    seedWindow = [ordered]@{ available = $false }
    baseline = [ordered]@{ consoleErrors = 0; networkFailures = 0 }
  }
  $payload = [ordered]@{
    options = [ordered]@{
      expectedProjectPath = $projectPath
      expectedCommit = $Candidate.commit
      expectedWxTree = $Candidate.wxTree
      executionDate = $ExecutionDate
      timeoutMs = 5000
    }
    snapshot = $snapshot
  } | ConvertTo-Json -Depth 10 -Compress
  $modulePath = Join-Path $RepoRoot 'wx/automator/slice-5-preflight.js'
  $driver = @'
const fs = require("node:fs");
const preflight = require(process.argv[1]);
const value = JSON.parse(fs.readFileSync(0, "utf8"));
const snapshot = value.snapshot;
const dependencies = {
  readCandidate: async () => snapshot.candidate,
  readWechatIde: async () => snapshot.wechatide,
  readTestAccountCount: async () => snapshot.accountCount,
  readApiHealth: async () => snapshot.health,
  readClockDate: async () => snapshot.clockDate,
  readSeedWindow: async () => snapshot.seedWindow,
  readBaseline: async () => snapshot.baseline,
};
preflight.runPreflight(value.options, dependencies).then(
  (result) => process.stdout.write(JSON.stringify(result)),
  () => process.exitCode = 1,
);
'@
  $resultText = $payload | & node -e $driver $modulePath 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw 'SLICE5_PREFLIGHT_EXECUTION_FAILED'
  }
  return $resultText | ConvertFrom-Json
}

function Test-Slice5PhysicalPickerCapability {
  # miniprogram-automator 0.12.1 cannot physically operate native date pickers.
  # A future implementation must replace this with an attested physical tool,
  # not trigger(change), callMethod, evaluate, or direct navigation.
  return $false
}

function Start-Slice5TrustedLedgerProducer {
  param(
    [Parameter(Mandatory)][object]$State,
    [Parameter(Mandatory)][string]$ApiBaseUrl
  )

  $null = $State
  $null = $ApiBaseUrl
  # The existing WSL verifier does not expose an authenticated, sanitized
  # request-observation stream. Refuse to synthesize counters from UI intent,
  # API state, logs, or caller-provided files.
  return [pscustomobject]@{
    Ready = $false
    Reason = 'POST_LEDGER_PRODUCER_UNAVAILABLE'
  }
}

function Start-Slice5Automator {
  param(
    [Parameter(Mandatory)][string]$RepoRoot,
    [Parameter(Mandatory)][string]$OwnedRoot,
    [Parameter(Mandatory)][object]$Candidate,
    [Parameter(Mandatory)][object]$Preflight,
    [Parameter(Mandatory)][string]$ExecutionDate,
    [Parameter(Mandatory)][string]$LedgerPath,
    [ValidateRange(30000, 3600000)][int]$AutomatorTimeoutMilliseconds = 1800000
  )

  $wechatideCommand = Get-Command wechatide -ErrorAction Stop
  $cliPath = Join-Path (Split-Path $wechatideCommand.Source -Parent) 'cli.bat'
  if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
    return [pscustomobject]@{ ExitCode = 125; Complete = $false }
  }
  $runOptionsPath = Join-Path $OwnedRoot 'run-options.json'
  $evidencePath = Join-Path $RepoRoot (
    'docs/verification/evidence/slice-5-booking-lifecycle'
  )
  $evidenceParent = Split-Path -Parent $evidencePath
  if (-not (Test-Path -LiteralPath $evidenceParent -PathType Container)) {
    return [pscustomobject]@{ ExitCode = 125; Complete = $false }
  }
  $runOptions = [ordered]@{
    candidate = [ordered]@{
      commit = $Candidate.commit
      wxTree = $Candidate.wxTree
    }
    preflight = $Preflight
    executionDate = $ExecutionDate
    toolVersion = '0.3.5'
    timeoutMs = 30000
    # Evidence is staged on the repository volume so the lifecycle runner's
    # final rename remains atomic. OwnedRoot retains only ephemeral control
    # material such as options, ledger, gate, and credentials.
    temporaryDirectory = $evidenceParent
    evidenceDirectory = $evidencePath
  } | ConvertTo-Json -Depth 12 -Compress
  [System.IO.File]::WriteAllText(
    $runOptionsPath,
    $runOptions,
    [System.Text.UTF8Encoding]::new($false)
  )
  $lifecycle = Join-Path $RepoRoot 'wx/automator/slice-5-booking-lifecycle.js'
  $nodePath = (Get-Command node -ErrorAction Stop).Source
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $nodePath
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.WorkingDirectory = $RepoRoot
  $startInfo.Arguments = Join-Slice5ProcessArguments @(
    $lifecycle,
    '--run-options',
    $runOptionsPath,
    '--post-ledger',
    $LedgerPath,
    '--cli-path',
    $cliPath,
    '--project-path',
    (Join-Path $RepoRoot 'wx')
  )
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) {
    return [pscustomobject]@{ ExitCode = 125; Complete = $false }
  }
  try {
    $automatorExitCode = Wait-Slice5AutomatorProcess `
      -Process $process `
      -TimeoutMilliseconds $AutomatorTimeoutMilliseconds
  }
  catch {
    if ($_.Exception.Message -ne 'SLICE5_PROCESS_TREE_TERMINATION_FAILED') {
      throw
    }
    return [pscustomobject]@{
      ExitCode = 126
      Complete = $false
      ProcessTreesConfirmed = $false
    }
  }
  return [pscustomobject]@{
    ExitCode = $automatorExitCode
    Complete = ($automatorExitCode -eq 0)
    ProcessTreesConfirmed = $true
  }
}

function Wait-Slice5RuntimeVerifier {
  param(
    [Parameter(Mandatory)][object]$Runtime,
    [ValidateRange(1, 1800)][int]$TimeoutSeconds = 900
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $timedOut = $false
  while ($true) {
    try {
      $line = Read-Slice5RuntimeOutputLine `
        -Runtime $Runtime `
        -Deadline $deadline
    }
    catch {
      if ($_.Exception.Message -eq 'SLICE5_RUNTIME_OUTPUT_TIMEOUT') {
        $timedOut = $true
        break
      }
      throw
    }
    if ($null -eq $line) { break }
    if ($line -eq (Get-Slice5RuntimeMarker `
      -Runtime $Runtime `
      -Marker 'SLICE2_RUNTIME_STABLE_10_MINUTES')) {
      $Runtime.Stable = $true
    }
    if ($line -eq (Get-Slice5RuntimeMarker `
      -Runtime $Runtime `
      -Marker 'SLICE2_RUNTIME_CLEANUP_COMPLETE')) {
      $Runtime.Cleanup = $true
    }
  }
  $remainingMilliseconds = [Math]::Max(
    1,
    [int][Math]::Ceiling(($deadline - [DateTime]::UtcNow).TotalMilliseconds)
  )
  if (
    $timedOut -or
    (
      -not $Runtime.Process.HasExited -and
      -not $Runtime.Process.WaitForExit($remainingMilliseconds)
    )
  ) {
    $timedOut = $true
    if (-not $Runtime.Process.HasExited) {
      try {
        Stop-Slice5OwnedProcessTree -Process $Runtime.Process
      }
      catch {
        if ($_.Exception.Message -ne 'SLICE5_PROCESS_TREE_TERMINATION_FAILED') {
          throw
        }
        return [pscustomobject]@{
          ExitCode = 126
          Stable = $false
          ProcessTreesConfirmed = $false
          RuntimeCleanupConfirmed = $false
        }
      }
    }
  }
  if ($Runtime.Stderr.IsCompleted) {
    try { $null = $Runtime.Stderr.Result } catch {}
  }
  $runtimeCleanupConfirmed = $true
  $runtimeExitCode = if ($timedOut) { 124 } else { $Runtime.Process.ExitCode }
  if (
    $Runtime.PSObject.Properties.Name -contains 'RequiresFallbackCleanup' -and
    $Runtime.RequiresFallbackCleanup -and
    (
      -not $Runtime.Cleanup -or
      $runtimeExitCode -ne 0
    )
  ) {
    $fallbackCleanup = Invoke-Slice5RuntimeFallbackCleanup -Runtime $Runtime
    if (-not $fallbackCleanup.ProcessTreesConfirmed) {
      return [pscustomobject]@{
        ExitCode = 126
        Stable = $false
        ProcessTreesConfirmed = $false
        RuntimeCleanupConfirmed = $false
      }
    }
    $runtimeCleanupConfirmed = $fallbackCleanup.Complete
  }
  if (-not $runtimeCleanupConfirmed) {
    return [pscustomobject]@{
      ExitCode = 126
      Stable = $false
      ProcessTreesConfirmed = $true
      RuntimeCleanupConfirmed = $false
    }
  }
  if ($timedOut) {
    return [pscustomobject]@{
      ExitCode = 124
      Stable = $false
      ProcessTreesConfirmed = $true
      RuntimeCleanupConfirmed = $true
    }
  }
  return [pscustomobject]@{
    ExitCode = $runtimeExitCode
    Stable = (
      $runtimeExitCode -eq 0 -and
      $Runtime.Stable -eq $true -and
      $Runtime.Cleanup -eq $true
    )
    ProcessTreesConfirmed = $true
    RuntimeCleanupConfirmed = $true
  }
}

function Remove-Slice5OwnedRoot {
  param(
    [Parameter(Mandatory)][string]$OwnedRoot,
    [Parameter(Mandatory)][string]$OwnerToken
  )

  $canonical = Get-Slice5CanonicalPath $OwnedRoot
  $ownerMarker = Join-Path $canonical '.slice5-owner'
  if (
    -not (Test-Path -LiteralPath $ownerMarker -PathType Leaf) -or
    -not [StringComparer]::Ordinal.Equals(
      (Get-Content -LiteralPath $ownerMarker -Raw),
      $OwnerToken
    )
  ) {
    throw 'SLICE5_RUNTIME_OWNERSHIP_INVALID'
  }
  [System.IO.Directory]::Delete($canonical, $true)
}

function Invoke-Slice5Cleanup {
  param(
    [AllowNull()][string]$OwnedRoot,
    [AllowNull()][string]$OwnerToken,
    [AllowNull()][object]$Lock,
    [bool]$ProcessTreesConfirmed = $true,
    [bool]$RuntimeCleanupConfirmed = $true
  )

  if (-not $ProcessTreesConfirmed) {
    throw 'SLICE5_PROCESS_TREE_TERMINATION_UNCONFIRMED'
  }
  if (-not $RuntimeCleanupConfirmed) {
    throw 'SLICE5_RUNTIME_FALLBACK_CLEANUP_UNCONFIRMED'
  }
  $cleanupFailed = $false
  if (-not [string]::IsNullOrWhiteSpace($OwnedRoot) -and (Test-Path -LiteralPath $OwnedRoot)) {
    try {
      Remove-Slice5OwnedRoot -OwnedRoot $OwnedRoot -OwnerToken $OwnerToken
    }
    catch {
      $cleanupFailed = $true
    }
  }
  if ($null -ne $Lock) {
    try {
      Exit-Slice5RunLock -Lock $Lock
    }
    catch {
      $cleanupFailed = $true
    }
  }
  if ($cleanupFailed) {
    throw 'SLICE5_CLEANUP_FAILED'
  }
}

function Invoke-Slice5Uat {
  param(
    [Parameter(Mandatory)][string]$Distro,
    [Parameter(Mandatory)][string]$ExecutionDate,
    [ValidateRange(1, 3600)][int]$RuntimeReadyTimeoutSeconds = 1800,
    [ValidateRange(1, 300)][int]$RuntimeAbortTimeoutSeconds = 60
  )

  $repoRoot = (Resolve-Path -LiteralPath (git rev-parse --show-toplevel)).Path
  $currentPath = (Resolve-Path -LiteralPath (Get-Location).ProviderPath).Path
  if (-not [StringComparer]::OrdinalIgnoreCase.Equals($repoRoot, $currentPath)) {
    throw 'SLICE5_WRONG_WORKTREE'
  }
  if ($ExecutionDate -notmatch $script:Slice5DatePattern) {
    throw 'SLICE5_EXECUTION_DATE_INVALID'
  }

  $lock = $null
  $runtime = $null
  $runtimeResult = $null
  $ownedRoot = $null
  $stableGatePath = $null
  $stableGateResolved = $false
  $stableGateDecision = $null
  $ownerToken = [Guid]::NewGuid().ToString('N')
  $automatorExitCode = 125
  $wslExitCode = 125
  $processTreesConfirmed = $true
  $runtimeCleanupConfirmed = $true
  $terminationBlocked = $false
  $runtimeCleanupBlocked = $false
  try {
    $lock = Enter-Slice5RunLock -LockPath (
      Get-Slice5LockPath -RepoRoot $repoRoot
    )
    $candidate = Get-Slice5Candidate -RepoRoot $repoRoot
    Write-Output "SLICE5_CANDIDATE_COMMIT $($candidate.commit)"
    Write-Output "SLICE5_CANDIDATE_WX_TREE $($candidate.wxTree)"

    $ownedRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
      "stay-fable-slice5-$ownerToken"
    )
    [System.IO.Directory]::CreateDirectory($ownedRoot) | Out-Null
    [System.IO.File]::WriteAllText(
      (Join-Path $ownedRoot '.slice5-owner'),
      $ownerToken,
      [System.Text.UTF8Encoding]::new($false)
    )
    $ledgerPath = Join-Path $ownedRoot 'post-ledger.json'
    $stableGatePath = Join-Path $ownedRoot 'stable-window.gate'
    $ledgerState = New-Slice5LedgerState `
      -OwnedRoot $ownedRoot `
      -LedgerPath $ledgerPath `
      -OwnerToken $ownerToken `
      -CandidateCommit $candidate.commit `
      -CandidateWxTree $candidate.wxTree `
      -ExecutionDate $ExecutionDate

    $runtime = Start-Slice5RuntimeVerifier `
      -RepoRoot $repoRoot `
      -Distro $Distro `
      -StableGatePath $stableGatePath `
      -StableGateOwnerToken $ownerToken
    $ready = Wait-Slice5RuntimeReady `
      -Runtime $runtime `
      -TimeoutSeconds $RuntimeReadyTimeoutSeconds
    do {
      if (-not $ready) {
        Write-Output 'SLICE5_BLOCKED RUNTIME_READY_UNAVAILABLE'
        continue
      }
      $preflightResult = Invoke-Slice5TrustedPreflight `
        -RepoRoot $repoRoot `
        -Candidate $candidate `
        -ExecutionDate $ExecutionDate
      if ($preflightResult.status -ne 'READY') {
        Write-Output "SLICE5_BLOCKED $($preflightResult.status)"
        continue
      }
      Write-Output 'SLICE5_PREFLIGHT_READY'

      if (-not (Test-Slice5PhysicalPickerCapability)) {
        Write-Output 'SLICE5_BLOCKED PICKER_PHYSICAL_UNAVAILABLE'
        continue
      }
      $ledgerProducer = Start-Slice5TrustedLedgerProducer `
        -State $ledgerState `
        -ApiBaseUrl 'http://127.0.0.1:3000'
      if (-not $ledgerProducer.Ready) {
        Write-Output "SLICE5_BLOCKED $($ledgerProducer.Reason)"
        continue
      }
      $automatorResult = Start-Slice5Automator `
        -RepoRoot $repoRoot `
        -OwnedRoot $ownedRoot `
        -Candidate $candidate `
        -Preflight $preflightResult `
        -ExecutionDate $ExecutionDate `
        -LedgerPath $ledgerPath
      $automatorExitCode = $automatorResult.ExitCode
      if (
        $automatorResult.PSObject.Properties.Name -contains 'ProcessTreesConfirmed' -and
        -not $automatorResult.ProcessTreesConfirmed
      ) {
        $processTreesConfirmed = $false
      }
      if ($automatorExitCode -eq 0 -and $automatorResult.Complete) {
        Set-Slice5StableGate `
          -Path $stableGatePath `
          -OwnerToken $ownerToken `
          -Decision 'START'
        $stableGateResolved = $true
        $stableGateDecision = 'START'
        Write-Output 'SLICE5_AUTOMATOR_COMPLETE'
        Write-Output 'SLICE5_MANUAL_PENDING'
      }
      else {
        Set-Slice5StableGate `
          -Path $stableGatePath `
          -OwnerToken $ownerToken `
          -Decision 'ABORT'
        $stableGateResolved = $true
        $stableGateDecision = 'ABORT'
      }
    } while ($false)

    if (-not $stableGateResolved) {
      Set-Slice5StableGate `
        -Path $stableGatePath `
        -OwnerToken $ownerToken `
        -Decision 'ABORT'
      $stableGateResolved = $true
      $stableGateDecision = 'ABORT'
    }
    # Even after Automator returns, the same verifier process owns the Worker
    # 10-minute observation and cleanup window.
    $runtimeWaitTimeoutSeconds = if ($stableGateDecision -eq 'START') {
      900
    }
    else {
      $RuntimeAbortTimeoutSeconds
    }
    $runtimeResult = Wait-Slice5RuntimeVerifier `
      -Runtime $runtime `
      -TimeoutSeconds $runtimeWaitTimeoutSeconds
    $wslExitCode = $runtimeResult.ExitCode
    if (
      $runtimeResult.PSObject.Properties.Name -contains 'ProcessTreesConfirmed' -and
      -not $runtimeResult.ProcessTreesConfirmed
    ) {
      $processTreesConfirmed = $false
    }
    if (
      $runtimeResult.PSObject.Properties.Name -contains 'RuntimeCleanupConfirmed' -and
      -not $runtimeResult.RuntimeCleanupConfirmed
    ) {
      $runtimeCleanupConfirmed = $false
    }
    if (
      $runtimeResult.Stable -and
      $runtime.Stable -and
      $runtime.Cleanup
    ) {
      Write-Output 'SLICE5_RUNTIME_STABLE'
    }
  }
  finally {
    if (
      $null -ne $runtime -and
      -not $stableGateResolved -and
      -not [string]::IsNullOrWhiteSpace($stableGatePath)
    ) {
      try {
        Set-Slice5StableGate `
          -Path $stableGatePath `
          -OwnerToken $ownerToken `
          -Decision 'ABORT'
        $stableGateResolved = $true
        $stableGateDecision = 'ABORT'
      }
      catch {
        $wslExitCode = 125
      }
    }
    if ($null -ne $runtime -and $null -eq $runtimeResult) {
      try {
        $runtimeWaitTimeoutSeconds = if ($stableGateDecision -eq 'START') {
          900
        }
        else {
          $RuntimeAbortTimeoutSeconds
        }
        $runtimeResult = Wait-Slice5RuntimeVerifier `
          -Runtime $runtime `
          -TimeoutSeconds $runtimeWaitTimeoutSeconds
        $wslExitCode = $runtimeResult.ExitCode
        if (
          $runtimeResult.PSObject.Properties.Name -contains 'ProcessTreesConfirmed' -and
          -not $runtimeResult.ProcessTreesConfirmed
        ) {
          $processTreesConfirmed = $false
        }
        if (
          $runtimeResult.PSObject.Properties.Name -contains 'RuntimeCleanupConfirmed' -and
          -not $runtimeResult.RuntimeCleanupConfirmed
        ) {
          $runtimeCleanupConfirmed = $false
        }
      }
      catch {
        if ($_.Exception.Message -eq 'SLICE5_PROCESS_TREE_TERMINATION_FAILED') {
          $processTreesConfirmed = $false
          $runtimeCleanupConfirmed = $false
          $wslExitCode = 126
        }
        else {
          $runtimeCleanupConfirmed = $false
          $wslExitCode = 125
        }
      }
    }
    Write-Output "SLICE5_WSL_EXIT_CODE $wslExitCode"
    Write-Output "SLICE5_AUTOMATOR_EXIT_CODE $automatorExitCode"
    try {
      Invoke-Slice5Cleanup `
        -OwnedRoot $ownedRoot `
        -OwnerToken $ownerToken `
        -Lock $lock `
        -ProcessTreesConfirmed $processTreesConfirmed `
        -RuntimeCleanupConfirmed $runtimeCleanupConfirmed
      Write-Output 'SLICE5_CLEANUP_COMPLETE'
    }
    catch {
      if (
        $_.Exception.Message -eq
        'SLICE5_PROCESS_TREE_TERMINATION_UNCONFIRMED'
      ) {
        $terminationBlocked = $true
        Write-Output 'SLICE5_BLOCKED PROCESS_TREE_TERMINATION_UNCONFIRMED'
      }
      elseif (
        $_.Exception.Message -eq
        'SLICE5_RUNTIME_FALLBACK_CLEANUP_UNCONFIRMED'
      ) {
        $runtimeCleanupBlocked = $true
        Write-Output 'SLICE5_BLOCKED RUNTIME_FALLBACK_CLEANUP_UNCONFIRMED'
      }
      else {
        throw
      }
    }
  }
  if ($terminationBlocked -or $runtimeCleanupBlocked) { return 1 }
  if ($wslExitCode -ne 0 -or $automatorExitCode -ne 0) {
    return 1
  }
  return 0
}

if ($MyInvocation.InvocationName -ne '.') {
  $scriptExitCode = 1
  try {
    Invoke-Slice5Uat -Distro $Distro -ExecutionDate $ExecutionDate |
      ForEach-Object {
        if ($_ -is [int]) {
          $scriptExitCode = [int]$_
        }
        else {
          Write-Output $_
        }
      }
  }
  catch {
    $blockedReason = switch ($_.Exception.Message) {
      'SLICE5_CANDIDATE_NOT_CLEAN' { 'CANDIDATE_NOT_CLEAN'; break }
      'SLICE5_CANDIDATE_CHANGED' { 'CANDIDATE_CHANGED'; break }
      'SLICE5_RUN_LOCK_UNAVAILABLE' { 'RUN_LOCK_UNAVAILABLE'; break }
      'SLICE5_WRONG_WORKTREE' { 'WRONG_WORKTREE'; break }
      'SLICE5_EXECUTION_DATE_INVALID' { 'EXECUTION_DATE_INVALID'; break }
      'SLICE5_CLEANUP_FAILED' { 'CLEANUP_FAILED'; break }
      'SLICE5_PROCESS_TREE_TERMINATION_UNCONFIRMED' {
        'PROCESS_TREE_TERMINATION_UNCONFIRMED'
        break
      }
      'SLICE5_RUNTIME_FALLBACK_CLEANUP_UNCONFIRMED' {
        'RUNTIME_FALLBACK_CLEANUP_UNCONFIRMED'
        break
      }
      default { 'ORCHESTRATION_FAILED' }
    }
    Write-Output "SLICE5_BLOCKED $blockedReason"
    $scriptExitCode = 1
  }
  exit $scriptExitCode
}

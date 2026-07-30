[CmdletBinding()]
param(
  [string]$Distro = 'Ubuntu-22.04',
  [string]$StableGatePath = '',
  [string]$StableGateOwnerToken = '',
  [switch]$CleanupOnly
)

$ErrorActionPreference = 'Stop'

function ConvertTo-WslDrvfsPath {
  param(
    [Parameter(Mandatory)][string]$Distro,
    [Parameter(Mandatory)][string]$WindowsPath,
    [string]$FailureMessage = 'Windows path could not be converted to WSL drvfs'
  )

  if (
    $Distro -notmatch '^[A-Za-z0-9._-]{1,64}$' -or
    $WindowsPath -notmatch '^[A-Za-z]:[\\/]'
  ) {
    throw $FailureMessage
  }
  $normalizedPath = $WindowsPath.Replace([char]92, [char]47)
  $rawOutput = @(
    wsl.exe -d $Distro --exec wslpath -a $normalizedPath
  )
  $conversionExitCode = $LASTEXITCODE
  if (
    $conversionExitCode -ne 0 -or
    $rawOutput.Count -ne 1 -or
    [string]::IsNullOrWhiteSpace([string]$rawOutput[0])
  ) {
    throw $FailureMessage
  }
  $convertedPath = ([string]$rawOutput[0]).Trim()
  if (
    $convertedPath -notmatch '^/mnt/[a-z](?:/|$)'
  ) {
    throw $FailureMessage
  }
  return $convertedPath
}

function Test-WslPathInsideRoot {
  param(
    [Parameter(Mandatory)][string]$RootPath,
    [Parameter(Mandatory)][string]$CandidatePath
  )

  $normalizedRoot = $RootPath.TrimEnd([char]47)
  $normalizedCandidate = $CandidatePath.TrimEnd([char]47)
  if (
    [string]::IsNullOrWhiteSpace($normalizedRoot) -or
    [string]::IsNullOrWhiteSpace($normalizedCandidate) -or
    [StringComparer]::Ordinal.Equals($normalizedCandidate, $normalizedRoot)
  ) {
    return $false
  }
  return $normalizedCandidate.StartsWith(
    "$normalizedRoot/",
    [StringComparison]::Ordinal
  )
}

$repoRoot = (Resolve-Path -LiteralPath (git rev-parse --show-toplevel)).Path
$currentPath = (Resolve-Path -LiteralPath (Get-Location).ProviderPath).Path
if (-not [StringComparer]::OrdinalIgnoreCase.Equals($currentPath, $repoRoot)) {
  throw 'Refusing validation: run this script from the linked worktree root'
}
if ($CleanupOnly) {
  if (
    -not [string]::IsNullOrWhiteSpace($StableGatePath) -or
    $StableGateOwnerToken -notmatch '^[a-f0-9]{32}$'
  ) {
    throw 'Cleanup-only mode requires one valid owner token and no gate path'
  }
}
elseif (
  [string]::IsNullOrWhiteSpace($StableGatePath) -xor
  [string]::IsNullOrWhiteSpace($StableGateOwnerToken)
) {
    throw 'Stable-window gate path and owner token must be supplied together'
}

$runtimeDir = Join-Path $repoRoot '.wsl-runtime'
$runtimeOwnerMarker = Join-Path $runtimeDir '.stay-fable-validation-owner'
$validationToken = if (
  -not [string]::IsNullOrWhiteSpace($StableGateOwnerToken)
) {
  $StableGateOwnerToken
}
else {
  [Guid]::NewGuid().ToString('N')
}
$runtimeOwned = $false
$wslValidationStarted = $false
$wslCleanupConfirmed = $false

if ($CleanupOnly) {
  $cleanupRuntimeDir = (
    Resolve-Path -LiteralPath $runtimeDir -ErrorAction SilentlyContinue
  ).Path
  if (
    $null -eq $cleanupRuntimeDir -or
    -not [StringComparer]::OrdinalIgnoreCase.Equals(
      $cleanupRuntimeDir,
      $runtimeDir
    ) -or
    -not (Test-Path -LiteralPath $runtimeOwnerMarker -PathType Leaf) -or
    -not [StringComparer]::Ordinal.Equals(
      (Get-Content -LiteralPath $runtimeOwnerMarker -Raw),
      $validationToken
    )
  ) {
    throw 'Cleanup-only runtime ownership check failed'
  }
  $repoWsl = ConvertTo-WslDrvfsPath `
    -Distro $Distro `
    -WindowsPath $repoRoot `
    -FailureMessage 'Repository path could not be converted to a WSL drvfs path'
  wsl.exe -d $Distro --exec env `
    "VALIDATION_TOKEN=$validationToken" `
    "REPO_ROOT=$repoWsl" `
    "STABLE_GATE_OWNER_TOKEN=$StableGateOwnerToken" `
    'CLEANUP_ONLY=true' `
    bash "$repoWsl/scripts/wsl-runtime-validation.sh"
  if ($LASTEXITCODE -ne 0) {
    throw 'Owner-bound WSL fallback cleanup failed'
  }
  if (
    -not (Test-Path -LiteralPath $runtimeOwnerMarker -PathType Leaf) -or
    -not [StringComparer]::Ordinal.Equals(
      (Get-Content -LiteralPath $runtimeOwnerMarker -Raw),
      $validationToken
    )
  ) {
    throw 'Cleanup-only runtime ownership changed'
  }
  [System.IO.Directory]::Delete($cleanupRuntimeDir, $true)
  Write-Output 'SLICE5_RUNTIME_FALLBACK_CLEANUP_COMPLETE'
  return
}

try {
  if (Test-Path -LiteralPath $runtimeDir) {
    throw 'A pre-existing .wsl-runtime directory was found; refusing to take ownership'
  }
  if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) {
    throw 'TCP port 3000 is already listening; refusing to displace another service'
  }
  $sliceFourVerifier = Join-Path $repoRoot 'scripts/verify-slice-4-runtime.mjs'
  if (-not (Test-Path -LiteralPath $sliceFourVerifier -PathType Leaf)) {
    throw 'Slice 4 runtime verifier is missing'
  }
  $stableGateWsl = ''
  if (-not [string]::IsNullOrWhiteSpace($StableGatePath)) {
    $stableGateParent = (
      Resolve-Path -LiteralPath (Split-Path -Parent $StableGatePath)
    ).Path
    $stableGateOwnerMarker = Join-Path $stableGateParent '.slice5-owner'
    $expectedStableGatePath = Join-Path $stableGateParent 'stable-window.gate'
    if (
      $StableGateOwnerToken -notmatch '^[a-f0-9]{32}$' -or
      -not [StringComparer]::OrdinalIgnoreCase.Equals(
        [System.IO.Path]::GetFullPath($StableGatePath),
        [System.IO.Path]::GetFullPath($expectedStableGatePath)
      ) -or
      (Test-Path -LiteralPath $StableGatePath) -or
      -not (Test-Path -LiteralPath $stableGateOwnerMarker -PathType Leaf) -or
      -not [StringComparer]::Ordinal.Equals(
        (Get-Content -LiteralPath $stableGateOwnerMarker -Raw),
        $StableGateOwnerToken
      )
    ) {
      throw 'Stable-window gate ownership check failed'
    }
    $stableGateWsl = ConvertTo-WslDrvfsPath `
      -Distro $Distro `
      -WindowsPath $StableGatePath `
      -FailureMessage 'Stable-window gate path could not be converted to WSL'
  }

  New-Item -ItemType Directory -Path $runtimeDir | Out-Null
  $runtimeOwned = $true
  Set-Content -LiteralPath $runtimeOwnerMarker -Value $validationToken -NoNewline

  corepack pnpm --filter @stay-fable/api-server prisma:generate
  if ($LASTEXITCODE -ne 0) { throw 'Prisma client generation failed' }
  corepack pnpm build
  if ($LASTEXITCODE -ne 0) { throw 'Production build failed' }
  corepack pnpm deploy --filter @stay-fable/api-server --prod (Join-Path $runtimeDir 'api')
  if ($LASTEXITCODE -ne 0) { throw 'API production deployment failed' }
  corepack pnpm deploy --filter @stay-fable/job-worker --prod (Join-Path $runtimeDir 'worker')
  if ($LASTEXITCODE -ne 0) { throw 'Worker production deployment failed' }

  $repoWsl = ConvertTo-WslDrvfsPath `
    -Distro $Distro `
    -WindowsPath $repoRoot `
    -FailureMessage 'Repository path could not be converted to a WSL drvfs path'
  $runtimeWsl = ConvertTo-WslDrvfsPath `
    -Distro $Distro `
    -WindowsPath $runtimeDir `
    -FailureMessage 'Runtime path could not be converted to WSL drvfs'
  if (-not (Test-WslPathInsideRoot -RootPath $repoWsl -CandidatePath $runtimeWsl)) {
    throw 'Runtime path is not inside the current linked worktree'
  }

  $wslValidationStarted = $true
  wsl.exe -d $Distro --exec env `
    "VALIDATION_TOKEN=$validationToken" `
    "REPO_ROOT=$repoWsl" `
    "ARTIFACT_ROOT=$runtimeWsl" `
    "STABLE_GATE_PATH=$stableGateWsl" `
    "STABLE_GATE_OWNER_TOKEN=$StableGateOwnerToken" `
    bash "$repoWsl/scripts/wsl-runtime-validation.sh"
  if ($LASTEXITCODE -ne 0) { throw 'WSL runtime validation failed' }
  $wslCleanupConfirmed = $true
}
finally {
  if (
    $runtimeOwned -and
    (
      -not $wslValidationStarted -or
      $wslCleanupConfirmed
    )
  ) {
    $cleanupRuntimeDir = (Resolve-Path -LiteralPath $runtimeDir -ErrorAction SilentlyContinue).Path
    $expectedRuntimeDir = Join-Path $repoRoot '.wsl-runtime'
    if (
      $null -eq $cleanupRuntimeDir -or
      -not [StringComparer]::OrdinalIgnoreCase.Equals($cleanupRuntimeDir, $expectedRuntimeDir) -or
      -not (Test-Path -LiteralPath $runtimeOwnerMarker -PathType Leaf) -or
      -not [StringComparer]::Ordinal.Equals(
        (Get-Content -LiteralPath $runtimeOwnerMarker -Raw),
        $validationToken
      )
    ) {
      throw 'Runtime ownership check failed; refusing cleanup'
    }
    [System.IO.Directory]::Delete($cleanupRuntimeDir, $true)
    if (
      -not $wslValidationStarted -and
      -not [string]::IsNullOrWhiteSpace($StableGateOwnerToken)
    ) {
      Write-Output (
        'SLICE2_RUNTIME_CLEANUP_COMPLETE OWNER=' +
        $StableGateOwnerToken
      )
    }
  }
}

git status --short
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect final Git status' }

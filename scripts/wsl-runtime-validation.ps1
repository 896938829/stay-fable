[CmdletBinding()]
param(
  [string]$Distro = 'Ubuntu-22.04'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (git rev-parse --show-toplevel)).Path
$currentPath = (Resolve-Path -LiteralPath (Get-Location).ProviderPath).Path
if (-not [StringComparer]::OrdinalIgnoreCase.Equals($currentPath, $repoRoot)) {
  throw 'Refusing validation: run this script from the linked worktree root'
}

$runtimeDir = Join-Path $repoRoot '.wsl-runtime'
$runtimeOwnerMarker = Join-Path $runtimeDir '.stay-fable-validation-owner'
$validationToken = [Guid]::NewGuid().ToString('N')
$runtimeOwned = $false

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

  $repoWsl = (wsl.exe -d $Distro -- wslpath -a $repoRoot).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $repoWsl.StartsWith('/mnt/')) {
    throw 'Repository path could not be converted to a WSL drvfs path'
  }
  $runtimeWsl = (wsl.exe -d $Distro -- wslpath -a $runtimeDir).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $runtimeWsl.StartsWith("$repoWsl/")) {
    throw 'Runtime path is not inside the current linked worktree'
  }

  wsl.exe -d $Distro -- env `
    "VALIDATION_TOKEN=$validationToken" `
    "REPO_ROOT=$repoWsl" `
    "ARTIFACT_ROOT=$runtimeWsl" `
    bash "$repoWsl/scripts/wsl-runtime-validation.sh"
  if ($LASTEXITCODE -ne 0) { throw 'WSL runtime validation failed' }
}
finally {
  if ($runtimeOwned) {
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
  }
}

git status --short
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect final Git status' }

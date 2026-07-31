[CmdletBinding()]
param(
  [ValidateSet('Up', 'Status', 'Down')]
  [string]$Action = 'Status',
  [string]$Distro = 'Ubuntu-22.04'
)

$ErrorActionPreference = 'Stop'

function ConvertTo-DemoWslPath {
  param(
    [Parameter(Mandatory)][string]$DistroName,
    [Parameter(Mandatory)][string]$WindowsPath
  )

  if (
    $DistroName -notmatch '^[A-Za-z0-9._-]{1,64}$' -or
    $WindowsPath -notmatch '^[A-Za-z]:[\\/]'
  ) {
    throw 'Demo path configuration is invalid'
  }
  $normalized = $WindowsPath.Replace([char]92, [char]47)
  $output = @(wsl.exe -d $DistroName --exec wslpath -a $normalized)
  if (
    $LASTEXITCODE -ne 0 -or
    $output.Count -ne 1 -or
    [string]::IsNullOrWhiteSpace([string]$output[0])
  ) {
    throw 'Demo path could not be converted to WSL'
  }
  $converted = ([string]$output[0]).Trim()
  if ($converted -notmatch '^/mnt/[a-z](?:/|$)') {
    throw 'Demo WSL path is outside drvfs'
  }
  return $converted
}

function Get-DemoContext {
  $repoRoot = (Resolve-Path -LiteralPath (git rev-parse --show-toplevel)).Path
  if ($LASTEXITCODE -ne 0) {
    throw 'Unable to resolve repository root'
  }
  $currentPath = (Resolve-Path -LiteralPath (Get-Location).ProviderPath).Path
  if (-not [StringComparer]::OrdinalIgnoreCase.Equals($repoRoot, $currentPath)) {
    throw 'Run the Demo command from the linked worktree root'
  }
  $runtimePath = Join-Path $repoRoot '.demo-runtime'
  return [pscustomobject]@{
    RepoRoot = $repoRoot
    RuntimePath = $runtimePath
    OwnerMarker = Join-Path $runtimePath '.stay-fable-demo-owner'
  }
}

function Read-DemoOwnerToken {
  param([Parameter(Mandatory)][object]$Context)

  if (
    -not (Test-Path -LiteralPath $Context.RuntimePath -PathType Container) -or
    -not (Test-Path -LiteralPath $Context.OwnerMarker -PathType Leaf)
  ) {
    throw 'Demo runtime is not initialized; run demo:up first'
  }
  $token = Get-Content -LiteralPath $Context.OwnerMarker -Raw
  if ($token -notmatch '^[a-f0-9]{32}$') {
    throw 'Demo owner token is invalid'
  }
  return $token
}

function Invoke-DemoWsl {
  param(
    [Parameter(Mandatory)][object]$Context,
    [Parameter(Mandatory)][string]$OwnerToken,
    [Parameter(Mandatory)][ValidateSet('infra-up', 'services-up', 'status', 'down')]
    [string]$WslAction
  )

  $repoWsl = ConvertTo-DemoWslPath -DistroName $Distro -WindowsPath $Context.RepoRoot
  $runtimeWsl = ConvertTo-DemoWslPath -DistroName $Distro -WindowsPath $Context.RuntimePath
  $expectedRuntimeWsl = "$($repoWsl.TrimEnd('/'))/.demo-runtime"
  if (-not [StringComparer]::Ordinal.Equals($runtimeWsl, $expectedRuntimeWsl)) {
    throw 'Demo artifact root is outside the current linked worktree'
  }

  wsl.exe -d $Distro --exec env `
    "DEMO_ACTION=$WslAction" `
    "DEMO_OWNER_TOKEN=$OwnerToken" `
    "REPO_ROOT=$repoWsl" `
    "ARTIFACT_ROOT=$runtimeWsl" `
    bash "$repoWsl/scripts/demo-runtime.sh"
  if ($LASTEXITCODE -ne 0) {
    throw "Demo WSL action failed: $WslAction"
  }
}

function Remove-DemoRuntime {
  param(
    [Parameter(Mandatory)][object]$Context,
    [Parameter(Mandatory)][string]$OwnerToken
  )

  $resolved = (Resolve-Path -LiteralPath $Context.RuntimePath -ErrorAction Stop).Path
  $expected = [System.IO.Path]::GetFullPath(
    (Join-Path $Context.RepoRoot '.demo-runtime')
  )
  if (
    -not [StringComparer]::OrdinalIgnoreCase.Equals($resolved, $expected) -or
    -not (Test-Path -LiteralPath $Context.OwnerMarker -PathType Leaf) -or
    -not [StringComparer]::Ordinal.Equals(
      (Get-Content -LiteralPath $Context.OwnerMarker -Raw),
      $OwnerToken
    )
  ) {
    throw 'Demo runtime ownership changed; refusing cleanup'
  }
  [System.IO.Directory]::Delete($resolved, $true)
}

function Assert-DemoHost {
  if ($Distro -notmatch '^[A-Za-z0-9._-]{1,64}$') {
    throw 'Invalid WSL distribution name'
  }
  $nodeVersion = (& node --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v24\.') {
    throw "Node.js 24 is required; found $nodeVersion"
  }
  $pnpmVersion = (& corepack pnpm --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $pnpmVersion -ne '11.17.0') {
    throw "pnpm 11.17.0 is required; found $pnpmVersion"
  }
  wsl.exe -d $Distro --exec docker info --format '{{.ServerVersion}}' | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Docker Engine is unavailable in $Distro"
  }
}

function Invoke-DemoUp {
  param([Parameter(Mandatory)][object]$Context)

  if (Test-Path -LiteralPath $Context.RuntimePath) {
    throw 'A Demo runtime already exists; use demo:status or demo:down'
  }
  if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) {
    throw 'TCP port 3000 is already listening; refusing to displace another service'
  }

  Assert-DemoHost
  $ownerToken = [Guid]::NewGuid().ToString('N')
  $runtimeOwned = $false
  $wslStarted = $false
  $cleanupConfirmed = $false
  try {
    [System.IO.Directory]::CreateDirectory($Context.RuntimePath) | Out-Null
    [System.IO.File]::WriteAllText(
      $Context.OwnerMarker,
      $ownerToken,
      [System.Text.UTF8Encoding]::new($false)
    )
    $runtimeOwned = $true
    $apiArtifact = Join-Path $Context.RuntimePath 'api'
    $workerArtifact = Join-Path $Context.RuntimePath 'worker'

    corepack pnpm --filter @stay-fable/api-server prisma:generate
    if ($LASTEXITCODE -ne 0) { throw 'Prisma client generation failed' }
    corepack pnpm build
    if ($LASTEXITCODE -ne 0) { throw 'Workspace production build failed' }
    corepack pnpm deploy --filter @stay-fable/api-server --prod $apiArtifact
    if ($LASTEXITCODE -ne 0) { throw 'API deployment artifact failed' }
    corepack pnpm deploy --filter @stay-fable/job-worker --prod $workerArtifact
    if ($LASTEXITCODE -ne 0) { throw 'Worker deployment artifact failed' }

    $wslStarted = $true
    Invoke-DemoWsl `
      -Context $Context `
      -OwnerToken $ownerToken `
      -WslAction 'infra-up'

    $previousDatabaseUrl = $env:DATABASE_URL
    $previousCatalogStartDate = $env:STAY_FABLE_CATALOG_START_DATE
    try {
      $env:DATABASE_URL = (
        'postgresql://stay_fable:local_only_password@127.0.0.1:55432/' +
        'stay_fable?schema=public&sslmode=disable'
      )
      $chinaZone = [System.TimeZoneInfo]::FindSystemTimeZoneById(
        'China Standard Time'
      )
      $env:STAY_FABLE_CATALOG_START_DATE = (
        [System.TimeZoneInfo]::ConvertTimeFromUtc(
          [DateTime]::UtcNow,
          $chinaZone
        ).ToString('yyyy-MM-dd')
      )
      corepack pnpm --filter @stay-fable/api-server prisma:migrate
      if ($LASTEXITCODE -ne 0) { throw 'Demo database migration failed' }
      corepack pnpm --filter @stay-fable/api-server prisma:seed
      if ($LASTEXITCODE -ne 0) { throw 'Demo seed failed' }
    }
    finally {
      $env:DATABASE_URL = $previousDatabaseUrl
      $env:STAY_FABLE_CATALOG_START_DATE = $previousCatalogStartDate
    }

    Invoke-DemoWsl `
      -Context $Context `
      -OwnerToken $ownerToken `
      -WslAction 'services-up'
    Write-Output "STAY_FABLE_DEMO_WECHAT_PROJECT $($Context.RepoRoot)\wx"
  }
  catch {
    $originalError = $_
    if ($wslStarted) {
      try {
        Invoke-DemoWsl `
          -Context $Context `
          -OwnerToken $ownerToken `
          -WslAction 'down'
        $cleanupConfirmed = $true
      }
      catch {
        Write-Warning 'Demo WSL cleanup was not confirmed; runtime ownership was preserved'
      }
    }
    elseif ($runtimeOwned) {
      $cleanupConfirmed = $true
    }
    if ($runtimeOwned -and $cleanupConfirmed) {
      Remove-DemoRuntime -Context $Context -OwnerToken $ownerToken
    }
    throw $originalError
  }
}

function Invoke-DemoAction {
  $context = Get-DemoContext
  switch ($Action) {
    'Up' {
      Invoke-DemoUp -Context $context
    }
    'Status' {
      Assert-DemoHost
      $ownerToken = Read-DemoOwnerToken -Context $context
      Invoke-DemoWsl `
        -Context $context `
        -OwnerToken $ownerToken `
        -WslAction 'status'
    }
    'Down' {
      Assert-DemoHost
      $ownerToken = Read-DemoOwnerToken -Context $context
      Invoke-DemoWsl `
        -Context $context `
        -OwnerToken $ownerToken `
        -WslAction 'down'
      Remove-DemoRuntime -Context $context -OwnerToken $ownerToken
    }
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  Invoke-DemoAction
}

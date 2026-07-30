[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$RepoRoot,

  [ValidateRange(1, 65535)]
  [int]$Port = 55432,

  [AllowEmptyString()]
  [string]$CatalogStartDate
)

$ErrorActionPreference = 'Stop'
$catalogStartDateSupplied = $PSBoundParameters.ContainsKey('CatalogStartDate')
if ($catalogStartDateSupplied) {
  $parsedCatalogStartDate = [DateTime]::MinValue
  if (
    $CatalogStartDate -notmatch '^(?!0000)\d{4}-\d{2}-\d{2}$' -or
    -not [DateTime]::TryParseExact(
      $CatalogStartDate,
      'yyyy-MM-dd',
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::None,
      [ref]$parsedCatalogStartDate
    )
  ) {
    throw 'Catalog start date must be a real YYYY-MM-DD date'
  }
  if (
    [StringComparer]::Ordinal.Compare(
      $CatalogStartDate,
      '9999-11-02'
    ) -gt 0
  ) {
    throw 'Catalog start date must leave the full 60-day window within four-digit years'
  }
}
$resolvedRepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$gitRepoRoot = (Resolve-Path -LiteralPath (git -C $resolvedRepoRoot rev-parse --show-toplevel)).Path
if (-not [StringComparer]::OrdinalIgnoreCase.Equals($resolvedRepoRoot, $gitRepoRoot)) {
  throw 'Database bootstrap repository path is not a linked worktree root'
}

$previousDatabaseUrl = $env:DATABASE_URL
$catalogStartDateWasPresent = Test-Path Env:STAY_FABLE_CATALOG_START_DATE
$previousCatalogStartDate = $env:STAY_FABLE_CATALOG_START_DATE
try {
  $env:DATABASE_URL = "postgresql://stay_fable:local_only_password@127.0.0.1:$Port/stay_fable?schema=public&sslmode=disable"
  if ($catalogStartDateSupplied) {
    $env:STAY_FABLE_CATALOG_START_DATE = $CatalogStartDate
  }
  else {
    Remove-Item Env:STAY_FABLE_CATALOG_START_DATE -ErrorAction SilentlyContinue
  }
  Push-Location -LiteralPath $resolvedRepoRoot
  try {
    corepack pnpm --filter @stay-fable/api-server prisma:migrate
    if ($LASTEXITCODE -ne 0) { throw 'Prisma migrate deploy failed' }
    corepack pnpm --filter @stay-fable/api-server prisma:seed
    if ($LASTEXITCODE -ne 0) { throw 'Deterministic city seed failed' }
  }
  finally {
    Pop-Location
  }
}
finally {
  $env:DATABASE_URL = $previousDatabaseUrl
  if ($catalogStartDateWasPresent) {
    $env:STAY_FABLE_CATALOG_START_DATE = $previousCatalogStartDate
  }
  else {
    Remove-Item Env:STAY_FABLE_CATALOG_START_DATE -ErrorAction SilentlyContinue
  }
}

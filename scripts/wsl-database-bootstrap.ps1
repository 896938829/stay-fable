[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$RepoRoot,

  [ValidateRange(1, 65535)]
  [int]$Port = 55432
)

$ErrorActionPreference = 'Stop'
$resolvedRepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$gitRepoRoot = (Resolve-Path -LiteralPath (git -C $resolvedRepoRoot rev-parse --show-toplevel)).Path
if (-not [StringComparer]::OrdinalIgnoreCase.Equals($resolvedRepoRoot, $gitRepoRoot)) {
  throw 'Database bootstrap repository path is not a linked worktree root'
}

$previousDatabaseUrl = $env:DATABASE_URL
try {
  $env:DATABASE_URL = "postgresql://stay_fable:local_only_password@127.0.0.1:$Port/stay_fable?schema=public&sslmode=disable"
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
}

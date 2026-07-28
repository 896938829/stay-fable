# Local development

## Prerequisites

- Node.js 24
- Corepack with pnpm 11.17.0
- Docker Desktop with Docker Compose v2
- WeChat DevTools

## First start

From the repository root:

```powershell
Copy-Item .env.example .env
pnpm install
docker compose -f infrastructure/compose.yaml up -d --wait --wait-timeout 120
node scripts/check-local-infrastructure.mjs
pnpm dev
```

PostgreSQL/PostGIS and Redis are bound to `127.0.0.1` only. Their ports
(`5432` and `6379`) are available to applications on this computer, not to
other computers on the network.

If another service already occupies either default port (a common case in
WSL2), select unused host ports before starting Compose:

```powershell
$env:POSTGRES_PORT = "55432"
$env:REDIS_PORT = "56379"
docker compose -f infrastructure/compose.yaml up -d --wait --wait-timeout 120
```

Use the selected PostgreSQL and Redis ports in `.env` for that session.

## Stop

Stop the local services without deleting their data:

```powershell
docker compose -f infrastructure/compose.yaml stop
```

## Destructive local reset

> **Warning:** This deletes all data in the local PostgreSQL and Redis volumes.
> Use it only for local development. Never run a destructive reset against
> production infrastructure.

```powershell
docker compose -f infrastructure/compose.yaml down --volumes
```

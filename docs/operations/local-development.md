# Local development

## Prerequisites

- Node.js 24
- Corepack with pnpm 11.17
- Docker Desktop with Docker Compose v2
- WeChat DevTools

## First start

From the repository root:

```powershell
Copy-Item .env.example .env
pnpm install
docker compose -f infrastructure/compose.yaml up -d
node scripts/check-local-infrastructure.mjs
pnpm dev
```

PostgreSQL/PostGIS and Redis are bound to `127.0.0.1` only. Their ports
(`5432` and `6379`) are available to applications on this computer, not to
other computers on the network.

## Stop

Stop the local services without deleting their data:

```powershell
docker compose -f infrastructure/compose.yaml down
```

## Destructive local reset

> **Warning:** This deletes all data in the local PostgreSQL and Redis volumes.
> Use it only for local development. Never run a destructive reset against
> production infrastructure.

```powershell
docker compose -f infrastructure/compose.yaml down --volumes
```

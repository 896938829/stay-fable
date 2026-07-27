# Stay Fable Phase 0 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reproducible, testable monorepo foundation with local infrastructure, deployable application shells, CI security gates, environment separation, and launch-compliance records.

**Architecture:** Use a pnpm/Turborepo monorepo containing a Taro consumer shell, React management shell, NestJS API, and BullMQ worker. PostgreSQL/PostGIS and Redis run locally in Docker; production uses CloudBase Run and private Tencent Cloud managed services. Phase 0 creates no booking-domain functionality and ends with health checks, build artifacts, security checks, and reviewed operational evidence.

**Tech Stack:** Node.js 24, pnpm 11.17.0, TypeScript 7.0.2, Taro 4.2.1, React 19.2.8, Vite 8.1.5, NestJS 11.1.28, Prisma 7.9.0, PostgreSQL 17/PostGIS, Redis 7, BullMQ 5.81.2, Vitest 4.1.10, Docker Compose, GitHub Actions.

**Source Spec:** `docs/superpowers/specs/2026-07-27-stay-fable-platform-architecture-design.md`

---

## Scope and sequencing

This plan implements only Phase 0 from the approved architecture specification:

- repository and package boundaries;
- local PostgreSQL/PostGIS and Redis;
- runnable API, worker, management Web, and multi-platform mini-program shells;
- type checking, linting, unit/integration tests, builds, container images, and CI;
- environment, secret, observability, security, backup, privacy, and cloud-provisioning records.

It does not implement users, merchants, properties, inventory, orders, payments, refunds, promotions, reviews, or production analytics. Those belong to later phase-specific plans.

## Target file map

```text
stay-fable/
├─ .github/workflows/ci.yml
├─ apps/
│  ├─ api-server/
│  │  ├─ prisma/
│  │  ├─ src/config/
│  │  ├─ src/database/
│  │  ├─ src/health/
│  │  ├─ src/observability/
│  │  ├─ test/
│  │  ├─ Dockerfile
│  │  └─ package.json
│  ├─ job-worker/
│  │  ├─ src/
│  │  ├─ test/
│  │  ├─ Dockerfile
│  │  └─ package.json
│  ├─ management-web/
│  │  ├─ src/
│  │  └─ package.json
│  └─ consumer-miniapp/
│     ├─ config/
│     ├─ src/platform/
│     ├─ src/pages/index/
│     └─ package.json
├─ packages/
│  ├─ api-contracts/
│  ├─ eslint-config/
│  ├─ tsconfig/
│  └─ validation/
├─ infrastructure/
│  ├─ compose.yaml
│  ├─ cloud/
│  └─ runbooks/
├─ docs/
│  ├─ compliance/
│  ├─ operations/
│  └─ superpowers/
├─ scripts/
├─ .env.example
├─ .editorconfig
├─ .gitattributes
├─ .gitignore
├─ .npmrc
├─ .nvmrc
├─ eslint.config.mjs
├─ package.json
├─ pnpm-lock.yaml
├─ pnpm-workspace.yaml
├─ prettier.config.mjs
├─ tsconfig.json
└─ turbo.json
```

## Task 1: Establish the workspace contract

**Files:**

- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `.npmrc`
- Create: `.nvmrc`
- Create: `.editorconfig`
- Create: `.gitattributes`
- Create: `.gitignore`
- Create: `prettier.config.mjs`
- Create: `scripts/verify-workspace.mjs`
- Test: `scripts/verify-workspace.test.mjs`

- [ ] **Step 1: Write the failing workspace contract test**

Create `scripts/verify-workspace.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("root workspace pins the package manager and required applications", async () => {
  const root = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  const workspace = await readFile(
    new URL("../pnpm-workspace.yaml", import.meta.url),
    "utf8",
  );

  assert.equal(root.private, true);
  assert.equal(root.packageManager, "pnpm@11.17.0");
  assert.match(workspace, /apps\/\*/);
  assert.match(workspace, /packages\/\*/);
  assert.equal(root.scripts.verify, "node scripts/verify-workspace.mjs");
});
```

- [ ] **Step 2: Run the test and verify the expected failure**

Run:

```powershell
node --test scripts/verify-workspace.test.mjs
```

Expected: FAIL with `ENOENT` for `package.json` or `pnpm-workspace.yaml`.

- [ ] **Step 3: Create the root workspace files**

Create `package.json`:

```json
{
  "name": "stay-fable",
  "version": "0.0.0",
  "private": true,
  "packageManager": "pnpm@11.17.0",
  "engines": {
    "node": ">=24 <25"
  },
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev --parallel",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "lint": "turbo run lint",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "verify": "node scripts/verify-workspace.mjs",
    "check": "pnpm verify && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build"
  },
  "devDependencies": {
    "prettier": "3.9.6",
    "turbo": "2.10.7",
    "typescript": "7.0.2"
  }
}
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - apps/*
  - packages/*
```

Create `turbo.json`:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".taro/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "lint": {
      "dependsOn": ["^lint"]
    },
    "test": {
      "dependsOn": ["^build"],
      "outputs": ["coverage/**"]
    },
    "typecheck": {
      "dependsOn": ["^build"]
    }
  }
}
```

Create `.npmrc`:

```ini
auto-install-peers=false
engine-strict=true
frozen-lockfile=false
inject-workspace-packages=true
strict-peer-dependencies=true
```

Create `.nvmrc`:

```text
24
```

Create `.editorconfig`:

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
```

Create `.gitattributes`:

```gitattributes
* text=auto eol=lf
*.png binary
*.jpg binary
*.jpeg binary
*.webp binary
*.woff2 binary
```

Create `.gitignore`:

```gitignore
node_modules/
dist/
coverage/
.turbo/
.taro/
.env
.env.*
!.env.example
*.log
.DS_Store
Thumbs.db
apps/consumer-miniapp/dist/
apps/api-server/src/generated/
infrastructure/local-data/
```

Create `prettier.config.mjs`:

```js
export default {
  endOfLine: "lf",
  printWidth: 100,
  semi: true,
  singleQuote: false,
  trailingComma: "all",
};
```

- [ ] **Step 4: Implement the workspace verifier**

Create `scripts/verify-workspace.mjs`:

```js
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const requiredPaths = [
  "apps/api-server/package.json",
  "apps/job-worker/package.json",
  "apps/management-web/package.json",
  "apps/consumer-miniapp/package.json",
  "packages/api-contracts/package.json",
  "packages/validation/package.json",
];

const root = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(root.packageManager, "pnpm@11.17.0");
assert.equal(root.engines.node, ">=24 <25");

for (const path of requiredPaths) {
  await access(path);
}

process.stdout.write("Workspace contract verified.\n");
```

- [ ] **Step 5: Install the pinned root toolchain and rerun the test**

Run:

```powershell
corepack enable
corepack prepare pnpm@11.17.0 --activate
pnpm install
node --test scripts/verify-workspace.test.mjs
```

Expected: the Node test passes. `pnpm install` creates `pnpm-lock.yaml`.

- [ ] **Step 6: Commit the workspace contract**

```powershell
git add package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json .npmrc .nvmrc .editorconfig .gitattributes .gitignore prettier.config.mjs scripts
git commit -m "chore: establish monorepo workspace contract"
```

## Task 2: Add shared TypeScript, lint, validation, and API contracts

**Files:**

- Create: `tsconfig.json`
- Create: `eslint.config.mjs`
- Create: `packages/tsconfig/package.json`
- Create: `packages/tsconfig/base.json`
- Create: `packages/eslint-config/package.json`
- Create: `packages/eslint-config/index.mjs`
- Create: `packages/validation/package.json`
- Create: `packages/validation/src/environment.ts`
- Create: `packages/validation/test/environment.test.ts`
- Create: `packages/api-contracts/package.json`
- Create: `packages/api-contracts/src/health.ts`
- Create: `packages/api-contracts/test/health.test.ts`

- [ ] **Step 1: Write failing shared-package tests**

Create `packages/validation/test/environment.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseRuntimeEnvironment } from "../src/environment";

describe("parseRuntimeEnvironment", () => {
  it("rejects production configuration that disables database TLS", () => {
    expect(() =>
      parseRuntimeEnvironment({
        NODE_ENV: "production",
        PORT: "3000",
        DATABASE_URL: "postgresql://app:secret@db:5432/stay_fable?sslmode=disable",
        REDIS_URL: "redis://redis:6379",
      }),
    ).toThrow("Production DATABASE_URL must require TLS");
  });
});
```

Create `packages/api-contracts/test/health.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { healthResponseSchema } from "../src/health";

describe("healthResponseSchema", () => {
  it("accepts the stable readiness response", () => {
    expect(
      healthResponseSchema.parse({
        status: "ok",
        service: "api-server",
        checks: { database: "up", redis: "up" },
      }),
    ).toEqual({
      status: "ok",
      service: "api-server",
      checks: { database: "up", redis: "up" },
    });
  });
});
```

- [ ] **Step 2: Run the tests and verify missing-module failures**

Run:

```powershell
pnpm dlx vitest@4.1.10 run packages/validation/test packages/api-contracts/test
```

Expected: FAIL because the source modules do not exist.

- [ ] **Step 3: Add shared TypeScript and ESLint configuration**

Create `tsconfig.json`:

```json
{
  "extends": "./packages/tsconfig/base.json",
  "files": []
}
```

Create `packages/tsconfig/package.json`:

```json
{
  "name": "@stay-fable/tsconfig",
  "version": "0.0.0",
  "private": true,
  "files": ["base.json"]
}
```

Create `packages/tsconfig/base.json`:

```json
{
  "compilerOptions": {
    "allowJs": false,
    "declaration": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true,
    "noUncheckedIndexedAccess": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "strict": true,
    "target": "ES2023"
  }
}
```

Create `packages/eslint-config/package.json`:

```json
{
  "name": "@stay-fable/eslint-config",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./index.mjs",
  "dependencies": {
    "@eslint/js": "10.0.1",
    "eslint": "10.8.0",
    "typescript-eslint": "8.65.0"
  }
}
```

Create `packages/eslint-config/index.mjs`:

```js
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", "**/src/generated/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: process.cwd(),
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
);
```

Create root `eslint.config.mjs`:

```js
export { default } from "./packages/eslint-config/index.mjs";
```

- [ ] **Step 4: Implement environment validation**

Create `packages/validation/package.json`:

```json
{
  "name": "@stay-fable/validation",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/environment.ts",
      "default": "./dist/src/environment.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "eslint src test",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "zod": "4.4.3"
  },
  "devDependencies": {
    "vitest": "4.1.10"
  }
}
```

Create `packages/validation/src/environment.ts`:

```ts
import { z } from "zod";

const runtimeEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
});

export type RuntimeEnvironment = z.infer<typeof runtimeEnvironmentSchema>;

export function parseRuntimeEnvironment(
  input: Record<string, unknown>,
): RuntimeEnvironment {
  const environment = runtimeEnvironmentSchema.parse(input);

  if (
    environment.NODE_ENV === "production" &&
    !environment.DATABASE_URL.includes("sslmode=require")
  ) {
    throw new Error("Production DATABASE_URL must require TLS");
  }

  return environment;
}
```

Add `packages/validation/tsconfig.json`:

```json
{
  "extends": "../tsconfig/base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 5: Implement the health contract**

Create `packages/api-contracts/package.json`:

```json
{
  "name": "@stay-fable/api-contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    "./health": {
      "types": "./src/health.ts",
      "default": "./dist/src/health.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "eslint src test",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "zod": "4.4.3"
  },
  "devDependencies": {
    "vitest": "4.1.10"
  }
}
```

Create `packages/api-contracts/src/health.ts`:

```ts
import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.string().min(1),
  checks: z.record(z.string(), z.enum(["up", "down"])).optional(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
```

Add `packages/api-contracts/tsconfig.json`:

```json
{
  "extends": "../tsconfig/base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 6: Install dependencies and verify shared packages**

Run:

```powershell
pnpm install
pnpm --filter @stay-fable/validation test
pnpm --filter @stay-fable/api-contracts test
pnpm --filter @stay-fable/validation typecheck
pnpm --filter @stay-fable/api-contracts typecheck
```

Expected: all commands pass.

- [ ] **Step 7: Commit the shared foundation**

```powershell
git add tsconfig.json eslint.config.mjs packages
git commit -m "chore: add shared contracts and validation"
```

## Task 3: Provision reproducible local infrastructure

**Files:**

- Create: `.env.example`
- Create: `infrastructure/compose.yaml`
- Create: `infrastructure/postgres/init/001_extensions.sql`
- Create: `scripts/check-local-infrastructure.mjs`
- Test: `scripts/check-local-infrastructure.test.mjs`
- Create: `docs/operations/local-development.md`

- [ ] **Step 1: Write the failing infrastructure contract test**

Create `scripts/check-local-infrastructure.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("local compose defines healthy PostGIS and Redis services", async () => {
  const compose = await readFile(
    new URL("../infrastructure/compose.yaml", import.meta.url),
    "utf8",
  );

  assert.match(compose, /postgis\/postgis:17-3\.5/);
  assert.match(compose, /redis:7\.4-alpine/);
  assert.match(compose, /pg_isready/);
  assert.match(compose, /redis-cli/);
});
```

- [ ] **Step 2: Verify the test fails**

Run:

```powershell
node --test scripts/check-local-infrastructure.test.mjs
```

Expected: FAIL because `infrastructure/compose.yaml` does not exist.

- [ ] **Step 3: Define non-secret local environment defaults**

Create `.env.example`:

```dotenv
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://stay_fable:local_only_password@127.0.0.1:5432/stay_fable?schema=public&sslmode=disable
REDIS_URL=redis://127.0.0.1:6379
LOG_LEVEL=debug
```

Create `infrastructure/compose.yaml`:

```yaml
name: stay-fable-local

services:
  postgres:
    image: postgis/postgis:17-3.5
    environment:
      POSTGRES_DB: stay_fable
      POSTGRES_USER: stay_fable
      POSTGRES_PASSWORD: local_only_password
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
      - ./postgres/init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U stay_fable -d stay_fable"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 10s

  redis:
    image: redis:7.4-alpine
    command: ["redis-server", "--appendonly", "yes"]
    ports:
      - "127.0.0.1:6379:6379"
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 5s

volumes:
  postgres-data:
  redis-data:
```

Create `infrastructure/postgres/init/001_extensions.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
```

- [ ] **Step 4: Implement the runtime infrastructure check**

Create `scripts/check-local-infrastructure.mjs`:

```js
import { execFileSync } from "node:child_process";

const compose = ["compose", "-f", "infrastructure/compose.yaml"];

execFileSync("docker", [...compose, "config", "--quiet"], { stdio: "inherit" });

const output = execFileSync("docker", [...compose, "ps", "--format", "json"], {
  encoding: "utf8",
});

const services = output
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

for (const serviceName of ["postgres", "redis"]) {
  const service = services.find((entry) => entry.Service === serviceName);
  if (!service || service.Health !== "healthy") {
    throw new Error(`${serviceName} is not healthy`);
  }
}

process.stdout.write("Local PostgreSQL/PostGIS and Redis are healthy.\n");
```

- [ ] **Step 5: Document exact local startup and reset behavior**

Create `docs/operations/local-development.md`:

```markdown
# Local development

## Prerequisites

- Node.js 24
- Corepack with pnpm 11.17.0
- Docker Desktop with Compose v2
- WeChat Developer Tools for mini-program preview

## First start

1. Copy `.env.example` to `.env`.
2. Run `pnpm install`.
3. Run `docker compose -f infrastructure/compose.yaml up -d`.
4. Run `node scripts/check-local-infrastructure.mjs`.
5. Run `pnpm dev`.

Local ports bind only to `127.0.0.1`.

## Stop without deleting data

Run `docker compose -f infrastructure/compose.yaml stop`.

## Intentional local data reset

Run `docker compose -f infrastructure/compose.yaml down --volumes`.
This permanently removes only the named local Docker volumes for this Compose project.
Never use this command against production infrastructure.
```

- [ ] **Step 6: Start dependencies and verify health**

Run:

```powershell
node --test scripts/check-local-infrastructure.test.mjs
docker compose -f infrastructure/compose.yaml config --quiet
docker compose -f infrastructure/compose.yaml up -d
node scripts/check-local-infrastructure.mjs
docker compose -f infrastructure/compose.yaml exec postgres psql -U stay_fable -d stay_fable -c "SELECT PostGIS_Version();"
```

Expected: the Node test passes, both containers become healthy, and PostgreSQL prints a PostGIS version.

- [ ] **Step 7: Commit the local infrastructure**

```powershell
git add .env.example infrastructure scripts docs/operations/local-development.md
git commit -m "chore: add local postgres and redis infrastructure"
```

## Task 4: Build the NestJS API shell with secure health checks

**Files:**

- Create: `apps/api-server/package.json`
- Create: `apps/api-server/tsconfig.json`
- Create: `apps/api-server/tsconfig.build.json`
- Create: `apps/api-server/nest-cli.json`
- Create: `apps/api-server/prisma.config.ts`
- Create: `apps/api-server/prisma/schema.prisma`
- Create: `apps/api-server/src/main.ts`
- Create: `apps/api-server/src/app.module.ts`
- Create: `apps/api-server/src/config/runtime.config.ts`
- Create: `apps/api-server/src/database/database.service.ts`
- Create: `apps/api-server/src/health/health.controller.ts`
- Create: `apps/api-server/src/health/health.service.ts`
- Test: `apps/api-server/test/health.e2e-spec.ts`

- [ ] **Step 1: Write the failing health endpoint test**

Create `apps/api-server/test/health.e2e-spec.ts`:

```ts
import { Test } from "@nestjs/testing";
import request from "supertest";
import { HealthController } from "../src/health/health.controller";
import { HealthService } from "../src/health/health.service";

describe("health endpoints", () => {
  it("returns a stable liveness response", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthService,
          useValue: {
            live: () => ({ status: "ok", service: "api-server" }),
            ready: () => ({
              status: "ok",
              service: "api-server",
              checks: { database: "up", redis: "up" },
            }),
          },
        },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer())
      .get("/health/live")
      .expect(200)
      .expect({ status: "ok", service: "api-server" });

    await app.close();
  });
});
```

- [ ] **Step 2: Run the test and verify missing-module failure**

Run:

```powershell
pnpm --filter @stay-fable/api-server test
```

Expected: FAIL because the package and health modules do not exist.

- [ ] **Step 3: Add the API package and Prisma 7 configuration**

Create `apps/api-server/package.json`:

```json
{
  "name": "@stay-fable/api-server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "nest build",
    "dev": "nest start --watch",
    "lint": "eslint src test prisma.config.ts",
    "prisma:generate": "prisma generate",
    "prisma:migrate": "prisma migrate deploy",
    "start": "node dist/main.js",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@nestjs/common": "11.1.28",
    "@nestjs/config": "4.0.4",
    "@nestjs/core": "11.1.28",
    "@nestjs/platform-express": "11.1.28",
    "@nestjs/swagger": "11.4.6",
    "@prisma/adapter-pg": "7.9.0",
    "@prisma/client": "7.9.0",
    "@stay-fable/api-contracts": "workspace:*",
    "@stay-fable/validation": "workspace:*",
    "dotenv": "17.4.2",
    "helmet": "8.3.0",
    "ioredis": "5.11.1",
    "nestjs-pino": "4.6.1",
    "pg": "8.22.0",
    "pino": "10.3.1",
    "reflect-metadata": "0.2.2",
    "rxjs": "7.8.2"
  },
  "devDependencies": {
    "@nestjs/cli": "11.0.24",
    "@nestjs/testing": "11.1.28",
    "@types/pg": "8.20.0",
    "@types/supertest": "7.2.1",
    "prisma": "7.9.0",
    "supertest": "7.2.2",
    "vitest": "4.1.10"
  }
}
```

Create `apps/api-server/tsconfig.json`:

```json
{
  "extends": "../../packages/tsconfig/base.json",
  "compilerOptions": {
    "declaration": false,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "module": "NodeNext",
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "prisma.config.ts"]
}
```

Create `apps/api-server/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": "src"
  },
  "exclude": ["test", "dist", "node_modules"]
}
```

Create `apps/api-server/nest-cli.json`:

```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "sourceRoot": "src",
  "compilerOptions": {
    "tsConfigPath": "tsconfig.build.json",
    "deleteOutDir": true
  }
}
```

Create `apps/api-server/prisma.config.ts`:

```ts
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: env("DATABASE_URL"),
  },
});
```

Create `apps/api-server/prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
}
```

- [ ] **Step 4: Implement database and readiness services**

Create `apps/api-server/src/database/database.service.ts`:

```ts
import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

@Injectable()
export class DatabaseService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is required");
    }

    const adapter = new PrismaPg({
      connectionString,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 10_000,
      max: 10,
    });
    super({ adapter });
  }

  async check(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
```

Create `apps/api-server/src/health/health.service.ts`:

```ts
import { Injectable, OnModuleDestroy } from "@nestjs/common";
import type { HealthResponse } from "@stay-fable/api-contracts/health";
import Redis from "ioredis";
import { DatabaseService } from "../database/database.service";

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor(private readonly database: DatabaseService) {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error("REDIS_URL is required");
    }
    this.redis = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 5_000,
    });
  }

  live(): HealthResponse {
    return { status: "ok", service: "api-server" };
  }

  async ready(): Promise<HealthResponse> {
    await this.database.check();
    if (this.redis.status === "wait") {
      await this.redis.connect();
    }
    await this.redis.ping();

    return {
      status: "ok",
      service: "api-server",
      checks: { database: "up", redis: "up" },
    };
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis.status !== "end") {
      await this.redis.quit();
    }
  }
}
```

Create `apps/api-server/src/health/health.controller.ts`:

```ts
import { Controller, Get } from "@nestjs/common";
import type { HealthResponse } from "@stay-fable/api-contracts/health";
import { HealthService } from "./health.service";

@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get("live")
  live(): HealthResponse {
    return this.health.live();
  }

  @Get("ready")
  ready(): Promise<HealthResponse> {
    return this.health.ready();
  }
}
```

- [ ] **Step 5: Bootstrap the API with validation and secure defaults**

Create `apps/api-server/src/config/runtime.config.ts`:

```ts
import { parseRuntimeEnvironment } from "@stay-fable/validation";

export function validateRuntimeConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  return parseRuntimeEnvironment(config);
}
```

Create `apps/api-server/src/app.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { LoggerModule } from "nestjs-pino";
import { validateRuntimeConfig } from "./config/runtime.config";
import { DatabaseService } from "./database/database.service";
import { HealthController } from "./health/health.controller";
import { HealthService } from "./health/health.service";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateRuntimeConfig,
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? "info",
        redact: {
          paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            "req.body.password",
            "req.body.idCardNumber",
          ],
          censor: "[REDACTED]",
        },
      },
    }),
  ],
  controllers: [HealthController],
  providers: [DatabaseService, HealthService],
})
export class AppModule {}
```

Create `apps/api-server/src/main.ts`:

```ts
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.enableShutdownHooks();
  app.setGlobalPrefix("api/v1");
  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
    }),
  );

  const openApi = new DocumentBuilder()
    .setTitle("Stay Fable API")
    .setVersion("1.0")
    .build();
  SwaggerModule.setup("internal/openapi", app, SwaggerModule.createDocument(app, openApi));

  await app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
}

void bootstrap();
```

- [ ] **Step 6: Generate Prisma client and run API tests**

Run:

```powershell
pnpm install
pnpm --filter @stay-fable/validation build
pnpm --filter @stay-fable/api-contracts build
pnpm --filter @stay-fable/api-server prisma:generate
pnpm --filter @stay-fable/api-server test
pnpm --filter @stay-fable/api-server typecheck
pnpm --filter @stay-fable/api-server build
```

Expected: test, typecheck, and build pass.

- [ ] **Step 7: Verify live dependencies through the readiness endpoint**

Run in one terminal:

```powershell
Copy-Item .env.example .env
pnpm --filter @stay-fable/api-server dev
```

Run in another terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/v1/health/live
Invoke-RestMethod http://127.0.0.1:3000/api/v1/health/ready
```

Expected: liveness returns `status=ok`; readiness returns database and Redis as `up`.

- [ ] **Step 8: Commit the API shell**

```powershell
git add apps/api-server pnpm-lock.yaml
git commit -m "feat: add secure api service shell"
```

## Task 5: Build the persistent BullMQ worker shell

**Files:**

- Create: `apps/job-worker/package.json`
- Create: `apps/job-worker/tsconfig.json`
- Create: `apps/job-worker/tsconfig.build.json`
- Create: `apps/job-worker/src/config.ts`
- Create: `apps/job-worker/src/worker.ts`
- Create: `apps/job-worker/src/main.ts`
- Test: `apps/job-worker/test/config.test.ts`

- [ ] **Step 1: Write the failing worker configuration test**

Create `apps/job-worker/test/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseWorkerConfig } from "../src/config";

describe("parseWorkerConfig", () => {
  it("requires a Redis URL and stable queue prefix", () => {
    expect(
      parseWorkerConfig({
        NODE_ENV: "test",
        REDIS_URL: "redis://127.0.0.1:6379",
      }),
    ).toEqual({
      nodeEnv: "test",
      redisUrl: "redis://127.0.0.1:6379",
      queuePrefix: "stay-fable:test",
    });
  });
});
```

- [ ] **Step 2: Run the test and verify missing-module failure**

Run:

```powershell
pnpm --filter @stay-fable/job-worker test
```

Expected: FAIL because the worker package does not exist.

- [ ] **Step 3: Create the worker package and validated config**

Create `apps/job-worker/package.json`:

```json
{
  "name": "@stay-fable/job-worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "dev": "tsx watch src/main.ts",
    "lint": "eslint src test",
    "start": "node dist/main.js",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "bullmq": "5.81.2",
    "ioredis": "5.11.1",
    "pino": "10.3.1",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "tsx": "4.23.1",
    "vitest": "4.1.10"
  }
}
```

Create `apps/job-worker/tsconfig.json`:

```json
{
  "extends": "../../packages/tsconfig/base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Create `apps/job-worker/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": "src"
  },
  "exclude": ["test", "dist", "node_modules"]
}
```

Create `apps/job-worker/src/config.ts`:

```ts
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  REDIS_URL: z.string().url(),
});

export function parseWorkerConfig(input: Record<string, unknown>) {
  const value = schema.parse(input);
  return {
    nodeEnv: value.NODE_ENV,
    redisUrl: value.REDIS_URL,
    queuePrefix: `stay-fable:${value.NODE_ENV}`,
  } as const;
}
```

- [ ] **Step 4: Implement the persistent worker and graceful shutdown**

Create `apps/job-worker/src/worker.ts`:

```ts
import { Worker } from "bullmq";
import Redis from "ioredis";
import pino from "pino";
import { parseWorkerConfig } from "./config";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: ["password", "token", "idCardNumber"],
});

export function createSystemWorker() {
  const config = parseWorkerConfig(process.env);
  const connection = new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
    connectTimeout: 5_000,
  });

  const worker = new Worker(
    "system",
    async (job) => {
      logger.info({ jobId: job.id, jobName: job.name }, "system job processed");
    },
    {
      connection,
      prefix: config.queuePrefix,
      concurrency: 2,
    },
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error }, "system job failed");
  });

  return { connection, worker };
}
```

Create `apps/job-worker/src/main.ts`:

```ts
import { createSystemWorker } from "./worker";

const { connection, worker } = createSystemWorker();

async function shutdown(): Promise<void> {
  await worker.close();
  await connection.quit();
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
```

- [ ] **Step 5: Verify worker tests and build**

Run:

```powershell
pnpm install
pnpm --filter @stay-fable/job-worker test
pnpm --filter @stay-fable/job-worker typecheck
pnpm --filter @stay-fable/job-worker build
```

Expected: all commands pass.

- [ ] **Step 6: Commit the worker shell**

```powershell
git add apps/job-worker pnpm-lock.yaml
git commit -m "feat: add persistent queue worker shell"
```

## Task 6: Build the management Web shell

**Files:**

- Create: `apps/management-web/package.json`
- Create: `apps/management-web/tsconfig.json`
- Create: `apps/management-web/index.html`
- Create: `apps/management-web/vite.config.ts`
- Create: `apps/management-web/src/main.tsx`
- Create: `apps/management-web/src/app.tsx`
- Create: `apps/management-web/src/app.test.tsx`
- Create: `apps/management-web/src/styles.css`

- [ ] **Step 1: Write the failing application-shell test**

Create `apps/management-web/src/app.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./app";

describe("App", () => {
  it("labels the management application as a non-production shell", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Stay Fable 管理平台" })).toBeVisible();
    expect(screen.getByText("基础环境已就绪")).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the test and verify missing-module failure**

Run:

```powershell
pnpm --filter @stay-fable/management-web test
```

Expected: FAIL because the package and app do not exist.

- [ ] **Step 3: Create the Vite/React package**

Create `apps/management-web/package.json`:

```json
{
  "name": "@stay-fable/management-web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "dev": "vite",
    "lint": "eslint src vite.config.ts",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@tanstack/react-query": "5.101.4",
    "antd": "6.5.2",
    "i18next": "26.3.6",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "react-i18next": "17.0.11"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "7.0.0",
    "@testing-library/react": "16.3.2",
    "@types/react": "19.2.17",
    "@types/react-dom": "19.2.3",
    "@vitejs/plugin-react": "6.0.4",
    "jsdom": "29.1.1",
    "vite": "8.1.5",
    "vitest": "4.1.10"
  }
}
```

Create `apps/management-web/tsconfig.json`:

```json
{
  "extends": "../../packages/tsconfig/base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "noEmit": true,
    "types": ["vite/client", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "vite.config.ts"]
}
```

Create `apps/management-web/index.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Stay Fable 管理平台</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Create `apps/management-web/vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5173 },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
  },
});
```

Create `apps/management-web/src/test-setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 4: Implement the minimal management shell**

Create `apps/management-web/src/app.tsx`:

```tsx
import { Alert, App as AntApp, Card, Typography } from "antd";

export function App() {
  return (
    <AntApp>
      <main className="shell">
        <Card>
          <Typography.Title level={1}>Stay Fable 管理平台</Typography.Title>
          <Alert
            type="success"
            showIcon
            message="基础环境已就绪"
            description="商家和运营功能将在后续阶段按权限逐步开放。"
          />
        </Card>
      </main>
    </AntApp>
  );
}
```

Create `apps/management-web/src/main.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
    mutations: { retry: false },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
```

Create `apps/management-web/src/styles.css`:

```css
:root {
  color: #1f2937;
  background: #f3f4f6;
  font-family: Inter, "PingFang SC", "Microsoft YaHei", sans-serif;
}

body {
  margin: 0;
}

.shell {
  box-sizing: border-box;
  max-width: 960px;
  min-height: 100vh;
  margin: 0 auto;
  padding: 48px 24px;
}
```

- [ ] **Step 5: Verify the Web shell**

Run:

```powershell
pnpm install
pnpm --filter @stay-fable/management-web test
pnpm --filter @stay-fable/management-web typecheck
pnpm --filter @stay-fable/management-web build
```

Expected: the component test passes and Vite emits `apps/management-web/dist`.

- [ ] **Step 6: Commit the management shell**

```powershell
git add apps/management-web pnpm-lock.yaml
git commit -m "feat: add management web application shell"
```

## Task 7: Build the multi-platform Taro consumer shell

**Files:**

- Create: `apps/consumer-miniapp/package.json`
- Create: `apps/consumer-miniapp/tsconfig.json`
- Create: `apps/consumer-miniapp/config/index.ts`
- Create: `apps/consumer-miniapp/src/app.config.ts`
- Create: `apps/consumer-miniapp/src/app.ts`
- Create: `apps/consumer-miniapp/src/app.scss`
- Create: `apps/consumer-miniapp/src/pages/index/index.config.ts`
- Create: `apps/consumer-miniapp/src/pages/index/index.tsx`
- Create: `apps/consumer-miniapp/src/pages/index/index.scss`
- Create: `apps/consumer-miniapp/src/platform/platform-adapter.ts`
- Create: `apps/consumer-miniapp/src/platform/platform-adapter.test.ts`

- [ ] **Step 1: Write the failing platform-boundary test**

Create `apps/consumer-miniapp/src/platform/platform-adapter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { assertSupportedPlatform } from "./platform-adapter";

describe("assertSupportedPlatform", () => {
  it.each(["weapp", "alipay", "tt"] as const)("accepts %s", (platform) => {
    expect(assertSupportedPlatform(platform)).toBe(platform);
  });

  it("rejects an unplanned platform", () => {
    expect(() => assertSupportedPlatform("h5")).toThrow("Unsupported platform: h5");
  });
});
```

- [ ] **Step 2: Run the test and verify missing-module failure**

Run:

```powershell
pnpm --filter @stay-fable/consumer-miniapp test
```

Expected: FAIL because the Taro package and adapter do not exist.

- [ ] **Step 3: Define the Taro package and three build targets**

Create `apps/consumer-miniapp/package.json`:

```json
{
  "name": "@stay-fable/consumer-miniapp",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "pnpm build:weapp",
    "build:alipay": "taro build --type alipay",
    "build:tt": "taro build --type tt",
    "build:weapp": "taro build --type weapp",
    "dev": "taro build --type weapp --watch",
    "lint": "eslint src config",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@tarojs/components": "4.2.1",
    "@tarojs/plugin-framework-react": "4.2.1",
    "@tarojs/plugin-platform-alipay": "4.2.1",
    "@tarojs/plugin-platform-tt": "4.2.1",
    "@tarojs/plugin-platform-weapp": "4.2.1",
    "@tarojs/react": "4.2.1",
    "@tarojs/runtime": "4.2.1",
    "@tarojs/taro": "4.2.1",
    "react": "19.2.8",
    "react-dom": "19.2.8"
  },
  "devDependencies": {
    "@tarojs/cli": "4.2.1",
    "@tarojs/webpack5-runner": "4.2.1",
    "@types/react": "19.2.17",
    "sass": "1.102.0",
    "vitest": "4.1.10"
  }
}
```

Create `apps/consumer-miniapp/config/index.ts`:

```ts
import { defineConfig } from "@tarojs/cli";

export default defineConfig({
  projectName: "stay-fable",
  date: "2026-07-27",
  designWidth: 750,
  deviceRatio: { 640: 2.34 / 2, 750: 1, 828: 1.81 / 2 },
  sourceRoot: "src",
  outputRoot: `dist/${process.env.TARO_ENV}`,
  framework: "react",
  compiler: "webpack5",
  cache: { enable: true },
  mini: {},
});
```

- [ ] **Step 4: Implement the platform contract and shell page**

Create `apps/consumer-miniapp/src/platform/platform-adapter.ts`:

```ts
export type SupportedPlatform = "weapp" | "alipay" | "tt";

export interface PlatformAdapter {
  readonly platform: SupportedPlatform;
  login(): Promise<{ code: string }>;
}

export function assertSupportedPlatform(value: string): SupportedPlatform {
  if (value === "weapp" || value === "alipay" || value === "tt") {
    return value;
  }
  throw new Error(`Unsupported platform: ${value}`);
}
```

Create `apps/consumer-miniapp/src/app.config.ts`:

```ts
export default defineAppConfig({
  pages: ["pages/index/index"],
  window: {
    backgroundTextStyle: "light",
    navigationBarBackgroundColor: "#ffffff",
    navigationBarTextStyle: "black",
    navigationBarTitleText: "Stay Fable",
  },
});
```

Create `apps/consumer-miniapp/src/app.ts`:

```ts
import type { PropsWithChildren } from "react";
import "./app.scss";

export default function App({ children }: PropsWithChildren) {
  return children;
}
```

Create `apps/consumer-miniapp/src/pages/index/index.tsx`:

```tsx
import { Text, View } from "@tarojs/components";
import "./index.scss";

export default function IndexPage() {
  return (
    <View className="page">
      <Text className="title">Stay Fable</Text>
      <Text className="status">基础环境已就绪</Text>
    </View>
  );
}
```

Create `apps/consumer-miniapp/src/pages/index/index.config.ts`:

```ts
export default definePageConfig({
  navigationBarTitleText: "Stay Fable",
});
```

Create `apps/consumer-miniapp/src/pages/index/index.scss`:

```scss
.page {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 48px;
}

.title {
  color: #1f2937;
  font-size: 48px;
  font-weight: 700;
}

.status {
  color: #047857;
  font-size: 30px;
}
```

Create an empty `apps/consumer-miniapp/src/app.scss`.

Create `apps/consumer-miniapp/tsconfig.json`:

```json
{
  "extends": "../../packages/tsconfig/base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "noEmit": true,
    "types": ["@tarojs/taro", "vitest/globals"]
  },
  "include": ["config/**/*.ts", "src/**/*.ts", "src/**/*.tsx"]
}
```

- [ ] **Step 5: Verify tests, types, and all three builds**

Run:

```powershell
pnpm install
pnpm --filter @stay-fable/consumer-miniapp test
pnpm --filter @stay-fable/consumer-miniapp typecheck
pnpm --filter @stay-fable/consumer-miniapp build:weapp
pnpm --filter @stay-fable/consumer-miniapp build:alipay
pnpm --filter @stay-fable/consumer-miniapp build:tt
```

Expected: test and typecheck pass; output exists under `dist/weapp`, `dist/alipay`, and `dist/tt`.

- [ ] **Step 6: Preview the WeChat build**

Open `apps/consumer-miniapp/dist/weapp` in WeChat Developer Tools.

Expected: the page displays `Stay Fable` and `基础环境已就绪` with no runtime errors.

- [ ] **Step 7: Commit the consumer shell**

```powershell
git add apps/consumer-miniapp pnpm-lock.yaml
git commit -m "feat: add multi-platform consumer miniapp shell"
```

## Task 8: Add production containers and deployment contracts

**Files:**

- Create: `apps/api-server/Dockerfile`
- Create: `apps/job-worker/Dockerfile`
- Create: `.dockerignore`
- Create: `infrastructure/cloud/environment-matrix.md`
- Create: `infrastructure/cloud/cloudbase-run.md`
- Test: `scripts/check-container-contracts.test.mjs`

- [ ] **Step 1: Write the failing container security test**

Create `scripts/check-container-contracts.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

for (const service of ["api-server", "job-worker"]) {
  test(`${service} container runs as a non-root user`, async () => {
    const dockerfile = await readFile(
      new URL(`../apps/${service}/Dockerfile`, import.meta.url),
      "utf8",
    );
    assert.match(dockerfile, /USER node/);
    assert.doesNotMatch(dockerfile, /latest/);
  });
}
```

- [ ] **Step 2: Run the test and verify missing-file failure**

Run:

```powershell
node --test scripts/check-container-contracts.test.mjs
```

Expected: FAIL because the Dockerfiles do not exist.

- [ ] **Step 3: Add deterministic non-root images**

Create `.dockerignore`:

```dockerignore
.git
.github
**/node_modules
**/dist
**/coverage
.env
.env.*
!.env.example
docs
```

Create `apps/api-server/Dockerfile`:

```dockerfile
FROM node:24.7.0-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
WORKDIR /workspace
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @stay-fable/validation build && pnpm --filter @stay-fable/api-contracts build
RUN pnpm --filter @stay-fable/api-server prisma:generate
RUN pnpm --filter @stay-fable/api-server build
RUN pnpm --filter @stay-fable/api-server deploy --prod /out

FROM node:24.7.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

Create `apps/job-worker/Dockerfile`:

```dockerfile
FROM node:24.7.0-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
WORKDIR /workspace
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @stay-fable/job-worker build
RUN pnpm --filter @stay-fable/job-worker deploy --prod /out

FROM node:24.7.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
CMD ["node", "dist/main.js"]
```

- [ ] **Step 4: Document the environment matrix**

Create `infrastructure/cloud/environment-matrix.md` with this exact table:

```markdown
# Environment matrix

| Resource | Development | Pre-production | Production |
|---|---|---|---|
| API | Local Node | CloudBase Run, min 1 | CloudBase Run, min 1 |
| Worker | Local Node | CloudBase Run, min 1 | CloudBase Run, min 1 |
| PostgreSQL | Local Docker | Independent managed instance | Independent HA instance |
| Redis | Local Docker | Independent managed instance | Independent HA instance |
| COS | Developer-only bucket | Independent private/public buckets | Independent private/public buckets |
| Secrets | Local `.env` | Secret manager | KMS/secret manager |
| Payment | Disabled | Platform test configuration | Production merchant configuration |
| Logs | Console | Independent CLS topics | Independent CLS topics |

No database, Redis, COS bucket, payment callback, or secret is shared between environments.
Production database and Redis have no public endpoint.
```

Create `infrastructure/cloud/cloudbase-run.md`:

```markdown
# CloudBase Run deployment contract

## API service

- Container port: 3000
- Minimum instances: 1
- Readiness path: `/api/v1/health/ready`
- Liveness path: `/api/v1/health/live`
- Private VPC access to PostgreSQL and Redis
- Public traffic accepted only through the configured EdgeOne/WAF origin

## Worker service

- Minimum instances: 1
- No public ingress
- Private VPC access to Redis and PostgreSQL
- Scale based on queue depth and oldest waiting job

## Required secret names

- `DATABASE_URL`
- `REDIS_URL`

Values are created in the cloud secret manager and are never committed.
Production `DATABASE_URL` must include `sslmode=require`.
```

- [ ] **Step 5: Verify Dockerfile contracts and image builds**

Run:

```powershell
node --test scripts/check-container-contracts.test.mjs
docker build -f apps/api-server/Dockerfile -t stay-fable/api-server:phase-0 .
docker build -f apps/job-worker/Dockerfile -t stay-fable/job-worker:phase-0 .
docker image inspect stay-fable/api-server:phase-0 --format "{{.Config.User}}"
docker image inspect stay-fable/job-worker:phase-0 --format "{{.Config.User}}"
```

Expected: tests pass, both images build, and both inspect commands print `node`.

- [ ] **Step 6: Commit deployment contracts**

```powershell
git add .dockerignore apps/api-server/Dockerfile apps/job-worker/Dockerfile infrastructure/cloud scripts/check-container-contracts*
git commit -m "chore: add production container contracts"
```

## Task 9: Add CI, dependency, secret, and container security gates

**Files:**

- Create: `.github/workflows/ci.yml`
- Create: `.github/dependabot.yml`
- Create: `.gitleaks.toml`
- Create: `docs/operations/security-gates.md`

- [ ] **Step 1: Add a CI workflow with real service dependencies**

Create `.github/workflows/ci.yml`:

```yaml
name: ci

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    services:
      postgres:
        image: postgis/postgis:17-3.5
        env:
          POSTGRES_DB: stay_fable
          POSTGRES_USER: stay_fable
          POSTGRES_PASSWORD: ci_only_password
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U stay_fable -d stay_fable"
          --health-interval 5s
          --health-timeout 3s
          --health-retries 10
      redis:
        image: redis:7.4-alpine
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 3s
          --health-retries 10
    env:
      NODE_ENV: test
      DATABASE_URL: postgresql://stay_fable:ci_only_password@127.0.0.1:5432/stay_fable?schema=public&sslmode=disable
      REDIS_URL: redis://127.0.0.1:6379
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v4
        with:
          version: 11.17.0
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @stay-fable/api-server prisma:generate
      - run: pnpm check
      - run: pnpm audit --audit-level high

  secrets:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: gitleaks/gitleaks-action@v2

  containers:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@v5
      - run: docker build -f apps/api-server/Dockerfile -t stay-fable/api-server:${{ github.sha }} .
      - uses: aquasecurity/trivy-action@0.33.1
        with:
          image-ref: stay-fable/api-server:${{ github.sha }}
          severity: HIGH,CRITICAL
          exit-code: "1"
          ignore-unfixed: true
```

- [ ] **Step 2: Add dependency update policy**

Create `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
      day: monday
    open-pull-requests-limit: 5
    groups:
      safe-minor-patches:
        update-types:
          - minor
          - patch
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: monthly
```

Create `.gitleaks.toml`:

```toml
title = "Stay Fable secret scanning"

[extend]
useDefault = true

[[allowlists]]
description = "Documented local-only example credentials"
paths = [
  '''\.env\.example$''',
  '''infrastructure/compose\.yaml$''',
  '''docs/operations/local-development\.md$'''
]
```

- [ ] **Step 3: Document blocking security gates**

Create `docs/operations/security-gates.md`:

```markdown
# Security gates

A change cannot merge when any of these conditions is true:

- formatting, lint, type checking, test, or build fails;
- a high or critical production dependency vulnerability has no reviewed exception;
- Gitleaks finds a credential;
- Trivy finds a fixable high or critical runtime-image vulnerability;
- a database migration has not been reviewed;
- an API contract changes without a compatibility note;
- a payment, authorization, or sensitive-data change lacks dedicated tests.

Exceptions require a dated decision record with owner, risk, mitigation, and expiry.
```

- [ ] **Step 4: Validate workflow syntax and run local equivalents**

Run:

```powershell
pnpm check
pnpm audit --audit-level high
git diff --check
```

Expected: all commands exit successfully. Push a temporary branch only after local success and verify all three CI jobs pass.

- [ ] **Step 5: Commit CI and security gates**

```powershell
git add .github .gitleaks.toml docs/operations/security-gates.md
git commit -m "ci: enforce quality and security gates"
```

## Task 10: Create cloud, backup, incident, and compliance records

**Files:**

- Create: `infrastructure/cloud/provisioning-checklist.md`
- Create: `infrastructure/runbooks/backup-restore.md`
- Create: `infrastructure/runbooks/security-incident.md`
- Create: `docs/compliance/data-inventory.md`
- Create: `docs/compliance/third-party-processing-register.md`
- Create: `docs/compliance/retention-policy.md`
- Create: `docs/compliance/launch-evidence-index.md`
- Create: `docs/operations/ownership.md`
- Test: `scripts/check-phase-0-documents.test.mjs`

- [ ] **Step 1: Write the failing evidence-document test**

Create `scripts/check-phase-0-documents.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const required = [
  "infrastructure/cloud/provisioning-checklist.md",
  "infrastructure/runbooks/backup-restore.md",
  "infrastructure/runbooks/security-incident.md",
  "docs/compliance/data-inventory.md",
  "docs/compliance/third-party-processing-register.md",
  "docs/compliance/retention-policy.md",
  "docs/compliance/launch-evidence-index.md",
  "docs/operations/ownership.md",
];

test("phase 0 evidence documents have accountable status fields", async () => {
  for (const path of required) {
    const content = await readFile(path, "utf8");
    assert.match(content, /Status:/);
    assert.match(content, /Owner role:/);
    assert.doesNotMatch(content, /T[B]D|T[O]DO|待[定]|待补[充]/);
  }
});
```

- [ ] **Step 2: Run the test and verify missing-file failure**

Run:

```powershell
node --test scripts/check-phase-0-documents.test.mjs
```

Expected: FAIL because the evidence documents do not exist.

- [ ] **Step 3: Create operational ownership and cloud provisioning records**

Every file begins with:

```markdown
Status: Draft for pre-production verification
Owner role: Platform Owner
Review cadence: Before each production release
```

`docs/operations/ownership.md` assigns:

- Platform Owner: scope, budget, production release approval.
- Security Owner: access reviews, incident coordination, security exceptions.
- Data Protection Owner: privacy inventory, user requests, retention reviews.
- Engineering Owner: architecture, CI, migrations, reliability.
- Operations Owner: merchant/content/order/customer-service workflows.
- Finance Owner: payment, refund, settlement, and reconciliation evidence.

For a 1–3 person team, one individual may hold multiple roles, but each action is performed under a named role and remains auditable.

`infrastructure/cloud/provisioning-checklist.md` contains checkboxes for:

- separate pre-production and production VPCs;
- PostgreSQL 17 HA, PostGIS, SSL, TDE, backup, log backup, capacity alerts, no public endpoint;
- Redis HA, authentication, private endpoint, memory and connection alerts;
- API and worker CloudBase Run services with minimum instance count 1;
- EdgeOne/WAF origin restriction, TLS, rate limits, and attack alerts;
- separate COS quarantine, public, and secure-document buckets;
- KMS/secret-manager keys with rotation and deletion protection;
- separate CLS topics with redaction and retention;
- CAM child accounts, roles, MFA, and quarterly access review;
- evidence screenshot or exported configuration attached outside the repository.

Use this row format for every item:

```markdown
| Control | Required state | Evidence | Status |
|---|---|---|---|
| Production PostgreSQL | PostgreSQL 17 HA; PostGIS, SSL, TDE, backups and alerts enabled; no public endpoint | Cloud configuration export retained in the controlled evidence store | Not started |
```

Allowed status values are `Not started`, `In review`, `Accepted`, and `Blocked`.

- [ ] **Step 4: Create backup and incident runbooks**

`infrastructure/runbooks/backup-restore.md` defines this exact exercise:

1. Record the latest recoverable point.
2. Restore to an isolated VPC and a new database instance.
3. Connect using a temporary read-only verification account.
4. Verify PostGIS, migration history, table counts, and database constraints.
5. Run application readiness against the restored database without public traffic.
6. Record achieved RPO and RTO.
7. Destroy the isolated restore only after the Platform Owner signs the evidence.

Acceptance: achieved RPO is at most 15 minutes and RTO at most 2 hours.

`infrastructure/runbooks/security-incident.md` defines:

1. Triage severity and affected environments.
2. Revoke sessions, CAM credentials, application secrets, or payment certificates involved.
3. Isolate the affected service and preserve CLS, WAF, database-audit, and CAM logs.
4. Restore a known-safe release and validate data integrity.
5. Have the Data Protection Owner assess notification duties.
6. Record timeline, impact, root cause, corrective actions, and owners.
7. Close only after monitoring confirms no recurrence.

- [ ] **Step 5: Create privacy and retention records**

`docs/compliance/data-inventory.md` lists, for each data category:

- purpose;
- source;
- fields;
- sensitivity;
- legal/contractual basis to be confirmed by qualified counsel;
- system of record;
- roles with access;
- sharing recipients;
- retention rule;
- deletion or anonymization action.

Seed categories are account identity, contact details, booking participants, stay records, approximate/precise location, merchant qualifications, payment references, customer-service records, audit logs, and behavior analytics.

Use this exact schema:

```markdown
| Category | Purpose | Source | Sensitivity | System of record | Access roles | Retention action |
|---|---|---|---|---|---|---|
| Account identity | Authenticate and maintain an account | Mini-program platform and user | Personal information | PostgreSQL identity module | User support, security | Delete or de-identify after account closure subject to applicable retention duties |
| Payment reference | Reconcile payment and refund status | Licensed payment provider | Sensitive transaction information | PostgreSQL payment module | Finance, security | Retain for the period approved by qualified counsel |
| Behavior analytics | Improve search and booking funnel | Client and server events | De-identified analytics | Analytics schema | Product, data | Delete raw events after 13 months |
```

`docs/compliance/third-party-processing-register.md` seeds Tencent Cloud, WeChat, Alipay, Douyin, SMS provider, map provider, content-security provider, and Metabase. It records purpose, data categories, region, agreement status, security review date, and exit/deletion method.

Use this exact schema:

```markdown
| Provider | Purpose | Data categories | Processing region | Agreement status | Security review | Exit/deletion |
|---|---|---|---|---|---|---|
| Tencent Cloud | Hosting, database, cache, files, logs and protection | Platform data according to service | Mainland China region selected for production | In review | Required before production | Export required records, delete resources, verify expiry of backups |
| WeChat | Login, payment and subscribed messages | Platform identity, transaction reference, message recipient | Per provider agreement | In review | Required before production | Revoke credentials and follow provider deletion process |
| Metabase | Internal dashboards | Aggregated or de-identified operational data | Production VPC | In review | Required before production | Revoke read-only account and remove deployment |
```

`docs/compliance/retention-policy.md` establishes:

- behavior events: 13 months, then deletion or irreversible aggregation;
- application logs: 180 days unless an active incident requires preservation;
- security audit logs: 3 years;
- abandoned quote and inventory-hold data: 90 days;
- account data: active life plus the shortest legally/contractually required period;
- transaction and accommodation records: period confirmed by qualified mainland-China counsel before production;
- identity documents: collect only when required and delete or de-identify at the earliest permitted time;
- backups: follow the configured backup window and expire automatically.

Represent the rules in this exact schema:

```markdown
| Data | Default period | End-of-period action | Exception approval |
|---|---|---|---|
| Behavior events | 13 months | Delete or irreversibly aggregate | Data Protection Owner |
| Application logs | 180 days | Delete | Security Owner for an active incident |
| Security audit logs | 3 years | Delete after review | Security Owner |
| Abandoned quotes and holds | 90 days | Delete | Engineering Owner |
| Identity documents | Shortest permitted period | Delete or de-identify | Data Protection Owner with counsel review |
| Backups | Configured backup window | Automatic expiry | Platform Owner |
```

`docs/compliance/launch-evidence-index.md` links every required evidence item and uses only these statuses: `Not started`, `In review`, `Accepted`, `Blocked`. Initial state is `Not started`; no placeholder wording is used.

- [ ] **Step 6: Run document checks**

Run:

```powershell
node --test scripts/check-phase-0-documents.test.mjs
rg -n "T[B]D|T[O]DO|待[定]|待补[充]" infrastructure docs/compliance docs/operations
```

Expected: the Node test passes and `rg` returns no matches.

- [ ] **Step 7: Commit operational and compliance records**

```powershell
git add infrastructure docs/compliance docs/operations scripts/check-phase-0-documents.test.mjs
git commit -m "docs: add phase zero operational and compliance controls"
```

## Task 11: Verify Phase 0 as an integrated deliverable

**Files:**

- Modify: `scripts/verify-workspace.mjs`
- Create: `scripts/verify-phase-0.mjs`
- Create: `docs/operations/phase-0-verification.md`

- [ ] **Step 1: Implement a single deterministic verifier**

Create `scripts/verify-phase-0.mjs`:

```js
import { execFileSync } from "node:child_process";

function run(command, args) {
  process.stdout.write(`> ${command} ${args.join(" ")}\n`);
  execFileSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
}

run("node", ["scripts/verify-workspace.mjs"]);
run("node", ["--test", "scripts/verify-workspace.test.mjs"]);
run("node", ["--test", "scripts/check-local-infrastructure.test.mjs"]);
run("node", ["--test", "scripts/check-container-contracts.test.mjs"]);
run("node", ["--test", "scripts/check-phase-0-documents.test.mjs"]);
run("pnpm", ["format:check"]);
run("pnpm", ["lint"]);
run("pnpm", ["typecheck"]);
run("pnpm", ["test"]);
run("pnpm", ["build"]);

process.stdout.write("Phase 0 verification passed.\n");
```

Add root script:

```json
{
  "scripts": {
    "verify:phase-0": "node scripts/verify-phase-0.mjs"
  }
}
```

- [ ] **Step 2: Run local infrastructure and the full verifier**

Run:

```powershell
docker compose -f infrastructure/compose.yaml up -d
node scripts/check-local-infrastructure.mjs
pnpm verify:phase-0
```

Expected: final output is `Phase 0 verification passed.`

- [ ] **Step 3: Perform manual runtime checks**

Run the API and worker, then verify:

- `/api/v1/health/live` returns HTTP 200.
- `/api/v1/health/ready` returns database and Redis `up`.
- the worker remains connected for 10 minutes without reconnect loops.
- management Web renders the foundation shell.
- WeChat Developer Tools renders the mini-program shell.
- `docker image inspect` reports user `node` for API and worker.

- [ ] **Step 4: Record verification evidence**

Create `docs/operations/phase-0-verification.md`:

```markdown
# Phase 0 verification

Status: Accepted
Owner role: Engineering Owner
Review cadence: Re-run after foundation changes

## Automated evidence

- `pnpm verify:phase-0`: passed
- API container build: passed
- Worker container build: passed
- CI verify job: passed
- CI secret scan: passed
- CI container scan: passed

## Runtime evidence

- API liveness: HTTP 200
- API readiness: PostgreSQL up, Redis up
- Worker stability: no reconnect loop during 10-minute observation
- Management Web shell: rendered
- WeChat mini-program shell: rendered in developer tools

## External gates

Cloud provisioning, account qualification, domain/filing, payment merchant approval,
privacy/legal review, and production penetration testing remain launch prerequisites.
They are tracked in `docs/compliance/launch-evidence-index.md`.
```

- [ ] **Step 5: Confirm the worktree is clean and commit**

Run:

```powershell
git diff --check
git status --short
```

Expected before commit: only the intended verifier and evidence files are modified.

Commit:

```powershell
git add package.json scripts/verify-workspace.mjs scripts/verify-phase-0.mjs docs/operations/phase-0-verification.md
git commit -m "chore: verify phase zero foundation"
git status --short
```

Expected after commit: `git status --short` prints nothing.

## Phase 0 exit criteria

Phase 0 is complete only when:

- all four applications/packages build from a clean checkout;
- PostgreSQL/PostGIS and Redis health checks pass;
- API and worker images run as non-root;
- API liveness and readiness are distinct and correct;
- worker has a persistent minimum-instance deployment contract;
- all three mini-program targets compile and WeChat preview passes;
- CI quality, dependency, secret, and container scans pass;
- production resource separation and private-network requirements are documented;
- backup/restore and incident runbooks are executable;
- data inventory, third-party register, retention rules, and ownership exist;
- external launch prerequisites are visible as gates rather than silently assumed;
- every task above has an atomic commit and the worktree is clean.

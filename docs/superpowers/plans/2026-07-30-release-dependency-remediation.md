# Release 依赖漏洞分批修复计划

日期：2026-07-30

## 基线与边界

- 新鲜完整审计：31 项，2 Critical、11 High、16 Moderate、2 Low。
- `/wx` 是唯一正式用户端；`apps/consumer-miniapp` 是冻结的 Taro 参考源码。当前它仍被
  `apps/*` 纳入 workspace；Batch 1 的目标状态是将它排除出默认 workspace、构建和发布
  依赖图，同时完整保留源码与 `package.json`。
- release/main 在 Critical/High 未清零且没有正式风险例外时保持阻断。
- 每个批次独立 RED → GREEN、独立复核和提交；禁止降低阈值、强压不兼容 override 或使用
  预发布主版本掩盖问题。

## Batch 1：校正正式 workspace 边界

**Files:**

- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`
- Modify: `package.json`
- Modify: `scripts/verify-workspace.test.mjs`
- Modify: `scripts/check-phase-0-documents.test.mjs`
- Modify: `scripts/verify-phase-0.test.mjs`
- Modify: `scripts/verify-phase-0.mjs`
- Modify: `scripts/smoke-frontend-artifacts.mjs`
- Modify: `docs/operations/phase-0-verification.md`
- Modify: `docs/operations/dependency-audit.md`
- Modify: `docs/compliance/launch-evidence-index.md`

### RED

新增断言：

- workspace 必须显式排除 `apps/consumer-miniapp`；
- lockfile 不得包含该 importer 或 Taro 依赖图；
- Phase 0 不运行冻结 Taro 的 build/filter；
- 根级 build/lint/test/typecheck 不得过滤已排除 workspace 的冻结包；
- 默认 smoke 只验证管理端产物，并保留冻结源码存在性检查。

### GREEN

在 workspace packages 中加入 `!apps/consumer-miniapp`，移除默认 Phase 0 的 Taro 构建、
根级 build/lint/test/typecheck 对已排除包的过滤器及 Taro 产物 smoke，再使用
`corepack pnpm install --lockfile-only` 重建锁文件。不得删除冻结源码或其 `package.json`。

### 门禁

```powershell
node --test scripts/verify-workspace.test.mjs scripts/verify-phase-0.test.mjs
corepack pnpm check
corepack pnpm audit --audit-level high
```

记录实际计数，不把预估计数当作证据。

## Batch 2：Prisma 统一补丁升级

**Files:**

- Modify: `apps/api-server/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `scripts/verify-workspace.test.mjs`
- Modify: `docs/operations/dependency-audit.md`

### RED

断言 `@prisma/adapter-pg`、`@prisma/client`、`prisma` 三者版本完全一致且不低于
`7.9.1`；当前 `7.9.0` 必须失败。

### GREEN

三者统一精确升级到 `7.9.1`，只对相关依赖做定向锁文件更新。不得单独升级 CLI 或生成两个
Prisma 版本图。

```powershell
corepack pnpm --filter @stay-fable/api-server update @prisma/adapter-pg@7.9.1 @prisma/client@7.9.1 prisma@7.9.1 --save-exact
```

禁止运行无包名的 `pnpm update` 或更新其他依赖。

### 门禁

```powershell
corepack pnpm prisma:generate
corepack pnpm --filter @stay-fable/api-server test
corepack pnpm --filter @stay-fable/api-server typecheck
corepack pnpm --filter @stay-fable/api-server build
corepack pnpm check
corepack pnpm audit --json
corepack pnpm audit --audit-level high
powershell -NoProfile -File scripts/wsl-runtime-validation.ps1 -Distro Ubuntu-22.04
```

必须重新验证 migration、PostgreSQL/PostGIS、Redis、API live/ready、订单事务、Worker
10 分钟稳定窗口与清理；审计中不得再出现 Prisma 的 `find-my-way`/`valibot` 公告。Batch 4
尚未解阻时完整审计预期仍非零，但 Critical/High/Moderate/Low 的完整计数必须记录且不得出现
新增 Critical/High。

## Batch 3：移除 Nest CLI 旧 minimatch 链

**Files:**

- Modify: `apps/api-server/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `scripts/clean-api-dist.mjs`
- Create: `scripts/clean-api-dist.test.mjs`
- Modify: `scripts/verify-workspace.test.mjs`
- Delete: `apps/api-server/nest-cli.json`
- Modify: `docs/operations/dependency-audit.md`

### RED

断言：

- API scripts 不调用 `nest`；
- API 不声明 `@nestjs/cli`；
- 构建前只清理固定的 `apps/api-server/dist`，拒绝任意路径、workspace root 和未解析目标；
- 连续构建不会保留陈旧产物。

### GREEN

用 `tsc -p tsconfig.build.json` 替换 `nest build`，开发模式使用现有 `tsx` 能力；实现
固定目标、跨平台、可测试的构建清理，不接受调用方路径参数。删除 `@nestjs/cli` 后定向更新
锁文件。测试必须创建 dist 内 sentinel 并证明清理成功，同时证明脚本没有路径参数入口且拒绝
workspace root。直接添加 `brace-expansion@5` 不能修复 minimatch 1.x/2.x 的传递范围，
不得采用该伪修复。

### 门禁

```powershell
corepack pnpm --filter @stay-fable/api-server build
corepack pnpm --filter @stay-fable/api-server build
corepack pnpm --filter @stay-fable/api-server test
corepack pnpm --filter @stay-fable/api-server typecheck
node scripts/smoke-api-runtime.mjs
corepack pnpm check
corepack pnpm audit --audit-level high
powershell -NoProfile -File scripts/wsl-runtime-validation.ps1 -Distro Ubuntu-22.04
```

## Batch 4：Swagger 上游阻断

**Files（触发后）:**

- Modify: `apps/api-server/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `scripts/verify-workspace.test.mjs`
- Modify: `docs/operations/dependency-audit.md`

当前 stable `@nestjs/swagger@11.4.6` 精确解析到有 High 公告的 `js-yaml@5.2.1`；
安全候选仅存在于需要 Nest next peer 的 Swagger 12 alpha。当前不升级预发布主版本、不安装
第二份 `js-yaml`、不 override 精确依赖。

触发条件：上游发布兼容 Nest 11、且不再解析到 `js-yaml@5.2.1` 的 stable 版本。触发后单独
TDD 升级：

1. RED：依赖回归测试断言 Swagger 必须是兼容 Nest 11 的 stable，且锁文件中该链不得解析到
   `js-yaml@5.2.1`；当前版本必须失败。
2. 只执行精确定向升级：

   ```powershell
   corepack pnpm --filter @stay-fable/api-server update @nestjs/swagger@<approved-stable> --save-exact
   ```

3. 运行全部 OpenAPI/MVP 契约、API test/typecheck/build、`node scripts/smoke-api-runtime.mjs`、
   完整 `pnpm check`、WSL 验证和 `corepack pnpm audit --audit-level high`。
4. 最终 audit 必须 exit 0；任何新 Critical/High 都视为失败。

在 Batch 4 解阻或取得包含批准人、到期日、缓解措施和修复跟踪的正式风险例外前，
`BLOCKED_DEPENDENCY_AUDIT` 必须保持，release/main 不得通过。

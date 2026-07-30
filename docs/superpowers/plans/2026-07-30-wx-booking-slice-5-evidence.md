# Slice 5：微信预订 MVP 全链路证据实施计划

日期：2026-07-30  
设计：
[Slice 5 全链路证据设计](../specs/2026-07-30-wx-booking-slice-5-evidence-design.md)

> 实施纪律：每个代码任务先 RED、再最小 GREEN、再独立规格与质量复核。外部环境 blocker
> 只能生成 `BLOCKED` 证据，不能改写为 PASS。

## Task 1：候选 manifest 与安全状态模型

**Files:**

- Create: `scripts/verify-slice-5-candidate.mjs`
- Create: `scripts/verify-slice-5-candidate.test.mjs`
- Modify: `package.json`

### Step 1：写 RED

固定 manifest 输入：

- commit、`/wx` tree、9 pages、migration count；
- `check`、audit、OpenAPI、WechatIDE、Automator、manual、phone、WSL 状态；
- `READY | BLOCKED_* | FAILED_PRODUCT` 枚举，其中必须独立包含
  `BLOCKED_PHYSICAL_UAT` 和 `BLOCKED_DEPENDENCY_AUDIT`；
- blocker 不得被其他 PASS 抵消；
- dangerous object、getter、Proxy、unknown key 和敏感字段拒绝。

### Step 2：实现

验证器只接受显式 JSON 输入并输出安全摘要。不得读取或输出 token、AppID、账号、UUID、key、
坐标或库存值。增加：

```json
"verify:slice5:candidate": "node scripts/verify-slice-5-candidate.mjs"
```

### Step 3：门禁

```powershell
node --test scripts/verify-slice-5-candidate.test.mjs
corepack pnpm lint
corepack pnpm check
```

### Step 4：提交

```powershell
git commit -m "test(slice-5): validate candidate evidence state"
```

## Task 2：MVP OpenAPI 与微信契约矩阵

**Files:**

- Create: `apps/api-server/test/mvp.openapi.test.ts`
- Create: `wx/tests/mvp-contract-matrix.test.js`
- Modify only if tests expose a contract defect.

### Step 1：写 OpenAPI RED

聚合断言身份、定位、Catalog、报价、下单、订单查询、取消和开发支付路由。覆盖：

- security/header/status/envelope；
- production 不含 dev payment；
- response 无 user/hold/inventory/internal UUID；
- exact request body 与 enum；
- mock payment 开关边界。

### Step 2：写微信矩阵 RED

把 OpenAPI 的公共字段映射到现有 `wx/services/contracts.js` 断言，确认：

- exact keys；
- dangerous object 防御；
- 日期、金额、cursor、history/payment/actions；
- 客户端不推导服务端动作。

### Step 3：GREEN 与门禁

```powershell
corepack pnpm exec vitest run apps/api-server/test/mvp.openapi.test.ts
corepack pnpm exec vitest run wx/tests/mvp-contract-matrix.test.js
corepack pnpm check
```

### Step 4：提交

```powershell
git commit -m "test(api): lock mvp openapi client matrix"
```

## Task 3：Slice 5 UAT 环境预检

**Files:**

- Create: `wx/automator/slice-5-preflight.js`
- Create: `wx/tests/slice-5-preflight.test.js`
- Modify: `wx/tests/configuration.test.js`

### Step 1：写 RED

覆盖：

- exact worktree path；
- candidate commit/tree；
- WechatIDE version/login/token；
- test account count；
- loopback health；
- seed date window；
- console/network baseline；
- 每种 `BLOCKED_*` 的安全错误；
- preflight 失败时 tap/write 调用次数为 0。

### Step 2：实现

预检必须只读、有界、可注入。禁止自动：

- 登录或创建测试号；
- 关闭域名/TLS 校验；
- 修改 project private config；
- 启动写流程；
- 打印 AppID、账号、URL query 或响应 body。

### Step 3：官方工具验证

用 initializer/debugger 读取真实环境。当前没有测试号时，预期真实终态为
`BLOCKED_TEST_ACCOUNT`，这是正确阻断，不是测试失败。

### Step 4：提交

```powershell
git commit -m "test(wx): preflight physical uat environment"
```

## Task 4：纯物理 Automator 主流程

**Files:**

- Create: `wx/automator/slice-5-booking-lifecycle.js`
- Create: `wx/tests/slice-5-booking-lifecycle-automator.test.js`
- Modify: `wx/tests/configuration.test.js`

### Step 1：写 launcher/cleanup RED

覆盖：

- bounded launch/connect；
- terminal cleanup；
- candidate/preflight mismatch 时不启动；
- 首个物理失败立即停止；
- late callback 不写 evidence；
- evidence 写入失败仍关闭 Automator；
- 不出现 callMethod/evaluate/direct navigation fallback。

### Step 2：写流程 RED

使用注入的页面/元素 fake 覆盖完整 10 步流程，并断言：

- 所有导航来自 element tap；
- 日期为执行日 `D+1` 至 `D+3`、3 位住客；
- quote/booking/fail/success/cancel 各 POST 增量恰为 1；
- GET 刷新 POST 增量 0；
- unknown write 立即终止，不自动重试；
- payment retry 保持同一 scope/key，但 evidence 不保存 key；
- confirmed/cancelled 终态和订单 Tab 返回刷新。

### Step 3：实现安全 evidence writer

manifest exact schema，截图写临时目录后：

- 检查实际编码；
- 校验无敏感可见文本；
- 计算 SHA-256；
- 只复制允许的截图；
- 删除二维码和原始 network/console。

### Step 4：门禁

```powershell
corepack pnpm exec vitest run wx/tests/slice-5-booking-lifecycle-automator.test.js
corepack pnpm test:wx
corepack pnpm wx:check
```

### Step 5：提交

```powershell
git commit -m "test(wx): automate booking lifecycle uat"
```

## Task 5：稳定窗口协调器

**Files:**

- Create: `scripts/run-slice-5-uat.ps1`
- Create: `scripts/run-slice-5-uat.test.mjs`

### Step 1：写 RED

协调器必须：

- 取得运行锁；
- 记录 candidate commit/tree；
- 启动现有 WSL verifier；
- 只在 `SLICE4_UAT_READY` 后调用预检；
- preflight blocker 时不启动 Automator；
- Automator 完成后仍等待 Worker 10 分钟；
- 保留 WSL/Automator 各自退出码；
- finally 清理锁和临时凭据；
- 不停止无关容器。

### Step 2：实现

协调器不修改 API、数据库或微信配置。它只编排既有命令并输出安全 marker：

```text
SLICE5_PREFLIGHT_READY
SLICE5_AUTOMATOR_COMPLETE
SLICE5_MANUAL_PENDING
SLICE5_RUNTIME_STABLE
SLICE5_CLEANUP_COMPLETE
```

任何 blocker 都不得输出 `SLICE5_AUTOMATOR_COMPLETE`。

### Step 3：提交

```powershell
git commit -m "test(slice-5): coordinate stable uat window"
```

## Task 6：真实 Automator、人工和手机 UAT

**Files:**

- Create only sanitized evidence under:
  `docs/verification/evidence/slice-5-booking-lifecycle/`

### Step 1：环境解阻

必须由有权限的开发者提供：

- 非生产测试号或合规微信登录；
- loopback 模拟器，或配置合法 HTTPS 非生产域名的手机环境；
- 若 Automator RC 仍失败，正式例外的批准人、到期日、缓解措施和修复跟踪。

没有这些输入时停止为 `BLOCKED`，不得创建 PASS manifest。

### Step 2：执行

```powershell
powershell -NoProfile -File scripts/run-slice-5-uat.ps1
```

完成 Automator 主流程后，由人工或手机复核视觉、modal、点击区域和快速双击。

### Step 3：清理

- 删除预览二维码、token、raw network 和测试登录材料；
- 清理临时用户/订单/支付/hold/quote；
- 保留允许的脱敏截图和 manifest；
- 确认无 `.wsl-runtime`、验证容器或运行锁。

### Step 4：提交

仅在物理闭环真实通过时提交：

```powershell
git commit -m "test(slice-5): record physical booking uat"
```

## Task 7：依赖漏洞与发布门禁

**Files:**

- Modify dependencies and `docs/operations/dependency-audit.md` only through separately reviewed
  upgrade plans.

### Step 1：重新审计

```powershell
corepack pnpm audit --audit-level high
```

当前基线为 2 Critical、11 High、16 Moderate、2 Low。release/main 不能在该基线上通过。

### Step 2：处理

每组上游升级单独 TDD、构建和运行验证。不能：

- 降低 audit 阈值；
- 用 overrides 强压不兼容版本后跳过测试；
- 把 dev 报告政策写成 release 豁免。

若不能安全升级，必须由用户或批准人提供正式依赖风险例外。

## Task 8：最终候选证据与分支交付

**Files:**

- Create: `docs/verification/<date>-slice-5-mvp-candidate.md`
- Modify only if final validation exposes a defect.

### Step 1：最终门禁

```powershell
corepack pnpm check
corepack pnpm audit --audit-level high
powershell -NoProfile -File scripts/run-slice-5-uat.ps1
```

### Step 2：证据

记录：

- final commit/tree；
- OpenAPI/微信矩阵；
- Automator 与人工/手机真实结果；
- 每写最多一个 POST；
- WSL markers/10 分钟/cleanup；
- audit 和目标分支政策；
- 临时凭据删除；
- blocker 或风险例外。

### Step 3：三重独立复核

依次执行：

1. 规格符合性；
2. 代码质量与安全；
3. 物理交互、竞争与证据。

所有 Critical、Important、Minor 必须关闭。

### Step 4：交付

- 工作树 clean；
- 推送 `codex/wx-mvp-booking-design`；
- 不自动合并 `dev`、`release` 或 `main`；
- 只有全部完成定义满足时才将 Slice 5 标记完成。

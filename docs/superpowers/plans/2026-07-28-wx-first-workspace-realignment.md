# 微信优先工作区重整实施计划

状态: 已完成
完成日期: 2026-07-28

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将仓库重整为以 `/wx` 原生微信小程序为正式客户端的干净开发基线，保全并上传所有现有文件，建立微信开发者工具与 WSL2 后端验证工作流。

**Architecture:** `/wx` 成为默认客户端质量门禁，Taro 多平台工程保留但从日常构建中冻结。根目录 `AGENTS.md` 负责路由微信开发者工具技能、WSL2 Docker 验证、分支与漏洞策略；`dev` 阶段持续报告漏洞但不阻断，`release/main` 仍执行发布级门禁。

**Tech Stack:** 原生微信小程序、Node.js 24、pnpm 11、Node Test Runner、NestJS、PostgreSQL/PostGIS、Redis、Docker Compose、WSL2 Ubuntu-22.04、GitHub Actions

## 完成摘要

- Task 1–9 均已完成。实施收尾时，`main`、`dev`、`release` 及对应远端分支均对齐到**实施基线** `5a7ba6f1800c26569e2cb41679c3f8cc26ede22d`；该 SHA 是实施基线，而不是本计划后续文档提交产生的当前 `HEAD`。旧工作树和已完成功能分支已清理。
- 微信官方验证绑定不可变 input `deb274c58f64b6259e89d19a582200182126d770` 与 `wx` tree `021ed57a0b3b1e876123befad4f375446621fb42`：WXML 32400，WXSS 2/3398，preview 11626 bytes。未调用 `upload`，证据状态保持 **In review**。
- WSL2 实机验证已完成：PostGIS 查询成功、Redis 返回 `PONG`、API live/ready 返回 HTTP 200，API 与 Worker 均为非 root 且只读根文件系统；Worker 观察超过 10 分钟后 `RestartCount=0`，无重连循环。
- 依赖审计仍报告 29 项：2 Critical、11 High、14 Moderate、2 Low。`dev` 阶段漏洞只报告、不阻断功能开发；`release/main` 继续阻断 Critical/High，除非存在正式批准的风险例外。
- Taro、支付宝、抖音和多语言均已搁置，不属于当前开发与上线门禁。本计划仅记录工作区重整的完成状态，不代表酒店产品功能完成；酒店产品功能仍属后续开发。

---

## 文件结构

本计划创建或修改以下文件：

- 创建 `AGENTS.md`：项目级强制工作流。
- 创建 `scripts/check-wx-project.mjs`：可移植的 `/wx` 静态项目检查器。
- 创建 `scripts/check-wx-project.test.mjs`：微信项目结构的回归测试。
- 修改 `scripts/verify-workspace.mjs`：将 `/wx` 纳入工作区契约。
- 修改 `scripts/verify-workspace.test.mjs`：锁定微信优先脚本与 Taro 冻结规则。
- 修改 `package.json`：新增 `wx:check`，并从默认 Turbo 任务中排除 Taro。
- 修改 `.github/workflows/ci.yml`：覆盖 `dev/release/main`，在 `dev` 报告漏洞、在发布分支阻断。
- 修改 `scripts/check-ci-contracts.test.mjs`：锁定分支和漏洞门禁行为。
- 创建 `docs/operations/wsl-runtime-validation.md`：WSL2 后端实机验证步骤。
- 修改 `docs/operations/local-development.md`：链接 WSL2 工作流并明确端口策略。
- 修改 `scripts/check-local-infrastructure.test.mjs`：验证 WSL2 文档契约。
- 整合旧工作树中的 4 份文档修改。
- 保留并提交本规格和本实施计划。

### Task 1：建立根目录 `AGENTS.md`

**Files:**

- Create: `AGENTS.md`
- Modify: `scripts/verify-workspace.test.mjs`

- [x] **Step 1: 写入失败的项目规则测试**

在 `scripts/verify-workspace.test.mjs` 中新增：

```js
test("documents the WeChat-first agent workflow", async () => {
  const agents = await readFile(new URL("AGENTS.md", rootUrl), "utf8");

  assert.match(agents, /\/wx.*唯一正式用户端/s);
  for (const skill of [
    "initializer",
    "compiler",
    "previewer",
    "automator",
    "debugger",
    "project-config",
  ]) {
    assert.match(agents, new RegExp(`\\b${skill}\\b`));
  }
  assert.match(agents, /Ubuntu-22\.04/);
  assert.match(agents, /POSTGRES_PORT=55432/);
  assert.match(agents, /REDIS_PORT=56379/);
  assert.match(agents, /dev.*报告.*不阻断/s);
  assert.match(agents, /release.*Critical.*High/s);
});
```

- [x] **Step 2: 运行测试并确认失败**

Run:

```powershell
node --test scripts/verify-workspace.test.mjs
```

Expected: FAIL，错误指出无法读取 `AGENTS.md`。

- [x] **Step 3: 创建项目级工作流**

创建 `AGENTS.md`，内容如下：

```markdown
# Stay Fable Agent Workflow

## 开始工作前

1. 阅读本文件和当前任务涉及的技能说明。
2. 执行 `git status --short` 和 `git worktree list`，不得覆盖未提交修改。
3. 从 `dev` 创建 `codex/<feature>` 分支；`release` 和 `main` 不直接开发。

## 客户端边界

- `/wx` 是唯一正式用户端。
- `apps/consumer-miniapp` 是冻结的 Taro 多平台参考工程，不进入默认开发和构建门禁。
- 微信任务按需使用 wechatide 技能：
  - 环境、登录、打开项目：`initializer`
  - 编译和模拟器刷新：`compiler`
  - 手机预览：`previewer`
  - 页面交互验收：`automator`
  - 日志、网络和截图诊断：`debugger`
  - 项目配置：`project-config`
- 每个微信功能至少完成静态检查和微信开发者工具编译；用户闭环还需预览或自动化验收。

## WSL2 后端验证

- 默认发行版：`Ubuntu-22.04`；后端实机验证使用其中的 Docker Engine。
- 不得停止或删除无关容器。
- 默认端口被占用时使用 `POSTGRES_PORT=55432` 和 `REDIS_PORT=56379`。
- 验证 PostgreSQL/PostGIS、Redis、API `/health/live`、`/health/ready` 和 Worker。
- API 与 Worker 必须以非 root 用户和只读根文件系统运行。
- Worker 稳定性观察期至少 10 分钟，重启次数必须为 0，且不得出现重连循环。
- 任务结束时删除临时容器和运行产物；Compose 数据卷默认保留。
- 详细命令见 `docs/operations/wsl-runtime-validation.md`。

## 质量与漏洞

- `dev` 阶段运行格式、lint、类型检查、测试、构建和漏洞报告。
- `dev` 的已知依赖漏洞只报告、不阻断功能开发。
- `release` 和 `main` 必须阻断未修复的 Critical/High 漏洞，除非存在有批准人、到期日和缓解措施的风险例外。
- 完成前必须执行与修改范围相称的全量验证，不得仅依据缓存或历史结果。
```

- [x] **Step 4: 运行测试并确认通过**

Run:

```powershell
node --test scripts/verify-workspace.test.mjs
```

Expected: 所有 workspace contract 测试 PASS。

- [x] **Step 5: 提交**

```powershell
git add AGENTS.md scripts/verify-workspace.test.mjs
git commit -m "docs: establish WeChat-first agent workflow"
```

### Task 2：建立 `/wx` 静态检查器

**Files:**

- Create: `scripts/check-wx-project.mjs`
- Create: `scripts/check-wx-project.test.mjs`
- Modify: `scripts/verify-workspace.mjs`

- [x] **Step 1: 创建最小合法和非法微信工程测试**

`scripts/check-wx-project.test.mjs` 使用临时目录构建 fixture，并验证页面完整性：

```js
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { validateWxProject } from "./check-wx-project.mjs";

const temporaryRoots = [];

async function createProject() {
  const root = await mkdtemp(join(tmpdir(), "stay-fable-wx-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "pages", "index"), { recursive: true });
  await writeFile(
    join(root, "project.config.json"),
    JSON.stringify({ appid: "test-appid", compileType: "miniprogram" }),
  );
  await writeFile(join(root, "app.json"), JSON.stringify({ pages: ["pages/index/index"] }));
  for (const extension of [".js", ".json", ".wxml", ".wxss"]) {
    await writeFile(join(root, "pages", "index", `index${extension}`), extension === ".json" ? "{}" : "");
  }
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("accepts a complete native WeChat mini-program", async () => {
  const root = await createProject();
  const result = await validateWxProject(root);
  assert.deepEqual(result, { pageCount: 1 });
});

test("rejects a page with a missing WXML file", async () => {
  const root = await createProject();
  await rm(join(root, "pages", "index", "index.wxml"));
  await assert.rejects(() => validateWxProject(root), /index\.wxml/);
});

test("rejects traversal in a declared page path", async () => {
  const root = await createProject();
  await writeFile(join(root, "app.json"), JSON.stringify({ pages: ["../outside"] }));
  await assert.rejects(() => validateWxProject(root), /unsafe page path/i);
});
```

- [x] **Step 2: 运行测试并确认模块不存在**

Run:

```powershell
node --test scripts/check-wx-project.test.mjs
```

Expected: FAIL，无法导入 `check-wx-project.mjs`。

- [x] **Step 3: 实现检查器**

创建 `scripts/check-wx-project.mjs`：

```js
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PAGE_EXTENSIONS = [".js", ".json", ".wxml", ".wxss"];
const SAFE_PAGE_PATH = /^[A-Za-z0-9_/-]+$/;

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function validateWxProject(projectRoot) {
  const root = resolve(projectRoot);
  const project = await readJson(resolve(root, "project.config.json"));
  const app = await readJson(resolve(root, "app.json"));

  assert.equal(project.compileType, "miniprogram", "wx project must compile as miniprogram");
  assert.ok(Array.isArray(app.pages) && app.pages.length > 0, "wx app must declare pages");

  for (const page of app.pages) {
    assert.ok(
      typeof page === "string" &&
        SAFE_PAGE_PATH.test(page) &&
        !page.startsWith("/") &&
        !page.includes(".."),
      `unsafe page path: ${String(page)}`,
    );
    await Promise.all(PAGE_EXTENSIONS.map((extension) => access(resolve(root, `${page}${extension}`))));
  }

  return { pageCount: app.pages.length };
}

const isCli =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isCli) {
  const root = fileURLToPath(new URL("../wx/", import.meta.url));
  const result = await validateWxProject(root);
  console.log(`WeChat project verified: ${result.pageCount} pages`);
}
```

- [x] **Step 4: 将 `/wx` 加入工作区必需路径**

在 `scripts/verify-workspace.mjs` 的 `requiredPaths` 中增加：

```js
"wx/project.config.json",
"wx/app.json",
"scripts/check-wx-project.mjs",
"scripts/check-wx-project.test.mjs",
"AGENTS.md",
```

保留 `apps/consumer-miniapp/package.json`，因为冻结表示保留，而不是删除。

- [x] **Step 5: 运行检查**

Run:

```powershell
node --test scripts/check-wx-project.test.mjs
node scripts/check-wx-project.mjs
node scripts/verify-workspace.mjs
```

Expected: 3 个微信测试 PASS；输出 `WeChat project verified: 2 pages` 和
`Workspace contract verified.`。

- [x] **Step 6: 提交**

```powershell
git add scripts/check-wx-project.mjs scripts/check-wx-project.test.mjs scripts/verify-workspace.mjs
git commit -m "test: verify native WeChat project"
```

### Task 3：冻结 Taro 默认构建并启用微信门禁

**Files:**

- Modify: `package.json`
- Modify: `scripts/verify-workspace.test.mjs`

- [x] **Step 1: 写入失败的脚本契约**

在 `scripts/verify-workspace.test.mjs` 的根契约测试中增加：

```js
assert.equal(root.scripts["wx:check"], "node scripts/check-wx-project.mjs");
for (const script of ["lint", "typecheck", "test", "build"]) {
  assert.match(root.scripts[script], /--filter=!@stay-fable\/consumer-miniapp/);
}
assert.match(root.scripts.check, /pnpm wx:check/);
```

- [x] **Step 2: 运行测试并确认失败**

Run:

```powershell
node --test scripts/verify-workspace.test.mjs
```

Expected: FAIL，`wx:check` 为 `undefined`。

- [x] **Step 3: 调整根脚本**

将 `package.json` 对应脚本改为：

```json
{
  "scripts": {
    "build": "turbo run build --filter=!@stay-fable/consumer-miniapp",
    "dev": "turbo run build --filter=\"./packages/*\" && turbo run dev --parallel --filter=!@stay-fable/consumer-miniapp",
    "lint": "eslint eslint.config.mjs prettier.config.mjs scripts/*.mjs packages/eslint-config/index.mjs && turbo run lint --filter=!@stay-fable/consumer-miniapp",
    "test": "node --test scripts/*.test.mjs && turbo run test --filter=!@stay-fable/consumer-miniapp",
    "typecheck": "turbo run typecheck --filter=!@stay-fable/consumer-miniapp",
    "wx:check": "node scripts/check-wx-project.mjs",
    "check": "pnpm verify && pnpm wx:check && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build"
  }
}
```

保留其他现有脚本和值不变。

- [x] **Step 4: 验证默认门禁不运行 Taro**

Run:

```powershell
corepack pnpm check
```

Expected: exit 0；Turbo 输出中不出现 `@stay-fable/consumer-miniapp` 任务，微信静态检查
输出 `WeChat project verified: 2 pages`。

- [x] **Step 5: 提交**

```powershell
git add package.json scripts/verify-workspace.test.mjs
git commit -m "build: make native WeChat the default client"
```

### Task 4：调整 CI 漏洞与分支策略

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/check-ci-contracts.test.mjs`

- [x] **Step 1: 写入 CI 分支和漏洞策略测试**

在 `scripts/check-ci-contracts.test.mjs` 中新增：

```js
test("reports dependency vulnerabilities on dev and blocks release branches", async () => {
  const source = await readFile(new URL(".github/workflows/ci.yml", rootUrl), "utf8");

  assert.match(source, /branches:\s*\n\s*-\s*main\s*\n\s*-\s*dev\s*\n\s*-\s*release/);
  assert.match(source, /id:\s*dependency-audit/);
  assert.match(source, /continue-on-error:.*dev/);
  assert.match(source, /pnpm audit --audit-level high/);
});
```

- [x] **Step 2: 运行测试并确认失败**

Run:

```powershell
node --test scripts/check-ci-contracts.test.mjs
```

Expected: FAIL，push 分支缺少 `dev` 和 `release`。

- [x] **Step 3: 修改 CI 触发和审计步骤**

将 `.github/workflows/ci.yml` 的 push 分支改为：

```yaml
push:
  branches:
    - main
    - dev
    - release
```

将依赖审计步骤改为：

```yaml
- name: Audit all workspace dependencies
  id: dependency-audit
  continue-on-error: ${{ github.ref_name == 'dev' || github.base_ref == 'dev' }}
  run: pnpm audit --audit-level high
```

该表达式使 `dev` push 和目标为 `dev` 的 PR 只报告审计失败；`release`、`main` 及目标为
这些分支的 PR 继续阻断。

- [x] **Step 4: 运行 CI 契约测试**

Run:

```powershell
node --test scripts/check-ci-contracts.test.mjs
```

Expected: 全部 PASS。

- [x] **Step 5: 提交**

```powershell
git add .github/workflows/ci.yml scripts/check-ci-contracts.test.mjs
git commit -m "ci: report audits on dev and gate releases"
```

### Task 5：建立 WSL2 后端实机验证文档

**Files:**

- Create: `docs/operations/wsl-runtime-validation.md`
- Modify: `docs/operations/local-development.md`
- Modify: `scripts/check-local-infrastructure.test.mjs`

- [x] **Step 1: 写入失败的 WSL2 文档契约**

在 `scripts/check-local-infrastructure.test.mjs` 中新增：

```js
test("documents the required WSL2 runtime verification", async () => {
  const guide = await readFile(
    new URL("docs/operations/wsl-runtime-validation.md", rootUrl),
    "utf8",
  );

  assert.match(guide, /Ubuntu-22\.04/);
  assert.match(guide, /POSTGRES_PORT=55432/);
  assert.match(guide, /REDIS_PORT=56379/);
  assert.match(guide, /PostGIS_Lib_Version/);
  assert.match(guide, /health\/ready/);
  assert.match(guide, /user=node/);
  assert.match(guide, /ReadonlyRootfs/);
  assert.match(guide, /10 分钟/);
  assert.match(guide, /不得.*无关容器/s);
});
```

- [x] **Step 2: 运行测试并确认文档不存在**

Run:

```powershell
node --test scripts/check-local-infrastructure.test.mjs
```

Expected: FAIL，无法读取 `wsl-runtime-validation.md`。

- [x] **Step 3: 编写 WSL2 验证流程**

创建 `docs/operations/wsl-runtime-validation.md`，必须包含以下有序流程和完整命令：

1. 用 `wsl.exe -l -v` 确认 `Ubuntu-22.04` 与 WSL2。
2. 用 `docker ps` 盘点现有容器，明确不得停止无关容器。
3. 在 WSL 中设置 `POSTGRES_PORT=55432`、`REDIS_PORT=56379` 并启动 Compose。
4. 执行 `SELECT PostGIS_Lib_Version();` 和 `redis-cli ping`。
5. 生成 API/Worker 生产依赖产物。
6. 以 `--user node --read-only --tmpfs /tmp` 启动 API 和 Worker。
7. 验证 `/health/live`、`/health/ready`、`Config.User` 和 `ReadonlyRootfs`。
8. Worker 观察 10 分钟，检查 `RestartCount=0` 和日志无重连循环。
9. 停止并删除临时 API/Worker 容器，Compose 使用 `down` 但不带 `--volumes`。
10. 删除 `.wsl-runtime/`，确认 `git status --short` 未出现验证产物。

文档中的示例输出必须包含 `user=node`、`ReadonlyRootfs=true`、`PONG` 和 HTTP 200。

- [x] **Step 4: 从本地开发文档链接新流程**

在 `docs/operations/local-development.md` 的端口说明后增加：

```markdown
完整的 WSL2 API、Worker、PostgreSQL/PostGIS 和 Redis 实机验收步骤见
[`wsl-runtime-validation.md`](../../operations/wsl-runtime-validation.md)。该流程不得停止无关容器，
并在结束时保留 Compose 数据卷。
```

- [x] **Step 5: 运行文档契约测试**

Run:

```powershell
node --test scripts/check-local-infrastructure.test.mjs
```

Expected: 全部 PASS。

- [x] **Step 6: 提交**

```powershell
git add docs/operations/wsl-runtime-validation.md docs/operations/local-development.md scripts/check-local-infrastructure.test.mjs
git commit -m "docs: standardize WSL2 backend verification"
```

### Task 6：保全旧工作树的 4 份文档

**Files:**

- Modify: `docs/compliance/launch-evidence-index.md`
- Modify: `docs/operations/dependency-audit.md`
- Modify: `docs/operations/phase-0-verification.md`
- Modify: `docs/superpowers/specs/2026-07-27-stay-fable-platform-architecture-design.md`

- [x] **Step 1: 再次记录旧工作树状态**

Run:

```powershell
git -C "E:\My Work\stay-fable\.worktrees\phase-0-foundation" status --short
git -C "E:\My Work\stay-fable\.worktrees\phase-0-foundation" diff --check
```

Expected: 只出现上述 4 个修改文件；`diff --check` 不得出现错误。若文件集合发生变化，
停止整合并重新盘点，不能遗漏新增文件。

- [x] **Step 2: 在旧分支提交现有文档**

```powershell
git -C "E:\My Work\stay-fable\.worktrees\phase-0-foundation" add docs/compliance/launch-evidence-index.md docs/operations/dependency-audit.md docs/operations/phase-0-verification.md docs/superpowers/specs/2026-07-27-stay-fable-platform-architecture-design.md
git -C "E:\My Work\stay-fable\.worktrees\phase-0-foundation" commit -m "docs: preserve Phase 0 Chinese documentation"
```

Expected: 生成一个只包含 4 个文档的提交。

- [x] **Step 3: 将文档提交整合到当前分支**

记录上一步提交号为 `$phase0DocsCommit`，然后：

```powershell
git cherry-pick $phase0DocsCommit
```

Expected: cherry-pick 成功且 4 份文件均出现在当前分支历史中。若冲突，保留旧工作树的
中文内容，同时保留本分支新增的微信优先设计文件；解决后运行 `git diff --check`。

- [x] **Step 4: 运行文档契约**

Run:

```powershell
node --test scripts/check-phase-0-documents.test.mjs
corepack pnpm exec prettier --check docs/compliance docs/operations
```

Expected: 文档契约和格式检查全部 PASS。

### Task 7：执行完整验证和微信官方编译

**Files:**

- No source changes expected

- [x] **Step 1: 执行全仓开发门禁**

Run:

```powershell
corepack pnpm check
```

Expected: exit 0；默认任务不构建 Taro；`/wx` 静态检查通过。

- [x] **Step 2: 执行漏洞报告并记录实际状态**

Run:

```powershell
corepack pnpm audit --audit-level high
```

Expected: 在现有风险未解决时 exit 1，并打印具体 Critical/High 数量。此结果记录为
已知开发风险，不将 `dev` 判定为失败，也不得描述为安全通过。

- [x] **Step 3: 使用微信技能执行官方编译**

先完整读取 `compiler` 技能，然后针对
`E:\My Work\stay-fable\wx` 执行微信开发者工具编译。若编译器技能要求先初始化，则先
读取并使用 `initializer`。

Expected: 官方微信开发者工具报告编译成功，无 WXML/WXSS/JavaScript 错误。

- [x] **Step 4: 生成一次微信预览**

完整读取并使用 `previewer` 技能，为 `/wx` 生成预览信息。

Expected: AppID 权限有效，预览构建成功并返回包体信息。关闭本次打开的项目窗口，但
不得退出用户原本已打开的其他项目。

- [x] **Step 5: 执行 WSL2 实机验证**

严格按照 `docs/operations/wsl-runtime-validation.md` 执行。确认：

- PostGIS 查询返回版本；
- Redis 返回 `PONG`；
- API live/ready 均为 HTTP 200；
- API/Worker `user=node`、`ReadonlyRootfs=true`；
- Worker 观察 10 分钟后 `RestartCount=0`；
- 临时容器和 `.wsl-runtime/` 已清理；
- Compose 数据卷保留。

- [x] **Step 6: 确认工作区无验证噪声**

Run:

```powershell
git status --short
git diff --check
```

Expected: 只包含本计划文档尚未提交时的预期修改；不得包含 `.turbo/cache`、
`.wsl-runtime`、构建产物或微信预览文件。

### Task 8：整合主线并清理工作树

**Files:**

- No source changes expected

- [x] **Step 1: 确认所有实施提交和工作区状态**

```powershell
git status --short
git log --oneline --decorate -10
```

Expected: 当前功能分支 `git status --short` 无输出；历史中包含设计、实施计划、
`AGENTS.md`、微信检查、CI 策略、WSL2 文档和旧工作树文档提交。

- [x] **Step 2: 更新本地主线并合并功能分支**

在主工作区执行：

```powershell
git switch main
git merge --ff-only codex/wx-first-roadmap
```

Expected: `main` 快进到微信优先重整的最终提交。

- [x] **Step 3: 重新执行合并后的全量检查**

Run:

```powershell
corepack pnpm check
```

Expected: exit 0。若失败，不得继续删除工作树或推送。

- [x] **Step 4: 删除已整合工作树和功能分支**

先确认两个辅助工作树均无修改：

```powershell
git -C "E:\My Work\stay-fable\.worktrees\phase-0-foundation" status --short
git -C "E:\My Work\stay-fable\.worktrees\wx-first-roadmap" status --short
```

两者均无输出后：

```powershell
git worktree remove "E:\My Work\stay-fable\.worktrees\phase-0-foundation"
git worktree remove "E:\My Work\stay-fable\.worktrees\wx-first-roadmap"
git branch -d codex/phase-0-foundation
git branch -d codex/wx-first-roadmap
git worktree prune
```

Expected: `git worktree list` 只显示主工作区。

- [x] **Step 5: 对齐本地基线分支**

```powershell
git branch -f dev main
git branch -f release main
```

Expected: `main`、`dev`、`release` 指向同一最终提交。

### Task 9：推送并证明没有遗漏

**Files:**

- No source changes expected

- [x] **Step 1: 推送功能历史和三条基线分支**

使用普通推送，不使用 `--force`：

```powershell
git push origin main
git push origin dev
git push origin release
```

Expected: 三次推送成功。若远程出现新提交导致 non-fast-forward，停止并先 fetch/rebase
或合并，不得覆盖远程。

- [x] **Step 2: 刷新并比对本地与远程提交号**

```powershell
git fetch --prune origin
git rev-parse main
git rev-parse origin/main
git rev-parse dev
git rev-parse origin/dev
git rev-parse release
git rev-parse origin/release
```

Expected: 每一对本地/远程提交号完全一致。

- [x] **Step 3: 最终盘点**

```powershell
git status --short
git worktree list
git branch -vv
git log -1 --oneline --decorate
```

Expected:

- `git status --short` 无输出；
- 只有主工作区；
- `main`、`dev`、`release` 指向同一提交；
- 三条分支均与对应 origin 分支一致；
- Dependabot 远程分支未被修改或删除。

- [x] **Step 4: 记录已知搁置项**

最终交付说明必须明确：

- 实际依赖漏洞数量和等级；
- 漏洞在 `dev` 阶段只报告；
- `release/main` 仍阻断 Critical/High，或要求正式风险例外；
- 支付宝、抖音、Taro 日常构建和多语言均已搁置；
- 下一阶段从 `dev` 创建分支，实施微信基础体验。

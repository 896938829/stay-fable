import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const rootUrl = new URL("../", import.meta.url);

test("declares the root workspace contract", async () => {
  const root = JSON.parse(await readFile(new URL("package.json", rootUrl), "utf8"));
  const workspace = await readFile(new URL("pnpm-workspace.yaml", rootUrl), "utf8");

  assert.equal(root.private, true);
  assert.equal(root.packageManager, "pnpm@11.17.0");
  assert.match(workspace, /^\s*-\s+["']?apps\/\*["']?\s*$/m);
  assert.match(workspace, /^\s*-\s+["']?packages\/\*["']?\s*$/m);
  assert.equal(root.scripts.verify, "node scripts/verify-workspace.mjs");
  assert.equal(root.scripts["verify:phase-0"], "node scripts/verify-phase-0.mjs");
  const expectedScripts = {
    build: "turbo run build --filter=!@stay-fable/consumer-miniapp",
    dev: 'turbo run build --filter="./packages/*" && turbo run dev --parallel --filter=!@stay-fable/consumer-miniapp',
    lint: "eslint eslint.config.mjs prettier.config.mjs scripts/*.mjs packages/eslint-config/index.mjs && turbo run lint --filter=!@stay-fable/consumer-miniapp",
    test: "node --test scripts/*.test.mjs && turbo run test --filter=!@stay-fable/consumer-miniapp",
    typecheck: "turbo run typecheck --filter=!@stay-fable/consumer-miniapp",
    "prisma:generate": "pnpm --filter @stay-fable/api-server prisma:generate",
    "wx:check": "node scripts/check-wx-project.mjs",
    check:
      "pnpm verify && pnpm wx:check && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build",
  };
  for (const [script, expected] of Object.entries(expectedScripts)) {
    assert.equal(root.scripts[script], expected, `${script} must match the approved command`);
  }

  assert.deepEqual(
    root.scripts.check.split(" && "),
    [
      "pnpm verify",
      "pnpm wx:check",
      "pnpm format:check",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm test",
      "pnpm build",
    ],
    "check must run the approved gates in deterministic order",
  );
  assert.doesNotMatch(
    root.scripts.check,
    /\|\||continue-on-error|prisma:generate/,
    "check must not neutralize failures or duplicate the Turbo prerequisite",
  );
});

test("includes phase zero verification entry points and evidence in the workspace contract", async () => {
  const verifier = await readFile(new URL("scripts/verify-workspace.mjs", rootUrl), "utf8");

  for (const path of [
    "apps/api-server/turbo.json",
    "scripts/verify-phase-0.mjs",
    "scripts/verify-phase-0.test.mjs",
    "scripts/api-runtime-child.mjs",
    "scripts/smoke-api-runtime.mjs",
    "scripts/smoke-frontend-artifacts.mjs",
    "docs/operations/phase-0-verification.md",
    "infrastructure/cloud/cloudbase-run.md",
    "infrastructure/runbooks/backup-restore.md",
  ]) {
    assert.ok(verifier.includes(`"${path}"`), `workspace verifier must require ${path}`);
  }
});

test("models Prisma generation as an API package Turbo prerequisite", async () => {
  const apiPackage = JSON.parse(
    await readFile(new URL("apps/api-server/package.json", rootUrl), "utf8"),
  );
  const apiTurbo = JSON.parse(
    await readFile(new URL("apps/api-server/turbo.json", rootUrl), "utf8"),
  );

  assert.equal(
    apiPackage.scripts["prisma:generate"],
    "node --env-file=../../.env.example node_modules/prisma/build/index.js generate",
  );
  assert.deepEqual(apiTurbo.extends, ["//"]);
  assert.deepEqual(apiTurbo.tasks["prisma:generate"], {
    outputs: ["src/generated/prisma/**"],
  });
  for (const task of ["build", "lint", "test", "typecheck"]) {
    assert.deepEqual(
      apiTurbo.tasks[task]?.dependsOn,
      ["$TURBO_EXTENDS$", "prisma:generate"],
      `${task} must preserve root prerequisites and generate Prisma first`,
    );
  }
});

test("activates reproducible pnpm project settings", async () => {
  const workspace = await readFile(new URL("pnpm-workspace.yaml", rootUrl), "utf8");
  const lockfile = await readFile(new URL("pnpm-lock.yaml", rootUrl), "utf8");

  assert.match(workspace, /^autoInstallPeers:\s+false$/m);
  assert.match(workspace, /^engineStrict:\s+true$/m);
  assert.match(workspace, /^injectWorkspacePackages:\s+true$/m);
  assert.match(workspace, /^strictPeerDependencies:\s+true$/m);
  assert.doesNotMatch(workspace, /frozenLockfile|frozen-lockfile/);
  await assert.rejects(() => readFile(new URL(".npmrc", rootUrl)), { code: "ENOENT" });
  assert.match(lockfile, /^\s+autoInstallPeers:\s+false$/m);
  assert.match(lockfile, /^\s+injectWorkspacePackages:\s+true$/m);
});

test("excludes only the frozen Taro subtree from Prettier", async () => {
  const prettierIgnore = await readFile(new URL(".prettierignore", rootUrl), "utf8");
  const activeRules = prettierIgnore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  assert.deepEqual(
    activeRules.toSorted(),
    [
      ".agents/skills/",
      "apps/consumer-miniapp/",
      "docs/superpowers/",
      "pnpm-lock.yaml",
      "wx/",
    ].toSorted(),
    "Prettier ignore rules must exactly match the approved set",
  );
});

test("documents the WeChat-first agent workflow", async () => {
  const agents = await readFile(new URL("AGENTS.md", rootUrl), "utf8");
  const lines = agents.split(/\r?\n/);
  const findRuleLine = (tokens, label) => {
    const line = lines.find((candidate) => tokens.every((token) => candidate.includes(token)));
    assert.ok(line, `AGENTS.md must document ${label}`);
    return line;
  };

  assert.match(agents, /\/wx.*唯一正式用户端/s);
  const taroRule = findRuleLine(["apps", "consumer-miniapp"], "the Taro reference path");
  assert.match(taroRule, /冻结/, "the Taro reference must remain frozen");
  assert.match(
    taroRule,
    /不进入[^\n]*默认[^\n]*开发[^\n]*构建门禁/,
    "the Taro reference must stay outside default development and build gates",
  );
  const requiredRules = [
    [
      "read workflow and applicable skills before work",
      /开始工作前[\s\S]*?阅读本文件[^\n]*当前任务涉及[^\n]*技能说明/,
    ],
    [
      "start-of-work repository safety checks",
      /开始工作前[\s\S]*?git status --short[^\n]*git worktree list[^\n]*不得覆盖未提交修改/,
    ],
    [
      "dev feature-branch policy",
      /从[^\n]*dev[^\n]*创建[^\n]*codex[^\n]*<feature>[^\n]*分支[^\n]*release[^\n]*main[^\n]*不直接开发/,
    ],
    [
      "minimum WeChat verification",
      /微信功能[^\n]*静态检查[^\n]*微信开发者工具编译[^\n]*预览或自动化验收/,
    ],
    ["unrelated-container protection", /不得停止或删除无关容器/],
    ["non-root read-only services", /API 与 Worker[^\n]*非 root[^\n]*只读根文件系统/],
    ["Worker stability observation", /Worker[^\n]*10 分钟[^\n]*重启 0[^\n]*无重连循环/],
    ["runtime cleanup and volume retention", /删除临时容器\/产物[^\n]*Compose 数据卷[^\n]*保留/],
    [
      "dev quality gates",
      /dev 阶段[^\n]*格式[^\n]*lint[^\n]*类型检查[^\n]*测试[^\n]*构建[^\n]*漏洞报告/,
    ],
    ["dev vulnerability reporting", /dev 已知依赖漏洞[^\n]*报告[^\n]*不阻断/],
    ["fresh completion verification", /完成前[^\n]*全量验证[^\n]*不依赖历史结果/],
  ];

  for (const [rule, pattern] of requiredRules) {
    assert.match(agents, pattern, `AGENTS.md must document ${rule}`);
  }
  const releaseRule = findRuleLine(
    ["release", "main", "Critical", "High"],
    "release/main vulnerability policy",
  );
  assert.match(releaseRule, /阻断/, "release/main must block Critical and High vulnerabilities");
  assert.doesNotMatch(
    releaseRule,
    /不[^\n]{0,3}阻断/,
    "release/main must not describe Critical and High vulnerabilities as non-blocking",
  );
  for (const field of ["批准人", "到期日", "缓解措施"]) {
    assert.ok(releaseRule.includes(field), `release/main risk exceptions must include ${field}`);
  }
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
  for (const service of [
    "PostgreSQL/PostGIS",
    "Redis",
    "API /health/live",
    "/health/ready",
    "Worker",
  ]) {
    assert.ok(agents.includes(service), `AGENTS.md must require validating ${service}`);
  }
});

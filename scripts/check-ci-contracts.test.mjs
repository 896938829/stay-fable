import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parse } from "yaml";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("CI workflow enforces verification, secret scanning, and container scanning", async () => {
  const source = await read(".github/workflows/ci.yml");
  const workflow = parse(source);

  assert.deepEqual(workflow.on, {
    pull_request: {},
    push: { branches: ["main"] },
  });
  assert.deepEqual(workflow.permissions, { contents: "read" });

  const verify = workflow.jobs.verify;
  assert.equal(verify["runs-on"], "ubuntu-24.04");
  assert.equal(verify["timeout-minutes"], 30);
  assert.match(verify.services.postgres.image, /^postgis\/postgis:17-3\.5@sha256:[0-9a-f]{64}$/);
  assert.match(verify.services.redis.image, /^redis:7\.4-alpine@sha256:[0-9a-f]{64}$/);
  assert.match(verify.services.postgres.options, /pg_isready/);
  assert.match(verify.services.redis.options, /redis-cli ping/);
  assert.match(verify.env.DATABASE_URL, /^postgresql:\/\/[^:]+:[^@]+@localhost:/);
  assert.match(verify.env.REDIS_URL, /^redis:\/\/localhost:/);

  const nodeSetup = verify.steps.find((step) => step.name === "Set up Node.js");
  assert.equal(nodeSetup.with["node-version-file"], ".nvmrc");
  assert.equal(nodeSetup.with["node-version"], undefined);
  const nodeVersion = (await read(".nvmrc")).trim();
  assert.equal(nodeVersion, "24.14.1");
  for (const dockerfile of ["apps/api/Dockerfile", "apps/worker/Dockerfile"]) {
    assert.match(
      await read(dockerfile),
      new RegExp(`^FROM node:${nodeVersion}-bookworm-slim@`, "m"),
    );
  }

  const workflowText = JSON.stringify(workflow);
  for (const command of [
    "pnpm install --frozen-lockfile",
    "pnpm --filter @stay-fable/api-server prisma:generate",
    "pnpm check",
    "pnpm audit --audit-level high",
  ]) {
    assert.match(workflowText, new RegExp(command.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.equal(workflow.jobs.secrets.steps[0].with["fetch-depth"], 0);
  assert.match(
    workflowText,
    /ghcr\.io\/gitleaks\/gitleaks@sha256:[0-9a-f]{64}.*detect.*--exit-code 1/,
  );
  assert.match(workflow.jobs.secrets.steps[1].run, /--user "\$\(id -u\):\$\(id -g\)"/);

  const containers = workflow.jobs.containers;
  const containerText = JSON.stringify(containers.steps);
  assert.match(containerText, /apps\/api\/Dockerfile --tag stay-fable-api:ci/);
  assert.match(containerText, /apps\/worker\/Dockerfile --tag stay-fable-worker:ci/);
  assert.match(workflowText, /aquasecurity\/trivy-action@[0-9a-f]{40}/);
  for (const [name, image] of [
    ["Scan API image", "stay-fable-api:ci"],
    ["Scan Worker image", "stay-fable-worker:ci"],
  ]) {
    const scan = containers.steps.find((step) => step.name === name);
    assert.equal(scan.with["image-ref"], image);
    assert.equal(scan.with["exit-code"], "1");
    assert.equal(scan.with.severity, "HIGH,CRITICAL");
    assert.equal(scan.with["ignore-unfixed"], true);
  }
  assert.doesNotMatch(source, /Audit production dependencies/);

  for (const use of source.matchAll(/uses:\s*([^@\s]+)@([^\s#]+)/g)) {
    assert.match(use[2], /^[0-9a-f]{40}$/, `${use[1]} must be pinned to a full commit SHA`);
  }
  assert.doesNotMatch(source, /security-events:\s*write/);
});

test("Dependabot covers npm and GitHub Actions with bounded schedules", async () => {
  const config = parse(await read(".github/dependabot.yml"));

  assert.equal(config.version, 2);
  const npm = config.updates.find((entry) => entry["package-ecosystem"] === "npm");
  assert.equal(npm.directory, "/");
  assert.equal(npm.schedule.interval, "weekly");
  assert.equal(npm.schedule.day, "monday");
  assert.equal(npm["open-pull-requests-limit"], 5);
  assert.deepEqual(npm.groups["minor-and-patch"]["update-types"], ["minor", "patch"]);

  const actions = config.updates.find((entry) => entry["package-ecosystem"] === "github-actions");
  assert.equal(actions.directory, "/");
  assert.equal(actions.schedule.interval, "monthly");
});

test("direct CI tooling dependencies use patched versions", async () => {
  const rootPackage = JSON.parse(await read("package.json"));

  assert.equal(rootPackage.devDependencies.yaml, "2.8.3");
});

test("Gitleaks configuration only allows explicit fake fixture paths", async () => {
  const source = await read(".gitleaks.toml");

  assert.match(source, /useDefault\s*=\s*true/);
  assert.match(source, /tests?\/fixtures?/);
  assert.doesNotMatch(source, /paths\s*=\s*\['(?:docs|\*\*|\.env\.\*)/);
});

test("security gate documentation names owners, evidence, SLAs, and exceptions", async () => {
  const source = await read("docs/operations/security-gates.md");

  for (const phrase of [
    "Owner",
    "状态",
    "lint",
    "typecheck",
    "test",
    "build",
    "HIGH",
    "CRITICAL",
    "分支保护",
    "证据",
    "SLA",
    "例外",
    "到期",
    "补偿措施",
    "复审",
    "数据库迁移",
    "API contract",
    "兼容性说明",
    "支付",
    "授权",
    "敏感数据",
    "专项测试",
  ]) {
    assert.match(source, new RegExp(phrase, "i"), `missing ${phrase}`);
  }
  assert.match(source, /已有修复版本/);
  assert.match(source, /未修复项.*(?:跟踪|例外)/s);
  assert.match(source, /尚未在 GitHub Actions 实际运行/);
});

test("dependency audit evidence records the unresolved blocking advisories", async () => {
  const source = await read("docs/operations/dependency-audit.md");

  assert.match(source, /基线.*30.*2 CRITICAL.*11 HIGH/s);
  assert.match(source, /当前.*29.*2 CRITICAL.*11 HIGH/s);
  assert.match(source, /直接依赖.*webpack/s);
  assert.match(source, /传递依赖.*GHSA-hmx5-qpq5-p643/s);
  for (const advisory of [
    "GHSA-mp2f-45pm-3cg9",
    "GHSA-8jmw-wjr8-2x66",
    "GHSA-c96f-x56v-gq3h",
    "GHSA-pm4m-ph32-ghv5",
    "GHSA-mh99-v99m-4gvg",
  ]) {
    assert.match(source, new RegExp(advisory));
  }
  assert.match(source, /无兼容修复/);
  assert.match(source, /34.*16.*18/);
  assert.match(source, /pnpm audit --audit-level high/);
});

test("security docs assign monthly Gitleaks image updates", async () => {
  const source = await read("docs/operations/security-gates.md");

  assert.match(source, /Dependabot.*不会追踪.*Gitleaks/s);
  assert.match(source, /Security Owner.*至少每月/s);
  assert.match(source, /稳定 tag.*Registry.*digest.*留证/s);
});

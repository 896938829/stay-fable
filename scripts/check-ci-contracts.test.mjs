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
  assert.equal(verify.services.postgres.image, "postgis/postgis:17-3.5");
  assert.equal(verify.services.redis.image, "redis:7.4-alpine");
  assert.match(verify.services.postgres.options, /pg_isready/);
  assert.match(verify.services.redis.options, /redis-cli ping/);
  assert.match(verify.env.DATABASE_URL, /^postgresql:\/\/[^:]+:[^@]+@localhost:/);
  assert.match(verify.env.REDIS_URL, /^redis:\/\/localhost:/);

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

  const containers = workflow.jobs.containers;
  assert.match(
    JSON.stringify(containers.steps),
    /docker build --file apps\/api\/Dockerfile --tag stay-fable-api:ci \./,
  );
  assert.match(workflowText, /aquasecurity\/trivy-action@[0-9a-f]{40}/);
  assert.equal(
    containers.steps.find((step) => step.name === "Scan API image").with["exit-code"],
    "1",
  );
  assert.equal(
    containers.steps.find((step) => step.name === "Scan API image").with.severity,
    "HIGH,CRITICAL",
  );
  assert.equal(
    containers.steps.find((step) => step.name === "Scan API image").with["ignore-unfixed"],
    true,
  );

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
  ]) {
    assert.match(source, new RegExp(phrase, "i"), `missing ${phrase}`);
  }
  assert.match(source, /尚未在 GitHub Actions 实际运行/);
});

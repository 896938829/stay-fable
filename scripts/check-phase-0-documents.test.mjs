import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const documents = {
  "infrastructure/cloud/provisioning-checklist.md": [
    "| Control | Required state | Evidence | Status |",
    "VPC",
    "PostgreSQL 17",
    "Redis",
    "CloudBase Run",
    "EdgeOne",
    "quarantine",
    "KMS",
    "CLS",
    "CAM",
  ],
  "infrastructure/runbooks/backup-restore.md": [
    "RPO",
    "RTO",
    "PostGIS",
    "readiness",
    "Platform Owner",
  ],
  "infrastructure/runbooks/security-incident.md": [
    "## Contacts and escalation",
    "## Evidence preservation",
    "Data Protection",
    "CLS",
    "WAF",
  ],
  "docs/compliance/data-inventory.md": [
    "| Data category | Purpose | Source | Fields | Sensitivity | Legal or contractual basis | System of record | Access | Sharing | Retention | Deletion |",
    "Payment reference",
    "Audit log",
    "Behavior analytics",
  ],
  "docs/compliance/third-party-processing-register.md": [
    "| Provider | Purpose | Data | Region | Agreement status | Security review | Exit deletion |",
    "Tencent Cloud",
    "WeChat",
    "Alipay",
    "Douyin",
    "Metabase",
  ],
  "docs/compliance/retention-policy.md": [
    "| Data | Default period | End-of-period action | Exception approval |",
    "13 months",
    "180 days",
    "3 years",
    "90 days",
  ],
  "docs/compliance/launch-evidence-index.md": [
    "| Evidence item | Repository evidence | External evidence location | Status |",
    "Docker",
    "GitHub Actions",
    "Gitleaks",
    "Trivy",
    "WeChat",
    "Alipay",
    "Douyin",
    "2 critical",
    "11 high",
  ],
  "docs/operations/ownership.md": [
    "| Role | Accountabilities |",
    "Platform",
    "Security",
    "Data Protection",
    "Engineering",
    "Operations",
    "Finance",
  ],
};

const allowedControlStatuses = new Set(["Not started", "In review", "Accepted", "Blocked"]);

function tableStatusValues(markdown) {
  const lines = markdown.split(/\r?\n/);
  const values = [];

  for (let index = 0; index < lines.length - 2; index += 1) {
    const headers = lines[index]
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean);
    const statusIndexes = headers
      .map((header, headerIndex) =>
        /^(Status|Agreement status|Security review)$/i.test(header) ? headerIndex : -1,
      )
      .filter((headerIndex) => headerIndex !== -1);
    if (statusIndexes.length === 0 || !/^\s*\|?(?:\s*:?-+:?\s*\|)+\s*$/.test(lines[index + 1])) {
      continue;
    }

    for (let row = index + 2; row < lines.length && lines[row].trim().startsWith("|"); row += 1) {
      const cells = lines[row]
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean);
      for (const statusIndex of statusIndexes) {
        if (cells[statusIndex]) values.push(cells[statusIndex]);
      }
    }
  }

  return values;
}

function canonicalMarkdown(markdown) {
  return markdown
    .split(/\r?\n/)
    .map((line) =>
      line.trim().startsWith("|")
        ? `| ${line
            .split("|")
            .map((cell) => cell.trim())
            .filter(Boolean)
            .join(" | ")} |`
        : line,
    )
    .join("\n");
}

test("status parser validates every status-bearing table column", () => {
  const markdown = [
    "| Provider | Agreement status | Security review |",
    "| --- | --- | --- |",
    "| Example | In review | Not started |",
  ].join("\n");

  assert.deepEqual(tableStatusValues(markdown), ["In review", "Not started"]);
});

test("phase zero control documents are complete and use auditable states", async () => {
  for (const [relativePath, requiredContent] of Object.entries(documents)) {
    const markdown = await readFile(path.join(root, relativePath), "utf8");
    const canonical = canonicalMarkdown(markdown);

    assert.match(
      markdown,
      /^Status: Draft for pre-production verification\r?\nOwner role: .+\r?\nReview cadence: .+/,
      `${relativePath} must start with the document control metadata`,
    );
    assert.doesNotMatch(
      markdown,
      /\b(?:TBD|TODO)\b|待定|待补充/i,
      `${relativePath} contains a placeholder`,
    );

    for (const content of requiredContent) {
      assert.ok(canonical.includes(content), `${relativePath} must include ${content}`);
    }

    for (const status of tableStatusValues(markdown)) {
      assert.ok(
        allowedControlStatuses.has(status),
        `${relativePath} uses invalid control status: ${status}`,
      );
    }
  }
});

test("backup restoration and incident response runbooks contain seven ordered actions", async () => {
  for (const relativePath of [
    "infrastructure/runbooks/backup-restore.md",
    "infrastructure/runbooks/security-incident.md",
  ]) {
    const markdown = await readFile(path.join(root, relativePath), "utf8");
    const steps = [...markdown.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]));
    assert.deepEqual(
      steps,
      [1, 2, 3, 4, 5, 6, 7],
      `${relativePath} must contain exactly seven ordered actions`,
    );
  }
});

test("launch evidence does not claim unfinished external gates are accepted", async () => {
  const markdown = await readFile(
    path.join(root, "docs/compliance/launch-evidence-index.md"),
    "utf8",
  );

  for (const gate of [
    "Docker",
    "GitHub Actions",
    "Gitleaks",
    "Trivy",
    "WeChat",
    "Alipay",
    "Douyin",
  ]) {
    const row = markdown.split(/\r?\n/).find((line) => line.startsWith("|") && line.includes(gate));
    assert.ok(row, `launch evidence must include ${gate}`);
    assert.doesNotMatch(
      row,
      /\|\s*Accepted\s*\|?\s*$/,
      `${gate} cannot be accepted before external verification`,
    );
  }
});

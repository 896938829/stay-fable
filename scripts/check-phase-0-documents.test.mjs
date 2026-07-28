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
    "| Provider | Purpose | Data | Region | Agreement status | Security review | Review status | Evidence ID | Exit owner | Completion deadline | Exit deletion |",
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

  function cellsFor(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
      throw new Error("malformed Markdown table: every row must start and end with a pipe");
    }
    return trimmed
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
  }

  function isSeparator(line) {
    if (!line.trim().startsWith("|") || !line.trim().endsWith("|")) return false;
    const cells = cellsFor(line);
    return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  }

  for (let index = 0; index < lines.length - 2; index += 1) {
    if (!isSeparator(lines[index + 1])) continue;

    const headers = cellsFor(lines[index]);
    const separators = cellsFor(lines[index + 1]);
    if (headers.length !== separators.length || headers.some((header) => header.length === 0)) {
      throw new Error("malformed Markdown table: header and separator columns must align");
    }
    const statusIndexes = headers
      .map((header, headerIndex) =>
        /^(Status|Agreement status|Security review|Review status)$/i.test(header)
          ? headerIndex
          : -1,
      )
      .filter((headerIndex) => headerIndex !== -1);

    for (let row = index + 2; row < lines.length && lines[row].trim().startsWith("|"); row += 1) {
      const cells = cellsFor(lines[row]);
      if (cells.length !== headers.length) {
        throw new Error("malformed Markdown table: data row column count does not match header");
      }
      for (const statusIndex of statusIndexes) {
        if (cells[statusIndex].length === 0) {
          throw new Error("empty status cell in Markdown table");
        }
        values.push(cells[statusIndex]);
      }
    }
  }

  return values;
}

function canonicalMarkdown(markdown) {
  return markdown
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith("|") && trimmed.endsWith("|")
        ? `| ${trimmed
            .slice(1, -1)
            .split("|")
            .map((cell) => cell.trim())
            .join(" | ")} |`
        : line;
    })
    .join("\n");
}

function assertDependencyAuditEvidenceConsistent(evidenceIndex, dependencyAudit) {
  const summaries = [
    ...dependencyAudit.matchAll(/^Current audit summary: (\d+) CRITICAL, (\d+) HIGH$/gm),
  ];
  const conclusions = [
    ...dependencyAudit.matchAll(/^Current release conclusion: (Blocked|In review|Accepted)$/gm),
  ];
  if (summaries.length !== 1 || conclusions.length !== 1) {
    throw new Error("dependency audit must contain one unique current summary and conclusion");
  }

  const critical = Number(summaries[0][1]);
  const high = Number(summaries[0][2]);
  const conclusion = conclusions[0][1];
  if ((critical > 0 || high > 0) && conclusion !== "Blocked") {
    throw new Error("current dependency severities require a Blocked release conclusion");
  }

  const lines = evidenceIndex.split(/\r?\n/);
  const dependencyRows = [];
  for (let index = 0; index < lines.length - 2; index += 1) {
    const headerLine = lines[index].trim();
    const separatorLine = lines[index + 1].trim();
    if (
      !headerLine.startsWith("|") ||
      !headerLine.endsWith("|") ||
      !separatorLine.startsWith("|") ||
      !separatorLine.endsWith("|")
    ) {
      continue;
    }

    const headers = headerLine
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    const separators = separatorLine
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    if (
      headers.length !== separators.length ||
      !separators.every((cell) => /^:?-{3,}:?$/.test(cell))
    ) {
      continue;
    }

    const itemIndex = headers.indexOf("Evidence item");
    const statusIndex = headers.indexOf("Status");
    if (itemIndex === -1 || statusIndex === -1) continue;

    for (let row = index + 2; row < lines.length && lines[row].trim().startsWith("|"); row += 1) {
      const trimmed = lines[row].trim();
      const cells = trimmed
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim());
      if (cells.length !== headers.length) {
        throw new Error("malformed launch evidence table");
      }
      if (/^Dependency audit:/i.test(cells[itemIndex])) {
        dependencyRows.push({ cells, itemIndex, statusIndex });
      }
    }
  }

  if (dependencyRows.length !== 1) {
    throw new Error("dependency audit evidence row must be present exactly once");
  }
  const [{ cells, itemIndex, statusIndex }] = dependencyRows;
  const item = cells[itemIndex];
  const itemSummary = /^Dependency audit: (\d+) critical and (\d+) high findings$/i.exec(item);
  if (!itemSummary || Number(itemSummary[1]) !== critical || Number(itemSummary[2]) !== high) {
    throw new Error("dependency audit evidence counts must match the current audit summary");
  }

  const status = cells[statusIndex];
  if (status !== conclusion) {
    if (conclusion === "Blocked") {
      throw new Error("dependency audit evidence must remain Blocked while audit blockers exist");
    }
    throw new Error("dependency audit evidence status must match the current release conclusion");
  }
}

test("status parser validates every status-bearing table column", () => {
  const markdown = [
    "| Provider | Agreement status | Security review |",
    "| --- | --- | --- |",
    "| Example | In review | Not started |",
  ].join("\n");

  assert.deepEqual(tableStatusValues(markdown), ["In review", "Not started"]);
});

test("status parser rejects empty and structurally shifted status cells", () => {
  const malformedTables = [
    ["| Status | Control |", "| --- | --- |", "| | Example |"],
    ["| Control | Status |", "| --- | --- |", "| Example | |"],
    ["| Control | Status |", "| --- | --- |", "| Example | Not started | unexpected |"],
    [
      "| Control | Agreement status | Security review |",
      "| --- | --- | --- |",
      "| Example | In review |",
    ],
  ];

  for (const lines of malformedTables) {
    assert.throws(
      () => tableStatusValues(lines.join("\n")),
      /malformed Markdown table|empty status/i,
    );
  }
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

test("launch evidence uses the native WeChat project and keeps official validation pending", async () => {
  const markdown = await readFile(
    path.join(root, "docs/compliance/launch-evidence-index.md"),
    "utf8",
  );
  const row = markdown
    .split(/\r?\n/)
    .find((line) => line.startsWith("|") && line.includes("微信（WeChat）"));

  assert.ok(row, "launch evidence must include the current WeChat row");
  for (const evidencePath of [
    "../../wx/project.config.json",
    "../../wx/app.json",
    "../../scripts/check-wx-project.mjs",
  ]) {
    assert.ok(row.includes(evidencePath), `WeChat evidence must reference ${evidencePath}`);
  }
  assert.doesNotMatch(
    row,
    /apps\/consumer-miniapp/,
    "current WeChat evidence must not point to the frozen Taro reference",
  );
  assert.match(
    row,
    /尚未执行.*微信开发者工具.*编译.*官方预览/,
    "official WeChat compilation and preview must remain explicitly pending",
  );
  assert.match(row, /\|\s*Blocked\s*\|?\s*$/, "pending official evidence must remain blocked");
});

test("only WeChat is a current mini-program launch gate", async () => {
  const markdown = await readFile(
    path.join(root, "docs/compliance/launch-evidence-index.md"),
    "utf8",
  );
  const currentSection = markdown.match(/^## 当前上线门禁\r?\n[\s\S]*?(?=^## |(?![\s\S]))/m)?.[0];
  const historicalSection = markdown.match(
    /^## 历史与延期的非当前门禁项目\r?\n[\s\S]*?(?=^## |(?![\s\S]))/m,
  )?.[0];

  assert.ok(currentSection, "launch evidence must identify the current gate section");
  assert.match(currentSection, /微信（WeChat）/);
  assert.doesNotMatch(currentSection, /支付宝（Alipay）|抖音（Douyin）/);

  assert.ok(historicalSection, "launch evidence must retain deferred platform history");
  for (const platform of ["支付宝（Alipay）", "抖音（Douyin）"]) {
    const row = historicalSection
      .split(/\r?\n/)
      .find((line) => line.startsWith("|") && line.includes(platform));
    assert.ok(row, `historical evidence must retain ${platform}`);
    assert.match(row, /Deferred/);
    assert.match(row, /不属于当前.*上线门禁/);
    assert.doesNotMatch(row, /\|\s*Blocked\s*\|?\s*$/);
  }
});

test("Phase 0 verification separates current native WeChat checks from historical Taro evidence", async () => {
  const markdown = await readFile(
    path.join(root, "docs/operations/phase-0-verification.md"),
    "utf8",
  );
  const currentSection = markdown.match(
    /^## 当前 HEAD 的微信优先验证契约\r?\n[\s\S]*?(?=^## |(?![\s\S]))/m,
  )?.[0];
  const historicalSection = markdown.match(
    /^## 2026-07-27 历史证据（Taro 三端）\r?\n[\s\S]*?(?=^## |(?![\s\S]))/m,
  )?.[0];

  assert.ok(currentSection, "verification evidence must describe the current HEAD contract");
  for (const required of [
    "`pnpm check`",
    "`pnpm wx:check`",
    "`scripts/check-wx-project.mjs`",
    "`/wx`",
    "`apps/consumer-miniapp`",
  ]) {
    assert.ok(currentSection.includes(required), `current HEAD contract must include ${required}`);
  }
  assert.match(currentSection, /冻结/);
  assert.match(currentSection, /不进入.*默认.*(?:检查|构建)/s);
  assert.match(
    currentSection,
    /Task 7.*尚未执行.*微信开发者工具.*编译.*预览/s,
    "current HEAD must not claim Task 7 runtime evidence",
  );

  assert.ok(historicalSection, "verification evidence must retain a dated Taro history section");
  assert.match(historicalSection, /历史/);
  assert.match(historicalSection, /三个平台产物|三端/);
  assert.match(historicalSection, /不代表当前 HEAD|不可作为当前 HEAD/);
});

test("Phase 0 historical evidence names its immutable remediation commit", async () => {
  const markdown = await readFile(
    path.join(root, "docs/operations/phase-0-verification.md"),
    "utf8",
  );
  const sourceSection = markdown.match(
    /^## 2026-07-27 历史证据来源\r?\n[\s\S]*?(?=^## |(?![\s\S]))/m,
  )?.[0];
  const remediationSha = "bcd312122dc6fe9b41f5e6ec2febf3181e144410";

  assert.ok(sourceSection, "historical evidence must have an explicitly dated source section");
  assert.match(sourceSection, new RegExp(`历史整改证据提交：\`${remediationSha}\``));
  assert.equal(
    [...markdown.matchAll(new RegExp(remediationSha, "g"))].length,
    1,
    "the immutable remediation SHA must appear exactly once",
  );
  assert.doesNotMatch(markdown, /本页所在提交|本页的提交|当前提交/);
});

test("the 2026-07-27 architecture marks its client strategy as superseded", async () => {
  const markdown = await readFile(
    path.join(root, "docs/superpowers/specs/2026-07-27-stay-fable-platform-architecture-design.md"),
    "utf8",
  );
  const notice = markdown.slice(0, 900);

  assert.match(notice, /历史架构记录/);
  assert.match(notice, /客户端策略已由[\s\S]*?取代/);
  assert.match(notice, /2026-07-28-wx-first-development-landscape-design\.md/);
  assert.match(notice, /`\/wx`.*唯一正式用户端/s);
  assert.match(notice, /Taro.*冻结/s);
});

test("dependency audit evidence remains blocked while audit evidence reports blockers", async () => {
  const audit = await readFile(path.join(root, "docs/operations/dependency-audit.md"), "utf8");
  const evidence = await readFile(
    path.join(root, "docs/compliance/launch-evidence-index.md"),
    "utf8",
  );

  assert.doesNotThrow(() => assertDependencyAuditEvidenceConsistent(evidence, audit));

  const accepted = evidence.replace(
    /(\|\s*Dependency audit:[^\r\n]*\|)\s*Blocked\s*\|/i,
    "$1 Accepted |",
  );
  assert.notEqual(accepted, evidence, "adversarial fixture must alter the dependency audit row");
  assert.throws(
    () => assertDependencyAuditEvidenceConsistent(accepted, audit),
    /dependency audit evidence must remain Blocked/i,
  );
});

test("dependency audit gate ignores historical severities and follows unique current fields", async () => {
  const audit = await readFile(path.join(root, "docs/operations/dependency-audit.md"), "utf8");
  assert.equal(
    [...audit.matchAll(/^Current audit summary: \d+ CRITICAL, \d+ HIGH$/gm)].length,
    1,
    "dependency audit must expose one current summary",
  );
  assert.equal(
    [...audit.matchAll(/^Current release conclusion: (?:Blocked|In review|Accepted)$/gm)].length,
    1,
    "dependency audit must expose one current release conclusion",
  );

  const historicalOnly = [
    "Historical baseline: 2 CRITICAL, 11 HIGH",
    "Current audit summary: 0 CRITICAL, 0 HIGH",
    "Current release conclusion: In review",
  ].join("\n");
  const currentEvidence = [
    "| Evidence item | Repository evidence | External evidence location | Status |",
    "| --- | --- | --- | --- |",
    "| Dependency audit: 0 critical and 0 high findings | audit | evidence | In review |",
  ].join("\n");

  assert.doesNotThrow(() =>
    assertDependencyAuditEvidenceConsistent(currentEvidence, historicalOnly),
  );
});

test("runbooks preserve evidence and make destructive actions auditable", async () => {
  const incident = await readFile(
    path.join(root, "infrastructure/runbooks/security-incident.md"),
    "utf8",
  );
  const backup = await readFile(
    path.join(root, "infrastructure/runbooks/backup-restore.md"),
    "utf8",
  );

  assert.ok(
    incident.indexOf("preserve volatile") < incident.indexOf("Revoke affected"),
    "volatile evidence preservation must precede normal containment",
  );
  for (const phrase of [
    "active attack",
    "time, operator, reason, and affected evidence",
    "authoritative deadline source",
    "notification decision owner",
    "approver",
    "recipient",
    "deadline",
    "sending owner",
    "sent or not sent",
    "delivery evidence",
  ]) {
    assert.ok(incident.toLowerCase().includes(phrase), `incident runbook must include ${phrase}`);
  }

  for (const phrase of [
    "immutable resource ID",
    "different from the source instance ID",
    "recovery network",
    "no business traffic",
    "second role",
    "deletion plan preview",
    "cloud audit event",
    "proof that the resource no longer exists",
  ]) {
    assert.ok(backup.includes(phrase), `backup runbook must include ${phrase}`);
  }
});

test("privacy controls enforce minimization, safe deletion, and processor review evidence", async () => {
  const inventory = await readFile(path.join(root, "docs/compliance/data-inventory.md"), "utf8");
  const retention = await readFile(path.join(root, "docs/compliance/retention-policy.md"), "utf8");
  const processors = await readFile(
    path.join(root, "docs/compliance/third-party-processing-register.md"),
    "utf8",
  );

  for (const phrase of [
    "Authentication identity",
    "Optional account profile",
    "Collection condition",
    "Field whitelist",
    "Prohibited fields",
    "government identity number",
    "biometric",
  ]) {
    assert.ok(inventory.includes(phrase), `data inventory must include ${phrase}`);
  }
  for (const phrase of [
    "primary storage, derived copy, index, and cache",
    "immutable backups expire through the approved rolling window",
    "deletion ledger",
    "tombstone",
    "must not be served again",
  ]) {
    assert.ok(retention.includes(phrase), `retention policy must include ${phrase}`);
  }
  for (const phrase of [
    "Review status",
    "Evidence ID",
    "Exit owner",
    "Completion deadline",
    "provider backup expiry",
  ]) {
    assert.ok(processors.includes(phrase), `processor register must include ${phrase}`);
  }
});

test("security gates use the canonical operating owner roles", async () => {
  const gates = await readFile(path.join(root, "docs/operations/security-gates.md"), "utf8");

  assert.doesNotMatch(
    gates,
    /\b(?:Release Manager|Security Champion|Engineering Lead|Dependency Owner|Service Owner|Data Owner|API Owner)\b/,
  );
  for (const owner of ["Platform Owner", "Security Owner", "Engineering Owner"]) {
    assert.ok(gates.includes(owner), `security gates must assign ${owner}`);
  }
});

test("release and security exception approvals use the same two owners", async () => {
  const approval = "Security Owner and Platform Owner jointly approve";
  for (const relativePath of [
    "docs/operations/security-gates.md",
    "docs/operations/ownership.md",
    "infrastructure/cloud/provisioning-checklist.md",
  ]) {
    const markdown = await readFile(path.join(root, relativePath), "utf8");
    assert.ok(markdown.includes(approval), `${relativePath} must use the joint approval contract`);
    assert.doesNotMatch(
      markdown,
      /\brelease approver\b/i,
      `${relativePath} uses an undefined role`,
    );
  }
});

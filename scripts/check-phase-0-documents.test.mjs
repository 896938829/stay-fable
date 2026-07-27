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

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
const wxFirstPlanPath = "docs/superpowers/plans/2026-07-28-wx-first-workspace-realignment.md";

function git(...args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`, {
      cause: error,
    });
  }
}

function extractWeChatEvidence(markdown, source) {
  const input = markdown.match(/(?:不可变验证输入提交为\s*|input )`([0-9a-f]{40})`/)?.[1];
  const tree = markdown.match(/(?:对应 `wx` tree 为\s*|wx tree )`([0-9a-f]{40})`/)?.[1];

  assert.ok(input, `${source} must record a 40-character validation input commit`);
  assert.ok(tree, `${source} must record a 40-character wx tree`);

  return { input, tree };
}

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

function stripFencedCodeBlocks(markdown) {
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  const output = [];
  let fenceCharacter;
  let fenceLength = 0;

  for (const line of markdown.split(/\r?\n/)) {
    if (fenceCharacter) {
      const closingFence = new RegExp(`^ {0,3}${fenceCharacter}{${fenceLength},}[\\t ]*$`);
      if (closingFence.test(line)) {
        fenceCharacter = undefined;
        fenceLength = 0;
      }
      output.push("");
      continue;
    }

    const openingFence = /^ {0,3}(`{3,}|~{3,})[^\r\n]*$/.exec(line);
    if (openingFence) {
      fenceCharacter = openingFence[1][0];
      fenceLength = openingFence[1].length;
      output.push("");
      continue;
    }

    output.push(line);
  }

  return output.join(eol);
}

function validateCompletedPlanTasks(markdown) {
  const source = stripFencedCodeBlocks(markdown);
  assert.doesNotMatch(source, /^\s*-\s+\[ \]/m, "completed plan has an unchecked task");

  const taskMatches = [...source.matchAll(/^###\s+Task\s+(\d+)(?:\s*[:：]|\s|$)[^\r\n]*$/gm)];
  for (let number = 1; number <= 9; number += 1) {
    const matchingTasks = taskMatches.filter((match) => Number(match[1]) === number);
    assert.equal(matchingTasks.length, 1, `Task ${number} must appear exactly once`);
  }
  assert.equal(taskMatches.length, 9, "plan must contain exactly nine real Task headings");

  for (let index = 0; index < taskMatches.length; index += 1) {
    const current = taskMatches[index];
    const next = taskMatches[index + 1];
    const section = source.slice(current.index, next?.index ?? source.length);
    assert.match(
      section,
      /^\s*-\s+\[[xX]\]/m,
      `Task ${current[1]} must contain a completed checklist item`,
    );
  }
}

function parseLabeledCompletionSummary(section) {
  const allowedLabels = new Set(["实施基线", "微信证据", "WSL2 验证", "漏洞策略", "延期范围"]);
  const entries = [];
  let current;

  function saveCurrent() {
    if (!current) return;
    assert.ok(current.value, `${current.label} summary value must not be empty`);
    assert.ok(
      !entries.some(([label]) => label === current.label),
      `duplicate completion summary label: ${current.label}`,
    );
    entries.push([current.label, current.value.replace(/\s+/g, " ").trim()]);
    current = undefined;
  }

  for (const line of section.split(/\r?\n/)) {
    if (!line.trim()) continue;

    const bullet = /^ {0,3}-\s+(.+)$/.exec(line);
    if (bullet) {
      saveCurrent();
      const labeledValue = /^\*\*([^*：:]+)[：:]\*\*\s*(.*)$/.exec(bullet[1]);
      assert.ok(labeledValue, "completion summary bullet must start with a bold label");
      const label = labeledValue[1].trim();
      assert.ok(allowedLabels.has(label), `unknown completion summary label: ${label}`);
      current = { label, value: labeledValue[2].trim() };
      continue;
    }

    assert.ok(
      current && /^(?: {2,}|\t)\S/.test(line),
      "completion summary contains non-bullet prose",
    );
    current.value += ` ${line.trim()}`;
  }
  saveCurrent();

  assert.equal(entries.length, 5, "completion summary must contain exactly five labeled bullets");
  assert.deepEqual(
    entries.map(([label]) => label).sort(),
    [...allowedLabels].sort(),
    "completion summary labels must each appear exactly once",
  );

  return Object.fromEntries(entries);
}

function assertCompletionSummaryFacts(summary) {
  function match(label, pattern, fact) {
    assert.match(summary[label], pattern, `${label} must record ${fact}`);
  }

  match("实施基线", /^Task 1–9 均已完成。/, "Task 1–9 completion");
  match(
    "实施基线",
    /5a7ba6f1800c26569e2cb41679c3f8cc26ede22d/,
    "the implementation baseline commit",
  );
  match(
    "实施基线",
    /`main`、`dev`、`release` 及对应远端分支均对齐到\*\*实施基线\*\*/,
    "local and remote baseline alignment",
  );
  match("实施基线", /该 SHA 是实施基线，而不是.*当前 `HEAD`/, "baseline-not-HEAD scope");
  match("实施基线", /旧工作树和已完成功能分支已清理。$/, "worktree and branch cleanup");

  match(
    "微信证据",
    /不可变 input `deb274c58f64b6259e89d19a582200182126d770`/,
    "immutable input commit",
  );
  match("微信证据", /`wx` tree `021ed57a0b3b1e876123befad4f375446621fb42`/, "immutable wx tree");
  for (const [pattern, fact] of [
    [/WXML 32400/, "WXML 32400"],
    [/WXSS 2\/3398/, "WXSS 2/3398"],
    [/preview 11626 bytes/, "preview 11626 bytes"],
    [/未调用 `upload`/, "no upload"],
    [/证据状态保持 \*\*In review\*\*。$/, "In review status"],
  ]) {
    match("微信证据", pattern, fact);
  }
  assert.doesNotMatch(
    summary.微信证据,
    /\bAccepted\b|已调用 `upload`|已发布体验版/i,
    "微信证据 must not claim Accepted, upload, or release",
  );

  match("WSL2 验证", /^WSL2 实机验证已完成：/, "completed WSL2 validation");
  match("WSL2 验证", /PostGIS 查询成功/, "PostGIS success");
  match("WSL2 验证", /Redis 返回 `PONG`/, "Redis PONG");
  match("WSL2 验证", /API live\/ready 返回 HTTP 200/, "API live/ready HTTP 200");
  match(
    "WSL2 验证",
    /API 与 Worker 均为非 root 且只读根文件系统/,
    "non-root read-only API and Worker",
  );
  match(
    "WSL2 验证",
    /Worker 观察超过 10 分钟后 `RestartCount=0`，无重连循环。$/,
    "10-minute stable Worker observation",
  );

  match(
    "漏洞策略",
    /^依赖审计仍报告 29 项：2 Critical、11 High、14 Moderate、2 Low。/,
    "all dependency audit counts",
  );
  match("漏洞策略", /`dev` 阶段漏洞只报告、不阻断功能开发/, "dev report-only policy");
  match("漏洞策略", /`release\/main` 继续阻断 Critical\/High/, "protected branch blocking");
  match("漏洞策略", /正式批准的风险例外。$/, "approved risk exception requirement");

  match("延期范围", /^Taro、支付宝、抖音和多语言均已搁置/, "all deferred targets");
  match("延期范围", /不属于当前开发与上线门禁/, "current gate exclusion");
  match(
    "延期范围",
    /本计划仅记录工作区重整的完成状态，不代表酒店产品功能完成/,
    "workspace-only completion scope",
  );
  match("延期范围", /酒店产品功能仍属后续开发。$/, "future hotel product development");
  assert.doesNotMatch(
    summary.延期范围,
    /酒店产品功能(?:已经|已)完成|当前开发与上线门禁包含(?:Taro|支付宝|抖音|多语言)/,
    "延期范围 must not reverse the product or gate boundary",
  );
}

function assertDependencyAuditEvidenceConsistent(evidenceIndex, dependencyAudit) {
  const summaries = [
    ...dependencyAudit.matchAll(
      /^Current audit summary: (\d+) CRITICAL, (\d+) HIGH, (\d+) MODERATE, (\d+) LOW$/gm,
    ),
  ];
  const productionSummaries = [
    ...dependencyAudit.matchAll(
      /^Current production audit summary: (\d+) CRITICAL, (\d+) HIGH, (\d+) MODERATE, (\d+) LOW$/gm,
    ),
  ];
  const conclusions = [
    ...dependencyAudit.matchAll(/^Current release conclusion: (Blocked|In review|Accepted)$/gm),
  ];
  if (summaries.length !== 1 || productionSummaries.length !== 1 || conclusions.length !== 1) {
    throw new Error("dependency audit must contain one unique current summary and conclusion");
  }

  const fullCounts = summaries[0].slice(1).map(Number);
  const productionCounts = productionSummaries[0].slice(1).map(Number);
  const [critical, high] = fullCounts;
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
  const itemSummary =
    /^Dependency audit: full (\d+) critical, (\d+) high, (\d+) moderate, (\d+) low; production (\d+) critical, (\d+) high, (\d+) moderate, (\d+) low$/i.exec(
      item,
    );
  if (
    !itemSummary ||
    !itemSummary
      .slice(1, 5)
      .map(Number)
      .every((count, index) => count === fullCounts[index]) ||
    !itemSummary
      .slice(5, 9)
      .map(Number)
      .every((count, index) => count === productionCounts[index])
  ) {
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

function completedTaskFixture(eol = "\n") {
  return Array.from(
    { length: 9 },
    (_, index) => `### Task ${index + 1}：fixture${eol}${eol}- [x] completed`,
  ).join(`${eol}${eol}`);
}

test("completed task parser ignores fenced checkboxes and pseudo tasks", () => {
  const markdown = [
    completedTaskFixture(),
    "```markdown",
    "### Task 1：pseudo duplicate",
    "- [ ] pseudo incomplete",
    "- [x] pseudo complete",
    "````",
    "````text",
    "```",
    "### Task 2：pseudo after a too-short closer",
    "- [ ] still fenced",
    "````",
    "~~~",
    "```",
    "### Task 9：another pseudo duplicate",
    "- [ ] another pseudo incomplete",
    "~~~~",
  ].join("\n");

  assert.equal(
    stripFencedCodeBlocks(markdown).split("\n").length,
    markdown.split("\n").length,
    "fence stripping must preserve line structure",
  );
  assert.doesNotThrow(() => validateCompletedPlanTasks(markdown));
});

test("completed task parser rejects duplicate real tasks and fenced-only completion", () => {
  assert.throws(
    () =>
      validateCompletedPlanTasks(`${completedTaskFixture()}\n### Task 9：duplicate\n- [x] done`),
    /exactly once|duplicate/i,
  );

  const fencedOnly = completedTaskFixture().replace(
    "### Task 1：fixture\n\n- [x] completed",
    "### Task 1：fixture\n\n```\n- [x] pseudo complete\n```",
  );
  assert.throws(() => validateCompletedPlanTasks(fencedOnly), /Task 1.*completed checklist/i);
});

test("completed task parser supports CRLF and the final task section", () => {
  const markdown = completedTaskFixture("\r\n");
  assert.doesNotThrow(() => validateCompletedPlanTasks(markdown));
});

test("completion summary parser accepts wrapped labeled bullets and CRLF", () => {
  const summary = [
    "- **实施基线：** first line",
    "  wrapped continuation",
    "- **微信证据：** evidence",
    "- **WSL2 验证：** runtime",
    "- **漏洞策略：** policy",
    "- **延期范围：** deferred",
  ].join("\r\n");

  assert.deepEqual(parseLabeledCompletionSummary(summary), {
    实施基线: "first line wrapped continuation",
    微信证据: "evidence",
    "WSL2 验证": "runtime",
    漏洞策略: "policy",
    延期范围: "deferred",
  });
});

test("completion summary parser rejects prose, unknown, extra, and duplicate labels", () => {
  const canonical = [
    "- **实施基线：** baseline",
    "- **微信证据：** evidence",
    "- **WSL2 验证：** runtime",
    "- **漏洞策略：** policy",
    "- **延期范围：** deferred",
  ];
  const invalidSummaries = [
    ["unlabeled preface", ...canonical],
    [canonical[0], "unlabeled body", ...canonical.slice(1)],
    [...canonical, "- **未知标签：** unexpected"],
    [...canonical.slice(0, 4), "- **实施基线：** duplicate"],
  ];

  for (const lines of invalidSummaries) {
    assert.throws(
      () => parseLabeledCompletionSummary(lines.join("\n")),
      /non-bullet|unknown|exactly five|duplicate|labels/i,
    );
  }
});

test("completion evidence must remain bound to its labeled section", async () => {
  const markdown = await readFile(path.join(root, wxFirstPlanPath), "utf8");
  const completionSummary = markdown.match(
    /^##\s+完成摘要\s*$([\s\S]*?)(?=^##\s+|(?![\s\S]))/m,
  )?.[1];
  assert.ok(completionSummary, "fixture plan must include a completion summary");

  const summary = parseLabeledCompletionSummary(completionSummary);
  const input = "deb274c58f64b6259e89d19a582200182126d770";
  const misplacedInput = {
    ...summary,
    实施基线: summary.实施基线.replace("旧工作树", `${input}。旧工作树`),
    微信证据: summary.微信证据.replace(input, ""),
  };

  assert.throws(
    () => assertCompletionSummaryFacts(misplacedInput),
    /微信证据.*input/i,
    "moving WeChat input evidence to another label must fail",
  );
});

test("WeChat-first workspace plan records the completed implementation baseline", async () => {
  const markdown = await readFile(path.join(root, wxFirstPlanPath), "utf8");
  const topMatter = markdown.split(/^##\s+/m, 1)[0];

  assert.match(topMatter, /^(?:Status|状态)\s*:\s*已完成\s*$/m, "plan status must be 已完成");
  assert.match(
    topMatter,
    /^完成日期\s*:\s*2026-07-28\s*$/m,
    "plan completion date must be 2026-07-28",
  );
  validateCompletedPlanTasks(markdown);

  const completionSummary = markdown.match(
    /^##\s+完成摘要\s*$([\s\S]*?)(?=^##\s+|(?![\s\S]))/m,
  )?.[1];
  assert.ok(completionSummary, "plan must include a 完成摘要 section");

  const summary = parseLabeledCompletionSummary(completionSummary);
  assertCompletionSummaryFacts(summary);
});

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

test("launch evidence records WSL2 Docker validation without unblocking unarchived evidence", async () => {
  const markdown = await readFile(
    path.join(root, "docs/compliance/launch-evidence-index.md"),
    "utf8",
  );
  const dockerRows = markdown
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|") && line.includes("Docker"));

  assert.equal(dockerRows.length, 2, "launch evidence must retain both Docker gates");
  for (const row of dockerRows) {
    assert.match(row, /WSL2 Docker.*运行时验证.*完成/);
    assert.match(row, /受控证据.*(?:尚未归档|尚未审批)/);
    assert.match(row, /\|\s*Blocked\s*\|?\s*$/);
    assert.doesNotMatch(row, /没有本地 Docker 引擎/);
    assert.doesNotMatch(row, /\|\s*Accepted\s*\|?\s*$/);
  }
});

test("launch evidence records current native WeChat validation without claiming acceptance", async () => {
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
    "../verification/2026-07-29-slice-1-identity-search.md",
  ]) {
    assert.ok(row.includes(evidencePath), `WeChat evidence must reference ${evidencePath}`);
  }
  assert.doesNotMatch(
    row,
    /apps\/consumer-miniapp/,
    "current WeChat evidence must not point to the frozen Taro reference",
  );
  assert.match(row, /2026-07-29.*Slice 1.*官方编译.*自动化.*预览.*完成/i);
  assert.match(
    row,
    /\|\s*In review\s*\|?\s*$/,
    "current WeChat evidence must await controlled archival and independent review",
  );
  assert.doesNotMatch(row, /deb274c58f64b6259e89d19a582200182126d770/);
  assert.doesNotMatch(row, /021ed57a0b3b1e876123befad4f375446621fb42/);
  assert.doesNotMatch(row, /WXML 32400|WXSS 2|3398|11626 bytes/);
  assert.doesNotMatch(row, /\|\s*Accepted\s*\|?\s*$/);
});

test("historical WeChat input and tree remain bound to their immutable Git objects", async () => {
  const [verification, launchIndex] = await Promise.all([
    readFile(path.join(root, "docs/operations/phase-0-verification.md"), "utf8"),
    readFile(path.join(root, "docs/compliance/launch-evidence-index.md"), "utf8"),
  ]);
  const phaseHistory = verification.match(
    /^## 2026-07-28 历史微信官方工具证据\r?\n[\s\S]*?(?=^## |(?![\s\S]))/m,
  )?.[0];
  const launchHistory = launchIndex.match(
    /^## 历史与延期的非当前门禁项目\r?\n[\s\S]*?(?=^## |(?![\s\S]))/m,
  )?.[0];
  assert.ok(phaseHistory, "Phase 0 verification must retain historical native WeChat evidence");
  assert.ok(launchHistory, "launch index must retain historical native WeChat evidence");
  const phaseEvidence = extractWeChatEvidence(phaseHistory, "historical Phase 0 verification");
  const launchEvidence = extractWeChatEvidence(launchHistory, "historical launch evidence index");

  assert.deepEqual(
    launchEvidence,
    phaseEvidence,
    "both evidence documents must record the same validation input and wx tree",
  );

  const inputTree = git("rev-parse", `${phaseEvidence.input}:wx`);
  assert.equal(
    phaseEvidence.tree,
    inputTree,
    "recorded wx tree must equal the tree Git resolves from the validation input",
  );
  assert.match(phaseHistory, /historical|历史/i);
  assert.match(phaseHistory, /superseded|不代表当前|不可作为当前/i);
  assert.match(launchHistory, /Historical|历史/i);
  assert.match(launchHistory, /Superseded|不代表当前|不可作为当前/i);
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
  for (const platform of ["微信（WeChat）", "支付宝（Alipay）", "抖音（Douyin）"]) {
    const row = historicalSection
      .split(/\r?\n/)
      .find((line) => line.startsWith("|") && line.includes(platform));
    assert.ok(row, `historical evidence must retain ${platform}`);
    assert.match(row, platform.startsWith("微信") ? /Historical.*Superseded/ : /Deferred/);
    assert.match(row, /不属于当前.*上线门禁/);
    assert.doesNotMatch(row, /\|\s*Blocked\s*\|?\s*$/);
  }
});

test("Phase 0 verification separates current Slice 1 WeChat evidence from historical evidence", async () => {
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
  assert.match(currentSection, /official validation passed for Slice 1/i);
  assert.match(currentSection, /2026-07-29[\s\S]*WXML\/WXSS.*编译/s);
  assert.match(currentSection, /核心搜索上下文自动化.*官方预览/s);
  assert.match(currentSection, /公众平台隐私保护指引[\s\S]*\*\*Blocked\*\*/s);
  assert.match(currentSection, /不替代.*生产发布审核/s);
  assert.doesNotMatch(
    currentSection,
    /deb274c58f64b6259e89d19a582200182126d770|021ed57a0b3b1e876123befad4f375446621fb42/,
  );
  assert.doesNotMatch(currentSection, /WXML 32400|WXSS 2|3398|11626 bytes/);
  assert.doesNotMatch(currentSection, /证据状态为 \*\*Accepted\*\*/);

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
    [...audit.matchAll(/^Current audit summary: \d+ CRITICAL, \d+ HIGH, \d+ MODERATE, \d+ LOW$/gm)]
      .length,
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
    "Current audit summary: 0 CRITICAL, 0 HIGH, 0 MODERATE, 0 LOW",
    "Current production audit summary: 0 CRITICAL, 0 HIGH, 0 MODERATE, 0 LOW",
    "Current release conclusion: In review",
  ].join("\n");
  const currentEvidence = [
    "| Evidence item | Repository evidence | External evidence location | Status |",
    "| --- | --- | --- | --- |",
    "| Dependency audit: full 0 critical, 0 high, 0 moderate, 0 low; production 0 critical, 0 high, 0 moderate, 0 low | audit | evidence | In review |",
  ].join("\n");

  assert.doesNotThrow(() =>
    assertDependencyAuditEvidenceConsistent(currentEvidence, historicalOnly),
  );
});

test("dependency audit remediation assigns each remaining high advisory to its planned batch", async () => {
  const audit = await readFile(path.join(root, "docs/operations/dependency-audit.md"), "utf8");

  for (const [advisory, batch] of [
    ["GHSA-c96f-x56v-gq3h", "Batch 2"],
    ["GHSA-mh99-v99m-4gvg", "Batch 3"],
    ["GHSA-pm4m-ph32-ghv5", "Batch 4"],
  ]) {
    const row = audit
      .split(/\r?\n/)
      .find((line) => line.startsWith("|") && line.includes(advisory));
    assert.ok(row, `dependency audit must retain the current ${advisory} row`);
    assert.ok(row.includes(batch), `${advisory} must be assigned to ${batch}`);
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

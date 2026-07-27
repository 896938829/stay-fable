import { spawn } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

function pnpmCommand(label, ...arguments_) {
  if (process.platform === "win32") {
    return {
      label,
      executable: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
      arguments: ["/d", "/s", "/c", ["pnpm", ...arguments_].join(" ")],
    };
  }

  return { label, executable: "pnpm", arguments: arguments_ };
}

export const automatedRepositoryCommands = Object.freeze([
  {
    label: "Workspace contract",
    executable: process.execPath,
    arguments: ["scripts/verify-workspace.mjs"],
  },
  {
    label: "Workspace contract tests",
    executable: process.execPath,
    arguments: ["--test", "scripts/verify-workspace.test.mjs"],
  },
  {
    label: "Local infrastructure static contracts",
    executable: process.execPath,
    arguments: ["--test", "scripts/check-local-infrastructure.test.mjs"],
  },
  {
    label: "Container static contracts",
    executable: process.execPath,
    arguments: ["--test", "scripts/check-container-contracts.test.mjs"],
  },
  {
    label: "CI static contracts",
    executable: process.execPath,
    arguments: ["--test", "scripts/check-ci-contracts.test.mjs"],
  },
  {
    label: "Phase 0 document contracts",
    executable: process.execPath,
    arguments: ["--test", "scripts/check-phase-0-documents.test.mjs"],
  },
  pnpmCommand("Formatting", "format:check"),
  pnpmCommand("Lint", "lint"),
  pnpmCommand("Typecheck", "typecheck"),
  pnpmCommand("Tests", "test"),
  pnpmCommand("Build", "build"),
  pnpmCommand("Dependency audit", "audit", "--audit-level", "high"),
]);

export const externalRuntimeChecks = Object.freeze([
  {
    name: "Docker Compose PostgreSQL/PostGIS and Redis readiness",
    status: "Blocked",
    detail: "Requires an available Docker engine and live service probes.",
  },
  {
    name: "API and worker image build/run as non-root",
    status: "Blocked",
    detail: "Requires Docker image build, inspect, and runtime evidence.",
  },
  {
    name: "GitHub Actions, Gitleaks, and Trivy",
    status: "Blocked",
    detail: "Requires a hosted run tied to an immutable commit.",
  },
  {
    name: "Official WeChat, Alipay, and Douyin GUI previews",
    status: "Blocked",
    detail: "Requires each vendor's official developer tools.",
  },
  {
    name: "Cloud resources, accounts, filing, and payment",
    status: "Blocked",
    detail: "Requires provisioned production-like resources and accountable approvals.",
  },
  {
    name: "Legal, privacy, and penetration review",
    status: "Blocked",
    detail: "Requires qualified reviewers and retained external evidence.",
  },
]);

function formatCommand(command) {
  return [command.executable, ...command.arguments].join(" ");
}

export function runCommand(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.arguments, {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      stdio: "inherit",
      windowsHide: true,
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command.label} terminated by signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

export async function runPhaseZeroVerification({ run = runCommand, log = console.log } = {}) {
  log("=== Automated repository checks ===");
  log("=== External runtime checks (not executed by this verifier) ===");
  for (const gate of externalRuntimeChecks) {
    log(`${gate.status}: ${gate.name} — ${gate.detail}`);
  }
  log("=== Running automated repository checks ===");

  for (const command of automatedRepositoryCommands) {
    log(`RUN ${command.label}: ${formatCommand(command)}`);
    const exitCode = await run(command);
    if (exitCode !== 0) {
      throw new Error(`${command.label} failed with exit code ${exitCode}`);
    }
  }
}

const isCli =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isCli) {
  try {
    await runPhaseZeroVerification();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

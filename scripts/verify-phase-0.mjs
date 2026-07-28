import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export function resolveCorepackLauncher(
  nodeExecutable,
  platform = process.platform,
  exists = existsSync,
) {
  const path = platform === "win32" ? win32 : posix;
  const launcher = path.join(
    path.dirname(nodeExecutable),
    platform === "win32" ? "corepack.cmd" : "corepack",
  );
  if (!exists(launcher)) {
    throw new Error(`Corepack launcher not found next to Node executable: ${launcher}`);
  }
  return {
    kind: platform === "win32" ? "windows-cmd" : "executable",
    path: launcher,
  };
}

const corepackLauncher = resolveCorepackLauncher(process.execPath);

function windowsCorepackCommand(launcher, arguments_) {
  if (/["&|<>^%\r\n]/.test(launcher)) {
    throw new Error("Corepack launcher path contains unsupported command characters");
  }
  for (const argument of arguments_) {
    if (!/^[A-Za-z0-9@._:/\\=-]+$/.test(argument)) {
      throw new Error(`Corepack argument contains unsupported command characters: ${argument}`);
    }
  }
  return `call "${launcher}" ${arguments_.join(" ")}`;
}

function pnpmCommand(label, ...arguments_) {
  const corepackArguments = ["pnpm", ...arguments_];
  if (corepackLauncher.kind === "windows-cmd") {
    return {
      label,
      executable: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
      arguments: [
        "/d",
        "/s",
        "/c",
        windowsCorepackCommand(corepackLauncher.path, corepackArguments),
      ],
      windowsVerbatimArguments: true,
    };
  }
  return {
    label,
    executable: corepackLauncher.path,
    arguments: corepackArguments,
  };
}

export const automatedRepositoryCommands = Object.freeze([
  {
    ...pnpmCommand("Corepack pnpm version", "--version"),
    expectedOutput: "11.17.0",
  },
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
  pnpmCommand(
    "Build Alipay mini-program",
    "--filter",
    "@stay-fable/consumer-miniapp",
    "build:alipay",
  ),
  pnpmCommand("Build Douyin mini-program", "--filter", "@stay-fable/consumer-miniapp", "build:tt"),
  {
    label: "Built API runtime smoke",
    executable: process.execPath,
    arguments: ["scripts/smoke-api-runtime.mjs"],
  },
  {
    label: "Built frontend artifact smoke",
    executable: process.execPath,
    arguments: ["scripts/smoke-frontend-artifacts.mjs"],
  },
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

export function validateExpectedOutput(command, actualOutput) {
  if (command.expectedOutput !== undefined && actualOutput.trim() !== command.expectedOutput) {
    throw new Error(
      `${command.label} expected ${command.expectedOutput}, received ${actualOutput.trim() || "<empty>"}`,
    );
  }
}

export function runCommand(command) {
  return new Promise((resolve, reject) => {
    const capturedOutput = [];
    const capturesOutput = command.expectedOutput !== undefined;
    const child = spawn(command.executable, command.arguments, {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      stdio: capturesOutput ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true,
      windowsVerbatimArguments: command.windowsVerbatimArguments ?? false,
    });

    child.once("error", reject);
    child.stdout?.on("data", (chunk) => {
      capturedOutput.push(chunk);
      process.stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      process.stderr.write(chunk);
    });
    child.once("close", (code, signal) => {
      if (signal) {
        reject(new Error(`${command.label} terminated by signal ${signal}`));
        return;
      }
      if (code === 0 && capturesOutput) {
        const actualOutput = Buffer.concat(capturedOutput).toString("utf8").trim();
        try {
          validateExpectedOutput(command, actualOutput);
        } catch (error) {
          reject(error);
          return;
        }
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
  process.argv[1] !== undefined &&
  pathToFileURL(
    process.platform === "win32" ? win32.resolve(process.argv[1]) : posix.resolve(process.argv[1]),
  ).href === import.meta.url;

if (isCli) {
  try {
    await runPhaseZeroVerification();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

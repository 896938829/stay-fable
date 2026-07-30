import { lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspaceRootPath = fileURLToPath(new URL("../", import.meta.url));

export function assertApiDistTarget(workspaceRoot, target) {
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedTarget = path.resolve(target);
  const expectedTarget = path.join(resolvedRoot, "apps", "api-server", "dist");

  if (resolvedTarget === resolvedRoot || resolvedTarget !== expectedTarget) {
    throw new Error("Cleanup target is not the fixed API dist directory");
  }
}

export async function cleanApiDist() {
  const resolvedRoot = await realpath(workspaceRootPath);
  const resolvedApiRoot = await realpath(path.join(resolvedRoot, "apps", "api-server"));
  const resolvedTarget = path.join(resolvedApiRoot, "dist");

  assertApiDistTarget(resolvedRoot, resolvedTarget);

  const targetStats = await lstat(resolvedTarget).catch((error) => {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (targetStats?.isSymbolicLink()) {
    throw new Error("Cleanup target must not be a symbolic link");
  }
  if (targetStats) {
    const canonicalTarget = await realpath(resolvedTarget);
    assertApiDistTarget(resolvedRoot, canonicalTarget);
  }

  await rm(resolvedTarget, { recursive: true, force: true });
}

const isCommandLine =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isCommandLine) {
  if (process.argv.length !== 2) {
    console.error("clean-api-dist does not accept arguments");
    process.exitCode = 1;
  } else {
    cleanApiDist().catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}

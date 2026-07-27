import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const rootUrl = new URL("../", import.meta.url);
const dockerfileUrls = [
  new URL("apps/api/Dockerfile", rootUrl),
  new URL("apps/worker/Dockerfile", rootUrl),
];
const nodeImage =
  "node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c";

test("pins non-root multi-stage Node 24 container images", async () => {
  for (const dockerfileUrl of dockerfileUrls) {
    const dockerfile = await readFile(dockerfileUrl, "utf8");
    const fromLines = dockerfile.match(/^FROM\s+.+$/gm) ?? [];

    assert.deepEqual(fromLines, [`FROM ${nodeImage} AS build`, `FROM ${nodeImage} AS runtime`]);
    assert.doesNotMatch(dockerfile, /^FROM\s+\S+:latest(?:\s|$)/m);
    assert.match(dockerfile, /^USER node$/m);
  }
});

test("uses reproducible production dependency installation", async () => {
  for (const dockerfileUrl of dockerfileUrls) {
    const dockerfile = await readFile(dockerfileUrl, "utf8");
    const dependencyCopyIndex = dockerfile.indexOf(
      "COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./",
    );
    const fetchIndex = dockerfile.indexOf("pnpm fetch --frozen-lockfile");
    const sourceCopyIndex = dockerfile.indexOf("COPY . .");
    const offlineInstallIndex = dockerfile.indexOf("pnpm install --offline --frozen-lockfile");

    assert.match(dockerfile, /corepack prepare pnpm@11\.17\.0 --activate/);
    assert.ok(dependencyCopyIndex >= 0, "dependency metadata must be copied before fetching");
    assert.ok(fetchIndex > dependencyCopyIndex, "pnpm fetch must follow dependency metadata");
    assert.ok(sourceCopyIndex > fetchIndex, "source code must be copied after pnpm fetch");
    assert.ok(offlineInstallIndex > sourceCopyIndex, "offline install must follow the source copy");
    assert.match(dockerfile, /--mount=type=cache,id=pnpm-store/);
    assert.match(dockerfile, /pnpm deploy --filter .+ --prod \/out/);
  }
});

test("defines the API and worker runtime contracts", async () => {
  const apiDockerfile = await readFile(dockerfileUrls[0], "utf8");
  const workerDockerfile = await readFile(dockerfileUrls[1], "utf8");

  assert.match(apiDockerfile, /^ENV NODE_ENV=production$/m);
  assert.match(apiDockerfile, /^EXPOSE 3000$/m);
  assert.match(apiDockerfile, /^CMD \["node", "dist\/main\.js"\]$/m);
  assert.match(workerDockerfile, /^ENV NODE_ENV=production$/m);
  assert.doesNotMatch(workerDockerfile, /^EXPOSE\s+/m);
  assert.match(workerDockerfile, /^CMD \["node", "dist\/main\.js"\]$/m);
});

test("keeps secrets and generated artifacts out of the build context", async () => {
  const dockerignore = await readFile(new URL(".dockerignore", rootUrl), "utf8");

  for (const pattern of [
    ".git",
    ".github",
    "**/node_modules",
    "**/dist",
    "**/coverage",
    ".env",
    ".env.*",
    "!.env.example",
    "docs",
  ]) {
    assert.match(dockerignore, new RegExp(`^${pattern.replaceAll("*", "\\*")}$`, "m"));
  }
});

test("documents isolated environments and CloudBase Run service boundaries", async () => {
  const environmentMatrix = await readFile(
    new URL("infrastructure/cloud/environment-matrix.md", rootUrl),
    "utf8",
  );
  const cloudbaseRun = await readFile(
    new URL("infrastructure/cloud/cloudbase-run.md", rootUrl),
    "utf8",
  );

  assert.match(environmentMatrix, /dev.*staging.*prod/is);
  assert.match(environmentMatrix, /不得共享|不共享/);
  for (const resource of ["PostgreSQL", "PostGIS", "Redis", "对象存储", "密钥"]) {
    assert.match(environmentMatrix, new RegExp(resource, "i"));
  }

  assert.match(cloudbaseRun, /API.*公网/is);
  assert.match(cloudbaseRun, /worker.*无公网/is);
  assert.match(cloudbaseRun, /\/health\/live/);
  assert.match(cloudbaseRun, /\/health\/ready/);
  for (const secret of [
    "DATABASE_URL",
    "REDIS_URL",
    "JWT_SECRET",
    "WECHAT_APP_ID",
    "WECHAT_APP_SECRET",
    "COS_SECRET_ID",
    "COS_SECRET_KEY",
    "COS_BUCKET",
    "COS_REGION",
  ]) {
    assert.match(cloudbaseRun, new RegExp(`\\b${secret}\\b`));
  }
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { assertHealthyServices, parseComposePs } from "./local-infrastructure-status.mjs";

const rootUrl = new URL("../", import.meta.url);

test("pins the local PostgreSQL/PostGIS and Redis service contract", async () => {
  const compose = await readFile(new URL("infrastructure/compose.yaml", rootUrl), "utf8");

  assert.match(compose, /^\s+image:\s+postgis\/postgis:17-3\.5$/m);
  assert.match(compose, /^\s+image:\s+redis:7\.4-alpine$/m);
  assert.match(compose, /^\s+- "127\.0\.0\.1:\$\{POSTGRES_PORT:-5432\}:5432"$/m);
  assert.match(compose, /^\s+- "127\.0\.0\.1:\$\{REDIS_PORT:-6379\}:6379"$/m);
  assert.match(
    compose,
    /^\s+test:\s+\["CMD-SHELL",\s*"pg_isready -U stay_fable -d stay_fable"\]$/m,
  );
  assert.match(compose, /^\s+test:\s+\["CMD",\s*"redis-cli",\s*"ping"\]$/m);
});

test("documents a bounded first-start health wait", async () => {
  const guide = await readFile(new URL("docs/operations/local-development.md", rootUrl), "utf8");

  assert.match(
    guide,
    /docker compose -f infrastructure\/compose\.yaml up -d --wait --wait-timeout 120/,
  );
  assert.match(guide, /\$env:POSTGRES_PORT\s*=\s*"55432"/);
  assert.match(guide, /\$env:REDIS_PORT\s*=\s*"56379"/);
});

test("documents the required WSL2 runtime verification", async () => {
  const guide = await readFile(
    new URL("docs/operations/wsl-runtime-validation.md", rootUrl),
    "utf8",
  );

  assert.match(guide, /wsl\.exe -l -v[\s\S]*Ubuntu-22\.04[\s\S]*WSL\s*2/i);
  assert.match(
    guide,
    /POSTGRES_PORT=55432 REDIS_PORT=56379 docker compose --project-name stay-fable-wsl-validation -f infrastructure\/compose\.yaml up -d --wait --wait-timeout 120/,
  );
  const composeCommands =
    guide.match(/^(?:POSTGRES_PORT=55432 REDIS_PORT=56379 )?docker compose [^\r\n]+$/gm) ?? [];
  assert.ok(composeCommands.length >= 5, "expected executable Compose verification commands");
  for (const command of composeCommands) {
    assert.match(command, /--project-name stay-fable-wsl-validation/);
  }
  assert.doesNotMatch(guide, /stay-fable-local_default/);
  assert.match(guide, /SELECT PostGIS_Lib_Version\(\);[\s\S]*redis-cli ping/i);
  assert.match(guide, /postgis_lib_version[\s\S]*\d+\.\d+[\s\S]*PONG/i);
  const runCommands =
    guide.match(/^docker run -d --name [^\r\n]+[\s\S]*?^  node:24[^\s]* node dist\/main\.js$/gm) ??
    [];

  for (const containerName of [
    "stay-fable-wsl-validation-api",
    "stay-fable-wsl-validation-worker",
  ]) {
    const runCommand = runCommands.find((command) => command.includes(`--name ${containerName}`));

    assert.ok(runCommand, `missing docker run command for ${containerName}`);
    assert.match(runCommand, /--user node/);
    assert.match(runCommand, /--read-only/);
    assert.match(runCommand, /--tmpfs \/tmp/);
    assert.match(runCommand, /--network stay-fable-wsl-validation_default/);
  }
  assert.match(
    guide,
    /for attempt in \$\(seq 1 30\); do[\s\S]*curl --fail[\s\S]*health\/ready[\s\S]*sleep 2[\s\S]*done[\s\S]*if \[ "\$api_ready" != true \]; then[\s\S]*docker logs stay-fable-wsl-validation-api[\s\S]*docker logs stay-fable-wsl-validation-worker[\s\S]*exit 1[\s\S]*fi/,
  );
  assert.match(guide, /health\/live[\s\S]*HTTP 200[\s\S]*health\/ready[\s\S]*HTTP 200/i);
  assert.match(
    guide,
    /docker inspect[\s\S]*Config\.User[\s\S]*HostConfig\.ReadonlyRootfs[\s\S]*user=node[\s\S]*ReadonlyRootfs=true/i,
  );
  assert.match(
    guide,
    /10 分钟[\s\S]*RestartCount=0[\s\S]*(无|没有).*(重连循环|reconnect loop).*错误/is,
  );
  assert.match(
    guide,
    /for minute in \$\(seq 1 10\); do[\s\S]*if \[ "\$restart_count" -ne 0 \]; then[\s\S]*docker logs stay-fable-wsl-validation-worker[\s\S]*exit 1[\s\S]*fi[\s\S]*sleep 60[\s\S]*done/,
  );
  assert.match(
    guide,
    /final_restart_count=.*RestartCount[\s\S]*if \[ "\$final_restart_count" -ne 0 \]; then[\s\S]*docker logs stay-fable-wsl-validation-worker[\s\S]*exit 1[\s\S]*fi[\s\S]*final_worker_logs=.*docker logs --since 10m[\s\S]*if printf[\s\S]*grep -Eiq '\(reconnect\|error\)'[\s\S]*exit 1[\s\S]*fi/,
  );
  assert.match(guide, /不得(停止|删除).*无关容器/s);
  assert.deepEqual(guide.match(/^docker (?:rm|stop|kill)[^\r\n]+/gm), [
    "docker rm -f stay-fable-wsl-validation-api stay-fable-wsl-validation-worker",
  ]);
  assert.match(
    guide,
    /^POSTGRES_PORT=55432 REDIS_PORT=56379 docker compose --project-name stay-fable-wsl-validation -f infrastructure\/compose\.yaml down$/m,
  );
  assert.doesNotMatch(guide, /docker compose[^\r\n]*(down|rm)[^\r\n]*--volumes/);
  assert.doesNotMatch(guide, /test -d \.git/);
  assert.match(
    guide,
    /repo_root="\$\(git rev-parse --show-toplevel\)"[\s\S]*current_dir="\$\(pwd -P\)"[\s\S]*if \[ "\$current_dir" = "\$repo_root" \]; then[\s\S]*rm -rf -- "\$runtime_dir"[\s\S]*mkdir -p "\$runtime_dir"[\s\S]*else[\s\S]*exit 1[\s\S]*fi[\s\S]*pnpm deploy/,
  );
  assert.match(
    guide,
    /repo_root="\$\(git rev-parse --show-toplevel\)"[\s\S]*current_dir="\$\(pwd -P\)"[\s\S]*if \[ "\$current_dir" = "\$repo_root" \].*&&.*\[ "\$runtime_dir" = "\$repo_root\/\.wsl-runtime" \]; then[\s\S]*rm -rf -- "\$runtime_dir"[\s\S]*else[\s\S]*exit 1[\s\S]*fi[\s\S]*git status --short/,
  );
  assert.match(
    guide,
    /删除 `.wsl-runtime\/`[\s\S]*git status --short[\s\S]*(保留|不会删除).*Compose.*数据卷/s,
  );
});

test("parses Docker Compose JSON array output", () => {
  const services = parseComposePs(
    JSON.stringify([
      { Service: "postgres", Health: "healthy" },
      { Service: "redis", Health: "healthy" },
    ]),
  );

  assert.equal(services.length, 2);
  assert.equal(services[0].Service, "postgres");
  assert.equal(services[1].Service, "redis");
});

test("parses Docker Compose NDJSON output with Windows line endings", () => {
  const services = parseComposePs(
    '{"Service":"postgres","Health":"healthy"}\r\n' + '{"Service":"redis","Health":"healthy"}\r\n',
  );

  assert.equal(services.length, 2);
  assert.equal(services[0].Service, "postgres");
  assert.equal(services[1].Service, "redis");
});

test("reports a missing required service", () => {
  assert.throws(
    () => assertHealthyServices([{ Service: "postgres", Health: "healthy" }]),
    /redis.*missing/i,
  );
});

test("reports a service that is still starting", () => {
  assert.throws(
    () =>
      assertHealthyServices([
        { Service: "postgres", Health: "starting" },
        { Service: "redis", Health: "healthy" },
      ]),
    /postgres.*starting/i,
  );
});

test("reports an unhealthy service", () => {
  assert.throws(
    () =>
      assertHealthyServices([
        { Service: "postgres", Health: "healthy" },
        { Service: "redis", Health: "unhealthy" },
      ]),
    /redis.*unhealthy/i,
  );
});

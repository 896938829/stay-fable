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
  assert.doesNotMatch(guide, /^docker ps(?: -a)? --format [^\r\n]+\|\| true$/m);
  const inventoryBlock = guide.match(
    /if ! docker ps --format [^\r\n]+; then[\s\S]*exit 1[\s\S]*fi[\s\S]*if ! docker ps -a --format [^\r\n]+; then[\s\S]*exit 1[\s\S]*fi/,
  )?.[0];
  assert.ok(inventoryBlock, "missing mandatory pre-mutation Docker inventory");
  const windowsPhase = guide.match(/## Windows PowerShell 阶段[\s\S]*?## WSL 阶段/)?.[0];
  assert.ok(windowsPhase, "missing Windows artifact-build phase before the WSL lifecycle");
  const wslPhase = guide.match(/## WSL 阶段[\s\S]*/)?.[0];
  assert.ok(wslPhase, "missing WSL runtime phase");
  assert.match(windowsPhase, /\$ErrorActionPreference = 'Stop'/);
  assert.match(
    windowsPhase,
    /\$repoRoot = \(Resolve-Path -LiteralPath \(git rev-parse --show-toplevel\)\)\.Path/,
  );
  assert.match(
    windowsPhase,
    /\$currentPath = \(Resolve-Path -LiteralPath \(Get-Location\)\.ProviderPath\)\.Path/,
  );
  assert.match(
    windowsPhase,
    /\[StringComparer\]::OrdinalIgnoreCase\.Equals\(\$currentPath, \$repoRoot\)/,
  );
  assert.match(windowsPhase, /\$runtimeDir = Join-Path \$repoRoot '\.wsl-runtime'/);
  assert.match(windowsPhase, /\$validationToken = /);
  assert.match(
    windowsPhase,
    /\$runtimeOwnerMarker = Join-Path \$runtimeDir '\.stay-fable-validation-owner'/,
  );
  assert.match(
    windowsPhase,
    /if \(Test-Path -LiteralPath \$runtimeDir\) \{[\s\S]*throw '.*\.wsl-runtime.*拒绝.*'/,
  );
  const runtimeCollisionGuard = windowsPhase.match(
    /if \(Test-Path -LiteralPath \$runtimeDir\) \{[\s\S]*?throw '.*\.wsl-runtime.*拒绝.*'[\s\S]*?\}/,
  )?.[0];
  assert.ok(runtimeCollisionGuard, "missing .wsl-runtime collision guard");
  assert.doesNotMatch(runtimeCollisionGuard, /Remove-Item/);
  assert.match(
    windowsPhase,
    /New-Item -ItemType Directory -Path \$runtimeDir[\s\S]*Set-Content -LiteralPath \$runtimeOwnerMarker -Value \$validationToken/,
  );
  assert.match(
    windowsPhase,
    /\$runtimeOwned = \$false[\s\S]*try \{[\s\S]*wsl\.exe -d Ubuntu-22\.04 -- env "VALIDATION_TOKEN=\$validationToken" "LIFECYCLE_SCRIPT=\$lifecycleScript" bash/,
  );
  assert.match(
    windowsPhase,
    /New-Item -ItemType Directory -Path \$runtimeDir[\s\S]*\$runtimeOwned = \$true/,
  );
  assert.match(
    windowsPhase,
    /bash -c 'set -eu; script="\/tmp\/stay-fable-wsl-validation-\$\{VALIDATION_TOKEN\}\.sh"; marker="\$\{script\}\.owner"; \[ "\$1" = "\$script" \]; \[ -f "\$script" \]; \[ -f "\$marker" \]; \[ "\$\(cat -- "\$marker"\)" = "\$VALIDATION_TOKEN" \]' -- \$lifecycleScript/,
  );
  const prismaGenerateIndex = windowsPhase.indexOf(
    "corepack pnpm --filter @stay-fable/api-server prisma:generate",
  );
  const fullBuildIndex = windowsPhase.indexOf("corepack pnpm build");
  assert.ok(prismaGenerateIndex >= 0, "missing API Prisma generation");
  assert.ok(fullBuildIndex >= 0, "missing full production build");
  assert.ok(prismaGenerateIndex < fullBuildIndex, "Prisma generation must precede the full build");
  assert.match(
    windowsPhase,
    /corepack pnpm deploy --filter @stay-fable\/api-server --prod \(Join-Path \$runtimeDir 'api'\)/,
  );
  assert.match(
    windowsPhase,
    /corepack pnpm deploy --filter @stay-fable\/job-worker --prod \(Join-Path \$runtimeDir 'worker'\)/,
  );
  assert.match(windowsPhase, /wslpath -a/);
  assert.match(
    windowsPhase,
    /finally \{[\s\S]*if \(\$runtimeOwned\) \{[\s\S]*Get-Content -LiteralPath \$runtimeOwnerMarker[\s\S]*\[StringComparer\]::Ordinal\.Equals\(\$cleanupMarkerToken, \$validationToken\)[\s\S]*Remove-Item -LiteralPath \$runtimeDir -Recurse -Force/,
  );
  assert.equal(
    windowsPhase.match(/Remove-Item -LiteralPath \$runtimeDir -Recurse -Force/g)?.length,
    1,
  );
  assert.match(
    windowsPhase,
    /\$lifecycleScript = "\/tmp\/stay-fable-wsl-validation-\$validationToken\.sh"/,
  );
  assert.match(
    windowsPhase,
    /env "VALIDATION_TOKEN=\$validationToken"[\s\S]*bash \$lifecycleScript/,
  );
  assert.match(
    windowsPhase,
    /finally \{[\s\S]*wsl\.exe -d Ubuntu-22\.04 -- env "VALIDATION_TOKEN=\$validationToken" bash -c [^\r\n]*rm/,
  );
  assert.match(
    windowsPhase,
    /if \(\$runtimeOwned\) \{[\s\S]*try \{[\s\S]*Get-Content -LiteralPath \$runtimeOwnerMarker[\s\S]*Remove-Item -LiteralPath \$runtimeDir -Recurse -Force[\s\S]*\}\s*catch \{[\s\S]*\$cleanupFailed = \$true[\s\S]*\}[\s\S]*wsl\.exe/,
  );
  assert.doesNotMatch(windowsPhase, /\bcorepack enable\b/);
  assert.doesNotMatch(wslPhase, /\bcorepack\b|\bpnpm\b/);
  assert.match(
    guide,
    /\/tmp\/stay-fable-wsl-validation-\$validationToken\.sh[\s\S]*(禁止|不得|不要).*(管道|stdin|标准输入)[\s\S]*docker compose exec -T/is,
  );
  assert.doesNotMatch(guide, /`\/tmp\/stay-fable-wsl-validation\.sh`/);
  assert.match(
    guide,
    /以下内容是 `\$lifecycleScript`（`\/tmp\/stay-fable-wsl-validation-\$validationToken\.sh`）的完整内容/,
  );
  assert.doesNotMatch(guide, /\|\s*(?:bash|sh)\b/);
  assert.match(
    guide,
    /validation_root="\/tmp\/stay-fable-wsl-validation"[\s\S]*mkdir -- "\$validation_root"[\s\S]*mkdir -- "\$validation_root\/api" "\$validation_root\/worker"[\s\S]*cp -a -- "\$artifact_root\/api\/\." "\$validation_root\/api\/"[\s\S]*cp -a -- "\$artifact_root\/worker\/\." "\$validation_root\/worker\/"/,
  );
  const collisionGuard = guide.match(
    /for container_name in stay-fable-wsl-validation-api stay-fable-wsl-validation-worker; do[\s\S]*docker ps -a --filter "name=\^\/\$\{container_name\}\$"[\s\S]*if \[ -n "\$listed_names" \]; then[\s\S]*exit 1[\s\S]*fi[\s\S]*done/,
  )?.[0];
  assert.ok(collisionGuard, "missing pre-mutation exact-name collision guard");
  assert.ok(guide.indexOf(inventoryBlock) < guide.indexOf(collisionGuard));
  assert.ok(guide.indexOf(collisionGuard) < guide.indexOf("cleanup_validation()"));
  const composeOwnershipGuard = guide.match(
    /docker ps -a --filter "label=com\.docker\.compose\.project=stay-fable-wsl-validation"[\s\S]*if \[ -n "\$project_containers" \]; then[\s\S]*exit 1[\s\S]*docker network ls --filter "label=com\.docker\.compose\.project=stay-fable-wsl-validation"[\s\S]*if \[ -n "\$project_networks" \]; then[\s\S]*exit 1[\s\S]*fi/,
  )?.[0];
  assert.ok(composeOwnershipGuard, "missing Compose project ownership preflight");
  const tempRootGuard = guide.match(
    /if \[ -e "\$validation_root" \]; then[\s\S]*exit 1[\s\S]*fi/,
  )?.[0];
  assert.ok(tempRootGuard, "missing ext4 validation-root collision guard");
  assert.ok(guide.indexOf(composeOwnershipGuard) < guide.indexOf("cleanup_validation()"));
  assert.ok(guide.indexOf(tempRootGuard) < guide.indexOf("cleanup_validation()"));
  assert.match(
    guide,
    /validation_token=.*\$\$[\s\S]*ownership_marker="\$validation_root\/\.stay-fable-validation-owner"[\s\S]*mkdir -- "\$validation_root"[\s\S]*printf '%s\\n' "\$validation_token" > "\$ownership_marker"[\s\S]*validation_root_owned=true/,
  );
  assert.match(
    guide,
    /POSTGRES_PORT=55432 REDIS_PORT=56379 docker compose --project-name stay-fable-wsl-validation -f infrastructure\/compose\.yaml up -d --wait --wait-timeout 120/,
  );
  assert.match(
    guide,
    /compose_mutation_started=false[\s\S]*trap 'cleanup_validation \$\?' EXIT[\s\S]*compose_mutation_started=true\s+POSTGRES_PORT=55432 REDIS_PORT=56379 docker compose --project-name stay-fable-wsl-validation/,
  );
  const composeCommands =
    guide.match(
      /^\s*(?:if ! )?(?:POSTGRES_PORT=55432 REDIS_PORT=56379 )?docker compose [^\r\n]+$/gm,
    ) ?? [];
  assert.ok(composeCommands.length >= 5, "expected executable Compose verification commands");
  for (const command of composeCommands) {
    assert.match(command, /--project-name stay-fable-wsl-validation/);
  }
  assert.doesNotMatch(guide, /stay-fable-local_default/);
  assert.match(guide, /SELECT PostGIS_Lib_Version\(\);[\s\S]*redis-cli ping/i);
  assert.match(guide, /postgis_lib_version[\s\S]*\d+\.\d+[\s\S]*PONG/i);
  const runCommands =
    guide.match(
      /^docker run -d --name [^\r\n]+[\s\S]*?^ {2}node:24[^\s]* node dist\/main\.js$/gm,
    ) ?? [];

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
    assert.match(runCommand, /--label "stay-fable\.validation-token=\$validation_token"/);
    assert.match(runCommand, /-v "\$validation_root\/(?:api|worker):\/app:ro"/);
    assert.doesNotMatch(runCommand, /\.wsl-runtime|\/mnt\//);
  }
  assert.match(
    guide,
    /for runtime_name in api worker; do[\s\S]*"\$validation_root\/\$runtime_name\/dist\/main\.js"[\s\S]*"\$validation_root\/\$runtime_name\/package\.json"[\s\S]*-d "\$validation_root\/\$runtime_name\/node_modules"[\s\S]*exit 1[\s\S]*done[\s\S]*docker run/,
  );
  const curlCommands = guide.match(/^\s*(?:if )?curl --fail[^\r\n]+/gm) ?? [];
  assert.equal(curlCommands.length, 3);
  for (const command of curlCommands) {
    assert.match(command, /--connect-timeout 1/);
    assert.match(command, /--max-time 2/);
  }
  assert.match(
    guide,
    /20 次[\s\S]*每次.*2 秒[\s\S]*间隔 1 秒[\s\S]*最长 60 秒[\s\S]*for attempt in \$\(seq 1 20\); do[\s\S]*curl --fail[\s\S]*health\/ready[\s\S]*sleep 1[\s\S]*done[\s\S]*if \[ "\$api_ready" != true \]; then[\s\S]*docker logs stay-fable-wsl-validation-api[\s\S]*docker logs stay-fable-wsl-validation-worker[\s\S]*exit 1[\s\S]*fi/,
  );
  const diagnosticLogCommands = guide.match(/^\s+docker logs [^\r\n]+>&2[^\r\n]*$/gm) ?? [];
  assert.ok(diagnosticLogCommands.length >= 4);
  for (const command of diagnosticLogCommands) {
    assert.match(command, /\|\| true$/);
  }
  assert.match(guide, /health\/live[\s\S]*HTTP 200[\s\S]*health\/ready[\s\S]*HTTP 200/i);
  assert.match(
    guide,
    /docker inspect[\s\S]*Config\.User[\s\S]*HostConfig\.ReadonlyRootfs[\s\S]*user=node[\s\S]*ReadonlyRootfs=true/i,
  );
  assert.match(
    guide,
    /10 分钟[\s\S]*Running=true[\s\S]*RestartCount=0[\s\S]*(无|没有).*(致命|fatal).*(重连循环|reconnect loop)/is,
  );
  assert.match(
    guide,
    /for minute in \$\(seq 1 10\); do[\s\S]*worker_running=.*State\.Running[\s\S]*if \[ "\$worker_running" != true \] \|\| \[ "\$restart_count" -ne 0 \]; then[\s\S]*docker inspect[\s\S]*State\.Status[\s\S]*docker logs stay-fable-wsl-validation-worker[\s\S]*exit 1[\s\S]*fi[\s\S]*sleep 60[\s\S]*done/,
  );
  assert.match(
    guide,
    /final_worker_running=.*State\.Running[\s\S]*final_restart_count=.*RestartCount[\s\S]*if \[ "\$final_worker_running" != true \] \|\| \[ "\$final_restart_count" -ne 0 \]; then[\s\S]*docker inspect[\s\S]*State\.Status[\s\S]*docker logs stay-fable-wsl-validation-worker[\s\S]*exit 1[\s\S]*fi/,
  );
  const workerFailurePatternSource = guide.match(
    /^worker_failure_log_pattern='([^'\r\n]+)'$/m,
  )?.[1];
  assert.ok(workerFailurePatternSource, "missing shared Worker failure-log pattern");
  const workerFailurePattern = new RegExp(workerFailurePatternSource, "i");
  for (const failureLog of [
    '{"level":50,"msg":"Redis command failed"}',
    '{"level":60,"msg":"Worker cannot continue"}',
    '{"level":"error","msg":"Redis command failed"}',
    '{"level":"fatal","msg":"Worker cannot continue"}',
    "connect ECONNREFUSED 127.0.0.1:6379",
    "Redis reconnect loop detected",
    "uncaughtException: worker crashed",
    "unhandledRejection: promise rejected",
  ]) {
    assert.match(failureLog, workerFailurePattern);
  }
  for (const benignLog of [
    '{"level":30,"msg":"Worker started"}',
    '{"level":30,"errorCount":0,"msg":"error budget remains healthy"}',
  ]) {
    assert.doesNotMatch(benignLog, workerFailurePattern);
  }
  assert.equal(guide.match(/grep -Eiq "\$worker_failure_log_pattern"/g)?.length, 2);
  assert.doesNotMatch(guide, /grep -Eiq '\(reconnect\|error\)'/);
  assert.match(guide, /不得(停止|删除).*无关容器/s);
  assert.deepEqual(guide.match(/docker (?:rm|stop|kill)[^\r\n]+/g), [
    'docker rm -f "$container_name"; then',
  ]);
  assert.doesNotMatch(guide, /docker compose[^\r\n]*(down|rm)[^\r\n]*--volumes/);
  assert.doesNotMatch(guide, /test -d \.git/);
  assert.doesNotMatch(wslPhase, /git rev-parse --show-toplevel/);
  assert.match(
    guide,
    /删除 `.wsl-runtime\/`[\s\S]*git status --short[\s\S]*(保留|不会删除).*Compose.*数据卷/s,
  );
  const cleanupFunction = guide.match(/^cleanup_validation\(\) \{[\s\S]*?^\}$/m)?.[0];
  assert.ok(cleanupFunction, "missing validation cleanup function");
  assert.match(cleanupFunction, /if \[ "\$compose_mutation_started" = true \]; then/);
  assert.match(
    cleanupFunction,
    /docker ps -a --filter "label=com\.docker\.compose\.project=stay-fable-wsl-validation"[\s\S]*stay-fable-wsl-validation-(?:postgres|redis)-1[\s\S]*docker network ls --filter "label=com\.docker\.compose\.project=stay-fable-wsl-validation"[\s\S]*stay-fable-wsl-validation_default[\s\S]*docker compose --project-name stay-fable-wsl-validation[^\r\n]* down/,
  );
  assert.match(cleanupFunction, /trap - EXIT/);
  assert.match(
    cleanupFunction,
    /for container_name in stay-fable-wsl-validation-api stay-fable-wsl-validation-worker; do/,
  );
  const exactContainerQueries = cleanupFunction.match(
    /docker ps -a --filter "name=\^\/\$\{container_name\}\$" --format '\{\{\.Names\}\}'/g,
  );
  assert.equal(exactContainerQueries?.length, 2);
  assert.match(
    cleanupFunction,
    /if ! listed_names=.*docker ps -a[\s\S]*cleanup_failed=1[\s\S]*continue[\s\S]*if \[ -n "\$listed_names" \]; then[\s\S]*\[ "\$listed_names" != "\$container_name" \][\s\S]*docker inspect --format '\{\{ index \.Config\.Labels "stay-fable\.validation-token" \}\}'[\s\S]*\[ "\$container_token" != "\$validation_token" \][\s\S]*拒绝删除[\s\S]*docker rm -f "\$container_name"[\s\S]*cleanup_failed=1[\s\S]*fi[\s\S]*if ! listed_names=.*docker ps -a[\s\S]*cleanup_failed=1[\s\S]*elif \[ -n "\$listed_names" \]; then[\s\S]*cleanup_failed=1[\s\S]*fi[\s\S]*done/,
  );
  assert.doesNotMatch(cleanupFunction, /docker rm[^\r\n]*\|\| true/);
  assert.match(
    cleanupFunction,
    /if \[ "\$validation_root_owned" = true \]; then[\s\S]*\[ "\$validation_root" != "\/tmp\/stay-fable-wsl-validation" \][\s\S]*\[ ! -f "\$ownership_marker" \][\s\S]*cat -- "\$ownership_marker"[\s\S]*\[ "\$marker_token" = "\$validation_token" \][\s\S]*rm -rf -- "\$validation_root"[\s\S]*cleanup_failed=1/,
  );
  assert.doesNotMatch(cleanupFunction, /\.wsl-runtime|\/mnt\//);
  assert.match(
    cleanupFunction,
    /if \[ "\$cleanup_failed" -ne 0 \]; then[\s\S]*return 1[\s\S]*fi[\s\S]*return "\$validation_status"/,
  );
  assert.doesNotMatch(cleanupFunction, /\[ "\$\?" -ne 0 \]/);
  const trapCommand = "trap 'cleanup_validation $?' EXIT";
  const trapIndex = guide.indexOf(trapCommand);
  const strictModeCommand = "set -Eeuo pipefail";
  const strictModeIndex = guide.indexOf(strictModeCommand);
  assert.ok(trapIndex >= 0);
  assert.ok(guide.indexOf(inventoryBlock) < guide.indexOf("cleanup_validation()"));
  assert.ok(guide.indexOf(inventoryBlock) < trapIndex);
  assert.ok(strictModeIndex > trapIndex);
  assert.ok(
    strictModeIndex <
      guide.indexOf(
        "POSTGRES_PORT=55432 REDIS_PORT=56379 docker compose --project-name stay-fable-wsl-validation -f infrastructure/compose.yaml up",
      ),
  );
  assert.match(guide, /trap 'cleanup_validation \$\?' EXIT\s+set -Eeuo pipefail/);
  assert.match(
    guide,
    /if cleanup_validation 0; then[\s\S]*else[\s\S]*exit 1[\s\S]*fi[\s\S]*test ! -e "\$validation_root"/,
  );
  assert.match(
    guide,
    /1 秒.*API.*就绪[\s\S]*10 分 55 秒[\s\S]*Running=true[\s\S]*RestartCount=0[\s\S]*(无|没有).*(致命|fatal).*(reconnect|重连)/is,
  );
  assert.match(guide, /生产环境[\s\S]*rediss:\/\//);
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

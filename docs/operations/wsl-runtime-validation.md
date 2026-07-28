# WSL2 后端实机验证

本流程在 Windows PowerShell 中生成 API/Worker 的生产部署产物，再在
`Ubuntu-22.04` WSL2 中运行隔离的 PostgreSQL/PostGIS、Redis、API 和 Worker。
验证容器固定命名为 `stay-fable-wsl-validation-api` 和
`stay-fable-wsl-validation-worker`。

> **边界：** 验证前先盘点 Docker 现状。不得停止或删除任何无关容器，不得使用
> `docker system prune`，也不得执行带 `--volumes` 的 Compose 清理命令。

## 1. 确认 Ubuntu-22.04 使用 WSL2

在 Windows PowerShell 中运行：

```powershell
wsl.exe -l -v
```

预期列表中存在 `Ubuntu-22.04`，且 `VERSION` 为 `2`（即 WSL 2）。

## 2. 保存生命周期脚本

先打开交互式 WSL Bash：

```powershell
wsl.exe -d Ubuntu-22.04 -- bash
```

在该交互式 shell 中，用编辑器把“WSL 阶段”下的完整 Bash 代码块保存为
`/tmp/stay-fable-wsl-validation.sh`，然后运行：

```bash
chmod 700 /tmp/stay-fable-wsl-validation.sh
exit
```

生命周期必须从这个已保存的 Bash 脚本文件运行；也可以在交互式 shell 中逐行
执行。禁止通过管道或 stdin（标准输入）把整个生命周期送给 Bash。原因是
`docker compose exec -T` 可能消费剩余标准输入，使后续命令静默丢失。尤其不要把
本指南代码块接到 Bash 或 `sh` 的标准输入。

## Windows PowerShell 阶段

从当前 linked worktree 的仓库根目录运行下面的完整 PowerShell 代码块。Windows
Git 能正确解析 linked worktree `.git` 文件中的 Windows `gitdir:`；不要把这个
守卫改回 WSL Git。所有构建和部署命令都通过仓库锁定的 Corepack 入口运行，因为
此 Ubuntu 环境不假定安装原生 Node 或 Corepack。

脚本先解析实际仓库根目录和当前物理路径，只有两者相同时才允许重建该 worktree
自己的 `.wsl-runtime/`。它随后生成生产部署产物，将两个明确路径转换为 WSL 路径，
并启动已保存的生命周期脚本。无论 WSL 验证成功还是失败，`finally` 都用同样的
路径守卫清理 Windows 侧产物。

```powershell
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (git rev-parse --show-toplevel)).Path
$currentPath = (Resolve-Path -LiteralPath (Get-Location).ProviderPath).Path
if (-not [StringComparer]::OrdinalIgnoreCase.Equals($currentPath, $repoRoot)) {
  throw '拒绝重建：当前目录不是当前 linked worktree 顶层目录'
}

$runtimeDir = Join-Path $repoRoot '.wsl-runtime'

try {
  if (Test-Path -LiteralPath $runtimeDir) {
    Remove-Item -LiteralPath $runtimeDir -Recurse -Force
  }
  New-Item -ItemType Directory -Path $runtimeDir | Out-Null

  corepack pnpm build
  if ($LASTEXITCODE -ne 0) { throw '生产构建失败' }
  corepack pnpm --filter @stay-fable/api-server prisma:generate
  if ($LASTEXITCODE -ne 0) { throw 'Prisma 客户端生成失败' }
  corepack pnpm deploy --filter @stay-fable/api-server --prod (Join-Path $runtimeDir 'api')
  if ($LASTEXITCODE -ne 0) { throw 'API 部署产物生成失败' }
  corepack pnpm deploy --filter @stay-fable/job-worker --prod (Join-Path $runtimeDir 'worker')
  if ($LASTEXITCODE -ne 0) { throw 'Worker 部署产物生成失败' }

  $repoWsl = (wsl.exe -d Ubuntu-22.04 -- wslpath -a $repoRoot).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $repoWsl.StartsWith('/mnt/')) {
    throw '仓库路径无法安全转换为 WSL drvfs 路径'
  }
  $runtimeWsl = (wsl.exe -d Ubuntu-22.04 -- wslpath -a $runtimeDir).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $runtimeWsl.StartsWith("$repoWsl/")) {
    throw '部署产物路径无法安全转换为当前仓库下的 WSL 路径'
  }

  wsl.exe -d Ubuntu-22.04 -- env "REPO_ROOT=$repoWsl" "ARTIFACT_ROOT=$runtimeWsl" bash /tmp/stay-fable-wsl-validation.sh
  if ($LASTEXITCODE -ne 0) { throw 'WSL 运行时验证失败' }
}
finally {
  $cleanupCurrentPath = (Resolve-Path -LiteralPath (Get-Location).ProviderPath).Path
  $cleanupRuntimeDir = Join-Path $repoRoot '.wsl-runtime'
  if (
    [StringComparer]::OrdinalIgnoreCase.Equals($cleanupCurrentPath, $repoRoot) -and
    [StringComparer]::OrdinalIgnoreCase.Equals($cleanupRuntimeDir, $runtimeDir)
  ) {
    if (Test-Path -LiteralPath $runtimeDir) {
      Remove-Item -LiteralPath $runtimeDir -Recurse -Force
    }
  }
  else {
    Write-Error '当前目录或验证产物路径不符合预期，拒绝清理 .wsl-runtime'
  }
}

git status --short
```

这里的“生产部署产物”指 `corepack pnpm deploy --prod` 生成的运行包，不代表连接
本机无 TLS 的依赖时把 `NODE_ENV` 伪装成生产环境。

## WSL 阶段

以下内容是 `/tmp/stay-fable-wsl-validation.sh` 的完整内容。PowerShell 已传入经过
验证和 `wslpath` 转换的仓库、产物路径，因此这里不依赖 WSL Git，也不调用 WSL
中的 Node 包管理工具。

脚本在任何 Docker 变更前执行两次强制盘点。随后注册失败安全的 EXIT trap；清理
只处理两个固定容器、隔离 Compose 项目和精确的 ext4 临时根目录
`/tmp/stay-fable-wsl-validation`。Compose `down` 不带 `--volumes`，所以数据卷
会保留。

API 就绪探测执行 20 次，每次请求最长 2 秒、连接超时 1 秒，失败后间隔 1 秒，
因此最长 60 秒。Worker 随后执行完整的 10 分钟稳定性观察。

```bash
#!/usr/bin/env bash

if [ -z "${REPO_ROOT:-}" ] || [ -z "${ARTIFACT_ROOT:-}" ]; then
  echo '缺少已验证的 REPO_ROOT 或 ARTIFACT_ROOT' >&2
  exit 1
fi
if ! repo_root="$(cd -- "$REPO_ROOT" && pwd -P)"; then
  echo '无法解析仓库物理路径' >&2
  exit 1
fi
if ! artifact_root="$(cd -- "$ARTIFACT_ROOT" && pwd -P)"; then
  echo '无法解析部署产物物理路径' >&2
  exit 1
fi
if [ "$artifact_root" != "$repo_root/.wsl-runtime" ]; then
  echo '部署产物路径不属于当前仓库，停止验证' >&2
  exit 1
fi
cd -- "$repo_root"

if ! docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'; then
  echo '无法盘点运行中的容器，停止验证且不执行清理' >&2
  exit 1
fi
if ! docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'; then
  echo '无法盘点全部容器，停止验证且不执行清理' >&2
  exit 1
fi
for container_name in stay-fable-wsl-validation-api stay-fable-wsl-validation-worker; do
  if ! listed_names="$(docker ps -a --filter "name=^/${container_name}$" --format '{{.Names}}')"; then
    echo "无法检查验证容器名称冲突：${container_name}" >&2
    exit 1
  fi
  if [ -n "$listed_names" ]; then
    echo "验证容器已存在；先人工确认来源，脚本拒绝删除：${container_name}" >&2
    exit 1
  fi
done

validation_root="/tmp/stay-fable-wsl-validation"

cleanup_validation() {
  local validation_status="$1"
  local cleanup_failed=0
  local container_name listed_names
  trap - EXIT

  for container_name in stay-fable-wsl-validation-api stay-fable-wsl-validation-worker; do
    if ! listed_names="$(docker ps -a --filter "name=^/${container_name}$" --format '{{.Names}}')"; then
      echo "无法查询验证容器：${container_name}" >&2
      cleanup_failed=1
      continue
    fi
    if [ -n "$listed_names" ]; then
      if [ "$listed_names" != "$container_name" ]; then
        echo "容器查询返回非预期名称，拒绝删除：${listed_names}" >&2
        cleanup_failed=1
      elif ! docker rm -f "$container_name"; then
        cleanup_failed=1
      fi
    fi

    if ! listed_names="$(docker ps -a --filter "name=^/${container_name}$" --format '{{.Names}}')"; then
      echo "无法验证容器已删除：${container_name}" >&2
      cleanup_failed=1
    elif [ -n "$listed_names" ]; then
      echo "验证容器清理后仍存在：${container_name}" >&2
      cleanup_failed=1
    fi
  done

  if ! POSTGRES_PORT=55432 REDIS_PORT=56379 docker compose --project-name stay-fable-wsl-validation -f infrastructure/compose.yaml down; then
    cleanup_failed=1
  fi

  if [ "$validation_root" = "/tmp/stay-fable-wsl-validation" ]; then
    if ! rm -rf -- "$validation_root"; then
      cleanup_failed=1
    fi
  else
    echo '临时根目录不符合预期，拒绝清理' >&2
    cleanup_failed=1
  fi

  if [ "$cleanup_failed" -ne 0 ]; then
    return 1
  fi
  return "$validation_status"
}
trap 'cleanup_validation $?' EXIT
set -Eeuo pipefail

if [ "$validation_root" != "/tmp/stay-fable-wsl-validation" ]; then
  echo '临时根目录守卫失败' >&2
  exit 1
fi
if [ ! -d "$artifact_root/api" ] || [ ! -d "$artifact_root/worker" ]; then
  echo 'API 或 Worker 部署产物不存在' >&2
  exit 1
fi
rm -rf -- "$validation_root"
mkdir -p "$validation_root/api" "$validation_root/worker"
cp -a -- "$artifact_root/api/." "$validation_root/api/"
cp -a -- "$artifact_root/worker/." "$validation_root/worker/"

POSTGRES_PORT=55432 REDIS_PORT=56379 docker compose --project-name stay-fable-wsl-validation -f infrastructure/compose.yaml up -d --wait --wait-timeout 120
POSTGRES_PORT=55432 REDIS_PORT=56379 docker compose --project-name stay-fable-wsl-validation -f infrastructure/compose.yaml ps

POSTGRES_PORT=55432 REDIS_PORT=56379 docker compose --project-name stay-fable-wsl-validation -f infrastructure/compose.yaml exec -T postgres \
  psql -U stay_fable -d stay_fable -c 'SELECT PostGIS_Lib_Version();'
POSTGRES_PORT=55432 REDIS_PORT=56379 docker compose --project-name stay-fable-wsl-validation -f infrastructure/compose.yaml exec -T redis \
  redis-cli ping

docker run -d --name stay-fable-wsl-validation-api \
  --network stay-fable-wsl-validation_default \
  --user node --read-only --tmpfs /tmp \
  --workdir /app -v "$validation_root/api:/app:ro" \
  -p 127.0.0.1:53000:3000 \
  -e NODE_ENV=development \
  -e DATABASE_URL='postgresql://stay_fable:local_only_password@postgres:5432/stay_fable?schema=public&sslmode=disable' \
  -e REDIS_URL='redis://redis:6379' \
  node:24.14.1-bookworm-slim node dist/main.js

docker run -d --name stay-fable-wsl-validation-worker \
  --network stay-fable-wsl-validation_default \
  --user node --read-only --tmpfs /tmp \
  --workdir /app -v "$validation_root/worker:/app:ro" \
  -e NODE_ENV=development \
  -e REDIS_URL='redis://redis:6379' \
  node:24.14.1-bookworm-slim node dist/main.js

api_ready=false
for attempt in $(seq 1 20); do
  if curl --fail --silent --show-error --connect-timeout 1 --max-time 2 http://127.0.0.1:53000/health/ready >/dev/null; then
    api_ready=true
    break
  fi
  sleep 1
done
if [ "$api_ready" != true ]; then
  echo 'API 未在 60 秒内就绪' >&2
  docker logs stay-fable-wsl-validation-api >&2 || true
  docker logs stay-fable-wsl-validation-worker >&2 || true
  exit 1
fi

curl --fail --silent --show-error --connect-timeout 1 --max-time 2 -o /dev/null -w '/health/live HTTP %{http_code}\n' \
  http://127.0.0.1:53000/health/live
curl --fail --silent --show-error --connect-timeout 1 --max-time 2 -o /dev/null -w '/health/ready HTTP %{http_code}\n' \
  http://127.0.0.1:53000/health/ready

docker inspect --format \
  'user={{.Config.User}} ReadonlyRootfs={{.HostConfig.ReadonlyRootfs}}' \
  stay-fable-wsl-validation-api stay-fable-wsl-validation-worker

for minute in $(seq 1 10); do
  echo "Worker observation minute ${minute}/10"
  restart_count="$(docker inspect --format '{{.RestartCount}}' stay-fable-wsl-validation-worker)"
  echo "RestartCount=${restart_count}"
  if [ "$restart_count" -ne 0 ]; then
    echo 'Worker 在观察期间发生重启' >&2
    docker logs stay-fable-wsl-validation-worker >&2 || true
    exit 1
  fi
  worker_logs="$(docker logs --since 65s stay-fable-wsl-validation-worker 2>&1)"
  printf '%s\n' "$worker_logs"
  if printf '%s\n' "$worker_logs" | grep -Eiq '(reconnect|error)'; then
    echo 'Worker 日志出现 reconnect loop 或错误' >&2
    exit 1
  fi
  sleep 60
done

final_restart_count="$(docker inspect --format '{{.RestartCount}}' stay-fable-wsl-validation-worker)"
echo "RestartCount=${final_restart_count}"
if [ "$final_restart_count" -ne 0 ]; then
  echo 'Worker 最终重启次数非零' >&2
  docker logs stay-fable-wsl-validation-worker >&2 || true
  exit 1
fi
final_worker_logs="$(docker logs --since 10m stay-fable-wsl-validation-worker 2>&1)"
printf '%s\n' "$final_worker_logs"
if printf '%s\n' "$final_worker_logs" | grep -Eiq '(reconnect|error)'; then
  echo 'Worker 最终日志出现 reconnect loop 或错误' >&2
  exit 1
fi

if cleanup_validation 0; then
  echo '验证资源清理完成'
else
  echo '验证资源清理失败' >&2
  exit 1
fi
test ! -e "$validation_root"
```

## 3. 必须记录的证据

PostGIS 查询与 Redis 探测必须成功，例如：

```text
 postgis_lib_version
---------------------
 3.5.2
(1 row)

PONG
```

API 探测必须记录：

```text
/health/live HTTP 200
/health/ready HTTP 200
user=node ReadonlyRootfs=true
user=node ReadonlyRootfs=true
```

就绪循环共 20 次，每次请求最长 2 秒、连接超时 1 秒、失败后间隔 1 秒，因此最长
60 秒。已证明的实机运行中，ext4 副本挂载后 API 在 1 秒内就绪；Worker 连续稳定
10 分 55 秒，`RestartCount=0`，没有 reconnect loop 或 error 错误。执行新一轮
验收时仍须完整运行并记录自己的 10 分钟观察，不能只引用这组历史证据。

本地隔离网络使用 `redis://redis:6379` 和关闭 TLS 的数据库 URL。真实生产环境
必须设置 `NODE_ENV=production`，Redis 必须使用可信证书保护的 `rediss://` URL，
数据库也必须启用 TLS。

## 4. 清理确认

成功路径和失败路径共用清理函数。它对两个固定名称分别进行删除前精确查询、定向
删除和删除后查询，再关闭 `stay-fable-wsl-validation` Compose 项目，并删除精确
ext4 临时根目录。不得停止或删除清单中的无关容器。

PowerShell 的 `finally` 删除 `.wsl-runtime/` 后运行 `git status --short`。验证
产物不应出现在工作树中；清理会保留 Compose 命名数据卷，也不会删除 PostgreSQL
或 Redis 数据。

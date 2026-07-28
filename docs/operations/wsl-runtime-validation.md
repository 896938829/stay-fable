# WSL2 后端实机验证

本流程在 Windows PowerShell 与 `Ubuntu-22.04` WSL2 中验证本地
PostgreSQL/PostGIS、Redis、API 和 Worker。以下命令均从仓库根目录开始执行；
验证容器固定命名为 `stay-fable-wsl-validation-api` 和
`stay-fable-wsl-validation-worker`。

> **边界：** 验证前先盘点 Docker 现状。不得停止或删除任何无关容器，不得使用
> `docker system prune`，也不得执行带 `--volumes` 的 Compose 清理命令。

## 1. 确认 Ubuntu-22.04 使用 WSL2

在 PowerShell 中运行：

```powershell
wsl.exe -l -v
```

预期列表中存在 `Ubuntu-22.04`，且 `VERSION` 为 `2`（即 WSL 2）。随后从当前
仓库根目录进入该发行版：

```powershell
$repo = (Get-Location).Path
wsl.exe -d Ubuntu-22.04 --cd (wsl.exe -d Ubuntu-22.04 -- wslpath -a $repo) bash
```

后续步骤在刚进入的 WSL Bash 中执行。

## 2. 盘点现有容器

记录验证前的完整清单：

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
```

若 `stay-fable-wsl-validation-api` 或 `stay-fable-wsl-validation-worker` 已存在，
先确认它们确实是上次执行本指南遗留的临时容器，才可定向删除。不得停止或删除
清单中的无关容器；端口冲突时应更换本流程的临时 API 端口，而不是处理占用端口
的其他容器。

## 3. 用避让端口启动 Compose

为本次验收固定独立 Compose 项目名 `stay-fable-wsl-validation`。这会把数据库、
Redis、网络和其他 checkout/worktree 的默认 Compose 项目隔离。在同一条启动命令
中指定项目名、宿主机端口并等待健康检查完成：

```bash
POSTGRES_PORT=55432 REDIS_PORT=56379 docker compose --project-name stay-fable-wsl-validation -f infrastructure/compose.yaml up -d --wait --wait-timeout 120
POSTGRES_PORT=55432 REDIS_PORT=56379 docker compose --project-name stay-fable-wsl-validation -f infrastructure/compose.yaml ps
```

宿主机使用 `127.0.0.1:55432` 和 `127.0.0.1:56379`；同一 Compose 网络内的
临时 API/Worker 仍通过服务名 `postgres:5432` 和 `redis:6379` 访问依赖。

## 4. 验证 PostGIS 和 Redis

```bash
POSTGRES_PORT=55432 REDIS_PORT=56379 docker compose --project-name stay-fable-wsl-validation -f infrastructure/compose.yaml exec -T postgres \
  psql -U stay_fable -d stay_fable -c 'SELECT PostGIS_Lib_Version();'
POSTGRES_PORT=55432 REDIS_PORT=56379 docker compose --project-name stay-fable-wsl-validation -f infrastructure/compose.yaml exec -T redis \
  redis-cli ping
```

示例证据：

```text
 postgis_lib_version
---------------------
 3.5.2
(1 row)

PONG
```

版本补丁号可能随镜像更新而变化，但查询必须成功返回 PostGIS 版本，Redis 必须
返回 `PONG`。

## 5. 生成 API 和 Worker 生产部署产物

先解析当前 linked worktree 自己的 Git 顶层目录并取得物理路径。只有当前目录与
该顶层目录完全相等时，才删除并重建这个仓库自己的 `.wsl-runtime/`。因此上次
失败留下的部署目标可安全重跑，也不会删除父仓库或其他 worktree 的同名目录：

```bash
repo_root="$(git rev-parse --show-toplevel)"
repo_root="$(cd "$repo_root" && pwd -P)"
current_dir="$(pwd -P)"
runtime_dir="$repo_root/.wsl-runtime"
if [ "$current_dir" = "$repo_root" ]; then
  rm -rf -- "$runtime_dir"
  mkdir -p "$runtime_dir"
else
  echo "拒绝重建：当前目录不是当前 worktree 顶层目录" >&2
  exit 1
fi

corepack enable
pnpm --filter @stay-fable/validation build
pnpm --filter @stay-fable/api-contracts build
DATABASE_URL=postgresql://build:build@localhost:5432/build \
  pnpm --filter @stay-fable/api-server prisma:generate
pnpm --filter @stay-fable/api-server build
pnpm --filter @stay-fable/job-worker build
pnpm deploy --filter @stay-fable/api-server --prod "$runtime_dir/api"
pnpm deploy --filter @stay-fable/job-worker --prod "$runtime_dir/worker"
```

这里的“生产部署产物”指 `pnpm deploy --prod` 生成的运行包，不代表下一步连接
本机无 TLS 的依赖时把 `NODE_ENV` 伪装成生产环境。

## 6. 以受限 Node 容器运行 API 和 Worker

独立 Compose 项目创建的网络名为 `stay-fable-wsl-validation_default`。两个临时
容器都必须同时使用 `--user node`、`--read-only`、`--tmpfs /tmp`，并只读挂载
各自部署产物：

```bash
docker run -d --name stay-fable-wsl-validation-api \
  --network stay-fable-wsl-validation_default \
  --user node --read-only --tmpfs /tmp \
  --workdir /app -v "$runtime_dir/api:/app:ro" \
  -p 127.0.0.1:53000:3000 \
  -e NODE_ENV=development \
  -e DATABASE_URL='postgresql://stay_fable:local_only_password@postgres:5432/stay_fable?schema=public&sslmode=disable' \
  -e REDIS_URL='redis://redis:6379' \
  node:24.14.1-bookworm-slim node dist/main.js

docker run -d --name stay-fable-wsl-validation-worker \
  --network stay-fable-wsl-validation_default \
  --user node --read-only --tmpfs /tmp \
  --workdir /app -v "$runtime_dir/worker:/app:ro" \
  -e NODE_ENV=development \
  -e REDIS_URL='redis://redis:6379' \
  node:24.14.1-bookworm-slim node dist/main.js
```

`redis://redis:6379` 只适用于这个隔离的本地开发网络。真实生产环境必须设置
`NODE_ENV=production` 并使用可信证书保护的 `rediss://` Redis URL；数据库同样
必须启用 TLS。

## 7. 验证 API 健康端点和容器限制

API 启动和依赖连接需要短暂时间。先进行最多 30 次、间隔 2 秒的就绪探测，总等待
时间有界；超时必须打印 API 和 Worker 日志并以非零状态退出：

```bash
api_ready=false
for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error http://127.0.0.1:53000/health/ready >/dev/null; then
    api_ready=true
    break
  fi
  sleep 2
done
if [ "$api_ready" != true ]; then
  echo 'API 未在 60 秒内就绪' >&2
  docker logs stay-fable-wsl-validation-api >&2
  docker logs stay-fable-wsl-validation-worker >&2
  exit 1
fi
```

就绪后记录两个健康端点和容器限制证据：

```bash
curl --fail --silent --show-error -o /dev/null -w '/health/live HTTP %{http_code}\n' \
  http://127.0.0.1:53000/health/live
curl --fail --silent --show-error -o /dev/null -w '/health/ready HTTP %{http_code}\n' \
  http://127.0.0.1:53000/health/ready

docker inspect --format \
  'user={{.Config.User}} ReadonlyRootfs={{.HostConfig.ReadonlyRootfs}}' \
  stay-fable-wsl-validation-api stay-fable-wsl-validation-worker
```

预期证据：

```text
/health/live HTTP 200
/health/ready HTTP 200
user=node ReadonlyRootfs=true
user=node ReadonlyRootfs=true
```

只有两个端点均为 HTTP 200，且两个容器的 `Config.User=node`、
`HostConfig.ReadonlyRootfs=true`，本步骤才通过。

## 8. 连续观察 Worker 至少 10 分钟

以下循环每分钟检查一次重启次数和新增日志，共观察 10 分钟；出现非零重启次数、
`reconnect` 或 `error` 即失败：

```bash
for minute in $(seq 1 10); do
  echo "Worker observation minute ${minute}/10"
  restart_count="$(docker inspect --format '{{.RestartCount}}' stay-fable-wsl-validation-worker)"
  echo "RestartCount=${restart_count}"
  if [ "$restart_count" -ne 0 ]; then
    echo 'Worker 在观察期间发生重启' >&2
    docker logs stay-fable-wsl-validation-worker >&2
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
```

通过证据应持续显示 `RestartCount=0`，并且没有重连循环（reconnect loop）或错误。
最后再次保存完整状态和最近日志供验收：

```bash
final_restart_count="$(docker inspect --format '{{.RestartCount}}' stay-fable-wsl-validation-worker)"
echo "RestartCount=${final_restart_count}"
if [ "$final_restart_count" -ne 0 ]; then
  echo 'Worker 最终重启次数非零' >&2
  docker logs stay-fable-wsl-validation-worker >&2
  exit 1
fi
final_worker_logs="$(docker logs --since 10m stay-fable-wsl-validation-worker 2>&1)"
printf '%s\n' "$final_worker_logs"
if printf '%s\n' "$final_worker_logs" | grep -Eiq '(reconnect|error)'; then
  echo 'Worker 最终日志出现 reconnect loop 或错误' >&2
  exit 1
fi
```

## 9. 只清理命名的临时容器

仅删除本指南创建的两个明确命名容器，然后关闭本仓库的 Compose 项目：

```bash
docker rm -f stay-fable-wsl-validation-api stay-fable-wsl-validation-worker
POSTGRES_PORT=55432 REDIS_PORT=56379 docker compose --project-name stay-fable-wsl-validation -f infrastructure/compose.yaml down
```

不得把任何其他容器名加入清理命令。独立项目名确保 `down` 只作用于本次验收的
Compose 项目；该命令不带卷删除参数，因此命名 Compose 数据卷会被保留，
PostgreSQL 和 Redis 数据不会因本次验证而删除。

## 10. 删除临时产物并检查工作树

再次解析当前 linked worktree 顶层目录和物理路径。只有当前目录相等且目标精确为
该顶层目录下的 `.wsl-runtime/` 时，才执行删除：

```bash
repo_root="$(git rev-parse --show-toplevel)"
repo_root="$(cd "$repo_root" && pwd -P)"
current_dir="$(pwd -P)"
runtime_dir="$repo_root/.wsl-runtime"
if [ "$current_dir" = "$repo_root" ] && [ "$runtime_dir" = "$repo_root/.wsl-runtime" ]; then
  rm -rf -- "$runtime_dir"
else
  echo "拒绝清理：当前目录或验证产物路径不符合预期" >&2
  exit 1
fi
git status --short
```

删除 `.wsl-runtime/` 后，`git status --short` 不应出现任何验证产物。此清理会
保留 Compose 数据卷，也不得为了“清空状态”停止或删除任何无关容器。

# Slice 5 WSL2 runtime transcript

本文件是 2026-07-31 最终候选 WSL2 运行的脱敏持久证据。它不包含登录材料、业务 token、
原始 owner token 或原始网络负载。

## 运行身份与时间

- 验证代码 HEAD：`80d7ce5`（相对实现候选 `0caa904` 只新增候选说明文档）
- Ubuntu distro：`Ubuntu-22.04`
- 启动时间：`2026-07-31T03:51:24.3267793+08:00`
- `SLICE4_UAT_READY` 观察时间：`2026-07-31T03:56:01.3869203+08:00`
- START gate 写入时间：`2026-07-31T03:56:01.4471695+08:00`
- 最终 marker 观察时间：`2026-07-31T04:07:05.3426354+08:00`
- 证据收尾时间：`2026-07-31T04:07:32.8426878+08:00`
- cleanup 反查时间：`2026-07-31T04:07:56.0616502+08:00`
- owner 指纹：
  `sha256:129c16da6146a365feae878332e80f5df0f6250790e45bbffc0ec7872222436d`

运行命令的固定形式：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts/wsl-runtime-validation.ps1 `
  -Distro Ubuntu-22.04 `
  -StableGatePath <owner-temp>/stable-window.gate `
  -StableGateOwnerToken <ephemeral-owner>
```

START gate 由 `Set-Slice5StableGate` 以 write-through 临时文件、flush 和原子 rename 写入。
原 owner token 仅存在于已删除的临时目录。本文件统一使用不可逆 owner 指纹。

## 原始日志保管信息

临时原始 stdout/stderr 在 owner 目录删除前完成哈希和敏感词扫描：

| Stream | Bytes | Lines | SHA-256                                                            |
| ------ | ----: | ----: | ------------------------------------------------------------------ |
| stdout | 7,994 |   146 | `88a8b952d10a43ff67aae324f91e774e14a73af9d2583916c697cd5d6f4798cd` |
| stderr | 2,873 |    40 | `a755849b015b596c8fc70374ba3ea9de7b2d681fba0e9aa0c931bb512e401558` |

对两个原始流执行不区分大小写的
`authorization|bearer|access-token|refresh-token|password|secret|cookie|session=|openid|unionid`
扫描，命中数为 0。原始流包含临时 owner 和本机路径，因此不入库；下文保留完成独立复核所需
的脱敏运行 transcript。伴随 `.sha256` sidecar 校验本文件内容。

Windows 启动器未保留已退出进程的句柄，因此不伪造一个数字化的原进程 exit code。成功依据
是：唯一 stable/cleanup marker、10 个完整采样、PowerShell 进程已退出、stderr 无终止错误，
以及独立 cleanup postcheck 的退出码 0。

## 构建、迁移与基础设施

```text
@stay-fable/api-server:build:
  node ../../scripts/clean-api-dist.mjs && tsc -p tsconfig.build.json
Tasks: 6 successful, 6 total

6 migrations found in prisma/migrations
Applying migration 202607290001_identity_location
Applying migration 202607290002_user_session_version
Applying migration 202607290003_session_version_monotonic
Applying migration 202607290004_catalog_supply
Applying migration 202607300001_quote_booking_hold
Applying migration 202607300002_booking_lifecycle_payment
All migrations have been successfully applied.

postgis_version
3.5 USE_GEOS=1 USE_PROJ=1 USE_STATS=1

PONG
/health/live HTTP 200
/health/ready HTTP 200
api owner=sha256:129c16da...2436d user=node readonly=true
worker owner=sha256:129c16da...2436d user=node readonly=true
```

## 身份、房源、报价与预订断言

```text
identity isolation: pass
seeded cities: pass
PostGIS location resolution: pass
refresh rotation and replay rejection: pass
catalog validation: pass - Hangzhou properties
catalog validation: pass - property type filter
catalog validation: pass - guest capacity
catalog validation: pass - cursor pagination
catalog validation: pass - property room types
catalog validation: pass - room inventory redaction
SLICE3_QUOTE_CREATED
SLICE3_IDEMPOTENT_REPLAY
SLICE3_LAST_ROOM_SERIALIZED
SLICE3_MULTI_NIGHT_ROLLED_BACK
SLICE3_QUOTE_CHANGED_NO_HOLD
SLICE3_QUOTE_EXPIRED_NO_HOLD
SLICE3_UAT_READY http://127.0.0.1:3000
SLICE4_BOOKING_QUERY_ISOLATED
SLICE4_MOCK_FAILURE_IDEMPOTENT
SLICE4_MOCK_SUCCESS_CONFIRMED
SLICE4_CANCEL_RELEASED
SLICE4_LIFECYCLE_RACE_SERIALIZED
SLICE4_WORKER_EXPIRY_RELEASED
SLICE4_UAT_READY http://127.0.0.1:3000
SLICE4_UAT_READY http://127.0.0.1:3000 OWNER=sha256:129c16da...2436d
SLICE2_RUNTIME_READY http://127.0.0.1:3000
```

## Worker 十分钟逐分钟采样

以下 10 行来自同一 stdout 流，运行 owner 由前后 owner-bound marker 的相同指纹绑定：

```text
Worker observation minute 1/10 Running=true RestartCount=0
Worker observation minute 2/10 Running=true RestartCount=0
Worker observation minute 3/10 Running=true RestartCount=0
Worker observation minute 4/10 Running=true RestartCount=0
Worker observation minute 5/10 Running=true RestartCount=0
Worker observation minute 6/10 Running=true RestartCount=0
Worker observation minute 7/10 Running=true RestartCount=0
Worker observation minute 8/10 Running=true RestartCount=0
Worker observation minute 9/10 Running=true RestartCount=0
Worker observation minute 10/10 Running=true RestartCount=0
SLICE2_RUNTIME_STABLE_10_MINUTES OWNER=sha256:129c16da...2436d
SLICE2_RUNTIME_CLEANUP_COMPLETE OWNER=sha256:129c16da...2436d
```

每次采样还检查最近 65 秒 Worker 日志，不允许 fatal/error、连接错误或 reconnect loop；
否则脚本会在 stable marker 前以非零状态返回。

## Cleanup transcript 与独立反查

Compose stderr 确认本次 owner 项目的 PostgreSQL、Redis 和网络完成 stop/remove：

```text
postgres-1 Stopping
redis-1 Stopping
postgres-1 Stopped
postgres-1 Removing
postgres-1 Removed
redis-1 Stopped
redis-1 Removing
redis-1 Removed
owner_default Removing
owner_default Removed
```

marker 完成后，独立 postcheck 重新查询 Docker/WSL/Windows/Git，结果为：

```json
{
  "checkedAt": "2026-07-31T04:07:56.0616502+08:00",
  "ownerFingerprint": "sha256:129c16da6146a365feae878332e80f5df0f6250790e45bbffc0ec7872222436d",
  "stableMarkerCount": 1,
  "cleanupMarkerCount": 1,
  "workerMinuteCount": 10,
  "ownerContainerCount": 0,
  "projectContainerCount": 0,
  "projectNetworkCount": 0,
  "wslRoot": "ABSENT",
  "windowsRuntimeExists": false,
  "gitStatus": null
}
```

```text
EVIDENCE_POSTCHECK_EXIT=0
```

受保护的既有资源在反查时保持：

```text
stay-fable-wsl-validation-redis-1 Created
stay-fable-wsl-validation-postgres-1 Created
vigorous_jang Created
rims-postgres Up 28 hours (healthy)
```

最后在验证 owner、路径和 marker 后删除 Windows owner 临时目录；Compose 数据卷按
`AGENTS.md` 默认保留。

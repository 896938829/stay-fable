# WSL2 后端实机验证

本流程从 Windows PowerShell 一键验证 PostgreSQL/PostGIS、Redis、NestJS API 和
Worker。它面向已安装 WSL2 与 Docker Engine 的 `Ubuntu-22.04`，不要求 WSL 内安装
Node.js。

先确认发行版运行在 WSL 2：

```powershell
wsl.exe -l -v
```

列表中必须包含 `Ubuntu-22.04`，且 `VERSION` 为 `2`（WSL 2）。

## 执行

从当前 linked worktree 根目录运行：

```powershell
powershell -NoProfile -File scripts/wsl-runtime-validation.ps1
```

如发行版名称不同，可显式指定：

```powershell
powershell -NoProfile -File scripts/wsl-runtime-validation.ps1 -Distro Ubuntu-22.04
```

脚本会执行以下步骤：

1. 在 Windows 生成 Prisma Client，并构建、部署 API 与 Worker 生产运行包。
2. 原子获取带本次随机所有权令牌的 Docker 锁，然后在隔离的
   `stay-fable-wsl-validation` Compose 项目中启动 PostgreSQL/PostGIS 和 Redis，
   宿主端口分别为 `55432`、`56379`。
3. 通过 Windows Prisma CLI 连接 WSL 转发的 PostgreSQL，执行迁移和种子数据。
   这样可以避免依赖 WSL Node，也不会把 Windows Prisma 引擎放进 Linux 容器运行。
4. 以固定摘要的 Node 镜像、`user=node`、只读根文件系统启动 API 和 Worker。
   API 仅监听 `127.0.0.1:3000`。
5. 验证 PostGIS、Redis、健康探针、用户与文件系统权限，并运行身份隔离、城市种子、
   PostGIS 定位解析、刷新令牌轮换及重放拒绝冒烟测试。
6. 连续观察 Worker 10 分钟，要求始终运行、重启次数为零，且日志无致命错误、
   连接错误或重连循环。
7. 无论成功或失败，都只清理由本次随机所有权令牌创建的容器、网络和临时目录。
   Compose 清理不带 `--volumes`，不会删除数据库卷。

## 成功标志

完整成功运行应同时出现：

```text
PostGIS
PONG
/health/live HTTP 200
/health/ready HTTP 200
identity isolation: pass
seeded cities: pass
PostGIS location resolution: pass
refresh rotation and replay rejection: pass
SLICE1_RUNTIME_STABLE_10_MINUTES
SLICE1_RUNTIME_CLEANUP_COMPLETE
```

API 与 Worker 的检查结果还必须包含 `user=node`、`readonly=true`，每分钟 Worker
状态必须为 `Running=true RestartCount=0`。

## 所有权与安全边界

- 开始前必须位于当前 worktree 根目录，且 `.wsl-runtime`、固定验证容器名和隔离
  Compose 项目均不存在；存在时脚本拒绝接管。
- 固定名称的锁容器通过 Docker 的名称唯一性原子串行化验证；并发第二次运行即使同时
  通过只读预检，也无法取得锁，因而不会创建或清理另一运行的 PostgreSQL、Redis 或网络。
- 清理锁之前必须重新核对随机所有权令牌；固定 Compose 项目复用命名数据卷，从而支持
  第二次运行验证“无待执行迁移”，且 `down` 不删除数据卷。
- Windows 端口 `3000` 已被占用时脚本直接失败，不停止现有服务。
- 清理前重新核对随机所有权令牌；无法证明归属时保留资源并报错。
- 不执行 `docker system prune`，不停止或删除无关容器。已有的本地服务不属于本流程。
- 本地验证使用开发凭据、明文容器网络和模拟身份。生产环境仍必须使用 TLS、真实微信
  身份适配器、密钥管理和最小权限网络策略。

当前 Slice 1 的实测记录见
[`2026-07-29-slice-1-identity-search.md`](../verification/2026-07-29-slice-1-identity-search.md)。

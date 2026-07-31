# Stay Fable Demo v0.1 部署与演示

## 1. 适用范围

本手册用于在一台 Windows 开发机上部署 Stay Fable 第一版可演示环境：

- 原生微信小程序位于 `/wx`，运行在微信开发者工具模拟器；
- PostgreSQL/PostGIS、Redis、NestJS API 和 Worker 运行在 WSL2 的
  Ubuntu-22.04 Docker Engine；
- API 仅映射到 Windows 回环地址 `127.0.0.1:3000`；
- 开发版使用模拟身份和模拟支付，不要求真实微信用户或支付商户配置。

该环境只用于本地 Demo，不是生产部署。它使用 HTTP 回环地址、固定的本地数据库密码、
模拟身份和模拟支付。不得把这些设置复制到体验版、正式版或公网服务器。

## 2. 环境要求

需要预先安装：

- Windows 10/11 与 WSL2；
- 名称为 `Ubuntu-22.04` 的 WSL 发行版；
- Ubuntu-22.04 内可用的 Docker Engine 和 Docker Compose v2；
- Windows 侧 Node.js 24；
- Corepack 与 pnpm 11.17.0；
- 微信开发者工具；
- Git。

在 PowerShell 7 中检查版本：

```powershell
node --version
corepack pnpm --version
wsl.exe -l -v
wsl.exe -d Ubuntu-22.04 --exec docker version
wsl.exe -d Ubuntu-22.04 --exec docker compose version
```

预期 Node 输出 `v24.x`，pnpm 输出 `11.17.0`，Ubuntu-22.04 状态正常，Docker
客户端能够连接该发行版中的 Docker Engine。

## 3. 首次安装

在仓库根目录执行：

```powershell
git status --short
corepack pnpm install --frozen-lockfile
corepack pnpm wx:check
```

`git status --short` 应为空。正式用户端只有 `/wx`；冻结的
`apps/consumer-miniapp` 不参与本 Demo。

启动脚本会使用以下固定本地端口：

| 服务       | Windows 回环端口 |
| ---------- | ---------------- |
| API        | 3000             |
| PostgreSQL | 55432            |
| Redis      | 56379            |

启动前可检查冲突：

```powershell
Get-NetTCPConnection -State Listen |
  Where-Object LocalPort -In 3000, 55432, 56379
```

脚本会明确拒绝占用中的 API 端口 3000。数据库或 Redis 端口冲突会由 Docker
Compose 返回失败；不得停止或删除不属于 Stay Fable Demo 的容器。

## 4. 启动后端 Demo

必须从当前 linked worktree 根目录执行：

```powershell
corepack pnpm demo:up
```

该命令依次完成：

1. 检查 Node、pnpm、Ubuntu-22.04 和 Docker Engine；
2. 生成 Prisma Client并构建 workspace；
3. 生成 API、Worker 生产依赖部署产物；
4. 启动 PostgreSQL/PostGIS 和 Redis；
5. 执行全部 Prisma migration；
6. 按 Asia/Shanghai 当日初始化酒店、房型、价格和库存演示数据；
7. 以非 root、只读根文件系统启动 API 和 Worker；
8. 检查 `/health/live` 与 `/health/ready`。

成功时末尾出现：

```text
STAY_FABLE_DEMO_READY http://127.0.0.1:3000
STAY_FABLE_DEMO_WECHAT_PROJECT E:\...\stay-fable\wx
```

不要关闭 WSL Docker Engine。后端容器会在 PowerShell 命令结束后继续运行。

## 5. 状态与健康检查

任何时候都可以执行只读状态检查：

```powershell
corepack pnpm demo:status
Invoke-RestMethod http://127.0.0.1:3000/health/live
Invoke-RestMethod http://127.0.0.1:3000/health/ready
```

`pnpm demo:status` 会检查：

- PostGIS 和 Redis 的 Compose health 状态；
- API 与 Worker 的 owner token；
- API 与 Worker 使用 `node` 用户；
- API 与 Worker 根文件系统只读；
- 两个服务重启次数均为 0；
- Worker 日志中没有致命错误或重连循环；
- API 两个健康端点均成功。

成功标记为：

```text
STAY_FABLE_DEMO_READY http://127.0.0.1:3000
```

## 6. 导入微信项目

1. 打开微信开发者工具。
2. 选择“导入项目”。
3. 项目目录选择当前仓库的绝对 `/wx` 路径，例如：
   `E:\My Work\stay-fable\.worktrees\demo-v0.1\wx`。
4. 使用仓库 `wx/project.config.json` 中的 AppID。
5. 在“详情 → 本地设置”中，仅为本地模拟器勾选：
   “不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书”。
6. 点击“编译”。

上述域名检查设置只允许用于微信开发者工具模拟器。体验版和正式版必须使用已备案、
已配置微信 request 合法域名的 HTTPS API。

开发版会自动选择：

- `http://127.0.0.1:3000/api/v1`；
- `mock` 身份适配器。

若首页提示网络失败，先重新执行 `pnpm demo:status`，并在开发者工具 Network
面板确认请求确实发往 `127.0.0.1:3000/api/v1`。

## 7. 标准演示路径

演示遵循“旅店/酒店为一级，点进去才是房源”的产品结构：

1. 首页确认当前城市，选择入住和离店日期及入住人数。
2. 点击搜索，进入酒店列表。
3. 在酒店列表中选择一家酒店，进入酒店详情。
4. 在酒店详情中查看房型列表，再选择一个房型进入房型详情。
5. 点击预订，核对日期、住客、晚数、房价和总价。
6. 创建订单，进入待支付订单详情。
7. 首次选择“模拟支付失败”，确认订单仍为待支付且可重试。
8. 再选择“模拟支付成功”，确认订单变为已确认。
9. 进入订单列表，再进入订单详情，确认状态、订单号和支付结果一致。
10. 新建另一笔订单并执行取消，确认订单列表和详情均显示已取消。

若演示日期没有房量，停止并重新启动 Demo。seed 会按当日重新建立可查询的供应窗口。

## 8. 日志与故障排查

只检查 Demo 自己的资源：

```powershell
wsl.exe -d Ubuntu-22.04 --exec docker ps -a `
  --filter label=stay-fable.demo-owner
wsl.exe -d Ubuntu-22.04 --exec docker logs --tail 200 stay-fable-demo-api
wsl.exe -d Ubuntu-22.04 --exec docker logs --tail 200 stay-fable-demo-worker
```

常见问题：

- `TCP port 3000 is already listening`：识别占用者；不要直接终止不明服务。
- PostgreSQL 端口 55432 冲突：停止自己明确拥有的冲突环境，或完成其他验证后再启动。
- Redis 端口 56379 冲突：同样先确认资源所有者。
- `/health/ready` 失败：检查 PostGIS、Redis 和 API 日志，再运行 `pnpm demo:status`。
- 微信请求被拦截：确认只在模拟器启用了“不校验合法域名”，并重新编译。
- `Demo runtime already exists`：运行 `pnpm demo:status`；若环境不再需要，先正常执行
  `pnpm demo:down`。

脚本不会执行 `docker system prune`，也不会停止、删除无 Demo owner 标签的容器。

## 9. 停止 Demo

演示完成后执行：

```powershell
corepack pnpm demo:down
```

成功标记：

```text
STAY_FABLE_DEMO_DOWN
```

该命令删除 Demo API、Worker、PostGIS、Redis 容器和 Demo 网络，并清理当前工作树的
`.demo-runtime` 部署产物。PostgreSQL 和 Redis 数据卷默认保留，后续启动可以继续使用；
迁移和 seed 仍会以幂等方式再次执行。

### 显式清空 Demo 数据

以下操作会永久删除 Demo 数据，只能在 `pnpm demo:down` 成功、并确认卷确实属于
`stay-fable-demo` 后人工执行：

```powershell
wsl.exe -d Ubuntu-22.04 --exec docker volume inspect `
  stay-fable-demo_postgres-data stay-fable-demo_redis-data
wsl.exe -d Ubuntu-22.04 --exec docker volume rm `
  stay-fable-demo_postgres-data stay-fable-demo_redis-data
```

不得使用通配符、`docker volume prune` 或 `docker system prune`。

## 10. 已知安全限制

截至 Demo v0.1，依赖审计仍记录一条
`@nestjs/swagger -> js-yaml` 路径的 High 级漏洞。dev 阶段按项目策略报告但不阻断
功能演示；该问题仍阻断 `release` 和 `main`，除非升级到兼容安全版本，或取得包含批准人、
到期日和缓解措施的风险例外。

因此：

- `demo-v0.1.0` 是 dev 演示里程碑，不代表生产发布；
- 不得暴露本地端口到公网；
- 不得启用真实支付；
- 不得把模拟身份用于非 develop 环境；
- 不得把本手册中的固定本地凭据用于共享或生产环境。

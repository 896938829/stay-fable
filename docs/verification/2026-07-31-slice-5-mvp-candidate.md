# Slice 5 MVP 候选验证记录

验证日期：2026-07-31（Asia/Shanghai）

## 结论

候选状态：`BLOCKED_DEPENDENCY_AUDIT`

实现、仓库质量门禁、OpenAPI 契约和 WSL2 后端闭环均已通过；本记录不是发布批准，也不是
物理微信 UAT 的 PASS manifest。当前仍有以下独立阻断：

- stable `@nestjs/swagger@11.4.6` 精确依赖有 High 公告的 `js-yaml@5.2.1`；
- 微信开发者工具只读状态检查等待用户授权，无法取得可用测试号状态；
- `miniprogram-automator@0.12.1` 不能物理操作原生日期 picker；
- 人工与手机端视觉、modal、点击区域和快速双击验收尚未执行。

## 固定候选

- 实现提交：`0caa90402a44552a8c676f9611d983c3414648f2`
- 微信树：`d942ce5a1a401e5a9ea3eecfdfc6d4796125c86e`
- 微信页面：9
- PostgreSQL migration：6
- 分支：`codex/wx-mvp-booking-design`
- 远端同步：验证时 `origin/codex/wx-mvp-booking-design...HEAD` 为 `0 0`

当前微信树与最后一次微信代码提交 `06fceb7cecb05234552cc3fd3ad59570c18f1472`
完全相同；本轮后端依赖修复未改动 `/wx`。

## 机器可读状态声明

以下 manifest 已被 `node scripts/verify-slice-5-candidate.mjs` 接受：

该验证器只校验声明的字段集合、值域、SHA 格式和状态优先级；它不会解析 Git 对象，也不会
自行验证各 gate 的证据。因此这里的“接受”不是候选身份或 gate PASS 的独立证明。候选身份
由本记录中的 Git 查询结果约束，各项结果必须同时由后续持久证据和独立复核支持。

```json
{
  "commit": "0caa90402a44552a8c676f9611d983c3414648f2",
  "wxTree": "d942ce5a1a401e5a9ea3eecfdfc6d4796125c86e",
  "pages": 9,
  "migrations": 6,
  "check": "PASS",
  "audit": "BLOCKED_DEPENDENCY_AUDIT",
  "openapi": "PASS",
  "wechatide": "BLOCKED_TEST_ACCOUNT",
  "automator": "BLOCKED_AUTOMATOR_RC",
  "manual": "BLOCKED_PHYSICAL_UAT",
  "phone": "BLOCKED_PHYSICAL_UAT",
  "wsl": "PASS"
}
```

验证器摘要为：

```json
{
  "state": "BLOCKED_DEPENDENCY_AUDIT",
  "passedChecks": 3,
  "nonPass": [
    {
      "gate": "audit",
      "state": "BLOCKED_DEPENDENCY_AUDIT"
    },
    {
      "gate": "wechatide",
      "state": "BLOCKED_TEST_ACCOUNT"
    },
    {
      "gate": "automator",
      "state": "BLOCKED_AUTOMATOR_RC"
    },
    {
      "gate": "manual",
      "state": "BLOCKED_PHYSICAL_UAT"
    },
    {
      "gate": "phone",
      "state": "BLOCKED_PHYSICAL_UAT"
    }
  ]
}
```

## 已通过证据

### 仓库与 API

- `corepack pnpm check`：退出码 0。
- 脚本测试：218 项通过；新增 Redis RESP 分片/合包探针测试通过。
- API 测试：680 项通过、90 项按环境门禁跳过。
- API 连续构建两次通过；第二次构建删除陈旧 sentinel 并重新生成 `dist/main.js`。
- 构建产物 smoke：live 200、ready 503/database+redis down、再次 live 200、干净关闭。
- `git diff --check`：退出码 0。
- OpenAPI/MVP 路由契约测试通过。

### WSL2 真实后端

在 Ubuntu-22.04 Docker Engine 上使用唯一所有权令牌完成：

- 6 个 migration 全部应用；
- PostgreSQL/PostGIS 3.5、Redis PONG；
- `/health/live` 和 `/health/ready` 均为 HTTP 200；
- API 与 Worker 均为 `USER node` 且根文件系统只读；
- 身份隔离、城市种子、PostGIS 定位、refresh rotation/replay rejection；
- 房源列表、类型、人数、游标、房型与库存脱敏；
- 报价幂等、最后一间串行化、多晚回滚、变价/过期不占库存；
- 预订隔离、支付失败/成功幂等、取消释放、生命周期竞争、Worker 过期释放；
- Worker 连续 10 分钟每分钟均为 `Running=true`、`RestartCount=0`，无 fatal、连接故障或重连循环。

最终观察到所有权绑定的稳定与清理 marker（所有权值已脱敏）：

```text
SLICE2_RUNTIME_STABLE_10_MINUTES OWNER=[REDACTED_OWNER]
SLICE2_RUNTIME_CLEANUP_COMPLETE OWNER=[REDACTED_OWNER]
```

清理后反查：

- 本次所有权标签容器：0；
- 本次 Compose 项目容器与网络：0；
- 本次 WSL `/tmp` 验证根：不存在；
- Windows `.wsl-runtime`：不存在；
- 门禁临时目录：已删除；
- 既有 `stay-fable-wsl-validation-postgres-1`、
  `stay-fable-wsl-validation-redis-1`、`rims-postgres` 和 `vigorous_jang` 状态未改变。

## 依赖审计

- 完整审计：0 Critical、1 High、1 Moderate、0 Low；
- 生产依赖审计：0 Critical、1 High、0 Moderate、0 Low；
- Prisma 与 Nest CLI 高危链已分别在 Batch 2/3 消除；
- 2026-07-31 再次查询 npm registry：
  - `latest` 仍为 `@nestjs/swagger@11.4.6`，依赖 `js-yaml@5.2.1`；
  - `next` 为 `12.0.0-alpha.2`，peer 要求 `@nestjs/common`/`core` 为 `next`。

不采用预发布主版本、不添加第二份 `js-yaml`、不以 override 强压精确依赖。release/main
继续阻断，直到出现兼容 Nest 11 的安全 stable 版本，或取得包含批准人、到期日、缓解措施和
修复跟踪的正式风险例外。

## 微信与物理 UAT 阻断

本轮执行了：

```text
wechatide -c stay-fable-slice5 check_wechatide_status --skill-version 0.3.5
```

工具返回用户授权任务，初次及 30 秒后轮询均为 `pending`。因此未打开项目窗口、未操作页面、
未生成预览二维码，也未创建任何测试登录或原始网络证据。

即使授权恢复，现有 Automator 仍不能物理完成原生日期 picker。受信 POST ledger producer
和人工/手机验收也必须在真实测试账号、合规域名或 loopback 条件下执行。解阻前不得提交
`test(slice-5): record physical booking uat`，不得把本候选标为 READY。

## 推荐后续动作

1. 由有权限的开发者完成微信开发者工具授权并提供非生产测试号。
2. 在 loopback 模拟器或合法 HTTPS 非生产域名上执行
   `scripts/run-slice-5-uat.ps1`。
3. 使用可物理操作原生 picker 的正式能力或有时限例外，完成 Automator、人工与手机 UAT。
4. 上游 Swagger stable 解阻后，单独 TDD 升级并重新执行 audit、全量检查和 WSL2 验证。
5. 所有门禁为 PASS 后再进入 `release`；不得直接开发或合并到 `release`/`main`。

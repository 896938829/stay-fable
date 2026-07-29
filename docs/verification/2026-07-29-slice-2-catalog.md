# Slice 2：目录浏览验证

验证日期：2026-07-29–2026-07-30（Asia/Shanghai）

范围：原生微信小程序 `/wx`、PostgreSQL/PostGIS、Redis、NestJS API 和 Worker。
输入提交：`65af2512da46e6da47ab04b2cd79a0d8b5e3ad09`；对应 `/wx` tree：
`0cf64badcf937a2d4e5affaf7ed36d7b9b19cb83`。本记录仅提交验证文档和脱敏的诊断截图，
不改写 `/wx` tree。

## 结论

输入提交 `65af251` 的仓库门禁、官方微信页面与模板编译，以及 WSL2 Catalog 运行时验证已完成，
因此 Task 12 的基础证据已完成。随后兼容修复的代码基线为
`247fc9c92c7fc6dccc363445852a230b72d0420f`，仓库 tree 为
`88fccdae363ae13e177eef30a63acf7518ad798d`，对应 `/wx` tree 为
`175a7ecd2fc90d784d48b1b17044c11379580223`。

初始 `launch` 失败已由后续兼容修复越过，不能再作为当前失败点。RC 开发者工具的后续真实探针
仍显示 Automator 交互/导航分发不可靠，且当前代码基线未重新执行完整原始 Catalog Automator
命令。因此 Slice 2 的自动化物理交互状态仍为
**NOT_COMPLETE/BLOCKED_BY_RC_AUTOMATOR**（未完成）；单元测试、API/页面数据探针或诊断截图
不能代替这项用户闭环。

## 仓库门禁与审计

`corepack pnpm check` 以退出码 0 完成：workspace contract、6 页微信静态检查、Prettier、
ESLint、TypeScript、Node 验证（116/116）以及各工作区测试与生产构建均通过。API 单元/端到端
测试为 186 通过、64 个需要独立集成环境的用例跳过。

输入提交上的 `corepack pnpm audit --audit-level high` 以退出码 1 报告 30 项依赖漏洞：
2 Critical、11 High、15 Moderate、2 Low。后续代码基线的最新审计重新报告 31 项：
2 Critical、11 High、16 Moderate、2 Low。开发阶段按政策仅记录，不阻断功能开发；
release/main 因仍有 Critical/High 必须阻断，除非存在包含批准人、到期日和缓解措施的有效
风险例外。

## 数据库与 Catalog 运行时

本轮任务拥有的 PostgreSQL 中，直接只读计数为：2 个城市、6 个旅店、12 个房型、720 条日价和
720 条日库存。运行时验证确认迁移无待执行项；Catalog smoke 对杭州基线 3 家旅店、民宿筛选
1 家、3 位住客容量、每页 2 条的无重复游标分页、旅店—房型层级及库存字段脱敏均通过。

WSL 验证命令：

```powershell
pwsh -NoProfile -File scripts/wsl-runtime-validation.ps1
```

READY 前已观察到 PostGIS 3.5、Redis `PONG`、`/health/live` 和 `/health/ready` 均为 HTTP 200。
API 与 Worker 均报告 `user=node readonly=true`；身份隔离、城市 seed、PostGIS 位置解析与刷新令牌
轮换/重放拒绝 smoke 均通过。Worker 连续 10/10 分钟均为 `Running=true RestartCount=0`，未命中
脚本定义的 fatal、连接或重连循环信号，并输出 `SLICE2_RUNTIME_STABLE_10_MINUTES` 与
`SLICE2_RUNTIME_CLEANUP_COMPLETE`。任务拥有的 API、Worker、Compose 容器、网络和
`.wsl-runtime` 已清理；现有无关 `rims-postgres` 未被停止或修改。

## 微信开发者工具

Task 12 使用的 WechatIDE 桥接版本为 `0.3.5`，登录态有效且未要求 CLI token。官方工具先逐页
打开并编译
`pages/home/home`、`pages/city-select/city-select`、`pages/date-guest-select/date-guest-select`、
`pages/property-list/property-list`、`pages/property-detail/property-detail` 与
`pages/room-detail/room-detail`；随后对全部六页分别执行 WXML/WXSS 编译。12 项均成功：每个
WXML 返回 `codeLength=32400`，每个 WXSS 返回 `files=2`、`totalCodeLength=6327`。

最终运行时位于 `pages/home/home`。console 以 `error|exception|fail|inventory|pagination` 筛查、
network 以 `401|error|fail|inventory|pagination|cursor` 筛查均无命中。这只证明 Task 12 输入
经官方编译后的诊断缓冲区没有该类错误，不能代替真实 Catalog 页面流中的重复分页、401 循环或
库存展示验收。

脱敏诊断截图（不含账号、令牌、精确坐标或私有 AppID）：

- [最终官方模拟器截图](evidence/slice-2-catalog/wechat-final-diagnostic.png)
- [编译后的模拟器截图](evidence/slice-2-catalog/wechat-compile-diagnostic.png)

## 初始 Automator 失败时间线

Task 12 输入上已实际运行以下命令（证据父目录位于 `/wx` 外且预先存在）：

```powershell
$repo = (Resolve-Path '.').Path
$wxPath = (Resolve-Path 'wx').Path
$evidenceParent = (Resolve-Path 'docs/verification/evidence/slice-2-catalog').Path
node wx/automator/slice-2-catalog.js $wxPath $evidenceParent --cli-path '<DEVTOOLS_CLI>'
```

脚本安全输出为 `status=fail`、`step=launch`、`currentPage=unknown`，退出码 1；因此未生成
`catalog-*` 页面树或截图，不能虚构其相对路径。使用同一输入重现的本地诊断当时提供以下线索：

- Node 24 直接启动该 `.bat` 时返回 `EINVAL`；
- 官方 CLI 的 `auto` 帮助未列出 `--auto-port`，且携带该参数的观察只记录到 IDE HTTP 服务；
- 未观察到 Automator 需要的本地 WebSocket 自动化端口处于监听状态。

这组结果仅描述 `65af251` 时点。后续 cold-start 适配器已修复 Node 24 直接 spawn `.bat` 的
`EINVAL`，真实链路探针也已越过 `launch`，所以不得继续将 `currentPage=unknown` 写成当前失败。

## 兼容修复与后续探针

代码基线 `247fc9c` 的完整微信测试为 439/439 通过；`wx:check`、Prettier、lint、diff check 和
全仓 `check` 均有后续新鲜通过记录。独立 cleanup review 结果为 `Ready: Yes`、`remaining: 0`。
这些结果验证代码与清理边界，但不等价于当前基线上的完整原始 Automator 用户闭环。

两项兼容问题已有单元测试和真实链路探针共同验证：

- Windows cold-start 适配器绕过 Node 24 直接 spawn CLI batch 文件的 `EINVAL`；
- fixture 与 restore 跨协议返回值通过 Automator runtime 内的 JSON 重建为 plain object，避免
  协议对象原型差异破坏深比较与恢复。

在微信开发者工具 RC `2.02.2607271` 和 `miniprogram-automator@0.12.1` 的真实探针中：

- 正式 `property-list` 的页面 API、data 和旅店 UUID 可达；
- shadow `Element.tap()` 返回，但未触发 property card 导航；
- `CustomElement.callMethod()`、`Page.callMethod()` 以及 runtime evaluate 调用正式
  `openProperty()` 均未产生导航；
- 官方 `miniprogram.navigateTo()` 使用编码后的详情页 URL 时，等待 Automator 响应超时。

这些现象构成“RC legacy Automator 交互/导航分发不可靠”的可复现实证，但不足以确认完整根因，
也不能据此宣称业务页面本身的物理点击已失败。

WechatIDE MCP `fullMode` 的另一次探针为 **INCONCLUSIVE**：实际登录请求的 network status 为 0，
API 无入站；即使临时将 `urlCheck` 设为 `false` 并重新打开项目，现象仍相同。该探针尚未到达
property tap，因此不能写成 MCP tap 失败。临时配置已按原文件 SHA 精确恢复。

所有失败探针产生的临时 tree、PNG 和其他临时产物均按安全要求清理，未归档；上文两张 Task 12
官方诊断 PNG 保留。当前代码基线未重新执行完整原始 Automator 命令，因而没有该命令在
`247fc9c` 上的精确结果，也不得宣称自动化门禁已通过。

## 待执行人工或手机 UAT

当 RC Automator 仍无法稳定完成物理交互时，以下流程可作为可重复的人工/手机证据补充，但在
release 验收决定明确更新前不自动关闭 Automator 门禁：

1. 在提交 `247fc9c`、`/wx` tree `175a7ecd2fc90d784d48b1b17044c11379580223` 上固定搜索条件为
   杭州、2026-07-30 入住、2026-08-01 离店、3 位住客。
2. 点击搜索，进入旅店列表后点击第一家旅店。
3. 在旅店详情点击第一个房型，再点击“选择此房型”。
4. 核对 modal 标题为“预订功能即将开放”、正文为“报价与预订将在下一开发切片开放”，且只提供
   确认操作。
5. 关闭 modal，按房型详情 → 旅店详情 → 旅店列表 → 首页的顺序验证返回链。
6. 记录实际 commit、`/wx` tree 和每个关键节点的脱敏截图；证据不得包含账号、令牌、精确坐标或
   私有 AppID。

Slice 1 的真实定位拒绝仍是独立人工面板验收项：需在微信开发者工具授权设置中明确拒绝位置权限，
再按 [Slice 1 记录](2026-07-29-slice-1-identity-search.md) 的步骤留存实际截图。本次不把它
描述为已自动化验收。

## 最终验证结果

输入提交 `65af251` 的完整 WSL2 验证以退出码 0 完成，包含 10/10 Worker 观察和清理标志；仓库、
官方编译与 WSL2 运行时基础证据均为通过。后续 `247fc9c` 代码基线的微信测试和质量门禁也有新鲜
通过记录，但未重新执行完整原始 Automator 命令。Task 12 基础证据已完成；Slice 2 自动化物理
交互仍为 **NOT_COMPLETE/BLOCKED_BY_RC_AUTOMATOR**（未完成），该用户闭环继续作为退出阻断。

# Slice 2：目录浏览验证

验证日期：2026-07-29（Asia/Shanghai）

范围：原生微信小程序 `/wx`、PostgreSQL/PostGIS、Redis、NestJS API 和 Worker。
输入提交：`65af2512da46e6da47ab04b2cd79a0d8b5e3ad09`；对应 `/wx` tree：
`0cf64badcf937a2d4e5affaf7ed36d7b9b19cb83`。本记录仅提交验证文档和脱敏的诊断截图，
不改写 `/wx` tree。

## 结论

仓库门禁、官方微信页面与模板编译，以及 WSL2 Catalog 运行时验证已完成。真实 Catalog
Automator 未通过：当前 Windows 官方 CLI 与 `miniprogram-automator@0.12.1` 的自动化启动
协议不兼容。因没有生成真实页面树或用户闭环截图，本记录不宣称 Slice 2 完成，也不以
单元测试、手工模拟或截图替代该门禁。

## 仓库门禁与审计

`corepack pnpm check` 以退出码 0 完成：workspace contract、6 页微信静态检查、Prettier、
ESLint、TypeScript、Node 验证（116/116）以及各工作区测试与生产构建均通过。API 单元/端到端
测试为 186 通过、64 个需要独立集成环境的用例跳过。

`corepack pnpm audit --audit-level high` 以退出码 1 报告当前 30 项依赖漏洞：2 Critical、
11 High、15 Moderate、2 Low。开发阶段按政策仅记录，不阻断本次开发验证；release/main
因仍有 Critical/High 必须阻断，除非存在包含批准人、到期日和缓解措施的有效风险例外。

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

WechatIDE 版本为 `0.3.5`，登录态有效且未要求 CLI token。官方工具先逐页打开并编译
`pages/home/home`、`pages/city-select/city-select`、`pages/date-guest-select/date-guest-select`、
`pages/property-list/property-list`、`pages/property-detail/property-detail` 与
`pages/room-detail/room-detail`；随后对全部六页分别执行 WXML/WXSS 编译。12 项均成功：每个
WXML 返回 `codeLength=32400`，每个 WXSS 返回 `files=2`、`totalCodeLength=6327`。

最终运行时位于 `pages/home/home`。console 以 `error|exception|fail|inventory|pagination` 筛查、
network 以 `401|error|fail|inventory|pagination|cursor` 筛查均无命中。由于 Automator 启动失败，
这只证明官方编译后的诊断缓冲区没有该类错误，不能代替真实 Catalog 页面流中的重复分页、401
循环或库存展示验收。

脱敏诊断截图（不含账号、令牌、精确坐标或私有 AppID）：

- [最终官方模拟器截图](evidence/slice-2-catalog/wechat-final-diagnostic.png)
- [编译后的模拟器截图](evidence/slice-2-catalog/wechat-compile-diagnostic.png)

## Automator 门禁

已实际运行以下命令（证据父目录位于 `/wx` 外且预先存在）：

```powershell
$repo = (Resolve-Path '.').Path
$wxPath = (Resolve-Path 'wx').Path
$evidenceParent = (Resolve-Path 'docs/verification/evidence/slice-2-catalog').Path
node wx/automator/slice-2-catalog.js $wxPath $evidenceParent --cli-path 'D:\Soft\微信web开发者工具\cli.bat'
```

脚本安全输出为 `status=fail`、`step=launch`、`currentPage=unknown`，退出码 1；因此未生成
`catalog-*` 页面树或截图，不能虚构其相对路径。使用同一输入重现的本地非提交诊断表明：

- Node 24 直接启动该 `.bat` 时返回 `EINVAL`；
- 用官方 CLI 单独启用自动化可启动 IDE 的 HTTP 服务，但该 CLI 不支持或忽略
  `miniprogram-automator@0.12.1` 所需的 `--auto-port` 参数；
- Automator 所需的本地 WebSocket 自动化端口未监听，故启动阶段无法连接。

这是当前开发者工具 CLI 与 Automator 依赖的外部版本兼容性门禁。需要升级/匹配开发者工具与
Automator 协议后，重新执行上述原始命令并归档其真实 `catalog-*` 页面树与截图；不得以手工
模拟结果关闭该项。

Slice 1 的真实定位拒绝仍是独立人工面板验收项：需在微信开发者工具授权设置中明确拒绝位置权限，
再按 [Slice 1 记录](2026-07-29-slice-1-identity-search.md) 的步骤留存实际截图。本次不把它
描述为已自动化验收。

## 最终验证结果

完整 WSL2 验证以退出码 0 完成，包含 10/10 Worker 观察和清理标志。仓库、官方编译与 WSL2
运行时证据均为通过；Automator 用户闭环因记录的外部 CLI/协议兼容性问题未通过。因此 Slice 2
当前状态为 **DONE_WITH_CONCERNS**（验证记录与提交完成，但不代表 Slice 2 发布或用户闭环完成）。

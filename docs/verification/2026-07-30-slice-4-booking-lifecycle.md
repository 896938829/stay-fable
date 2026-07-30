# Slice 4：订单生命周期验证

验证日期：2026-07-30（Asia/Shanghai）

范围：原生微信小程序 `/wx`、PostgreSQL/PostGIS、Redis、NestJS API 和 Worker。功能输入
提交为 `334081c3333a23a4e0c18d442a0db300ab87e6e4`；全仓 lint 门禁修复提交为
`8cf8d41ffc3f0261f1f2cc5f035b840c7f850d28`。两者对应的 `/wx` tree 均为
`a6b30f4a6b41619496430cbda3067400ab1b2c01`，lint 修复没有改写小程序输入。

关联资料：

- [Slice 4 设计](../superpowers/specs/2026-07-30-wx-booking-slice-4-lifecycle-design.md)
- [Slice 4 实施计划](../superpowers/plans/2026-07-30-wx-booking-slice-4-lifecycle.md)
- [WSL2 运行验证说明](../operations/wsl-runtime-validation.md)

## 结论

全仓非安全质量门禁、微信 9 页静态门禁、三页官方 WXML/WXSS 编译、官方预览，以及唯一
一次完整 WSL2 Slice 1–4 后端验证均通过。依赖审计已执行但未通过：dev 阶段仅报告，
release/main 继续阻断。真实 PostgreSQL 验证覆盖订单查询隔离、模拟支付失败幂等、模拟
支付成功、待支付取消、支付与取消竞争，以及 Worker 关闭过期订单。Worker 连续观察
10/10 分钟均运行且重启 0。

人工和手机 UAT 未执行。稳定窗口内的唯一 Automator 物理点击在登录环境未就绪时阻断，
终态为 **BLOCKED/environment-not-ready**。因此本记录不宣称微信端订单生命周期物理闭环
通过，也不宣称既有 RC Automator 问题已修复；该门禁继续阻断 Slice 5 全流程验收收口。

## 仓库门禁与依赖审计

首次执行 `corepack pnpm check` 暴露 4 个 lint 错误并按要求停止。提交 `8cf8d41` 仅完成：

- Node 运行时全局通过 `globalThis` 显式访问；
- 删除不影响 `try/finally` cleanup 门控的无效完成标志；
- 测试显式导入 `node:buffer` 的 `Buffer`。

相关 Node 测试为 19/19 通过，cleanup 失败仍不会输出 `SLICE4_UAT_READY`。随后从
`8cf8d41` fresh 执行的 `corepack pnpm lint` 和 `corepack pnpm check` 均以退出码 0
完成；后者完整覆盖 workspace、微信静态检查、格式、lint、类型检查、测试和构建。

Task 14 的 `corepack pnpm test:wx` 为 25 个文件、579/579 用例通过；
`corepack pnpm wx:check` 确认原生微信工程共 9 页。

`corepack pnpm audit --audit-level high` 以退出码 1 报告 31 项依赖漏洞：
2 Critical、11 High、16 Moderate、2 Low。dev 阶段按政策报告而不阻断功能验证；
release/main 仍因 2 Critical 和 11 High 阻断，除非存在包含批准人、到期日和缓解措施的
有效风险例外。

## 数据库与运行时

唯一完整验证命令为：

```powershell
powershell -NoProfile -File scripts/wsl-runtime-validation.ps1 -Distro Ubuntu-22.04
```

运行结果：

- 发现 6 个迁移且无待执行项，PostGIS 3.5 正常；
- Redis 返回 `PONG`，`/health/live` 和 `/health/ready` 均为 HTTP 200；
- API 和 Worker 均为 `user=node readonly=true`；
- 身份隔离、城市 seed、PostGIS 定位、refresh rotation/replay rejection 全部通过；
- 杭州旅店、类型筛选、住客容量、游标分页、旅店—房型层级和库存字段脱敏全部通过；
- `SLICE3_QUOTE_CREATED`、`SLICE3_IDEMPOTENT_REPLAY`、
  `SLICE3_LAST_ROOM_SERIALIZED`、`SLICE3_MULTI_NIGHT_ROLLED_BACK`、
  `SLICE3_QUOTE_CHANGED_NO_HOLD`、`SLICE3_QUOTE_EXPIRED_NO_HOLD` 和
  `SLICE3_UAT_READY` 全部出现；
- `SLICE4_BOOKING_QUERY_ISOLATED`、`SLICE4_MOCK_FAILURE_IDEMPOTENT`、
  `SLICE4_MOCK_SUCCESS_CONFIRMED`、`SLICE4_CANCEL_RELEASED`、
  `SLICE4_LIFECYCLE_RACE_SERIALIZED`、`SLICE4_WORKER_EXPIRY_RELEASED` 和
  `SLICE4_UAT_READY` 全部出现；
- Worker 10/10 分钟均为 `Running=true RestartCount=0`；
- 输出 `SLICE2_RUNTIME_STABLE_10_MINUTES` 和 `SLICE2_RUNTIME_CLEANUP_COMPLETE`。

稳定窗口内只读聚合计数为：2 个城市、6 个旅店、12 个房型；fixture cleanup 后报价、
订单和支付记录均为 0。该计数没有读取或记录用户标识、请求幂等材料、库存数值或逐行明细。

任务拥有的 API、Worker、PostgreSQL 和 Redis 容器、Compose 网络及 `.wsl-runtime` 均已清理；
验证数据卷按规范保留。无关 `rims-postgres` 的容器身份、运行状态、启动时间、镜像和
`RestartCount=0` 在验证前后完全一致，未被停止或修改。

## 微信官方工具

WechatIDE skill 为 `0.3.5`，版本关系 equal，登录有效、`tokenRequired=false`；打开的是
当前 worktree 的 `/wx`。冷却后串行编译以下三页：

- `pages/booking-confirm/booking-confirm`
- `pages/order-list/order-list`
- `pages/order-detail/order-detail`

三页 WXML/WXSS 共 6/6 项成功，随后模拟器刷新成功。console 对
`error|exception|unhandled|401` 及敏感词的筛查均无命中。network 对 401、支付或取消
POST 及敏感词的筛查均无命中；当时没有连接真实后端，所以该结果只是干净基线，不能证明
写请求成功或重复 POST 门禁。

官方 `create_preview_qrcode` 只调用一次并成功，预览包为 203,746 bytes，未调用
`auto_preview`，也未上传体验版。工具曾输出 470×470、47,124 bytes 的可扫描二维码；
该文件属于凭据型访问材料，不作为脱敏证据，在记录尺寸和实际 JPEG 编码后已从临时目录删除，
文档不保留其路径或哈希。预览绑定功能输入提交；后续 lint-only 提交不改变 `/wx` tree。

模拟器脱敏截图为临时、非持久证据：

```text
C:\Users\Xpeng\AppData\Local\Temp\wechatide-simulator-screenshot-1785415618951-ihj88j.png
```

该文件为 PNG、45,834 bytes，SHA-256 为
`dd516bf506f752da12082da007f67ad86362ee4aeeeeacf8873b1cfce65594cf`。

## Automator 与物理 UAT

本次稳定窗口只执行一次允许的物理动作：在首页对 `.search-button` 单次 tap，然后等待
`.property-list-page`。等待超时后：

- 当前页仍为 home，目标 selector 数量为 0；
- POST 计数从 0 保持为 0；
- console 对 `error|exception|fail` 的命中数为 0；
- 页面显示“暂时无法登录 / 网络连接不稳定，请重试”；
- 测试账户列表为空，Automator 为 RC `0.12.1`。

两张脱敏截图是当前机器上的临时、非持久证据：

```text
C:\Users\Xpeng\AppData\Local\Temp\stay-fable-slice4-uat-8cf8d41\01-home-ready.png
C:\Users\Xpeng\AppData\Local\Temp\stay-fable-slice4-uat-8cf8d41\02-home-tap-timeout.jpg
```

第一张为 PNG、45,684 bytes，SHA-256 为
`a286bd7f05744c82f67b7253d5124b94fae8b0b6a8c7fcb997da3ea8c51f0c62`；第二张实际为 JPEG、
25,744 bytes，已将工具产生的不匹配 `.png` 扩展名更正为 `.jpg`，SHA-256 为
`2389213cff62882f13e0b01d121ff593a8cb32a97c906232a6dcf3ebb177a52e`。

失败后没有重试，没有使用 `evaluate` 或 `callMethod` 绕过物理交互，也没有继续执行写流程。
终态是 **BLOCKED/environment-not-ready**，不是业务失败或业务成功证据。人工和手机 UAT
均未执行；列表、详情、模拟失败、模拟成功、取消、连续点击单 POST 等微信端物理闭环仍为
**NOT_COMPLETE**。

## 独立复核

### 规格符合性

Slice 4 的 API/Worker 自动化 marker、微信页面静态测试、官方编译和预览证据与
[Slice 4 设计](../superpowers/specs/2026-07-30-wx-booking-slice-4-lifecycle-design.md)
一致。没有把本地格式化逻辑当作服务端状态或 `allowed_actions`，也没有加入 Slice 5 功能。
独立复核发现并关闭了“风险例外可替代物理 UAT”的越界表述；当前未发现未关闭的 Critical、
Important 或 Minor 规格问题。

### 代码质量与安全

全仓 `pnpm check` exit 0；lint 修复保持最小范围，cleanup 失败继续阻止 UAT-ready marker。
验证记录未保存 token、可扫描二维码、幂等键、用户 UUID、private AppID、精确坐标或内部
库存快照。独立复核发现的二维码处理、门禁措辞、临时证据可验证性和扩展名问题均已关闭；
允许保留的临时截图记录实际格式、大小和哈希。依赖审计仍有 2 Critical 和 11 High，
因此 release/main 持续阻断；除这些已报告的依赖发现外，未发现未关闭的 Critical、
Important 或 Minor 代码质量/证据安全问题。

### 生命周期竞争与证据

真实 PostgreSQL marker 在对应数据库断言后输出，表明支付失败重放、支付成功、取消、
支付/取消竞争和 Worker expiry 均达到预期终态；Worker 10 分钟内无重启，owner-scoped
cleanup 后 quote、booking、payment 聚合均为 0。证据仅陈述实际输出，未把
console/network 空基线或 Automator timeout 推断为物理闭环通过。未发现未关闭的
Critical、Important 或 Minor 竞争/证据问题。

## 剩余门禁

物理 UAT 仍因测试账户和登录环境未就绪而阻断。进入 Slice 5 全流程验收前必须在合规环境
补齐人工或手机闭环，并重新验证每个写动作最多一个 POST。若 RC Automator 仍阻断，须改用
合规的人工或手机 UAT 补齐物理闭环；在完成前，该门禁持续阻断 Slice 5 全流程验收收口。

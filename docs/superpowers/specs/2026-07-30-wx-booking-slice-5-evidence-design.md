# Slice 5：微信预订 MVP 全链路证据设计

日期：2026-07-30  
状态：推荐方案已采用，待实施

## 1. 目标

Slice 5 不再增加订单业务能力。它把已经完成的 Slice 1–4 固化成可重复、可审计、不会把
工具阻断误报为通过的候选验收流程：

```text
候选提交与 /wx tree 冻结
→ OpenAPI 与微信严格契约矩阵
→ 微信/后端环境预检
→ 纯物理 Automator 主流程
→ 人工或手机补充验收
→ 唯一完整 WSL2、依赖审计和最终证据
```

完成 Slice 5 必须同时关闭三个现有阻断：

1. 微信测试账户或等价合规登录环境可用；
2. 物理点击和导航可完成完整用户路径；
3. release/main 的 Critical/High 依赖漏洞已修复或具有正式风险例外。

在这些条件未满足时，Slice 5 只能是 `BLOCKED`，不能通过单元测试、编译、API verifier、
`callMethod`、`evaluate` 或关闭域名/TLS 校验替代。

## 2. 已冻结输入

- 正式客户端仅为 `/wx`；
- Slice 4 功能提交：`334081c3333a23a4e0c18d442a0db300ab87e6e4`；
- Slice 4 最终证据提交：`db22f65`；
- 当前 `/wx` tree：`a6b30f4a6b41619496430cbda3067400ab1b2c01`；
- API 使用 PostgreSQL/PostGIS、Redis、NestJS；
- Worker 负责过期待支付订单关闭与库存释放；
- 微信开发者工具 bridge 为 0.3.5，Automator 依赖为 0.12.1；
- 当前测试账户列表为空，最近一次物理尝试终态为
  `BLOCKED/environment-not-ready`。

候选验收期间若 `/wx` tree、数据库迁移、OpenAPI 路由或运行时 verifier 发生变化，所有微信
物理证据和最终 WSL 证据必须重新生成。

## 3. 非目标

- 不接入真实支付；
- 不接入生产微信身份；
- 不增加管理后台；
- 不恢复 Taro 多平台开发；
- 不关闭微信合法域名或 TLS 校验来取得真机证据；
- 不把开发态模拟支付路由暴露到 production；
- 不创建长期有效的二维码、token、幂等键或测试身份仓库证据。

## 4. 候选输入清单

创建机器可读的候选验证器，至少固定：

- Git commit 与 `/wx` tree；
- 9 个微信页面；
- 6 个数据库迁移；
- API/Worker 镜像运行用户与只读根文件系统；
- OpenAPI 必需路由；
- 微信严格契约导出；
- mock payment 的环境门禁；
- 依赖审计结果；
- Automator、人工、手机三种 UAT 的独立状态。

验证器只允许输出安全状态、计数和 commit/tree，不输出 AppID、用户或订单 UUID、测试账号、
token、幂等键、内部库存数值或精确坐标。

## 5. OpenAPI 与微信契约矩阵

Slice 5 增加一个聚合 OpenAPI 测试，不替代各模块已有测试。它固定 MVP 客户端真正消费的
路由与安全边界：

| 领域 | 路由 |
| --- | --- |
| 身份 | `/auth/wechat/login`、`/auth/session/refresh` |
| 定位 | `/location/resolve` |
| Catalog | `/properties`、`/properties/{id}`、`/room-types/{id}` |
| 报价与下单 | `/quotes`、`/bookings` |
| 生命周期 | `/bookings` GET、`/bookings/{id}`、`/bookings/{id}/cancel` |
| 开发支付 | `/dev/payments/{bookingId}/simulate`，仅显式开发开关 |

聚合测试必须断言：

- Bearer、`Idempotency-Key`、请求/响应状态和 envelope；
- production 文档与 Nest route 均不出现开发支付路由；
- booking 响应不泄露 user、hold、inventory 或内部 UUID；
- 微信 `contracts.js` 的 exact-key 响应形状与 OpenAPI 字段一致；
- 未知字段、危险对象、getter、会触发异常的 Proxy 和非法游标继续被安全拒绝；
- 原生小程序 JavaScript 无法在不执行陷阱的前提下可靠区分透明 Proxy 与普通对象，因此客户端
  契约的可信输入边界是 `wx.request` 返回的 JSON 解析值，不声称拒绝任意透明 Proxy。

不在 Slice 5 引入生成式客户端；原生微信仍使用手写严格契约。

## 6. 环境预检

物理交互前必须先完成只读预检：

```text
candidate commit/tree unchanged
→ WechatIDE version equal
→ login valid
→ exact worktree /wx window
→ test account available
→ API loopback health ready
→ current date seed window available
→ console/network baseline clean
```

终态分类：

- `READY`：所有条件满足，可以进入物理主流程；
- `BLOCKED_TEST_ACCOUNT`：没有测试号或登录环境；
- `BLOCKED_API`：loopback API 不可达或 ready 失败；
- `BLOCKED_AUTOMATOR_RC`：初始化、物理点击或导航分发失败；
- `BLOCKED_DATA_WINDOW`：执行日没有可用的确定性 seed 日期；
- `BLOCKED_PHYSICAL_UAT`：人工或手机补充 UAT 未完成；
- `BLOCKED_DEPENDENCY_AUDIT`：目标分支仍有未修复且无例外的 Critical/High；
- `FAILED_PRODUCT`：真实业务断言失败。

只有 `READY` 能进入写操作。任何 blocker 都必须在交互前停止，或在首个物理失败后立即停止。

## 7. 纯物理 Automator 主流程

Automator 脚本只能使用正式页面的物理导航和元素 tap/input：

1. 首页选择执行日 `D` 的 `D+1` 至 `D+3`、3 位住客；
2. 物理点击搜索；
3. 物理点击第一家符合条件的旅店；
4. 物理点击可订房型；
5. 获取报价并确认下单；
6. 打开订单详情；
7. 模拟失败，确认仍待支付；
8. 使用同一明确动作模拟成功，确认已确认；
9. 从订单 Tab 打开详情，GET 刷新不产生 POST；
10. 新建第二单并取消，确认已取消。

禁止：

- 使用 `Page.callMethod()`、`CustomElement.callMethod()`、runtime `evaluate` 或直接
  `navigateTo()` 代替用户点击；
- 在 selector 失败后猜测另一个绕过路径；
- 自动确认未知结果写操作；
- 在支付结果未知时生成新幂等键；
- 为证据关闭域名/TLS 校验。

### 7.1 写请求计数

每个写动作在操作前后记录脱敏计数：

- quote POST；
- booking POST；
- mock failure POST；
- mock success POST；
- cancel POST。

快速连续点击时每个动作的 POST 增量必须恰为 1。GET 刷新时 POST 增量必须为 0。原始 URL、
header 和 body 不进入证据。

### 7.2 证据产物

证据目录为临时目录，完成后只把脱敏 manifest 和必要截图复制到仓库证据目录。manifest 记录：

- schema version；
- candidate commit/tree；
- 执行日期和日期窗口；
- 工具版本；
- 每步 pass/block/fail；
- 脱敏 POST 计数；
- 截图相对路径与 SHA-256；
- cleanup 终态。

截图不得包含 AppID、测试账号、token、UUID、幂等键、精确坐标或库存数值。预览二维码属于
凭据型临时材料，只记录生成成功，随后删除。

## 8. 人工与手机 UAT

Automator 是主要门禁。人工或手机 UAT 是必要补充，覆盖：

- 实际视觉层级、按钮可点击区域和原生 modal；
- 订单列表 Tab、详情返回刷新；
- 快速连续点击；
- 登录、网络错误和未知结果提示；
- 预览包在合规 HTTPS 非生产域名上的真机表现。

若 RC Automator 仍阻断，人工或手机 UAT 仍必须完成，但不能自动替代 Automator。替代
Automator 只允许正式例外，例外必须含批准人、到期日、缓解措施和修复跟踪。当前不存在例外。

## 9. 后端与 WSL2

最终候选只执行一次完整 WSL2 验证：

- PostGIS、Redis、live/ready；
- API/Worker 为非 root、只读 rootfs；
- Slice 1–4 全部 marker；
- 支付失败重放、支付成功、取消、支付/取消竞争、Worker expiry；
- Worker 10/10 分钟、restart 0、无重连循环；
- fixture cleanup；
- `.wsl-runtime` 和临时容器清理；
- 无关容器状态不变。

稳定窗口是 Automator 和人工 UAT 的唯一 loopback 后端窗口。若物理 UAT 修改候选代码，必须
废弃该次证据并从新候选重跑。

## 10. 安全与发布门禁

- `pnpm check` 必须 exit 0；
- `pnpm audit --audit-level high` 的实际结果必须记录；
- dev 阶段漏洞报告不阻断功能开发；
- release/main 的 Critical/High 必须修复或具有正式依赖风险例外；
- 物理 UAT 没有“dev 阶段不阻断”豁免，未完成即保持 Slice 5 未完成；
- mock payment 默认关闭，production 显式拒绝启用；
- 失败诊断统一脱敏 UUID、token、Authorization 和幂等键；
- 二维码和测试登录材料不进入 Git。

## 11. 完成定义

Slice 5 只有在以下条件全部满足时才为完成：

1. 候选验证器和 OpenAPI/微信契约矩阵通过；
2. `pnpm check` 通过；
3. 依赖安全门禁满足目标分支政策；
4. Automator 主流程完成，或存在有效正式例外；
5. 人工或手机补充 UAT 完成；
6. 唯一最终 WSL2 验证完成；
7. 预览完成且二维码已删除；
8. 最终证据通过规格、质量安全、竞争与证据三重独立复核；
9. 工作树干净，分支已推送。

当前已知状态是：1–2、6–7 的 Slice 4 基础证据可复用作设计输入；3、4、5 仍未满足，因此
Slice 5 不能标记完成。

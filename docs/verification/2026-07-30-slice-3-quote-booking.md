# Slice 3：报价与并发安全下单验证

验证日期：2026-07-30（Asia/Shanghai）

范围：原生微信小程序 `/wx`、PostgreSQL/PostGIS、Redis、NestJS API 和 Worker。
功能输入提交：`30899a206f7074d1e968501a2b24ef6f765cd925`；对应 `/wx` tree：
`a93cde5f9191829d280cad5d89318ed3575c2527`。后续验证文档和 WSL 失败诊断增强不改写
该 `/wx` tree。

## 结论

仓库质量门禁、微信官方 WXML/WXSS 编译和完整 WSL2 Slice 1–3 运行时门禁均通过。真实
PostgreSQL 验证覆盖报价日期投影、幂等下单、最后一间房并发串行化、多晚原子回滚，以及
价格变化和报价过期不占库存；Worker 连续观察 10 分钟且重启 0。

微信开发者工具内已完成登录恢复、日期与人数保存，以及首页到杭州旅店列表的真实请求。
RC Automator 仍无法穿透自定义组件完成旅店卡片物理点击；其导航接口还出现“返回成功但页栈
不变化”的既有 RC 类问题。因此正常报价、重复点击确认和待支付摘要的人工/手机物理闭环
**NOT_COMPLETE/BLOCKED_BY_RC_AUTOMATOR**，没有截图或 network 证据时不虚构通过。
该闭环继续保留在 Slice 5 UAT 台账，当前记录不是发布豁免。

## 仓库门禁与依赖审计

`corepack pnpm check` 以退出码 0 完成。当前 API 测试为 483 通过、79 个需要
独立集成环境的用例跳过；新增真实 PostgreSQL 集成文件随后 53/53 通过。新增用例在同一
Prisma 事务连接内将时区设为 `Pacific/Auckland`，覆盖 `2030-01-31` 至 `2030-02-02`
跨月区间，并严格得到 `YYYY-MM-DD`。

`corepack pnpm test:wx` 为 21 个文件、491/491 用例通过；`corepack pnpm wx:check`
确认原生微信工程共 7 页。

`corepack pnpm audit --audit-level high` 以退出码 1 报告 31 项依赖漏洞：2 Critical、
11 High、16 Moderate、2 Low。dev 阶段按政策记录而不阻断功能开发；release/main 仍因
Critical/High 阻断，除非存在包含批准人、到期日和缓解措施的有效风险例外。

## 数据库与运行时

验证数据卷清理业务 smoke 数据后的只读聚合计数为：2 个城市、6 个旅店、12 个房型、
720 条日价、720 条日库存，报价、订单、库存占用和订单状态历史均为 0。计数过程没有读取
用户 UUID、幂等键或库存明细。

完整验证命令：

```powershell
powershell -NoProfile -File scripts/wsl-runtime-validation.ps1 -Distro Ubuntu-22.04
```

验证结果：

- 5 个迁移已应用且无待执行项，PostGIS 3.5 正常；
- Redis 返回 `PONG`，`/health/live` 和 `/health/ready` 均为 HTTP 200；
- API 和 Worker 均为 `user=node readonly=true`；
- 身份隔离、城市 seed、PostGIS 定位、refresh rotation/replay rejection 全部通过；
- 杭州旅店、类型筛选、住客容量、游标分页、旅店—房型层级和库存字段脱敏全部通过；
- `SLICE3_QUOTE_CREATED`、`SLICE3_IDEMPOTENT_REPLAY`、
  `SLICE3_LAST_ROOM_SERIALIZED`、`SLICE3_MULTI_NIGHT_ROLLED_BACK`、
  `SLICE3_QUOTE_CHANGED_NO_HOLD` 和 `SLICE3_QUOTE_EXPIRED_NO_HOLD` 全部出现；
- Worker 10/10 分钟均为 `Running=true RestartCount=0`；
- 输出 `SLICE2_RUNTIME_STABLE_10_MINUTES` 和 `SLICE2_RUNTIME_CLEANUP_COMPLETE`。

任务拥有的 API、Worker、Compose 容器、网络和 `.wsl-runtime` 已清理，验证数据卷按规范
保留。无关 `rims-postgres` 在验证前后均保持 healthy，未被停止或修改。

## 微信开发者工具

WechatIDE skill 版本为 `0.3.5`，版本关系 equal，登录有效且不需要 CLI token；打开的是当前
worktree 的 `/wx`。`pages/room-detail/room-detail` 和
`pages/booking-confirm/booking-confirm` 的 WXML/WXSS 共 4 项官方编译均成功，随后模拟器
刷新成功。

模拟器在 WSL 稳定窗口内恢复会话后，以执行日 `D=2026-07-30` 设置
`D+1=2026-07-31` 入住、`D+3=2026-08-02` 离店和 3 位住客。保存后首页正确显示 2 晚，
点击“搜索旅店”真实返回杭州 3 家全程可售旅店，覆盖酒店、民宿和农家乐。

console 以 `error|exception|unhandled|401` 筛查无命中。network 仅针对 loopback 的
`/api/v1/quotes` 和 `/api/v1/bookings` 筛查无命中；这与物理路径在旅店卡片处被 RC
Automator 阻塞一致，不能解释为报价或下单成功，也不能证明重复 POST 门禁。

尝试进一步物理交互时保留以下脱敏结论：

- Automator 页面选择器看不到 `property-card` 自定义组件内部点击目标；
- 页面导航和 `wx.navigateTo` 调用曾返回 success/`navigateTo:ok`，但运行时页栈未变化；
- 官方 `simulator_open_page` 短暂报告详情路由后回到首页；
- console 未提供 runtime exception，可归类为既有 RC Automator 交互/导航分发债务，
  不能据此归咎业务页面。

未生成可证明报价/下单闭环的脱敏截图，因此本记录不创建或引用不存在的图片。

## 待补人工或手机 UAT

在 Slice 5 候选提交上启动同一 WSL 稳定窗口后，必须补齐：

1. 以执行日 `D` 选择杭州、`D+1` 入住、`D+3` 离店和 3 位住客；
2. 物理点击旅店、UAT 保留房型和“确认价格并预订”；
3. 核对服务端逐晚价格、总价、5 分钟有效期和预订政策；
4. 连续点击确认，network 只能有一个 booking 写请求；
5. 核对待支付摘要，且页面不调用支付、不宣称库存已自动释放；
6. 保存候选 commit、`/wx` tree、实际日期和脱敏截图。

若 RC 工具仍阻断，只有包含批准人、到期日、缓解措施和修复跟踪的正式例外才能替代
Automator 门禁；当前不存在该例外。

## 安全与清理

验证记录没有保存 token、幂等键、用户 UUID、精确坐标、private AppID 或内部库存快照。
WSL 失败诊断只在 Slice 3 verifier 失败时打印 API/Worker 容器状态和最近 200 行日志，
成功路径不输出诊断；应用日志已有认证头脱敏，诊断文本不作为仓库证据归档。

当前 Slice 3 的仓库、官方编译和后端并发运行时证据均通过；人工/手机物理闭环仍为
**NOT_COMPLETE/BLOCKED_BY_RC_AUTOMATOR**，继续作为 Slice 5 发布前门禁。

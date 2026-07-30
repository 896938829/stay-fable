# 微信预订切片 4：订单生命周期设计

日期：2026-07-30  
状态：已按“MVP 总线路图需要选择时采用推荐方案”的持续授权选定推荐方案  
范围：模拟支付、待支付取消、订单列表/详情、Worker 超时释放、原生微信双 Tab

## 1. 目标

Slice 4 把 Slice 3 创建的 `PENDING_PAYMENT` 订单推进为可查询、可取消、可在开发环境模拟
支付，并由 Worker 自动关闭超时订单。完成后，用户可以走通：

```text
旅店 → 房型 → 服务端报价 → 幂等下单
→ 订单详情 → 模拟支付成功 → 已确认
```

同时支持：

```text
待支付订单 → 用户取消 → 库存释放
待支付订单 → 15 分钟到期 → Worker 关闭 → 库存释放
模拟支付失败 → 保持待支付 → 可再次操作
```

本切片不实现真实微信支付、退款、支付回调验签、支付对账、优惠券、发票、入住人资料、
订单评价、客服系统或管理后台。真实支付仍属于后续里程碑。

## 2. 已有基线

- `/wx` 是唯一正式用户端，当前有 7 个页面。
- Slice 3 已有 5 分钟报价、15 分钟 `PENDING_PAYMENT` 订单、逐晚 `HELD` 占用、严格
  响应契约和用户归属。
- `booking` 已预留 `PAID`、`CONFIRMED`、`CANCELLED`、`CLOSED`。
- `inventory_hold` 已预留 `CONSUMED` 和 `RELEASED`。
- `booking_status_history` 已支持 `USER`、`SYSTEM` 操作者。
- Worker 当前运行 BullMQ system worker，但尚未访问 PostgreSQL 或执行订单任务。
- 运行配置已经保证生产环境 `ENABLE_MOCK_PAYMENT=true` 时启动失败。
- RC Automator 对自定义组件 shadow 点击和导航分发仍不可靠，完整物理路径继续是
  Slice 5 门禁。

## 3. 方案比较与选择

### 3.1 方案 A：PostgreSQL 主导的直接扫描（采用）

API 在数据库事务中处理模拟支付和取消；Worker 周期性直接扫描 PostgreSQL，使用
`FOR UPDATE SKIP LOCKED` 逐个领取过期订单。

优点：

- `booking.expires_at` 是唯一到期事实来源；
- Worker 停机后恢复即可补扫，不需要重建延迟任务；
- 多 Worker 通过数据库行锁安全竞争；
- 可与 API 支付/取消使用相同锁顺序和状态约束；
- 符合当前 PostgreSQL 是订单、支付和库存事实来源的架构。

代价是 Worker 增加 PostgreSQL 连接和独立的过期订单 repository。

### 3.2 方案 B：每单一个 BullMQ 延迟任务（不采用）

下单后投递 15 分钟延迟任务。它直观，但必须解决数据库提交与队列投递的原子性、队列数据
丢失后的补偿、重复任务、延迟漂移和历史订单重建。MVP 不引入 outbox，因此不采用。

### 3.3 方案 C：延迟任务加数据库兜底扫描（不采用）

正常路径使用 BullMQ 延迟任务，另设 PostgreSQL 扫描兜底。可靠性较高，但同时维护两套触发
机制，测试矩阵和运维复杂度不适合当前切片。

## 4. 总体架构

```text
微信订单列表/详情
        │
        ▼
GET /bookings / GET /bookings/:id
POST /bookings/:id/cancel
POST /dev/payments/:id/simulate
        │
        ▼
BookingQueryService / BookingLifecycleService
        │
        ▼
PostgreSQL booking/payment/hold/inventory/history
        ▲
        │
BookingExpirySweeper
        ▲
        │
Job Worker 周期扫描
```

API 和 Worker 不通过 Redis 锁协调生命周期。Redis 继续用于会话、写限流和现有 system queue；
订单状态与库存互斥只依赖 PostgreSQL 事务、固定锁顺序、条件更新和唯一约束。

API 的创建订单 repository 保持独立。Slice 4 新建查询和生命周期 repository，避免继续扩大
现有 `booking.repository.ts`。Worker 拥有专门的过期扫描 repository，不依赖 API 应用包。
两端通过相同数据库约束、锁顺序和集成测试维持一致性，不建立 API → Worker 或 Worker → API
运行时调用。

## 5. 状态机

### 5.1 允许的转换

```text
PENDING_PAYMENT --模拟成功--> PAID --同事务--> CONFIRMED
PENDING_PAYMENT --用户取消--> CANCELLED
PENDING_PAYMENT --超时关闭--> CLOSED
```

`PAID` 是同一支付事务内的可审计中间状态。API 成功响应只返回最终 `CONFIRMED`，不会把
`PAID` 暴露为需要用户刷新才能继续的稳定页面状态。

### 5.2 禁止的转换

- `CONFIRMED` 不能在本切片取消或再次支付；
- `CANCELLED`、`CLOSED` 不能支付；
- `CANCELLED` 重复取消返回原订单，不能再次释放库存；
- `CLOSED` 不接受用户取消；
- 模拟失败不改变订单状态和库存占用；
- Worker 对任何非 `PENDING_PAYMENT` 订单都是安全 no-op。

### 5.3 到期语义

支付和取消事务都捕获一次可信 `now`。若订单仍是 `PENDING_PAYMENT` 但
`expires_at <= now`，该事务先按 `SYSTEM/PAYMENT_TIMEOUT` 关闭并释放库存，再返回
`BOOKING_EXPIRED`。这样用户不能在逻辑到期后抢在 Worker 前支付或取消。

订单查询不产生写入。极短窗口内查询到“数据库仍待支付但已经到期”的订单时：

- 返回数据库状态 `PENDING_PAYMENT`；
- `payment_deadline_passed=true`；
- `allowed_actions=[]`；
- 微信端显示“付款时间已结束，正在关闭订单”。

Worker 下一次扫描会把它转换为 `CLOSED`。

## 6. 事务与锁顺序

所有支付、取消和超时事务必须使用以下顺序：

1. 支付请求先取得 `(booking_id, idempotency_key)` 的事务级 advisory lock；
2. `booking FOR UPDATE`，API 查询同时包含当前 `user_id`；
3. 支付请求查询已有同键 `payment`；
4. `inventory_hold` 按 `business_date ASC, id ASC FOR UPDATE`；
5. `daily_inventory` 按 `business_date ASC FOR UPDATE`；
6. 执行条件更新；
7. 写 payment、booking 和 status history；
8. 提交。

取消和 Worker 不需要支付 advisory lock，但从第 2 步开始保持同一顺序。任何逐晚数据缺失、
状态不一致或条件更新影响行数错误都回滚整个事务并返回安全服务错误。

### 6.1 模拟支付成功

在一个事务中：

1. 验证订单属于当前用户、为 `PENDING_PAYMENT` 且未到期；
2. 验证每晚占用都是 `HELD`，数量与入住晚数一致；
3. 每晚条件更新 `held_inventory - 1`、`sold_inventory + 1`；
4. 将每晚占用改为 `CONSUMED`；
5. 创建 `SUCCEEDED` payment；
6. 订单 `PENDING_PAYMENT → PAID`，写 `USER/MOCK_PAYMENT_SUCCEEDED`；
7. 订单 `PAID → CONFIRMED`，写 `SYSTEM/PAYMENT_CONFIRMED`；
8. 返回最终订单详情。

数据库约束继续保证：

```text
held_inventory >= 0
sold_inventory >= 0
held_inventory + sold_inventory <= total_inventory
```

### 6.2 模拟支付失败

事务锁定订单并确认仍可支付，创建一个 `FAILED` payment，订单和库存保持不变。接口返回
`409 MOCK_PAYMENT_FAILED`。同一幂等键重放返回同一业务错误，不创建第二条 payment。

### 6.3 用户取消

事务确认当前用户拥有订单：

- `PENDING_PAYMENT` 且未到期：逐晚 `held_inventory - 1`，占用改为 `RELEASED`，
  订单改为 `CANCELLED`，写 `USER/USER_CANCELLED`；
- 已 `CANCELLED`：返回当前详情，标记 replay；
- 已到期：按系统超时流程关闭，然后返回 `BOOKING_EXPIRED`；
- 其他状态：返回 `BOOKING_NOT_CANCELLABLE`。

取消接口本身是状态幂等操作，不要求 `Idempotency-Key`。微信端遇到不确定网络结果时先 GET
详情对账，再决定是否允许用户再次取消。

### 6.4 Worker 超时释放

Worker 每轮最多处理 25 个订单，每个订单使用独立事务：

```sql
SELECT id
FROM booking
WHERE status = 'PENDING_PAYMENT'
  AND expires_at <= $captured_now
ORDER BY expires_at ASC, id ASC
FOR UPDATE SKIP LOCKED
LIMIT 1;
```

选中后在同一事务锁定占用和库存，逐晚释放，订单改为 `CLOSED`，写
`SYSTEM/PAYMENT_TIMEOUT`。随后提交并开始下一单。单个订单失败只回滚该订单，记录安全结构化
日志并继续本轮其他订单。

多个 Worker 同时运行时，`SKIP LOCKED` 保证同一订单只有一个事务处理。已被 API 支付或取消
锁定的订单会被跳过，下一轮根据最终状态决定是否处理。

## 7. 数据模型

新增枚举：

```text
PaymentProvider: MOCK
PaymentStatus: SUCCEEDED | FAILED
MockPaymentOutcome: SUCCEED | FAIL
```

新增 `payment`：

| 字段 | 约束 |
| --- | --- |
| `id` | UUID 主键 |
| `booking_id` | 关联 booking，删除 Restrict |
| `payment_number` | `SFP` + 8 位日期 + 12 位大写十六进制，唯一 |
| `provider` | Slice 4 固定 `MOCK` |
| `status` | `SUCCEEDED` 或 `FAILED` |
| `requested_outcome` | `SUCCEED` 或 `FAIL` |
| `amount_cents` | 非负整数，必须等于订单金额 |
| `currency` | 固定 `CNY` |
| `idempotency_key` | 32–80 位安全字符 |
| `processed_at` | UTC timestamptz |
| `created_at` | UTC timestamptz |

约束和索引：

- `(booking_id, idempotency_key)` 唯一；
- `payment_number` 唯一；
- 每个订单最多一个 `SUCCEEDED` payment，使用 partial unique index；
- `SUCCEED` 必须对应 `SUCCEEDED`，`FAIL` 必须对应 `FAILED`；
- `(booking_id, created_at DESC, id DESC)` 索引；
- `amount_cents >= 0`、`currency = 'CNY'`；
- payment number 和幂等键使用数据库正则约束。

`booking`、`inventory_hold`、`booking_status_history` 不新增业务字段。Prisma relation 增加
`Booking.payments`。

## 8. API 契约

所有响应继续使用全局 envelope 和 `request_id`。所有对象严格拒绝未知字段。

### 8.1 订单列表

```text
GET /api/v1/bookings?limit=10&cursor=<opaque>
```

- `limit` 范围 1–20，默认 10；
- 固定按 `created_at DESC, id DESC`；
- cursor 只编码经过验证的 `created_at` 和 `id`；
- repository 始终包含当前 `user_id`；
- 返回 `{ items, next_cursor }`；
- 不支持状态筛选、搜索或排序切换。

列表项：

```text
booking_id
booking_number
status
property_name
room_type_name
checkin
checkout
nights
guests
total_price_cents
currency
expires_at
payment_deadline_passed
created_at
updated_at
```

列表不返回 quote ID、用户 ID、幂等键、逐晚占用或内部库存。

### 8.2 订单详情

```text
GET /api/v1/bookings/:bookingId
```

详情在列表字段基础上增加：

```text
nightly_prices
booking_policy
latest_payment
status_history
allowed_actions
```

`latest_payment` 为 `null` 或：

```text
payment_number
status
processed_at
```

`status_history` 不返回 `actor_user_id`，只返回：

```text
from_status
to_status
reason
actor_type
created_at
```

`allowed_actions` 是以下值的有序子集：

```text
CANCEL
MOCK_PAY_SUCCESS
MOCK_PAY_FAILURE
```

只有未到期 `PENDING_PAYMENT` 才允许操作。两个 mock action 还要求当前运行时显式启用模拟支付。

### 8.3 取消

```text
POST /api/v1/bookings/:bookingId/cancel
Body: {}
```

首次取消返回 200 和最终订单详情；重复取消同样返回 200。请求不自动重试。

### 8.4 模拟支付

```text
POST /api/v1/dev/payments/:bookingId/simulate
Idempotency-Key: <32–80 chars>
Body: { "outcome": "SUCCEED" | "FAIL" }
```

- 仅在 `NODE_ENV != production && ENABLE_MOCK_PAYMENT=true` 时注册 controller；
- 生产环境开关为 true 继续在启动阶段失败；
- 首次成功支付返回 201 和最终订单详情；
- 同键成功重放返回 200；
- 首次或重放失败返回 409 `MOCK_PAYMENT_FAILED`；
- 同键改用不同 outcome 返回 `IDEMPOTENCY_KEY_REUSED`；
- 不同键操作已处理订单返回 `BOOKING_ALREADY_PROCESSED`。

### 8.5 稳定错误

新增或正式使用：

```text
BOOKING_NOT_FOUND
BOOKING_NOT_CANCELLABLE
BOOKING_EXPIRED
BOOKING_ALREADY_PROCESSED
ORDER_CURSOR_INVALID
PAYMENT_REQUEST_INVALID
IDEMPOTENCY_KEY_REUSED
MOCK_PAYMENT_FAILED
BOOKING_LIFECYCLE_UNAVAILABLE
```

越权读取、支付或取消统一返回 `BOOKING_NOT_FOUND`，不透露资源是否存在。数据库、Redis、
Worker 和第三方原始错误不得进入响应。模拟支付未启用时 controller 不注册，外部表现为普通
404，不返回可用于探测环境功能开关的专用业务错误。

## 9. 写限流

在现有 Redis 写限流服务增加：

- cancel：每用户每 60 秒最多 6 次；
- mock payment：每用户每 60 秒最多 10 次。

限流 key 只包含现有环境前缀、操作名和用户 ID 的不可逆摘要，不包含 booking ID、支付号或
幂等键。Redis 不可用时写操作失败关闭并返回生命周期服务不可用，不绕过限流。

## 10. Worker 设计

### 10.1 配置

Worker 新增：

```text
DATABASE_URL
BOOKING_EXPIRY_POLL_MS（默认 5000，范围 1000–60000）
```

Worker 对 PostgreSQL URL 执行与 API 同等级的协议和生产 TLS 校验。日志和异常不得输出带凭据
的 URL。WSL 运行时把验证数据库 URL 注入 Worker。

### 10.2 资源

`createSystemWorker` 返回并由 shutdown 关闭：

- BullMQ worker；
- Redis connection；
- PostgreSQL pool；
- `BookingExpirySweeper`。

Sweeper 不允许重叠 tick；上一轮未结束时不启动下一轮。关闭时停止新 tick，等待当前独立事务
有界完成，再关闭 pool。启动和关闭都要支持单元测试注入 fake clock、timer、pool 和 logger。

### 10.3 日志

允许记录：

```text
event
processed_count
failed_count
duration_ms
booking_number（单项失败时）
安全错误分类
```

禁止记录：

```text
DATABASE_URL
用户 ID
booking UUID
payment UUID
Idempotency-Key
完整订单/支付对象
```

## 11. 微信端

### 11.1 导航

`app.json` 增加：

```text
pages/order-list/order-list
pages/order-detail/order-detail
```

并增加原生双 Tab：

```text
首页 → pages/home/home
订单 → pages/order-list/order-list
```

使用仓库内本地普通/选中 PNG 图标，不依赖远程资源。Tab 色彩沿用暖色主题。进入订单 Tab 使用
`switchTab`；订单列表进入详情使用 `navigateTo`。

### 11.2 预订确认页收口

订单创建成功状态改为：

- 主按钮“查看订单”，使用 `redirectTo` 打开本订单详情；
- 次按钮“查看全部订单”，使用 `switchTab`；
- 不再显示“下一切片开放”。

booking ID 只保存在当前页面内存和路由参数，不写同步 storage。

### 11.3 订单列表页

页面直接渲染普通 `view/button`，不引入带 shadow 点击层的订单卡片组件。它覆盖：

- 首次加载；
- 空订单；
- 列表；
- 首屏失败；
- 加载更多；
- footer 失败；
- 到底；
- 下拉刷新；
- `onShow` 从详情返回后的安全刷新。

每项展示状态、旅店、房型、日期、总价和剩余付款时间。点击使用普通页面按钮，便于官方
Automator 选择器直接访问。

### 11.4 订单详情页

详情展示：

- 订单号和状态；
- 旅店、房型、日期、晚数、人数；
- 逐晚价格、总价、预订政策；
- 状态时间线；
- 最新支付结果；
- 服务端 `allowed_actions` 对应操作。

开发模拟按钮明确标记：

```text
模拟支付成功（开发）
模拟支付失败（开发）
```

生产或开关关闭时服务端不返回这两个 action，页面不得通过本地环境猜测显示。

取消前显示确认 modal。支付、失败模拟和取消执行中锁定所有写按钮，连续点击最多发一个请求。

### 11.5 不确定结果

- GET 查询可手动重试；
- 支付和取消不自动重试；
- 模拟支付使用 `payment:<bookingId>:<outcome>` 内存幂等 scope；
- 网络/未知支付失败保留 scope，页面显示“支付结果待确认”；
- 收到成功、`MOCK_PAYMENT_FAILED`、`BOOKING_EXPIRED` 或
  `BOOKING_ALREADY_PROCESSED` 后清除对应 scope；
- 取消遇到网络未知结果时先 GET 详情对账；
- 页面隐藏、卸载和晚到响应使用 generation/cancel gate，不能写回旧页面；
- 冷启动不恢复支付幂等键，先 GET 订单状态；已确认或终态不再提交写请求。

## 12. 防御性与安全

- 所有订单 repository 查询包含当前用户归属或只由 Worker 使用；
- path、query、body、header 和数据库返回均严格验证；
- lifecycle SQL 使用 Prisma tagged SQL 或 `pg` 参数，不拼接用户输入；
- payment number 使用加密安全随机数并由数据库唯一约束兜底；
- 完整订单、支付、幂等键和内部库存不写应用日志；
- logger redaction 继续覆盖 `Authorization` 和 `Idempotency-Key`；
- 微信 storage 不保存 token、订单对象、payment 对象或幂等键；
- mock controller 在禁用环境中不存在；不能只靠客户端隐藏；
- `ENABLE_MOCK_PAYMENT=false` 保持 `.env.example` 默认值；
- WSL Slice 4 验证显式临时开启 mock payment，结束后不改写默认配置。

## 13. 测试策略

### 13.1 契约和单元测试

- 全部订单状态的列表/详情严格解析；
- cursor、unknown fields、危险对象、越界数组和非法时间拒绝；
- allowed actions 与状态、到期和 mock 开关一致；
- payment number 和幂等键生成；
- 支付/取消错误映射；
- 微信列表分页、详情状态机、倒计时、重复点击、generation 和不确定结果；
- mock 开关关闭时 UI 不显示开发操作。

### 13.2 真实 PostgreSQL 集成测试

- 当前用户只能读取自己的列表和详情；
- cursor 无重复、无遗漏、跨用户隔离；
- 模拟成功只产生一个成功 payment，库存从 held 转 sold；
- 同键成功重放不重复 payment、库存或历史；
- 同键换 outcome 被拒绝；
- 模拟失败记录一次且订单仍待支付；
- 取消释放全部晚次且重复取消不二次释放；
- Worker 关闭过期订单且重复运行安全；
- 两个 Worker 同时扫描只处理一次；
- 支付与取消并发只有一个终态；
- 支付与 Worker 并发只有一个终态；
- 多晚任一数据异常时整体回滚；
- 越权读、支付、取消不泄露订单存在性。

测试使用真实 PostgreSQL/PostGIS 和随机 schema，不用 SQLite 模拟锁。

### 13.3 Worker

- 配置协议、TLS、轮询范围和敏感 URL 错误脱敏；
- tick 不重叠；
- 每单独立事务；
- 单单失败不阻断下一单；
- shutdown 停止 timer 并关闭全部资源；
- 日志不包含 UUID、用户、URL 凭据或幂等键。

### 13.4 WSL2

扩展现有唯一完整验证：

1. migration、seed、PostGIS、Redis、live/ready；
2. API/Worker 非 root、只读根文件系统；
3. Slice 1–3 markers；
4. 订单列表/详情和用户隔离；
5. 模拟失败与同键重放；
6. 模拟成功与库存 held → sold；
7. 取消与重复取消；
8. 支付/取消竞争；
9. 实际 Worker 关闭人为置为过期的待支付订单；
10. Worker 10/10 分钟、restart 0；
11. 清理测试用户、订单、payment、history、hold，并恢复库存；
12. 保留 Compose 数据卷和无关 `rims-postgres`。

### 13.5 微信官方工具与 UAT

- `pnpm test:wx`、`pnpm wx:check`；
- order-list、order-detail、booking-confirm WXML/WXSS 官方编译；
- console 无 runtime exception/401 循环；
- network 每个写动作最多一个 POST；
- 开发模拟失败、成功、取消和订单刷新；
- 生成一次预览，不上传体验版；
- RC Automator 仍失败时如实记录，完整物理闭环继续作为 Slice 5 门禁。

## 14. 实施切片

按依赖顺序实施：

1. 共享契约与 migration/payment 模型；
2. 订单列表/详情查询；
3. 生命周期 repository、取消和 mock payment；
4. Worker PostgreSQL sweeper；
5. 微信订单 service 与严格响应验证；
6. 双 Tab、订单列表和详情页；
7. booking-confirm 成功入口收口；
8. WSL Slice 4 verifier、官方编译、证据和独立复核。

每个任务遵循测试先行和原子提交。功能开发期间漏洞只报告；release/main 仍阻断未例外的
Critical/High。

## 15. 完成标准

Slice 4 完成必须同时满足：

- 用户只能看到自己的订单列表和详情；
- 开发模拟失败不改变订单/库存，成功后订单最终为 `CONFIRMED`；
- 成功支付把每晚 held 转为 sold，且只执行一次；
- 待支付取消把每晚 hold 释放，重复取消不二次调整；
- Worker 自动关闭过期订单，两个 Worker 不重复处理；
- 支付、取消和 Worker 竞争不会产生双终态、负库存或部分晚次更新；
- mock payment 在生产强制禁用，禁用时路由不注册；
- 微信有“首页 / 订单”双 Tab 和可操作订单详情；
- 全仓检查、真实 PostgreSQL、WSL2、官方微信编译和证据记录通过；
- RC Automator 或人工/手机 UAT 未完成时继续明确阻断 Slice 5 发布门禁，不伪造验收。

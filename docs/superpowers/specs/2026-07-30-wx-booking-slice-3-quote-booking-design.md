# 微信预订切片 3：报价与并发安全下单设计

状态：按已确认 MVP 总规格和推荐方案进入实施规划  
日期：2026-07-30  
依据：

- `docs/superpowers/specs/2026-07-29-wx-mvp-booking-vertical-slice-design.md`
- `docs/superpowers/specs/2026-07-29-wx-booking-slice-2-catalog-design.md`
- `docs/superpowers/plans/2026-07-29-wx-booking-mvp-roadmap.md`

## 1. 目标

Slice 3 让用户从房型详情进入预订确认页，获得服务端生成、5 分钟有效的报价，并创建
15 分钟有效的待支付订单。数据库必须保证：

- 同一报价最多创建一个订单；
- 同一用户和幂等键的并发请求只产生一个订单；
- 两个用户争抢最后一间房时只成功一个；
- 多晚订单任一晚不可售时整笔事务回滚；
- 客户端展示价格、重复点击或网络重放都不能决定最终金额和库存。

Slice 3 不实现模拟支付、取消、订单列表、订单详情或 Worker 超时释放。这些属于 Slice 4。
成功下单后，预订确认页原地显示待支付订单摘要，不创建伪支付页。

## 2. 前置状态与边界

Slice 2 已提供：

- 登录用户和 Redis 会话；
- 城市、日期、人数搜索上下文；
- 旅店、房型、逐晚展示价格和每日库存；
- PostgreSQL/PostGIS、API、Worker 的 WSL2 运行基线；
- `/wx` 的严格契约、防御性请求层和密码学幂等键工具。

Slice 2 的 RC Automator 物理点击门禁仍为
`NOT_COMPLETE/BLOCKED_BY_RC_AUTOMATOR`。它已登记到 Slice 5 UAT，不改变 Slice 3
的数据一致性、微信官方编译和 WSL2 并发门禁。Slice 3 修改房型选择流程后，Slice 5
必须验收更新后的完整路径。

本切片不包含：

- 微信真实支付、模拟支付、退款或关单；
- 待支付订单取消和超时释放；
- 订单列表与订单详情页；
- 优惠券、税费、服务费、多币种、发票或入住人证件；
- 商家确认模式、管理后台和多平台客户端；
- Redis 分布式库存锁。

## 3. 方案选择

### 3.1 方案 A：数据库报价快照 + PostgreSQL 行锁（采用）

报价保存为 PostgreSQL 行，包含逐晚价格、政策和展示快照，5 分钟失效。下单事务重新读取
实时价格和房型状态，按日期升序锁定 `daily_inventory`，再创建订单和逐晚占用。

优点：

- 报价归属、有效期和价格变化可审计；
- 与订单、库存和状态历史共享清晰的事务边界；
- 并发、重放、过期和多晚回滚可在真实 PostgreSQL 中直接验证；
- Slice 4 可以复用订单、占用和状态历史。

代价是多一张报价表和定期清理需求。过期报价本轮只按查询条件失效，不要求 Worker 物理删除。

### 3.2 方案 B：无状态签名报价令牌（不采用）

服务端签名逐晚价格和有效期，客户端下单时回传令牌。它减少报价行，但撤销、用户归属、
政策版本、密钥轮换和问题审计更复杂，也不利于返回结构化替代报价。

### 3.3 方案 C：生成报价时立即占库存（不采用）

报价同时创建短期占用。它可以提高下单成功率，但会让浏览和确认阶段过早占房，放大恶意
请求、用户放弃和回收压力，并把 Slice 4 的过期处理提前耦合进 Slice 3。

## 4. 用户体验

### 4.1 房型详情

现有“选择此房型”按钮不再显示“下一切片开放”的提示。点击后导航到：

```text
pages/booking-confirm/booking-confirm?room_type_id=<UUID>
```

页面不从 URL 接收价格、日期、人数或旅店信息。它只接收严格 UUID，日期和人数从共享
`searchStore` 读取，所有展示数据由报价响应提供。

### 4.2 预订确认页

页面状态固定为：

```text
loading_quote
quote_ready
quote_error
quote_changed
submitting
booking_created
booking_error
```

`quote_ready` 展示：

- 旅店和房型名称；
- 入住、离店、晚数和人数；
- 每晚销售价与划线价；
- 人民币总价；
- 预订政策；
- 报价失效时间和剩余时间提示。

页面不自行合计价格。总价、晚数和逐晚明细都使用服务端响应。倒计时只控制按钮和提示，
不能延长服务端有效期。

### 4.3 提交与重复点击

“确认下单”按钮只在 `quote_ready` 且本地时间尚未到 `expires_at` 时可用。

- 首次提交为当前 `quote_id` 取得一个密码学随机幂等键；
- 同一报价提交进行中时重复点击不发第二个请求；
- 网络层不自动重试 `POST /bookings`；
- 登录续期后的单次受控 replay 保留相同幂等键；
- 只有明确刷新或接受替代报价时，才清除旧 scope 并为新 `quote_id` 生成新键。

### 4.4 价格变化

服务端返回 `QUOTE_CHANGED` 时，错误详情包含一个新的完整报价。页面进入
`quote_changed`：

- 清晰展示原总价和新总价；
- 不自动创建订单；
- 用户点击“接受新价格”后，替代报价成为当前报价；
- 再次点击“确认下单”时使用替代报价对应的新幂等键。

### 4.5 下单成功

页面进入 `booking_created`，展示：

- 订单业务编号；
- `PENDING_PAYMENT`；
- 总价；
- 付款截止时间；
- “支付与订单详情将在下一开发切片开放”。

页面不调用支付、不伪造确认状态。用户可以返回首页或留在当前成功态；重复进入成功态不再次
下单。

## 5. API 契约

所有接口使用现有认证守卫、成功 envelope 和错误 envelope。

### 5.1 创建报价

```http
POST /api/v1/quotes
Authorization: Bearer <access token>
Content-Type: application/json
```

请求：

```json
{
  "room_type_id": "20000000-0000-4000-8000-000000000001",
  "checkin": "2026-08-01",
  "checkout": "2026-08-03",
  "guests": 2
}
```

响应 `201`：

```json
{
  "data": {
    "quote_id": "30000000-0000-4000-8000-000000000001",
    "property": {
      "id": "10000000-0000-4000-8000-000000000101",
      "name": "西湖云栖酒店"
    },
    "room_type": {
      "id": "20000000-0000-4000-8000-000000000001",
      "name": "湖景大床房",
      "cover_url": "/images/catalog/hangzhou-hotel-room-1.jpg"
    },
    "checkin": "2026-08-01",
    "checkout": "2026-08-03",
    "nights": 2,
    "guests": 2,
    "nightly_prices": [
      {
        "business_date": "2026-08-01",
        "sale_price_cents": 58800,
        "rack_price_cents": 68800,
        "currency": "CNY"
      },
      {
        "business_date": "2026-08-02",
        "sale_price_cents": 62800,
        "rack_price_cents": 72800,
        "currency": "CNY"
      }
    ],
    "total_price_cents": 121600,
    "currency": "CNY",
    "booking_policy": "入住前一天 18:00 前可免费取消",
    "expires_at": "2026-07-30T02:05:00.000Z"
  },
  "request_id": "req_01..."
}
```

报价接口校验：

- 用户有效；
- 日期合法、入住不早于服务端业务日、最多 30 晚；
- 人数为 1–10 且不超过房型容量；
- 旅店为 `OPEN`、房型为 `ON_SALE`；
- 区间内每日价格和库存行完整；
- 每晚至少一间可售。

它不锁库存，不返回 `total_inventory`、`held_inventory`、`sold_inventory` 或内部版本。

### 5.2 创建待支付订单

```http
POST /api/v1/bookings
Authorization: Bearer <access token>
Idempotency-Key: <32–80 个安全字符>
Content-Type: application/json
```

请求：

```json
{
  "quote_id": "30000000-0000-4000-8000-000000000001"
}
```

首次创建响应 `201`；相同用户和幂等键的重放响应 `200`，并返回同一业务结果：

```json
{
  "data": {
    "booking_id": "40000000-0000-4000-8000-000000000001",
    "quote_id": "30000000-0000-4000-8000-000000000001",
    "booking_number": "SF20260730A1B2C3D4E5F6",
    "status": "PENDING_PAYMENT",
    "property_name": "西湖云栖酒店",
    "room_type_name": "湖景大床房",
    "checkin": "2026-08-01",
    "checkout": "2026-08-03",
    "nights": 2,
    "guests": 2,
    "total_price_cents": 121600,
    "currency": "CNY",
    "expires_at": "2026-07-30T02:15:00.000Z",
    "created_at": "2026-07-30T02:00:00.000Z"
  },
  "request_id": "req_01..."
}
```

响应不返回入住人、内部库存、报价指纹或数据库状态历史。

### 5.3 `QUOTE_CHANGED`

实时价格、房型展示快照或预订政策与报价不一致时，服务端不占库存、不创建订单。它在一个
可提交的事务结果中保存替代报价，再返回 `409`：

错误 envelope 中：

- `error.code` 固定为 `QUOTE_CHANGED`；
- `error.message` 固定为安全中文提示；
- `error.details.previous_total_price_cents` 为原报价总价；
- `error.details.replacement_quote` 必须使用与 5.1 响应 `data` 完全相同的
  `quoteResponseDataSchema`，字段不可省略或扩展；
- `request_id` 沿用统一 envelope。

替代报价重新获得 5 分钟有效期。客户端必须显式接受，不能自动重提订单。

## 6. 稳定错误

新增或本切片使用：

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `QUOTE_REQUEST_INVALID` | 请求结构、日期或参数非法 |
| 401 | `AUTH_SESSION_EXPIRED` | 会话失效 |
| 404 | `ROOM_NOT_AVAILABLE` | 旅店/房型不可售或不对当前用户暴露 |
| 409 | `QUOTE_EXPIRED` | 报价超过服务端有效期 |
| 409 | `QUOTE_CHANGED` | 实时价格、政策或展示快照变化 |
| 409 | `QUOTE_ALREADY_USED` | 报价已被另一个订单消费 |
| 409 | `INVENTORY_UNAVAILABLE` | 任一晚无可售库存 |
| 422 | `ROOM_CAPACITY_EXCEEDED` | 人数超过房型容量 |
| 429 | `RATE_LIMITED` | 当前用户在窗口内请求过多 |
| 503 | `BOOKING_SERVICE_UNAVAILABLE` | 数据库或时钟不可安全使用 |

资源归属错误不透露其他用户是否存在该报价，统一返回 `QUOTE_EXPIRED` 或 404 风格的安全消息。
错误详情使用严格契约，不能回传 SQL、表名、堆栈、内部版本或库存数量。

## 7. 数据模型

### 7.1 枚举

```text
BookingStatus:
  PENDING_PAYMENT
  PAID
  CONFIRMED
  CANCELLED
  CLOSED

InventoryHoldStatus:
  HELD
  CONSUMED
  RELEASED

BookingActorType:
  USER
  SYSTEM
```

Slice 3 只写 `PENDING_PAYMENT` 和 `HELD`，其余值为 Slice 4 的显式状态机预留，不在本切片
实现迁移命令。

### 7.2 `quote`

| 字段 | 规则 |
| --- | --- |
| `id` | UUID 主键 |
| `user_id` | 必填，外键 `user`，删除限制 |
| `property_id`、`room_type_id` | 必填，删除限制 |
| `checkin_date`、`checkout_date` | PostgreSQL `date`，`checkout > checkin` |
| `guests` | 1–10 |
| `nightly_prices` | JSONB，严格逐晚快照 |
| `property_snapshot` | JSONB，只保存订单展示所需字段 |
| `room_type_snapshot` | JSONB，只保存订单展示所需字段 |
| `booking_policy_snapshot` | 最多 2,000 字 |
| `total_price_cents` | 非负整数分 |
| `currency` | 固定 `CNY` |
| `fingerprint` | 64 位小写 SHA-256 十六进制 |
| `expires_at` | UTC `timestamptz`，创建时间 + 5 分钟 |
| `created_at` | UTC `timestamptz` |

索引：

- `(user_id, expires_at)`；
- `(room_type_id, created_at)`；
- `fingerprint` 不是授权令牌，不单独作为唯一键。

报价不软删除。后续可按保留策略批量清理过期且未关联订单的行。

### 7.3 `booking`

| 字段 | 规则 |
| --- | --- |
| `id` | UUID 主键 |
| `user_id` | 必填 |
| `quote_id` | 唯一；同一报价最多一个订单 |
| `property_id`、`room_type_id` | 必填 |
| `booking_number` | 唯一、不可预测、可客服口述 |
| `status` | 初始 `PENDING_PAYMENT` |
| `checkin_date`、`checkout_date`、`guests` | 从已验证报价复制 |
| `property_snapshot`、`room_type_snapshot` | JSONB |
| `nightly_prices`、`booking_policy_snapshot` | JSONB/文本 |
| `total_price_cents`、`currency` | 人民币整数分和 `CNY` |
| `idempotency_key` | 32–80 字符；与用户联合唯一 |
| `expires_at` | UTC，创建时间 + 15 分钟 |
| `created_at`、`updated_at` | UTC |

`booking_number` 使用可注入生成器产生：

```text
SF + UTC日期YYYYMMDD + 12个大写十六进制字符
```

数据库唯一约束是最终防线。发生极低概率碰撞时当前事务整体回滚，服务层使用新业务编号将
完整下单事务最多重试一次；回滚保证第一次尝试没有留下库存或订单写入。

### 7.4 `inventory_hold`

| 字段 | 规则 |
| --- | --- |
| `id` | UUID 主键 |
| `booking_id` | 必填，订单删除限制 |
| `room_type_id` | 必填 |
| `business_date` | PostgreSQL `date` |
| `status` | 初始 `HELD` |
| `expires_at` | 与订单截止时间相同 |
| `created_at`、`updated_at` | UTC |

约束：

- `(booking_id, business_date)` 唯一；
- `expires_at > created_at`；
- 索引 `(status, expires_at, id)` 为 Slice 4 Worker 领取准备。

### 7.5 `booking_status_history`

| 字段 | 规则 |
| --- | --- |
| `id` | UUID 主键 |
| `booking_id` | 必填 |
| `from_status` | 首条为 `NULL` |
| `to_status` | Slice 3 为 `PENDING_PAYMENT` |
| `reason` | 固定 `BOOKING_CREATED` |
| `actor_type` | `USER` |
| `actor_user_id` | 当前用户 |
| `created_at` | UTC |

历史只追加，不更新、不删除。

### 7.6 数据库约束

迁移使用显式 SQL 增加：

```text
daily_inventory:
  total_inventory >= 0
  held_inventory >= 0
  sold_inventory >= 0
  held_inventory + sold_inventory <= total_inventory

daily_price:
  sale_price_cents >= 0
  rack_price_cents >= sale_price_cents

quote / booking:
  checkout_date > checkin_date
  guests BETWEEN 1 AND 10
  total_price_cents >= 0
  currency = 'CNY'
```

现有不满足约束的数据必须使迁移失败，不能静默修正。

## 8. 报价生成

报价服务复用 Catalog 的日期解析和注入式 `Clock`，但拥有独立模块边界：

```text
PricingModule
├─ QuotesController
├─ QuotesService
├─ QuoteRepository
├─ QuoteFingerprint
└─ DTO / OpenAPI
```

生成步骤：

1. 严格解析请求和业务日期；
2. 查询 `OPEN` 旅店、`ON_SALE` 房型和容量；
3. 读取完整日期区间的价格与库存；
4. 验证价格行、库存行数量均等于晚数；
5. 验证每晚 `total - held - sold > 0`；
6. 按日期升序构造逐晚明细；
7. 使用安全整数求和并拒绝超过 JavaScript safe integer；
8. 对规范字段生成 SHA-256 指纹；
9. 保存报价和 5 分钟 UTC 到期时间；
10. 返回严格响应契约。

指纹输入固定为 UTF-8 JSON 数组，字段顺序固定：

```text
room_type_id
property_id
checkin
checkout
guests
property [id, name]
room_type [id, name, cover_url]
booking_policy
nightly [business_date, sale_price_cents, rack_price_cents]
```

指纹只包含报价和订单实际展示的快照，不包含宽泛的 `updated_at`，避免无关字段变化制造
假价格变化。库存版本不进入指纹。其他订单的占用变化不应伪装成价格变化；库存始终在下单
事务内独立校验。

## 9. 下单事务

### 9.1 固定锁顺序

事务隔离级别使用 PostgreSQL `READ COMMITTED`，配合显式行锁和唯一约束。所有路径必须按以下
顺序获取锁：

```text
同用户幂等键 advisory transaction lock
→ quote FOR UPDATE
→ daily_inventory 按 business_date ASC FOR UPDATE
→ 写 booking
→ 写 inventory_hold
→ 写 booking_status_history
```

不使用 Redis 锁，不在持锁期间调用外部服务。

### 9.2 幂等处理

事务先用参数化 SQL 获取：

```sql
SELECT pg_advisory_xact_lock(
  hashtextextended(user_id::text || ':' || idempotency_key, 0)
)
```

advisory lock 只序列化同一用户和键；哈希碰撞最多造成额外等待，不影响正确性。

随后查询 `(user_id, idempotency_key)`：

- 已存在：返回原订单，不重新检查报价到期、不重复加库存；
- 不存在：继续报价和库存流程。

唯一约束仍是最终防线。任何唯一冲突都回滚当前事务，再按用户和键读取原订单；读取不到时返回
固定服务错误，不能把数据库异常外泄。

### 9.3 报价校验

在事务内：

1. 对 `quote` 执行同时包含 `id = $quoteId`、`user_id = $userId` 的参数化
   `FOR UPDATE` 查询；
2. 不存在或不属于用户时返回安全的 `QUOTE_EXPIRED`；
3. 已有关联订单时：
   - 若新请求幂等键等于原订单，返回原订单；
   - 否则返回 `QUOTE_ALREADY_USED`；
4. 服务端时钟达到 `expires_at` 时返回 `QUOTE_EXPIRED`；
5. 重新读取旅店、房型、政策和逐晚价格；
6. 重新计算规范快照与指纹。

指纹变化时，事务创建替代报价并提交一个 `QUOTE_CHANGED` 结果；它不锁库存、不创建订单。
Controller 在事务提交后将结果转换为 `409`。

### 9.4 库存占用

报价仍一致时，按日期升序执行参数化 `FOR UPDATE` 查询。必须精确得到每晚一行，且每晚：

```text
available = total_inventory - held_inventory - sold_inventory
available >= 1
```

随后逐晚条件更新：

```sql
UPDATE daily_inventory
SET held_inventory = held_inventory + 1,
    version = version + 1,
    updated_at = $now
WHERE room_type_id = $roomTypeId
  AND business_date = $businessDate
  AND held_inventory + sold_inventory < total_inventory
RETURNING room_type_id
```

任一晚没有返回行，事务整体回滚并返回 `INVENTORY_UNAVAILABLE`。

### 9.5 创建订单

全部库存更新成功后：

1. 创建 `booking`，到期时间为事务时钟 + 15 分钟；
2. 每晚创建一个 `inventory_hold(HELD)`；
3. 写首条 `booking_status_history`；
4. 提交事务；
5. 返回严格订单摘要。

数据库事务回调只返回领域结果，不在回调内抛出需要保留写入结果的
`QUOTE_CHANGED`。未知异常触发回滚，并由统一异常层返回安全错误。

## 10. 服务边界

```text
BookingModule
├─ BookingsController
├─ BookingsService
├─ BookingRepository
├─ BookingNumberGenerator
└─ DTO / OpenAPI
```

- `QuotesService` 只负责报价创建和替代报价。
- `BookingsService` 组织幂等、重报价、库存和订单事务。
- `BookingRepository` 是事务 SQL 的唯一入口，不在 Controller 拼 SQL。
- `CatalogModule` 继续只读，不创建报价或占用。
- `Clock` 从现有 `common/clock` 注入，测试不真实等待 5 或 15 分钟。

仓库 SQL 使用 Prisma tagged template 或 `pg` 参数绑定；禁止把 UUID、日期、幂等键或排序值
拼接进 SQL 字符串。

## 11. 微信端边界

新增：

```text
wx/services/booking.js
wx/pages/booking-confirm/
```

`wx/services/contracts.js` 增加严格报价、替代报价、订单摘要和错误详情断言。所有对象：

- 拒绝未知字段；
- UUID、日期、ISO 时间、金额、currency 和枚举严格校验；
- 数组长度最多 30 晚；
- 不保留内部库存、版本、用户 ID 或状态历史；
- 响应 ID 必须与请求的 `room_type_id` / `quote_id` 绑定。

订单摘要公开返回 `quote_id`，用于把响应严格绑定到本次订单请求。`createBooking` 的
`options.expectedQuote` 还必须携带从已校验报价快照取得的 `property_id` 和
`room_type_id`；该上下文不进入请求体，只用于验证 `QUOTE_CHANGED` 的替代报价仍属于原旅店和
房型。缺失、畸形或不匹配时客户端必须 fail closed。

报价和订单请求失败后先检查页面 generation/cancel 状态，再处理异常。依赖异常只允许通过自有
数据描述符读取白名单 code，并以固定安全消息重建；不得读取 accessor、修改或原样重抛任意异常。

页面异步规则沿用 Slice 2：

- 每次 load/submit 使用 generation token；
- `onHide` / `onUnload` 使晚到响应失效；
- 同一提交只有一个 in-flight；
- modal、toast 和导航失败必须释放 UI 锁；
- 页面不把访问令牌、幂等键、报价对象或订单对象写入同步 storage；
- 页面隐藏或卸载时不清除处于“不确定网络结果”的幂等 scope；重新提交同一报价必须复用同一
  键。只有服务端明确返回未创建订单的 `QUOTE_CHANGED`、`QUOTE_EXPIRED` 或
  `INVENTORY_UNAVAILABLE`，或页面已收到确定成功结果时，才清除或切换 scope。

## 12. 防御与安全

- 报价和订单接口都要求当前登录用户。
- 报价、订单和幂等查询始终包含 `user_id`。
- `Idempotency-Key` 只允许 `[A-Za-z0-9._~-]`，长度 32–80。
- 幂等键和完整报价不写应用日志；日志只记录操作结果、request ID 和安全业务编号。
- 业务编号不可用数据库自增 ID 推导。
- 金额只使用整数分和 safe integer。
- 客户端不得传总价、每晚价格、库存数量、到期时间或订单状态。
- 报价错误和库存错误不返回剩余房量。
- 用户输入、SQL、堆栈、JWT、会话、精确地址和用户 ID 不进入错误响应。
- 对 `POST /quotes` 和 `POST /bookings` 使用独立 Redis 限流 scope；现有全局请求大小限制
  继续生效。
- 前端不自动重试报价或下单。唯一允许的 replay 是请求层已经受控的单次 401 刷新 replay，
  下单 replay 必须保持同一幂等键和请求体。

限流使用 Redis Lua 原子执行计数和首次过期：

```text
quotes:   每用户每 60 秒最多 30 次
bookings: 每用户每 60 秒最多 10 次
```

Redis key 只保存用户 UUID 的 SHA-256 摘要和 scope，不记录原始用户 ID。超限返回
`429 RATE_LIMITED` 和上限为 60 的 `retry_after_seconds`。Redis 不可用时请求安全失败为
`503 BOOKING_SERVICE_UNAVAILABLE`；不能绕过限流继续写数据库。

## 13. 测试

### 13.1 契约与单元测试

- 请求拒绝未知字段、非法 UUID、日期、人数和幂等键；
- 报价响应拒绝内部库存、版本、用户 ID 和未知字段；
- 金额求和、30 晚边界、闰日和 safe integer；
- 指纹对字段顺序稳定，对价格、政策和快照变化敏感，对库存版本变化不敏感；
- 5 分钟报价和 15 分钟订单使用 `FixedClock`；
- 业务编号格式和碰撞重试；
- 页面加载、刷新报价、倒计时、重复点击、晚到响应和卸载；
- `QUOTE_CHANGED` 必须显式接受，新报价使用新幂等 scope；
- `POST /bookings` 没有网络自动重试。
- 报价和下单限流 scope、窗口、Redis key 摘要、首次过期和 `retry_after_seconds`；
- Redis 限流不可用时写接口 fail closed，不能访问订单事务。

### 13.2 PostgreSQL 集成测试

必须在真实 PostgreSQL/PostGIS 执行：

1. 两个不同用户争抢总库存为 1 的同房型同日期：
   - 一个 `PENDING_PAYMENT`；
   - 一个 `INVENTORY_UNAVAILABLE`；
   - `held_inventory = 1`；
   - 只有一个订单和一组占用。
2. 同一用户、同一幂等键并发两次：
   - 返回同一 `booking_id` 和业务编号；
   - 只增加一次 held；
   - 只写一条初始状态历史。
3. 同一报价、不同幂等键：
   - 一个成功；
   - 另一个 `QUOTE_ALREADY_USED`；
   - 不重复占用。
4. 多晚任一晚无库存：
   - 无订单、无占用、无状态历史；
   - 其他晚 held 不变。
5. 报价后修改任一晚价格或政策：
   - 返回 `QUOTE_CHANGED` 和替代报价；
   - 不占库存；
   - 替代报价归属当前用户。
6. 报价超过 5 分钟：
   - 返回 `QUOTE_EXPIRED`；
   - 不占库存。
7. 其他用户使用报价 ID：
   - 不读取、不下单；
   - 不泄露资源存在性。
8. 数据库约束拒绝负库存、超卖和非法金额。

并发测试使用独立数据库连接和有界 barrier，不以 `Promise.all` 的调度偶然性代替同时竞争。

### 13.3 API 与 OpenAPI

- `POST /quotes`、`POST /bookings` 的 envelope、状态码和认证；
- 首次创建订单为 `201`，同键重放为 `200`，响应 body 中的订单身份和业务字段一致；
- `Idempotency-Key` header 出现在 OpenAPI；
- `QUOTE_CHANGED.details.replacement_quote` 使用严格 schema；
- 业务异常不变成 500；
- 未知异常不泄露内部信息；
- 生产配置没有模拟支付路由。

### 13.4 微信官方工具

- 新增页面写入 `app.json`；
- 房型详情和预订确认页 WXML/WXSS 官方编译；
- console/network 无运行时异常、401 循环或重复 POST；
- RC Automator 限制按现有 Slice 5 UAT 台账处理；
- 手机/人工 UAT 使用执行日 `D` 对齐后的 `D+1`–`D+3`，验证房型选择、报价、重复点击和
  待支付结果。

## 14. WSL2 运行验证

扩展 `scripts/wsl-runtime-validation.ps1`：

- 迁移首次应用、再次无 pending；
- seed 行数保持 2 城、6 店、12 房型、720 日价、720 日库存；
- PostGIS、Redis、live/ready、non-root、readonly 继续通过；
- Slice 1、Slice 2 smoke 不回归；
- Slice 3 创建报价和待支付订单；
- 同幂等键重放返回同一订单；
- 最后一间房并发只成功一个；
- 多晚失败整体回滚；
- 报价变化和过期不占库存；
- API 和 Worker 仍观察 10/10 分钟、重启 0；
- 临时容器、网络和产物按 owner 清理，数据卷保留。

Worker 在 Slice 3 不处理订单超时；10 分钟观察只验证新增表和请求流量不会造成 Worker
崩溃或重连循环。

因此 Slice 3 的 `booking.expires_at` 和 `inventory_hold.expires_at` 只是 Slice 4 状态机的
权威截止时间。到期后自动释放尚未实现，测试与运行文档不得宣称库存已经自动恢复；开发验证
使用隔离数据并在 owner 范围内清理测试订单。

## 15. 迁移、兼容与回滚

- 新迁移只新增报价、订单、占用、历史表和现有价格/库存约束；
- Catalog 读接口保持兼容；
- 房型详情按钮行为改变为进入预订确认页；
- 回滚应用版本时，新表可保留为空或保留已创建的测试订单，不执行自动 destructive down
  migration；
- 数据库迁移必须先于新 API 部署；
- 旧 API 看到新表不受影响；
- Slice 4 只能在本切片并发、幂等和回滚门禁通过后实现支付、取消和超时释放。

## 16. 退出条件

Slice 3 功能开发完成必须同时满足：

- 报价由服务端生成，5 分钟有效，微信端不计算总价；
- 预订确认页可以显式处理价格变化、过期和库存不足；
- 相同用户和幂等键只创建一个订单；
- 同一报价最多创建一个订单；
- 两个用户争抢最后一间房只成功一个；
- 多晚失败不留下任何部分占用；
- 待支付订单、逐晚占用和初始状态历史在一个事务中创建；
- 真实 PostgreSQL 并发测试、全量质量门禁和 WSL2 smoke 通过；
- `/wx` 静态检查和微信官方编译通过；
- 依赖漏洞按 dev 政策报告，release/main 的 Critical/High 仍阻断；
- Slice 2/3 更新后的物理交互路径继续登记在 Slice 5 UAT，不能因开发排序被标记为已验收。

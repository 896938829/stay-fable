# Stay Fable Slice 2 供给浏览设计

状态：已确认

日期：2026-07-29

适用分支：`codex/wx-mvp-booking-design`

## 1. 目标与范围

Slice 2 将已经完成的身份与搜索上下文连接到真实 PostgreSQL 供给数据，交付以下用户
路径：

```text
首页搜索
→ 按城市、日期、人数和可选类型浏览旅店
→ 查看旅店详情
→ 在旅店内查看可售房型
→ 查看房型详情
```

旅店是唯一一级供给结果。酒店、民宿和农家乐都是旅店类型；房型或房源只能从旅店
详情进入，不能出现在一级搜索结果。

本切片包含旅店、媒体、设施、房型、未来 60 天展示价格和库存、筛选、游标分页以及
原生微信页面。服务端只返回所选入住区间内至少有一个全程可售房型的旅店。

本切片不创建报价、库存占用、订单或支付，也不建设管理后台、地图找房、收藏、评价、
个性化排序或关键词搜索。“选择此房型”只明确提示报价功能将在 Slice 3 开放。

## 2. 已确认决策

- 采用标准关系模型和服务端可售聚合，不使用旅店 JSON 大字段或客户端假数据。
- 列表价格显示所选区间内的最低单晚可售价，文案为“每晚 ¥xxx 起”。
- 最终区间总价必须在 Slice 3 由报价接口计算；微信端不得把单晚价格相加作为报价。
- 不可售旅店在服务端被过滤，因此既有“可售优先”规则在本切片表现为前置过滤；
  返回结果再按确定性展示顺序排序。
- PostgreSQL 是供给、价格和库存的事实来源。Redis 不参与本切片的供给查询。
- 图片使用仓库内测试素材或明确允许公开使用的固定测试资源，不使用真实商户资料。

## 3. 方案选择

### 3.1 采用：关系模型与服务端可售聚合

旅店、媒体、设施、房型、每日价格和每日库存分别建表。Catalog 服务按搜索上下文查询
全程可售房型，并聚合旅店的最低单晚价格。该方案约束明确，可直接复用到 Slice 3 的
报价和库存事务。

### 3.2 未采用：JSON 供给快照

将设施、媒体、房型和价格保存为旅店 JSON 可以减少首期表数量，但会削弱唯一约束、
人数与日期筛选、运营维护和后续库存行锁，因此不采用。

### 3.3 未采用：推迟价格和库存

只建设旅店元数据会降低 Slice 2 工作量，但无法证明日期范围内全程可售，也无法满足
60 天确定性种子和最低可售价退出条件，因此不采用。

## 4. 数据模型

### 4.1 枚举

```text
PropertyType: HOTEL | HOMESTAY | FARM_STAY
PropertyStatus: OPEN | CLOSED
RoomTypeStatus: ON_SALE | OFF_SALE
PropertyMediaType: IMAGE
```

生产配置和 API 只接受枚举值，不接收自由文本状态。

### 4.2 表与约束

| 表 | 关键字段 | 关键约束 |
| --- | --- | --- |
| `property` | `id`、`city_id`、`type`、`name_zh`、`address_zh`、`location`、`short_description_zh`、`description_zh`、`policies_zh`、`cover_url`、`status`、`display_order`、审计时间 | 城市外键；名称和文本长度有界；坐标为 `geography(Point,4326)`；`display_order >= 0` |
| `property_media` | `id`、`property_id`、`type`、`url`、`alt_zh`、`display_order` | 旅店外键级联删除；`property_id + display_order` 唯一 |
| `facility` | `id`、`code`、`name_zh`、`display_order` | `code` 唯一且稳定；`display_order >= 0` |
| `property_facility` | `property_id`、`facility_id` | 联合主键，两个外键级联删除 |
| `room_type` | `id`、`property_id`、`name_zh`、`bed_type_zh`、`area_sqm`、`max_guests`、`cover_url`、`description_zh`、`booking_policy_zh`、`status`、`display_order`、审计时间 | `area_sqm > 0`；`1 <= max_guests <= 10`；`display_order >= 0` |
| `daily_price` | `room_type_id`、`business_date`、`sale_price_cents`、`rack_price_cents`、审计时间 | 房型和日期联合主键；价格非负；划线价不低于销售价 |
| `daily_inventory` | `room_type_id`、`business_date`、`total_inventory`、`held_inventory`、`sold_inventory`、`version`、审计时间 | 房型和日期联合主键；各库存非负；`held + sold <= total`；`version >= 0` |

数据库迁移显式创建 Prisma 不能表达的金额、面积、人数和库存检查约束。所有业务日期使用
PostgreSQL `date`；审计时间使用 UTC `timestamptz`；金额只保存人民币分。

### 4.3 可售定义

搜索区间为 `[checkin, checkout)`。房型只有同时满足以下条件才可售：

1. 所属旅店为 `OPEN`，房型为 `ON_SALE`。
2. `max_guests >= guests`。
3. 区间不超过 30 晚。
4. 每一晚都有 `daily_price` 和 `daily_inventory`。
5. 每一晚都满足
   `total_inventory - held_inventory - sold_inventory > 0`。

旅店至少存在一个全程可售房型时才出现在列表。列表的
`from_nightly_price_cents` 是所有符合条件房型、所有入住夜晚中最小的
`sale_price_cents`，只用于“每晚起”展示。

## 5. 确定性种子

种子数据扩展现有城市 seed，并继续在 PostgreSQL advisory transaction lock 内执行：

- 杭州、贵阳各 3 家旅店。
- 每城各含 1 家 `HOTEL`、1 家 `HOMESTAY`、1 家 `FARM_STAY`。
- 每家旅店固定 2 个房型。
- 每个房型从固定基准日 `2026-07-30` 开始生成连续 60 天价格和库存。
- 至少一个房型总库存为 1，供 Slice 3 并发测试复用。
- 基准房型包含不同人数上限，以验证人数筛选。关闭旅店、停售房型、价格缺口和库存
  缺口由集成测试在事务内临时构造并回滚，不污染六家基准旅店。

所有 ID 使用固定 UUID。seed 以固定 ID 和业务唯一键 upsert；如果同一 ID 与业务键
映射冲突则失败，不静默接管未知数据。重复运行必须保持行数稳定，并把受管字段恢复到
版本化基准值。

基准日不依赖执行当天，以保证重复验证得到相同数据和行数。API 与微信验收使用该固定
窗口；进入下一里程碑前若演示日期超出窗口，应通过新的版本化 seed 明确迁移基准日，
不能在同一 seed 中按执行日静默增加历史行。

## 6. API 设计

所有 Catalog 路由使用现有 API envelope、request ID、登录会话守卫和一次刷新机制。

### 6.1 旅店列表

```http
GET /api/v1/properties
  ?city_id=<uuid>
  &checkin=YYYY-MM-DD
  &checkout=YYYY-MM-DD
  &guests=2
  &property_type=HOTEL
  &page_size=10
  &cursor=<opaque>
```

`property_type`、`page_size` 和 `cursor` 可选。`page_size` 范围为 1–20，默认 10。

排序固定为：

```text
property.display_order ASC
property.id ASC
```

游标是版本化、base64url 编码的不透明 JSON，只包含最后一项的展示顺序和 UUID。
服务端限制解码长度、验证版本、整数范围和 UUID；游标不是授权凭据，不包含用户或
敏感数据。无效游标返回稳定的请求校验错误。

列表项返回：

```text
id
type
name
city
cover_url
short_description
facility_highlights[]
from_nightly_price_cents
currency = CNY
available_room_type_count
```

响应包含 `items` 和可空的 `next_cursor`。服务端多取一条判断是否还有下一页。

### 6.2 旅店详情

```http
GET /api/v1/properties/:propertyId
  ?checkin=YYYY-MM-DD
  &checkout=YYYY-MM-DD
  &guests=2
```

详情返回旅店基本信息、媒体、全部设施和符合当前搜索条件的可售房型摘要。房型摘要包含
房型 ID、名称、床型、面积、最大人数、封面、规则摘要和
`from_nightly_price_cents`，价格币种固定为 `CNY`。关闭、未知或当前区间无可售房型的旅店统一返回
`PROPERTY_NOT_AVAILABLE`，不泄露内部状态。

### 6.3 房型详情

```http
GET /api/v1/room-types/:roomTypeId
  ?checkin=YYYY-MM-DD
  &checkout=YYYY-MM-DD
  &guests=2
```

房型详情返回所属旅店摘要、房型内容、预订规则以及每晚日期和展示价格。它不返回
每晚价格的币种固定为 `CNY`，并且不返回 `total_inventory`、`held_inventory`、
`sold_inventory` 或内部版本。人数超限返回
`ROOM_CAPACITY_EXCEEDED`；停售、未知、价格缺失或任一晚无库存返回
`ROOM_NOT_AVAILABLE`。

### 6.4 校验与时间边界

- UUID、枚举、日期和人数由 DTO 校验。
- `checkout` 必须晚于 `checkin`，区间最多 30 晚。
- `checkin` 不早于注入时钟对应的当前业务日；MVP 业务时区固定为
  `Asia/Shanghai`，不得用服务器本地时区推断。
- 日期解析只接受严格 `YYYY-MM-DD`，不经过 JavaScript 本地时区隐式转换。
- 所有列表查询都参数化；动态筛选只组合固定 Prisma 字段或固定 SQL 片段。

## 7. 后端组件边界

```text
apps/api-server/src/catalog/
├─ catalog.module.ts
├─ catalog.controller.ts
├─ catalog.service.ts
├─ catalog.repository.ts
├─ catalog-cursor.ts
└─ dto/
   ├─ catalog-query.dto.ts
   ├─ property-list-response.dto.ts
   ├─ property-detail-response.dto.ts
   └─ room-type-detail-response.dto.ts
```

- Controller 只负责路由、DTO 和 OpenAPI。
- Service 负责业务错误、可售语义和 DTO 组装。
- Repository 封装固定的可售查询和分页，不处理 HTTP。
- Cursor 模块只负责版本化编码与严格解码。
- 日期区间逻辑复用单一领域函数，不在三个端点重复实现。

Catalog 不直接访问 Redis，不缓存可售结果。当前数据量很小，正确性优先于缓存；后续只有
在指标证明必要时才引入短 TTL 缓存。

## 8. 微信端设计

### 8.1 文件边界

```text
wx/
├─ services/catalog.js
├─ components/
│  ├─ price/
│  └─ property-card/
└─ pages/
   ├─ property-list/
   ├─ property-detail/
   └─ room-detail/
```

`catalog.js` 只调用三个 Catalog API 并验证 envelope 中的展示 DTO。金额由现有
`utils/money.js` 格式化，微信端不计算可售性或区间总价。

### 8.2 页面流

- 首页只有在城市、日期和人数完整时进入 `property-list`。
- `property-list` 从共享 search store 读取条件；缺少或损坏时返回首页，不猜测默认城市。
- 列表顶部显示城市、日期、晚数和人数，并允许返回现有页面修改。
- 旅店类型筛选为“全部、酒店、民宿、农家乐”，切换后清空旧游标并重新查询。
- 首屏手动加载；滚动到底按 `next_cursor` 加载。相同 cursor 只允许一个在途请求。
- `property-card` 只展示旅店，不渲染房型字段；点击进入 `property-detail`。
- 旅店详情展示媒体、设施、政策和可售房型卡片。
- 房型详情展示所属旅店、房型内容、逐晚价格和预订规则。
- “选择此房型”在 Slice 2 显示“报价与预订将在下一切片开放”，不创建伪订单。

页面 URL 只携带旅店或房型 UUID。城市、日期和人数继续从 Slice 1 已验证的共享 search
store 读取，并沿用其受控持久化；Catalog 页面不得把完整搜索上下文或会话令牌另存到新
storage key，也不得放入 URL 或日志。会话令牌只由既有 session store 管理。

### 8.3 页面状态

三个页面都覆盖：

- 首次加载；
- 空列表或无可售房型；
- 网络或会话错误；
- 手动重试；
- 成功；
- 页面隐藏或卸载后迟到响应抑制。

分页失败保留已经加载的安全列表并显示页尾重试，不把整页替换为错误态。筛选变化和页面
卸载会递增请求代次，旧请求不能覆盖新筛选结果。

## 9. 防御与隐私

- API 不返回精确旅店坐标、内部库存数量、数据库错误或堆栈。
- 测试地址为公开、泛化地址，不包含私人门牌、联系人或手机号。
- URL 只允许固定的安全 HTTPS 子集或仓库内 `/images/` 资源；HTTPS 主机只接受标准
  ASCII DNS label，拒绝凭据、IDN/punycode、IP 字面量、空 label 和非标准 label，
  可选端口必须使用规范十进制 `1–65535`。路径、查询和 fragment 只接受安全 ASCII
  URL 字符及完整 `%HH` 转义。服务端共享契约与微信端使用同一规则，不依赖两端
  WHATWG URL 实现差异；seed 不接受运行时外部输入。
- 文本字段有长度上限；微信模板只进行文本绑定，不使用富文本 HTML。
- 查询端点无副作用，可以手动重试；不为错误请求自动扩大日期或人数范围。
- 401 继续沿用现有一次刷新和单次重放策略。
- 日志只记录路由、状态、request ID 和安全筛选摘要，不记录 token 或精确坐标。

## 10. 测试与验收

### 10.1 数据与 API

- 迁移约束测试覆盖价格、面积、人数、库存和唯一键。
- 真实 PostgreSQL 集成测试覆盖 seed 首次执行、重复执行、冲突失败和确定性行数。
- 可售测试覆盖日期缺口、价格缺口、零库存、持有/已售库存、停售、关闭和人数超限。
- 列表测试覆盖城市、类型、人数、日期、确定性排序、`page_size`、下一页和畸形游标。
- 详情测试证明房型只从旅店详情返回，一级列表没有房型数组。
- 房型详情测试证明内部库存字段不会出现在响应。
- OpenAPI 测试固定三个路由、查询参数、响应 envelope 和稳定业务错误。

### 10.2 微信

- service 契约测试拒绝畸形金额、枚举、分页和详情 DTO。
- 首页测试证明搜索按钮进入旅店列表。
- 列表测试覆盖筛选、分页去重、并发请求抑制、页尾重试和空态。
- 详情测试覆盖旅店到房型、房型详情、错误重试和返回后搜索上下文保持。
- WXML/WXSS 静态检查和微信官方编译覆盖三个新增页面及两个新增组件。

### 10.3 实机证据

WSL2 验证在现有原子锁流程中执行迁移和 seed，并增加以下冒烟：

```text
杭州返回 3 家旅店
类型筛选只返回目标类型
人数不足房型被过滤
游标两页无重复
旅店详情在 `guests=1` 时返回 2 个基准房型
一级列表响应不包含房型集合
房型详情不包含内部库存数量
```

微信自动化覆盖：

```text
首页保留杭州、日期和 3 人
→ 搜索旅店
→ 切换旅店类型并恢复全部
→ 打开旅店
→ 打开房型
→ 返回后搜索上下文仍保持
```

## 11. Slice 2 完成定义

只有同时满足以下条件才可进入 Slice 3：

- 迁移、约束和确定性 seed 在真实 PostgreSQL 中通过，重复执行不增加行数。
- 两个城市各有 3 家基准旅店，每店 2 个基准房型和连续 60 天价格库存。
- 列表只返回旅店，日期、人数、状态和类型筛选有效，游标分页无重复或遗漏。
- 旅店详情才返回房型，房型详情不泄露内部库存。
- 微信完成“首页 → 旅店列表 → 旅店详情 → 房型详情”并保留搜索上下文。
- 全仓格式、静态检查、类型检查、Node/API/微信测试和构建通过。
- 新增微信页面完成官方编译，WSL2 Catalog 冒烟和 Worker 10 分钟观察通过。
- 工作区只包含已提交的预期文件，验证产物无噪声。

Slice 1 的真实定位拒绝授权面板证据仍作为独立人工验收项保留，不在本设计中伪造或
静默关闭。

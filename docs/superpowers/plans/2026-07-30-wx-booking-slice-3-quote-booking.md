# 微信预订切片 3：报价与并发安全下单 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在原生微信小程序中提供服务端报价和待支付订单创建，并以 PostgreSQL 行锁、幂等键和约束证明最后一间房不超卖。

**Architecture:** PostgreSQL 保存 5 分钟报价快照、15 分钟待支付订单、逐晚库存占用和状态历史。NestJS 的 Pricing 与 Booking 模块分别负责报价和下单事务；下单按幂等 advisory lock、报价、日期升序库存的固定顺序加锁。`/wx` 只验证服务端契约、展示报价并提交报价 ID，不计算总价或自动重试写请求。

**Tech Stack:** PostgreSQL 17/PostGIS、Prisma 7、NestJS 11、Zod 4、Redis 7、Vitest 4、原生微信小程序、WechatIDE、WSL2 Docker Engine

---

## 实施约束

- 工作分支固定为 `codex/wx-mvp-booking-design`，不得直接在 `dev`、`release` 或 `main` 开发。
- `/wx` 是唯一正式客户端；冻结的 `apps/consumer-miniapp` 不进入修改范围。
- 每个任务按 RED → 最小实现 → GREEN → 原子提交执行。
- PostgreSQL 并发、行锁和约束必须在真实 PostgreSQL 运行，不得用 SQLite 或纯 mock 替代。
- 前端不得计算订单总价、传库存数量、传订单状态或自动重试 `POST /bookings`。
- Slice 2 的 RC Automator 物理交互债务继续登记到 Slice 5；本计划不得伪造 Automator PASS。
- dev 阶段漏洞只报告；release/main 的 Critical/High 继续阻断。

## 文件结构

### 共享契约

- Create: `packages/api-contracts/src/booking.ts`
- Create: `packages/api-contracts/test/booking.test.ts`
- Modify: `packages/api-contracts/package.json`

### 数据库与后端

- Modify: `apps/api-server/prisma/schema.prisma`
- Create: `apps/api-server/prisma/migrations/202607300001_quote_booking_hold/migration.sql`
- Create: `apps/api-server/src/common/rate-limit/write-rate-limit.service.ts`
- Create: `apps/api-server/src/pricing/quote-fingerprint.ts`
- Create: `apps/api-server/src/pricing/quote.repository.ts`
- Create: `apps/api-server/src/pricing/quotes.service.ts`
- Create: `apps/api-server/src/pricing/quotes.controller.ts`
- Create: `apps/api-server/src/pricing/pricing.module.ts`
- Create: `apps/api-server/src/pricing/dto/quote-request.dto.ts`
- Create: `apps/api-server/src/pricing/dto/quote-response.dto.ts`
- Create: `apps/api-server/src/booking/booking-number.ts`
- Create: `apps/api-server/src/booking/booking.repository.ts`
- Create: `apps/api-server/src/booking/bookings.service.ts`
- Create: `apps/api-server/src/booking/bookings.controller.ts`
- Create: `apps/api-server/src/booking/booking.module.ts`
- Create: `apps/api-server/src/booking/dto/create-booking.dto.ts`
- Create: `apps/api-server/src/booking/dto/booking-response.dto.ts`
- Modify: `apps/api-server/src/app.module.ts`
- Modify: `apps/api-server/src/infrastructure/redis/redis.service.ts`

### 后端测试与运行验证

- Create: `apps/api-server/test/quote-fingerprint.test.ts`
- Create: `apps/api-server/test/write-rate-limit.service.test.ts`
- Create: `apps/api-server/test/quotes.service.test.ts`
- Create: `apps/api-server/test/quotes.controller.e2e.test.ts`
- Create: `apps/api-server/test/bookings.service.test.ts`
- Create: `apps/api-server/test/bookings.controller.e2e.test.ts`
- Create: `apps/api-server/test/booking.openapi.test.ts`
- Create: `apps/api-server/test/database/quote-booking.integration.test.ts`
- Modify: `scripts/wsl-runtime-validation.ps1`
- Modify: `scripts/wsl-runtime-validation.test.mjs`

### 原生微信小程序

- Modify: `wx/services/contracts.js`
- Create: `wx/services/booking.js`
- Create: `wx/pages/booking-confirm/booking-confirm.js`
- Create: `wx/pages/booking-confirm/booking-confirm.logic.js`
- Create: `wx/pages/booking-confirm/booking-confirm.json`
- Create: `wx/pages/booking-confirm/booking-confirm.wxml`
- Create: `wx/pages/booking-confirm/booking-confirm.wxss`
- Modify: `wx/pages/room-detail/room-detail.js`
- Modify: `wx/pages/room-detail/room-detail.wxml`
- Modify: `wx/app.json`
- Create: `wx/tests/booking-contracts.test.js`
- Create: `wx/tests/booking-service.test.js`
- Create: `wx/tests/booking-confirm-page.test.js`
- Modify: `wx/tests/room-detail-page.test.js`
- Modify: `wx/tests/configuration.test.js`

### 证据

- Create: `docs/verification/2026-07-30-slice-3-quote-booking.md`

## Task 1：定义报价与订单共享契约

**Files:**

- Create: `packages/api-contracts/src/booking.ts`
- Create: `packages/api-contracts/test/booking.test.ts`
- Modify: `packages/api-contracts/package.json`

- [ ] **Step 1: 写报价与订单契约 RED 测试**

在 `packages/api-contracts/test/booking.test.ts` 覆盖：

```ts
import { describe, expect, it } from "vitest";

import {
  bookingSummarySchema,
  createBookingRequestSchema,
  createQuoteRequestSchema,
  quoteChangedDetailsSchema,
  quoteResponseDataSchema,
} from "../src/booking.js";

const quote = {
  quote_id: "30000000-0000-4000-8000-000000000001",
  property: {
    id: "10000000-0000-4000-8000-000000000101",
    name: "西湖云栖酒店",
  },
  room_type: {
    id: "20000000-0000-4000-8000-000000000001",
    name: "湖景大床房",
    cover_url: "/images/catalog/hangzhou-hotel-room-1.jpg",
  },
  checkin: "2026-08-01",
  checkout: "2026-08-03",
  nights: 2,
  guests: 2,
  nightly_prices: [
    {
      business_date: "2026-08-01",
      sale_price_cents: 58800,
      rack_price_cents: 68800,
      currency: "CNY",
    },
    {
      business_date: "2026-08-02",
      sale_price_cents: 62800,
      rack_price_cents: 72800,
      currency: "CNY",
    },
  ],
  total_price_cents: 121600,
  currency: "CNY",
  booking_policy: "入住前一天 18:00 前可免费取消",
  expires_at: "2026-07-30T02:05:00.000Z",
};

describe("booking contracts", () => {
  it("accepts a strict quote and rejects internal inventory", () => {
    expect(quoteResponseDataSchema.parse(quote)).toEqual(quote);
    expect(() =>
      quoteResponseDataSchema.parse({
        ...quote,
        held_inventory: 1,
      }),
    ).toThrow();
  });

  it("binds quote request fields and rejects client totals", () => {
    expect(
      createQuoteRequestSchema.parse({
        room_type_id: quote.room_type.id,
        checkin: quote.checkin,
        checkout: quote.checkout,
        guests: quote.guests,
      }),
    ).toBeDefined();
    expect(() =>
      createQuoteRequestSchema.parse({
        room_type_id: quote.room_type.id,
        checkin: quote.checkin,
        checkout: quote.checkout,
        guests: quote.guests,
        total_price_cents: 1,
      }),
    ).toThrow();
  });

  it("requires only quote_id to create a booking", () => {
    expect(createBookingRequestSchema.parse({ quote_id: quote.quote_id })).toEqual({
      quote_id: quote.quote_id,
    });
  });

  it("requires a complete replacement quote for QUOTE_CHANGED", () => {
    expect(
      quoteChangedDetailsSchema.parse({
        previous_total_price_cents: quote.total_price_cents,
        replacement_quote: quote,
      }),
    ).toBeDefined();
  });

  it("rejects user, inventory, and history fields from booking summaries", () => {
    const booking = {
      booking_id: "40000000-0000-4000-8000-000000000001",
      booking_number: "SF20260730A1B2C3D4E5F6",
      status: "PENDING_PAYMENT",
      property_name: quote.property.name,
      room_type_name: quote.room_type.name,
      checkin: quote.checkin,
      checkout: quote.checkout,
      nights: quote.nights,
      guests: quote.guests,
      total_price_cents: quote.total_price_cents,
      currency: "CNY",
      expires_at: "2026-07-30T02:15:00.000Z",
      created_at: "2026-07-30T02:00:00.000Z",
    };
    expect(bookingSummarySchema.parse(booking)).toEqual(booking);
    expect(() => bookingSummarySchema.parse({ ...booking, user_id: quote.quote_id })).toThrow();
  });
});
```

- [ ] **Step 2: 运行契约测试确认 RED**

Run:

```powershell
corepack pnpm --filter @stay-fable/api-contracts test -- booking.test.ts
```

Expected: FAIL，提示 `../src/booking.js` 或导出不存在。

- [ ] **Step 3: 实现严格 Zod 契约**

在 `packages/api-contracts/src/booking.ts` 导出：

```ts
export const createQuoteRequestSchema;
export const quoteResponseDataSchema;
export const createBookingRequestSchema;
export const bookingSummarySchema;
export const quoteChangedDetailsSchema;
export const idempotencyKeySchema;

export type CreateQuoteRequest;
export type QuoteResponseData;
export type CreateBookingRequest;
export type BookingSummary;
export type QuoteChangedDetails;
```

实现要求：

- 复用 `catalogDateSchema`、`catalogResourceSchema`、`currencySchema` 和
  `nightlyPriceSchema`；
- 所有 object 使用 `.strict()`；
- `nightly_prices` 为 1–30；
- `nights` 为 1–30，且必须等于日期差和明细数量；
- `total_price_cents` 必须等于逐晚 `sale_price_cents` 的 safe integer 求和；
- `expires_at`、`created_at` 只接受带 `Z` 或显式 offset 的 ISO 8601 时间；
- 业务编号匹配 `^SF[0-9]{8}[A-F0-9]{12}$`；
- 幂等键匹配 `^[A-Za-z0-9._~-]{32,80}$`。

在 `packages/api-contracts/package.json` 增加：

```json
"./booking": {
  "types": "./src/booking.ts",
  "default": "./dist/src/booking.js"
}
```

- [ ] **Step 4: 运行契约测试和包门禁**

Run:

```powershell
corepack pnpm --filter @stay-fable/api-contracts test
corepack pnpm --filter @stay-fable/api-contracts typecheck
corepack pnpm --filter @stay-fable/api-contracts build
```

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```powershell
git add packages/api-contracts
git commit -m "feat(contracts): define quote and booking APIs"
```

## Task 2：迁移报价、订单、占用和状态历史

**Files:**

- Modify: `apps/api-server/prisma/schema.prisma`
- Create: `apps/api-server/prisma/migrations/202607300001_quote_booking_hold/migration.sql`
- Create: `apps/api-server/test/database/quote-booking.integration.test.ts`

- [ ] **Step 1: 写数据库契约 RED 测试**

在 `quote-booking.integration.test.ts` 使用现有
`requireSafeDatabaseIntegrationUrl`，并复用
`identity-location.integration.test.ts` 的随机 schema、`search_path`、`finally DROP SCHEMA`
隔离模式，先断言：

```ts
expect(await enumValues("BookingStatus")).toEqual([
  "PENDING_PAYMENT",
  "PAID",
  "CONFIRMED",
  "CANCELLED",
  "CLOSED",
]);

expect(await tableColumns("quote")).toMatchObject({
  user_id: { data_type: "uuid", is_nullable: "NO" },
  nightly_prices: { data_type: "jsonb", is_nullable: "NO" },
  expires_at: { data_type: "timestamp with time zone", is_nullable: "NO" },
});

await expect(
  pool.query(
    `UPDATE daily_inventory
     SET held_inventory = total_inventory + 1
     WHERE room_type_id = $1 AND business_date = $2`,
    [roomTypeId, businessDate],
  ),
).rejects.toMatchObject({
  code: "23514",
  constraint: "daily_inventory_capacity_check",
});
```

测试还必须检查：

- `booking(user_id, idempotency_key)` 唯一；
- `booking.quote_id` 唯一；
- `inventory_hold(booking_id, business_date)` 唯一；
- quote/booking 日期、人数、金额和 `CNY` check；
- daily price 非负且 rack 不小于 sale；
- history 外键和索引；
- 同一迁移第二次 deploy 无 pending。

- [ ] **Step 2: 启动隔离 PostgreSQL、迁移既有基线并确认 RED**

Run:

```powershell
$composeWindows = (Resolve-Path -LiteralPath infrastructure/compose.yaml).Path
$composeWsl = (wsl.exe -d Ubuntu-22.04 -- wslpath -a $composeWindows).Trim()
if ($LASTEXITCODE -ne 0 -or -not $composeWsl.StartsWith("/mnt/")) {
  throw "Unable to resolve the Slice 3 Compose path in WSL"
}
wsl.exe -d Ubuntu-22.04 -- env POSTGRES_PORT=55432 docker compose `
  --project-name stay-fable-slice3-test `
  -f $composeWsl `
  up -d --wait postgres
if ($LASTEXITCODE -ne 0) { throw "Unable to start the isolated Slice 3 PostgreSQL" }
wsl.exe -d Ubuntu-22.04 -- docker compose `
  --project-name stay-fable-slice3-test `
  -f $composeWsl `
  exec -T postgres dropdb --if-exists -U stay_fable stay_fable_ci
if ($LASTEXITCODE -ne 0) { throw "Unable to reset stay_fable_ci" }
wsl.exe -d Ubuntu-22.04 -- docker compose `
  --project-name stay-fable-slice3-test `
  -f $composeWsl `
  exec -T postgres createdb -U stay_fable stay_fable_ci
if ($LASTEXITCODE -ne 0) { throw "Unable to create stay_fable_ci" }

$env:RUN_DATABASE_INTEGRATION = "true"
$env:DATABASE_URL = "postgresql://stay_fable:local_only_password@127.0.0.1:55432/stay_fable_ci?schema=public&sslmode=disable"
corepack pnpm --filter @stay-fable/api-server prisma:migrate
if ($LASTEXITCODE -ne 0) { throw "Unable to migrate the existing test baseline" }
corepack pnpm --filter @stay-fable/api-server test -- quote-booking.integration.test.ts
```

Expected: 最后一条命令 FAIL，缺少表、枚举或约束；数据库守卫接受
`postgresql://stay_fable:local_only_password@127.0.0.1:55432/stay_fable_ci?schema=public&sslmode=disable`。
不得改用 `stay_fable`、`rims-postgres` 或其他非隔离数据库。

- [ ] **Step 3: 更新 Prisma schema**

增加：

```prisma
enum BookingStatus {
  PENDING_PAYMENT
  PAID
  CONFIRMED
  CANCELLED
  CLOSED
}

enum InventoryHoldStatus {
  HELD
  CONSUMED
  RELEASED
}

enum BookingActorType {
  USER
  SYSTEM
}

model Quote {
  id                    String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId                String   @map("user_id") @db.Uuid
  propertyId            String   @map("property_id") @db.Uuid
  roomTypeId            String   @map("room_type_id") @db.Uuid
  checkinDate           DateTime @map("checkin_date") @db.Date
  checkoutDate          DateTime @map("checkout_date") @db.Date
  guests                Int
  nightlyPrices         Json     @map("nightly_prices")
  propertySnapshot      Json     @map("property_snapshot")
  roomTypeSnapshot      Json     @map("room_type_snapshot")
  bookingPolicySnapshot String   @map("booking_policy_snapshot") @db.VarChar(2000)
  totalPriceCents       Int      @map("total_price_cents")
  currency              String   @default("CNY") @db.Char(3)
  fingerprint           String   @db.Char(64)
  expiresAt             DateTime @map("expires_at") @db.Timestamptz(3)
  createdAt             DateTime @default(now()) @map("created_at") @db.Timestamptz(3)

  @@index([userId, expiresAt], map: "quote_user_expires_idx")
  @@index([roomTypeId, createdAt], map: "quote_room_created_idx")
  @@map("quote")
}

model Booking {
  id                    String        @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId                String        @map("user_id") @db.Uuid
  quoteId               String        @unique(map: "booking_quote_id_key") @map("quote_id") @db.Uuid
  propertyId            String        @map("property_id") @db.Uuid
  roomTypeId            String        @map("room_type_id") @db.Uuid
  bookingNumber         String        @unique(map: "booking_booking_number_key") @map("booking_number") @db.VarChar(22)
  status                BookingStatus @default(PENDING_PAYMENT)
  checkinDate           DateTime      @map("checkin_date") @db.Date
  checkoutDate          DateTime      @map("checkout_date") @db.Date
  guests                Int
  propertySnapshot      Json          @map("property_snapshot")
  roomTypeSnapshot      Json          @map("room_type_snapshot")
  nightlyPrices         Json          @map("nightly_prices")
  bookingPolicySnapshot String        @map("booking_policy_snapshot") @db.VarChar(2000)
  totalPriceCents       Int           @map("total_price_cents")
  currency              String        @default("CNY") @db.Char(3)
  idempotencyKey        String        @map("idempotency_key") @db.VarChar(80)
  expiresAt             DateTime      @map("expires_at") @db.Timestamptz(3)
  createdAt             DateTime      @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt             DateTime      @updatedAt @map("updated_at") @db.Timestamptz(3)
  user                  User          @relation(fields: [userId], references: [id], onDelete: Restrict, onUpdate: Cascade)
  quote                 Quote         @relation(fields: [quoteId], references: [id], onDelete: Restrict, onUpdate: Cascade)
  property              Property      @relation(fields: [propertyId], references: [id], onDelete: Restrict, onUpdate: Cascade)
  roomType              RoomType      @relation(fields: [roomTypeId], references: [id], onDelete: Restrict, onUpdate: Cascade)
  inventoryHolds        InventoryHold[]
  statusHistory         BookingStatusHistory[]

  @@unique([userId, idempotencyKey], map: "booking_user_id_idempotency_key_key")
  @@index([userId, createdAt, id], map: "booking_user_created_id_idx")
  @@index([status, expiresAt, id], map: "booking_status_expires_id_idx")
  @@map("booking")
}

model InventoryHold {
  id           String              @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  bookingId    String              @map("booking_id") @db.Uuid
  roomTypeId   String              @map("room_type_id") @db.Uuid
  businessDate DateTime            @map("business_date") @db.Date
  status       InventoryHoldStatus @default(HELD)
  expiresAt    DateTime            @map("expires_at") @db.Timestamptz(3)
  createdAt    DateTime            @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt    DateTime            @updatedAt @map("updated_at") @db.Timestamptz(3)
  booking      Booking             @relation(fields: [bookingId], references: [id], onDelete: Restrict, onUpdate: Cascade)
  roomType     RoomType            @relation(fields: [roomTypeId], references: [id], onDelete: Restrict, onUpdate: Cascade)

  @@unique([bookingId, businessDate], map: "inventory_hold_booking_id_business_date_key")
  @@index([status, expiresAt, id], map: "inventory_hold_status_expires_id_idx")
  @@index([roomTypeId, businessDate], map: "inventory_hold_room_date_idx")
  @@map("inventory_hold")
}

model BookingStatusHistory {
  id          String           @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  bookingId   String           @map("booking_id") @db.Uuid
  fromStatus  BookingStatus?   @map("from_status")
  toStatus    BookingStatus    @map("to_status")
  reason      String           @db.VarChar(64)
  actorType   BookingActorType @map("actor_type")
  actorUserId String?          @map("actor_user_id") @db.Uuid
  createdAt   DateTime         @default(now()) @map("created_at") @db.Timestamptz(3)
  booking     Booking          @relation(fields: [bookingId], references: [id], onDelete: Restrict, onUpdate: Cascade)
  actorUser   User?            @relation("BookingStatusActor", fields: [actorUserId], references: [id], onDelete: Restrict, onUpdate: Cascade)

  @@index([bookingId, createdAt, id], map: "booking_status_history_booking_created_id_idx")
  @@index([actorUserId], map: "booking_status_history_actor_user_id_idx")
  @@map("booking_status_history")
}
```

同时在既有模型增加反向 relation：

```prisma
model User {
  // existing fields
  quotes               Quote[]
  bookings             Booking[]
  bookingStatusHistory BookingStatusHistory[] @relation("BookingStatusActor")
}

model Property {
  // existing fields
  quotes   Quote[]
  bookings Booking[]
}

model RoomType {
  // existing fields
  quotes         Quote[]
  bookings       Booking[]
  inventoryHolds InventoryHold[]
}
```

并在 `Quote` 增加 `user`、`property`、`roomType` 和可空反向 `booking` relation。上述
`// existing fields` 只表示保留当前字段，不是可复制的新模型定义。

- [ ] **Step 4: 编写显式 SQL 迁移**

迁移必须：

- 创建 enum、表、外键、唯一约束和索引；
- 为现有 `daily_price` / `daily_inventory` 加命名 check；
- 使用 `NOT VALID` + `VALIDATE CONSTRAINT` 只在确有必要时控制锁，但不得跳过验证；
- 不更新或删除现有 Catalog 数据；
- 不包含 down migration。

- [ ] **Step 5: 生成 Prisma client 并运行集成测试**

Run:

```powershell
$env:RUN_DATABASE_INTEGRATION = "true"
$env:DATABASE_URL = "postgresql://stay_fable:local_only_password@127.0.0.1:55432/stay_fable_ci?schema=public&sslmode=disable"
corepack pnpm prisma:generate
corepack pnpm --filter @stay-fable/api-server typecheck
corepack pnpm --filter @stay-fable/api-server test -- quote-booking.integration.test.ts
```

Expected: PASS。

- [ ] **Step 6: 提交**

```powershell
git add apps/api-server/prisma apps/api-server/test/database/quote-booking.integration.test.ts
git commit -m "feat(database): add quote booking and inventory holds"
```

## Task 3：实现写接口 Redis 限流

**Files:**

- Modify: `apps/api-server/src/infrastructure/redis/redis.service.ts`
- Create: `apps/api-server/src/common/rate-limit/write-rate-limit.service.ts`
- Create: `apps/api-server/test/write-rate-limit.service.test.ts`

- [ ] **Step 1: 写限流 RED 测试**

测试固定：

```ts
const quotes = { scope: "quotes", limit: 30, windowSeconds: 60 };
const bookings = { scope: "bookings", limit: 10, windowSeconds: 60 };
```

覆盖：

- Redis Lua 返回 `{ count, ttlMilliseconds }`；
- 第 30/10 次允许，下一次抛 `429 RATE_LIMITED`；
- `retry_after_seconds` 为 1–60；
- key 只含 `sha256(userId)`，不含原 UUID；
- Redis 错误转为 `503 BOOKING_SERVICE_UNAVAILABLE`；
- Redis 错误时不调用后续业务 callback。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```powershell
corepack pnpm --filter @stay-fable/api-server test -- write-rate-limit.service.test.ts
```

Expected: FAIL，服务不存在。

- [ ] **Step 3: 增加 Redis 原子脚本入口**

为 `RedisService` 增加窄接口：

```ts
async executeRateLimit(
  key: string,
  limit: number,
  windowMilliseconds: number,
): Promise<{ count: number; ttlMilliseconds: number }>;
```

Lua 必须在首次 `INCR` 时设置 `PEXPIRE`，并始终返回当前 count 和 `PTTL`。解析非整数、负 TTL
或错误 shape 时安全失败。

- [ ] **Step 4: 实现 `WriteRateLimitService`**

公开方法：

```ts
checkQuotes(userId: string): Promise<void>;
checkBookings(userId: string): Promise<void>;
```

使用 `createHash("sha256").update(userId, "utf8").digest("hex")` 生成 key 摘要，不记录原 ID。

- [ ] **Step 5: 运行测试与 lint**

Run:

```powershell
corepack pnpm --filter @stay-fable/api-server test -- write-rate-limit.service.test.ts
corepack pnpm --filter @stay-fable/api-server lint
```

Expected: PASS。

- [ ] **Step 6: 提交**

```powershell
git add apps/api-server/src/infrastructure/redis/redis.service.ts apps/api-server/src/common/rate-limit apps/api-server/test/write-rate-limit.service.test.ts
git commit -m "feat(api): rate limit quote and booking writes"
```

## Task 4：实现规范报价指纹

**Files:**

- Create: `apps/api-server/src/pricing/quote-fingerprint.ts`
- Create: `apps/api-server/test/quote-fingerprint.test.ts`

- [ ] **Step 1: 写指纹 RED 测试**

覆盖：

- 输入字段顺序变化不改变结果；
- nightly 顺序由函数按业务日期规范化；
- 价格、政策、property/room 快照任一变化改变结果；
- inventory version、held、sold 不在输入类型中；
- 非法日期、重复日期、非 safe integer、未知字段被拒绝；
- 结果为 64 位小写 hex。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```powershell
corepack pnpm --filter @stay-fable/api-server test -- quote-fingerprint.test.ts
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现规范序列化**

导出：

```ts
export interface QuoteFingerprintInput {
  property: { id: string; name: string };
  roomType: { id: string; name: string; coverUrl: string };
  checkin: string;
  checkout: string;
  guests: number;
  bookingPolicy: string;
  nightlyPrices: Array<{
    businessDate: string;
    salePriceCents: number;
    rackPriceCents: number;
  }>;
}

export const createQuoteFingerprint = (input: QuoteFingerprintInput): string;
```

先用共享 Zod schema parse，再构造固定字段数组并 SHA-256。不得直接对调用者对象
`JSON.stringify`。

- [ ] **Step 4: 运行测试**

Run:

```powershell
corepack pnpm --filter @stay-fable/api-server test -- quote-fingerprint.test.ts
```

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add apps/api-server/src/pricing/quote-fingerprint.ts apps/api-server/test/quote-fingerprint.test.ts
git commit -m "feat(pricing): fingerprint canonical quotes"
```

## Task 5：实现报价 Repository 与 Service

**Files:**

- Create: `apps/api-server/src/pricing/quote.repository.ts`
- Create: `apps/api-server/src/pricing/quotes.service.ts`
- Create: `apps/api-server/src/pricing/pricing.module.ts`
- Create: `apps/api-server/test/quotes.service.test.ts`

- [ ] **Step 1: 写报价 Service RED 测试**

使用 `FixedClock` 和 mock repository 覆盖：

```ts
expect(result.expires_at).toBe("2026-07-30T02:05:00.000Z");
expect(result.total_price_cents).toBe(121600);
expect(repository.createQuote).toHaveBeenCalledWith(
  expect.objectContaining({
    userId,
    roomTypeId,
    expiresAt: new Date("2026-07-30T02:05:00.000Z"),
  }),
);
```

还要覆盖：

- 房型不可用；
- 容量超过；
- 任一晚缺价格/库存；
- 任一晚 available 为 0；
- 30 晚和 safe integer；
- 时钟无效；
- repository 异常转为安全 503；
- 限流在数据库查询前执行。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```powershell
corepack pnpm --filter @stay-fable/api-server test -- quotes.service.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现 `QuoteRepository`**

公开窄方法：

```ts
findQuoteInput(
  roomTypeId: string,
  range: { checkin: string; checkout: string; nights: number; guests: number },
): Promise<QuoteInputLookup>;

createQuote(input: PersistQuoteInput): Promise<QuoteRecord>;
```

读取 SQL 必须：

- 只查 `OPEN` property 和 `ON_SALE` room；
- 日期区间 `[checkin, checkout)`；
- `ORDER BY business_date ASC`；
- 返回逐晚价格和 `available > 0` 布尔，不返回库存到 Controller；
- 所有外部值参数化。

- [ ] **Step 4: 实现 `QuotesService`**

构造函数：

```ts
constructor(
  private readonly repository: QuoteRepository,
  private readonly rateLimit: WriteRateLimitService,
  @Inject(CLOCK) private readonly clock: Clock,
) {}
```

流程严格按设计文档第 8 节。使用共享 `parseCatalogDateRange`，不得复制另一套日期规则。

`PricingModule` 必须导入 `DatabaseModule`、`RedisModule` 和 `IdentityModule`，注册
`QuoteRepository`、`QuotesService`、`WriteRateLimitService` 以及
`{ provide: CLOCK, useValue: systemClock }`，并导出 `WriteRateLimitService` 供
`BookingModule` 复用。不得在两个模块中创建行为不同的限流器。

- [ ] **Step 5: 运行测试、类型和 lint**

Run:

```powershell
corepack pnpm --filter @stay-fable/api-server test -- quotes.service.test.ts
corepack pnpm --filter @stay-fable/api-server typecheck
corepack pnpm --filter @stay-fable/api-server lint
```

Expected: PASS。

- [ ] **Step 6: 提交**

```powershell
git add apps/api-server/src/pricing apps/api-server/test/quotes.service.test.ts
git commit -m "feat(pricing): create expiring quote snapshots"
```

## Task 6：暴露报价 API 与 OpenAPI

**Files:**

- Create: `apps/api-server/src/pricing/quotes.controller.ts`
- Create: `apps/api-server/src/pricing/dto/quote-request.dto.ts`
- Create: `apps/api-server/src/pricing/dto/quote-response.dto.ts`
- Modify: `apps/api-server/src/pricing/pricing.module.ts`
- Modify: `apps/api-server/src/app.module.ts`
- Create: `apps/api-server/test/quotes.controller.e2e.test.ts`
- Create: `apps/api-server/test/booking.openapi.test.ts`

- [ ] **Step 1: 写 Controller/OpenAPI RED 测试**

断言：

```ts
await request(app.getHttpServer())
  .post("/api/v1/quotes")
  .set("Authorization", `Bearer ${accessToken}`)
  .send({
    room_type_id: roomTypeId,
    checkin: "2026-08-01",
    checkout: "2026-08-03",
    guests: 2,
  })
  .expect(201)
  .expect(({ body }) => {
    expect(body.data.total_price_cents).toBe(121600);
    expect(body.request_id).toMatch(/^req_/);
  });
```

覆盖无认证、未知字段、错误日期、容量、限流 429 和安全 503。OpenAPI 必须声明严格请求、201
响应和业务错误。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```powershell
corepack pnpm --filter @stay-fable/api-server test -- quotes.controller.e2e.test.ts booking.openapi.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现 DTO 和 Controller**

Controller：

```ts
@Post("quotes")
@HttpCode(HttpStatus.CREATED)
@UseGuards(SessionAuthGuard)
createQuote(
  @CurrentUser() user: AuthenticatedUser,
  @Body() body: CreateQuoteRequestDto,
): Promise<QuoteResponseData> {
  return this.quotes.create(user.id, body);
}
```

DTO 使用 `class-validator` 做 transport 校验，Service 入口再次用共享 Zod schema parse。

- [ ] **Step 4: 接入 AppModule 并验证**

Run:

```powershell
corepack pnpm --filter @stay-fable/api-server test -- quotes.controller.e2e.test.ts booking.openapi.test.ts
corepack pnpm --filter @stay-fable/api-server build
```

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add apps/api-server/src/pricing apps/api-server/src/app.module.ts apps/api-server/test/quotes.controller.e2e.test.ts apps/api-server/test/booking.openapi.test.ts
git commit -m "feat(api): expose authenticated quote creation"
```

## Task 7：实现业务编号与下单事务

**Files:**

- Create: `apps/api-server/src/booking/booking-number.ts`
- Create: `apps/api-server/src/booking/booking.repository.ts`
- Create: `apps/api-server/src/booking/bookings.service.ts`
- Create: `apps/api-server/src/booking/booking.module.ts`
- Create: `apps/api-server/test/bookings.service.test.ts`

- [ ] **Step 1: 写业务编号与 Service RED 测试**

覆盖：

- `SF + UTC YYYYMMDD + 12 uppercase hex`；
- 注入随机源短读、抛错和碰撞；
- 相同用户/键先返回原订单；
- quote 不存在、过期、已使用；
- quote changed 提交替代报价结果，不占库存；
- inventory unavailable；
- 初次成功写 booking、每晚 hold、history；
- 业务编号唯一冲突使整个事务回滚，并最多重试一次；
- 未知唯一冲突不当作幂等成功。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```powershell
corepack pnpm --filter @stay-fable/api-server test -- bookings.service.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现业务编号生成器**

导出：

```ts
export interface BookingNumberGenerator {
  next(now: Date): string;
}

export const createBookingNumberGenerator = (
  randomBytes?: (size: number) => Buffer,
): BookingNumberGenerator;
```

只接受有效 `Date`，随机源必须精确返回 6 bytes。

- [ ] **Step 4: 实现 `BookingRepository.createFromQuote`**

接口返回 discriminated union：

```ts
type CreateBookingResult =
  | { kind: "CREATED"; booking: BookingSummary }
  | { kind: "REPLAYED"; booking: BookingSummary }
  | { kind: "QUOTE_EXPIRED" }
  | { kind: "QUOTE_ALREADY_USED" }
  | { kind: "QUOTE_CHANGED"; details: QuoteChangedDetails }
  | { kind: "INVENTORY_UNAVAILABLE" };
```

事务必须：

1. advisory lock 当前用户和幂等键；
2. 查询同键订单；
3. quote `FOR UPDATE` 且包含 user；
4. 重新读取并计算指纹；
5. changed 时写 replacement quote 并正常 commit；
6. 日期升序 `FOR UPDATE` inventory；
7. 每晚条件更新 held/version；
8. 写 booking、holds、history；
9. 返回领域结果。

所有 SQL 使用参数化 `Prisma.sql`。事务内禁止网络、Redis、日志和真实等待。

- [ ] **Step 5: 实现 `BookingsService`**

Service 在事务前执行 booking rate limit、严格 header/body parse 和时钟校验；把领域结果转换为
`BusinessException`。`QUOTE_CHANGED` details 再次通过共享 schema parse。

`BookingModule` 导入 `DatabaseModule`、`IdentityModule` 和 `PricingModule`，注册
`BookingRepository`、`BookingsService`、业务编号生成器以及
`{ provide: CLOCK, useValue: systemClock }`。`WriteRateLimitService` 必须从
`PricingModule` 导出的同一 provider 解析，不能在下单模块另建计数命名空间。

- [ ] **Step 6: 运行单元测试和门禁**

Run:

```powershell
corepack pnpm --filter @stay-fable/api-server test -- bookings.service.test.ts
corepack pnpm --filter @stay-fable/api-server typecheck
corepack pnpm --filter @stay-fable/api-server lint
```

Expected: PASS。

- [ ] **Step 7: 提交**

```powershell
git add apps/api-server/src/booking apps/api-server/test/bookings.service.test.ts
git commit -m "feat(booking): reserve inventory in idempotent transactions"
```

## Task 8：暴露创建订单 API

**Files:**

- Create: `apps/api-server/src/booking/bookings.controller.ts`
- Create: `apps/api-server/src/booking/dto/create-booking.dto.ts`
- Create: `apps/api-server/src/booking/dto/booking-response.dto.ts`
- Modify: `apps/api-server/src/booking/booking.module.ts`
- Modify: `apps/api-server/src/app.module.ts`
- Create: `apps/api-server/test/bookings.controller.e2e.test.ts`
- Modify: `apps/api-server/test/booking.openapi.test.ts`

- [ ] **Step 1: 写 Controller RED 测试**

覆盖：

- 首次创建 `201`；
- 同键 replay `200`；
- 缺失、重复或非法 `Idempotency-Key`；
- body 未知字段；
- `QUOTE_EXPIRED`、`QUOTE_CHANGED`、`QUOTE_ALREADY_USED`、
  `INVENTORY_UNAVAILABLE`；
- 无认证和禁用用户；
- 429/503；
- 响应不含 user/inventory/history。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```powershell
corepack pnpm --filter @stay-fable/api-server test -- bookings.controller.e2e.test.ts booking.openapi.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现 header 解析和动态状态码**

Controller 不接受数组 header：

```ts
const parseIdempotencyHeader = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new BusinessException(400, "IDEMPOTENCY_KEY_INVALID", "请求标识无效");
  }
  return idempotencyKeySchema.parse(value);
};
```

Service 返回 `{ replayed, booking }`，Controller 使用 `@Res({ passthrough: true })`：

```ts
response.status(result.replayed ? 200 : 201);
return result.booking;
```

不得让 Controller 自行查数据库判断 replay。

- [ ] **Step 4: 更新 OpenAPI**

声明：

- required `Idempotency-Key` header；
- `201` 创建和 `200` replay；
- 409 details 的 replacement quote；
- 429 和 503；
- bearer auth。

- [ ] **Step 5: 运行测试和 build**

Run:

```powershell
corepack pnpm --filter @stay-fable/api-server test -- bookings.controller.e2e.test.ts booking.openapi.test.ts
corepack pnpm --filter @stay-fable/api-server build
```

Expected: PASS。

- [ ] **Step 6: 提交**

```powershell
git add apps/api-server/src/booking apps/api-server/src/app.module.ts apps/api-server/test/bookings.controller.e2e.test.ts apps/api-server/test/booking.openapi.test.ts
git commit -m "feat(api): expose idempotent booking creation"
```

## Task 9：证明真实 PostgreSQL 并发与回滚

**Files:**

- Modify: `apps/api-server/test/database/quote-booking.integration.test.ts`

开始本任务前确认 `stay-fable-slice3-test` PostgreSQL 仍健康；若已停止，则重新执行 Task 2
Step 2 代码块中从定义 `$composeWindows` 到检查 `prisma:migrate` 退出码的全部命令，再继续
本任务。

- [ ] **Step 1: 增加 barrier 并发 RED 测试**

使用两个独立 `pg.PoolClient` 和有界 barrier：

```ts
const barrier = createBarrier(2, 5_000);

const compete = async (userId: string, quoteId: string, key: string) => {
  await barrier.arrive();
  return createBookingThroughRepository({ userId, quoteId, idempotencyKey: key });
};

const results = await Promise.allSettled([
  compete(firstUserId, firstQuoteId, firstKey),
  compete(secondUserId, secondQuoteId, secondKey),
]);
```

测试精确覆盖设计第 13.2 节八类场景，并在每例后查询：

- booking 数量；
- hold 数量和状态；
- history 数量；
- 每晚 held/sold/total/version；
- 不存在部分写入。

- [ ] **Step 2: 运行确认至少并发用例 RED**

Run:

```powershell
$env:RUN_DATABASE_INTEGRATION = "true"
$env:DATABASE_URL = "postgresql://stay_fable:local_only_password@127.0.0.1:55432/stay_fable_ci?schema=public&sslmode=disable"
corepack pnpm --filter @stay-fable/api-server test -- quote-booking.integration.test.ts
```

Expected: 新增并发断言在事务实现未正确接线时 FAIL。

- [ ] **Step 3: 只修正事务实现，不放宽测试**

允许修改：

- `apps/api-server/src/booking/booking.repository.ts`
- `apps/api-server/src/booking/bookings.service.ts`

禁止：

- 用串行测试代替 barrier；
- 增加任意 sleep 让竞态“更容易通过”；
- 在测试外重置库存掩盖部分提交；
- 用 Redis 锁替代 PostgreSQL。

- [ ] **Step 4: 连续运行集成测试三次**

Run:

```powershell
$env:RUN_DATABASE_INTEGRATION = "true"
$env:DATABASE_URL = "postgresql://stay_fable:local_only_password@127.0.0.1:55432/stay_fable_ci?schema=public&sslmode=disable"
1..3 | ForEach-Object {
  corepack pnpm --filter @stay-fable/api-server test -- quote-booking.integration.test.ts
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
```

Expected: 三次均 PASS，无挂起。

- [ ] **Step 5: 提交**

```powershell
git add apps/api-server/src/booking apps/api-server/test/database/quote-booking.integration.test.ts
git commit -m "test(booking): prove PostgreSQL inventory serialization"
```

- [ ] **Step 6: 停止本任务拥有的测试容器**

Run:

```powershell
$composeWindows = (Resolve-Path -LiteralPath infrastructure/compose.yaml).Path
$composeWsl = (wsl.exe -d Ubuntu-22.04 -- wslpath -a $composeWindows).Trim()
wsl.exe -d Ubuntu-22.04 -- docker compose `
  --project-name stay-fable-slice3-test `
  -f $composeWsl `
  down
if ($LASTEXITCODE -ne 0) { throw "Unable to stop the isolated Slice 3 PostgreSQL" }
```

Expected: 只移除 `stay-fable-slice3-test` 的容器和网络；不带 `--volumes`，不操作
`rims-postgres` 或其他 Compose 项目。

## Task 10：扩展 WSL2 Slice 3 smoke

**Files:**

- Modify: `scripts/wsl-runtime-validation.ps1`
- Modify: `scripts/wsl-runtime-validation.test.mjs`

- [ ] **Step 1: 写脚本契约 RED 测试**

要求脚本输出固定标志：

```text
SLICE3_QUOTE_CREATED
SLICE3_IDEMPOTENT_REPLAY
SLICE3_LAST_ROOM_SERIALIZED
SLICE3_MULTI_NIGHT_ROLLED_BACK
SLICE3_QUOTE_CHANGED_NO_HOLD
SLICE3_QUOTE_EXPIRED_NO_HOLD
```

测试还要验证：

- 用两个独立测试用户；
- 不输出 access token、幂等键、用户 UUID、SQL 或库存内部值；
- 所有 HTTP 和 SQL 辅助调用有界；
- 失败仍进入 owner cleanup；
- 不停止 `rims-postgres` 或无关容器。

- [ ] **Step 2: 运行脚本测试确认 RED**

Run:

```powershell
node --test scripts/wsl-runtime-validation.test.mjs
```

Expected: FAIL，缺少 Slice 3 marker。

- [ ] **Step 3: 实现 Slice 3 smoke**

在现有 READY 后：

1. 通过真实登录获得两个内存会话；
2. 创建报价；
3. 同键下单两次并比较安全业务字段；
4. 重置 owner seed 后执行最后一间并发；
5. 多晚回滚、价格变化和过期；
6. 只输出 marker，不输出秘密；
7. smoke 完成后输出 `SLICE3_UAT_READY http://127.0.0.1:3000`，再进入原有 Worker
   10/10 分钟观察；该窗口供 Task 15 在另一个终端完成官方工具人工 UAT；
8. UAT 使用一间未被并发 smoke 修改的既有种子房型，脚本不得为此增加测试后门 API；
9. cleanup 保持 owner 边界。

- [ ] **Step 4: 运行静态脚本测试**

Run:

```powershell
node --test scripts/wsl-runtime-validation.test.mjs
```

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add scripts/wsl-runtime-validation.ps1 scripts/wsl-runtime-validation.test.mjs
git commit -m "test(runtime): add quote and booking smoke checks"
```

## Task 11：实现微信端严格报价与订单服务

**Files:**

- Modify: `wx/services/contracts.js`
- Create: `wx/services/booking.js`
- Create: `wx/tests/booking-contracts.test.js`
- Create: `wx/tests/booking-service.test.js`

- [ ] **Step 1: 写微信契约与服务 RED 测试**

覆盖：

- quote/booking/replacement quote 严格字段；
- 日期差、nightly 数量、safe integer 总价；
- 请求 ID 与响应 quote/booking ID 绑定；
- 未知库存、user、history、version 字段拒绝且不保留；
- `createQuote` 只传 room/date/guests；
- `createBooking` 只传 quote ID 和 header；
- booking POST `retry: false`；
- 401 单次 replay 保持相同 body 和幂等键；
- 输入对象、回调对象和环境对象 getter/prototype hostile；
- 晚到响应不改变已取消调用。

- [ ] **Step 2: 运行确认 RED**

Run:

```powershell
corepack pnpm vitest run wx/tests/booking-contracts.test.js wx/tests/booking-service.test.js
```

Expected: FAIL，模块或断言不存在。

- [ ] **Step 3: 实现微信契约**

在 `contracts.js` 导出：

```js
assertQuoteResponse(value, requestedRoomTypeId);
assertBookingResponse(value, requestedQuoteId);
assertQuoteChangedDetails(value);
```

实现沿用当前 null-prototype snapshot、防 getter 和 exact-key 模式，不把共享 Zod 运行时打包进
小程序。

- [ ] **Step 4: 实现 `booking.js`**

导出：

```js
createQuote(input, options);
createBooking(input, idempotencyKey, options);
```

调用现有 `request` 服务；显式关闭网络重试，禁止记录 header/body。输入在任何 await 前做安全快照。

- [ ] **Step 5: 运行微信服务测试**

Run:

```powershell
corepack pnpm vitest run wx/tests/booking-contracts.test.js wx/tests/booking-service.test.js
corepack pnpm wx:check
```

Expected: PASS。

- [ ] **Step 6: 提交**

```powershell
git add wx/services/contracts.js wx/services/booking.js wx/tests/booking-contracts.test.js wx/tests/booking-service.test.js
git commit -m "feat(wx): request strict quotes and bookings"
```

## Task 12：实现预订确认页

**Files:**

- Create: `wx/pages/booking-confirm/booking-confirm.logic.js`
- Create: `wx/pages/booking-confirm/booking-confirm.js`
- Create: `wx/pages/booking-confirm/booking-confirm.json`
- Create: `wx/pages/booking-confirm/booking-confirm.wxml`
- Create: `wx/pages/booking-confirm/booking-confirm.wxss`
- Create: `wx/tests/booking-confirm-page.test.js`

- [ ] **Step 1: 写页面逻辑 RED 测试**

`booking-confirm.logic.js` 纯函数覆盖：

```js
createQuoteView(quote, now);
createBookingView(booking);
remainingSeconds(expiresAt, now);
quoteChangedView(previousTotal, replacementQuote, now);
```

断言：

- 服务端 nights/total/nightly 原样使用；
- 价格格式复用 `money` 工具；
- 过期剩余为 0；
- replacement 明确 old/new total；
- 输入不保留未知字段。

- [ ] **Step 2: 写页面生命周期 RED 测试**

覆盖：

- 严格 room UUID；
- 从 `searchStore` 读取日期/人数；
- load quote、error、retry；
- 倒计时只禁用按钮、不改变服务端到期；
- 同一报价双击只发一个 booking；
- network failure 后复用同一 idempotency key；
- quote changed 不自动下单，接受后切新 scope；
- inventory/expired 明确状态；
- success 原地展示，不调用支付；
- hide/unload 取消 timer、generation 和晚到响应；
- toast/modal/navigation fail 解锁。

- [ ] **Step 3: 运行确认 RED**

Run:

```powershell
corepack pnpm vitest run wx/tests/booking-confirm-page.test.js
```

Expected: FAIL，页面模块不存在。

- [ ] **Step 4: 实现纯逻辑和页面状态机**

页面定义必须通过依赖注入工厂测试：

```js
function createBookingConfirmPage(dependencies) {
  const bookingApi = dependencies?.bookingApi || require("../../services/booking");
  const idempotency = dependencies?.idempotency || require("../../utils/idempotency");
  const wxApi = dependencies?.wxApi || globalThis.wx;
  const clock = dependencies?.clock || (() => Date.now());
  // return Page definition
}
```

timer 间隔 1 秒；页面隐藏时停止，显示时按服务端 `expires_at` 重算。不得写 storage。

- [ ] **Step 5: 实现 WXML/WXSS**

必须包含：

- loading/error/quote/changed/submitting/created 状态；
- 逐晚价格行；
- 总价和政策；
- 报价/付款截止；
- disabled/pressed/loading 可访问状态；
- 安全区和自定义导航栏；
- 不使用渐变，不添加 emoji 图标。

- [ ] **Step 6: 运行页面测试与静态检查**

Run:

```powershell
corepack pnpm vitest run wx/tests/booking-confirm-page.test.js
corepack pnpm test:wx
corepack pnpm wx:check
```

Expected: PASS。

- [ ] **Step 7: 提交**

```powershell
git add wx/pages/booking-confirm wx/tests/booking-confirm-page.test.js
git commit -m "feat(wx): confirm quotes and create pending bookings"
```

## Task 13：连接房型详情和页面配置

**Files:**

- Modify: `wx/pages/room-detail/room-detail.js`
- Modify: `wx/pages/room-detail/room-detail.wxml`
- Modify: `wx/app.json`
- Modify: `wx/tests/room-detail-page.test.js`
- Modify: `wx/tests/configuration.test.js`

- [ ] **Step 1: 写导航与配置 RED 测试**

断言：

- `selectRoom` 只在 success/active/未 navigating 时执行；
- 只从已验证 `roomType.id` 构造 encode 后 URL；
- 不从 dataset 接收价格/日期/人数；
- navigate success 保持锁直到 hide，fail/reject/throw 解锁；
- 不再调用 `showModal`；
- `app.json` 精确新增第 7 页；
- 页面 JSON 只声明已存在组件。

- [ ] **Step 2: 运行确认 RED**

Run:

```powershell
corepack pnpm vitest run wx/tests/room-detail-page.test.js wx/tests/configuration.test.js
```

Expected: FAIL，仍显示旧 modal 或缺页。

- [ ] **Step 3: 修改房型详情**

`selectRoom` 导航：

```js
wxApi.navigateTo({
  url: `/pages/booking-confirm/booking-confirm?room_type_id=${encodeURIComponent(
    this.data.roomType.id,
  )}`,
  fail: releaseNavigation,
});
```

WXML 按钮文案改为“确认价格并预订”，移除“下一切片”提示。

- [ ] **Step 4: 更新 app 配置并运行门禁**

Run:

```powershell
corepack pnpm vitest run wx/tests/room-detail-page.test.js wx/tests/configuration.test.js
corepack pnpm test:wx
corepack pnpm wx:check
```

Expected: PASS，7 pages。

- [ ] **Step 5: 提交**

```powershell
git add wx/pages/room-detail wx/app.json wx/tests/room-detail-page.test.js wx/tests/configuration.test.js
git commit -m "feat(wx): enter booking confirmation from room details"
```

## Task 14：官方微信编译与人工 UAT 准备

**Files:**

- Modify only if validation exposes a defect in Task 11–13 files.

- [ ] **Step 1: 运行仓库微信门禁**

Run:

```powershell
corepack pnpm test:wx
corepack pnpm wx:check
```

Expected: 全部 PASS，7 pages。

- [ ] **Step 2: 用 initializer 确认环境**

按技能执行：

- WechatIDE version relation 为 equal；
- login 有效；
- token 不需要；
- 打开当前 worktree `/wx`，不得打开根 `dev` 的 `/wx`。

- [ ] **Step 3: 用 compiler 编译**

官方打开并编译：

```text
pages/room-detail/room-detail
pages/booking-confirm/booking-confirm
```

至少完成两页 WXML 和 WXSS，共 4 项成功；再刷新模拟器。

- [ ] **Step 4: 用 debugger 检查**

检查 console/network：

- 无 runtime exception；
- 无 401 循环；
- 每次点击最多一个 quote POST；
- 每次确认最多一个 booking POST；
- 不出现 token、幂等键或内部库存日志。

- [ ] **Step 5: 准备人工 UAT 清单**

记录将在 Task 15 的 `SLICE3_UAT_READY` 窗口执行的清单。以实际执行日 `D` 选择
`D+1`–`D+3`，并使用 Task 10 为 UAT 保留、未被并发 smoke 修改的种子房型：

1. 进入杭州房型；
2. 点击“确认价格并预订”；
3. 核对逐晚价格和总价；
4. 连续点击确认，network 只有一个 booking 写请求；
5. 查看待支付摘要；
6. 确认页面不调用支付，也不宣称到期库存已自动释放；
7. 保存 commit、`/wx` tree、实际日期和脱敏截图。

RC Automator 未修复时，本步骤是必须补充证据，但不自动替代 Slice 5 的 Automator 门禁。

- [ ] **Step 6: 若发现缺陷，按 TDD 修复并提交**

只修改直接暴露缺陷的文件，提交：

```powershell
git commit -m "fix(wx): close quote confirmation validation gaps"
```

没有缺陷时不创建空提交。

## Task 15：完整 WSL2 与 Slice 3 证据

**Files:**

- Create: `docs/verification/2026-07-30-slice-3-quote-booking.md`
- Modify only if validation exposes a defect.

- [ ] **Step 1: 运行全量仓库门禁**

Run:

```powershell
corepack pnpm check
corepack pnpm audit --audit-level high
```

Expected:

- `check` exit 0；
- audit 按实际数量记录；dev 不因已知项中断，release/main 保持阻断。

- [ ] **Step 2: 运行唯一 WSL2 全验证并在稳定窗口执行人工 UAT**

终端 A 从当前 worktree 根目录运行：

```powershell
pwsh -NoProfile -File scripts/wsl-runtime-validation.ps1
```

当终端 A 输出 `SLICE3_UAT_READY http://127.0.0.1:3000` 后，在 Worker 10 分钟观察结束前，
终端 B/微信开发者工具执行 Task 14 Step 5 的清单。只使用开发者工具模拟器的 loopback
连接；若改用真机，必须先配置合规的非生产 HTTPS 域名，不能关闭域名或 TLS 校验充当证据。

Expected:

- PostGIS、PONG、live/ready；
- API/Worker `user=node readonly=true`；
- Slice 1/2 smoke；
- 所有 Slice 3 marker；
- 人工 UAT 完成正常报价、单次下单和待支付摘要，console/network 无秘密和重复 POST；
- Worker 10/10、restart 0；
- cleanup complete；
- `rims-postgres` 未改变。

- [ ] **Step 3: 写验证记录**

记录：

- 输入 commit 和 `/wx` tree；
- migration 和 seed 行数；
- PostgreSQL 并发、幂等、多晚回滚；
- quote changed/expired 不占库存；
- API/Worker/health；
- 微信官方编译、console/network；
- 人工/手机 UAT 的实际 D、D+1、D+3 和截图；
- RC Automator 债务仍在 Slice 5；
- audit 实际计数和 release 阻断。

不得记录 token、幂等键、用户 UUID、精确坐标、private AppID 或内部库存快照。

- [ ] **Step 4: 格式和证据检查**

Run:

```powershell
corepack pnpm prettier --write docs/verification/2026-07-30-slice-3-quote-booking.md
git diff --check
git status --short
```

检查所有证据链接存在、截图脱敏、临时容器和 `.wsl-runtime` 已清理。

- [ ] **Step 5: 提交**

```powershell
git add docs/verification/2026-07-30-slice-3-quote-booking.md
git commit -m "test(slice-3): record quote and booking evidence"
```

- [ ] **Step 6: 最终独立复核**

按顺序执行：

1. Slice 3 规格符合性复核；
2. 代码质量与安全复核；
3. 全切片并发和证据复核。

所有 Critical、Important、Minor 必须关闭后，才能将 Slice 3 功能开发标记完成并进入 Slice 4。

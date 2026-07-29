# 微信预订切片 2：供给浏览 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在真实 PostgreSQL 供给数据上，让 `/wx` 完成“首页搜索 → 旅店列表 → 旅店详情 → 房型详情”，并按城市、日期、人数和旅店类型返回全程可售结果。

**Architecture:** PostgreSQL/Prisma 保存规范化旅店、房型、每日价格和每日库存，NestJS Catalog 模块用固定参数化 SQL 完成全住期可售聚合和稳定游标分页。共享 Zod 契约固定 API 展示 DTO，原生微信端只验证并渲染服务端结果，不计算可售性或订单总价。

**Tech Stack:** TypeScript 6、NestJS 11、Prisma 7、PostgreSQL 17/PostGIS、Zod、Vitest/Supertest、原生微信小程序 JavaScript、微信开发者工具、WSL2 Docker。

---

## 实施约束

- 只在 `codex/wx-mvp-booking-design` 独立 worktree 中执行，不触碰根目录 `dev`
  工作树里的 Turbo 缓存修改。
- 每项行为严格先写失败测试，确认失败原因正确，再写最小实现。
- `/wx` 是唯一正式客户端；不得修改冻结的 `apps/consumer-miniapp`。
- 一级列表只返回旅店。房型只允许从旅店详情进入。
- 价格全部使用人民币分；列表只显示“每晚 ¥xxx 起”，不计算区间总价。
- 搜索区间使用 `[checkin, checkout)`，最多 30 晚；每晚均有价格且可用库存大于零才可售。
- Redis 不参与 Catalog 查询；Slice 2 不创建报价、库存占用、订单或支付。
- 所有动态输入经 DTO 和领域校验后进入参数化 Prisma SQL，不拼接 SQL 字符串。
- 每个微信任务完成 `pnpm wx:check`、`pnpm test:wx` 和微信官方编译；最终闭环再执行
  automator。
- WSL2 验证不得停止或删除无关容器；继续使用既有令牌所有权和原子 Docker 锁。

## 文件结构

```text
apps/api-server/
├─ prisma/
│  ├─ catalog-seed-data.ts
│  ├─ migrations/202607290004_catalog_supply/migration.sql
│  ├─ schema.prisma
│  └─ seed.ts
├─ src/catalog/
│  ├─ catalog-cursor.ts
│  ├─ catalog-date-range.ts
│  ├─ catalog.controller.ts
│  ├─ catalog.module.ts
│  ├─ catalog.repository.ts
│  ├─ catalog.service.ts
│  └─ dto/
│     ├─ catalog-query.dto.ts
│     └─ catalog-response.dto.ts
└─ test/
   ├─ catalog.controller.e2e.test.ts
   ├─ catalog.integration.e2e.test.ts
   ├─ catalog.openapi.test.ts
   ├─ catalog.service.test.ts
   ├─ catalog-cursor.test.ts
   └─ database/catalog-supply.integration.test.ts

packages/api-contracts/
├─ src/catalog.ts
└─ test/catalog.test.ts

wx/
├─ automator/slice-2-catalog.js
├─ components/
│  ├─ price/{price.js,price.json,price.wxml,price.wxss}
│  └─ property-card/{property-card.js,property-card.json,property-card.wxml,property-card.wxss}
├─ pages/
│  ├─ property-list/{property-list.js,property-list.logic.js,property-list.json,property-list.wxml,property-list.wxss}
│  ├─ property-detail/{property-detail.js,property-detail.logic.js,property-detail.json,property-detail.wxml,property-detail.wxss}
│  └─ room-detail/{room-detail.js,room-detail.logic.js,room-detail.json,room-detail.wxml,room-detail.wxss}
├─ services/catalog.js
└─ tests/
   ├─ catalog-contracts.test.js
   ├─ catalog-service.test.js
   ├─ property-components.test.js
   ├─ property-list-page.test.js
   ├─ property-detail-page.test.js
   └─ room-detail-page.test.js
```

## Task 1：固定共享 Catalog 契约

**Files:**

- Create: `packages/api-contracts/src/catalog.ts`
- Create: `packages/api-contracts/test/catalog.test.ts`
- Modify: `packages/api-contracts/package.json`

- [ ] **Step 1：写失败的契约测试**

在 `catalog.test.ts` 用固定 UUID 建立有效列表、旅店详情和房型详情样本，并断言：

```ts
expect(
  propertyListResponseSchema.parse({
    items: [
      {
        id: "20000000-0000-4000-8000-000000000001",
        type: "HOTEL",
        name: "西湖云栖酒店",
        city: {
          id: "10000000-0000-4000-8000-000000000001",
          code: "330100",
          name: "杭州",
        },
        cover_url: "https://images.unsplash.com/photo-1566073771259-6a8506099945",
        short_description: "步行可达湖滨的城市旅店",
        facility_highlights: ["无线网络", "早餐"],
        from_nightly_price_cents: 42800,
        currency: "CNY",
        available_room_type_count: 2,
      },
    ],
    next_cursor: null,
  }),
).toMatchObject({ items: [{ type: "HOTEL" }], next_cursor: null });

expect(() =>
  propertyListResponseSchema.parse({
    items: [{ type: "ROOM" }],
    next_cursor: null,
  }),
).toThrow();

expect(() =>
  roomTypeDetailSchema.parse({
    total_inventory: 2,
    held_inventory: 0,
    sold_inventory: 0,
  }),
).toThrow();
```

同时测试严格日期、人数 1–10、区间最多 30 晚、`page_size` 1–20、三种旅店枚举、
非负安全整数金额、`CNY`、HTTPS 或 `/images/` 本地资源路径，以及对象拒绝未知字段。

运行：

```powershell
pnpm --filter @stay-fable/api-contracts test -- catalog.test.ts
```

预期：FAIL，提示 `catalog.ts` 或导出不存在。

- [ ] **Step 2：实现契约**

`catalog.ts` 固定导出以下 schema 和推导类型：

```ts
import { z } from "zod";

import { citySchema } from "./location.js";

export const propertyTypeSchema = z.enum(["HOTEL", "HOMESTAY", "FARM_STAY"]);
export const currencySchema = z.literal("CNY");
export const catalogDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const catalogResourceSchema = z
  .string()
  .max(500)
  .refine((value) => value.startsWith("https://") || value.startsWith("/images/"));

export const availabilityQuerySchema = z
  .object({
    checkin: catalogDateSchema,
    checkout: catalogDateSchema,
    guests: z.number().int().min(1).max(10),
  })
  .strict();

export const propertyListQuerySchema = availabilityQuerySchema
  .extend({
    city_id: z.uuid(),
    property_type: propertyTypeSchema.optional(),
    page_size: z.number().int().min(1).max(20).default(10),
    cursor: z.string().min(1).max(256).optional(),
  })
  .strict();

const moneySchema = z.number().int().nonnegative().safe();
const facilitySchema = z.object({ code: z.string().min(1), name: z.string().min(1) }).strict();
const mediaSchema = z
  .object({
    type: z.literal("IMAGE"),
    url: catalogResourceSchema,
    alt: z.string().min(1).max(120),
  })
  .strict();

export const propertyListItemSchema = z
  .object({
    id: z.uuid(),
    type: propertyTypeSchema,
    name: z.string().min(1).max(120),
    city: citySchema,
    cover_url: catalogResourceSchema,
    short_description: z.string().min(1).max(240),
    facility_highlights: z.array(z.string().min(1).max(80)).max(4),
    from_nightly_price_cents: moneySchema,
    currency: currencySchema,
    available_room_type_count: z.number().int().positive(),
  })
  .strict();

export const propertyListResponseSchema = z
  .object({
    items: z.array(propertyListItemSchema),
    next_cursor: z.string().min(1).max(256).nullable(),
  })
  .strict();

export const roomTypeSummarySchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1).max(120),
    bed_type: z.string().min(1).max(120),
    area_sqm: z.number().positive(),
    max_guests: z.number().int().min(1).max(10),
    cover_url: catalogResourceSchema,
    policy_summary: z.string().min(1).max(500),
    from_nightly_price_cents: moneySchema,
    currency: currencySchema,
  })
  .strict();

export const propertyDetailSchema = z
  .object({
    id: z.uuid(),
    type: propertyTypeSchema,
    name: z.string().min(1).max(120),
    city: citySchema,
    address: z.string().min(1).max(240),
    description: z.string().min(1).max(2000),
    policies: z.string().min(1).max(2000),
    cover_url: catalogResourceSchema,
    media: z.array(mediaSchema).max(20),
    facilities: z.array(facilitySchema).max(50),
    room_types: z.array(roomTypeSummarySchema).min(1),
  })
  .strict();

export const nightlyPriceSchema = z
  .object({
    business_date: catalogDateSchema,
    sale_price_cents: moneySchema,
    rack_price_cents: moneySchema,
    currency: currencySchema,
  })
  .strict();

export const roomTypeDetailSchema = roomTypeSummarySchema
  .omit({ policy_summary: true, from_nightly_price_cents: true })
  .extend({
    property: z
      .object({
        id: z.uuid(),
        type: propertyTypeSchema,
        name: z.string().min(1).max(120),
        city: citySchema,
      })
      .strict(),
    description: z.string().min(1).max(2000),
    booking_policy: z.string().min(1).max(2000),
    nightly_prices: z.array(nightlyPriceSchema).min(1).max(30),
  })
  .strict();

export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;
export type PropertyListQuery = z.infer<typeof propertyListQuerySchema>;
export type PropertyListResponse = z.infer<typeof propertyListResponseSchema>;
export type PropertyDetail = z.infer<typeof propertyDetailSchema>;
export type RoomTypeDetail = z.infer<typeof roomTypeDetailSchema>;
export type PropertyType = z.infer<typeof propertyTypeSchema>;
```

`package.json` 的 `exports` 增加：

```json
"./catalog": {
  "types": "./src/catalog.ts",
  "default": "./dist/src/catalog.js"
}
```

- [ ] **Step 3：验证并提交**

```powershell
pnpm --filter @stay-fable/api-contracts test -- catalog.test.ts
pnpm --filter @stay-fable/api-contracts typecheck
git add packages/api-contracts/src/catalog.ts packages/api-contracts/test/catalog.test.ts packages/api-contracts/package.json
git commit -m "feat(contracts): define catalog browsing API"
```

预期：契约测试和类型检查 PASS。

## Task 2：建立供给、价格、库存模型与确定性种子

**Files:**

- Modify: `apps/api-server/prisma/schema.prisma`
- Create: `apps/api-server/prisma/migrations/202607290004_catalog_supply/migration.sql`
- Create: `apps/api-server/prisma/catalog-seed-data.ts`
- Modify: `apps/api-server/prisma/seed.ts`
- Create: `apps/api-server/test/database/catalog-supply.integration.test.ts`

- [ ] **Step 1：写真实 PostgreSQL 失败测试**

测试仅在 `RUN_DATABASE_INTEGRATION=true` 时运行，复用
`requireSafeDatabaseIntegrationUrl`。先断言表和检查约束：

```ts
expect(await pool.query('SELECT COUNT(*) FROM property')).toMatchObject({
  rows: [{ count: "6" }],
});
expect(await pool.query('SELECT COUNT(*) FROM room_type')).toMatchObject({
  rows: [{ count: "12" }],
});
expect(await pool.query('SELECT COUNT(*) FROM daily_price')).toMatchObject({
  rows: [{ count: "720" }],
});
expect(await pool.query('SELECT COUNT(*) FROM daily_inventory')).toMatchObject({
  rows: [{ count: "720" }],
});

await expect(
  pool.query(`
    INSERT INTO daily_inventory
      (room_type_id, business_date, total_inventory, held_inventory, sold_inventory, updated_at)
    VALUES
      ('30000000-0000-4000-8000-000000000001', '2026-07-30', 1, 1, 1, CURRENT_TIMESTAMP)
  `),
).rejects.toMatchObject({
  code: "23514",
  constraint: "daily_inventory_available_check",
});
```

覆盖：

- 两个城市各 3 家旅店，类型集合完整；
- 每店恰好 2 个房型；
- 每房型从 `2026-07-30` 连续 60 天价格和库存；
- 第二次 `runSeed` 后六张表行数不变；
- 修改一个受管名称后再次 seed 会恢复基准值；
- 固定 UUID 与业务键冲突时抛出
  `CATALOG_SEED_IDENTITY_CONFLICT_ERROR`；
- 价格负数、划线价低于销售价、面积非正、人数越界、库存和超过总量均触发指定约束。

运行 WSL 测试数据库命令，预期因 `property` 表不存在而 FAIL：

```bash
RUN_DATABASE_INTEGRATION=true pnpm --filter @stay-fable/api-server test -- catalog-supply.integration.test.ts
```

- [ ] **Step 2：扩展 Prisma schema 和迁移**

加入枚举：

```prisma
enum PropertyType {
  HOTEL
  HOMESTAY
  FARM_STAY
}

enum PropertyStatus {
  OPEN
  CLOSED
}

enum RoomTypeStatus {
  ON_SALE
  OFF_SALE
}

enum PropertyMediaType {
  IMAGE
}
```

在既有 `City` 增加 `properties Property[]`，并加入：

```prisma
model Property {
  id             String           @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  cityId         String           @map("city_id") @db.Uuid
  type           PropertyType
  nameZh         String           @map("name_zh") @db.VarChar(120)
  addressZh      String           @map("address_zh") @db.VarChar(240)
  location       Unsupported("geography(Point,4326)")
  shortDescriptionZh String       @map("short_description_zh") @db.VarChar(240)
  descriptionZh  String           @map("description_zh") @db.VarChar(2000)
  policiesZh     String           @map("policies_zh") @db.VarChar(2000)
  coverUrl       String           @map("cover_url") @db.VarChar(500)
  status         PropertyStatus   @default(OPEN)
  displayOrder   Int              @default(0) @map("display_order")
  createdAt      DateTime         @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt      DateTime         @updatedAt @map("updated_at") @db.Timestamptz(3)
  city           City             @relation(fields: [cityId], references: [id], onDelete: Restrict, onUpdate: Cascade)
  media          PropertyMedia[]
  facilities     PropertyFacility[]
  roomTypes      RoomType[]

  @@unique([cityId, nameZh], map: "property_city_name_key")
  @@index([cityId, status, type, displayOrder, id], map: "property_city_status_type_order_idx")
  @@index([location], type: Gist, map: "property_location_gix")
  @@map("property")
}

model PropertyMedia {
  id           String            @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  propertyId   String            @map("property_id") @db.Uuid
  type         PropertyMediaType @default(IMAGE)
  url          String            @db.VarChar(500)
  altZh        String            @map("alt_zh") @db.VarChar(120)
  displayOrder Int               @default(0) @map("display_order")
  property     Property          @relation(fields: [propertyId], references: [id], onDelete: Cascade, onUpdate: Cascade)

  @@unique([propertyId, displayOrder], map: "property_media_property_order_key")
  @@map("property_media")
}

model Facility {
  id           String             @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  code         String             @unique(map: "facility_code_key") @db.VarChar(64)
  nameZh       String             @map("name_zh") @db.VarChar(80)
  displayOrder Int                @default(0) @map("display_order")
  properties   PropertyFacility[]

  @@map("facility")
}

model PropertyFacility {
  propertyId String   @map("property_id") @db.Uuid
  facilityId String   @map("facility_id") @db.Uuid
  property   Property @relation(fields: [propertyId], references: [id], onDelete: Cascade, onUpdate: Cascade)
  facility   Facility @relation(fields: [facilityId], references: [id], onDelete: Cascade, onUpdate: Cascade)

  @@id([propertyId, facilityId])
  @@map("property_facility")
}

model RoomType {
  id              String         @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  propertyId      String         @map("property_id") @db.Uuid
  nameZh          String         @map("name_zh") @db.VarChar(120)
  bedTypeZh       String         @map("bed_type_zh") @db.VarChar(120)
  areaSqm         Decimal        @map("area_sqm") @db.Decimal(5, 2)
  maxGuests       Int            @map("max_guests")
  coverUrl        String         @map("cover_url") @db.VarChar(500)
  descriptionZh   String         @map("description_zh") @db.VarChar(2000)
  bookingPolicyZh String         @map("booking_policy_zh") @db.VarChar(2000)
  status          RoomTypeStatus @default(ON_SALE)
  displayOrder    Int            @default(0) @map("display_order")
  createdAt       DateTime       @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt       DateTime       @updatedAt @map("updated_at") @db.Timestamptz(3)
  property        Property       @relation(fields: [propertyId], references: [id], onDelete: Cascade, onUpdate: Cascade)
  dailyPrices     DailyPrice[]
  dailyInventory  DailyInventory[]

  @@unique([propertyId, nameZh], map: "room_type_property_name_key")
  @@index([propertyId, status, maxGuests, displayOrder, id], map: "room_type_property_status_capacity_order_idx")
  @@map("room_type")
}

model DailyPrice {
  roomTypeId    String   @map("room_type_id") @db.Uuid
  businessDate DateTime @map("business_date") @db.Date
  salePriceCents Int     @map("sale_price_cents")
  rackPriceCents Int     @map("rack_price_cents")
  createdAt     DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt     DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)
  roomType      RoomType @relation(fields: [roomTypeId], references: [id], onDelete: Cascade, onUpdate: Cascade)

  @@id([roomTypeId, businessDate])
  @@index([businessDate, roomTypeId], map: "daily_price_date_room_idx")
  @@map("daily_price")
}

model DailyInventory {
  roomTypeId      String   @map("room_type_id") @db.Uuid
  businessDate   DateTime @map("business_date") @db.Date
  totalInventory Int      @map("total_inventory")
  heldInventory  Int      @default(0) @map("held_inventory")
  soldInventory  Int      @default(0) @map("sold_inventory")
  version        Int      @default(0)
  createdAt      DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt      DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)
  roomType       RoomType @relation(fields: [roomTypeId], references: [id], onDelete: Cascade, onUpdate: Cascade)

  @@id([roomTypeId, businessDate])
  @@index([businessDate, roomTypeId], map: "daily_inventory_date_room_idx")
  @@map("daily_inventory")
}
```

关系规则固定为：

```text
City -> Property: onDelete Restrict
Property -> PropertyMedia/PropertyFacility/RoomType: onDelete Cascade
Facility -> PropertyFacility: onDelete Cascade
RoomType -> DailyPrice/DailyInventory: onDelete Cascade
```

迁移 SQL 显式创建：

```sql
ALTER TABLE "property"
  ADD CONSTRAINT "property_display_order_check" CHECK ("display_order" >= 0);
ALTER TABLE "property_media"
  ADD CONSTRAINT "property_media_display_order_check" CHECK ("display_order" >= 0);
ALTER TABLE "facility"
  ADD CONSTRAINT "facility_display_order_check" CHECK ("display_order" >= 0);
ALTER TABLE "room_type"
  ADD CONSTRAINT "room_type_area_check" CHECK ("area_sqm" > 0),
  ADD CONSTRAINT "room_type_guests_check" CHECK ("max_guests" BETWEEN 1 AND 10),
  ADD CONSTRAINT "room_type_display_order_check" CHECK ("display_order" >= 0);
ALTER TABLE "daily_price"
  ADD CONSTRAINT "daily_price_sale_check" CHECK ("sale_price_cents" >= 0),
  ADD CONSTRAINT "daily_price_rack_check"
    CHECK ("rack_price_cents" >= "sale_price_cents");
ALTER TABLE "daily_inventory"
  ADD CONSTRAINT "daily_inventory_nonnegative_check"
    CHECK (
      "total_inventory" >= 0 AND
      "held_inventory" >= 0 AND
      "sold_inventory" >= 0 AND
      "version" >= 0
    ),
  ADD CONSTRAINT "daily_inventory_available_check"
    CHECK ("held_inventory" + "sold_inventory" <= "total_inventory");
```

索引至少包含：

```sql
CREATE INDEX "property_city_status_type_order_idx"
  ON "property" ("city_id", "status", "type", "display_order", "id");
CREATE INDEX "room_type_property_status_capacity_order_idx"
  ON "room_type" ("property_id", "status", "max_guests", "display_order", "id");
CREATE INDEX "daily_price_date_room_idx"
  ON "daily_price" ("business_date", "room_type_id");
CREATE INDEX "daily_inventory_date_room_idx"
  ON "daily_inventory" ("business_date", "room_type_id");
```

- [ ] **Step 3：实现固定种子数据**

`catalog-seed-data.ts` 导出固定基准日、固定 UUID 和六家旅店：

| 城市 | Property UUID 末位 | 类型 | 名称 | display_order |
| --- | --- | --- | --- | --- |
| 杭州 | `20000000-0000-4000-8000-000000000001` | HOTEL | 西湖云栖酒店 | 10 |
| 杭州 | `20000000-0000-4000-8000-000000000002` | HOMESTAY | 龙井山居 | 20 |
| 杭州 | `20000000-0000-4000-8000-000000000003` | FARM_STAY | 青山田园农庄 | 30 |
| 贵阳 | `20000000-0000-4000-8000-000000000004` | HOTEL | 筑城观山酒店 | 10 |
| 贵阳 | `20000000-0000-4000-8000-000000000005` | HOMESTAY | 黔灵巷居 | 20 |
| 贵阳 | `20000000-0000-4000-8000-000000000006` | FARM_STAY | 花溪稻田农庄 | 30 |

六家旅店的泛化地址、坐标和固定封面依次为：

| Property UUID 末位 | 泛化地址 | 经度 | 纬度 | 固定封面 |
| --- | --- | --- | --- | --- |
| `0001` | 杭州市西湖区湖滨片区 | 120.1551 | 30.2741 | `https://images.unsplash.com/photo-1566073771259-6a8506099945` |
| `0002` | 杭州市西湖区龙井片区 | 120.1165 | 30.2248 | `https://images.unsplash.com/photo-1445019980597-93fa8acb246c` |
| `0003` | 杭州市余杭区青山片区 | 119.9878 | 30.2734 | `https://images.unsplash.com/photo-1500530855697-b586d89ba3ee` |
| `0004` | 贵阳市观山湖区中心片区 | 106.6227 | 26.6477 | `https://images.unsplash.com/photo-1522708323590-d24dbb6b0267` |
| `0005` | 贵阳市云岩区黔灵片区 | 106.7043 | 26.6049 | `https://images.unsplash.com/photo-1542314831-068cd1dbfeeb` |
| `0006` | 贵阳市花溪区田园片区 | 106.6732 | 26.4371 | `https://images.unsplash.com/photo-1564501049412-61c2a3083791` |

每家旅店创建一条 `IMAGE` media，UUID 前缀固定为
`50000000-0000-4000-8000-`，末位与旅店一致，URL 使用同一固定封面，alt 为
`<旅店名称>外观`，display order 为 10。所有旅店关联 `WIFI` 和 `PARKING`；酒店额外
关联 `BREAKFAST`，民宿和农家乐额外关联 `FAMILY`。

属性 UUID 前缀固定为 `20000000-0000-4000-8000-`，房型 UUID 前缀固定为
`30000000-0000-4000-8000-`，每家两个房型依次使用末位 `0001` 至 `0012`。第一房型
为“舒适大床房”、`bed_type_zh=1张1.8米大床`、`area_sqm=28.00`、
`max_guests=2`、总库存 3；第二房型为“家庭双床房”、
`bed_type_zh=2张1.35米单床`、`area_sqm=38.00`、`max_guests=4`、总库存 2。
杭州酒店第一房型总库存固定为 1，供 Slice 3 并发测试。

六家旅店的 `short_description_zh` 依次为“湖滨城市旅店，适合短途度假”、
“龙井山间民宿，提供安静居住体验”、“青山田园农庄，适合亲子周末”、
“观山湖城市旅店，交通便利”、“黔灵街巷民宿，适合慢旅行”、
“花溪田园农庄，临近自然景观”。`description_zh` 使用
`<旅店名称>提供整洁客房与本地旅行信息，本数据仅用于 Stay Fable MVP 演示。`；
`policies_zh` 固定为“14:00后入住，12:00前退房；入住人需出示有效证件。”。
房型 `description_zh` 分别为“配备独立卫浴和基础洗护用品。”与
“适合家庭入住，配备独立卫浴和基础洗护用品。”；`booking_policy_zh` 固定为
“到店前一天18:00前可免费取消，之后取消规则以报价确认为准。”。

设施固定为：

```ts
export const catalogFacilities = [
  { id: "40000000-0000-4000-8000-000000000001", code: "WIFI", nameZh: "无线网络", displayOrder: 10 },
  { id: "40000000-0000-4000-8000-000000000002", code: "BREAKFAST", nameZh: "早餐", displayOrder: 20 },
  { id: "40000000-0000-4000-8000-000000000003", code: "PARKING", nameZh: "停车场", displayOrder: 30 },
  { id: "40000000-0000-4000-8000-000000000004", code: "FAMILY", nameZh: "亲子友好", displayOrder: 40 },
] as const;
```

每房型第 `dayOffset` 天的销售价为
`basePriceCents + (dayOffset % 7) * 1000`，划线价为销售价加 `6000`；六家旅店两个房型的
`basePriceCents` 分别为：

```ts
[
  [42800, 56800],
  [32800, 44800],
  [26800, 38800],
  [39800, 52800],
  [29800, 41800],
  [23800, 35800],
] as const;
```

图片使用固定 HTTPS Unsplash 资源路径，文本均为虚构公开测试内容，不含手机号、联系人或
私人门牌。

- [ ] **Step 4：扩展事务 seed**

保留现有 PostgreSQL advisory transaction lock，在同一事务中依次：

1. upsert 城市；
2. upsert 设施；
3. 校验固定 UUID 与 `code` 的一一映射；
4. upsert 旅店并校验固定 UUID 与 `(city_id, name_zh)`；
5. upsert媒体、旅店设施和房型；
6. 用 `generate_series(0, 59)` 生成每日价格和库存并更新全部受管字段。

导出：

```ts
export const CATALOG_SEED_IDENTITY_CONFLICT_ERROR =
  "Catalog seed identity conflict: existing id/business-key mapping does not match fixed reference data";

export async function runSeed(prisma: PrismaClient): Promise<void>;
```

不得删除不属于固定 UUID 集合的运营数据；遇到映射冲突必须回滚整个 seed。

- [ ] **Step 5：生成客户端、迁移、验证并提交**

```powershell
pnpm --filter @stay-fable/api-server prisma:generate
pnpm --filter @stay-fable/api-server typecheck
```

在 WSL 测试 Compose 中执行：

```bash
pnpm --filter @stay-fable/api-server prisma:migrate
pnpm --filter @stay-fable/api-server prisma:seed
RUN_DATABASE_INTEGRATION=true pnpm --filter @stay-fable/api-server test -- catalog-supply.integration.test.ts
```

预期：迁移、seed、约束、重复 seed 和冲突测试全部 PASS。

```powershell
git add apps/api-server/prisma apps/api-server/test/database/catalog-supply.integration.test.ts
git commit -m "feat(database): add deterministic catalog supply"
```

## Task 3：实现日期区间和版本化游标领域函数

**Files:**

- Create: `apps/api-server/src/catalog/catalog-date-range.ts`
- Create: `apps/api-server/src/catalog/catalog-cursor.ts`
- Create: `apps/api-server/test/catalog-date-range.test.ts`
- Create: `apps/api-server/test/catalog-cursor.test.ts`

- [ ] **Step 1：写日期失败测试**

使用固定 `Clock`：

```ts
const clock = { now: () => new Date("2026-07-29T08:00:00.000Z") };
const captureError = (action: () => unknown): unknown => {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected action to throw");
};

expect(parseCatalogDateRange("2026-07-30", "2026-08-02", clock)).toEqual({
  checkin: "2026-07-30",
  checkout: "2026-08-02",
  nights: 3,
});
expect(captureError(() => parseCatalogDateRange("2026-02-30", "2026-03-02", clock))).toMatchObject({
  code: "CATALOG_DATE_RANGE_INVALID",
});
expect(captureError(() => parseCatalogDateRange("2026-07-28", "2026-07-30", clock))).toMatchObject({
  code: "CATALOG_CHECKIN_IN_PAST",
});
expect(captureError(() => parseCatalogDateRange("2026-07-30", "2026-08-30", clock))).toMatchObject({
  code: "CATALOG_STAY_TOO_LONG",
});
```

运行：

```powershell
pnpm --filter @stay-fable/api-server test -- catalog-date-range.test.ts
```

预期：FAIL，模块不存在。

- [ ] **Step 2：实现严格日期范围**

导出：

```ts
export interface CatalogDateRange {
  checkin: string;
  checkout: string;
  nights: number;
}

export function parseCatalogDateRange(
  checkin: string,
  checkout: string,
  clock: Clock,
): CatalogDateRange;
```

实现只接受 `YYYY-MM-DD`，用 `Date.UTC(year, month - 1, day)` 后反向核对年月日，按 UTC
日序号计算晚数。业务“今天”固定使用 `Asia/Shanghai`：把 `clock.now()` 转成该时区的
年月日后再计算，不读取服务器本地时区。错误使用 `BusinessException`，HTTP 400，code
分别为上述三个稳定值。

- [ ] **Step 3：写游标失败测试**

```ts
const encoded = encodeCatalogCursor({
  version: 1,
  display_order: 20,
  property_id: "20000000-0000-4000-8000-000000000002",
});

expect(decodeCatalogCursor(encoded)).toEqual({
  displayOrder: 20,
  propertyId: "20000000-0000-4000-8000-000000000002",
});
expect(captureError(() => decodeCatalogCursor("%%%"))).toMatchObject({
  code: "CATALOG_CURSOR_INVALID",
});
expect(captureError(() => decodeCatalogCursor("a".repeat(257)))).toMatchObject({
  code: "CATALOG_CURSOR_INVALID",
});
```

还要覆盖错误版本、额外键、负排序、非 UUID、非规范 base64url 和解码后超过 512 字节。

- [ ] **Step 4：实现游标并验证**

只编码：

```ts
type CatalogCursorPayload = {
  version: 1;
  display_order: number;
  property_id: string;
};
```

`encodeCatalogCursor` 使用 `Buffer.from(JSON.stringify(payload)).toString("base64url")`。
`decodeCatalogCursor` 先检查 1–256 字符和 `/^[A-Za-z0-9_-]+$/`，解码后限制 512 字节，
解析对象必须恰好含三个键，`display_order` 为非负安全整数，UUID 符合既有正则。
任何失败统一抛出 HTTP 400、`CATALOG_CURSOR_INVALID`。

```powershell
pnpm --filter @stay-fable/api-server test -- catalog-date-range.test.ts catalog-cursor.test.ts
git add apps/api-server/src/catalog/catalog-date-range.ts apps/api-server/src/catalog/catalog-cursor.ts apps/api-server/test/catalog-date-range.test.ts apps/api-server/test/catalog-cursor.test.ts
git commit -m "feat(catalog): validate date ranges and cursors"
```

## Task 4：实现全住期可售 Repository

**Files:**

- Create: `apps/api-server/src/catalog/catalog.repository.ts`
- Create: `apps/api-server/test/catalog.integration.e2e.test.ts`

- [ ] **Step 1：写真实数据库可售失败测试**

在测试事务或独立测试 schema 中先运行 seed，再覆盖：

```ts
const list = await repository.listProperties({
  cityId: "10000000-0000-4000-8000-000000000001",
  checkin: "2026-07-30",
  checkout: "2026-08-01",
  nights: 2,
  guests: 1,
  pageSize: 10,
});

expect(list.rows.map(({ name }) => name)).toEqual([
  "西湖云栖酒店",
  "龙井山居",
  "青山田园农庄",
]);
expect(list.rows.every(({ availableRoomTypeCount }) => availableRoomTypeCount === 2)).toBe(true);
```

逐个临时更新并回滚，证明：

- 任一晚缺少价格时对应房型不可售；
- 任一晚缺少库存或可用库存为零时对应房型不可售；
- `held + sold` 会减少可用库存；
- `CLOSED` 旅店、`OFF_SALE` 房型被过滤；
- `guests=3` 只保留家庭房，`guests=5` 无旅店；
- `propertyType=HOMESTAY` 只返回民宿；
- `pageSize=2` 的两页无重复、无遗漏且顺序稳定；
- 旅店详情只返回符合全住期条件的房型；
- 房型详情逐晚价格按日期升序，不读取或返回内部库存列。

运行：

```bash
RUN_DATABASE_INTEGRATION=true pnpm --filter @stay-fable/api-server test -- catalog.integration.e2e.test.ts
```

预期：FAIL，Repository 不存在。

- [ ] **Step 2：定义 Repository 输入和输出**

导出明确接口：

```ts
export interface CatalogAvailabilityInput {
  checkin: string;
  checkout: string;
  nights: number;
  guests: number;
}

export interface CatalogListInput extends CatalogAvailabilityInput {
  cityId: string;
  propertyType?: PropertyType;
  pageSize: number;
  after?: { displayOrder: number; propertyId: string };
}

export interface CatalogListRow {
  id: string;
  type: PropertyType;
  name: string;
  cityId: string;
  cityCode: string;
  cityName: string;
  coverUrl: string;
  shortDescription: string;
  displayOrder: number;
  fromNightlyPriceCents: number;
  availableRoomTypeCount: number;
}

export interface CatalogListResult {
  rows: CatalogListRow[];
  nextAfter: { displayOrder: number; propertyId: string } | null;
}

export interface CatalogFacilityRow {
  code: string;
  name: string;
}

export interface CatalogMediaRow {
  type: "IMAGE";
  url: string;
  alt: string;
}

export interface CatalogRoomSummaryRow {
  id: string;
  name: string;
  bedType: string;
  areaSqm: number;
  maxGuests: number;
  coverUrl: string;
  bookingPolicy: string;
  fromNightlyPriceCents: number;
}

export interface CatalogPropertyDetailRow {
  id: string;
  type: PropertyType;
  name: string;
  cityId: string;
  cityCode: string;
  cityName: string;
  address: string;
  description: string;
  policies: string;
  coverUrl: string;
  media: CatalogMediaRow[];
  facilities: CatalogFacilityRow[];
  roomTypes: CatalogRoomSummaryRow[];
}

export interface CatalogNightlyPriceRow {
  businessDate: string;
  salePriceCents: number;
  rackPriceCents: number;
}

export interface CatalogRoomDetailRow {
  id: string;
  name: string;
  bedType: string;
  areaSqm: number;
  maxGuests: number;
  coverUrl: string;
  description: string;
  bookingPolicy: string;
  propertyId: string;
  propertyType: PropertyType;
  propertyName: string;
  cityId: string;
  cityCode: string;
  cityName: string;
  nightlyPrices: CatalogNightlyPriceRow[];
}

export type CatalogRoomLookup =
  | { status: "NOT_AVAILABLE" }
  | { status: "CAPACITY_EXCEEDED" }
  | { status: "AVAILABLE"; room: CatalogRoomDetailRow };
```

详情行接口使用同一 camelCase 规则；每日价格只含业务日期、销售价和划线价。Repository
公开方法固定为：

```ts
listProperties(input: CatalogListInput): Promise<CatalogListResult>;
listFacilityHighlights(propertyIds: string[]): Promise<Map<string, string[]>>;
findProperty(propertyId: string, input: CatalogAvailabilityInput): Promise<CatalogPropertyDetailRow | null>;
findRoomType(roomTypeId: string, input: CatalogAvailabilityInput): Promise<CatalogRoomLookup>;
```

`findRoomType` 先读取房型状态和容量：未知、旅店关闭或房型停售返回 `NOT_AVAILABLE`；
容量不足返回 `CAPACITY_EXCEEDED`；容量满足后才执行完整日期、价格和库存查询，缺任一晚也
返回 `NOT_AVAILABLE`。

- [ ] **Step 3：实现列表 SQL**

`CatalogRepository.listProperties` 使用一个固定 `Prisma.sql` 查询。核心 CTE 必须等价于：

```sql
WITH requested_dates AS (
  SELECT generate_series(
    ${checkin}::date,
    ${checkout}::date - 1,
    interval '1 day'
  )::date AS business_date
),
eligible_rooms AS (
  SELECT
    rt.id,
    rt.property_id,
    MIN(dp.sale_price_cents)::int AS from_nightly_price_cents
  FROM room_type rt
  CROSS JOIN requested_dates rd
  JOIN daily_price dp
    ON dp.room_type_id = rt.id AND dp.business_date = rd.business_date
  JOIN daily_inventory di
    ON di.room_type_id = rt.id AND di.business_date = rd.business_date
  WHERE rt.status = 'ON_SALE'
    AND rt.max_guests >= ${guests}
    AND di.total_inventory - di.held_inventory - di.sold_inventory > 0
  GROUP BY rt.id, rt.property_id
  HAVING COUNT(*) = ${nights}
),
available_properties AS (
  SELECT
    property_id,
    MIN(from_nightly_price_cents)::int AS from_nightly_price_cents,
    COUNT(*)::int AS available_room_type_count
  FROM eligible_rooms
  GROUP BY property_id
)
SELECT
  p.id::text AS id,
  p.type::text AS type,
  p.name_zh AS name,
  c.id::text AS city_id,
  c.code AS city_code,
  c.name_zh AS city_name,
  p.cover_url AS cover_url,
  p.short_description_zh AS short_description,
  p.display_order AS display_order,
  ap.from_nightly_price_cents,
  ap.available_room_type_count
FROM property p
JOIN city c ON c.id = p.city_id AND c.enabled = true
JOIN available_properties ap ON ap.property_id = p.id
WHERE p.city_id = ${cityId}::uuid
  AND p.status = 'OPEN'
  AND (${propertyTypeOrNull}::"PropertyType" IS NULL OR p.type = ${propertyTypeOrNull}::"PropertyType")
  AND (
    ${cursorOrderOrNull}::int IS NULL OR
    (p.display_order, p.id) > (${cursorOrderOrNull}::int, ${cursorIdOrNull}::uuid)
  )
ORDER BY p.display_order ASC, p.id ASC
LIMIT ${pageSizePlusOne}
```

方法读取 `pageSize + 1` 行，多出一行只用于计算 next cursor，返回的 rows 最多为
`pageSize`。

- [ ] **Step 4：实现详情查询**

`findProperty` 先用同一 `eligible_rooms` 语义取得旅店和可售房型 ID，再分别用 Prisma
查询媒体、设施和房型展示字段。媒体、设施、房型分别按 `displayOrder, id` 排序。

`findRoomType` 用相同 requested_dates JOIN，要求恰好 `nights` 行；返回所属旅店摘要、
房型内容和逐晚价格。两个方法只 select 展示字段，禁止 select
`totalInventory`、`heldInventory`、`soldInventory`、`version`。

- [ ] **Step 5：验证并提交**

```bash
RUN_DATABASE_INTEGRATION=true pnpm --filter @stay-fable/api-server test -- catalog.integration.e2e.test.ts
pnpm --filter @stay-fable/api-server typecheck
```

预期：全部筛选、缺口、状态、人数和分页测试 PASS。

```powershell
git add apps/api-server/src/catalog/catalog.repository.ts apps/api-server/test/catalog.integration.e2e.test.ts
git commit -m "feat(catalog): query full-stay availability"
```

## Task 5：接通 Catalog Service、DTO、Controller 和 OpenAPI

**Files:**

- Create: `apps/api-server/src/catalog/dto/catalog-query.dto.ts`
- Create: `apps/api-server/src/catalog/dto/catalog-response.dto.ts`
- Create: `apps/api-server/src/catalog/catalog.service.ts`
- Create: `apps/api-server/src/catalog/catalog.controller.ts`
- Create: `apps/api-server/src/catalog/catalog.module.ts`
- Modify: `apps/api-server/src/app.module.ts`
- Create: `apps/api-server/test/catalog.service.test.ts`
- Create: `apps/api-server/test/catalog.controller.e2e.test.ts`
- Create: `apps/api-server/test/catalog.openapi.test.ts`
- Modify: `apps/api-server/test/app.module.test.ts`

- [ ] **Step 1：写 Service 失败测试**

伪 Repository 返回两条以上数据，断言：

```ts
await expect(
  service.listProperties({
    city_id: HANGZHOU_ID,
    checkin: "2026-07-30",
    checkout: "2026-08-01",
    guests: 2,
    page_size: 1,
  }),
).resolves.toEqual({
  items: [expect.objectContaining({ name: "西湖云栖酒店", currency: "CNY" })],
  next_cursor: expect.any(String),
});
```

覆盖：

- 调用日期领域函数并解码 cursor；
- 设施亮点最多四个，按设施排序；
- 旅店不存在或不可售抛出 404 `PROPERTY_NOT_AVAILABLE`；
- 房型人数超限抛出 422 `ROOM_CAPACITY_EXCEEDED`；
- 未知、停售或任一晚不可售抛出 404 `ROOM_NOT_AVAILABLE`；
- 三种响应均通过共享 Zod schema `.parse()` 后返回。

运行：

```powershell
pnpm --filter @stay-fable/api-server test -- catalog.service.test.ts
```

预期：FAIL，Service 不存在。

- [ ] **Step 2：实现查询 DTO**

`AvailabilityQueryDto`：

```ts
export class AvailabilityQueryDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  checkin!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  checkout!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  guests!: number;
}
```

`PropertyListQueryDto` 复制这三个字段并增加：

```ts
@IsUUID() city_id!: string;
@IsOptional() @IsEnum(PropertyType) property_type?: PropertyType;
@IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20) page_size = 10;
@IsOptional() @IsString() @Length(1, 256) cursor?: string;
```

DTO 不接受未知字段，依赖全局 `whitelist + forbidNonWhitelisted`。

- [ ] **Step 3：实现 Service**

注入 `CatalogRepository` 和 `CLOCK`。公开方法固定为：

```ts
listProperties(query: PropertyListQueryDto): Promise<PropertyListResponse>;
getProperty(propertyId: string, query: AvailabilityQueryDto): Promise<PropertyDetail>;
getRoomType(roomTypeId: string, query: AvailabilityQueryDto): Promise<RoomTypeDetail>;
```

Service 负责日期范围、cursor、snake_case DTO 组装、`CNY`、安全业务错误和响应 schema
验证；Repository 只负责数据库。

- [ ] **Step 4：写 Controller 与 OpenAPI 失败测试**

端到端测试使用覆写鉴权 Guard 和伪 Service，验证：

```text
GET /api/v1/properties
GET /api/v1/properties/:propertyId
GET /api/v1/room-types/:roomTypeId
```

覆盖有效 envelope、Bearer guard、UUID、日期、人数、枚举、page size、未知 query、畸形
cursor 和稳定业务错误。一级列表响应断言没有 `room_types` 或 `rooms` 键。

OpenAPI 测试断言三个 path、所有 query 参数、Bearer security、200 响应 envelope 和
400/401/404/422 响应均存在。

- [ ] **Step 5：实现 Controller、响应 DTO 和 Module**

Controller 使用 `@UseGuards(SessionAuthGuard)`，参数 UUID 使用
`ParseUUIDPipe({ version: "4" })`。路由：

```ts
@Get("properties")
list(@Query() query: PropertyListQueryDto) {
  return this.catalog.listProperties(query);
}

@Get("properties/:propertyId")
property(
  @Param("propertyId", new ParseUUIDPipe({ version: "4" })) propertyId: string,
  @Query() query: AvailabilityQueryDto,
) {
  return this.catalog.getProperty(propertyId, query);
}

@Get("room-types/:roomTypeId")
roomType(
  @Param("roomTypeId", new ParseUUIDPipe({ version: "4" })) roomTypeId: string,
  @Query() query: AvailabilityQueryDto,
) {
  return this.catalog.getRoomType(roomTypeId, query);
}
```

`catalog-response.dto.ts` 为列表、旅店详情、房型详情及 envelope 定义完整 Swagger 类；
字段名称与 Task 1 完全一致。`CatalogModule` 导入 `DatabaseModule`、`IdentityModule`，
提供 Repository/Service/Controller，并在 `AppModule` 导入。

- [ ] **Step 6：验证并提交**

```powershell
pnpm --filter @stay-fable/api-server test -- catalog.service.test.ts catalog.controller.e2e.test.ts catalog.openapi.test.ts app.module.test.ts
pnpm --filter @stay-fable/api-server typecheck
pnpm --filter @stay-fable/api-server build
git add apps/api-server/src/catalog apps/api-server/src/app.module.ts apps/api-server/test/catalog.service.test.ts apps/api-server/test/catalog.controller.e2e.test.ts apps/api-server/test/catalog.openapi.test.ts apps/api-server/test/app.module.test.ts
git commit -m "feat(api): expose catalog browsing endpoints"
```

预期：测试、类型检查和构建 PASS。

## Task 6：把 Catalog 冒烟加入 WSL2 验证

**Files:**

- Create: `scripts/verify-slice-2-runtime.mjs`
- Create: `scripts/verify-slice-2-runtime.test.mjs`
- Modify: `scripts/wsl-runtime-validation.sh`
- Modify: `scripts/wsl-runtime-validation.test.mjs`
- Modify: `docs/operations/wsl-runtime-validation.md`

- [ ] **Step 1：写运行时验证器失败测试**

用伪 fetch 队列验证脚本会执行：

```text
模拟登录
杭州 3 家旅店
HOMESTAY 只返回民宿
guests=3 只保留容量足够房型
page_size=2 后使用 next_cursor，合并两页无重复
guests=1 的旅店详情返回 2 个房型
一级列表没有房型集合
房型详情没有四个内部库存字段
```

并断言任何 HTTP 状态、错误 code、重复 ID 或内部库存泄露都会失败。

```powershell
node --test scripts/verify-slice-2-runtime.test.mjs
```

预期：FAIL，验证器不存在。

- [ ] **Step 2：实现验证器**

固定搜索窗口：

```js
const search = {
  city_id: "10000000-0000-4000-8000-000000000001",
  checkin: "2026-07-30",
  checkout: "2026-08-01",
  guests: 1,
};
```

复用 Slice 1 的 `requestJson` 和 Bearer 语义，但保持脚本独立可执行。查询参数全部通过
`URLSearchParams` 编码。每项成功打印一条不含 token 的 `catalog validation: pass`。

- [ ] **Step 3：接入现有原子验证流程**

在 `scripts/wsl-runtime-validation.sh` 的 Slice 1 冒烟之后、Worker 观察之前，以只读
Node 容器挂载并执行 `verify-slice-2-runtime.mjs`。不要改 Compose project、容器名、
固定端口、令牌所有权、清理规则或 Worker 10 分钟循环。

同步测试脚本和操作文档，把成功标志升级为：

```text
SLICE2_RUNTIME_READY http://127.0.0.1:3000
SLICE2_RUNTIME_STABLE_10_MINUTES
SLICE2_RUNTIME_CLEANUP_COMPLETE
```

- [ ] **Step 4：验证并提交**

```powershell
node --test scripts/verify-slice-2-runtime.test.mjs scripts/wsl-runtime-validation.test.mjs
git add scripts/verify-slice-2-runtime.mjs scripts/verify-slice-2-runtime.test.mjs scripts/wsl-runtime-validation.sh scripts/wsl-runtime-validation.test.mjs docs/operations/wsl-runtime-validation.md
git commit -m "test(wsl): add catalog runtime smoke"
```

## Task 7：实现微信 Catalog 响应防御和 Service

**Files:**

- Modify: `wx/services/contracts.js`
- Create: `wx/services/catalog.js`
- Create: `wx/tests/catalog-contracts.test.js`
- Create: `wx/tests/catalog-service.test.js`

- [ ] **Step 1：写失败的客户端契约测试**

有效样本与 Task 1 完全一致。逐项篡改并断言 `INVALID_API_RESPONSE`：

```text
未知 property type
负数、浮点数或超过安全整数的 cents
非 CNY
非 HTTPS 且非 /images/ 路径
available_room_type_count 为 0
next_cursor 为空串或超过 256
详情缺少 media/facilities/room_types
nightly_prices 超过 30 或日期无序
任何响应包含 total_inventory/held_inventory/sold_inventory/version
```

运行：

```powershell
pnpm test:wx -- catalog-contracts.test.js
```

预期：FAIL，断言函数不存在。

- [ ] **Step 2：实现严格断言**

在 `contracts.js` 导出：

```js
assertPropertyListResponse(value)
assertPropertyDetail(value)
assertRoomTypeDetail(value)
```

每个函数：

- 先用既有 `isObject`、`hasOnlyKeys` 和 UUID 正则；
- 返回重新构造的安全对象，不原样返回服务器对象；
- `facility_highlights` 最多四项；
- 金额要求 `Number.isSafeInteger(value) && value >= 0`；
- nightly dates 严格升序；
- 资源只允许 `https://` 或 `/images/`；
- 不允许未知键，因此库存字段会被拒绝。

- [ ] **Step 3：写 Service 失败测试**

断言：

```js
await service.listProperties({
  city_id: HANGZHOU_ID,
  checkin: "2026-07-30",
  checkout: "2026-08-01",
  guests: 2,
  property_type: "HOTEL",
  page_size: 10,
  cursor: "cursor_1",
});

expect(requestClient.get).toHaveBeenCalledWith(
  "/properties?city_id=10000000-0000-4000-8000-000000000001&checkin=2026-07-30&checkout=2026-08-01&guests=2&property_type=HOTEL&page_size=10&cursor=cursor_1",
);
```

还要证明无效 UUID、日期、人数、类型、page size、cursor 在发请求前失败；详情 URL 只编码
UUID，搜索上下文仍放 query string 而不是页面 URL。

- [ ] **Step 4：实现 Service 并提交**

导出 factory 和默认实例方法：

```js
createCatalogService(requestClient)
listProperties(query)
getProperty(propertyId, availability)
getRoomType(roomTypeId, availability)
```

内部使用一个固定顺序的 `URLSearchParams` 等价编码函数；微信运行环境不依赖浏览器
`URLSearchParams`，而是对键和值使用 `encodeURIComponent`。验证输入后调用
`requestClient.get`，再调用对应断言函数。

```powershell
pnpm test:wx -- catalog-contracts.test.js catalog-service.test.js
git add wx/services/contracts.js wx/services/catalog.js wx/tests/catalog-contracts.test.js wx/tests/catalog-service.test.js
git commit -m "feat(wx): add defensive catalog service"
```

## Task 8：实现价格和旅店卡片组件

**Files:**

- Create: `wx/components/price/price.js`
- Create: `wx/components/price/price.json`
- Create: `wx/components/price/price.wxml`
- Create: `wx/components/price/price.wxss`
- Create: `wx/components/property-card/property-card.js`
- Create: `wx/components/property-card/property-card.json`
- Create: `wx/components/property-card/property-card.wxml`
- Create: `wx/components/property-card/property-card.wxss`
- Create: `wx/tests/property-components.test.js`

- [ ] **Step 1：写失败组件测试**

读取四类组件文件并断言：

```js
expect(priceWxml).toContain("每晚");
expect(priceWxml).toContain("起");
expect(priceJs).toContain('require("../../utils/money")');
expect(cardWxml).toContain("bindtap=\"handleTap\"");
expect(cardWxml).not.toMatch(/room_types|roomType|房型列表/);
```

require 组件定义，验证 cents 变化会调用 `formatMoney` 得到 `¥428.00`，卡片事件只 emit
`propertytap` 和旅店 UUID，不传完整对象。

```powershell
pnpm test:wx -- property-components.test.js
```

预期：FAIL，组件文件不存在。

- [ ] **Step 2：实现价格组件**

`price.js` 的属性只含：

```js
properties: {
  cents: { type: Number, value: 0 },
  prefix: { type: String, value: "每晚" },
  suffix: { type: String, value: "起" },
},
```

observer 调用 `formatMoney` 写入 `formatted`。WXML 仅文本绑定，禁止 rich-text。

- [ ] **Step 3：实现旅店卡片**

属性只含 Task 1 的 `propertyListItem` 展示字段；点击时：

```js
handleTap() {
  this.triggerEvent("propertytap", { id: this.data.property.id });
}
```

WXML 展示封面、类型中文映射、名称、简介、最多四个设施标签、可售房型数量和 price
组件。不要渲染房型数组。

- [ ] **Step 4：静态验证并提交**

```powershell
pnpm test:wx -- property-components.test.js
pnpm wx:check
git add wx/components/price wx/components/property-card wx/tests/property-components.test.js
git commit -m "feat(wx): add catalog display components"
```

## Task 9：实现旅店列表、筛选和安全分页

**Files:**

- Create: `wx/pages/property-list/property-list.logic.js`
- Create: `wx/pages/property-list/property-list.js`
- Create: `wx/pages/property-list/property-list.json`
- Create: `wx/pages/property-list/property-list.wxml`
- Create: `wx/pages/property-list/property-list.wxss`
- Create: `wx/tests/property-list-page.test.js`

- [ ] **Step 1：写纯逻辑失败测试**

`toPropertyListView(search, type)` 必须输出城市、日期、晚数、人数和四个筛选项。缺少城市、
非法日期或人数时抛出 `SEARCH_CONTEXT_INVALID`。

`mergePropertyPage(existing, incoming)` 以 UUID 去重并保持已有顺序；同一 ID 内容更新但位置
不变。`safeCatalogError` 固定映射：

```js
{
  AUTH_REAUTHENTICATION_FAILED: "登录暂时失败，请返回首页重试",
  CATALOG_CURSOR_INVALID: "列表已更新，请重新加载",
  NETWORK_REQUEST_FAILED: "网络连接不稳定，请重试",
}
```

其他错误统一“服务暂时不可用，请重试”，不显示服务端 message。

- [ ] **Step 2：写页面状态机失败测试**

通过 `createPropertyListPage` 注入 search store、catalog service 和 wxApi，覆盖：

- onLoad 缺少完整搜索上下文时 `reLaunch("/pages/home/home")`；
- 首屏 loading → list/empty/error；
- 切换类型递增 generation、清空 items/cursor 并重新加载；
- 同一 cursor 只允许一个在途请求；
- 筛选变化后的旧响应不能覆盖新结果；
- onHide/onUnload 后迟到响应不 setData；
- 分页失败保留旧列表，设置 `footerStatus="error"`；
- 页尾重试只重试当前 cursor；
- `next_cursor=null` 后不再请求；
- 点击旅店只导航
  `/pages/property-detail/property-detail?id=<encoded uuid>`。

- [ ] **Step 3：实现逻辑和页面**

页面状态固定为：

```js
data: {
  status: "loading",
  items: [],
  nextCursor: null,
  activeType: "",
  filters: [
    { value: "", label: "全部" },
    { value: "HOTEL", label: "酒店" },
    { value: "HOMESTAY", label: "民宿" },
    { value: "FARM_STAY", label: "农家乐" },
  ],
  searchSummary: null,
  errorMessage: "",
  footerStatus: "idle",
}
```

内部字段：

```js
let generation = 0;
let active = true;
const inFlightCursors = new Set();
```

每次筛选变化递增 generation；请求完成前比较本地 generation 和 active。首屏失败用
error-state，空结果用 empty-state；分页失败只渲染页尾按钮。

- [ ] **Step 4：实现 WXML/WXSS/JSON**

JSON 注册 `navigation-bar`、`loading-state`、`error-state`、`empty-state`、
`property-card`。WXML 只循环 `items` 渲染 property-card。页面使用既有颜色、圆角、
safe area token；筛选按钮有清晰选中态，触控高度不少于 88rpx。

- [ ] **Step 5：验证并提交**

```powershell
pnpm test:wx -- property-list-page.test.js
pnpm wx:check
git add wx/pages/property-list wx/tests/property-list-page.test.js
git commit -m "feat(wx): browse and filter properties"
```

## Task 10：实现旅店详情和房型详情

**Files:**

- Create: `wx/pages/property-detail/property-detail.logic.js`
- Create: `wx/pages/property-detail/property-detail.js`
- Create: `wx/pages/property-detail/property-detail.json`
- Create: `wx/pages/property-detail/property-detail.wxml`
- Create: `wx/pages/property-detail/property-detail.wxss`
- Create: `wx/pages/room-detail/room-detail.logic.js`
- Create: `wx/pages/room-detail/room-detail.js`
- Create: `wx/pages/room-detail/room-detail.json`
- Create: `wx/pages/room-detail/room-detail.wxml`
- Create: `wx/pages/room-detail/room-detail.wxss`
- Create: `wx/tests/property-detail-page.test.js`
- Create: `wx/tests/room-detail-page.test.js`

- [ ] **Step 1：写旅店详情失败测试**

覆盖：

- URL 只有规范 UUID；坏 ID 返回旅店列表或首页且不请求；
- 从 search store 读取日期和人数；
- loading/success/error/retry；
- onHide/onUnload 后迟到响应抑制；
- 展示媒体、设施、政策和可售房型摘要；
- 点击房型只导航 `/pages/room-detail/room-detail?id=<encoded uuid>`；
- 响应为空房型时显示“当前条件暂无可售房型”；
- 错误文案不使用服务端 message。

- [ ] **Step 2：实现旅店详情**

页面 factory：

```js
createPropertyDetailPage({
  catalogService,
  getApp,
  wxApi,
})
```

data 固定为：

```js
{
  status: "loading",
  property: null,
  errorMessage: "",
}
```

请求代次和 active 规则与列表页一致。WXML 使用文本绑定，房型摘要显示床型、面积、最大
人数、规则和“每晚起”价格。

- [ ] **Step 3：写房型详情失败测试**

覆盖：

- 坏 UUID、坏搜索上下文和安全返回；
- loading/success/error/retry/迟到响应抑制；
- 所属旅店、房型内容、预订规则和逐晚价格；
- 页面对象和 WXML 都不含四个内部库存字段；
- 点击“选择此房型”只调用：

```js
wxApi.showModal({
  title: "预订功能即将开放",
  content: "报价与预订将在下一开发切片开放",
  showCancel: false,
});
```

不得调用 POST、不得写入订单 storage、不得跳转伪支付页。

- [ ] **Step 4：实现房型详情**

页面 factory：

```js
createRoomDetailPage({
  catalogService,
  getApp,
  wxApi,
})
```

data 只含 `status`、`roomType`、`errorMessage`。逐晚价格按服务端顺序渲染，通过 price
组件格式化；本地不相加总价。

- [ ] **Step 5：验证并提交**

```powershell
pnpm test:wx -- property-detail-page.test.js room-detail-page.test.js
pnpm wx:check
git add wx/pages/property-detail wx/pages/room-detail wx/tests/property-detail-page.test.js wx/tests/room-detail-page.test.js
git commit -m "feat(wx): view property and room details"
```

## Task 11：连接首页、页面注册和微信自动化闭环

**Files:**

- Modify: `wx/pages/home/home.js`
- Modify: `wx/tests/home-page.test.js`
- Modify: `wx/app.json`
- Modify: `wx/tests/configuration.test.js`
- Create: `wx/automator/slice-2-catalog.js`

- [ ] **Step 1：把首页旧提示行为测试改成真实导航失败测试**

删除“供给浏览将在下一开发切片开放”的断言，改为：

```js
it("opens property results only with a complete search context", () => {
  const page = pageContext(createHomePage({ getApp: () => app, locationService, wxApi }));
  page.data.canSearch = true;
  page.data.status = "ready";

  page.searchProperties.call(page);

  expect(wxApi.navigateTo).toHaveBeenCalledWith({
    url: "/pages/property-list/property-list",
  });
  expect(wxApi.showToast).not.toHaveBeenCalled();
});
```

并保留不完整搜索、登录错误和重复点击防御。

- [ ] **Step 2：实现首页导航和页面配置**

`searchProperties` 在 `status === "ready" && canSearch` 时导航列表，否则显示现有安全提示。
`app.json` 注册：

```json
"pages/property-list/property-list",
"pages/property-detail/property-detail",
"pages/room-detail/room-detail"
```

`configuration.test.js` 断言三页顺序存在且各自四个页面文件可被静态检查发现。

- [ ] **Step 3：写 automator 脚本**

使用 wechatide `automator` 技能支持的接口完成：

```text
打开首页
断言杭州、固定日期、3 人
点击搜索
断言一级卡片是旅店且不含房型列表
切换“民宿”，断言只剩民宿
恢复“全部”
打开第一家旅店
打开一个可售房型
断言逐晚价格和下一切片提示
返回两次，断言杭州、日期、3 人仍保持
```

每个关键页面保存截图和页面树；不得把 access token、refresh token 或精确坐标写入证据。

- [ ] **Step 4：Node 侧验证并提交**

```powershell
pnpm test:wx
pnpm wx:check
git add wx/pages/home/home.js wx/tests/home-page.test.js wx/app.json wx/tests/configuration.test.js wx/automator/slice-2-catalog.js
git commit -m "feat(wx): connect catalog browsing flow"
```

## Task 12：全量验证、官方微信编译、WSL2 实机和证据

**Files:**

- Create: `docs/verification/2026-07-29-slice-2-catalog.md`
- Modify only if validation exposes a defect: files already listed in Tasks 1–11

- [ ] **Step 1：执行全仓门禁**

```powershell
pnpm check
```

预期依次通过 workspace verify、微信静态检查、Prettier、ESLint、TypeScript、全部 Node/API/
微信测试和生产构建。漏洞报告按 AGENTS.md：dev 阶段记录但不因已知漏洞阻断 Slice 2。

- [ ] **Step 2：执行微信官方编译**

先使用 `initializer` 技能读取当前微信开发者工具环境、登录和项目上下文；再使用
`compiler` 技能逐页打开并编译：

```text
pages/property-list/property-list
pages/property-detail/property-detail
pages/room-detail/room-detail
```

每页检查 WXML/WXSS 编译成功。使用 `debugger` 技能检查 console、network 和截图，不得
出现运行时异常、重复分页请求、401 刷新循环或内部库存字段。

- [ ] **Step 3：执行微信用户闭环**

使用 `automator` 技能运行 `wx/automator/slice-2-catalog.js`。如果自动化桥接无法覆盖某个
官方面板操作，只把该项记录为明确人工门禁，不用单元测试替代真实面板证据。

- [ ] **Step 4：执行 WSL2 真实后端验证**

在隔离 worktree 根目录运行：

```powershell
pwsh -NoProfile -File scripts/wsl-runtime-validation.ps1
```

预期证据：

```text
PostGIS version 返回
Redis PONG
/health/live HTTP 200
/health/ready HTTP 200
API/Worker user=node readonly=true
Slice 1 identity/location/refresh smoke pass
Slice 2 catalog smoke pass
Worker 10/10 Running=true RestartCount=0
SLICE2_RUNTIME_CLEANUP_COMPLETE
```

结束后确认无临时容器、`.wsl-runtime` 或验证噪声；Compose 数据卷保留，无关
`rims-postgres` 不受影响。

- [ ] **Step 5：记录证据并重新运行相称门禁**

证据文档记录：

- commit SHA 与 `/wx` tree SHA；
- `pnpm check` 摘要；
- 数据库行数、重复 seed、筛选和分页结果；
- 微信官方编译的三个页面与 console/network 结果；
- automator 路径、截图和页面树位置；
- WSL 健康、非 root/只读、Catalog smoke、Worker 10 分钟；
- 当前依赖漏洞数量与 release 阻断状态；
- Slice 1 仍未关闭的真实定位拒绝人工面板项。

文档不得写入 token、精确坐标、真实用户资料或私有 AppID。

- [ ] **Step 6：提交并复核工作树**

```powershell
pnpm exec prettier --check docs/verification/2026-07-29-slice-2-catalog.md
git diff --check
git add docs/verification/2026-07-29-slice-2-catalog.md
git commit -m "test(slice-2): record catalog browsing evidence"
git status --short
git log -12 --oneline
git push origin codex/wx-mvp-booking-design
```

预期：隔离工作树为空，所有预期提交已推送；根目录 `dev` 的既有 Turbo 缓存修改未被触碰。

## Slice 2 完成定义

- 六家固定旅店、十二个房型及各 60 天价格库存可重复 seed，约束在真实 PostgreSQL 生效。
- 列表按城市、日期、人数、状态和类型返回旅店，游标分页无重复或遗漏。
- 一级结果不包含房型；旅店详情才返回当前搜索条件下的可售房型。
- 房型详情返回逐晚展示价但不泄露库存数量，不计算区间总价。
- `/wx` 完成首页、旅店列表、旅店详情、房型详情并保持搜索上下文。
- 全仓门禁、微信官方编译、automator 和 WSL2 Catalog smoke 全部通过。
- API 与 Worker 继续以非 root、只读根文件系统运行，Worker 观察 10 分钟重启数为零。
- 所有证据绑定当前 commit/tree；工作树干净，文件已推送。

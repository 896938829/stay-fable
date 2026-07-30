# 微信预订切片 4：订单生命周期 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现用户隔离的订单列表/详情、开发环境模拟支付、待支付取消和 Worker 超时释放，并在原生微信小程序提供“首页 / 订单”双 Tab 完成生命周期闭环。

**Architecture:** PostgreSQL 是订单生命周期唯一事实来源。API 支付/取消与 Worker 超时扫描统一使用“订单 → 占用 → 每日库存”的锁顺序；Worker 直接用 `FOR UPDATE SKIP LOCKED` 扫描到期订单，不使用延迟队列作为事实来源。微信端只消费严格 REST 契约和服务端 `allowed_actions`，不复制状态机。

**Tech Stack:** TypeScript 6、NestJS 11、Prisma 7 tagged SQL、PostgreSQL/PostGIS 17、`pg` 8、Redis/BullMQ、Zod 4、Vitest 4、原生微信 WXML/WXSS/JavaScript、WechatIDE skill、WSL2 Docker。

---

## 实施规则

- 在 `codex/wx-mvp-booking-design` worktree 执行；不得修改根 `dev` worktree。
- 每个任务先写失败测试，确认 RED，再写最小实现，确认 GREEN，最后原子提交。
- `/wx` 是唯一正式客户端；不修改冻结的 `apps/consumer-miniapp`。
- 数据库集成必须使用真实 PostgreSQL，不能用 SQLite 或仅 mock SQL 代替锁验证。
- API/Worker 写日志不得包含 token、用户 UUID、booking/payment UUID、幂等键、数据库 URL
  凭据或内部库存快照。
- WSL 验证只操作 `stay-fable-wsl-validation` 资源，不停止或删除 `rims-postgres` 等无关容器。
- dev 依赖漏洞只记录；release/main 继续阻断 Critical/High。

## Task 1：共享订单生命周期契约

**Files:**

- Create: `packages/api-contracts/src/booking-lifecycle.ts`
- Create: `packages/api-contracts/test/booking-lifecycle.test.ts`
- Modify: `packages/api-contracts/package.json`

- [ ] **Step 1: 写严格契约失败测试**

测试至少导入并覆盖：

```ts
import {
  bookingDetailSchema,
  bookingListQuerySchema,
  bookingListResponseSchema,
  cancelBookingRequestSchema,
  simulatePaymentRequestSchema,
} from "../src/booking-lifecycle.js";

expect(
  bookingListQuerySchema.parse({ limit: "10" }),
).toEqual({ limit: 10 });

expect(
  simulatePaymentRequestSchema.parse({ outcome: "SUCCEED" }),
).toEqual({ outcome: "SUCCEED" });

expect(() =>
  cancelBookingRequestSchema.parse({ unexpected: true }),
).toThrow();

expect(() =>
  bookingDetailSchema.parse({
    ...validBookingDetail,
    user_id: "00000000-0000-4000-8000-000000000001",
  }),
).toThrow();
```

还要验证：

- 状态只允许 `PENDING_PAYMENT|PAID|CONFIRMED|CANCELLED|CLOSED`；
- payment 只允许 `SUCCEEDED|FAILED`；
- `allowed_actions` 无重复且固定顺序；
- `nightly_prices` 与入住晚数、日期和总价一致；
- cursor 只允许 1–512 位 base64url；
- list 最多 20 项、history 最多 100 项；
- 危险 getter、Proxy、symbol key、unknown field 和超深对象失败关闭。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```powershell
corepack pnpm exec vitest run packages/api-contracts/test/booking-lifecycle.test.ts
```

Expected: FAIL，提示 `booking-lifecycle` export/module 不存在。

- [ ] **Step 3: 实现契约**

`booking-lifecycle.ts` 至少导出：

```ts
export const bookingStatusSchema = z.enum([
  "PENDING_PAYMENT",
  "PAID",
  "CONFIRMED",
  "CANCELLED",
  "CLOSED",
]);

export const bookingAllowedActionSchema = z.enum([
  "CANCEL",
  "MOCK_PAY_SUCCESS",
  "MOCK_PAY_FAILURE",
]);

export const bookingListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(20).default(10),
    cursor: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/).optional(),
  })
  .strict();

export const simulatePaymentRequestSchema = z
  .object({ outcome: z.enum(["SUCCEED", "FAIL"]) })
  .strict();

export const cancelBookingRequestSchema = z.object({}).strict();
```

建立并导出严格的：

```ts
bookingListItemSchema
bookingListResponseSchema
bookingPaymentSummarySchema
bookingStatusHistoryItemSchema
bookingDetailSchema
```

详情字段必须与设计文档第 8 节完全一致，不能包含用户、quote、幂等键、hold 或内部库存。

在 `package.json` 增加：

```json
"./booking-lifecycle": {
  "types": "./src/booking-lifecycle.ts",
  "default": "./dist/src/booking-lifecycle.js"
}
```

- [ ] **Step 4: 运行契约门禁**

Run:

```powershell
corepack pnpm exec vitest run packages/api-contracts/test/booking-lifecycle.test.ts packages/api-contracts/test/booking.test.ts
corepack pnpm --filter @stay-fable/api-contracts typecheck
corepack pnpm --filter @stay-fable/api-contracts lint
```

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```powershell
git add packages/api-contracts
git commit -m "feat(contracts): define booking lifecycle responses"
```

## Task 2：Payment migration、Prisma 模型和约束

**Files:**

- Create: `apps/api-server/prisma/migrations/202607300002_booking_lifecycle_payment/migration.sql`
- Modify: `apps/api-server/prisma/schema.prisma`
- Modify: `apps/api-server/test/database/quote-booking.integration.test.ts`

- [ ] **Step 1: 写 migration 失败测试**

在真实 PostgreSQL integration suite 增加断言：

```ts
expect(await tableExists("payment")).toBe(true);
expect(await enumValues("PaymentStatus")).toEqual(["SUCCEEDED", "FAILED"]);
expect(await enumValues("MockPaymentOutcome")).toEqual(["SUCCEED", "FAIL"]);
expect(await indexExists("payment_booking_success_key")).toBe(true);
```

插入测试必须证明：

- 同一 `(booking_id, idempotency_key)` 不能重复；
- 同一 booking 不能有两个 `SUCCEEDED` payment；
- `SUCCEED/FAILED` 组合被 CHECK 拒绝；
- 负金额、非 CNY、非法 payment number、非法幂等键被拒绝。

- [ ] **Step 2: 启动隔离 PostgreSQL 并确认 RED**

Run:

```powershell
$env:POSTGRES_PORT = "55432"
$env:REDIS_PORT = "56379"
$repoWsl = "/mnt/e/My Work/stay-fable/.worktrees/wx-mvp-booking-design"
wsl.exe -d Ubuntu-22.04 -- env POSTGRES_PORT=55432 REDIS_PORT=56379 docker compose `
  --project-name stay-fable-slice4-red `
  -f "$repoWsl/infrastructure/compose.yaml" up -d postgres
$env:DATABASE_URL = "postgresql://stay_fable:local_only_password@127.0.0.1:55432/stay_fable?schema=public&sslmode=disable"
corepack pnpm --filter @stay-fable/api-server prisma:migrate
corepack pnpm exec vitest run apps/api-server/test/database/quote-booking.integration.test.ts
```

Expected: 新 payment 断言 FAIL。

- [ ] **Step 3: 创建 migration**

Migration 必须创建：

```sql
CREATE TYPE "PaymentProvider" AS ENUM ('MOCK');
CREATE TYPE "PaymentStatus" AS ENUM ('SUCCEEDED', 'FAILED');
CREATE TYPE "MockPaymentOutcome" AS ENUM ('SUCCEED', 'FAIL');

CREATE TABLE "payment" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "booking_id" UUID NOT NULL,
  "payment_number" VARCHAR(23) NOT NULL,
  "provider" "PaymentProvider" NOT NULL DEFAULT 'MOCK',
  "status" "PaymentStatus" NOT NULL,
  "requested_outcome" "MockPaymentOutcome" NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'CNY',
  "idempotency_key" VARCHAR(80) NOT NULL,
  "processed_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_payment_number_key" UNIQUE ("payment_number"),
  CONSTRAINT "payment_booking_id_idempotency_key_key"
    UNIQUE ("booking_id", "idempotency_key"),
  CONSTRAINT "payment_number_check"
    CHECK ("payment_number" ~ '^SFP[0-9]{8}[A-F0-9]{12}$'),
  CONSTRAINT "payment_idempotency_key_check"
    CHECK ("idempotency_key" ~ '^[A-Za-z0-9._~-]{32,80}$'),
  CONSTRAINT "payment_amount_check" CHECK ("amount_cents" >= 0),
  CONSTRAINT "payment_currency_check" CHECK ("currency" = 'CNY'),
  CONSTRAINT "payment_outcome_status_check" CHECK (
    ("requested_outcome" = 'SUCCEED' AND "status" = 'SUCCEEDED')
    OR ("requested_outcome" = 'FAIL' AND "status" = 'FAILED')
  )
);

CREATE UNIQUE INDEX "payment_booking_success_key"
ON "payment"("booking_id")
WHERE "status" = 'SUCCEEDED';

CREATE INDEX "payment_booking_created_id_idx"
ON "payment"("booking_id", "created_at" DESC, "id" DESC);
```

并添加确定的 booking 外键：

```sql
ALTER TABLE "payment"
ADD CONSTRAINT "payment_booking_id_fkey"
FOREIGN KEY ("booking_id") REFERENCES "booking"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
```

- [ ] **Step 4: 更新 Prisma schema**

添加三个 enum、`Payment` model 和：

```prisma
model Booking {
  // existing fields
  payments Payment[]
}
```

Prisma model 必须映射全部数据库字段；partial unique index 只保留在 migration SQL，不伪造
Prisma 不支持的 schema 属性。

- [ ] **Step 5: 运行真实数据库 GREEN**

Run:

```powershell
corepack pnpm --filter @stay-fable/api-server prisma:generate
corepack pnpm exec vitest run apps/api-server/test/database/quote-booking.integration.test.ts
corepack pnpm --filter @stay-fable/api-server typecheck
```

Expected: integration 全部 PASS。

- [ ] **Step 6: 清理隔离容器**

Run:

```powershell
$repoWsl = "/mnt/e/My Work/stay-fable/.worktrees/wx-mvp-booking-design"
wsl.exe -d Ubuntu-22.04 -- env POSTGRES_PORT=55432 REDIS_PORT=56379 docker compose `
  --project-name stay-fable-slice4-red `
  -f "$repoWsl/infrastructure/compose.yaml" down
```

Expected: 只移除 `stay-fable-slice4-red` 容器和网络，数据卷保留；`rims-postgres` 未改变。

- [ ] **Step 7: 提交**

```powershell
git add apps/api-server/prisma apps/api-server/test/database/quote-booking.integration.test.ts
git commit -m "feat(database): add mock payment records"
```

## Task 3：订单列表与详情查询 API

**Files:**

- Create: `apps/api-server/src/booking/booking-cursor.ts`
- Create: `apps/api-server/src/booking/booking-query.repository.ts`
- Create: `apps/api-server/src/booking/booking-query.service.ts`
- Create: `apps/api-server/src/booking/booking-query.controller.ts`
- Create: `apps/api-server/src/booking/dto/booking-lifecycle-response.dto.ts`
- Create: `apps/api-server/test/booking-query.service.test.ts`
- Create: `apps/api-server/test/booking-query.controller.e2e.test.ts`
- Modify: `apps/api-server/src/booking/booking.module.ts`
- Modify: `apps/api-server/test/booking.openapi.test.ts`

- [ ] **Step 1: 写 query service/controller RED**

测试：

```ts
await request(app.getHttpServer())
  .get("/api/v1/bookings?limit=10")
  .set("Authorization", `Bearer ${accessToken}`)
  .expect(200);

await request(app.getHttpServer())
  .get(`/api/v1/bookings/${bookingId}`)
  .set("Authorization", `Bearer ${otherUserToken}`)
  .expect(404)
  .expect(({ body }) => {
    expect(body.error.code).toBe("BOOKING_NOT_FOUND");
  });
```

Service tests必须覆盖 cursor invalid、repository hostile output、当前用户过滤、到期 action 清空、
mock 开关关闭不返回支付 action。

- [ ] **Step 2: 运行确认 RED**

```powershell
corepack pnpm exec vitest run apps/api-server/test/booking-query.service.test.ts apps/api-server/test/booking-query.controller.e2e.test.ts
```

Expected: FAIL，query classes/routes 不存在。

- [ ] **Step 3: 实现 opaque cursor**

`booking-cursor.ts` 编解码：

```ts
interface BookingCursor {
  createdAt: string;
  id: string;
}
```

使用 base64url JSON，严格验证 exact keys、有效 UTC instant 和 UUID。任何异常统一抛
`400 ORDER_CURSOR_INVALID`，不回显 cursor。

- [ ] **Step 4: 实现 repository**

列表 SQL 必须：

```sql
WHERE booking.user_id = $userId
  AND (
    $afterCreatedAt IS NULL
    OR (booking.created_at, booking.id) < ($afterCreatedAt, $afterId)
  )
ORDER BY booking.created_at DESC, booking.id DESC
LIMIT $limitPlusOne
```

详情 SQL 必须同时按 `booking.id` 和 `booking.user_id`，并分别读取：

- booking 快照和 nightly prices；
- 最新 payment；
- 最多 100 条 status history；
- 不读取或映射 idempotency key、hold、daily inventory。

- [ ] **Step 5: 实现 service 和 allowed actions**

Service 捕获一次 `now`，严格解析 repository 输出并计算：

```ts
const pendingAndLive =
  booking.status === "PENDING_PAYMENT" &&
  booking.expires_at.getTime() > now.getTime();

const allowedActions = pendingAndLive
  ? [
      "CANCEL",
      ...(mockEnabled
        ? ["MOCK_PAY_SUCCESS", "MOCK_PAY_FAILURE"]
        : []),
    ]
  : [];
```

必须验证 actions 顺序并通过共享 schema 解析最终输出。
Service 对外方法固定为：

```ts
listOwned(userId: string, query: unknown): Promise<BookingListResponse>;
getOwned(userId: string, bookingId: unknown): Promise<BookingDetail>;
```

`BookingModule` 导出 `BookingQueryService`，供取消和模拟支付在事务提交后复用同一公共投影。

- [ ] **Step 6: 实现 controller/OpenAPI**

注册：

```text
GET /bookings
GET /bookings/:bookingId
```

使用 `SessionAuthGuard`，query/path pipe 严格校验。OpenAPI 响应不出现 user、quote、
idempotency、hold 或 inventory。

- [ ] **Step 7: 运行 GREEN**

```powershell
corepack pnpm exec vitest run apps/api-server/test/booking-query.service.test.ts apps/api-server/test/booking-query.controller.e2e.test.ts apps/api-server/test/booking.openapi.test.ts
corepack pnpm --filter @stay-fable/api-server typecheck
corepack pnpm --filter @stay-fable/api-server lint
```

Expected: 全部 PASS。

- [ ] **Step 8: 提交**

```powershell
git add apps/api-server/src/booking apps/api-server/test
git commit -m "feat(api): query owned booking lifecycle"
```

## Task 4：取消与通用释放事务

**Files:**

- Create: `apps/api-server/src/booking/booking-lifecycle.repository.ts`
- Create: `apps/api-server/src/booking/booking-lifecycle.service.ts`
- Create: `apps/api-server/src/booking/booking-actions.controller.ts`
- Create: `apps/api-server/test/booking-lifecycle.service.test.ts`
- Create: `apps/api-server/test/booking-actions.controller.e2e.test.ts`
- Modify: `apps/api-server/src/booking/booking.module.ts`
- Modify: `apps/api-server/src/common/rate-limit/write-rate-limit.service.ts`
- Modify: `apps/api-server/test/write-rate-limit.service.test.ts`
- Modify: `apps/api-server/test/booking.openapi.test.ts`

- [ ] **Step 1: 写取消状态机 RED**

Repository/service tests覆盖：

```ts
expect(await service.cancel(userId, bookingId, {})).toMatchObject({
  replayed: false,
  booking: { status: "CANCELLED", allowed_actions: [] },
});

expect(await service.cancel(userId, bookingId, {})).toMatchObject({
  replayed: true,
  booking: { status: "CANCELLED" },
});
```

还要覆盖越权 404、CONFIRMED/CLOSED 拒绝、已到期转 CLOSED 后 `BOOKING_EXPIRED`、Redis
失败关闭、非法 body/path、hostile DB output。

- [ ] **Step 2: 运行确认 RED**

```powershell
corepack pnpm exec vitest run apps/api-server/test/booking-lifecycle.service.test.ts apps/api-server/test/booking-actions.controller.e2e.test.ts
```

Expected: FAIL，lifecycle classes/routes 不存在。

- [ ] **Step 3: 实现 release repository**

新增事务方法：

```ts
cancelOwnedBooking(input: {
  userId: string;
  bookingId: string;
  now: Date;
}): Promise<
  | { kind: "CANCELLED" | "REPLAYED"; bookingId: string }
  | { kind: "EXPIRED"; bookingId: string }
  | { kind: "NOT_FOUND" | "NOT_CANCELLABLE" }
>;
```

SQL 固定顺序：

```text
booking FOR UPDATE
→ HELD holds ORDER BY business_date,id FOR UPDATE
→ daily_inventory ORDER BY business_date FOR UPDATE
→ 条件 held_inventory - 1
→ holds RELEASED
→ booking CANCELLED 或 CLOSED
→ status history
```

到期分支必须使用 `SYSTEM/PAYMENT_TIMEOUT`，取消分支使用 `USER/USER_CANCELLED`。任何晚次
缺失或 update count 不匹配抛内部 rollback sentinel，service 映射为 503。

- [ ] **Step 4: 扩展写限流**

在现有服务添加：

```ts
checkBookingCancellation(userId: string): Promise<void>;
```

窗口为 60 秒、limit 6，Redis key 只使用用户摘要。测试首次过期、retry-after、Redis failure
和 key 不含原始 user ID。

- [ ] **Step 5: 实现 service/controller**

Controller：

```text
POST /bookings/:bookingId/cancel
Body {}
```

`BookingLifecycleService` 在取消事务提交后调用导出的
`BookingQueryService.getOwned(userId, bookingId)` 取得唯一公共详情投影；repository 不自行
拼装 API DTO。首次和 replay 都返回 200。所有输出调用 `bookingDetailSchema.safeParse`。
越权统一 `BOOKING_NOT_FOUND`。

- [ ] **Step 6: 运行 GREEN**

```powershell
corepack pnpm exec vitest run apps/api-server/test/booking-lifecycle.service.test.ts apps/api-server/test/booking-actions.controller.e2e.test.ts apps/api-server/test/write-rate-limit.service.test.ts apps/api-server/test/booking.openapi.test.ts
corepack pnpm --filter @stay-fable/api-server typecheck
```

Expected: 全部 PASS。

- [ ] **Step 7: 提交**

```powershell
git add apps/api-server/src apps/api-server/test
git commit -m "feat(api): cancel pending bookings safely"
```

## Task 5：条件注册的模拟支付

**Files:**

- Create: `apps/api-server/src/booking/payment-number.ts`
- Create: `apps/api-server/src/booking/mock-payment.service.ts`
- Create: `apps/api-server/src/booking/dev-payments.controller.ts`
- Create: `apps/api-server/src/booking/mock-payment.module.ts`
- Create: `apps/api-server/test/payment-number.test.ts`
- Create: `apps/api-server/test/mock-payment.service.test.ts`
- Create: `apps/api-server/test/dev-payments.controller.e2e.test.ts`
- Modify: `apps/api-server/src/booking/booking-lifecycle.repository.ts`
- Modify: `apps/api-server/src/booking/booking.module.ts`
- Modify: `apps/api-server/src/app.module.ts`
- Modify: `apps/api-server/src/common/rate-limit/write-rate-limit.service.ts`
- Modify: `apps/api-server/test/app.module.test.ts`
- Modify: `apps/api-server/test/booking.openapi.test.ts`

- [ ] **Step 1: 写支付 RED**

测试必须覆盖：

```ts
const first = await service.simulate(userId, bookingId, key, {
  outcome: "SUCCEED",
});
expect(first).toMatchObject({
  replayed: false,
  booking: { status: "CONFIRMED" },
});

const replay = await service.simulate(userId, bookingId, key, {
  outcome: "SUCCEED",
});
expect(replay).toMatchObject({
  replayed: true,
  booking: { status: "CONFIRMED" },
});
```

还要覆盖 FAIL/replay、同键不同 outcome、过期、越权、终态、payment number 冲突重试一次、
未知 repository 异常、重复点击 controller 只调用一次。

- [ ] **Step 2: 运行确认 RED**

```powershell
corepack pnpm exec vitest run apps/api-server/test/payment-number.test.ts apps/api-server/test/mock-payment.service.test.ts apps/api-server/test/dev-payments.controller.e2e.test.ts
```

Expected: FAIL，支付实现不存在。

- [ ] **Step 3: 实现 payment number**

生成格式：

```ts
`SFP${yyyyMMddUtc}${randomBytes(6).toString("hex").toUpperCase()}`
```

严格得到 23 字符并匹配 `/^SFP[0-9]{8}[A-F0-9]{12}$/`。随机源和 Clock 可注入。

- [ ] **Step 4: 实现支付事务**

Repository 输入：

```ts
simulateMockPayment({
  userId,
  bookingId,
  idempotencyKey,
  outcome,
  paymentNumber,
  now,
});
```

先用参数派生的 advisory transaction lock，再锁 booking。SUCCESS 分支按设计将 held 转 sold、
holds 变 CONSUMED，创建 payment，依次写 PAID/CONFIRMED history。FAIL 只创建 FAILED
payment。使用 partial unique 和 `(booking,key)` unique 处理竞争，只对白名单 PostgreSQL/
Prisma 错误分类。Repository 只返回 result kind、replayed 和 canonical booking ID；成功/
replay 的公共响应由 `MockPaymentService` 在提交后调用
`BookingQueryService.getOwned(userId, bookingId)` 取得。

- [ ] **Step 5: 实现 service 和限流**

新增：

```ts
checkMockPayment(userId: string): Promise<void>;
```

60 秒 limit 10。Service 对 FAIL 抛稳定 `409 MOCK_PAYMENT_FAILED`；同键 FAIL 重放仍返回同一
错误；unknown/DB shape 统一 503。

- [ ] **Step 6: 条件注册 controller**

`MockPaymentModule.forRoot(process.env)` 必须：

```ts
const config = parseRuntimeEnvironment(environment);
const enabled =
  config.NODE_ENV !== "production" && config.ENABLE_MOCK_PAYMENT;
return {
  module: MockPaymentModule,
  imports: enabled ? [BookingModule, IdentityModule] : [],
  controllers: enabled ? [DevPaymentsController] : [],
};
```

生产 `ENABLE_MOCK_PAYMENT=true` 仍由共享配置解析直接拒绝启动。禁用时 OpenAPI 和 Nest route
均不存在，不返回专用探测错误。`MockPaymentService`、payment number provider 和 lifecycle
repository 由 `BookingModule` 提供并导出，动态模块不创建第二份 provider。

- [ ] **Step 7: 实现 controller**

```text
POST /dev/payments/:bookingId/simulate
```

严格解析 raw `Idempotency-Key`、path 和 `{outcome}`。首次成功 201、成功 replay 200、FAIL
409。认证和归属必需。

- [ ] **Step 8: 运行 GREEN**

```powershell
corepack pnpm exec vitest run apps/api-server/test/payment-number.test.ts apps/api-server/test/mock-payment.service.test.ts apps/api-server/test/dev-payments.controller.e2e.test.ts apps/api-server/test/app.module.test.ts apps/api-server/test/booking.openapi.test.ts apps/api-server/test/write-rate-limit.service.test.ts
corepack pnpm --filter @stay-fable/api-server typecheck
corepack pnpm --filter @stay-fable/api-server lint
```

Expected: 全部 PASS；禁用环境 route 404，启用环境 route 存在。

- [ ] **Step 9: 提交**

```powershell
git add apps/api-server/src apps/api-server/test
git commit -m "feat(api): simulate idempotent booking payments"
```

## Task 6：真实 PostgreSQL 生命周期与竞争测试

**Files:**

- Modify: `apps/api-server/test/database/quote-booking.integration.test.ts`
- Create: `apps/api-server/test/booking-lifecycle.integration.e2e.test.ts`

- [ ] **Step 1: 写并发 RED**

新增真实数据库场景：

```ts
const [payment, cancellation] = await Promise.allSettled([
  simulatePayment(ownerA, bookingId, paymentKey, "SUCCEED"),
  cancelBooking(ownerA, bookingId),
]);

expect(exactlyOneLifecycleWinner(payment, cancellation)).toBe(true);
await expectLifecycleInvariant(bookingId);
```

`expectLifecycleInvariant` 必须从数据库验证：

- 最终只可能 CONFIRMED 或 CANCELLED；
- CONFIRMED 时一条成功 payment、holds CONSUMED、held 归零、sold 加一；
- CANCELLED 时无成功 payment、holds RELEASED、held 归零、sold 不变；
- history 与最终状态一致；
- 每晚结果相同，不允许部分更新。

再覆盖支付与超时释放竞争、两个释放事务竞争、同键不同 outcome、越权和列表 cursor 隔离。

- [ ] **Step 2: 运行确认 RED**

使用 Task 2 的隔离 PostgreSQL 命令运行两个文件。Expected: 新场景至少一个 FAIL。

- [ ] **Step 3: 修正最小实现**

只修正 Task 3–5 暴露的锁顺序、条件更新、错误分类或响应绑定问题。禁止为测试增加生产旁路。

- [ ] **Step 4: 运行完整真实 PostgreSQL GREEN**

```powershell
corepack pnpm exec vitest run apps/api-server/test/database/quote-booking.integration.test.ts apps/api-server/test/booking-lifecycle.integration.e2e.test.ts
```

Expected: 全部 PASS，无 deadlock、timeout、部分晚次或负库存。

- [ ] **Step 5: 运行 API 全套**

```powershell
corepack pnpm --filter @stay-fable/api-server test
corepack pnpm --filter @stay-fable/api-server typecheck
corepack pnpm --filter @stay-fable/api-server lint
```

Expected: 全部 PASS；无数据库环境用例按 guard 明确 skip。

- [ ] **Step 6: 提交**

```powershell
git add apps/api-server
git commit -m "test(api): verify booking lifecycle races"
```

## Task 7：Worker PostgreSQL 配置和资源

**Files:**

- Modify: `packages/validation/src/environment.ts`
- Modify: `packages/validation/test/environment.test.ts`
- Modify: `apps/job-worker/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/job-worker/src/config.ts`
- Create: `apps/job-worker/src/database.ts`
- Modify: `apps/job-worker/src/worker.ts`
- Modify: `apps/job-worker/src/shutdown.ts`
- Modify: `apps/job-worker/test/config.test.ts`
- Modify: `apps/job-worker/test/worker.test.ts`
- Modify: `apps/job-worker/test/shutdown.test.ts`

- [ ] **Step 1: 写配置/资源 RED**

测试要求：

```ts
expect(parseWorkerConfig({
  NODE_ENV: "development",
  REDIS_URL: "redis://127.0.0.1:6379",
  DATABASE_URL:
    "postgresql://user:secret@127.0.0.1:5432/stay_fable?sslmode=disable",
  BOOKING_EXPIRY_POLL_MS: "5000",
})).toMatchObject({
  bookingExpiryPollMs: 5000,
});
```

生产禁用 TLS、错误协议、缺失 URL、999/60001 interval 必须拒绝，错误不得包含 `secret`。
shutdown 测试要求 sweeper、BullMQ worker、Redis 和 pool 都关闭一次。

- [ ] **Step 2: 运行确认 RED**

```powershell
corepack pnpm exec vitest run apps/job-worker/test/config.test.ts apps/job-worker/test/worker.test.ts apps/job-worker/test/shutdown.test.ts
```

Expected: FAIL，数据库配置和资源不存在。

- [ ] **Step 3: 增加依赖和配置**

Worker dependencies 增加：

```json
"@stay-fable/validation": "workspace:*",
"pg": "8.22.0"
```

devDependencies 增加：

```json
"@types/pg": "8.20.0"
```

在共享 validation 导出：

```ts
export const validateDatabaseUrlPolicy = (
  nodeEnv: "development" | "test" | "production",
  databaseUrl: string,
): string => {
  const parsed = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("DATABASE_URL must use postgres: or postgresql: protocol");
  }
  const sslModes = parsed.searchParams.getAll("sslmode");
  if (
    nodeEnv === "production" &&
    (sslModes.length !== 1 || sslModes[0] !== "require")
  ) {
    throw new Error("Production DATABASE_URL must require TLS");
  }
  return databaseUrl;
};
```

现有 `parseRuntimeEnvironment` 改为调用该 helper，保证 API 行为不变。Worker config 同样调用它，
返回 `databaseUrl` 和 `bookingExpiryPollMs`。

- [ ] **Step 4: 实现 pool 资源和关闭顺序**

`database.ts` 导出可注入工厂：

```ts
export interface DatabasePool {
  connect(): Promise<DatabaseClient>;
  end(): Promise<void>;
}
```

`SystemWorkerResources` 增加 pool 和 sweeper。shutdown：

```text
stop sweeper
→ close BullMQ worker
→ quit Redis
→ end PostgreSQL pool
```

每步失败要记录并继续关闭其余资源，最终设置非零退出码。

- [ ] **Step 5: 运行 GREEN**

```powershell
corepack pnpm install --lockfile-only
corepack pnpm exec vitest run packages/validation/test/environment.test.ts
corepack pnpm exec vitest run apps/job-worker/test/config.test.ts apps/job-worker/test/worker.test.ts apps/job-worker/test/shutdown.test.ts
corepack pnpm --filter @stay-fable/validation typecheck
corepack pnpm --filter @stay-fable/job-worker typecheck
corepack pnpm --filter @stay-fable/job-worker lint
```

Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```powershell
git add packages/validation apps/job-worker pnpm-lock.yaml
git commit -m "feat(worker): connect booking expiry database"
```

## Task 8：Worker 到期扫描与释放

**Files:**

- Create: `apps/job-worker/src/booking-expiry.repository.ts`
- Create: `apps/job-worker/src/booking-expiry.sweeper.ts`
- Create: `apps/job-worker/test/booking-expiry.repository.test.ts`
- Create: `apps/job-worker/test/booking-expiry.sweeper.test.ts`
- Create: `apps/job-worker/test/booking-expiry.integration.test.ts`
- Modify: `apps/job-worker/src/worker.ts`

- [ ] **Step 1: 写 sweeper RED**

单元测试：

```ts
await sweeper.tick();
await sweeper.tick();

expect(repository.closeNextExpired).toHaveBeenCalledTimes(expectedCalls);
expect(logger.info).toHaveBeenCalledWith(
  expect.objectContaining({ processedCount: 2, failedCount: 1 }),
  "booking expiry sweep completed",
);
```

覆盖：

- tick 不重叠；
- 最多 25 单；
- `NONE` 停止本轮；
- 一单失败继续下一单；
- timer 1000–60000ms；
- stop 等待当前 tick；
- 日志不含 UUID、用户、URL、key。

- [ ] **Step 2: 运行确认 RED**

```powershell
corepack pnpm exec vitest run apps/job-worker/test/booking-expiry.repository.test.ts apps/job-worker/test/booking-expiry.sweeper.test.ts
```

Expected: FAIL，repository/sweeper 不存在。

- [ ] **Step 3: 实现单订单事务**

`closeNextExpired(now)`：

```text
BEGIN
→ SELECT 一个 PENDING_PAYMENT 到期 booking FOR UPDATE SKIP LOCKED
→ 无记录则 COMMIT + NONE
→ 锁 HELD holds
→ 锁 daily_inventory
→ 条件释放每晚 held
→ holds RELEASED
→ booking CLOSED
→ history SYSTEM/PAYMENT_TIMEOUT
→ COMMIT + CLOSED(booking_number)
```

所有 SQL 参数化。返回日志仅需安全 booking number，不返回 UUID/库存。

- [ ] **Step 4: 实现 sweeper**

使用注入 Clock/timer/repository/logger。每 tick 捕获一个 now，最多循环 25。`start()` 立即执行
一次后再设 interval；`stop()` 清 interval 并等待 active tick。

- [ ] **Step 5: 真实 PostgreSQL 双 Worker 测试**

在随机 schema 创建到期订单，两个 repository 并发执行：

```ts
await Promise.all([workerA.closeNextExpired(now), workerB.closeNextExpired(now)]);
```

断言只有一次 CLOSED history、held 只减一次、所有 hold RELEASED、其他订单仍可处理。

- [ ] **Step 6: 运行 GREEN**

```powershell
corepack pnpm exec vitest run apps/job-worker/test
corepack pnpm --filter @stay-fable/job-worker typecheck
corepack pnpm --filter @stay-fable/job-worker lint
```

Expected: 全部 PASS。

- [ ] **Step 7: 提交**

```powershell
git add apps/job-worker
git commit -m "feat(worker): close expired pending bookings"
```

## Task 9：Slice 4 WSL 运行时 verifier

**Files:**

- Create: `scripts/verify-slice-4-runtime.mjs`
- Create: `scripts/verify-slice-4-runtime.test.mjs`
- Modify: `scripts/wsl-runtime-validation.ps1`
- Modify: `scripts/wsl-runtime-validation.sh`
- Modify: `scripts/wsl-runtime-validation.test.mjs`

- [ ] **Step 1: 写 marker/cleanup RED**

测试要求固定 marker：

```text
SLICE4_BOOKING_QUERY_ISOLATED
SLICE4_MOCK_FAILURE_IDEMPOTENT
SLICE4_MOCK_SUCCESS_CONFIRMED
SLICE4_CANCEL_RELEASED
SLICE4_LIFECYCLE_RACE_SERIALIZED
SLICE4_WORKER_EXPIRY_RELEASED
SLICE4_UAT_READY http://127.0.0.1:3000
```

每个 marker 必须出现在对应数据库断言之后。cleanup 未成功时不得输出 UAT_READY。

- [ ] **Step 2: 运行确认 RED**

```powershell
node --test scripts/verify-slice-4-runtime.test.mjs scripts/wsl-runtime-validation.test.mjs
```

Expected: FAIL，Slice 4 verifier/marker 不存在。

- [ ] **Step 3: 实现 bounded verifier**

Verifier 必须：

- 两个 mock 用户登录；
- 创建独立订单；
- 查询列表/详情并验证跨用户 404；
- FAIL + 同键 replay 后数据库只有一条 FAILED payment、订单仍待支付；
- SUCCEED 后最终 CONFIRMED、held0/sold1、history 包含 PAID/CONFIRMED；
- cancel + replay 后只释放一次；
- 支付/取消并发只有一个终态；
- 将专用订单 `expires_at` 更新为过去，轮询最多 30 秒等待真实 Worker 关闭；
- 逐项断言数据库计数和库存；
- finally 恢复 seed 价格/库存并删除测试用户相关 payment/history/hold/booking/quote/identity/user。

不得输出 token、用户 UUID、booking/payment UUID、幂等键或库存数值。

- [ ] **Step 4: 扩展 WSL 环境**

验证 API 临时使用：

```text
ENABLE_MOCK_PAYMENT=true
```

Worker 增加 `DATABASE_URL` 和 `BOOKING_EXPIRY_POLL_MS=1000`。默认 `.env.example` 仍是 false。
Slice 4 verifier 在 Slice 3 后、10 分钟 Worker 观察前运行。

- [ ] **Step 5: 保留失败诊断**

复用 `run_slice_three_runtime_validation` 的安全模式为 Slice 4 helper，必须保留 verifier 原退出码，
诊断失败不遮蔽，成功不打印最近日志。

- [ ] **Step 6: 运行脚本门禁**

```powershell
node --test scripts/verify-slice-4-runtime.test.mjs scripts/wsl-runtime-validation.test.mjs
wsl.exe -d Ubuntu-22.04 -- bash -n '/mnt/e/My Work/stay-fable/.worktrees/wx-mvp-booking-design/scripts/wsl-runtime-validation.sh'
```

Expected: 全部 PASS。

- [ ] **Step 7: 提交**

```powershell
git add scripts
git commit -m "test(runtime): verify booking lifecycle slice"
```

## Task 10：微信订单严格契约与 service

**Files:**

- Modify: `wx/services/contracts.js`
- Modify: `wx/services/booking.js`
- Create: `wx/services/orders.js`
- Create: `wx/tests/order-contracts.test.js`
- Create: `wx/tests/order-service.test.js`
- Modify: `wx/tests/booking-service.test.js`

- [ ] **Step 1: 写客户端 RED**

测试：

```js
expect(assertBookingListResponse(validList)).toEqual(canonicalList);
expect(() =>
  assertBookingDetail({ ...validDetail, user_id: USER_ID }),
).toThrow(/Invalid API response/);

await orders.simulatePayment(
  BOOKING_ID,
  { outcome: "SUCCEED" },
  IDEMPOTENCY_KEY,
  { isActive: () => true },
);
expect(post).toHaveBeenCalledWith(
  `/dev/payments/${BOOKING_ID}/simulate`,
  { outcome: "SUCCEED" },
  {
    header: { "Idempotency-Key": IDEMPOTENCY_KEY },
    retry: false,
  },
);
```

覆盖危险对象、unknown field、用户/hold/inventory 泄露、取消空 body、path 编码、generation
cancel 和安全错误白名单。

- [ ] **Step 2: 运行确认 RED**

```powershell
corepack pnpm exec vitest run wx/tests/order-contracts.test.js wx/tests/order-service.test.js
```

Expected: FAIL，assertions/service 不存在。

- [ ] **Step 3: 实现严格 contracts**

新增：

```js
assertBookingListResponse
assertBookingDetail
```

使用现有 descriptor snapshot 防 getter/Proxy；所有对象 exact keys；数组有上限；日期、instant、
金额、状态转换 history、payment 和 allowed actions 逐项校验。

- [ ] **Step 4: 实现 orders service**

API：

```js
listBookings(query, options)
getBooking(bookingId, options)
cancelBooking(bookingId, options)
simulatePayment(bookingId, input, idempotencyKey, options)
```

GET 可由页面手动 retry；三个写动作都传 `retry:false`。只透传白名单业务错误，未知异常统一
`BOOKING_LIFECYCLE_UNAVAILABLE`。

- [ ] **Step 5: 运行 GREEN**

```powershell
corepack pnpm exec vitest run wx/tests/order-contracts.test.js wx/tests/order-service.test.js wx/tests/booking-service.test.js
corepack pnpm test:wx
corepack pnpm wx:check
```

Expected: 全部 PASS，仍是现有 7 页。

- [ ] **Step 6: 提交**

```powershell
git add wx/services wx/tests
git commit -m "feat(wx): consume booking lifecycle APIs"
```

## Task 11：订单列表页

**Files:**

- Create: `wx/pages/order-list/order-list.js`
- Create: `wx/pages/order-list/order-list.logic.js`
- Create: `wx/pages/order-list/order-list.json`
- Create: `wx/pages/order-list/order-list.wxml`
- Create: `wx/pages/order-list/order-list.wxss`
- Create: `wx/tests/order-list-page.test.js`

- [ ] **Step 1: 写页面 RED**

页面测试覆盖：

```js
await page.onLoad();
expect(page.data.status).toBe("list");
expect(page.data.items[0]).toMatchObject({
  statusLabel: "待支付",
  actionLabel: "查看订单",
});
```

还要覆盖 empty、首屏 error、footer error、cursor、下拉刷新、onShow 去重、双击 item 只导航一次、
晚到响应、hide/unload 和无效 booking ID。

- [ ] **Step 2: 运行确认 RED**

```powershell
corepack pnpm exec vitest run wx/tests/order-list-page.test.js
```

Expected: FAIL，页面不存在。

- [ ] **Step 3: 实现纯 logic**

`toOrderListItemView` 只格式化：

- 状态中文；
- 日期/晚数/人数；
- 人民币金额；
- 待支付剩余秒数；
- deadline passed 提示。

不推导 allowed actions，不更改服务端状态。

- [ ] **Step 4: 实现页面状态机**

状态：

```text
loading | empty | list | error
footer: idle | loading | error | done
```

普通页面 `<button class="order-row__action">` 直接绑定 ID，不创建 shadow custom component。
`onShow` 从详情返回后只触发一个安全刷新；分页期间不并发首屏刷新。

- [ ] **Step 5: 运行 GREEN**

```powershell
corepack pnpm exec vitest run wx/tests/order-list-page.test.js
corepack pnpm test:wx
```

Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```powershell
git add wx/pages/order-list wx/tests/order-list-page.test.js
git commit -m "feat(wx): list current user bookings"
```

## Task 12：订单详情、模拟支付和取消页

**Files:**

- Create: `wx/pages/order-detail/order-detail.js`
- Create: `wx/pages/order-detail/order-detail.logic.js`
- Create: `wx/pages/order-detail/order-detail.json`
- Create: `wx/pages/order-detail/order-detail.wxml`
- Create: `wx/pages/order-detail/order-detail.wxss`
- Create: `wx/tests/order-detail-page.test.js`

- [ ] **Step 1: 写详情状态机 RED**

测试覆盖：

```js
await page.onLoad({ id: BOOKING_ID });
await page.simulateSuccess();
await page.simulateSuccess();
expect(orders.simulatePayment).toHaveBeenCalledTimes(1);
expect(page.data.booking.status).toBe("CONFIRMED");
```

并覆盖 FAIL、cancel confirm/cancel modal、cancel unknown 后 GET 对账、支付 unknown 保留 key、明确
结果清 key、非法链接、allowed actions、hide/unload、晚到响应、终态无按钮。

- [ ] **Step 2: 运行确认 RED**

```powershell
corepack pnpm exec vitest run wx/tests/order-detail-page.test.js
```

Expected: FAIL，页面不存在。

- [ ] **Step 3: 实现纯 view logic**

映射：

```text
PENDING_PAYMENT → 待支付
PAID → 支付处理中
CONFIRMED → 已确认
CANCELLED → 已取消
CLOSED → 已关闭
```

状态历史 reason 使用固定白名单中文，不展示未知服务端文本。逐晚和总价只格式化服务端金额。

- [ ] **Step 4: 实现页面**

状态：

```text
loading | ready | refreshing | action_pending | action_uncertain | error
```

按钮只按 `allowed_actions`：

```text
CANCEL → 取消订单
MOCK_PAY_SUCCESS → 模拟支付成功（开发）
MOCK_PAY_FAILURE → 模拟支付失败（开发）
```

支付 scope：

```js
`payment:${bookingId}:${outcome}`
```

所有写操作 `submitting` 锁互斥。cancel 网络未知后先 `getBooking`；支付网络未知显示可用同 key
重试，不自动 POST。

- [ ] **Step 5: 运行 GREEN**

```powershell
corepack pnpm exec vitest run wx/tests/order-detail-page.test.js
corepack pnpm test:wx
```

Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```powershell
git add wx/pages/order-detail wx/tests/order-detail-page.test.js
git commit -m "feat(wx): manage pending booking lifecycle"
```

## Task 13：双 Tab、订单入口和本地图标

**Files:**

- Modify: `wx/app.json`
- Modify: `wx/pages/booking-confirm/booking-confirm.js`
- Modify: `wx/pages/booking-confirm/booking-confirm.wxml`
- Modify: `wx/pages/booking-confirm/booking-confirm.wxss`
- Modify: `wx/tests/booking-confirm-page.test.js`
- Modify: `wx/tests/configuration.test.js`
- Create: `wx/images/tab-home.png`
- Create: `wx/images/tab-home-selected.png`
- Create: `wx/images/tab-orders.png`
- Create: `wx/images/tab-orders-selected.png`

- [ ] **Step 1: 写配置/导航 RED**

测试要求：

```js
expect(app.pages).toContain("pages/order-list/order-list");
expect(app.pages).toContain("pages/order-detail/order-detail");
expect(app.tabBar.list.map((item) => item.pagePath)).toEqual([
  "pages/home/home",
  "pages/order-list/order-list",
]);
```

booking created 主按钮必须 redirect 当前 booking detail，次按钮必须 switchTab 到订单列表；连续
点击只执行一次导航。

- [ ] **Step 2: 运行确认 RED**

```powershell
corepack pnpm exec vitest run wx/tests/configuration.test.js wx/tests/booking-confirm-page.test.js
```

Expected: FAIL，页面/Tab/导航不存在。

- [ ] **Step 3: 生成并验证图标**

使用 `imagegen` 技能生成一组透明背景、单色线性住宿主题图标：

```text
home：极简屋顶轮廓
orders：极简订单票据轮廓
normal：#8a7f76
selected：#9b5c3f
```

每个输出裁切并保存为 81×81 PNG，单文件 < 40 KiB；不得包含文字、渐变、品牌标识或远程引用。
运行：

```powershell
Get-ChildItem wx/images/tab-*.png |
  ForEach-Object {
    if ($_.Length -ge 40960) { throw "tab icon too large: $($_.Name)" }
  }
```

- [ ] **Step 4: 更新 app.json**

页面顺序保持 home 第一，增加 2 页。Tab 配置：

```json
{
  "color": "#8a7f76",
  "selectedColor": "#9b5c3f",
  "backgroundColor": "#fbf7f2",
  "borderStyle": "white",
  "list": [
    {
      "pagePath": "pages/home/home",
      "text": "首页",
      "iconPath": "images/tab-home.png",
      "selectedIconPath": "images/tab-home-selected.png"
    },
    {
      "pagePath": "pages/order-list/order-list",
      "text": "订单",
      "iconPath": "images/tab-orders.png",
      "selectedIconPath": "images/tab-orders-selected.png"
    }
  ]
}
```

- [ ] **Step 5: 收口 booking-confirm**

成功区：

```text
主按钮：查看订单 → redirectTo /pages/order-detail/order-detail?id=<bookingId>
次按钮：查看全部订单 → switchTab /pages/order-list/order-list
```

删除“下一开发切片开放”。页面只使用内存中的严格 booking ID。

- [ ] **Step 6: 运行 GREEN**

```powershell
corepack pnpm exec vitest run wx/tests/configuration.test.js wx/tests/booking-confirm-page.test.js
corepack pnpm test:wx
corepack pnpm wx:check
```

Expected: 全部 PASS，`wx:check` 报告 9 pages。

- [ ] **Step 7: 提交**

```powershell
git add wx
git commit -m "feat(wx): add booking lifecycle navigation"
```

## Task 14：官方微信编译、预览和 UAT 准备

**Files:**

- Modify only if official validation exposes a defect in Task 10–13 files.

- [ ] **Step 1: 运行微信门禁**

```powershell
corepack pnpm test:wx
corepack pnpm wx:check
```

Expected: 全部 PASS，9 pages。

- [ ] **Step 2: 用 initializer 检查环境**

确认：

- WechatIDE skill version equal；
- 登录有效；
- token 不需要；
- 打开当前 worktree `/wx`，不是根 `dev` `/wx`。

- [ ] **Step 3: 用 compiler 编译**

官方打开并编译：

```text
pages/booking-confirm/booking-confirm
pages/order-list/order-list
pages/order-detail/order-detail
```

三页 WXML/WXSS 共 6 项成功，再刷新模拟器。

- [ ] **Step 4: 用 debugger 检查**

console/network：

- 无 runtime exception；
- 无 401 循环；
- 每次支付或取消最多一个 POST；
- GET 刷新不触发写请求；
- 不出现 token、幂等键、用户 UUID 或内部库存日志。

- [ ] **Step 5: 创建预览**

使用 previewer 生成一次微信预览二维码或推送手机预览，不上传体验版。预览证据只记录生成成功和
脱敏图片路径，不记录 private AppID。

- [ ] **Step 6: 准备 Slice 5 UAT 清单**

在 `SLICE4_UAT_READY` 窗口：

1. 首页 → 旅店 → 房型 → 报价 → 下单；
2. 查看订单详情；
3. 模拟失败，确认仍待支付；
4. 模拟成功，确认最终已确认；
5. 订单 Tab 查看列表和详情；
6. 新建另一单并取消，确认已取消；
7. 连续点击各写按钮，network 每项最多一个 POST；
8. 保存 commit、`/wx` tree、执行日期和脱敏截图。

RC Automator 未修复时必须如实记录，不能替代 Slice 5 物理门禁。

- [ ] **Step 7: 缺陷按 TDD 修复**

只修改直接暴露的文件并运行对应测试。没有缺陷时不创建空提交。

## Task 15：完整 WSL2、证据和独立复核

**Files:**

- Create: `docs/verification/2026-07-30-slice-4-booking-lifecycle.md`
- Modify only if validation exposes a defect.

- [ ] **Step 1: 全仓门禁和审计**

```powershell
corepack pnpm check
corepack pnpm audit --audit-level high
```

Expected: `check` exit 0；audit 按实际数量记录。dev 不阻断，release/main 继续阻断未例外的
Critical/High。

- [ ] **Step 2: 唯一完整 WSL2 验证**

```powershell
powershell -NoProfile -File scripts/wsl-runtime-validation.ps1 -Distro Ubuntu-22.04
```

Expected:

- PostGIS、PONG、live/ready；
- API/Worker `user=node readonly=true`；
- Slice 1–4 全部 marker；
- Worker 真实关闭过期订单；
- Worker 10/10、restart 0；
- cleanup complete；
- `.wsl-runtime` 删除；
- `rims-postgres` 未改变。

- [ ] **Step 3: 稳定窗口执行官方工具 UAT**

当输出 `SLICE4_UAT_READY` 后执行 Task 14 清单。只能使用模拟器 loopback；真机必须配置合规
非生产 HTTPS 域名，不能关闭域名/TLS 校验作为证据。

- [ ] **Step 4: 写验证记录**

记录：

- 输入 commit 和 `/wx` tree；
- migration、seed/payment 清理后聚合计数；
- 查询隔离、支付失败/成功、取消、竞争和 Worker expiry；
- API/Worker/health；
- 微信编译、console/network、预览；
- 人工/手机/Automator 的真实状态；
- audit 数量和 release 阻断；
- 清理结果。

不得记录 token、幂等键、用户 UUID、private AppID、精确坐标或内部库存快照。

- [ ] **Step 5: 格式与证据检查**

```powershell
corepack pnpm prettier --write docs/verification/2026-07-30-slice-4-booking-lifecycle.md
git diff --check
git status --short
```

所有链接必须存在，截图脱敏，临时容器和 `.wsl-runtime` 必须清理。

- [ ] **Step 6: 提交证据**

```powershell
git add docs/verification/2026-07-30-slice-4-booking-lifecycle.md
git commit -m "test(slice-4): record booking lifecycle evidence"
```

- [ ] **Step 7: 最终独立复核**

依次完成：

1. Slice 4 规格符合性；
2. 代码质量与安全；
3. 生命周期竞争与证据。

所有 Critical、Important、Minor 必须关闭后，才进入 Slice 5 全流程验收收口。

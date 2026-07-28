# 微信预订切片 1：身份与搜索上下文 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 `/wx` 在真实 NestJS、Redis 和 PostgreSQL/PostGIS 上完成确定性模拟登录、会话续期、定位失败回退、城市选择、日期和人数选择，并通过微信官方编译与 WSL2 验证。

**Architecture:** 以统一响应协议和运行配置为地基；Identity 通过可替换 provider 产生平台主体，用 Redis 保存哈希后的轮换会话；Location 以 PostgreSQL 城市表和 PostGIS 距离查询为事实来源；原生微信端用小型 service/store 分层持有会话与搜索上下文，不复制后端业务规则。

**Tech Stack:** TypeScript 6、NestJS 11、Prisma 7、PostgreSQL 17/PostGIS、Redis/ioredis、Zod、Vitest/Supertest、原生微信小程序 JavaScript、微信开发者工具、WSL2 Docker。

---

## 实施约束

- 在分支 `codex/wx-mvp-booking-design` 的独立 worktree 内执行。
- 使用测试驱动：每个行为先写失败测试并确认失败原因，再实现最小代码。
- 本计划不创建旅店、房型、价格、库存或订单模型；它们属于切片 2 和 3。
- `MockWechatIdentityProvider` 只接受 `mock:` 前缀登录码。生产环境选择 mock provider
  必须在配置解析阶段启动失败。
- Redis 不保存登录码或明文令牌。精确经纬度不进入日志。
- 小程序 trial/release 环境没有显式 `apiBaseUrl` 时必须失败，不静默连接开发地址。

## Task 1：统一 API 响应、请求 ID 与稳定业务错误

**Files:**

- Create: `apps/api-server/src/common/http/request-context.ts`
- Create: `apps/api-server/src/common/http/business.exception.ts`
- Create: `apps/api-server/src/common/http/api-envelope.interceptor.ts`
- Create: `apps/api-server/src/common/http/api-exception.filter.ts`
- Modify: `apps/api-server/src/application-configuration.ts`
- Test: `apps/api-server/test/api-envelope.e2e.test.ts`

### Step 1：先写失败的端到端测试

在 `api-envelope.e2e.test.ts` 建立只用于测试的控制器：

```ts
@Controller("contract-probe")
class ContractProbeController {
  @Get("ok")
  ok() {
    return { value: 1 };
  }

  @Get("bad")
  bad() {
    throw new BusinessException(
      HttpStatus.BAD_REQUEST,
      "CITY_NOT_SUPPORTED",
      "当前城市暂未开通",
    );
  }
}
```

断言：

```ts
it("wraps successful API responses with one request id", async () => {
  const response = await request(app.getHttpServer())
    .get("/api/v1/contract-probe/ok")
    .set("x-request-id", "req_test_123")
    .expect(200);

  expect(response.headers["x-request-id"]).toBe("req_test_123");
  expect(response.body).toEqual({
    data: { value: 1 },
    request_id: "req_test_123",
  });
});

it("never exposes exception internals", async () => {
  const response = await request(app.getHttpServer())
    .get("/api/v1/contract-probe/bad")
    .expect(400);

  expect(response.body).toEqual({
    error: { code: "CITY_NOT_SUPPORTED", message: "当前城市暂未开通" },
    request_id: response.headers["x-request-id"],
  });
  expect(JSON.stringify(response.body)).not.toContain("stack");
});
```

运行并确认测试因公共 HTTP 类不存在而失败：

```powershell
pnpm --filter @stay-fable/api-server test -- api-envelope.e2e.test.ts
```

### Step 2：实现请求上下文和业务异常

`request-context.ts`：

```ts
import type { Request } from "express";

export type RequestWithId = Request & { requestId: string };
```

`business.exception.ts`：

```ts
import { HttpException } from "@nestjs/common";

export class BusinessException extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message, status);
  }
}
```

拦截器将业务返回包装为 `{ data, request_id }`。异常过滤器只对外输出稳定 code、
message、可选 details 和同一 request ID；未知异常统一为
`INTERNAL_SERVER_ERROR`/`服务暂时不可用`。在 `configureApplication` 中：

```ts
app.use((request: RequestWithId, response: Response, next: NextFunction) => {
  const supplied = request.header("x-request-id");
  request.requestId =
    supplied && /^[A-Za-z0-9_-]{8,80}$/.test(supplied)
      ? supplied
      : `req_${randomUUID().replaceAll("-", "")}`;
  response.setHeader("x-request-id", request.requestId);
  next();
});
app.useGlobalInterceptors(new ApiEnvelopeInterceptor());
app.useGlobalFilters(new ApiExceptionFilter());
```

拦截器对 `/health/live`、`/health/ready` 和 `/internal/openapi` 保留现有原始格式。

### Step 3：验证并提交

```powershell
pnpm --filter @stay-fable/api-server test -- api-envelope.e2e.test.ts health.e2e.test.ts bootstrap.smoke.test.ts
pnpm --filter @stay-fable/api-server typecheck
git add apps/api-server/src/common apps/api-server/src/application-configuration.ts apps/api-server/test/api-envelope.e2e.test.ts
git commit -m "feat(api): add stable response envelope"
```

## Task 2：运行配置、Redis 生命周期和可控时钟

**Files:**

- Modify: `.env.example`
- Modify: `packages/validation/src/environment.ts`
- Modify: `packages/validation/test/environment.test.ts`
- Create: `apps/api-server/src/common/clock/clock.ts`
- Create: `apps/api-server/src/infrastructure/redis/redis.service.ts`
- Create: `apps/api-server/src/infrastructure/redis/redis.module.ts`
- Test: `apps/api-server/src/infrastructure/redis/redis.service.test.ts`
- Modify: `apps/api-server/src/app.module.ts`

### Step 1：写生产安全门禁测试

在 validation 测试中加入：

```ts
it("rejects mock identity in production", () => {
  expect(() =>
    parseRuntimeEnvironment({
      ...productionEnvironment,
      IDENTITY_PROVIDER: "mock",
    }),
  ).toThrow("Production IDENTITY_PROVIDER must be code2session");
});

it("rejects mock payment in production", () => {
  expect(() =>
    parseRuntimeEnvironment({
      ...productionEnvironment,
      IDENTITY_PROVIDER: "code2session",
      ENABLE_MOCK_PAYMENT: "true",
    }),
  ).toThrow("Production ENABLE_MOCK_PAYMENT must be false");
});
```

运行：

```powershell
pnpm --filter @stay-fable/validation test
```

### Step 2：扩展配置并实现可控时钟

Zod schema 增加：

```ts
IDENTITY_PROVIDER: z.enum(["mock", "code2session"]).default("mock"),
ENABLE_MOCK_PAYMENT: z.stringbool().default(false),
SESSION_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(7200),
SESSION_REFRESH_TTL_SECONDS: z.coerce.number().int().min(3600).max(7776000).default(2592000),
LOCATION_MAX_DISTANCE_METERS: z.coerce.number().int().min(1000).max(500000).default(100000),
```

`.env.example` 使用：

```dotenv
IDENTITY_PROVIDER=mock
ENABLE_MOCK_PAYMENT=false
SESSION_ACCESS_TTL_SECONDS=7200
SESSION_REFRESH_TTL_SECONDS=2592000
LOCATION_MAX_DISTANCE_METERS=100000
```

`clock.ts`：

```ts
export const CLOCK = Symbol("CLOCK");

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
```

### Step 3：先测后实现 Redis 服务

测试用伪 ioredis 客户端断言：

- `onModuleInit` 执行 `ping`；
- `onModuleDestroy` 执行 `quit`；
- `setJson` 使用 `EX` 秒级 TTL；
- `consumeJson` 使用固定 Lua 脚本原子执行 GET + DEL；
- 日志和错误对象中不出现 value。

公开接口固定为：

```ts
export class RedisService {
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  consumeJson<T>(key: string): Promise<T | null>;
  delete(key: string): Promise<void>;
}
```

Lua 脚本：

```lua
local value = redis.call("GET", KEYS[1])
if value then redis.call("DEL", KEYS[1]) end
return value
```

`RedisModule` 使用 `parseRuntimeEnvironment(process.env).REDIS_URL` 创建单例，并在
`AppModule` 导入。

### Step 4：验证并提交

```powershell
pnpm --filter @stay-fable/validation test
pnpm --filter @stay-fable/api-server test -- redis.service.test.ts
pnpm --filter @stay-fable/api-server typecheck
git add .env.example packages/validation apps/api-server/src/common/clock apps/api-server/src/infrastructure/redis apps/api-server/src/app.module.ts
git commit -m "feat(runtime): add secure identity session configuration"
```

## Task 3：用户、身份和城市的 PostgreSQL/PostGIS 基线

**Files:**

- Modify: `apps/api-server/prisma/schema.prisma`
- Create: `apps/api-server/prisma/migrations/202607290001_identity_location/migration.sql`
- Create: `apps/api-server/prisma/seed.ts`
- Modify: `apps/api-server/package.json`
- Modify: `apps/api-server/prisma.config.ts`
- Create: `apps/api-server/test/database/identity-location.integration.test.ts`
- Modify: `.github/workflows/ci.yml`

### Step 1：定义失败的真实数据库测试

测试使用 `DATABASE_URL` 指向真实 PostgreSQL/PostGIS，执行迁移和 seed 后断言：

```ts
expect(await prisma.city.count()).toBe(2);
expect(await prisma.city.count({ where: { enabled: true } })).toBe(2);
expect(await prisma.userIdentity.count()).toBe(0);

await runSeed();
expect(await prisma.city.count()).toBe(2);

const extensions = await prisma.$queryRaw<Array<{ extname: string }>>`
  SELECT extname FROM pg_extension WHERE extname = 'postgis'
`;
expect(extensions).toEqual([{ extname: "postgis" }]);
```

先在 WSL 测试数据库上运行，确认因表不存在失败：

```bash
pnpm --filter @stay-fable/api-server test -- identity-location.integration.test.ts
```

### Step 2：加入 Prisma 模型

`schema.prisma` 增加：

```prisma
enum UserStatus {
  ACTIVE
  DISABLED
}

enum IdentityProvider {
  WECHAT
}

model User {
  id         String         @id @default(uuid()) @db.Uuid
  status     UserStatus     @default(ACTIVE)
  identities UserIdentity[]
  createdAt  DateTime       @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt  DateTime       @updatedAt @map("updated_at") @db.Timestamptz(3)

  @@map("user")
}

model UserIdentity {
  id              String           @id @default(uuid()) @db.Uuid
  userId          String           @map("user_id") @db.Uuid
  provider        IdentityProvider
  providerSubject String           @map("provider_subject") @db.VarChar(160)
  user            User             @relation(fields: [userId], references: [id], onDelete: Cascade)
  createdAt       DateTime         @default(now()) @map("created_at") @db.Timestamptz(3)

  @@unique([provider, providerSubject])
  @@index([userId])
  @@map("user_identity")
}

model City {
  id             String    @id @default(uuid()) @db.Uuid
  code           String    @unique @db.VarChar(32)
  nameZh         String    @map("name_zh") @db.VarChar(80)
  center         Unsupported("geography(Point,4326)")
  enabled        Boolean   @default(true)
  displayOrder   Int       @map("display_order")
  createdAt      DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt      DateTime  @updatedAt @map("updated_at") @db.Timestamptz(3)

  @@index([enabled, displayOrder])
  @@map("city")
}
```

迁移 SQL 必须显式包含：

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE INDEX "city_center_gix" ON "city" USING GIST ("center");
```

### Step 3：实现确定性 seed

使用固定 UUID 和参数化原始 SQL upsert 两个测试运营城市：

```ts
export const seedCities = [
  {
    id: "10000000-0000-4000-8000-000000000001",
    code: "330100",
    nameZh: "杭州",
    longitude: 120.1551,
    latitude: 30.2741,
    displayOrder: 10,
  },
  {
    id: "10000000-0000-4000-8000-000000000002",
    code: "520100",
    nameZh: "贵阳",
    longitude: 106.6302,
    latitude: 26.647,
    displayOrder: 20,
  },
] as const;
```

每条使用 `$executeRaw` 标签模板和
`ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography`，冲突时更新名称、中心点、
启用状态和排序。导出 `runSeed()` 供测试复用，直接执行脚本时连接、seed、断开。

`package.json` 增加：

```json
"prisma:seed": "tsx prisma/seed.ts"
```

并增加固定版本 `tsx` devDependency。CI 在数据库服务 ready 后依次运行
`prisma migrate deploy`、`prisma:seed`、集成测试。

### Step 4：验证并提交

```bash
pnpm install --lockfile-only
pnpm --filter @stay-fable/api-server prisma:generate
pnpm --filter @stay-fable/api-server prisma:migrate
pnpm --filter @stay-fable/api-server prisma:seed
pnpm --filter @stay-fable/api-server test -- identity-location.integration.test.ts
git add pnpm-lock.yaml apps/api-server/prisma apps/api-server/package.json apps/api-server/prisma.config.ts apps/api-server/test/database .github/workflows/ci.yml
git commit -m "feat(database): add identity and city foundation"
```

## Task 4：Identity provider、轮换会话和鉴权

**Files:**

- Create: `packages/api-contracts/src/auth.ts`
- Create: `packages/api-contracts/test/auth.test.ts`
- Modify: `packages/api-contracts/package.json`
- Create: `apps/api-server/src/identity/wechat-identity.provider.ts`
- Create: `apps/api-server/src/identity/mock-wechat-identity.provider.ts`
- Create: `apps/api-server/src/identity/session.service.ts`
- Create: `apps/api-server/src/identity/auth.service.ts`
- Create: `apps/api-server/src/identity/auth.controller.ts`
- Create: `apps/api-server/src/identity/current-user.ts`
- Create: `apps/api-server/src/identity/session-auth.guard.ts`
- Create: `apps/api-server/src/identity/identity.module.ts`
- Test: `apps/api-server/src/identity/mock-wechat-identity.provider.test.ts`
- Test: `apps/api-server/src/identity/session.service.test.ts`
- Test: `apps/api-server/test/auth.e2e.test.ts`
- Modify: `apps/api-server/src/app.module.ts`

### Step 1：契约和失败测试

契约：

```ts
export const wechatLoginRequestSchema = z.object({
  code: z.string().min(8).max(128),
});

export const authSessionSchema = z.object({
  access_token: z.string().min(32),
  access_expires_in: z.number().int().positive(),
  refresh_token: z.string().min(32),
  refresh_expires_in: z.number().int().positive(),
  user: z.object({ id: z.uuid() }),
});

export const refreshSessionRequestSchema = z.object({
  refresh_token: z.string().min(32),
});
```

在 `package.json` 的 `exports` 增加 `./auth`，其 types 指向 `./src/auth.ts`，构建产物指向
`./dist/src/auth.js`。`auth.test.ts` 对请求和响应各加入一组有效样本与一组缺字段/短 token
的失败样本，确保契约不是只定义而未执行。

单元测试覆盖：

```ts
expect(await provider.exchange("mock:user-a")).toEqual({
  provider: "WECHAT",
  subject: expect.stringMatching(/^mock_[a-f0-9]{64}$/),
});
await expect(provider.exchange("real-code")).rejects.toMatchObject({
  code: "AUTH_PROVIDER_REJECTED",
});
```

会话测试使用固定 Clock，断言 access/refresh token 均由 `randomBytes(32)` 产生，Redis key
只含 SHA-256 哈希；刷新令牌消费一次后不能再次刷新。

端到端测试覆盖：

- `mock:user-a` 重复登录得到同一 user ID；
- `mock:user-b` 得到不同 user ID；
- access token 可通过测试受保护路由读取当前用户；
- refresh 成功轮换两个令牌；
-旧 refresh 重放返回 `AUTH_REFRESH_REJECTED`；
- 无 token/坏 token 返回 `AUTH_SESSION_EXPIRED`；
- 数据库中不出现登录码。

### Step 2：实现 provider 和用户绑定

固定接口：

```ts
export const WECHAT_IDENTITY_PROVIDER = Symbol("WECHAT_IDENTITY_PROVIDER");

export interface WechatIdentityProvider {
  exchange(code: string): Promise<{
    provider: "WECHAT";
    subject: string;
  }>;
}
```

Mock provider 对完整 code 做 SHA-256，并只返回 `mock_<digest>`。`AuthService.login` 使用
Prisma 事务按 `(provider, providerSubject)` 查找；不存在时创建 User 和 UserIdentity，
唯一键冲突时重新查询，避免并发登录创建两个用户。

### Step 3：实现会话和鉴权

Redis 记录结构：

```ts
type StoredSession = {
  kind: "access" | "refresh";
  userId: string;
  familyId: string;
  issuedAt: string;
  expiresAt: string;
};
```

key 固定为 `session:<kind>:<sha256(token)>`。刷新时用 `consumeJson` 原子消费旧 refresh，
删除同 family 的旧 access，再签发一对新令牌。`SessionAuthGuard` 只接受
`Authorization: Bearer <token>`，将 `{ id: userId }` 放到 request.user。

控制器：

```ts
@Post("auth/wechat/login")
login(@Body() body: WechatLoginDto) {
  return this.authService.login(body.code);
}

@Post("auth/session/refresh")
refresh(@Body() body: RefreshSessionDto) {
  return this.authService.refresh(body.refresh_token);
}
```

DTO 使用 class-validator 重复执行边界校验；OpenAPI 注解与 Zod 契约字段一致。

### Step 4：验证并提交

```powershell
pnpm --filter @stay-fable/api-contracts test
pnpm --filter @stay-fable/api-server test -- mock-wechat-identity.provider.test.ts session.service.test.ts auth.e2e.test.ts
pnpm --filter @stay-fable/api-server typecheck
git add packages/api-contracts apps/api-server/src/identity apps/api-server/src/app.module.ts apps/api-server/test/auth.e2e.test.ts
git commit -m "feat(identity): add mock WeChat login and rotating sessions"
```

## Task 5：城市列表和 PostGIS 定位解析

**Files:**

- Create: `packages/api-contracts/src/location.ts`
- Create: `packages/api-contracts/test/location.test.ts`
- Modify: `packages/api-contracts/package.json`
- Create: `apps/api-server/src/location/location.service.ts`
- Create: `apps/api-server/src/location/location.controller.ts`
- Create: `apps/api-server/src/location/location.module.ts`
- Create: `apps/api-server/src/location/dto/resolve-location.dto.ts`
- Test: `apps/api-server/src/location/location.service.test.ts`
- Test: `apps/api-server/test/location.integration.test.ts`
- Modify: `apps/api-server/src/app.module.ts`

### Step 1：写失败测试

契约：

```ts
export const citySchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
});

export const resolveLocationRequestSchema = z.object({
  longitude: z.number().min(-180).max(180),
  latitude: z.number().min(-90).max(90),
});

export const resolvedLocationSchema = z.object({
  city: citySchema,
  distance_meters: z.number().int().nonnegative(),
});
```

在 `package.json` 的 `exports` 增加 `./location`，并在 `location.test.ts` 验证有效城市、越界
经纬度和缺少 `distance_meters` 的响应。这样 API 只能从稳定子路径导入契约。

真实 PostGIS 测试断言杭州中心附近匹配杭州、距离排序正确；远离两个运营城市的坐标返回
`CITY_NOT_SUPPORTED`。端到端测试还断言日志捕获中不包含请求的原始经纬度文本。

### Step 2：实现服务和接口

城市列表：

```ts
return this.database.city.findMany({
  where: { enabled: true },
  orderBy: [{ displayOrder: "asc" }, { id: "asc" }],
  select: { id: true, code: true, nameZh: true },
});
```

定位使用固定 SQL，不拼接用户输入：

```ts
const matches = await this.database.$queryRaw<ResolvedCity[]>`
  SELECT id, code, name_zh AS "name",
    ROUND(ST_Distance(
      center,
      ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography
    ))::int AS distance_meters
  FROM city
  WHERE enabled = true
  ORDER BY center <-> ST_SetSRID(
    ST_MakePoint(${longitude}, ${latitude}), 4326
  )::geography, display_order, id
  LIMIT 1
`;
```

无匹配或距离超过 `LOCATION_MAX_DISTANCE_METERS` 时抛出
`CITY_NOT_SUPPORTED`。控制器提供：

```text
GET  /api/v1/cities
POST /api/v1/location/resolve
```

两者要求有效 access token。

### Step 3：验证并提交

```bash
pnpm --filter @stay-fable/api-contracts test
pnpm --filter @stay-fable/api-server test -- location.service.test.ts location.integration.test.ts
pnpm --filter @stay-fable/api-server typecheck
git add packages/api-contracts apps/api-server/src/location apps/api-server/src/app.module.ts apps/api-server/test/location.integration.test.ts
git commit -m "feat(location): add operating cities and coordinate resolution"
```

## Task 6：原生微信请求层、会话 store 与搜索 store

**Files:**

- Create: `wx/config/runtime.js`
- Create: `wx/services/contracts.js`
- Create: `wx/services/request.js`
- Create: `wx/services/auth.js`
- Create: `wx/services/location.js`
- Create: `wx/stores/session.js`
- Create: `wx/stores/search.js`
- Create: `wx/utils/date.js`
- Create: `wx/utils/money.js`
- Create: `wx/utils/idempotency.js`
- Create: `wx/tests/runtime.test.js`
- Create: `wx/tests/request.test.js`
- Create: `wx/tests/search.test.js`
- Modify: `package.json`

### Step 1：先写 Node 单元测试

增加根脚本：

```json
"test:wx": "vitest run wx/tests"
```

测试覆盖：

- develop 环境无 ext config 时返回 `http://127.0.0.1:3000`；
- trial/release 无 `apiBaseUrl` 时抛错；
- 响应必须同时包含 `data` 与合法 `request_id`；
- 401 时并发请求共用一次 refresh promise，并只重放一次；
- refresh 失败清空 storage 并触发一次重新登录；
- POST 写操作不因网络错误自动重试；
- 默认日期为本地明天和后天，不用 UTC 字符串截断；
- checkout 必须晚于 checkin，人数范围 1–10；
- idempotency key 在一次提交期间稳定，成功或明确失败后才清除。

示例：

```js
it("shares one refresh across concurrent 401 responses", async () => {
  const refresh = vi.fn().mockResolvedValue(freshSession);
  const client = createRequestClient({ wx: fakeWx, sessionStore, refresh });
  await Promise.all([client.get("/cities"), client.get("/cities")]);
  expect(refresh).toHaveBeenCalledTimes(1);
});
```

运行并确认模块不存在：

```powershell
pnpm test:wx
```

### Step 2：实现运行配置和契约验证

`runtime.js`：

```js
function getRuntimeConfig(wxApi) {
  const envVersion =
    wxApi.getAccountInfoSync().miniProgram.envVersion || "develop";
  const ext = wxApi.getExtConfigSync ? wxApi.getExtConfigSync() : {};
  if (ext.apiBaseUrl) return { apiBaseUrl: ext.apiBaseUrl, envVersion };
  if (envVersion === "develop") {
    return { apiBaseUrl: "http://127.0.0.1:3000", envVersion };
  }
  throw new Error("apiBaseUrl is required outside develop");
}

module.exports = { getRuntimeConfig };
```

`contracts.js` 提供 `assertEnvelope`、`assertAuthSession`、`assertCity`、
`assertResolvedLocation`，任何结构异常抛出 `{ code: "INVALID_API_RESPONSE" }`，不把不可信
对象直接写入页面状态。

### Step 3：实现请求与 store

`request.js` 对外接口：

```js
function createRequestClient(dependencies) {
  return {
    get(path, options),
    post(path, body, options),
  };
}
```

规则：

- 自动加 `Authorization` 和 `x-request-id`；
- 只有 GET 网络失败最多自动重试一次；
- 401 最多 refresh 一次，并用模块级 promise 合并并发刷新；
- POST 不自动重试；
- 将 API error 原样映射为 `{ code, message, requestId, details }`；
- 日志不得包含 token、code、longitude 或 latitude。

`session.js` 只持久化 session 对象，暴露：

```js
getSession();
setSession(session);
clearSession();
ensureSession();
refreshSession();
```

`ensureSession` 调用 `wx.login`，将 `res.code` 只传给 auth service，不写 storage。

`search.js` 保存 `{ city, checkin, checkout, guests }`。默认明天入住、一晚、2 人；每次写入
均执行本地格式和范围校验。

### Step 4：验证并提交

```powershell
pnpm test:wx
pnpm wx:check
git add package.json wx/config wx/services wx/stores wx/utils wx/tests
git commit -m "feat(wx): add session-aware request and search stores"
```

## Task 7：微信登录、城市、日期和人数页面

**Files:**

- Modify: `wx/app.js`
- Modify: `wx/app.json`
- Modify: `wx/app.wxss`
- Delete: `wx/pages/index/index.js`
- Delete: `wx/pages/index/index.json`
- Delete: `wx/pages/index/index.wxml`
- Delete: `wx/pages/index/index.wxss`
- Create: `wx/pages/home/home.js`
- Create: `wx/pages/home/home.json`
- Create: `wx/pages/home/home.wxml`
- Create: `wx/pages/home/home.wxss`
- Create: `wx/pages/city-select/city-select.js`
- Create: `wx/pages/city-select/city-select.json`
- Create: `wx/pages/city-select/city-select.wxml`
- Create: `wx/pages/city-select/city-select.wxss`
- Create: `wx/pages/date-guest-select/date-guest-select.js`
- Create: `wx/pages/date-guest-select/date-guest-select.json`
- Create: `wx/pages/date-guest-select/date-guest-select.wxml`
- Create: `wx/pages/date-guest-select/date-guest-select.wxss`
- Create: `wx/components/loading-state/*`
- Create: `wx/components/empty-state/*`
- Create: `wx/components/error-state/*`
- Create: `wx/tests/home-page.test.js`
- Modify: `wx/sitemap.json`

### Step 1：写页面逻辑失败测试

将可测试状态转换导出为纯函数，测试：

```js
expect(toHomeView({ session: null, loading: true })).toMatchObject({
  state: "loading",
});
expect(toHomeView({ session: null, error: authError })).toMatchObject({
  state: "error",
  retryable: true,
});
expect(locationFailureToAction({ errMsg: "authorize:fail auth deny" })).toEqual({
  route: "/pages/city-select/city-select",
  reason: "permission_denied",
});
```

城市页测试加载、空态、错误重试和选择后回到首页。日期人数页测试非法日期不保存，合法选择
保存后回到首页。

### Step 2：实现应用启动和首页

`app.js` 不再保存 logs 或空调用 `wx.login`，只初始化 store：

```js
const sessionStore = require("./stores/session");
const searchStore = require("./stores/search");

App({
  async onLaunch() {
    searchStore.initializeDefaults();
    await sessionStore.ensureSession().catch(() => undefined);
  },
  globalData: { sessionStore, searchStore },
});
```

`app.json` 首页面改为 `pages/home/home`，注册 city-select 和 date-guest-select。首页：

- onShow 读取 search store；
- 无 session 时显示加载或可重试错误；
- “使用当前位置”先用模态框解释用途，再调用 `wx.getLocation({ type: "gcj02" })`；
- 坐标只存在当前调用栈，发往 `/location/resolve` 后立即丢弃；
- 拒绝、超时、API 错误均引导手动选城市；
- 点击城市或日期人数行进入对应页面；
- 切片 1 的搜索按钮在上下文完整时显示“下一步：浏览旅店”，点击显示
  `供给浏览将在下一开发切片开放`，不伪造旅店数据。

### Step 3：实现三个统一状态组件

每个组件使用独立目录下的 `.js/.json/.wxml/.wxss`：

- `loading-state`：可配置文字，默认“正在加载”；
- `empty-state`：标题、说明和可选 action；
- `error-state`：稳定中文消息和 `retry` 事件，不显示堆栈/request body。

全局 WXSS 定义暖色变量：

```css
page {
  --color-brand: #9b5c3f;
  --color-brand-soft: #f5e8df;
  --color-text: #2d241f;
  --color-muted: #786b63;
  --color-surface: #fffaf6;
  --radius-card: 24rpx;
  background: var(--color-surface);
  color: var(--color-text);
}
```

所有可点击控件最小高度 `88rpx`。

### Step 4：静态验证并提交

```powershell
pnpm test:wx
pnpm wx:check
git add wx
git commit -m "feat(wx): add login and search context experience"
```

## Task 8：微信官方编译、自动化验收和 WSL2 实机证据

**Files:**

- Create: `wx/automator/slice-1-identity-search.js`
- Modify: `docs/operations/wsl-runtime-validation.md`
- Create: `docs/verification/2026-07-29-slice-1-identity-search.md`

### Step 1：使用微信技能完成官方编译

严格按技能工作流：

1. 使用 `wechatide-skill` 根入口读取运行时。
2. 使用 `initializer` 打开当前 worktree 的 `/wx` 项目。
3. 使用 `compiler` 执行官方编译并检查 console/network。
4. 编译错误使用 `debugger` 定位，回到对应任务补测试后修复。

证据文档记录开发者工具版本、基础库版本、编译时间、结果和截图路径；不得写登录 token。

### Step 2：执行自动化用户路径

`slice-1-identity-search.js` 覆盖：

```text
启动并等待模拟登录
→ 首页显示默认明天/后天和 2 人
→ 拒绝定位
→ 进入城市选择
→ 选择杭州
→ 修改为后天入住、住 2 晚、3 人
→ 回到首页并保留全部选择
→ 清除 access token
→ 触发请求并验证 refresh 后仍为登录状态
```

使用 `automator` 技能运行脚本。若系统无法程序化拒绝授权，先清除授权状态，再通过开发者
工具授权面板设置拒绝，并在证据中注明可重复步骤。

### Step 3：WSL2 后端验证

在 Ubuntu-22.04 按现有运行手册启动 PostGIS、Redis、API 和 Worker。除原有检查外执行：

```bash
docker compose exec -T postgres \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT PostGIS_Version();"
docker compose exec -T redis redis-cli ping
curl -fsS http://127.0.0.1:3000/health/live
curl -fsS http://127.0.0.1:3000/health/ready
```

再用两个 mock code 验证用户隔离、refresh 轮换、城市列表、杭州坐标匹配和远距坐标业务
错误。检查 API/Worker 非 root、只读根文件系统；Worker 保持 10 分钟，重启为 0、无重连
循环。结束时只清理本轮临时容器/产物，保留命名数据卷。

### Step 4：运行切片门禁

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm wx:check
pnpm audit:report
git status --short
```

漏洞报告按 dev 政策记录数量和等级，不因此伪报失败或静默忽略。证据文档包含所有命令、
退出码、微信编译/automator 结果、WSL 容器状态和已知漏洞摘要。

### Step 5：提交证据

```powershell
git add wx/automator docs/operations/wsl-runtime-validation.md docs/verification/2026-07-29-slice-1-identity-search.md
git commit -m "test(slice-1): verify identity and search context"
git status --short --branch
```

## 切片 1 完成定义

只有以下条件全部满足才可声称完成并开始规划切片 2：

- 相同 mock code 稳定映射同一用户，不同 code 彼此隔离。
- access 过期可单次刷新并重放，旧 refresh 不能重放。
- 生产配置不能启用 mock identity 或 mock payment。
- 城市来自 PostgreSQL seed，重复 seed 不产生重复数据。
- PostGIS 能匹配支持城市，远距坐标返回稳定业务错误。
- `/wx` 覆盖登录失败、定位拒绝、城市选择、日期和人数选择。
- 精确坐标、登录码和令牌不出现在持久化、页面或日志。
- Node 测试、API 测试、真实数据库测试、静态检查、类型检查、构建全部通过。
- 微信开发者工具官方编译和 automator 路径通过。
- WSL2 PostGIS/Redis/API/Worker 验证与 10 分钟观察通过。
- 工作区只包含已提交的预期文件，验证产物无噪声。

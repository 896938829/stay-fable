# CloudBase Run 部署契约

## 服务边界

| 服务   | 入口                                                        | 端口与探针                                                                 | 扩缩容边界                       |
| ------ | ----------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------- |
| API    | 有公网 HTTPS 入口；仅允许受控域名访问                       | 容器端口 `3000`；存活探针 `GET /health/live`；就绪探针 `GET /health/ready` | 根据 HTTP 并发和延迟独立扩缩容   |
| worker | 无公网入口；仅主动连接 Redis、PostgreSQL 和必要的腾讯云 API | 不开放容器端口，也不配置 HTTP 探针                                         | 根据队列积压和任务耗时独立扩缩容 |

API 就绪探针只有在 PostgreSQL/PostGIS 与 Redis 均可用时才通过。存活探针只反映进程
状态，不应因下游暂时故障触发无休止重启。CloudBase Run 的安全组或访问策略必须阻止
公网直接访问 PostgreSQL、Redis 和 worker。

## 配置与 Secret

变量按用途严格区分。非敏感部署配置可作为环境变量；凭证只通过 CloudBase Secret
或腾讯云密钥管理服务注入。每个环境使用自己的值，禁止跨 `dev`、`staging`、`prod`
复制 Secret。

| 名称                | 类型     | 使用方      | 说明                                                                                   |
| ------------------- | -------- | ----------- | -------------------------------------------------------------------------------------- |
| `DATABASE_URL`      | Secret   | API、worker | `postgresql://` 或 `postgres://` 连接串；生产必须且只能包含一个 `sslmode=require` 参数 |
| `REDIS_URL`         | Secret   | API、worker | Redis 连接串；生产要求 `rediss://`                                                     |
| `JWT_SECRET`        | Secret   | API         | 高熵签名密钥，支持轮换                                                                 |
| `WECHAT_APP_ID`     | 环境变量 | API         | 当前环境对应的微信应用标识                                                             |
| `WECHAT_APP_SECRET` | Secret   | API         | 微信应用密钥                                                                           |
| `COS_SECRET_ID`     | Secret   | API、worker | 优先使用最小权限临时凭证或服务身份                                                     |
| `COS_SECRET_KEY`    | Secret   | API、worker | 不写入镜像、日志或普通环境文件                                                         |
| `COS_BUCKET`        | 环境变量 | API、worker | 当前环境独占的对象存储桶                                                               |
| `COS_REGION`        | 环境变量 | API、worker | 对象存储地域                                                                           |

部署前应校验全部必需变量存在，但错误信息不得输出变量值。日志应对连接串、令牌和微信、
COS 凭证做脱敏。

## 发布、迁移与回滚

1. 构建并扫描不可变镜像，以镜像摘要晋级环境；禁止使用 `latest`。
2. 对生产数据库创建可恢复备份，并由受审计的发布流水线从同一 Git 提交创建一次性迁移
   任务，执行 `pnpm --filter @stay-fable/api-server prisma:migrate`。生产 API 镜像仅含运行时
   依赖，不能充当迁移镜像；迁移任务需要锁定的 Prisma CLI 和专用最小权限数据库账号。
3. 仅在迁移成功后启动 API 滚动发布。平台先等待新实例的 `/health/live` 和
   `/health/ready` 通过，再停止旧实例；发布期间至少保留一个就绪实例。
4. API 稳定后滚动发布 worker。关闭 worker 时先停止领取新任务，再等待在途任务完成，
   防止任务重复或丢失。
5. 发布后观察错误率、延迟、就绪状态和队列积压。超过阈值立即停止扩大发布。

应用回滚使用上一已验证镜像摘要。数据库迁移必须保持向前、向后兼容，先扩展结构、再发布
应用、最后在后续版本清理旧结构；不得依赖破坏性自动回滚。若迁移失败，停止应用发布，
按已演练的恢复步骤处理数据库，再恢复上一镜像。发布记录应保存镜像摘要、迁移版本、操作者
和时间。

## 基础镜像摘要核验

Dockerfile 同时保留便于审计的版本标签 `node:24.14.1-bookworm-slim`，并锁定该标签的 OCI
镜像索引摘要。摘要必须从 Docker 官方 Registry 的
`registry-1.docker.io/v2/library/node/manifests/24.14.1-bookworm-slim` 获取，并以
`Docker-Content-Digest` 响应头为准；请求需要从 `auth.docker.io` 获取
`repository:library/node:pull` 只读令牌，并声明接受
`application/vnd.oci.image.index.v1+json`。2026-07-27 核验值为
`sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c`。升级 Node
版本或发现镜像重建时，应重复此核验、审查上游变更并同步更新两个 Dockerfile 和契约测试。

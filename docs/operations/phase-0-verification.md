Status: Blocked
Owner role: Engineering Owner
Review cadence: At every Phase 0 verification run and weekly while any gate is blocked

# Phase 0 验证证据

状态释义：阻断
负责人角色：工程负责人
复审周期：每次执行 Phase 0 验证时复审；存在未解除门禁期间每周复审

## 2026-07-27 历史证据来源

历史验证日期：2026-07-27

任务 11 父提交／输入证据提交：`058735e2f0f464f03bb334c015d86ece567b7e74`

验证实现提交：`ea77dbfe11269ad9778ee6054cadffd24fbe2b0a`

质量整改输入提交：`6bf55d4341ea03bfea4e8dbf8832d30ef681f55b`

历史整改证据提交：`bcd312122dc6fe9b41f5e6ec2febf3181e144410`

验证器和本证据页由“验证实现提交”首次引入；readiness 和可重复冒烟测试整改最终固化在上述
不可变的“历史整改证据提交”。本文记录的 2026-07-27 命令针对“质量整改输入提交 + 完整整改
工作状态”执行，并以该历史整改证据提交作为可复现来源，而不是以上三个较早的输入提交。

本记录将确定性的仓库检查，与必须依赖本工作站之外的系统或责任人完成的运行和组织检查分开。
发布状态为 **Blocked（阻断）**：仓库质量检查通过，不能覆盖依赖门禁失败或外部证据缺失。
外部材料的权威交叉索引为
[`launch-evidence-index.md`](../compliance/launch-evidence-index.md)。

## 当前 HEAD 的微信优先验证契约

当前默认的 `pnpm check` 包含 `pnpm wx:check`，后者通过
[`scripts/check-wx-project.mjs`](../../scripts/check-wx-project.mjs) 对唯一正式用户端 `/wx`
执行原生项目静态验证，包括 `project.config.json`、`app.json` 和页面文件完整性。
`apps/consumer-miniapp` 是冻结的 Taro 多平台参考工程，不进入默认检查、测试或构建。

当前状态：**official validation pending**。当前 HEAD 的 `/wx` tree 已包含旧证据采集后的
客户端基础层变更，尚未由微信开发者工具完成官方编译或预览。Task 8 执行官方编译与预览之后，
才能为当前 tree 采集新的不可变 input、tree ID、编译摘要和预览结果；在此之前不得沿用历史结果，也不得声称
当前 tree 已通过官方工具验证。当前微信官方工具证据状态为 **Blocked**。

## 2026-07-28 历史微信官方工具证据

本节是 **historical / superseded** 证据，只绑定到当时的原生微信项目输入，不代表当前 HEAD，
不可作为当前 `/wx` tree 已完成官方编译或预览的证据。不可变验证输入提交为
`deb274c58f64b6259e89d19a582200182126d770`，对应 `wx` tree 为
`021ed57a0b3b1e876123befad4f375446621fb42`。项目 AppID 为
`wxba597a3f09566936`。

| 官方工具动作     | 历史输入                    | 历史实际返回                                              |
| ---------------- | --------------------------- | --------------------------------------------------------- |
| WXML 编译        | `pages/index/index.wxml`    | 成功，`codeLength=32400`                                  |
| WXSS 编译        | `pages/index/index.wxss`    | 成功，`files=2`（`comm`、`page`），`totalCodeLength=3398` |
| `auto_preview`   | `pages/index/index`         | 成功，整包 `total=11626 bytes`                            |
| 项目窗口生命周期 | 当时工作树的 `/wx`、窗口 s0 | 新开后准确关闭；未调用 `upload`，未发布体验版             |

该历史证据状态保持 **In review**，但其范围已经被当前 `/wx` tree 取代。

## 2026-07-27 历史证据（Taro 三端）

以下自动化仓库检查和运行证据是 2026-07-27 的历史快照。其中关于 Taro 三端、三个平台产物
以及微信虚拟机 App 注册的事实予以保留，但不代表当前 HEAD 的 `/wx` 行为，也不可作为当前
HEAD 已完成微信开发者工具编译或官方预览的证据。

### 自动化仓库检查

| 证据                             | 结果                             | 范围与限制                                                                                                                                                                           |
| -------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `corepack pnpm check` 及其子检查 | 2026-07-27 本地通过              | 工作区契约、格式、代码检查、类型检查、测试和构建均以退出码 0 完成。这是仓库证据，不是托管 CI 执行证据。                                                                              |
| Corepack pnpm 版本门禁           | 本地通过：精确版本 11.17.0       | 验证器通过 Corepack 调用每条 pnpm 命令；解析版本不符时，会在执行其他检查前失败。                                                                                                     |
| 本地基础设施静态契约测试         | 本地通过                         | 只验证 Compose 配置和健康检查解析，不会启动 PostgreSQL/PostGIS 或 Redis。                                                                                                            |
| 容器静态契约测试                 | 本地通过                         | 以文本方式验证固定镜像、非 root 的 `USER node`、构建阶段和运行命令。由于没有 Docker，本地未构建、检查、扫描或运行镜像。                                                              |
| CI 静态契约测试                  | 本地通过                         | 将工作流结构、不可变 Action 固定版本、Gitleaks 调用和 Trivy 门禁作为仓库配置验证；GitHub Actions 尚未执行。                                                                          |
| Phase 0 文档契约测试             | 本地通过                         | 验证必需控制项、负责人角色、证据链接和可审计状态值。                                                                                                                                 |
| 已构建 API 运行冒烟测试          | 本地通过                         | [`smoke-api-runtime.mjs`](../../scripts/smoke-api-runtime.mjs) 使用安全且不可达的连接地址启动构建产物，验证 liveness 200、readiness 503/down、随后 liveness 仍为 200，以及有界关闭。 |
| 管理后台产物冒烟测试             | 本地通过                         | [`smoke-frontend-artifacts.mjs`](../../scripts/smoke-frontend-artifacts.mjs) 通过临时本地 HTTP 服务提供构建产物，并检查状态码、标题和根挂载节点。                                    |
| 小程序产物冒烟测试               | 2026-07-27 历史通过（Taro 三端） | 同一脚本检查三个平台产物，并在虚拟机环境加载微信产物，确认只发生一次 App 注册；这是历史 Taro 证据，官方厂商 GUI 预览仍处于阻断状态。                                                 |
| `pnpm verify:phase-0`            | **按设计阻断**                   | 所有仓库检查按确定顺序执行，最后的依赖审计以非零状态退出；验证器随即停止并返回非零，绝不会报告 Phase 0 已通过。                                                                      |
| `pnpm audit --audit-level high`  | **阻断：2 个严重、11 个高危**    | 当前机器可读且已复核的发现记录在 [`dependency-audit.md`](dependency-audit.md)。不得降低阈值或忽略退出码。                                                                            |

静态契约测试有意安排在聚合的 `pnpm test` 之前：前置测试可在昂贵构建开始前快速失败，
聚合测试则用于证明根级测试契约仍然包含这些测试。

### 运行证据

| 组件         | 已观察证据                                                                                                                                                                             | 状态      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| API 存活检查 | 真实 API 构建进程在未连接数据库时，通过 `/health/live` 返回 HTTP 200。                                                                                                                 | In review |
| API 就绪检查 | 可重复构建产物冒烟测试收到 HTTP 503，响应中 `status: unavailable`，数据库和 Redis 检查均为 `down`；随后 `/health/live` 仍返回 HTTP 200。真实 PostgreSQL/Redis 就绪验证仍属于外部检查。 | Blocked   |
| API 健康路由 | 应用契约和 HTTP 冒烟测试使用根路径 `/health/live` 与 `/health/ready`；健康路由排除在全局 API 前缀之外，因此 `/api/v1/health/live` 与 `/api/v1/health/ready` 返回 404。                 | In review |
| 任务消费者   | 单元测试覆盖配置、启动失败处理、消费者错误和优雅关闭；尚未针对真实 Redis 连续运行十分钟。                                                                                              | Blocked   |
| 管理后台     | 仓库冒烟测试覆盖构建后首页 HTTP 200、预期标题和根节点；尚未在浏览器中执行 React 产物，也未验证正式托管环境。                                                                           | In review |
| 小程序       | 当前 `/wx` tree 的静态检查已通过；官方微信开发者工具编译与预览为 **official validation pending**，Task 8 后重新采集不可变证据。                                                        | Blocked   |
| 容器         | Dockerfile 静态契约验证了 `USER node`；尚未执行 `docker image inspect`、真实构建和非 root 运行检查。                                                                                   | Blocked   |

### 外部运行检查

确定性验证器不会伪造或静默跳过以下门禁：

| 必需门禁                                      | 必须留存的证据                                                                                                                       | 状态        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| Docker Compose PostgreSQL 17/PostGIS 与 Redis | 有界启动日志、`pg_isready`、PostGIS 查询、Redis ping、API readiness 和销毁记录                                                       | Blocked     |
| API 与任务消费者镜像                          | 成功构建记录、不可变镜像摘要、`docker image inspect` 用户、非 root 运行身份、API 探针和任务消费者 Redis 稳定性观察                   | Blocked     |
| GitHub Actions                                | 精确提交对应的托管验证任务链接，并包含 PostgreSQL/Redis 服务证据                                                                     | Not started |
| Gitleaks 与 Trivy                             | 完整历史秘密扫描结果，以及 API/任务消费者镜像扫描报告和摘要                                                                          | Not started |
| 官方微信小程序工具（当前范围）                | 当前 `/wx` 的 **official validation pending**；Task 8 后采集新的输入提交、tree ID、AppID、WXML/WXSS 编译摘要和 `auto_preview` 包大小 | Blocked     |
| 云资源与账号                                  | 环境隔离清单、最小权限账号、KMS/CLS/WAF 证据、域名/ICP备案及支付渠道就绪证据                                                         | Not started |
| 法律、隐私与渗透测试                          | 已批准的处理方条款、隐私/法律签署、支付法律复核及限定范围的渗透测试报告                                                              | Not started |

在依赖审计清零或获得许可且有期限的联合批准例外，并且所有适用外部门禁均已在上线证据索引中
链接不可变证据之前，Phase 0 不得进入 `Accepted（已接受）` 状态。

Status: Draft for pre-production verification
Owner role: Platform Owner
Review cadence: At every launch review and weekly while any launch gate is open

# Phase 0 上线证据索引

状态释义：生产前验证草案
负责人角色：平台负责人
复审周期：每次上线评审时复审；存在未关闭上线门禁期间每周复审

本索引将仓库内的控制契约与必须采集的外部证明关联起来。外部材料保存在受访问控制的证据库中；
其存放位置按类别固定，并在实际执行时获得不可变的运行编号或采集编号。

## 当前上线门禁

| Evidence item                                     | Repository evidence                                                                                                                                                                                                      | External evidence location                                                                                                                   | Status      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 工作区质量检查                                    | [`package.json`](../../package.json)、[`verify-workspace.mjs`](../../scripts/verify-workspace.mjs)                                                                                                                       | 受控证据库：`phase-0/quality/local-check/`                                                                                                   | In review   |
| Docker API 与任务消费者真实镜像构建               | [`apps/api/Dockerfile`](../../apps/api/Dockerfile)、[`apps/worker/Dockerfile`](../../apps/worker/Dockerfile)                                                                                                             | 受控证据库：`phase-0/containers/build/`；WSL2 Docker 运行时验证已完成，但生产镜像构建及相应受控证据尚未归档或审批                            | Blocked     |
| Docker Compose PostgreSQL 与 Redis 就绪验证       | [`compose.yaml`](../../infrastructure/compose.yaml)、[`local-development.md`](../operations/local-development.md)                                                                                                        | 受控证据库：`phase-0/containers/compose/`；WSL2 Docker 运行时验证已完成，但 Compose 运行记录等受控证据尚未归档或审批                         | Blocked     |
| GitHub Actions 托管执行                           | [`ci.yml`](../../.github/workflows/ci.yml)、[`security-gates.md`](../operations/security-gates.md)                                                                                                                       | 受控证据库：`phase-0/ci/github-actions/`                                                                                                     | Not started |
| Gitleaks 完整历史扫描                             | [`ci.yml`](../../.github/workflows/ci.yml)、[`.gitleaks.toml`](../../.gitleaks.toml)                                                                                                                                     | 受控证据库：`phase-0/ci/gitleaks/`                                                                                                           | Not started |
| Trivy API 与任务消费者镜像扫描                    | [`ci.yml`](../../.github/workflows/ci.yml)、[`security-gates.md`](../operations/security-gates.md)                                                                                                                       | 受控证据库：`phase-0/ci/trivy/`                                                                                                              | Not started |
| 微信（WeChat）原生项目编译与官方预览              | [`project.config.json`](../../wx/project.config.json)、[`app.json`](../../wx/app.json)、[`check-wx-project.mjs`](../../scripts/check-wx-project.mjs)、[`phase-0-verification.md`](../operations/phase-0-verification.md) | 受控证据库：`phase-0/miniapps/wechat/`；**official validation pending**；当前 `/wx` tree 尚未完成官方编译与预览，Task 8 后采集新的不可变证据 | Blocked     |
| Dependency audit: 2 critical and 11 high findings | [`dependency-audit.md`](../operations/dependency-audit.md)、[`security-gates.md`](../operations/security-gates.md)                                                                                                       | 受控证据库：`phase-0/security/dependency-audit/`；发布门禁仍以非零状态退出                                                                   | Blocked     |
| 云资源配置控制                                    | [`provisioning-checklist.md`](../../infrastructure/cloud/provisioning-checklist.md)、[`cloudbase-run.md`](../../infrastructure/cloud/cloudbase-run.md)                                                                   | 受控证据库：`phase-0/cloud/`                                                                                                                 | Not started |
| 备份恢复演练                                      | [`backup-restore.md`](../../infrastructure/runbooks/backup-restore.md)                                                                                                                                                   | 受控证据库：`phase-0/runbooks/backup-restore/`                                                                                               | Not started |
| 安全事件演练                                      | [`security-incident.md`](../../infrastructure/runbooks/security-incident.md)                                                                                                                                             | 受控证据库：`phase-0/runbooks/security-incident/`                                                                                            | Not started |
| 合规与处理方评审                                  | [`data-inventory.md`](data-inventory.md)、[`third-party-processing-register.md`](third-party-processing-register.md)、[`retention-policy.md`](retention-policy.md)                                                       | 受控证据库：`phase-0/compliance/`                                                                                                            | Not started |

## 历史与延期的非当前门禁项目

以下项目保留 2026-07-27 Taro 多平台方案的历史引用，但不参与当前微信优先版本的上线判定。

| Historical/deferred item       | Preserved repository reference                                                                                               | Disposition                                                                                                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 微信（WeChat）历史官方工具证据 | [`phase-0-verification.md`](../operations/phase-0-verification.md)                                                           | Historical / Superseded — input `deb274c58f64b6259e89d19a582200182126d770`，wx tree `021ed57a0b3b1e876123befad4f375446621fb42`，AppID `wxba597a3f09566936`；WXML 32400，WXSS 2 files/3398，preview 11626 bytes；不属于当前 `/wx` 上线门禁 |
| 支付宝（Alipay）GUI 预览       | [`config/index.ts`](../../apps/consumer-miniapp/config/index.ts)、[`package.json`](../../apps/consumer-miniapp/package.json) | Deferred — 冻结的 Taro 历史范围，不属于当前 `/wx` 上线门禁                                                                                                                                                                                |
| 抖音（Douyin）GUI 预览         | [`config/index.ts`](../../apps/consumer-miniapp/config/index.ts)、[`package.json`](../../apps/consumer-miniapp/package.json) | Deferred — 冻结的 Taro 历史范围，不属于当前 `/wx` 上线门禁                                                                                                                                                                                |

只有引用控制项中指定的负责人可以提议将状态改为 `Accepted（已接受）`，并且必须由独立复核人
确认相应证据。任何 `Blocked（阻断）` 项都会阻止生产上线，直至问题解决，或由安全门禁中规定的角色
批准有期限且符合要求的例外。

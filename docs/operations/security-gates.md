# 安全与发布门禁

## 当前状态

| 字段           | 值                                                       |
| -------------- | -------------------------------------------------------- |
| 状态           | 已配置，等待 GitHub 首次执行                             |
| Owner          | Engineering Owner                                        |
| Security Owner | Security Owner                                           |
| 发布 Owner     | Security Owner and Platform Owner                        |
| 证据位置       | GitHub Actions 对应提交的运行记录、PR 检查与发布审批记录 |

本仓库已完成门禁配置和本地静态验证，但尚未在 GitHub Actions 实际运行。首次推送后，Engineering Owner 必须确认各任务在托管 Runner 上通过，才能把状态改为“已验证”。

Security Owner and Platform Owner jointly approve production release and security exceptions.

## 阻断规则

| 门禁         | 阻断条件                                                   | Owner             | 必须保存的证据                    |
| ------------ | ---------------------------------------------------------- | ----------------- | --------------------------------- |
| 代码质量     | lint、typecheck、test 或 build 任一失败                    | Engineering Owner | `Verify workspace` 日志及测试报告 |
| 依赖安全     | `pnpm audit --audit-level high` 发现 HIGH 或 CRITICAL 漏洞 | Engineering Owner | 审计日志、升级或缓解说明          |
| 秘密检测     | Gitleaks 命中任何未明确批准的秘密                          | Security Owner    | Gitleaks 日志、秘密轮换记录       |
| 镜像安全     | Trivy 发现 HIGH 或 CRITICAL 且已有修复版本的镜像漏洞       | Engineering Owner | 镜像摘要、扫描日志、修复 PR       |
| 分支保护     | 必需检查未通过、未完成审查或绕过保护规则                   | Platform Owner    | PR 审批与分支保护审计日志         |
| 数据库迁移   | 数据库迁移未经 Engineering Owner 与独立审查者审查          | Engineering Owner | 迁移脚本、回滚方案和审查记录      |
| API contract | API contract 变更未附兼容性说明或破坏性变更方案            | Engineering Owner | 契约 diff、兼容性说明和版本计划   |
| 高风险业务   | 支付、授权或敏感数据变更缺少专项测试及 Security Review     | Security Owner    | 专项测试报告、威胁评审和审批记录  |

所有门禁均为发布阻断项。合并到 `main` 前应在 GitHub 分支保护中把三个 CI jobs 设为必需检查，并要求至少一名非作者审查者批准；生产发布只允许从通过这些检查的不可变提交创建。

Trivy 当前使用 `ignore-unfixed: true`：未修复项不会由镜像扫描 job 直接阻断，但必须由 Engineering Owner 建立有时限的例外/跟踪记录，说明影响、补偿措施、上游修复状态与复审日期；缺少该记录时发布仍被人工门禁阻断。

## 修复 SLA

| 级别                 | 首次响应                   | 修复或批准补偿措施                  |
| -------------------- | -------------------------- | ----------------------------------- |
| CRITICAL、已泄露秘密 | 立即停止发布，1 小时内响应 | 24 小时内完成；秘密须立即吊销并轮换 |
| HIGH                 | 1 个工作日内响应           | 7 个自然日内完成                    |
| 质量门禁失败         | 当次 PR 内响应             | 合并前完成                          |

SLA 从 CI 首次报告或人工发现的较早时间开始计算。超过 SLA 的事项自动升级给 Engineering Owner、Security Owner 和 Platform Owner，并持续阻断发布。

## 例外流程

例外不是跳过检查。申请人必须建立可审计记录，并填写：

- 具体命中、影响范围和风险说明；
- 单一负责 Owner、批准人以及最长不超过 7 天的到期时间；
- 可验证的补偿措施、修复计划和关联工单；
- 到期前的复审日期，以及撤销例外的判定条件。

Security Owner 与 Platform Owner 必须共同批准例外和生产发布。已泄露秘密、可被利用的 CRITICAL 漏洞以及 lint/typecheck/test/build 失败不得获得发布例外。例外到期后自动失效；未完成复审或修复时继续阻断发布。

## 运行与证据保留

每次 PR 和 `main` 推送执行质量、秘密与 API/Worker 容器门禁。Platform Owner 在发布清单中记录提交 SHA、三个 CI 运行链接、审批人和例外记录。GitHub Actions 日志及相关报告至少保留 180 天；若平台默认保留期更短，应将报告复制到受访问控制的发布证据库。

Dependabot 每周检查 npm 依赖、每月检查 GitHub Actions。第三方 Action 固定到完整 commit SHA，Dependabot PR 经上述全部门禁后才能合并。

Dependabot 不会追踪工作流 `run` 命令中内嵌的 Gitleaks 容器。当前可读版本证据为 `v8.30.1`。Security Owner 至少每月核验 Gitleaks 上游最新稳定 tag，通过 GHCR Registry API 核验对应 manifest digest，更新可读版本证据和工作流 digest，并在安全维护记录中留证；更新 PR 必须通过完整历史秘密扫描和全部发布门禁。

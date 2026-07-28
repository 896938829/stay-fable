# Stay Fable Agent Workflow

## 开始工作前

1. 阅读本文件和当前任务涉及的技能说明。
2. 执行 `git status --short` 和 `git worktree list`，不得覆盖未提交修改。
3. 从 `dev` 创建 `codex/<feature>` 分支；`release` 和 `main` 不直接开发。

## 客户端边界

- `/wx` 是唯一正式用户端。
- `apps/consumer-miniapp` 是冻结的 Taro 多平台参考工程，不进入默认开发和构建门禁。
- 微信任务按需使用 wechatide 技能：initializer（环境/登录/打开）、compiler（编译/刷新）、previewer（手机预览）、automator（交互验收）、debugger（日志/网络/截图诊断）、project-config（项目配置）。
- 每个微信功能至少完成静态检查和微信开发者工具编译；用户闭环还需预览或自动化验收。

## WSL2 后端验证

- 默认 Ubuntu-22.04；后端实机验证使用其中 Docker Engine。
- 不得停止或删除无关容器。
- 默认端口占用时使用 POSTGRES_PORT=55432 和 REDIS_PORT=56379。
- 验证 PostgreSQL/PostGIS、Redis、API /health/live、/health/ready 和 Worker。
- API 与 Worker 必须非 root 且只读根文件系统。
- Worker 至少观察 10 分钟，重启 0 且无重连循环。
- 结束时删除临时容器/产物，Compose 数据卷默认保留。
- 详细命令见 docs/operations/wsl-runtime-validation.md。

## 质量与漏洞

- dev 阶段运行格式、lint、类型检查、测试、构建和漏洞报告。
- dev 已知依赖漏洞只报告、不阻断功能开发。
- release/main 阻断未修复 Critical/High，除非有批准人、到期日和缓解措施的风险例外。
- 完成前执行与修改范围相称的全量验证，不依赖历史结果。

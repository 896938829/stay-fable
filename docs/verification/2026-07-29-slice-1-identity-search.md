# Slice 1：身份与搜索上下文验证

验证日期：2026-07-29（Asia/Shanghai）

范围：原生微信小程序 `/wx`、PostgreSQL/PostGIS、Redis、NestJS API 和 Worker。
官方工具验证输入提交：
`7e94919d75dcc0632680dd6579f6323b773d14e3`；对应 `/wx` tree：
`2f730705c43e451a8508e4edaa048a32ad3a6e37`。验证后仅更新本证据文档和证据图片，
不再修改 `/wx` tree。

## 结论

Slice 1 的仓库检查、微信官方编译、除真实定位拒绝外的核心页面自动化、官方预览以及
WSL2 后端实机验证均已通过。真实定位拒绝仍需在开发者工具授权面板完成一次人工验收，
因此本记录不宣称 Slice 1 已完整验收。公众平台后台的隐私保护指引声明也是独立外部门禁；
仓库配置和本地验证不能替代该声明，当前结果不代表可提交生产审核。

## 微信开发者工具

- wechatide 工具版本：`0.3.5`
- 微信开发者工具：`2.02.2607271`
- 调试基础库：`3.17.0`
- 最终官方编译时间：2026-07-29 08:34（Asia/Shanghai）
- `pages/home/home`、`pages/city-select/city-select`、
  `pages/date-guest-select/date-guest-select` 的 WXML 与 WXSS 共六项官方编译成功。
  三项 WXML 均返回 `codeLength=32400`；三项 WXSS 均返回 `files=2`、
  `totalCodeLength=6327`。
- 整页打开 `pages/home/home` 成功，修正后的标准导航配置不再触发 Skyline
  `10009` 错误。
- 最终页面打开后，console 与 network 缓冲区按
  `error|fail|exception|10009|41002`、HTTP 4xx/5xx 条件检索均无命中。
- 核心自动化通过：默认入住/离店日期与 2 位住客、真实 API 城市列表、选择杭州、
  修改为 2026-07-31 至 2026-08-02（2 晚）和 3 位住客、保存后首页状态保持。
- 清空内存 access token 后再次请求城市列表成功，同一用户身份保持且 access/refresh
  token 均重新产生，验证了 `401 -> refresh -> replay`。
- 会话令牌和微信登录码仅在内存中使用，未写入同步存储、证据或日志。

自动化脚本：
[`wx/automator/slice-1-identity-search.js`](../../wx/automator/slice-1-identity-search.js)

页面截图：
[`2026-07-29-slice-1-home.jpg`](evidence/2026-07-29-slice-1-home.jpg)

官方预览二维码：
[`2026-07-29-slice-1-preview.png`](evidence/2026-07-29-slice-1-preview.png)

共享项目 AppID `wxba597a3f09566936` 在当前登录账户下返回 `41002 appid missing`。
预览使用该账户可管理的测试小程序 AppID `wxbef269cd06ff29d4` 临时覆盖
`project.private.config.json` 后生成；生成后已精确恢复私有配置，共享
`project.config.json` 未改写。最终预览包为 57,559 bytes，未调用上传或发布体验版。

### 定位拒绝边界

微信自动化桥接层无法把 `wx.getLocation` 的回调或 Promise 拒绝传入当前模拟器，
本次调用在 8 秒有界超时后正确回退到手动选城页
`city-select?reason=location_timeout`。定位拒绝、API 不可用和超时到手动选城的映射
由单元测试覆盖；本记录不把工具桥接限制描述为真实拒绝场景已自动化通过。

可重复的人工验收步骤：

1. 在项目窗口关闭时执行
   `wechatide -c Codex debug_clear_cache --project <当前 worktree 的 wx 绝对路径> --action clearAuth`。
2. 重新打开首页，点击“使用当前位置匹配已开通城市”，在用途弹窗选择“继续定位”。
3. 在开发者工具的授权提示或授权设置面板中将“位置信息”设为拒绝。
4. 确认页面显示安全提示并进入
   `pages/city-select/city-select?reason=location_denied`，随后仍可选择杭州继续。
5. 将页面截图与当前提交、wx tree ID 一并归档后，才可关闭该验收项。

## WSL2 后端实机验证

执行命令：

```powershell
powershell -NoProfile -File scripts/wsl-runtime-validation.ps1
```

基线流程连续完成两次；加入原子 Docker 锁并完成审查后，又对输入提交
`7e94919d75dcc0632680dd6579f6323b773d14e3` 完整复验一次。最终运行确认数据库迁移
幂等、锁所有权和清理边界：

- 首次应用 `202607290001_identity_location`、
  `202607290002_user_session_version`、
  `202607290003_session_version_monotonic`；第二次返回无待执行迁移。
- 两次均完成种子数据，PostGIS 3.5 查询成功，Redis 返回 `PONG`。
- `/health/live` 与 `/health/ready` 均返回 HTTP 200。
- API 和 Worker 均为 `user=node`、只读根文件系统。
- 身份隔离、杭州/贵阳种子城市、PostGIS 定位解析、刷新令牌轮换和旧令牌重放拒绝
  冒烟测试全部通过。
- 三次 Worker 观察均完成 10/10 分钟，始终
  `Running=true RestartCount=0`，未发现致命错误或重连循环。
- 三次均输出 `SLICE1_RUNTIME_CLEANUP_COMPLETE`；最终运行还确认锁容器、API/Worker、
  Compose 容器、网络和 `.wsl-runtime` 均已按所有权清理。既有无关
  `rims-postgres` 容器未被停止或修改。

流程说明：
[`wsl-runtime-validation.md`](../operations/wsl-runtime-validation.md)

## 门禁结果与待完成项

- 质量门禁（`pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、
  `pnpm build`、`pnpm wx:check`）均以退出码 0 完成；`pnpm test:wx` 的 11 个文件、
  160 项测试通过。
- 路线图写有尚未在根包定义的 `pnpm audit:report` 别名，本次使用仓库与 CI 的规范命令
  `pnpm audit --audit-level high`。命令按设计以退出码 1 报告 29 项漏洞：
  2 个严重、11 个高危、14 个中危、2 个低危；发布结论保持阻断，详见
  [`dependency-audit.md`](../operations/dependency-audit.md)。
- 在微信公众平台后台声明定位信息用途并留存审核证据。
- 正式上线前仍需真实微信身份、HTTPS 合法域名、密钥管理及生产监控证据。

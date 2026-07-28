---
name: installer
description: >-
  检查、下载或更新微信开发者工具。识别未安装、wechatide CLI 不可用、NW.js 版及过低的 Electron
  版本并强制进入更新流程；也处理 agent_ahead 后出现的明确版本兼容 blocker。支持手动或主动下载。
---

# installer

本 scene 负责更新提醒、获取安装包和安装指引，不调用 `wechatide` 业务工具。安装缺失或不兼容时无需执行根 SKILL 的可用状态检查。

安装诊断结果处理 → **只读** [运行前检查](../../references/environment-readiness.md)，本文不复述细则。

## 选包决策（先看这里）

```text
用户要「手动下载」？
  → 打开官方下载页，不跑解析脚本
否则，兼容修复？（下列任一）
  · 已装但仍 mustEnterInstaller（NW.js / Electron 过旧 / CLI 不可用等）
  · agent_ahead 后出现明确工具/参数兼容 blocker
  · 已是稳定版或 RC 仍不兼容，且用户同意为兼容而更新
  → --channel latest（只选 Nightly，末位 2）
否则，用户原话要「最新开发版 / 开发版 / Nightly / 最新版」？
  → --channel latest
否则（只说下载 / 安装 / 更新 / 稳定版）
  → --channel stable（末位 0→1→2 选满足门槛的最大版本）
```

兼容修复硬约束：

- **禁止**把「继续用当前 RC + 开 CLI 端口」说成与升级对等
- **禁止**在已装 RC 仍不兼容时让用户在 RC / Nightly 间二选一；应直接建议 Nightly，用户拒绝再保留 blocker
- 所有渠道只下载版本号**严格大于** `install-root.mjs` 的 `MIN_COMPATIBLE_VERSION`（以该常量为准）；macOS 只允许 `.pkg`

版本末位：`0` 稳定、`1` RC、`2` Nightly。不要猜测或拼接未在官方下载配置中出现的链接。

## 触发条件

以下任一进入本 scene：

- 用户要求下载、安装或更新
- **`wechatide` 调用不了**，经 `check-installation.mjs` 诊断后需安装或更新
- 诊断结果为 NW.js、Electron 版本过低、或 `cli_unavailable` 等 `mustEnterInstaller: true`
- `versionRelation: agent_ahead` 且后续因工具/参数不受支持等**明确兼容 blocker**无法继续

**不要**在业务会话开头主动跑安装检查。进入后不要重复 `check_wechatide_status`（安装完成前也无需根 SKILL 可用状态门禁）。

## 安装状态检查

```bash
node skills/installer/scripts/check-installation.mjs
# 非默认安装路径：
node skills/installer/scripts/check-installation.mjs --install-root "<安装目录>"
```

检查顺序：定位安装目录 → NW.js 标记 → Electron `version` → PATH / 安装目录 `wechatide` → 版本达标且 CLI 可用才 `compatible: true`（成功时带 `command`）。结果处理见 [运行前检查](../../references/environment-readiness.md)。

## 主动下载

脚本只依赖 Node 内置模块，在本 skill 目录执行：

```bash
# 日常
node skills/installer/scripts/resolve-download.mjs --channel stable --url-only
# 兼容修复 / 用户要 Nightly
node skills/installer/scripts/resolve-download.mjs --channel latest --url-only
```

脚本：拉官方下载页与配置 → 只接受规定前缀 → 按本机筛选并排除不大于门槛的包 → `stable` 按末位 `0→1→2`，`latest` 只选末位 `2` → `download_redirect` 的 `from` 改为 `skillauto`；macOS 探测重定向，非 `.pkg` 则跳过。

| 系统 | 架构 | `type` |
|------|------|--------|
| macOS | Apple Silicon / arm64 | 优先 `darwin_arm64`，兼容 `darwin_arm` |
| macOS | Intel / x64 | `darwin_x64` |
| Windows | x64 / x86 | `win32_x64` / `win32_ia32` |

拿到 URL 后切到目标目录（默认系统 Downloads）下载：

```bash
curl --fail --location --remote-header-name --remote-name "<resolvedUrl>"
```

报告安装包绝对路径、版本、渠道、架构。用户只要求下载时不要自动运行安装包；明确要求安装/更新时再启动并说明系统确认。

## 手动下载

打开 `https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html`。按本机选 macOS Apple Silicon / Intel 或 Windows x64；macOS 只选 `.pkg`。选包规则同上方决策树。无法开浏览器时返回可点链接并写清系统、架构、版本。

## 安装后与 agent_ahead

下载完成后提示退出正在运行的开发者工具，再覆盖安装。不要因本机已有旧版就降低目标版本；兼容修复不要再解析出同级或更旧的 RC。

`agent_ahead` / 明确兼容 blocker：先确认失败确实与旧版缺工具/参数/能力相关 → 引导 Nightly → 用户同意后下载；暂不更新则保留**具体**兼容问题作 blocker，不要只写 `agent_ahead`。

不得把 agent 侧 skill 写回安装目录；对齐只能从新安装目录的 `skillPath` 单向导入。

安装后重跑 `check-installation.mjs`；仅 `compatible: true` 后再做根 SKILL 可用状态检查（`check_wechatide_status`），确认 `loginExpired: false` 后回原业务 scene 重试一次。CLI 仍不存在则按 [运行前检查](../../references/environment-readiness.md) 定位 PATH（勿循环下载）。

## 失败处理

- 页面/脚本/下载配置失败，或无合格安装包 / 无对应架构链接 / macOS 全非 `.pkg`：转手动下载并说明原因
- `channel` 非法：修正后重试一次
- 链接不是规定前缀：拒绝下载
- 下载中断：保留错误，允许重试；勿把部分文件称为成功包
- Linux 等无桌面包平台：只给官方下载页，勿选 Win/mac 包

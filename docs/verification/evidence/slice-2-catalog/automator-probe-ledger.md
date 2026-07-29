# Slice 2 Automator 探针台账

运行窗口：2026-07-30（Asia/Shanghai）；精确开始和结束时间未保留。
性质：retrospective sanitized run ledger（回顾性脱敏运行台账）。

## 证据边界

本台账只记录交接中保留下来的已知、去敏事实。失败探针的临时页面 tree、PNG、raw logs 和其他
临时产物已按安全要求清理且未保留，因此本台账不是原始不可变证据。它只支持
`BLOCKED_BY_RC_AUTOMATOR` 的分类，不能关闭 Automator 或物理交互门禁，也不能证明业务页面的
物理 tap 失败。

Task 12 原有的两张官方诊断 PNG 不属于后续探针输出，仍由
[Slice 2 主验证记录](../../2026-07-29-slice-2-catalog.md) 单独引用。

## 工具与代码基线

| 项目                                       | 已保留事实                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 微信开发者工具                             | RC `2.02.2607271`                                                                          |
| Automator                                  | `miniprogram-automator@0.12.1`                                                             |
| WechatIDE bridge/MCP                       | `0.3.5`                                                                                    |
| Node.js                                    | 24；精确补丁版本未作为探针事实保留                                                         |
| `087ea5cc7144ed8656c9275162ce48901e79f934` | Windows cold-start CLI 适配，以及 fixture/restore 在 runtime 内通过 JSON 重建 plain object |
| `663532e9412b73879307258c22746211a6393cb5` | 在 Automator runtime 内分发正式 `openProperty` handler                                     |
| `247fc9c92c7fc6dccc363445852a230b72d0420f` | 要求 launcher cleanup 到达 terminal 状态并补充边界测试                                     |

对应仓库文件：

- [Catalog Automator](../../../../wx/automator/slice-2-catalog.js)
- [Catalog Automator tests](../../../../wx/tests/catalog-automator.test.js)

## 可复制入口

设置本机 `WECHAT_DEVTOOLS_CLI` 环境变量后，可从仓库根目录用以下命令创建一次新的主流程运行。
环境变量的实际值未写入本台账；新运行会产生新的结果，不能恢复已清理的 2026-07-30 原始输出。

```powershell
$repo = (Resolve-Path -LiteralPath ".").Path
$wxPath = (Resolve-Path -LiteralPath (Join-Path $repo "wx")).Path
$scriptPath = (Resolve-Path -LiteralPath (Join-Path $wxPath "automator/slice-2-catalog.js")).Path
$evidenceParent = (Resolve-Path -LiteralPath (Join-Path $repo "docs/verification/evidence/slice-2-catalog")).Path
$cliPath = (Resolve-Path -LiteralPath $env:WECHAT_DEVTOOLS_CLI).Path
node $scriptPath $wxPath $evidenceParent --cli-path $cliPath
```

仓库内的兼容和 cleanup 行为可用以下命令重新审计：

```powershell
$repo = (Resolve-Path -LiteralPath ".").Path
$testPath = (Resolve-Path -LiteralPath (Join-Path $repo "wx/tests/catalog-automator.test.js")).Path
$scriptPath = (Resolve-Path -LiteralPath (Join-Path $repo "wx/automator/slice-2-catalog.js")).Path
corepack pnpm exec vitest run $testPath
corepack pnpm exec prettier --check $scriptPath $testPath
git show --stat --oneline 247fc9c92c7fc6dccc363445852a230b72d0420f
git diff --check 663532e9412b73879307258c22746211a6393cb5 247fc9c92c7fc6dccc363445852a230b72d0420f -- wx/automator/slice-2-catalog.js wx/tests/catalog-automator.test.js
```

这些命令审计仓库代码，不重建已清理的真实探针证据，也不单独关闭 Slice 5 门禁。

## 已保留观察

Automator 探针的安全终态分类为退出码 1。已保留的 step 边界是：cold-start `launch` 已越过，
`property-list` 已到达，导航未完成；精确 terminal `step` 字符串和完整安全输出未保留，本文不
补写或推断。

| 探针动作                        | 已保留观察                                      |
| ------------------------------- | ----------------------------------------------- |
| `property-list` 检查            | 正式页面 API、data 和第一家旅店 UUID 可达       |
| shadow `Element.tap()`          | 调用返回，未观察到 property card 导航           |
| `CustomElement.callMethod()`    | 调用正式 handler 后未观察到导航                 |
| `Page.callMethod()`             | 调用正式 handler 后未观察到导航                 |
| runtime evaluate                | 调用正式 `openProperty()` 后未观察到导航        |
| 官方 `miniprogram.navigateTo()` | 使用编码后的详情页 URL，等待 Automator 响应超时 |

WechatIDE MCP `fullMode` 探针在登录步骤观察到 network status 0，API 无入站。临时将 `urlCheck`
设为 `false` 并重新打开项目后现象不变；配置随后按探针前文件 SHA 精确恢复，但具体 SHA 值未写入
本台账。该路径未到达 property tap，结论只能是 **INCONCLUSIVE**，不能登记为 MCP tap 失败。

## 归纳与门禁

上述观察支持“RC legacy Automator 交互/导航分发不可靠”的 blocker 分类，但没有保留足以确认
完整根因的原始材料。完整 Automator 主流程仍是 Slice 5 的主要门禁；人工开发者工具或手机上的
真实物理 tap 是必须的补充证据，不自动替代 Automator。

若工具仍阻断，只有包含批准人、到期日、缓解措施和修复跟踪的正式例外才能替代 Automator 结果。
当前不存在该例外；允许开始 Slice 3 功能开发不是发布豁免。

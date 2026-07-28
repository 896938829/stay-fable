---
name: automator
description: >-
  小程序/小游戏页面自动化：点击、输入、滚动、导航、断言、生成 automator 脚本。
  用户要点按钮、填表、页面验证、自动化测试时使用。不负责 console/network 深度排查。
---

# automator

## 用途

在当前项目内做确定性 UI 操作与验证。

## 工作流

1. 解析目标流程 → 导航/交互 → 采集证据 → pass/fail 摘要
2. 「等 → 再点/再跳」用工具自带 `waitForSelector` / `wait`，不要拆成单独等待 tool
3. 不确定选择器时，先 `automation_page_action`（`querySelectorAll`）

## 意图 → 工具

| 意图 | 工具 |
|------|------|
| 页面导航 | `automation_navigate` |
| 点击/输入/长按/读文本/样式/触摸 | `automation_element_action`（必须带 `selector`） |
| 读/写 page data、querySelector、callMethod | `automation_page_action` |
| 页面滚动；写入自动化脚本的截图 | `automation_viewport_action`（`pageScrollTo` / `screenshot`；截图**主归属本 scene**；不传 `path` 返回临时文件路径） |
| 模拟器完整 UI 截图（含 toast 等） | debugger 的 `simulator_screenshot`（勿与上项混用） |
| 运行时页栈/当前页 | `automation_runtime_info`（主归属 initializer，此处只读） |
| 执行受控表达式 | `automation_evaluate` |
| 调用/mock wx API | `automation_wx_api`（主归属 debugger；此处限流程内 mock/调用） |
| 测试号 / ticket | `automation_testaccount` |
| 生成脚本草稿 | `automation_generate_script`（生成后需人工检查） |

参数与动作枚举：`wechatide -c <clientName> <tool> --help`。

## 关键示例

```bash
wechatide -c <clientName> automation_element_action --project <project> --selector button --action tap --wait-for-selector button
wechatide -c <clientName> automation_element_action --project <project> --selector input --action input --value hello
wechatide -c <clientName> automation_page_action --project <project> --action querySelectorAll --selector button
wechatide -c <clientName> automation_viewport_action --project <project> --action screenshot --path <localOutputPath>
```

## 重要边界

- **元素交互**只用 `automation_element_action`，不是 `automation_viewport_action`
- `automation_viewport_action` **不支持** tap/input
- timeout：记录步骤 → 尽量补当前页/元素/最后成功动作证据 → 不要在本 scene 盲目扩恢复路径

调用前须已由根入口完成登录检查；项目窗口未开时先经 initializer。

## 失败快表

| 情况 | 处理 |
|------|------|
| 窗口未开 / `PROJECT_*` | initializer 开窗；配置错误见 [project-tool-error-guide.md](../../wechatide-tools/references/project-tool-error-guide.md) |
| timeout / 找不到元素 | 记录步骤与当前页；`querySelectorAll` 核对选择器；**不要**盲目加长 wait 死循环 |
| 需要 console/network 归因 | 移交 debugger，带上复现步骤与选择器 |
| User denied（测试号等） | 停等；勿自动重试破坏性动作 |

## 移交

| 目标 | 还需 |
|------|------|
| debugger | 失败步骤、currentPage、selector、已采集截图路径 |
| compiler | 需重新编译的页面 |
| 结束 | pass/fail 摘要与关键证据 |

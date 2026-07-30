# 依赖审计证据

审计日期：2026-07-30。执行命令：

Current audit summary: 0 CRITICAL, 3 HIGH, 2 MODERATE, 0 LOW
Current production audit summary: 0 CRITICAL, 2 HIGH, 1 MODERATE, 0 LOW
Current release conclusion: Blocked

当前完整审计摘要：0 个严重、3 个高危、2 个中危、0 个低危
当前生产依赖审计摘要：0 个严重、2 个高危、1 个中危、0 个低危
当前发布结论：阻断

```text
pnpm audit --json
pnpm audit --prod --json
pnpm audit --audit-level high
pnpm audit --prod --audit-level high
```

## Batch 1 工作区边界结果

- 历史基线（2026-07-27）：30 项，2 CRITICAL、11 HIGH、15 MODERATE、2 LOW。
- 历史当前值（2026-07-29）：29 项，2 CRITICAL、11 HIGH、14 MODERATE、2 LOW。
  当时直接依赖 `webpack` 仍受 Taro 精确 peer 约束；传递依赖从
  `GHSA-hmx5-qpq5-p643` 开始，另含 `GHSA-mp2f-45pm-3cg9`、
  `GHSA-8jmw-wjr8-2x66`、`GHSA-c96f-x56v-gq3h`、`GHSA-pm4m-ph32-ghv5` 和
  `GHSA-mh99-v99m-4gvg`。其中 brace-expansion 命中 34 条路径（16 条非开发、18 条开发），
  旧父依赖范围内无兼容修复。本段仅保留历史可审计基线，不是当前计数。
- `apps/consumer-miniapp` 的冻结源码和 `package.json` 继续保留，但
  `pnpm-workspace.yaml` 通过显式否定模式将其排除在活动 workspace 之外。
- 重新执行 `pnpm install --lockfile-only` 后，`pnpm-lock.yaml` 不再包含
  `apps/consumer-miniapp` importer、`@tarojs/*` 包或 `babel-preset-taro`。
- 相对 2026-07-29 的旧锁文件证据，Taro 链带来的 2 个严重、8 个高危、12 个中危和
  2 个低危公告已从活动依赖图移除。该变化是工作区边界收缩，不是删除冻结参考源码。
- 本次完整审计实际返回 5 个公告：3 个高危、2 个中危；生产依赖审计实际返回
  3 个公告：2 个高危、1 个中危。两次命令均因现存公告以非零状态退出。

“修复可用性”分为“安全公告给出修复版本”和“当前父依赖范围内可兼容安装”。只有后者才允许
直接升级或添加精确版本覆盖；不会关闭严格的对等依赖校验，也不会把新主版本强推给旧父包。

## 当前高危精确阻断项

| 安全公告              | 审计范围       | 已安装路径                                                                              | 公告修复／当前约束                                           | 建议                                                              |
| --------------------- | -------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| `GHSA-c96f-x56v-gq3h` | 完整、生产依赖 | `apps__api-server>{@prisma/client>prisma,prisma}>@prisma/dev>find-my-way@9.6.0`         | 修复版本 `>=9.6.1`；`@prisma/dev` 精确依赖 9.6.0，无兼容修复 | 跟踪 Prisma 发布；确认开发工具为何进入生产依赖图并在 Batch 2 处理 |
| `GHSA-pm4m-ph32-ghv5` | 完整、生产依赖 | `apps__api-server>@nestjs/swagger>js-yaml@5.2.1`                                        | 修复版本 `>=5.2.2`；`@nestjs/swagger` 精确依赖 5.2.1         | 阻断发布或取得有时限例外；在 Batch 4 升级 Nest Swagger            |
| `GHSA-mh99-v99m-4gvg` | 仅完整审计     | `apps__api-server>@nestjs/cli>fork-ts-checker-webpack-plugin>minimatch>brace-expansion` | 修复版本 `>=5.0.8`；旧父链限制旧版本，无兼容修复             | 开发依赖仍计入 release 门禁；在 Batch 3 升级 Nest CLI 工具链      |

完整机器可读路径以同一提交执行 `pnpm audit --json` 为准。完整审计另外保留两个中危公告：
`phin`（经根级 `miniprogram-automator`，42 条路径）和 `valibot`（经 Prisma，2 条路径）；
其中生产依赖审计仅保留 `valibot`。

## 发布结论

`pnpm audit --audit-level high` 和 `pnpm audit --prod --audit-level high` 当前均以非零状态退出，
依赖安全门禁保持阻断。不得降低阈值或忽略退出码。Batch 1 已消除冻结 Taro 工程对活动依赖图
和默认验证图景的影响，但没有解除 API 工具链的 3 个高危公告；下一步依次在 Batch 2 处理
Prisma、Batch 3 处理 Nest CLI、Batch 4 处理 Nest Swagger，并重新运行相应测试、完整审计和
生产依赖审计。

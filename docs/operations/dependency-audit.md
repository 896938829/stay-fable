# 依赖审计证据

审计日期：2026-07-31。执行命令：

Current audit summary: 0 CRITICAL, 1 HIGH, 1 MODERATE, 0 LOW
Current production audit summary: 0 CRITICAL, 1 HIGH, 0 MODERATE, 0 LOW
Current release conclusion: Blocked

当前完整审计摘要：0 个严重、1 个高危、1 个中危、0 个低危
当前生产依赖审计摘要：0 个严重、1 个高危、0 个中危、0 个低危
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

## Batch 2 Prisma 统一补丁结果

- `@prisma/adapter-pg`、`@prisma/client` 和 `prisma` 已从精确版本 `7.9.0` 统一升级到
  `7.9.1`，锁文件只更新该补丁版本及其传递依赖图。
- Prisma 的 `@prisma/dev` 现在解析到 `find-my-way@9.7.0` 和 `valibot@1.4.2`；
  完整与生产审计均不再报告 `find-my-way` 的 `GHSA-c96f-x56v-gq3h`，也不再报告
  `valibot` 公告。
- 本批次完整审计实际返回 3 个公告：0 CRITICAL、2 HIGH、1 MODERATE、0 LOW；
  生产依赖审计实际返回 1 个公告：0 CRITICAL、1 HIGH、0 MODERATE、0 LOW。
  两个 `--audit-level high` 门禁仍因 Batch 3/4 阻断项以非零状态退出。
- 已解除的高危项保留如下作为批次追踪记录，不属于当前阻断项：

| 已解除安全公告        | 批次    | 原安装路径                                                                              | 修复证据                                                          |
| --------------------- | ------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `GHSA-c96f-x56v-gq3h` | Batch 2 | `apps__api-server>{@prisma/client>prisma,prisma}>@prisma/dev>find-my-way@9.6.0`         | Prisma `7.9.1` 解析到 `find-my-way@9.7.0`，当前审计不再包含该公告 |
| `GHSA-mh99-v99m-4gvg` | Batch 3 | `apps__api-server>@nestjs/cli>fork-ts-checker-webpack-plugin>minimatch>brace-expansion` | 移除 Nest CLI 构建工具链后，当前审计不再包含该公告                |

“修复可用性”分为“安全公告给出修复版本”和“当前父依赖范围内可兼容安装”。只有后者才允许
直接升级或添加精确版本覆盖；不会关闭严格的对等依赖校验，也不会把新主版本强推给旧父包。

## 当前高危精确阻断项

| 安全公告              | 审计范围       | 已安装路径                                       | 公告修复／当前约束                                   | 建议                                                   |
| --------------------- | -------------- | ------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------ |
| `GHSA-pm4m-ph32-ghv5` | 完整、生产依赖 | `apps__api-server>@nestjs/swagger>js-yaml@5.2.1` | 修复版本 `>=5.2.2`；`@nestjs/swagger` 精确依赖 5.2.1 | 阻断发布或取得有时限例外；在 Batch 4 升级 Nest Swagger |

完整机器可读路径以同一提交执行 `pnpm audit --json` 为准。完整审计另外保留一个中危公告：
`phin`（经根级 `miniprogram-automator`，42 条路径）；生产依赖审计不再包含中危公告。

## Batch 3 Nest CLI 工具链移除结果

- API 构建从 `nest build` 改为固定目标清理后执行
  `tsc -p tsconfig.build.json`，开发监听改用工作区已有的 `tsx watch`。
- `@nestjs/cli`、`nest-cli.json` 及其
  `fork-ts-checker-webpack-plugin > minimatch > brace-expansion` 旧链已从活动依赖图移除。
- 构建清理器不接受命令行路径，只允许
  `apps/api-server/dist`；测试覆盖 workspace root、其他目录和额外参数拒绝。
- 两次连续 API 构建均成功，第二次构建会删除预先写入 `dist` 的陈旧 sentinel，同时重新生成
  `dist/main.js`。
- 本批次完整审计实际返回 2 个公告：0 CRITICAL、1 HIGH、1 MODERATE、0 LOW；
  生产依赖审计实际返回 1 个公告：0 CRITICAL、1 HIGH、0 MODERATE、0 LOW。
  `GHSA-mh99-v99m-4gvg` 已消失，现存 High 仅为 Batch 4 的 Swagger 上游阻断。

## 发布结论

`pnpm audit --audit-level high` 和 `pnpm audit --prod --audit-level high` 当前均以非零状态退出，
依赖安全门禁保持阻断。不得降低阈值或忽略退出码。Batch 1 已消除冻结 Taro 工程对活动依赖图
和默认验证图景的影响，Batch 2 已解除 Prisma 的高危与中危公告，Batch 3 已移除 Nest CLI
开发工具链高危公告；当前仅由 Batch 4 的 Nest Swagger 生产链保留一个高危公告。在上游发布
兼容 Nest 11 的安全 stable 版本或取得正式风险例外前，release/main 不得放行。

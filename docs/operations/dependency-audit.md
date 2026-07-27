# 依赖审计证据

审计日期：2026-07-27。执行命令：

```text
pnpm audit --json
pnpm audit --audit-level high
```

## 结果与分类

- 基线：30 项，含 2 CRITICAL、11 HIGH、15 MODERATE、2 LOW。
- 当前：29 项，含 2 CRITICAL、11 HIGH、14 MODERATE、2 LOW。
- 已修复：直接依赖 `yaml` 从 2.8.1 升至 2.8.3，消除对应的 MODERATE 命中。
- 直接依赖剩余：`webpack@5.91.0` 涉及 1 MODERATE、2 LOW。安全版本存在，但 Taro 4.2.1 的 loader、prebundle、runner 都把 peer 精确限制为 5.91.0；试升 5.104.1 被 `strictPeerDependencies` 拒绝，因此 fixAvailable（兼容）为否。
- 传递依赖剩余：2 CRITICAL、11 HIGH、13 MODERATE。HIGH/CRITICAL 均无可在父依赖声明范围内应用的兼容修复。

这里的 fixAvailable 分为“公告给出修复版本”和“当前父依赖范围内可兼容安装”。只有后者才允许直接升级或添加精确 override；不会关闭严格 peer 校验，也不会把新主版本强推给旧父包。

## HIGH/CRITICAL 精确阻断项

| Advisory                                     | 严重度   | 已安装路径                                                                                                                                   | 公告修复/Registry 状态                                 | fixAvailable（兼容）                                   | 建议                                                              |
| -------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------- |
| `GHSA-hmx5-qpq5-p643`                        | CRITICAL | `apps__consumer-miniapp>@tarojs/components>swiper@11.1.15`（另一路经 `@tarojs/taro`）                                                        | `>=12.1.2`，已发布                                     | 无兼容修复；Taro 精确依赖 11.1.15，跨主版本            | 阻断发布；升级支持 Swiper 12 的 Taro 后重测三端                   |
| `GHSA-mp2f-45pm-3cg9`                        | CRITICAL | `apps__consumer-miniapp>@tarojs/cli>download-git-repo>download>decompress@4.2.1`                                                             | 公告称 `>=4.2.2`，Registry 尚未发布 4.2.2              | 无兼容修复                                             | 跟踪上游发布；CLI 不处理不可信归档                                |
| `GHSA-8jmw-wjr8-2x66`                        | HIGH     | `apps__consumer-miniapp>@tarojs/cli>download-git-repo>git-clone@0.1.0`                                                                       | 公告称 `>=0.2.1`，Registry 尚未发布 0.2.1              | 无兼容修复；父包要求 `^0.1.0`                          | 禁止 CLI 克隆不可信地址；等待 Taro/下载器升级                     |
| `GHSA-rc47-6667-2j5j`                        | HIGH     | `apps__consumer-miniapp>@tarojs/cli>download-git-repo>download>got>cacheable-request>http-cache-semantics@3.8.1`                             | `>=4.1.1`，已发布                                      | 无兼容修复；跨主版本                                   | 等待 download/got 链升级                                          |
| `GHSA-pfq8-rq6v-vf5m`                        | HIGH     | `apps__consumer-miniapp>@tarojs/webpack5-runner>html-minifier@4.0.0`                                                                         | 公告称 `>=4.0.1`，Registry 尚未发布 4.0.1              | 无兼容修复                                             | 避免构建不可信 HTML；跟踪 Taro runner                             |
| `GHSA-5j98-mcp5-4vw2`                        | HIGH     | `apps__consumer-miniapp>@tarojs/cli>@tarojs/plugin-doctor>glob@10.2.6`                                                                       | `>=10.5.0`，已发布                                     | 无兼容修复；plugin-doctor 精确依赖 10.2.6              | 不向 glob CLI 传入不可信 `--cmd`；等待上游                        |
| `GHSA-5c6j-r48x-rmvq`                        | HIGH     | `apps__consumer-miniapp>@tarojs/webpack5-runner>{copy-webpack-plugin,css-minimizer-webpack-plugin}>serialize-javascript@6.0.2`               | `>=7.0.3`，已发布                                      | 无兼容修复；跨主版本                                   | 构建只接受仓库内受审内容；等待 runner 升级                        |
| `GHSA-xcpc-8h2w-3j85`                        | HIGH     | `apps__consumer-miniapp>@tarojs/cli>adm-zip@0.5.18`                                                                                          | `>=0.6.0`，已发布                                      | 无兼容修复；父包要求 `^0.5.12`，0.x 次版本可能破坏兼容 | 禁止处理不可信 ZIP；等待 Taro CLI 升级                            |
| `GHSA-6g55-p6wh-862q`、`GHSA-r28c-9q8g-f849` | HIGH     | `apps__consumer-miniapp>@tarojs/webpack5-runner>miniprogram-simulate>postcss@7.0.39`                                                         | `>=8.5.18`，已发布                                     | 无兼容修复；跨主版本                                   | 测试/构建不处理不可信 CSS；升级模拟器链                           |
| `GHSA-c96f-x56v-gq3h`                        | HIGH     | `apps__api-server>{@prisma/client>prisma,prisma}>@prisma/dev>find-my-way@9.6.0`                                                              | 公告称 `>=9.6.1`；Registry 当前可用安全版为 9.7.0      | 无兼容修复；`@prisma/dev` 精确依赖 9.6.0               | 跟踪 Prisma 发布；该路径属于 Prisma 开发工具，不进入 API 运行入口 |
| `GHSA-pm4m-ph32-ghv5`                        | HIGH     | `apps__api-server>@nestjs/swagger>js-yaml@5.2.1`                                                                                             | `>=5.2.2`，已发布                                      | 无兼容修复；`@nestjs/swagger` 精确依赖 5.2.1           | 阻断发布或取得有时限例外；等待 Nest Swagger 升级                  |
| `GHSA-mh99-v99m-4gvg`                        | HIGH     | 审计共 34 条路径：16 条非 dev 路径、18 条 dev 路径；集中于 `minimatch>brace-expansion@1.1.16/2.1.2`，涵盖 Nest CLI、Taro CLI/runner/platform | `>=5.0.8`，已发布且 5.0.8 已安全安装，但旧主版本仍存在 | 无兼容修复；旧父包限定 1.x/2.x                         | 等待 Nest/Taro 工具链淘汰旧 minimatch/glob                        |

完整机器可读路径以同一提交执行 `pnpm audit --json` 为准；上表保留所有 HIGH/CRITICAL advisory，并对多路径项记录路径数量和共同父链。

## 发布结论

`pnpm audit --audit-level high` 当前仍以非零状态退出，依赖安全门禁保持阻断。不得降低阈值或忽略退出码。下一步应优先升级 Taro、Nest Swagger 与 Prisma 上游版本；升级后必须重新运行三端小程序构建/运行契约、API/Prisma/Nest 测试和完整审计。

# 小程序地图相关 skill 索引

涉及「小程序地图组件 / 定位」或「腾讯位置服务 Web API」时，本包不处理，路由到外部 skill。

| 场景 | 外部 skill | 触发示例 |
|------|------------|----------|
| 小程序前端：`map` 组件、`marker`、`wx.getLocation` / `chooseLocation`、门店标点 | https://skillhub.cn/skills/tencentmap-miniprogram-skill | 放地图、选地址、定位权限 |
| 后端 HTTP：路线规划、POI 搜索、地理编码、距离矩阵、IP 定位 | https://skillhub.cn/skills/tencentmap-webservice-skill | 从 A 到 B、附近搜索、经纬度转地址 |

## 规则

1. 匹配上表 → **指向对应外链**，不要用本包 `wechatide` 工具回答地图用法或位置服务 API。
2. 仅「打开/编译/预览含地图的页面」这类 WechatIDE 动作 → 仍走本包 `compiler` / `previewer` 等。
3. 同时涉及两侧时，按用户当前主目标先路由一侧，再提示另一侧存在。

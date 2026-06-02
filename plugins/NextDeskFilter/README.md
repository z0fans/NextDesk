# NextDesk RDP Node Filter

XBoard 插件，用于保护 RDP 专用加速节点不被非 NextDesk 客户端获取。

## 工作原理

1. 在 XBoard 节点管理中，给 RDP 专用节点添加 `rdp-only` 标签，或把节点加入名为 `rdp-only` 的权限组
2. 插件拦截 `client.subscribe.servers` hook（订阅下发流程）
3. 检测请求的 User-Agent / flag 参数是否包含 `nextdesk`
4. **NextDesk 客户端** → 只下发带 `rdp-only` 标签或属于 `rdp-only` 权限组的节点
5. NextDesk 订阅会附带专用 marker proxy，客户端会校验后移除
6. **其他客户端**（Clash Verge、Shadowrocket 等）→ 隐藏 rdp-only 节点

## 安装

1. 将 `NextDeskFilter/` 目录复制到 XBoard 的 `plugins/` 目录下
2. 在 XBoard 后台 → 插件管理 → 启用 "NextDesk RDP Node Filter"
3. （可选）修改配置中的标签/权限组名和客户端标识

## 配置项

| 配置 | 默认值 | 说明 |
|:---|:---|:---|
| `protected_tag` | `rdp-only` | 受保护节点的标签名或权限组名，命中的节点只对 NextDesk 可见 |
| `client_identifier` | `nextdesk` | UA/flag 中的客户端识别关键词（不区分大小写） |

## 节点配置

在 XBoard 后台添加或编辑节点时，任选一种方式标记 RDP 专用节点：

1. 给节点的 **tags** 字段添加 `rdp-only`
2. 或将节点绑定到名为 `rdp-only` 的权限组

示例：你有 2 台 CN2 GIA VPS 部署了 AnyTLS，在 XBoard 中添加这两个节点后，
给它们的 tags 加上 `rdp-only`，或把它们加入 `rdp-only` 权限组。

插件会兼容以下标签形态：

- `rdp-only`
- `rdp-only,foo`
- `["rdp-only"]`
- `[{"name":"rdp-only"}]`

如果 XBoard 后台列表中显示的是权限组 chip，而不是 tags 字段，插件会自动按 `group_ids` 查询同名权限组并识别。

## 验证

```bash
# 模拟 NextDesk 客户端请求（应该能看到 rdp-only 节点）
curl -H "User-Agent: NextDesk/1.0.95" "https://your-xboard.com/api/v1/client/subscribe?token=xxx"

# 模拟普通 Clash 客户端请求（不应该看到 rdp-only 节点）
curl -H "User-Agent: clash-verge/v2.0.0" "https://your-xboard.com/api/v1/client/subscribe?token=xxx"
```

## 日志

插件会在 debug 级别记录过滤行为，可在 XBoard 日志中查看：

```
[NextDeskFilter] NextDesk client detected, returning all servers {"user_id":1,"server_count":5}
[NextDeskFilter] Non-NextDesk client, filtered protected nodes {"user_id":1,"total":5,"after_filter":3,"removed":2}
```

## 安全性

- **UA 伪造风险**：低。用户需要知道 NextDesk 的 UA 字符串才能伪造。
  后续可升级为 HMAC 签名验证（v2.0 计划）。
- **订阅 URL 泄漏**：即使 URL 泄漏，非 NextDesk 客户端也拿不到 RDP 节点。
- **向后兼容**：插件禁用后所有节点正常下发，不影响任何现有功能。

## 版本历史

- **1.0.0** — 初始版本，基于 UA 识别的节点过滤
- **1.2.1** — 兼容纯字符串、逗号字符串、JSON 数组、对象数组等多种 XBoard 标签形态
- **1.3.0** — 兼容 XBoard 权限组 chip；节点属于同名权限组时也视为受保护节点
- **1.3.1** — 为 NextDesk 订阅追加授权 marker proxy，客户端可拒绝非专用订阅

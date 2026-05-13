# NextDesk RDP 专用节点过滤方案

> 设计文档：XBoard 插件 + NextDesk 客户端 UA 识别

## 背景与问题

NextDesk 用户购买"服务器加速"套餐后，通过 XBoard 订阅获取代理节点加速 RDP 连接。当前问题：

1. 用户拿到节点后用于看视频等高流量用途，导致节点 IP 被 GFW 标记封禁
2. RDP 加速需要稳定、低流量、专用的节点（CN2 GIA + AnyTLS/VLESS-Reality）
3. 需要将 RDP 专用节点**只下发给 NextDesk 客户端**，其他 Clash 客户端看不到

## 方案概述

利用 XBoard 的 `client.subscribe.servers` filter hook，在订阅下发时根据客户端 User-Agent 过滤节点：

- NextDesk 客户端请求 → 下发全部节点（含 RDP 专用节点）
- 其他客户端请求 → 过滤掉带 `rdp-only` 标签的节点

## 设计原则：Fail-Open 故障隔离

**核心约束：插件出任何故障都不能影响正常订阅下发。**

无论是插件代码抛异常、配置读取失败、节点数据格式异常，插件都必须**返回原始 `$servers`**，让订阅按正常流程继续。这意味着：

- 插件挂了 → 用户拿到全部节点（含 rdp-only），最坏情况下保护失效，但订阅服务不中断
- 订阅服务永不中断 > RDP 节点保护

实现方式：所有过滤逻辑包在 `try/catch (\Throwable $e)` 中，捕获到任何异常就记录日志并返回原始列表。

## 架构

```
用户订阅 URL（同一个）
        │
        ▼
   XBoard 订阅接口
   (ClientController::subscribe)
        │
        ▼
   ServerService::getAvailableServers($user)
   → 获取用户套餐内所有节点
        │
        ▼
   HookManager::filter('client.subscribe.servers', $servers, $user, $request)
   → NextDeskFilter 插件在此拦截
        │
        ├─ UA 含 "nextdesk" → 返回全部节点 ✅
        │
        └─ UA 不含 "nextdesk" → 过滤掉 tags 含 "rdp-only" 的节点
        │
        ▼
   协议格式化 + 响应下发
```

## 组件设计

### 1. XBoard 插件：NextDeskFilter

#### 目录结构

```
plugins/
└── NextDeskFilter/
    ├── Plugin.php        # 主插件类（核心逻辑）
    ├── config.json       # 插件配置定义
    └── README.md         # 使用说明
```

#### config.json

```json
{
    "name": "NextDesk RDP Node Filter",
    "code": "nextdesk_filter",
    "version": "1.0.0",
    "description": "只允许 NextDesk 客户端获取带 rdp-only 标签的专用加速节点，防止节点被滥用",
    "author": "NextDesk",
    "require": {
        "xboard": ">=1.0.0"
    },
    "config": {
        "protected_tag": {
            "type": "string",
            "default": "rdp-only",
            "label": "受保护的节点标签",
            "description": "带有此标签的节点只会下发给 NextDesk 客户端，其他客户端看不到"
        },
        "client_identifier": {
            "type": "string",
            "default": "nextdesk",
            "label": "客户端标识关键词",
            "description": "User-Agent 或 flag 参数中包含此字符串时视为 NextDesk 客户端（不区分大小写）"
        }
    }
}
```

#### Plugin.php

```php
<?php

namespace Plugin\NextDeskFilter;

use App\Services\Plugin\AbstractPlugin;
use Illuminate\Http\Request;

class Plugin extends AbstractPlugin
{
    public function boot(): void
    {
        $this->filter('client.subscribe.servers', function (array $servers, $user, Request $request) {
            try {
                return $this->filterServers($servers, $user, $request);
            } catch (\Throwable $e) {
                // Fail-open: any error must not break subscription delivery.
                \Log::error('[NextDeskFilter] Filter failed, returning original servers', [
                    'error' => $e->getMessage(),
                    'user_id' => $user->id ?? null,
                ]);
                return $servers;
            }
        });
    }

    private function filterServers(array $servers, $user, Request $request): array
    {
        $protectedTag = $this->getConfig('protected_tag', 'rdp-only');
        $clientIdentifier = strtolower((string) $this->getConfig('client_identifier', 'nextdesk'));

        // Skip filtering if no protected tag is configured
        if (empty($protectedTag) || empty($clientIdentifier)) {
            return $servers;
        }

        // Detect if request comes from NextDesk client
        $userAgent = strtolower($request->header('User-Agent', ''));
        $flag = strtolower((string) $request->input('flag', ''));
        $isNextDesk = str_contains($userAgent, $clientIdentifier)
            || str_contains($flag, $clientIdentifier);

        if ($isNextDesk) {
            return $servers;
        }

        // Other clients: filter out servers with protected tag
        return array_values(array_filter($servers, function ($server) use ($protectedTag) {
            $tags = $this->normalizeTags($server['tags'] ?? []);
            return !in_array($protectedTag, $tags, true);
        }));
    }

    /**
     * Normalize tags to an array of strings.
     * Handles JSON-encoded strings, comma-separated strings, arrays, and null.
     */
    private function normalizeTags($tags): array
    {
        if (is_array($tags)) {
            return array_map('strval', $tags);
        }
        if (is_string($tags) && $tags !== '') {
            $decoded = json_decode($tags, true);
            if (is_array($decoded)) {
                return array_map('strval', $decoded);
            }
            return array_map('trim', explode(',', $tags));
        }
        return [];
    }
}
```

#### README.md

```markdown
# NextDesk RDP Node Filter

XBoard 插件，用于保护 RDP 专用加速节点不被非 NextDesk 客户端获取。

## 工作原理

1. 在 XBoard 节点管理中，给 RDP 专用节点添加 `rdp-only` 标签
2. 插件拦截订阅下发流程
3. 检测请求的 User-Agent 是否包含 `nextdesk`
4. NextDesk 客户端 → 正常下发所有节点
5. 其他客户端（Clash Verge、Shadowrocket 等）→ 隐藏 rdp-only 节点

## 安装

1. 将 `NextDeskFilter/` 目录复制到 XBoard 的 `plugins/` 目录
2. 在 XBoard 后台 → 插件管理 → 启用 "NextDesk RDP Node Filter"
3. 配置受保护标签名称（默认 `rdp-only`）

## 配置项

| 配置 | 默认值 | 说明 |
|:---|:---|:---|
| protected_tag | rdp-only | 受保护节点的标签名 |
| client_identifier | nextdesk | UA 中的客户端识别关键词 |

## 节点配置

在 XBoard 后台添加/编辑节点时，给 RDP 专用节点的 tags 字段添加 `rdp-only`。
```

### 2. NextDesk 客户端改动

#### subscription.rs — User-Agent 修改

```rust
// 改前
.header("User-Agent", "clash-verge/v1.7.7")

// 改后
.header("User-Agent", "NextDesk/1.0.95 (rdp-accelerator)")
```

版本号应动态读取 Cargo.toml 中的版本，保持同步。

## 数据流

### 场景 1：用户用 NextDesk 订阅

```
NextDesk → GET /api/v1/client/subscribe
           Header: User-Agent: NextDesk/1.0.95 (rdp-accelerator)
           
XBoard 响应：
  - 通用节点 A（香港 VMess）
  - 通用节点 B（日本 Trojan）
  - RDP 专用节点 C（CN2 GIA AnyTLS）  ← 带 rdp-only 标签
  - RDP 专用节点 D（CN2 GIA AnyTLS）  ← 带 rdp-only 标签
```

### 场景 2：同一用户用 Clash Verge 订阅（同一 URL）

```
Clash Verge → GET /api/v1/client/subscribe
              Header: User-Agent: clash-verge/v2.0.0
              
XBoard 响应：
  - 通用节点 A（香港 VMess）
  - 通用节点 B（日本 Trojan）
  （RDP 专用节点 C、D 被过滤，不在响应中）
```

## 错误处理

> **保证：所有失败场景下，订阅都能正常下发，不会返回错误响应。**

| 场景 | 行为 | 订阅下发是否受影响 |
|:---|:---|:---|
| 插件未启用 | XBoard 不调用 hook，原流程不变 | ❌ 不受影响 |
| 插件代码抛异常 | try/catch 捕获，记录日志，返回原始 `$servers` | ❌ 不受影响（fail-open） |
| 配置读取失败 | 使用默认值（`rdp-only` / `nextdesk`） | ❌ 不受影响 |
| `protected_tag` 配置为空 | 跳过过滤，返回原始 `$servers` | ❌ 不受影响 |
| `client_identifier` 配置为空 | 跳过过滤，返回原始 `$servers` | ❌ 不受影响 |
| 节点没有 `tags` 字段 | `?? []` 兜底，节点正常下发 | ❌ 不受影响 |
| `tags` 是字符串/JSON | `normalizeTags()` 解析处理 | ❌ 不受影响 |
| `tags` 是 null/数字等异常类型 | `normalizeTags()` 返回空数组 | ❌ 不受影响 |
| User-Agent 为空 | 视为非 NextDesk 客户端，过滤 rdp-only 节点 | ❌ 不受影响 |

**最坏情况**：插件因某种 bug 完全失效 → 所有客户端都拿到全部节点（包括 rdp-only）。这是可接受的降级行为 —— 节点保护功能失效，但订阅服务持续可用。

## 安全性考量

| 风险 | 评估 | 缓解措施 |
|:---|:---|:---|
| 用户伪造 UA | 低 — 需要知道 NextDesk 的 UA 字符串 | 可后续升级为 HMAC 签名验证 |
| 订阅 URL 泄漏 | 中 — URL 本身不变 | 即使泄漏，非 NextDesk 客户端也拿不到 RDP 节点 |
| 插件被绕过 | 极低 — hook 在 XBoard 核心流程中 | 无法绕过，除非直接改数据库 |

## 部署步骤

1. **XBoard 端**
   - 将 `NextDeskFilter/` 放入 `plugins/` 目录
   - 后台启用插件
   - 给 RDP 专用节点添加 `rdp-only` 标签

2. **NextDesk 端**
   - 修改 `subscription.rs` 中的 User-Agent
   - 发版更新

3. **验证**
   - 用 NextDesk 订阅，确认能看到 rdp-only 节点
   - 用 Clash Verge 订阅同一 URL，确认看不到 rdp-only 节点

## 后续扩展

- **阶段 2**：增加 HMAC 签名验证（防 UA 伪造）
- **阶段 3**：增加设备绑定（限制同时在线设备数）
- **阶段 4**：增加自动故障检测 + 节点切换逻辑

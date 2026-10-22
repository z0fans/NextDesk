# Connect Gateway 运维说明

## 数据边界

- Xboard 主数据库只读，不新增表，不写 Cloud Gateway 运行状态。
- 插件状态只写入：`storage/app/connect-gateway/state.sqlite`。
- NextDesk 不保存 Xboard 账号密码，只保存 device token。
- macOS 优先写入 Keychain；失败时回退到 NextDesk 配置目录的 token 文件。

## Agent 生命周期

新增 agent：

1. 在插件后台创建 agent。
2. 将 `agent_id` 和 `agent_token` 写入中继服务器配置。
3. 启动 `connect-gateway-agent`。
4. 插件看到 heartbeat 后才会参与调度。

删除 agent：

- 默认进入 `draining`。
- 新连接不会再调度到该 agent。
- 已有 binding 不会被强杀；到期或关闭后自然清理。

每个 binding 使用独立的 `realm-cg@<binding>.service`。创建、关闭或过期一个 binding 不会重启同一服务器上的其他 RDP 转发。Agent 会在启动和每次轮询时校准本地实例，并在控制面暂时不可用时继续按 `expires_at` 清理过期规则。

## Binding 租约

默认参数：

- binding TTL：180 秒。
- renew after：60 秒。
- reconnect grace：120 秒。

含义：

- 正常连接期间 NextDesk 可复用同一 binding，不需要每次网络抖动重连都重新向 agent 下发规则。
- 当同一个目标在 grace 窗口内重连时，NextDesk 优先复用缓存 binding。
- 当 binding 接近过期时，NextDesk 先 `/renew`，避免规则过早被清理。

## 路由与端口

- 默认允许：3389、22。
- 默认协议：TCP + UDP。
- 管理员可在插件 settings 中调整 `allowed_ports`、`forward_protocols`、并发和租约时间。
- Cloud Mode 失败时不得静默直连，避免用户误以为已经走中继。

## 典型排查

检查插件 PHP 语法：

```bash
cd /path/to/xboard
find plugins/ConnectGateway -name '*.php' -print0 | xargs -0 -n1 php -l
```

检查 agent：

```bash
cd gateway-agent
go test ./...
go build ./cmd/gateway-agent
```

检查 NextDesk：

```bash
cd frontend
npm test -- cloud-api.test.ts cloud-mode-settings.test.tsx
npm run build

cd ../src-tauri
cargo check
RUSTFLAGS="--cfg nextdesk_kkterm_rdp" cargo check --no-default-features --features kkterm-rdp
cargo test connection_resolver
```

## 常见错误

- `cloud_not_authorized`：NextDesk 未完成浏览器授权，或 device token 被删除。
- `no_healthy_edge`：没有 agent heartbeat，或 agent 已 disabled/draining。
- `port_not_allowed`：目标端口未在插件 settings 放行。
- `cloud_binding_not_ready`：agent 未在等待窗口内 ACK，检查 agent 日志和 realm-cg 状态。
- `cloud relay connect failed`：客户端无法连接 agent 公网监听地址，检查防火墙、安全组和端口范围。

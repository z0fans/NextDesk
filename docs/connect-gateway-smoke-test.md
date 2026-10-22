# Connect Gateway 冒烟测试

本文用于验证 Xboard `ConnectGateway` 插件、`gateway-agent` 和 NextDesk Cloud Mode 是否能组成闭环。

## 1. Xboard 插件检查

1. 上传并启用 `ConnectGateway` 插件。
2. 确认插件私有数据库存在：
   - `storage/app/connect-gateway/state.sqlite`
3. 在插件后台添加一个 agent，记录：
   - `agent_id`
   - `agent_token`
   - `public_host`
   - `public_port_range`
4. 确认默认设置：
   - `allowed_ports = [3389, 22]`
   - `forward_protocols = ["tcp", "udp"]`
   - `binding_ttl_seconds = 180`
   - `renew_after_seconds = 60`
   - `reconnect_grace_seconds = 120`

## 2. gateway-agent 检查

在中继服务器写入 `/etc/connect-gateway-agent/config.json`：

```json
{
  "base_url": "https://panel.example.com",
  "agent_id": "agt_xxx",
  "agent_token": "cg_agt_secret_xxx",
  "realm_profile": "cg",
  "poll_interval_seconds": 2,
  "public_host": "edge.example.com",
  "port_range": "42000-42999"
}
```

启动前先做本地构建验证：

```bash
cd gateway-agent
go test ./...
go build ./cmd/gateway-agent
```

启动服务后检查：

```bash
systemctl status connect-gateway-agent
systemctl list-units 'realm-cg@*.service'
ls -la /etc/realm-cg/rules
find /etc/realm-cg/instances -maxdepth 2 -name config.json -print
```

## 3. NextDesk 授权检查

1. 打开 Settings。
2. 打开 Cloud Mode。
3. 填入 Xboard 面板地址，例如 `https://panel.example.com`。
4. 点击授权，浏览器登录 Xboard 后会跳回 NextDesk。
5. NextDesk 应显示：
   - 授权状态：已授权
   - 账号可用期限
   - 设备授权期限

## 4. 连接闭环

1. 在 NextDesk 中连接一个允许端口的目标，例如 `203.0.113.10:3389`。
2. NextDesk 会先请求 `/api/v1/connect/bind`。
3. 插件分配 agent 和监听端口。
4. agent 轮询到 `create_binding` task 后写入 realm 规则。
5. 插件收到 agent ACK 后返回 active；如仍为 pending，NextDesk 最多等待 8 秒。
6. NextDesk 连接 `endpoint.host:endpoint.port`，但 RDP TLS 仍使用原始目标主机名。

预期结果：

- Xboard 插件 bindings 中状态变为 `active`。
- agent 规则目录出现 `cg-<binding_id>.json`。
- realm `network.no_tcp=false` 且 `network.use_udp=true`。
- RDP/SSH 连接不再走原始目标直连。

## 5. 失败预期

- Cloud Mode 已开启但未授权：连接失败，不静默直连。
- agent 不健康：`bind` 返回 `no_healthy_edge`。
- 目标端口不是 3389/22 且未在后台放行：返回 `port_not_allowed`。
- agent 未及时 ACK：NextDesk 返回 `cloud_binding_not_ready`。

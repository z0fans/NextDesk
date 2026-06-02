# TCP 病态连接自动检测与清理

RDP 间歇性黑屏的根因：TCP cwnd 崩塌后 XrayR 不清理病态连接，用户被迫等待客户端超时重连。目标：自动检测并杀死病态连接，将恢复时间从分钟级缩短到秒级。

## Proposed Changes

### 方案 A：route-monitor 健康巡检器

#### [MODIFY] [event.go](file:///Users/yuu/Downloads/vibe_coding/route/route-monitor/internal/model/event.go)
- `TcpLinkMetrics` 增加 `Backoff int` 和 `SendQ int64` 字段

#### [MODIFY] [parser.go](file:///Users/yuu/Downloads/vibe_coding/route/route-monitor/internal/collector/tcpmetrics/parser.go)
- 增加 `backoff:(\d+)` 和 `Send-Q` 正则解析
- `parsePeer()` 额外返回完整地址对（用于 `ss -K` 定位 socket）

#### [NEW] [healthcheck.go](file:///Users/yuu/Downloads/vibe_coding/route/route-monitor/internal/collector/healthcheck/healthcheck.go)
- 独立 goroutine，每 5 秒扫描一次
- 调用 `ss -tnpi state established src :24016` 获取 inbound 连接
- 病态条件：`cwnd ≤ 2 && backoff ≥ 3 && direction == "inbound"`
- 触发时执行 `ss -K dst <peer_ip> dport = <peer_port>` 杀死 socket
- 向 broker 发布 `tcp_health_kill` 事件用于 UI 展示和日志
- 配置项：`enable`（默认 true）、`cwnd_threshold`、`backoff_threshold`、`check_interval`

#### [MODIFY] [main.go](file:///Users/yuu/Downloads/vibe_coding/route/route-monitor/cmd/route-monitor/main.go)
- 启动 healthcheck goroutine

---

### 方案 C：系统层调优

#### 直接在入口服务器执行 sysctl 命令（不需要改代码）

```bash
# 减少重传次数，让病态连接更快死亡（默认15，改为8）
sysctl -w net.ipv4.tcp_retries2=8
# TCP keepalive 加强
sysctl -w net.ipv4.tcp_keepalive_time=30
sysctl -w net.ipv4.tcp_keepalive_intvl=10
sysctl -w net.ipv4.tcp_keepalive_probes=3
# 加速 FIN-WAIT-2 清理（默认60秒）
sysctl -w net.ipv4.tcp_fin_timeout=15
# 持久化
echo "net.ipv4.tcp_retries2=8
net.ipv4.tcp_keepalive_time=30
net.ipv4.tcp_keepalive_intvl=10
net.ipv4.tcp_keepalive_probes=3
net.ipv4.tcp_fin_timeout=15" >> /etc/sysctl.d/99-rdp-optimize.conf
```

## Verification Plan

### Automated Tests
1. `go build` 编译通过
2. 部署后观察 `journalctl -u route-monitor` 日志中 healthcheck 启动信息
3. 在 route-monitor UI 的 Disconnect Diagnosis 中确认 kill 事件被记录

### Manual Verification
1. 用 `ss -tnpi` 观察是否有 `cwnd:1 backoff:3+` 的连接被自动清理
2. 用 `sysctl -a | grep tcp_retries2` 确认 sysctl 参数已生效

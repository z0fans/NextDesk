# TCP 病态连接自动检测与清理 — Walkthrough

## 问题

RDP 间歇性黑屏：TCP cwnd 崩塌到 1 后 XrayR 不清理，用户被迫等 RDP 客户端超时重连（分钟级）。

## 实现

### 方案 A：healthcheck 模块

新建 [healthcheck.go](file:///Users/yuu/Downloads/vibe_coding/route/route-monitor/internal/collector/healthcheck/healthcheck.go)：
- 每 5 秒扫描 `ss -tnpi state established src :24016`
- 检测 `cwnd ≤ 2 && backoff ≥ 3` 的 inbound 连接
- 通过 `ss -K dst <ip> dport = <port>` 内核级杀死 socket
- 向 broker 发布 `tcp_health_kill` 事件

支撑改动：
- [event.go](file:///Users/yuu/Downloads/vibe_coding/route/route-monitor/internal/model/event.go): `TcpLinkMetrics` 增加 `Backoff`/`SendQ`/`LocalAddr`/`RemoteAddr`；新增 `TcpHealthKillEvent`
- [parser.go](file:///Users/yuu/Downloads/vibe_coding/route/route-monitor/internal/collector/tcpmetrics/parser.go): 增加 `backoff` 正则、Send-Q 解析、完整地址对
- [main.go](file:///Users/yuu/Downloads/vibe_coding/route/route-monitor/cmd/route-monitor/main.go): 启动 healthcheck goroutine

### 方案 C：sysctl 调优

```bash
net.ipv4.tcp_retries2=8       # 默认15→8，病态连接更快死亡
net.ipv4.tcp_keepalive_time=30 # 30秒无数据就探测
net.ipv4.tcp_keepalive_intvl=10
net.ipv4.tcp_keepalive_probes=3
net.ipv4.tcp_fin_timeout=15    # FIN-WAIT-2 加速清理
```

持久化到 `/etc/sysctl.d/99-rdp-optimize.conf`。

## 验证结果

```
route-monitor: active ✅
healthcheck log: "tcp healthcheck started" interval=5s cwnd_threshold=2 backoff_threshold=3 ✅
sysctl: tcp_retries2=8, keepalive_time=30, fin_timeout=15 ✅
```

# Route Monitor 链路诊断增强 — Walkthrough

## 变更总览

**纯增量开发**，未修改任何现有逻辑，全部为追加。

### 新增文件

| 文件 | 用途 |
|------|------|
| [poller.go](file:///Users/yuu/Downloads/vibe_coding/route/route-monitor/internal/collector/tcpmetrics/poller.go) | TCP 指标采集器，每轮询周期执行 `ss -tnpi` |
| [parser.go](file:///Users/yuu/Downloads/vibe_coding/route/route-monitor/internal/collector/tcpmetrics/parser.go) | 解析 RTT/重传/cwnd，自动识别入站(24016)和出站(16779)方向 |

### 修改文件（仅追加）

| 文件 | 追加内容 |
|------|---------|
| [event.go](file:///Users/yuu/Downloads/vibe_coding/route/route-monitor/internal/model/event.go) | `TcpLinkMetrics` / `TcpMetricsSnapshot` / `TransitDelayPoint` / `DisconnectDiagnosis` 四个新类型 + `DisconnectRecord.Diagnosis` 字段 |
| [store.go](file:///Users/yuu/Downloads/vibe_coding/route/route-monitor/internal/analyzer/store.go) | `endedReasonPattern` 正则、`transitHistory` / `latestTcpMetrics` 字段、`consumeTcpMetrics` / `TransitHistory` / `buildDiagnosis` / `determineVerdict` 方法 |
| [server.go](file:///Users/yuu/Downloads/vibe_coding/route/route-monitor/internal/httpapi/server.go) | `/api/transit-history` 路由 + handler |
| [main.go](file:///Users/yuu/Downloads/vibe_coding/route/route-monitor/cmd/route-monitor/main.go) | 导入 `tcpmetrics` 包 + 注册 collector |
| [index.html](file:///Users/yuu/Downloads/vibe_coding/route/route-monitor/internal/httpapi/index.html) | 断连诊断卡片 + 延迟趋势折线图 + 对应 CSS/JS |

## 验证结果

- ✅ `go build ./...` 编译通过，零错误

## 部署

重新编译并部署到服务器即可：

```bash
cd route-monitor
GOOS=linux GOARCH=amd64 go build -o route-monitor ./cmd/route-monitor/
scp route-monitor root@198.176.49.82:/usr/local/bin/
ssh root@198.176.49.82 "systemctl restart route-monitor"
```

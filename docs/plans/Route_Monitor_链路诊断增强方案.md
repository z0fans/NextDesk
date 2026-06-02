# Route Monitor 链路诊断增强方案

为 route-monitor 增加链路质量诊断能力，使断连时能一眼看出是**哪一环节**导致的问题。

> [!IMPORTANT]
> **纯增量开发**：不修改、不删除任何现有代码。所有改动通过新增文件、新增字段、新增端点实现。现有功能完全不受影响。

## Proposed Changes

### 1. 数据模型扩展

#### [MODIFY] [event.go](file:///Users/yuu/Downloads/vibe_coding/route/route-monitor/internal/model/event.go)

仅在文件末尾**追加**新类型，不改动现有类型：

```go
// 新增：TCP 链路指标（从 ss -tnpi 采集）
type TcpLinkMetrics struct {
    Peer       string  `json:"peer"`        // 对端 IP:Port
    Direction  string  `json:"direction"`   // "inbound" 或 "outbound"
    RttMs      float64 `json:"rtt_ms"`      // 平滑 RTT (ms)
    RttVarMs   float64 `json:"rtt_var_ms"`  // RTT 方差 (ms)
    Retrans    int     `json:"retrans"`     // 重传段数
    Cwnd       int     `json:"cwnd"`        // 拥塞窗口
    SendBps    int64   `json:"send_bps"`    // 发送速率 bps
}

// 新增：延迟历史点
type TransitDelayPoint struct {
    Tag       string    `json:"tag"`
    DelayMS   float64   `json:"delay_ms"`
    Timestamp time.Time `json:"timestamp"`
}

// 新增：断连诊断快照（附加到 DisconnectRecord）
type DisconnectDiagnosis struct {
    EndReason       string           `json:"end_reason"`
    InboundMetrics  *TcpLinkMetrics  `json:"inbound_metrics,omitempty"`
    OutboundMetrics *TcpLinkMetrics  `json:"outbound_metrics,omitempty"`
    TransitDelay    *TransitStat     `json:"transit_delay,omitempty"`
    Verdict         string           `json:"verdict"` // "inbound_degraded" / "outbound_degraded" / "transit_spike" / "unknown"
}
```

在现有 `DisconnectRecord` 末尾**追加一个字段**：

```go
// 在 DisconnectRecord struct 末尾追加
Diagnosis *DisconnectDiagnosis `json:"diagnosis,omitempty"`
```

---

### 2. 新 Collector: tcpmetrics

#### [NEW] [poller.go](file:///Users/yuu/Downloads/vibe_coding/route/route-monitor/internal/collector/tcpmetrics/poller.go)

每 5 秒执行 `ss -tnpi state established`，解析 RTT / 重传 / cwnd 指标，分类关联到入站和出站连接。

**核心逻辑**：
- 解析 `ss -tnpi` 输出中的 `rtt:` / `retrans:` / `cwnd:` / `send` 字段
- 入站连接：匹配 `:24016` 端口的连接（用户 → 中转）
- 出站连接：匹配已知出口地址（如 `104.245.12.51` / `148.135.184.12`）的连接
- 通过 `OnSnapshot` 回调发布 `tcp_metrics_snapshot` 事件到 broker

---

### 3. 增强断连原因提取

#### [MODIFY] [store.go](file:///Users/yuu/Downloads/vibe_coding/route/route-monitor/internal/analyzer/store.go)

在 `consumeLogLine` 中**追加**一个新的正则匹配（不修改现有 `endedPattern`）：

```go
// 新增正则：提取断连原因
var endedReasonPattern = regexp.MustCompile(
    `connection ends .* from ((?:\d{1,3}\.){3}\d{1,3}):(\d+).*?: (.+)$`,
)
```

在 `consumeLogLine` 函数的 ended 处理块中，**追加**对 `endedReasonPattern` 的匹配逻辑：如果匹配到原因字段，将其保存到 session 的 `EndReason` 中。

---

### 4. Observatory 延迟历史

#### [MODIFY] [store.go](file:///Users/yuu/Downloads/vibe_coding/route/route-monitor/internal/analyzer/store.go)

在 Store struct 中**追加**一个字段：

```go
transitHistory []model.TransitDelayPoint // 环形缓冲，最近 200 个点
```

在 `consumeJournalObservatory` 函数末尾**追加**一行：将每次探测结果也写入 `transitHistory`。

**新增**导出方法 `TransitHistory()` 返回历史列表。

---

### 5. 断连诊断快照

#### [MODIFY] [store.go](file:///Users/yuu/Downloads/vibe_coding/route/route-monitor/internal/analyzer/store.go)

在 Store struct 中**追加**字段保存最新的 TCP 指标快照：

```go
latestTcpMetrics map[string]model.TcpLinkMetrics // key = peer IP:Port
```

**新增**事件消费方法 `consumeTcpMetrics`，在 `consume` switch 中追加 `case "tcp_metrics_snapshot"`。

在 `consumeActiveInbound` 和 `consumeTcpLifecycle` 的断连处理逻辑中，**追加**构建 `DisconnectDiagnosis` 并挂载到 `DisconnectRecord.Diagnosis`。

---

### 6. API 端点

#### [MODIFY] [server.go](file:///Users/yuu/Downloads/vibe_coding/route/route-monitor/internal/httpapi/server.go)

**追加**新路由和 handler（不改动现有路由）：

```go
mux.HandleFunc("/api/transit-history", s.handleTransitHistory)
```

在 `stateView` 接口中**追加**方法声明：

```go
TransitHistory() []model.TransitDelayPoint
```

---

### 7. 主程序注册

#### [MODIFY] [main.go](file:///Users/yuu/Downloads/vibe_coding/route/route-monitor/cmd/route-monitor/main.go)

**追加** tcpmetrics collector 的启动调用（在 `startActiveSocketPoller` 之后）。

---

### 8. 前端增强

#### [MODIFY] [index.html](file:///Users/yuu/Downloads/vibe_coding/route/route-monitor/internal/httpapi/index.html)

在现有面板**后面追加**两个新区域：

**A. 断连诊断卡片区域**：
- 从 `/api/disconnects` 获取数据（现有端点，数据结构扩展了 `diagnosis` 字段）
- 每条记录展示：时间、目标、持续时间、断连原因、各环节指标快照
- 颜色标注异常环节（RTT > 200ms 标红，重传 > 5 标黄）
- 底部 verdict 标签（如"入站链路异常"）

**B. Observatory 延迟趋势图**：
- 从 `/api/transit-history` 获取历史数据
- 用 `<canvas>` 画折线图（每条出口一条线）
- 在断连发生的时间点上画竖线 ▼ 标记

## Verification Plan

### 自动化验证

1. **编译检查**：
```bash
cd /Users/yuu/Downloads/vibe_coding/route/route-monitor && go build ./...
```

2. **本地 demo 模式运行**：
```bash
ROUTE_MONITOR_DEMO_MODE=true ROUTE_MONITOR_ACCESS_LOG=- \
ROUTE_MONITOR_ERROR_LOG=- ROUTE_MONITOR_OBSERVATORY_URL=- \
ROUTE_MONITOR_JOURNAL_UNIT=- \
go run ./cmd/route-monitor/
```

### 手动验证

1. 部署到服务器 `198.176.49.82` 后，打开 `http://198.176.49.82:18080`
2. 等待一次 RDP 断连发生，检查断连记录中是否包含 `diagnosis` 字段
3. 查看延迟趋势图是否正常绘制，断连标记是否出现在正确位置
4. 对比断连前后的 RTT/重传数据，确认能定位到具体环节

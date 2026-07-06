# ConnectGateway 自适应 Agent 选择方案

日期：2026-07-06

## 目标

为 ConnectGateway Cloud Mode 增加第一版“自动选择更流畅 Agent”的能力。用户点击 RDP 连接后，NextDesk 不再只接受 Xboard 插件按负载选出的单个 Agent，而是让插件创建少量候选 binding，NextDesk 从真实客户端视角对这些 relay endpoint 做 RDP 轻量握手测速，选择最快的 endpoint 建立正式 RDP 会话。

第一版重点是功能闭环和可验证性，尽量减少用户等待时间，但不做复杂竞速、历史评分或多轮扩展。

## 已确认决策

- 采用方案 2：Xboard 插件创建候选 binding，NextDesk 负责测速并回报 winner。
- 使用完整 RDP 预探测，而不是只测用户到 Agent 的 TCP RTT。
- 候选数量自适应，不默认全量测试所有 Agent。
- 不做竞速提前 commit。NextDesk 并发测速，等待固定窗口或所有候选结束，再选最快成功项。
- Cloud 失败时不静默直连。
- 继续保持 ConnectGateway 使用私有 SQLite，不修改 Xboard 主数据库。
- 现有 `/api/v1/connect/bind` 保持兼容，新增 prepare/commit 流程作为更智能的连接路径。

## 非目标

- 不实现实时丢包模型。
- 不实现用户 IP 地理定位选路。
- 不实现历史质量评分或机器学习排序。
- 不实现连接过程中热切换 Agent。
- 不实现多轮候选扩展。
- 不默认对所有 Agent 全量测速。
- 不改变 gateway-agent 的基础职责：agent 仍只接收 binding 创建/删除任务并写入 realm-xwPF。

## 当前基线

当前 `AgentSelector` 的选择依据是：

1. Agent `status = active`。
2. `last_seen_at` 在 `agent_heartbeat_timeout_seconds` 窗口内，默认 30 秒。
3. 如果 `preferred_region != auto`，优先匹配 region。
4. 按 `active/pending binding count / capacity` 从低到高排序。

这能做到健康和负载均衡，但无法判断用户到哪个 Agent 的实际网络更好，也无法判断 `用户 -> Agent -> RDP 目标` 的完整链路是否顺畅。

## 推荐流程

```text
用户点击连接
  -> NextDesk 检查 Cloud Mode 授权
  -> NextDesk POST /api/v1/connect/prepare
  -> Xboard 选择少量候选 Agent
  -> Xboard 为候选 Agent 创建短 TTL candidate binding
  -> gateway-agent 拉取任务并写入 realm-cg 规则
  -> Xboard 返回 candidate endpoint 列表
  -> NextDesk 并发对每个 endpoint 做 RDP 轻量握手测速
  -> NextDesk 在固定测速窗口内选 total_ms 最低的成功项
  -> NextDesk POST /api/v1/connect/commit
  -> Xboard 保留 winner，关闭 loser
  -> NextDesk 使用 winner endpoint 正式连接 RDP
```

如果所有候选都失败：

```text
NextDesk POST /api/v1/connect/abort
  -> Xboard 将所有候选 binding 标记为 closing
  -> agent 删除对应 realm 规则
  -> NextDesk 显示 Cloud relay 不可用的明确错误
```

## 候选数量规则

候选数量由插件端决定，客户端不可强制要求更大的候选数。第一版规则：

```text
healthy_agents <= 3：全部候选
healthy_agents 4-8：候选 3 个
healthy_agents > 8：候选 4 个
```

健康 Agent 的判定沿用当前规则：

- `status = active`
- `last_seen_at >= now - agent_heartbeat_timeout_seconds`
- 非 deleted
- 非 draining
- region 匹配；如果指定 region 没有健康 Agent，则降级 `auto`

候选 Agent 排序沿用当前稳定逻辑：

```text
agent_score = active_or_candidate_binding_count / capacity
```

从低到高取前 N 个。第一版不引入随机扰动，便于验证和排查。

## API 设计

### `POST /api/v1/connect/prepare`

请求：

```json
{
  "target_host": "139.177.155.80",
  "target_port": 3389,
  "preferred_region": "auto",
  "client": {
    "platform": "macos",
    "app_version": "1.0.102"
  }
}
```

处理步骤：

1. 校验 device token。
2. 校验账号权益。
3. 校验 `target_port` 在允许端口中，默认 3389 和 22。
4. 如果同用户、同目标已有可复用 active binding，可直接返回 `mode = reused`。
5. 检查用户当前 committed active binding 并发限制。
6. 选择候选 Agent。
7. 为每个候选 Agent 创建 `candidate` binding。
8. 等待 agent ACK，等待上限沿用或扩展 `bind_wait_seconds`。
9. 返回已就绪候选 endpoint。

响应：

```json
{
  "prepare_id": "prep_xxx",
  "mode": "candidates",
  "probe_timeout_ms": 2500,
  "commit_deadline_at": "2026-07-06T07:00:30Z",
  "candidates": [
    {
      "binding_id": "bnd_a",
      "agent_id": "agt_hk_1",
      "region": "HKG",
      "endpoint": {
        "host": "199.15.77.185",
        "port": 42070,
        "protocols": ["tcp", "udp"]
      },
      "expires_at": "2026-07-06T07:00:30Z"
    }
  ]
}
```

如果复用已有 binding：

```json
{
  "prepare_id": null,
  "mode": "reused",
  "binding": {
    "binding_id": "bnd_existing",
    "status": "active",
    "endpoint": {
      "host": "199.15.77.185",
      "port": 42323,
      "protocols": ["tcp", "udp"]
    }
  }
}
```

### `POST /api/v1/connect/commit`

请求：

```json
{
  "prepare_id": "prep_xxx",
  "winner_binding_id": "bnd_a",
  "results": [
    {
      "binding_id": "bnd_a",
      "ok": true,
      "tcp_connect_ms": 18,
      "x224_ms": 42,
      "tls_ms": 180,
      "total_ms": 240
    },
    {
      "binding_id": "bnd_b",
      "ok": false,
      "error": "tls_timeout",
      "total_ms": 2500
    }
  ]
}
```

处理步骤：

1. 校验 `prepare_id` 属于当前 user/device。
2. 校验 winner 属于该 prepare。
3. 将 winner 转为正式 active binding，并把 `expires_at` 延长到 `binding_ttl_seconds`。
4. 将 loser 标记为 `closing`。
5. 记录测速结果到 events 或 candidate result 字段。
6. 返回 winner endpoint。

响应：

```json
{
  "binding_id": "bnd_a",
  "status": "active",
  "endpoint": {
    "host": "199.15.77.185",
    "port": 42070,
    "protocols": ["tcp", "udp"]
  },
  "expires_at": "2026-07-06T07:03:00Z",
  "renew_after_seconds": 60,
  "reconnect_grace_seconds": 120
}
```

### `POST /api/v1/connect/abort`

用于所有候选测速失败、用户取消连接、或 NextDesk 在 commit 前崩溃恢复后的显式清理。

请求：

```json
{
  "prepare_id": "prep_xxx",
  "reason": "all_candidates_failed"
}
```

处理步骤：

1. 校验 prepare 属于当前 user/device。
2. 将该 prepare 下未 commit 的 candidate binding 标记为 `closing`。
3. agent 下轮 poll 删除对应 realm 规则。

## SQLite 状态调整

ConnectGateway 仍只写入：

```text
storage/app/connect-gateway/state.sqlite
```

建议在私有 SQLite 中增加以下字段或等价结构：

### `bindings`

新增概念字段：

- `prepare_id`：候选组 ID，普通单 binding 可为空。
- `binding_kind`：`normal` / `candidate`。
- `selection_role`：`candidate` / `winner` / `loser`。
- `probe_result_json`：NextDesk 回报的测速结果，可为空。

状态继续使用当前语义：

- `pending`：等待 agent 应用规则。
- `active`：agent 已 ACK，endpoint 可连接。
- `closing`：等待 agent 删除规则。
- `expired`：TTL 到期。
- `failed`：agent 应用失败。

Candidate binding 可以是：

```text
binding_kind = candidate
status = pending 或 active
selection_role = candidate
```

Commit 后 winner 变为：

```text
binding_kind = normal
status = active
selection_role = winner
```

Loser 变为：

```text
binding_kind = candidate
status = closing
selection_role = loser
```

### `settings`

新增或确认以下配置：

```json
{
  "candidate_count_small_threshold": 3,
  "candidate_count_medium_threshold": 8,
  "candidate_count_medium": 3,
  "candidate_count_large": 4,
  "candidate_ttl_seconds": 45,
  "probe_timeout_ms": 2500,
  "prepare_commit_deadline_seconds": 45,
  "max_prepares_per_user": 1
}
```

第一版不把这些配置全部暴露到 UI 也可以，但需要有默认值。

## NextDesk 测速逻辑

NextDesk 在 Tauri 后端实现轻量 RDP probe，避免浏览器环境限制。

每个 candidate 并发执行：

1. TCP connect 到 `endpoint.host:endpoint.port`。
2. 发送 RDP X.224 Connection Request。
3. 等待 X.224 Connection Confirm。
4. 执行 TLS handshake，不做账号登录，不发送凭据。
5. 关闭连接。
6. 记录耗时和失败原因。

评分第一版只使用：

```text
total_ms = tcp_connect_ms + x224_ms + tls_ms
```

选择规则：

```text
在 probe_timeout_ms 内完成的成功候选中，选择 total_ms 最低的 binding。
如果所有候选失败，abort prepare 并显示错误。
如果只有一个成功，选择这个成功项。
如果多个 total_ms 相同，保留 Xboard 返回顺序靠前的候选。
```

这里不做竞速提前决策。NextDesk 可以在所有候选完成后立即 commit；如果还有候选未完成，则等到 `probe_timeout_ms` 后 commit。

## 生命周期和超时

### Candidate TTL

Candidate binding 默认 TTL 为 45 秒。原因：

- 足够覆盖 agent poll、NextDesk probe、commit。
- 不会长期占用端口。
- 如果 NextDesk 崩溃，cleanup 能快速回收。

### Winner TTL

Commit 后 winner 使用现有正式 binding 策略：

```text
binding_ttl_seconds = 180
renew_after_seconds = 60
reconnect_grace_seconds = 120
```

NextDesk 网络抖动重连时继续复用 winner binding，不重新 prepare。

### Commit deadline

Prepare 创建后必须在 `prepare_commit_deadline_seconds` 内 commit 或 abort。超过 deadline 的 candidate binding 由 cleanup 标记为 closing/expired。

## 错误处理

- `no_healthy_edge`：没有健康 Agent。
- `not_enough_candidates`：候选少于 1 个。
- `candidate_apply_timeout`：候选 binding 未在等待窗口内 ACK。
- `all_candidates_failed`：所有 RDP 轻握手失败。
- `prepare_expired`：commit 时 prepare 已过期。
- `winner_not_in_prepare`：提交的 winner 不属于当前 prepare。
- `cloud_authorization_expired`：设备授权失效。

NextDesk 展示时不暴露过多内部字段，建议用户可见文案：

```text
无法选择可用云端线路。请稍后重试，或检查目标服务器是否允许 RDP 连接。
```

调试日志中保留 `prepare_id`、候选 endpoint、失败原因、耗时和 winner。

## UI 表现

用户连接时保持简洁状态：

```text
正在选择云端线路...
正在连接 <host>...
```

不需要向普通用户展示所有候选 Agent。调试模式或日志中可显示：

```text
target=139.177.155.80:3389
prepare_id=prep_xxx
candidates=3
winner=199.15.77.185:42070
total_ms=240
```

## 兼容性

- `/api/v1/connect/bind` 保持现有单 Agent 行为，老版本 NextDesk 继续可用。
- 新版 NextDesk 优先使用 `/prepare -> /commit`。
- 如果服务端不支持 `/prepare`，新版 NextDesk 可以提示 Cloud Gateway 版本过旧，不应静默改走旧 `/bind`，避免用户误以为已经智能选路。
- gateway-agent 协议可以基本保持不变，只要 agent 能处理 candidate binding 产生的创建/删除任务。

## 安全与资源控制

- Candidate binding 也必须校验端口 allowlist、账号权益、设备授权。
- Candidate 不计入最终用户 active binding 并发，但必须计入 agent 端口占用和 agent 负载。
- 每个用户同一时间最多一个 active prepare，防止恶意并发占端口。
- Candidate TTL 短，并由 cleanup 兜底回收。
- Commit 只能选择当前 user/device 自己 prepare 下的 binding。
- Probe 不发送 RDP 用户名和密码，只做协议握手。

## 验证计划

### 插件侧

- AgentSelector 在 2 个健康 Agent 时返回 2 个候选。
- AgentSelector 在 6 个健康 Agent 时返回 3 个候选。
- AgentSelector 在 12 个健康 Agent 时返回 4 个候选。
- prepare 创建 candidate binding，并等待 agent ACK。
- commit 将 winner 转正式 active，将 losers 标记 closing。
- abort 将所有 candidate 标记 closing。
- expired candidate 会被 cleanup 回收。

### NextDesk 侧

- RDP probe 成功时记录 TCP、X.224、TLS、total_ms。
- 多个候选中选择 total_ms 最低的成功项。
- 所有候选失败时调用 abort 并展示明确错误。
- probe 超时不会让连接一直转圈。
- winner commit 后正式 RDP 连接使用 winner endpoint。

### 联调

- 1 个 Agent：prepare 返回 1 个候选，行为接近旧 bind。
- 2-3 个 Agent：全部候选，能选出最快 endpoint。
- 6 个 Agent：默认只候选 3 个，用户等待时间不随 Agent 数量线性增长。
- 关闭一个 Agent：不会被选为候选。
- draining Agent：不会被选为候选。

## 第一版验收标准

- 多 Agent 场景下，NextDesk 连接前可以获得多个候选 endpoint。
- NextDesk 可以对候选 endpoint 完成 RDP 轻握手测速。
- Xboard commit 后只保留 winner binding。
- Loser binding 会进入 closing 并由 agent 删除 realm 规则。
- 用户等待时间目标：常规场景 2-5 秒。
- 失败时有明确错误，不静默直连，不无限转圈。


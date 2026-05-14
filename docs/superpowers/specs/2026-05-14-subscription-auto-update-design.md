# 订阅自动更新方案

> 在 Tauri 后端实现真正的 24 小时订阅自动同步，让 UI 上"自动更新已启用"的承诺与实际行为一致。

## 背景

订阅页面顶部显示蓝色提示框：

> ✅ 自动更新已启用 — 服务器列表每 24 小时自动同步

但代码中并不存在该功能：
- `src-tauri/src/subscription.rs` 只暴露 `load_subscription()`，仅在用户点击"更新"按钮或加载保存的订阅时调用
- `src-tauri/src/lib.rs` 没有任何 `tokio::spawn` 启动定时刷新任务
- 前端 `App.tsx` 只在 `handleUpdateSubscription` 中调用 `api.loadSubscription`，没有 `setInterval`

文案承诺的功能从未实现，需要补齐。

## 目标

1. 后台每 24 小时自动调用一次 `load_subscription`，更新服务器列表
2. 持久化"上次同步时间"，重启 app 后能正确"追平"24 小时周期，不会因关机时间漂移
3. 失败时可见：UI 显示橙色失败提示，并允许用户立即重试
4. 提供开关：用户可关闭自动更新（默认开启）
5. 与核心引擎 (Clash) 解耦：无论引擎是否运行都执行同步，统一使用直连方式拉取订阅

## 范围

### In scope
- 新增 Rust 调度器模块 `sub_scheduler.rs`
- 扩展 `SavedConfig` 持久化 `auto_update_enabled` 与 `last_sync_ts`
- 扩展 `AppState` 维护运行时状态 `sync_state`
- 新增 3 个 Tauri 命令：`get_auto_update_status`、`set_auto_update_enabled`、`trigger_sync_now`
- 重构前端订阅页提示框为动态状态条 + 开关
- i18n 中英文文案

### Out of scope
- 同步频率自定义（固定 24 小时，YAGNI）
- 多订阅 URL 管理（当前应用为单订阅）
- 通知中心 / 桌面通知（仅 UI 内展示状态）
- 订阅 URL 走代理拉取（已确认走直连，复用 `subscription::load_subscription` 已有的 `proxy_port: None` 路径）

## 架构

### 数据流

```
启动 (lib.rs setup)
   ↓
载入 SavedConfig {
   subscription_url, auto_update_enabled, last_sync_ts
}
   ↓
sub_scheduler::spawn(app_handle, app_state)
   ↓
loop (每 60 秒醒来):
  if !auto_update_enabled || subscription_url.is_empty():
     continue
  
  elapsed = now - last_sync_ts
  if elapsed >= 24h:
     sync_state = Syncing
     result = load_subscription(url, proxy_port=None)
     if result.success:
         last_sync_ts = now
         sync_state = Idle
         persist SavedConfig
     else:
         sync_state = Failed{ category: "网络错误" | "订阅已失效" | "未知错误" }
         sleep 5min
         retry once
         if 仍失败: 保留 Failed 状态，等下个 24h 周期
  else:
     // 等待时间未到，下次循环再判断
```

调度器醒来周期 60 秒的理由：
- 用户切换开关时，状态变化能在 1 分钟内被调度器观察到
- 用户保存新订阅 URL 时同理
- 不需要精确计时，订阅同步本身允许分钟级误差

### 数据结构

#### `src-tauri/src/config.rs` — `SavedConfig`

新增两个字段：

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SavedConfig {
    // ... 已有字段 ...

    #[serde(default = "default_auto_update_enabled")]
    pub auto_update_enabled: bool,    // 默认 true

    #[serde(default)]
    pub last_sync_ts: u64,             // Unix 秒，0 = 从未同步
}

fn default_auto_update_enabled() -> bool { true }
```

迁移：旧配置文件无此字段时，serde 用默认值填充（开启 + 时间戳 0），第一次调度器循环就会触发同步。

#### `src-tauri/src/state.rs` — `AppState`

新增三个字段：

```rust
pub struct AppState {
    // ... 已有字段 ...

    pub auto_update_enabled: Arc<Mutex<bool>>,
    pub last_sync_ts: Arc<Mutex<u64>>,
    pub sync_state: Arc<Mutex<SyncState>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum SyncState {
    Idle,
    Syncing,
    Failed { error_category: String, error_detail: String },
}
```

启动时 `apply_saved_config` 把 `SavedConfig` 中的两个字段同步到 `AppState`。`sync_state` 初始为 `Idle`。

### 新模块 `src-tauri/src/sub_scheduler.rs`

```rust
const SYNC_INTERVAL_SECS: u64 = 24 * 60 * 60;  // 24h
const RETRY_DELAY_SECS: u64 = 5 * 60;           // 5min
const POLL_INTERVAL_SECS: u64 = 60;             // 60s 调度器自身唤醒间隔

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(scheduler_loop(app));
}

async fn scheduler_loop(app: AppHandle) {
    loop {
        tokio::time::sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;
        let state = app.state::<AppState>();
        let should_sync = check_should_sync(&state);
        if should_sync {
            run_sync(&app, &state, /* allow_retry */ true).await;
        }
    }
}

fn check_should_sync(state: &AppState) -> bool {
    if !*state.auto_update_enabled.lock().unwrap() { return false; }
    let url = state.subscription_url.lock().unwrap().clone();
    if url.is_empty() { return false; }
    let last = *state.last_sync_ts.lock().unwrap();
    let now = unix_now();
    now.saturating_sub(last) >= SYNC_INTERVAL_SECS
}

async fn run_sync(app: &AppHandle, state: &AppState, allow_retry: bool) {
    let url = state.subscription_url.lock().unwrap().clone();
    set_sync_state(state, SyncState::Syncing);
    emit_sync_state(app, state);

    match subscription::load_subscription(&url, /* proxy_port */ None).await {
        Ok(parsed) => {
            apply_parsed_to_state(state, parsed);
            *state.last_sync_ts.lock().unwrap() = unix_now();
            set_sync_state(state, SyncState::Idle);
            persist_config(state);
        }
        Err(err) => {
            set_sync_state(state, SyncState::Failed {
                error_category: classify_error(&err),  // i18n key
                error_detail: err.clone(),
            });
            if allow_retry {
                tokio::time::sleep(Duration::from_secs(RETRY_DELAY_SECS)).await;
                Box::pin(run_sync(app, state, /* allow_retry */ false)).await;
            }
        }
    }
    emit_sync_state(app, state);
}

fn classify_error(err: &str) -> &'static str {
    let s = err.to_lowercase();
    if s.contains("timeout") || s.contains("connect") || s.contains("dns") || s.contains("resolve") {
        "network_error"
    } else if s.contains("401") || s.contains("403") || s.contains("unauthorized") {
        "subscription_invalid"
    } else {
        "unknown_error"
    }
}
```

`error_category` 是固定的英文 i18n key 字符串，前端 `t()` 时映射到 `errorCategoryNetwork` 等翻译。

### Tauri 事件

调度器在状态变化时 `emit_all("subscription_sync_state", &payload)`，前端通过 `listen` 接收实时更新。

替代轮询 `get_auto_update_status` 的方案：前端启动时一次性拉取，之后靠事件推。

### 新增 Tauri Commands

| 命令 | 输入 | 输出 |
|:---|:---|:---|
| `get_auto_update_status` | — | `{ enabled, last_sync_ts, sync_state }` |
| `set_auto_update_enabled` | `enabled: bool` | `()` (并立即持久化) |
| `trigger_sync_now` | — | `()` (立即在后台触发一次同步，复用 `run_sync`) |

`trigger_sync_now` 的作用：
- UI 上的"立即重试"按钮
- 也可作为现有手动"更新订阅"按钮的统一入口（待 Plan 阶段决定是否复用，本 Spec 不强制）

### 与现有 `load_subscription` 命令的关系

现有 `load_subscription(url)` Tauri 命令是给前端"用户手动输入新 URL 并加载"用的。本设计**不修改** `load_subscription`，但要求：
- 在 `load_subscription` 成功路径中**也更新 `last_sync_ts = now`**，保证手动加载后 24h 周期会重新计时（避免用户刚手动同步完又被自动同步打扰）
- 这是一处微小但必要的改动，写在 `lib.rs::load_subscription` 命令中

## UI 设计

### 订阅页提示框（替换原蓝色静态提示）

订阅页 `App.tsx` 的现有蓝色提示框 (`autoUpdateEnabled` + `serverListSync`) 改为**动态状态条 + 开关**：

```
┌──────────────────────────────────────────────────────────────┐
│ ✅ 自动更新已启用                                    [开关] │
│    上次同步：2 小时前                                        │
└──────────────────────────────────────────────────────────────┘
```

#### 状态映射

| `sync_state`      | 条件                          | 颜色 | 主文案                  | 副文案                |
|:------------------|:------------------------------|:-----|:------------------------|:----------------------|
| `Idle`            | `auto_update_enabled=true`, `last_sync_ts>0` | 蓝   | 自动更新已启用          | 上次同步：X 小时前    |
| `Idle`            | `auto_update_enabled=true`, `last_sync_ts=0` | 蓝   | 自动更新已启用          | 服务器列表每 24 小时自动同步 |
| `Idle`            | `auto_update_enabled=false`   | 灰   | 自动更新已关闭          | (无)                  |
| `Syncing`         | —                             | 蓝   | 自动更新已启用          | 上次同步：X 小时前    |
| `Failed`          | —                             | 橙   | ⚠ 自动同步失败 (网络错误) | [立即重试] 按钮       |

注：
- `Syncing` 状态在 UI 上不做特殊视觉变化（按用户要求"进行中不需要修改"），文案保持 Idle 文案不变
- 失败态文案不显示"上次同步：X 小时前"，只显示错误原因和重试按钮（按用户要求"去掉上次"）

#### 时间格式

`X 小时前` 的实现：前端用 `now - last_sync_ts * 1000` 计算差值并格式化：
- < 1 分钟：`刚刚`
- < 60 分钟：`X 分钟前`
- < 24 小时：`X 小时前`
- 否则：`X 天前`

复用项目内是否已有时间格式化工具？需在 Plan 阶段确认；若无则新增 `frontend/src/lib/timeAgo.ts`。

### 开关交互

- 默认开启
- 关闭时立即写入持久化配置；调度器在下次 60s 唤醒时停止后续同步
- 关闭状态下点击"立即同步"按钮（如果暴露）仍然可以触发一次同步，但同步完成后不会重置 24h 周期

### i18n keys

新增中英对照：

| key                            | 中                                | EN                                                |
|:-------------------------------|:----------------------------------|:--------------------------------------------------|
| `autoUpdateDisabled`           | 自动更新已关闭                    | Auto-Update Disabled                              |
| `lastSyncedAgo`                | 上次同步：{time}                  | Last synced: {time}                               |
| `timeAgoJustNow`               | 刚刚                              | just now                                          |
| `timeAgoMinutes`               | {n} 分钟前                        | {n} minute(s) ago                                 |
| `timeAgoHours`                 | {n} 小时前                        | {n} hour(s) ago                                   |
| `timeAgoDays`                  | {n} 天前                          | {n} day(s) ago                                    |
| `autoSyncFailed`               | 自动同步失败 ({reason})           | Auto-sync failed ({reason})                       |
| `syncRetryNow`                 | 立即重试                          | Retry Now                                         |
| `errorCategoryNetwork`         | 网络错误                          | Network error                                     |
| `errorCategorySubscriptionInvalid` | 订阅已失效                    | Subscription expired                              |
| `errorCategoryUnknown`         | 未知错误                          | Unknown error                                     |

保留并复用已有的 `autoUpdateEnabled` 和 `serverListSync`。

## 错误处理

### 错误分类

`subscription::load_subscription` 已有的 `String` 错误按关键字归类：

| 关键字（不区分大小写）               | 类别                  |
|:--------------------------------------|:----------------------|
| `timeout`, `connect`, `dns`, `resolve` | `network_error`       |
| `401`, `403`, `unauthorized`           | `subscription_invalid`|
| 其他                                   | `unknown_error`       |

详细错误字符串保留在 `error_detail` 中（前端不展示，但可写日志方便排查）。

### 边界条件

| 场景                                | 行为                                                       |
|:------------------------------------|:-----------------------------------------------------------|
| 订阅 URL 为空                       | 调度器跳过，`sync_state` 保持 `Idle`                       |
| `auto_update_enabled = false`       | 调度器跳过                                                 |
| App 启动后立即关闭 (调度器未唤醒)   | 无副作用，调度器随 tokio runtime 终止                      |
| 用户手动点击"更新订阅"成功          | 同步刷新 `last_sync_ts`，下次自动同步从该时间点起 24h 后   |
| `last_sync_ts > now` (系统时间倒退) | 视为"未到 24h"，正常等待；`saturating_sub` 防止下溢       |
| 同步过程中关闭 app                  | 同步任务被中断，下次启动重试                               |
| 重试期间用户切换开关到 off          | 重试仍会完成（已经 spawn），但完成后调度器停止后续         |

## 测试

### 后端单元测试

`sub_scheduler.rs` 中的纯函数易于单测：
- `classify_error` — 给定典型错误字符串，返回正确类别
- `check_should_sync` — 各种 state 组合下返回正确布尔

### 集成测试 (手动验证步骤)

1. **首次同步**：清空 `last_sync_ts`，启动 app → 调度器在 60s 内触发同步
2. **24h 追平**：手动把 `last_sync_ts` 改成 `now - 25h` 后启动 → 应立即同步
3. **24h 未到**：手动把 `last_sync_ts` 改成 `now - 12h` 启动 → 应不同步，再等 12h 才触发
4. **失败 + 重试**：把订阅 URL 改成不可达地址 → 立即看到 Failed 状态，5 分钟后调度器重试一次
5. **开关关闭**：UI 关闭开关 → 60s 内 `auto_update_enabled` 写入配置文件，关闭期间不再同步
6. **手动同步影响周期**：手动点击更新订阅成功 → `last_sync_ts` 更新，24h 内不再自动同步

### Rust 编译 & TS 编译

- `cargo build` 在 `src-tauri/` 通过
- `npx tsc --noEmit` 在 `frontend/` 通过
- `npx vite build` 通过

## 改动清单

| 文件                                                | 性质 | 摘要                                                          |
|:----------------------------------------------------|:-----|:--------------------------------------------------------------|
| `src-tauri/src/sub_scheduler.rs`                    | 新建 | 调度器主循环 + run_sync + classify_error                      |
| `src-tauri/src/lib.rs`                              | 改   | mod 注册、setup 中 spawn、3 个新命令、`load_subscription` 命令成功路径写 `last_sync_ts` |
| `src-tauri/src/state.rs`                            | 改   | `AppState` 新增 3 个字段、`SyncState` enum                    |
| `src-tauri/src/config.rs`                           | 改   | `SavedConfig` 新增 `auto_update_enabled`、`last_sync_ts`，写默认值 |
| `frontend/src/api.ts`                               | 改   | 暴露 3 个新命令的 wrapper、新增 `SyncStatus` / `SyncState` 类型 |
| `frontend/src/App.tsx`                              | 改   | 替换静态提示框为动态状态条 + Switch + Retry 按钮、订阅事件监听 |
| `frontend/src/lib/timeAgo.ts`                       | 新建（如不存在） | 时间差人类可读格式化                              |
| `frontend/src/i18n/translations.ts`                 | 改   | 新增上述 i18n keys                                            |

预计 LOC：Rust 约 200，TypeScript 约 150。

## 决策记录

| 决策点                          | 选择                       | 理由                                                          |
|:--------------------------------|:---------------------------|:--------------------------------------------------------------|
| 同步触发模式                    | 持久化 last_sync_ts 追平   | 符合"每 24h 同步"的语义，避免开关机时间漂移                   |
| 失败处理                        | 5 分钟重试一次 + UI 提示   | 容忍短暂网络抖动，同时让用户对失败可见                        |
| 与核心引擎关系                  | 完全独立                   | 用户可能未启动引擎，订阅 URL 通常直连可达                     |
| 自动更新开关                    | 提供，默认开启             | 给用户最终控制权，但默认行为符合 UI 承诺                      |
| 重试策略                        | 单次固定 5 分钟            | 简单可预测，复杂指数退避对此场景过度                          |
| 调度器醒来周期                  | 60 秒                      | 平衡响应性（开关变化、URL 变化）和 CPU 占用                   |
| 错误分类粒度                    | 3 类（网络 / 失效 / 未知） | 用户层够用，详细字符串保留在日志和 `error_detail` 中          |

# 订阅自动更新 实施计划

> **给 Agent 执行者：** 必须使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务执行本计划。步骤使用 checkbox (`- [ ]`) 语法跟踪进度。

**目标：** 实现后台调度器，每 24 小时自动同步订阅，持久化上次同步时间，失败时 UI 提示，并提供用户开关。

**架构：** 新建 Rust 模块 `sub_scheduler.rs`，spawn 一个 tokio 循环每 60 秒醒来，检查距 `last_sync_ts` 是否已过 24h，若是则调用 `load_subscription(url, proxy_port=None)` 直连拉取。状态变化通过 Tauri 事件推送到前端。前端将静态蓝色提示框替换为动态状态条 + Switch 开关。

**技术栈：** Rust (Tauri 2, tokio), React 19, TypeScript, Tailwind CSS v4, ShadcnUI Switch

---

## 文件结构

| 文件 | 操作 | 职责 |
|:-----|:-----|:-----|
| `src-tauri/src/sub_scheduler.rs` | 新建 | 后台调度循环、同步执行、错误分类 |
| `src-tauri/src/state.rs` | 修改 | 新增 `SyncState` 枚举、AppState 3 个新字段 |
| `src-tauri/src/config.rs` | 修改 | SavedConfig 新增 `auto_update_enabled`、`last_sync_ts` |
| `src-tauri/src/lib.rs` | 修改 | 注册模块、setup 中 spawn、3 个新命令、`load_subscription` 写 `last_sync_ts` |
| `frontend/src/api.ts` | 修改 | 新增 `AutoUpdateStatus`、`SyncState` 类型，3 个 API 方法 |
| `frontend/src/lib/timeAgo.ts` | 新建 | 相对时间格式化工具 |
| `frontend/src/i18n/translations.ts` | 修改 | 新增中英文 i18n keys |
| `frontend/src/App.tsx` | 修改 | 替换静态提示框为动态状态条 + Switch + 事件监听 |

---

### 任务 1：给 AppState 添加 SyncState 枚举和新字段

**文件：**
- 修改：`src-tauri/src/state.rs`

- [ ] **步骤 1：添加 `SyncState` 枚举和新字段**

在 `state.rs` 现有 imports 之后添加：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SyncState {
    Idle,
    Syncing,
    Failed { error_category: String, error_detail: String },
}

impl Default for SyncState {
    fn default() -> Self {
        SyncState::Idle
    }
}
```

在 `AppState` 结构体中（`relay_endpoints` 之后）添加三个字段：

```rust
    pub auto_update_enabled: Arc<Mutex<bool>>,
    pub last_sync_ts: Arc<Mutex<u64>>,
    pub sync_state: Arc<Mutex<SyncState>>,
```

在 `impl Default for AppState` 中（`relay_endpoints` 之后）添加：

```rust
            auto_update_enabled: Arc::new(Mutex::new(true)),
            last_sync_ts: Arc::new(Mutex::new(0)),
            sync_state: Arc::new(Mutex::new(SyncState::default())),
```

- [ ] **步骤 2：验证编译**

运行：`cargo check`（在 `src-tauri/` 目录）
预期：编译无错误

- [ ] **步骤 3：提交**

```bash
git add src-tauri/src/state.rs
git commit -m "feat(state): add SyncState enum and auto-update fields to AppState"
```

---

### 任务 2：扩展 SavedConfig 持久化字段

**文件：**
- 修改：`src-tauri/src/config.rs`

- [ ] **步骤 1：给 SavedConfig 添加字段**

在 `SavedConfig` 结构体末尾添加两个新字段：

```rust
    #[serde(default = "default_auto_update_enabled")]
    pub auto_update_enabled: bool,
    #[serde(default)]
    pub last_sync_ts: u64,
```

在结构体之后（`load_saved_config` 之前）添加默认值函数：

```rust
fn default_auto_update_enabled() -> bool {
    true
}
```

- [ ] **步骤 2：验证编译**

运行：`cargo check`（在 `src-tauri/` 目录）
预期：可能因现有 `SavedConfig { ... }` 构造处缺少新字段而报错 — 这是预期的，在任务 4 中修复。

- [ ] **步骤 3：提交**

```bash
git add src-tauri/src/config.rs
git commit -m "feat(config): add auto_update_enabled and last_sync_ts to SavedConfig"
```

---

### 任务 3：创建 sub_scheduler.rs

**文件：**
- 新建：`src-tauri/src/sub_scheduler.rs`

- [ ] **步骤 1：编写调度器模块**

创建 `src-tauri/src/sub_scheduler.rs`，内容如下：

```rust
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};

use crate::config;
use crate::state::{AppState, ProxyGroup, SyncState};
use crate::subscription;

const SYNC_INTERVAL_SECS: u64 = 24 * 60 * 60;
const RETRY_DELAY_SECS: u64 = 5 * 60;
const POLL_INTERVAL_SECS: u64 = 60;

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(scheduler_loop(app));
}

async fn scheduler_loop(app: AppHandle) {
    loop {
        tokio::time::sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;
        let state = app.state::<AppState>();
        if !should_sync(&state) {
            continue;
        }
        run_sync(&app, &state, true).await;
    }
}

fn should_sync(state: &AppState) -> bool {
    let enabled = *state.auto_update_enabled.lock().unwrap();
    if !enabled {
        return false;
    }
    let url = state.subscription_url.lock().unwrap().clone();
    if url.is_empty() {
        return false;
    }
    let last = *state.last_sync_ts.lock().unwrap();
    unix_now().saturating_sub(last) >= SYNC_INTERVAL_SECS
}

async fn run_sync(app: &AppHandle, state: &AppState, allow_retry: bool) {
    let url = state.subscription_url.lock().unwrap().clone();
    if url.is_empty() {
        return;
    }

    *state.sync_state.lock().unwrap() = SyncState::Syncing;
    emit_sync_state(app, state);

    match subscription::load_subscription(&url, None).await {
        Ok(parsed) => {
            let servers = subscription::transform_proxies_to_servers(&parsed.proxies);
            *state.servers.lock().unwrap() = servers.clone();

            let groups: Vec<ProxyGroup> = parsed
                .proxy_groups
                .iter()
                .filter_map(|g| {
                    let name = g.get("name")?.as_str()?.to_string();
                    let gtype = g.get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("select")
                        .to_string();
                    let proxies: Vec<String> = g
                        .get("proxies")
                        .and_then(|v| v.as_sequence())
                        .map(|seq| seq.iter().filter_map(|p| p.as_str().map(|s| s.to_string())).collect())
                        .unwrap_or_default();
                    Some(ProxyGroup { name, group_type: gtype, proxies, now: None })
                })
                .collect();
            *state.proxy_groups.lock().unwrap() = groups;

            if let Some(raw) = &parsed.raw_config {
                config::generate_clash_config_from_subscription(raw);
            } else {
                config::generate_clash_config(&parsed.proxies);
            }

            *state.last_sync_ts.lock().unwrap() = unix_now();
            *state.sync_state.lock().unwrap() = SyncState::Idle;
            persist_config(state);
            log::info!("[sub_scheduler] Auto-sync OK, {} servers", servers.len());
        }
        Err(err) => {
            log::warn!("[sub_scheduler] Auto-sync failed: {err}");
            *state.sync_state.lock().unwrap() = SyncState::Failed {
                error_category: classify_error(&err).to_string(),
                error_detail: err.clone(),
            };
            emit_sync_state(app, state);

            if allow_retry {
                log::info!("[sub_scheduler] Retry in {}s...", RETRY_DELAY_SECS);
                tokio::time::sleep(Duration::from_secs(RETRY_DELAY_SECS)).await;
                Box::pin(run_sync(app, state, false)).await;
                return;
            }
        }
    }
    emit_sync_state(app, state);
}

pub async fn trigger_sync(app: &AppHandle) {
    let state = app.state::<AppState>();
    run_sync(app, &state, true).await;
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

fn emit_sync_state(app: &AppHandle, state: &AppState) {
    let sync_state = state.sync_state.lock().unwrap().clone();
    let last_sync_ts = *state.last_sync_ts.lock().unwrap();
    let enabled = *state.auto_update_enabled.lock().unwrap();
    let payload = serde_json::json!({
        "enabled": enabled,
        "last_sync_ts": last_sync_ts,
        "sync_state": sync_state,
    });
    let _ = app.emit("subscription_sync_state", payload);
}

fn persist_config(state: &AppState) {
    let saved = config::SavedConfig {
        subscription_url: state.subscription_url.lock().unwrap().clone(),
        servers: state.servers.lock().unwrap().clone(),
        proxy_groups: state.proxy_groups.lock().unwrap().clone(),
        tube_enabled: *state.tube_enabled.lock().unwrap(),
        cloud_mode: *state.cloud_mode.lock().unwrap(),
        dashboard_url: state.dashboard_url.lock().unwrap().clone(),
        relay_api_key: state.relay_api_key.lock().unwrap().clone(),
        auto_update_enabled: *state.auto_update_enabled.lock().unwrap(),
        last_sync_ts: *state.last_sync_ts.lock().unwrap(),
    };
    config::save_config(&saved);
}
```

- [ ] **步骤 2：提交**

```bash
git add src-tauri/src/sub_scheduler.rs
git commit -m "feat: add subscription auto-update scheduler module"
```

---

### 任务 4：在 lib.rs 中接入调度器

**文件：**
- 修改：`src-tauri/src/lib.rs`

- [ ] **步骤 1：声明模块**

在 `mod subscription;` 之后添加：

```rust
mod sub_scheduler;
```

- [ ] **步骤 2：在 `run()` 中加载新配置字段**

在 `pub fn run()` 中，现有行：
```rust
    *app_state.relay_api_key.lock().unwrap() = saved.relay_api_key;
```
之后添加：
```rust
    *app_state.auto_update_enabled.lock().unwrap() = saved.auto_update_enabled;
    *app_state.last_sync_ts.lock().unwrap() = saved.last_sync_ts;
```

- [ ] **步骤 3：在 setup 中 spawn 调度器**

在 `.setup(|app| { ... })` 中，`rdp_proxy::start_proxy` spawn 块之后添加：

```rust
            // Spawn subscription auto-update scheduler
            let app_handle = app.handle().clone();
            sub_scheduler::spawn(app_handle);
```

- [ ] **步骤 4：添加三个新 Tauri 命令**

在 `pub fn run()` 之前添加：

```rust
#[tauri::command]
fn get_auto_update_status(
    app_state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let enabled = *app_state.auto_update_enabled.lock().unwrap();
    let last_sync_ts = *app_state.last_sync_ts.lock().unwrap();
    let sync_state = app_state.sync_state.lock().unwrap().clone();
    Ok(serde_json::json!({
        "enabled": enabled,
        "last_sync_ts": last_sync_ts,
        "sync_state": sync_state,
    }))
}

#[tauri::command]
fn set_auto_update_enabled(
    enabled: bool,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    *app_state.auto_update_enabled.lock().unwrap() = enabled;
    let mut saved = config::load_saved_config();
    saved.auto_update_enabled = enabled;
    config::save_config(&saved);
    log::info!("[sub_scheduler] Auto-update set to: {enabled}");
    Ok(())
}

#[tauri::command]
async fn trigger_sync_now(app: AppHandle) -> Result<(), String> {
    sub_scheduler::trigger_sync(&app).await;
    Ok(())
}
```

如果顶部没有 `use tauri::AppHandle;`，需要添加。

- [ ] **步骤 5：注册命令到 invoke_handler**

在 `tauri::generate_handler![...]` 列表中添加：

```rust
            get_auto_update_status,
            set_auto_update_enabled,
            trigger_sync_now,
```

- [ ] **步骤 6：更新 `load_subscription` 命令以包含新字段**

在 `load_subscription` 命令的成功路径中，更新 `config::SavedConfig { ... }` 构造，加入：

```rust
                auto_update_enabled: *app_state.auto_update_enabled.lock().unwrap(),
                last_sync_ts: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
```

在 `config::save_config(&saved);` 之后，更新内存中的时间戳：

```rust
            *app_state.last_sync_ts.lock().unwrap() = saved.last_sync_ts;
```

- [ ] **步骤 7：验证编译**

运行：`cargo check`（在 `src-tauri/` 目录）
预期：编译无错误

- [ ] **步骤 8：提交**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(lib): wire sub_scheduler, add auto-update commands"
```

---

### 任务 5：前端 API 类型和方法

**文件：**
- 修改：`frontend/src/api.ts`

- [ ] **步骤 1：添加类型**

在 `UpdateInfo` 接口之后添加：

```typescript
export interface SyncState {
  type: 'Idle' | 'Syncing' | 'Failed';
  error_category?: string;
  error_detail?: string;
}

export interface AutoUpdateStatus {
  enabled: boolean;
  last_sync_ts: number;
  sync_state: SyncState;
}
```

- [ ] **步骤 2：添加 API 方法**

在 `api` 对象中（`getRelayEndpoints` 之后）添加：

```typescript
  // ── 订阅自动更新 ────────────────────────────────────
  getAutoUpdateStatus: () =>
    invoke<AutoUpdateStatus>('get_auto_update_status'),

  setAutoUpdateEnabled: (enabled: boolean) =>
    invoke<void>('set_auto_update_enabled', { enabled }),

  triggerSyncNow: () =>
    invoke<void>('trigger_sync_now'),
```

- [ ] **步骤 3：验证 TS 编译**

运行：`npx tsc --noEmit`（在 `frontend/` 目录）
预期：无错误

- [ ] **步骤 4：提交**

```bash
git add frontend/src/api.ts
git commit -m "feat(api): add auto-update status types and methods"
```

---

### 任务 6：创建 timeAgo 工具函数

**文件：**
- 新建：`frontend/src/lib/timeAgo.ts`

- [ ] **步骤 1：编写工具函数**

```typescript
/**
 * 将 Unix 时间戳（秒）转换为相对时间的翻译 key 和插值参数。
 * @param unixSeconds - 后端返回的 last_sync_ts（Unix 秒）
 */
export function getTimeAgo(unixSeconds: number): { key: string; n: number } {
  if (unixSeconds === 0) {
    return { key: 'timeAgoNever', n: 0 };
  }

  const now = Math.floor(Date.now() / 1000);
  const diff = now - unixSeconds;

  if (diff < 60) {
    return { key: 'timeAgoJustNow', n: 0 };
  }
  if (diff < 3600) {
    return { key: 'timeAgoMinutes', n: Math.floor(diff / 60) };
  }
  if (diff < 86400) {
    return { key: 'timeAgoHours', n: Math.floor(diff / 3600) };
  }
  return { key: 'timeAgoDays', n: Math.floor(diff / 86400) };
}
```

- [ ] **步骤 2：验证 TS 编译**

运行：`npx tsc --noEmit`（在 `frontend/` 目录）
预期：无错误

- [ ] **步骤 3：提交**

```bash
git add frontend/src/lib/timeAgo.ts
git commit -m "feat: add timeAgo relative time utility"
```

---

### 任务 7：添加 i18n 翻译

**文件：**
- 修改：`frontend/src/i18n/translations.ts`

- [ ] **步骤 1：添加英文翻译**

在英文部分 `serverListSync` 之后添加：

```typescript
    autoUpdateDisabled: 'Auto-Update Disabled',
    lastSyncedAgo: 'Last synced: {time}',
    timeAgoJustNow: 'just now',
    timeAgoMinutes: '{n} min ago',
    timeAgoHours: '{n} hour(s) ago',
    timeAgoDays: '{n} day(s) ago',
    timeAgoNever: 'never',
    autoSyncFailed: 'Auto-sync failed ({reason})',
    syncRetryNow: 'Retry Now',
    errorCategoryNetwork: 'Network error',
    errorCategorySubscriptionInvalid: 'Subscription expired',
    errorCategoryUnknown: 'Unknown error',
```

- [ ] **步骤 2：添加中文翻译**

在中文部分 `serverListSync` 之后添加：

```typescript
    autoUpdateDisabled: '自动更新已关闭',
    lastSyncedAgo: '上次同步：{time}',
    timeAgoJustNow: '刚刚',
    timeAgoMinutes: '{n} 分钟前',
    timeAgoHours: '{n} 小时前',
    timeAgoDays: '{n} 天前',
    timeAgoNever: '从未',
    autoSyncFailed: '自动同步失败 ({reason})',
    syncRetryNow: '立即重试',
    errorCategoryNetwork: '网络错误',
    errorCategorySubscriptionInvalid: '订阅已失效',
    errorCategoryUnknown: '未知错误',
```

- [ ] **步骤 3：验证 TS 编译**

运行：`npx tsc --noEmit`（在 `frontend/` 目录）
预期：无错误

- [ ] **步骤 4：提交**

```bash
git add frontend/src/i18n/translations.ts
git commit -m "feat(i18n): add auto-update status translations (CN + EN)"
```

---

### 任务 8：替换静态提示框为动态状态条 + Switch

**文件：**
- 修改：`frontend/src/App.tsx`

- [ ] **步骤 1：添加 imports 和 state**

在 `App.tsx` 顶部现有 imports 中添加：

```typescript
import { listen } from '@tauri-apps/api/event';
import { Switch } from '@/components/ui/switch';
```

添加新类型和工具的 import：

```typescript
import { AutoUpdateStatus, SyncState } from './api';
import { getTimeAgo } from './lib/timeAgo';
```

在主组件函数内添加 state：

```typescript
  const [autoUpdateStatus, setAutoUpdateStatus] = useState<AutoUpdateStatus>({
    enabled: true,
    last_sync_ts: 0,
    sync_state: { type: 'Idle' },
  });
```

- [ ] **步骤 2：添加 useEffect 获取初始状态并监听事件**

```typescript
  // 获取自动更新状态 + 监听变化
  useEffect(() => {
    api.getAutoUpdateStatus().then(setAutoUpdateStatus).catch(console.error);

    const unlisten = listen<AutoUpdateStatus>('subscription_sync_state', (event) => {
      setAutoUpdateStatus(event.payload);
    });

    return () => { unlisten.then(fn => fn()); };
  }, []);
```

- [ ] **步骤 3：添加开关和重试处理函数**

```typescript
  const handleAutoUpdateToggle = async (enabled: boolean) => {
    try {
      await api.setAutoUpdateEnabled(enabled);
      setAutoUpdateStatus(prev => ({ ...prev, enabled }));
    } catch (e) {
      console.error('Failed to toggle auto-update:', e);
    }
  };

  const handleRetrySync = async () => {
    try {
      await api.triggerSyncNow();
    } catch (e) {
      console.error('Failed to trigger sync:', e);
    }
  };
```

- [ ] **步骤 4：替换静态提示框**

找到现有的静态蓝色提示框（约第 897-907 行）：

```tsx
                  <div className="bg-blue-500/5 border border-blue-500/10 rounded-md p-4">
                    <div className="flex gap-3">
                      <CheckCircle2 className="h-5 w-5 text-blue-500 shrink-0" />
                      <div>
                        <h4 className="text-sm font-medium text-blue-400 mb-1">{t('autoUpdateEnabled')}</h4>
                        <p className="text-xs text-blue-400/60 leading-relaxed">
                          {t('serverListSync')}
                        </p>
                      </div>
                    </div>
                  </div>
```

替换为：

```tsx
                  {/* 自动更新状态条 */}
                  {autoUpdateStatus.sync_state.type === 'Failed' ? (
                    <div className="bg-orange-500/5 border border-orange-500/20 rounded-md p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex gap-3 items-center">
                          <AlertTriangle className="h-5 w-5 text-orange-500 shrink-0" />
                          <span className="text-sm font-medium text-orange-400">
                            {t('autoSyncFailed').replace(
                              '{reason}',
                              t(
                                autoUpdateStatus.sync_state.error_category === 'network_error'
                                  ? 'errorCategoryNetwork'
                                  : autoUpdateStatus.sync_state.error_category === 'subscription_invalid'
                                  ? 'errorCategorySubscriptionInvalid'
                                  : 'errorCategoryUnknown'
                              )
                            )}
                          </span>
                        </div>
                        <div className="flex items-center gap-3">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleRetrySync}
                            className="text-orange-400 hover:text-orange-300 text-xs"
                          >
                            {t('syncRetryNow')}
                          </Button>
                          <Switch
                            checked={autoUpdateStatus.enabled}
                            onCheckedChange={handleAutoUpdateToggle}
                          />
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className={cn(
                      "rounded-md p-4 border",
                      autoUpdateStatus.enabled
                        ? "bg-blue-500/5 border-blue-500/10"
                        : "bg-muted/30 border-border"
                    )}>
                      <div className="flex items-center justify-between">
                        <div className="flex gap-3 items-center">
                          <CheckCircle2 className={cn(
                            "h-5 w-5 shrink-0",
                            autoUpdateStatus.enabled ? "text-blue-500" : "text-muted-foreground"
                          )} />
                          <div>
                            <h4 className={cn(
                              "text-sm font-medium mb-0.5",
                              autoUpdateStatus.enabled ? "text-blue-400" : "text-muted-foreground"
                            )}>
                              {autoUpdateStatus.enabled ? t('autoUpdateEnabled') : t('autoUpdateDisabled')}
                            </h4>
                            {autoUpdateStatus.enabled && (
                              <p className="text-xs text-blue-400/60">
                                {autoUpdateStatus.last_sync_ts > 0
                                  ? t('lastSyncedAgo').replace('{time}', (() => {
                                      const { key, n } = getTimeAgo(autoUpdateStatus.last_sync_ts);
                                      return t(key).replace('{n}', String(n));
                                    })())
                                  : t('serverListSync')
                                }
                              </p>
                            )}
                          </div>
                        </div>
                        <Switch
                          checked={autoUpdateStatus.enabled}
                          onCheckedChange={handleAutoUpdateToggle}
                        />
                      </div>
                    </div>
                  )}
```

注意：如果顶部 lucide-react import 中没有 `AlertTriangle`，需要添加。

- [ ] **步骤 5：验证 TS 编译**

运行：`npx tsc --noEmit`（在 `frontend/` 目录）
预期：无错误

- [ ] **步骤 6：验证 Vite 构建**

运行：`npx vite build`（在 `frontend/` 目录）
预期：构建成功

- [ ] **步骤 7：提交**

```bash
git add frontend/src/App.tsx
git commit -m "feat(ui): replace static auto-update banner with dynamic status bar + switch"
```

---

### 任务 9：完整集成验证

- [ ] **步骤 1：Cargo 构建**

运行：`cargo build`（在 `src-tauri/` 目录）
预期：编译无错误

- [ ] **步骤 2：前端构建**

运行：`npx vite build`（在 `frontend/` 目录）
预期：构建成功

- [ ] **步骤 3：手动冒烟测试清单**

1. 启动 app，config 中无 `last_sync_ts` → 调度器应在 60s 内触发同步
2. 手动设置 `last_sync_ts` 为 `now - 25h` → 应在下次轮询时同步
3. 手动设置 `last_sync_ts` 为 `now - 12h` → 不应同步
4. 关闭开关 → 验证 config.json 中 `auto_update_enabled: false`
5. 开关关闭状态下等待 2 分钟 → 不触发同步
6. 将订阅 URL 设为不可达地址 → 验证橙色失败提示出现
7. 点击"立即重试" → 验证重试执行
8. 手动点击"更新订阅"按钮 → 验证 `last_sync_ts` 更新

- [ ] **步骤 4：最终提交**

```bash
git add -A
git commit -m "feat: subscription auto-update - complete implementation"
```

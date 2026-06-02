# 独立内核模式专用化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 禁用复用模式自动检测，NextDesk 始终使用独立内核模式运行 RDP 加速

**Architecture:** 注释掉 `lib.rs` 中所有复用模式的检测和分支逻辑，前端 UI 移除复用模式相关显示，始终展示独立内核状态

**Tech Stack:** Rust (Tauri 2), React 19 + TypeScript

---

### Task 1: 注释掉 `run()` 中的同步外部 Clash 检测

**Files:**
- Modify: `src-tauri/src/lib.rs:982-1057`

- [ ] **Step 1: 注释掉同步检测块**

将 `run()` 函数中第 982-1057 行的同步检测逻辑整块注释掉：

```rust
    // [DISABLED] 复用模式暂时禁用，始终使用独立内核
    // 待独立内核模式成熟后删除此段注释代码
    // ─────────────────────────────────────────────
    // // Synchronously detect external Clash
    // // (pure std::net, no tokio/async)
    // {
    //     use std::io::{Read, Write};
    //     use std::net::TcpStream;
    //     use std::time::Duration;
    //
    //     let ports: &[u16] = &[9090, 9097, 7891, 7890];
    //     let timeout = Duration::from_secs(1);
    //
    //     for &port in ports {
    //         let addr = format!("127.0.0.1:{port}");
    //         if let Ok(mut stream) =
    //             TcpStream::connect_timeout(
    //                 &addr.parse().unwrap(),
    //                 timeout,
    //             )
    //         {
    //             stream
    //                 .set_read_timeout(Some(timeout))
    //                 .ok();
    //             stream
    //                 .set_write_timeout(Some(timeout))
    //                 .ok();
    //             let req = format!(
    //                 "GET /version HTTP/1.1\r\n\
    //                  Host: 127.0.0.1:{port}\r\n\
    //                  Connection: close\r\n\r\n"
    //             );
    //             if stream
    //                 .write_all(req.as_bytes())
    //                 .is_ok()
    //             {
    //                 let mut buf = vec![0u8; 1024];
    //                 if let Ok(n) =
    //                     stream.read(&mut buf)
    //                 {
    //                     let resp =
    //                         String::from_utf8_lossy(
    //                             &buf[..n],
    //                         );
    //                     if resp.contains("200")
    //                         && resp.contains("version")
    //                     {
    //                         let api = format!(
    //                             "http://127.0.0.1:{port}"
    //                         );
    //                         eprintln!(
    //                             "[init] Detected external Clash at {api}"
    //                         );
    //
    //                         let pp =
    //                             get_proxy_port_sync(
    //                                 port,
    //                             );
    //                         *app_state
    //                             .clash_api_base
    //                             .lock()
    //                             .unwrap() = api;
    //                         *app_state
    //                             .proxy_port
    //                             .lock()
    //                             .unwrap() = pp;
    //                         *app_state
    //                             .reuse_mode
    //                             .lock()
    //                             .unwrap() = true;
    //                         break;
    //                     }
    //                 }
    //             }
    //         }
    //     }
    //     if !*app_state.reuse_mode.lock().unwrap() {
    //         eprintln!(
    //             "[init] No external Clash detected"
    //         );
    //     }
    // }
    // ─────────────────────────────────────────────
    eprintln!("[init] Independent kernel mode — skipping external Clash detection");
```

- [ ] **Step 2: 验证编译通过**

Run: `cd src-tauri && cargo check`
Expected: 编译通过，可能有 dead_code warnings（`get_proxy_port_sync` 不再被调用），这是预期的

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: disable sync external Clash detection in run() — independent kernel only"
```

---

### Task 2: 注释掉 `start_engine` 中的异步外部 Clash 检测

**Files:**
- Modify: `src-tauri/src/lib.rs:27-55` (start_engine 函数开头)

- [ ] **Step 1: 注释掉 detect_external_clash 逻辑**

将 `start_engine` 函数中的复用模式检测逻辑注释掉：

```rust
#[tauri::command]
async fn start_engine(
    app_state: State<'_, AppState>,
    force_internal: Option<bool>,
) -> Result<bool, String> {
    // [DISABLED] 复用模式暂时禁用，始终使用独立内核
    // 待独立内核模式成熟后删除此段注释代码
    // ─────────────────────────────────────────────
    // let force = force_internal.unwrap_or(false);
    // if !force {
    //     if let Some((host, port)) =
    //         clash::detect_external_clash().await
    //     {
    //         let api = format!("http://{host}:{port}");
    //         let proxy_port =
    //             clash::get_clash_proxy_port(&host, port).await;
    //         *app_state.clash_api_base.lock().unwrap() =
    //             api.clone();
    //         *app_state.proxy_port.lock().unwrap() = proxy_port;
    //         *app_state.reuse_mode.lock().unwrap() = true;
    //         let api_clone = api.clone();
    //         tokio::spawn(async move {
    //             clash::trigger_geodata_update(&api_clone)
    //                 .await;
    //         });
    //         return Ok(true);
    //     }
    // }
    // ─────────────────────────────────────────────

    // 始终使用独立内核模式
    *app_state.reuse_mode.lock().unwrap() = false;

    // Verify subscription contains required proxy groups
    let config_path = config::get_user_config_dir()
        .join("runtime_clash.yaml");
    // ... 后续代码不变
```

- [ ] **Step 2: 验证编译通过**

Run: `cd src-tauri && cargo check`
Expected: 编译通过

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: disable async external Clash detection in start_engine — always start internal kernel"
```

---

### Task 3: 注释掉 `get_proxy_groups` 中的复用模式分支

**Files:**
- Modify: `src-tauri/src/lib.rs` (get_proxy_groups 函数)

- [ ] **Step 1: 注释掉 reuse 分支**

```rust
#[tauri::command]
async fn get_proxy_groups(
    app_state: State<'_, AppState>,
) -> Result<Vec<Value>, String> {
    // [DISABLED] 复用模式分支
    // let reuse = *app_state.reuse_mode.lock().unwrap();
    // if reuse {
    //     let api =
    //         app_state.clash_api_base.lock().unwrap().clone();
    //     return Ok(clash::fetch_proxy_groups(&api).await);
    // }

    let groups =
        app_state.proxy_groups.lock().unwrap().clone();
    let api =
        app_state.clash_api_base.lock().unwrap().clone();

    let rdp_kw = ["server-", "auto-"];
    let mut result = vec![];
    for g in &groups {
        let lower = g.name.to_lowercase();
        if !rdp_kw.iter().any(|kw| lower.contains(kw)) {
            continue;
        }
        let now =
            clash::get_active_proxy(&api, &g.name).await;
        result.push(serde_json::json!({
            "name": g.name,
            "type": g.group_type,
            "proxies": g.proxies,
            "now": now,
        }));
    }
    Ok(result)
}
```

- [ ] **Step 2: 验证编译通过**

Run: `cd src-tauri && cargo check`
Expected: 编译通过

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: disable reuse_mode branch in get_proxy_groups"
```

---

### Task 4: 注释掉 `test_group_delays` 中的复用模式分支

**Files:**
- Modify: `src-tauri/src/lib.rs` (test_group_delays 函数)

- [ ] **Step 1: 注释掉 reuse 分支获取代理列表的逻辑**

```rust
#[tauri::command]
async fn test_group_delays(
    group_name: String,
    app_state: State<'_, AppState>,
) -> Result<HashMap<String, i64>, String> {
    let api =
        app_state.clash_api_base.lock().unwrap().clone();

    // [DISABLED] 复用模式分支
    // let reuse = *app_state.reuse_mode.lock().unwrap();
    // let proxies = if reuse {
    //     let groups =
    //         clash::fetch_proxy_groups(&api).await;
    //     groups
    //         .iter()
    //         .find(|g| {
    //             g.get("name")
    //                 .and_then(|n| n.as_str())
    //                 == Some(&group_name)
    //         })
    //         .and_then(|g| g.get("proxies"))
    //         .and_then(|p| p.as_array())
    //         .map(|arr| {
    //             arr.iter()
    //                 .filter_map(|v| {
    //                     v.as_str()
    //                         .map(|s| s.to_string())
    //                 })
    //                 .collect()
    //         })
    //         .unwrap_or_default()
    // } else {
    //     let groups =
    //         app_state.proxy_groups.lock().unwrap();
    //     groups
    //         .iter()
    //         .find(|g| g.name == group_name)
    //         .map(|g| g.proxies.clone())
    //         .unwrap_or_default()
    // };

    let proxies = {
        let groups = app_state.proxy_groups.lock().unwrap();
        groups
            .iter()
            .find(|g| g.name == group_name)
            .map(|g| g.proxies.clone())
            .unwrap_or_default()
    };

    Ok(clash::test_group_delays(
        &api,
        &group_name,
        &proxies,
    )
    .await)
}
```

- [ ] **Step 2: 验证编译通过**

Run: `cd src-tauri && cargo check`
Expected: 编译通过

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: disable reuse_mode branch in test_group_delays"
```

---

### Task 5: 简化 `load_subscription` 中的 proxy_port 判断

**Files:**
- Modify: `src-tauri/src/lib.rs` (load_subscription 函数)

- [ ] **Step 1: 注释掉 reuse 判断，只检查内核是否运行**

```rust
#[tauri::command]
async fn load_subscription(
    url: String,
    app_state: State<'_, AppState>,
) -> Result<subscription::SubscriptionResult, String> {
    // Determine active proxy port (if internal kernel is running)
    let proxy_port: Option<u16> = {
        // [DISABLED] 复用模式判断
        // let reuse = *app_state.reuse_mode.lock().unwrap();
        let has_internal = {
            let proc = app_state.clash_process.lock().unwrap();
            proc.as_ref().map_or(false, |c| c.id().is_some())
        };
        if has_internal {
            Some(*app_state.proxy_port.lock().unwrap())
        } else {
            None // 内核未启动时直连
        }
    };

    // ... 后续代码不变
```

- [ ] **Step 2: 验证编译通过**

Run: `cd src-tauri && cargo check`
Expected: 编译通过

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: simplify load_subscription proxy_port — only check internal kernel"
```

---

### Task 6: 前端 UI 适配 — 移除复用模式显示逻辑

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: 修改引擎状态显示区域**

找到显示 `runMode.reuse_mode` 的 UI 部分，做以下改动：

1. 移除 "Clash · 复用模式" 文字显示，始终显示 "运行中" / "已停止"
2. 移除复用模式下的绿色 Badge（`{t('reuse')}`）
3. 始终显示启动/停止按钮（不再根据 reuse_mode 隐藏）
4. 运行模式显示始终为 "内置" (builtIn)
5. 移除代理 Tab 中复用模式的空状态提示

具体改动点：

**a) 引擎状态文字（约第 547 行）：**
```tsx
// 改前
{runMode.reuse_mode
  ? `Clash · ${t('reuseMode')}`
  : isRunning ? t('running') : t('stopped')
}

// 改后
{isRunning ? t('running') : t('stopped')}
```

**b) 复用模式 Badge（约第 575 行）：**
```tsx
// 注释掉整个 reuse badge 块
{/* [DISABLED] 复用模式 Badge
{runMode.reuse_mode && (
  <Badge variant="secondary" className="...">
    {t('reuse')}
  </Badge>
)}
*/}
```

**c) 启动/停止按钮条件（约第 555 行）：**
```tsx
// 改前
{!runMode.reuse_mode && (
  <Button ...>...</Button>
)}

// 改后（始终显示）
<Button ...>...</Button>
```

**d) 运行模式显示（约第 622 行）：**
```tsx
// 改前
{runMode.reuse_mode ? t('external') : t('builtIn')}

// 改后
{t('builtIn')}
```

**e) 刷新按钮行为（约第 484 行）：**
```tsx
// 改前
if (runMode.reuse_mode) {
  fetchData();
  return;
}

// 改后 — 删除这个 early return，统一走正常逻辑
```

**f) 刷新按钮 title（约第 500 行）：**
```tsx
// 改前
title={runMode.reuse_mode ? t('refresh') : t('switchToInternal')}

// 改后
title={t('refresh')}
```

**g) 代理 Tab 复用模式空状态（约第 869 行）：**
```tsx
// 改前
{runMode.reuse_mode ? (
  <div className="...">...</div>
) : (
  // 正常代理组显示
)}

// 改后 — 移除条件判断，始终显示正常代理组内容
```

- [ ] **Step 2: 验证前端编译通过**

Run: `cd frontend && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 3: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat: remove reuse_mode UI branches — always show independent kernel state"
```

---

### Task 7: 添加 dead_code 允许标注

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 给不再被调用但保留的函数添加 allow(dead_code)**

在 `get_proxy_port_sync` 函数上方添加：

```rust
#[allow(dead_code)]
fn get_proxy_port_sync(api_port: u16) -> u16 {
    // ... 保持不变
}
```

同时检查 `clash.rs` 中 `detect_external_clash` 和 `get_clash_proxy_port` 是否需要添加（如果编译器报 warning）。

- [ ] **Step 2: 验证编译无 warning**

Run: `cd src-tauri && cargo check 2>&1 | grep warning`
Expected: 无 dead_code 相关 warning

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/clash.rs
git commit -m "chore: suppress dead_code warnings for disabled reuse_mode functions"
```

---

### Task 8: 端到端验证

- [ ] **Step 1: 完整编译**

Run: `cd src-tauri && cargo build`
Expected: 编译成功

- [ ] **Step 2: 前端构建**

Run: `cd frontend && npm run build`
Expected: 构建成功

- [ ] **Step 3: 启动开发模式验证**

Run: `npx tauri dev`

验证项：
1. 启动日志中出现 `[init] Independent kernel mode — skipping external Clash detection`
2. 不出现 `[init] Detected external Clash at ...`
3. 点击启动引擎后，内核正常启动（日志显示 `Internal Clash API ready`）
4. 加载订阅后，代理组正常显示
5. UI 中不再显示 "复用模式" / "外部" 等字样

- [ ] **Step 4: 最终 Commit**

```bash
git add -A
git commit -m "feat: NextDesk independent kernel mode only — disable reuse mode detection"
```

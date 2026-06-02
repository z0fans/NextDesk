# NextDesk 独立内核模式专用化方案

> 取消复用模式自动检测，始终使用独立内核模式运行 RDP 加速

## 背景

NextDesk 当前有两种 Clash 引擎运行模式：

1. **复用模式 (reuse_mode)** — 检测到本地已有 Clash 实例（端口 9090/9097/7891/7890），复用其代理端口
2. **独立内核模式** — 启动自带的 `nextdesk-core` 进程，使用独立端口（17890/17891/17897）

### 问题

复用模式下，NextDesk 通过自己的 UA 拉取订阅能获得 rdp-only 专用节点，但这些节点保存在 NextDesk 自己的配置目录中，**不会被加载到外部 Clash 实例里**。导致 rdp-only 节点在复用模式下形同虚设。

### 决策

NextDesk 是 RDP 专用加速客户端，应始终使用独立内核模式：
- 自管订阅、自管节点、自管内核
- 端口与本地 Clash Verge 完全隔离（17890/17891/17897 vs 7890/9090/7897），不冲突
- 用户体验简单，无需理解两种模式的差异

## 改动范围

### 1. `src-tauri/src/lib.rs` — `start_engine` 命令

**改动**：注释掉 `detect_external_clash()` 自动检测逻辑，始终走独立内核启动路径。

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
    //     if let Some((host, port)) = clash::detect_external_clash().await {
    //         let api = format!("http://{host}:{port}");
    //         let proxy_port = clash::get_clash_proxy_port(&host, port).await;
    //         *app_state.clash_api_base.lock().unwrap() = api.clone();
    //         *app_state.proxy_port.lock().unwrap() = proxy_port;
    //         *app_state.reuse_mode.lock().unwrap() = true;
    //         let api_clone = api.clone();
    //         tokio::spawn(async move {
    //             clash::trigger_geodata_update(&api_clone).await;
    //         });
    //         return Ok(true);
    //     }
    // }
    // ─────────────────────────────────────────────

    // 始终使用独立内核模式
    *app_state.reuse_mode.lock().unwrap() = false;

    // ... 后续独立内核启动逻辑不变
}
```

### 2. `src-tauri/src/lib.rs` — `run()` 函数中的同步检测

**改动**：注释掉 `run()` 函数中启动时同步检测外部 Clash 的逻辑块。

当前代码在 Tauri 启动时用 `std::net::TcpStream` 同步探测外部 Clash 端口，这段也需要注释掉，确保启动时不会进入复用模式。

### 3. `src-tauri/src/lib.rs` — `get_proxy_groups` 命令

**改动**：注释掉 `reuse_mode` 分支（从外部 Clash API 获取代理组），始终从本地 `app_state.proxy_groups` 读取。

```rust
#[tauri::command]
async fn get_proxy_groups(
    app_state: State<'_, AppState>,
) -> Result<Vec<Value>, String> {
    // [DISABLED] 复用模式分支
    // let reuse = *app_state.reuse_mode.lock().unwrap();
    // if reuse {
    //     let api = app_state.clash_api_base.lock().unwrap().clone();
    //     return Ok(clash::fetch_proxy_groups(&api).await);
    // }

    let groups = app_state.proxy_groups.lock().unwrap().clone();
    let api = app_state.clash_api_base.lock().unwrap().clone();

    // ... 后续逻辑不变
}
```

### 4. `src-tauri/src/lib.rs` — `test_group_delays` 命令

**改动**：注释掉 `reuse` 分支获取代理列表的逻辑，始终从 `app_state.proxy_groups` 读取。

### 5. `src-tauri/src/lib.rs` — `load_subscription` 命令

**改动**：注释掉 proxy_port 的复用模式判断，始终使用独立内核的代理端口（如果内核已启动）或直连。

```rust
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
```

### 6. 前端 — 移除复用模式相关 UI 提示（如有）

检查前端是否有基于 `reuse_mode` / `RunMode` 显示的 UI 状态提示，如果有则注释掉或统一显示为"独立内核"。

## 不改动的部分

以下代码**保留不动**（注释保留，不删除）：

- `clash::detect_external_clash()` 函数本身
- `clash::get_clash_proxy_port()` 函数本身
- `state.rs` 中的 `reuse_mode` 字段
- `RunMode` 结构体
- `get_run_mode` 命令
- 所有 `clash.rs` 中的函数

这些代码保留是为了：
1. 后续如果需要恢复复用模式可以快速启用
2. 不影响编译（字段和函数仍然存在，只是不被调用）

## 数据流（改动后）

```
NextDesk 启动
    │
    ▼
start_engine() — 始终启动 nextdesk-core
    │
    ├─ 写入 runtime_clash.yaml（含 rdp-only 节点）
    ├─ 启动 nextdesk-core 进程
    ├─ 等待 API ready (http://127.0.0.1:17891)
    │
    ▼
RDP 连接 → 通过 SOCKS5 127.0.0.1:17897 → nextdesk-core → rdp-only 节点 → RDP Server
```

## 验证步骤

1. 本地同时运行 Clash Verge + NextDesk
2. NextDesk 启动后确认进入独立内核模式（不检测外部 Clash）
3. 在 NextDesk 中加载订阅，确认 rdp-only 节点出现在代理组中
4. 连接 RDP 服务器，确认流量走 NextDesk 自己的内核（端口 17897）
5. 确认 Clash Verge 的节点、订阅、代理组完全不受影响

## 回滚方案

如果独立内核模式出现问题，取消注释即可恢复复用模式逻辑。所有改动都是注释而非删除，回滚成本为零。

mod clash;
mod cliprdr;
mod config;
mod file_transfer_ws;
mod frame_ws;
mod logging;
mod macos_cursor_fix;
mod macos_file_promise;
mod macos_item_provider;
mod macos_pasteboard_promise;
mod rdp_audio;
mod rdp_proxy;
mod rdp_session;
mod rdpdr_backend;
mod relay;
mod state;
mod sub_scheduler;
mod subscription;
mod tube;
mod updater;
mod virtual_file_clipboard;
mod windows_virtual_files;

use serde_json::Value;
use state::{AppState, RunMode, Server};
use std::collections::HashMap;
use std::net::{IpAddr, TcpListener, UdpSocket};
use tauri::{AppHandle, Manager, State};

#[tauri::command]
async fn start_engine(
    app_state: State<'_, AppState>,
    force_internal: Option<bool>,
) -> Result<bool, String> {
    let _ = force_internal; // suppress unused variable warning
    start_engine_inner(app_state.inner()).await
}

fn internal_engine_running(app_state: &AppState) -> bool {
    let mut proc = app_state.clash_process.lock().unwrap();
    let Some(child) = proc.as_mut() else {
        return false;
    };

    match child.try_wait() {
        Ok(Some(status)) => {
            log::warn!("[start_engine] Existing Clash process exited: {status}");
            *proc = None;
            false
        }
        Ok(None) => true,
        Err(err) => {
            log::warn!("[start_engine] Failed to probe Clash process: {err}");
            false
        }
    }
}

fn is_private_or_reserved_host(host: &str) -> bool {
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_unspecified()
        }
        Ok(IpAddr::V6(ip)) => ip.is_loopback() || ip.is_unspecified(),
        Err(_) => false,
    }
}

fn free_tcp_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("Reserve local TCP port failed: {e}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| format!("Read local TCP port failed: {e}"))
}

fn free_dns_port() -> Result<u16, String> {
    for _ in 0..32 {
        let tcp = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|e| format!("Reserve local DNS TCP port failed: {e}"))?;
        let port = tcp
            .local_addr()
            .map_err(|e| format!("Read local DNS TCP port failed: {e}"))?
            .port();
        if let Ok(udp) = UdpSocket::bind(("127.0.0.1", port)) {
            drop(udp);
            return Ok(port);
        }
    }
    Err("Reserve local DNS port failed".into())
}

fn choose_runtime_ports() -> Result<config::RuntimePorts, String> {
    let http_port = free_tcp_port()?;
    let socks_port = free_tcp_port()?;
    let controller_port = free_tcp_port()?;
    let dns_port = free_dns_port()?;

    Ok(config::RuntimePorts {
        http_port,
        socks_port,
        controller_port,
        dns_port,
    })
}

async fn start_engine_inner(app_state: &AppState) -> Result<bool, String> {
    if internal_engine_running(app_state) {
        log::info!("[start_engine] Internal Clash already running");
        return Ok(true);
    }

    // Always use independent kernel — no reuse mode
    *app_state.reuse_mode.lock().unwrap() = false;

    // Verify runtime config exists (no longer require specific group names)
    let config_path = config::get_user_config_dir().join("runtime_clash.yaml");
    if !config_path.exists() {
        return Err("No subscription loaded. Please load a subscription first.".into());
    }

    // Ensure interface-name is set to bypass external TUN/VPN
    config::ensure_interface_name(&config_path);
    let runtime_ports = choose_runtime_ports()?;
    config::patch_runtime_ports(&config_path, runtime_ports)?;
    let api_base = format!("http://127.0.0.1:{}", runtime_ports.controller_port);

    match clash::start_clash_process().await {
        Ok(child) => {
            *app_state.clash_process.lock().unwrap() = Some(child);
            *app_state.clash_api_base.lock().unwrap() = api_base.clone();
            *app_state.proxy_port.lock().unwrap() = runtime_ports.socks_port;
            log::info!(
                "[start_engine] Runtime ports http={} socks={} api={} dns={}",
                runtime_ports.http_port,
                runtime_ports.socks_port,
                runtime_ports.controller_port,
                runtime_ports.dns_port
            );
            // Wait for Clash API to become ready (up to 15s)
            let ready = {
                let client = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(2))
                    .no_proxy()
                    .build()
                    .unwrap_or_default();
                let mut ok = false;
                for _ in 0..240 {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    if let Ok(resp) = client.get(format!("{api_base}/version")).send().await {
                        if resp.status().is_success() {
                            ok = true;
                            break;
                        }
                    }
                }
                ok
            };
            if ready {
                eprintln!("[start_engine] Internal Clash API ready");
                // Trigger geodata update in background
                // (mihomo downloads latest Country.mmdb via its own proxy)
                tauri::async_runtime::spawn(async move {
                    // Wait a few seconds for proxy connections to establish
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    eprintln!("[start_engine] Triggering geodata update...");
                    clash::trigger_geodata_update(&api_base).await;
                    eprintln!("[start_engine] Geodata update triggered");
                });
            } else {
                eprintln!("[start_engine] Warning: Clash API not ready after 120s");
            }
            Ok(true)
        }
        Err(e) => {
            eprintln!("[start_engine] Failed to start clash: {e}");
            Err(e)
        }
    }
}

#[tauri::command]
async fn stop_engine(app_state: State<'_, AppState>) -> Result<bool, String> {
    let mut proc = app_state.clash_process.lock().unwrap();
    if let Some(ref mut child) = *proc {
        let _ = child.start_kill();
    }
    *proc = None;
    Ok(true)
}

#[tauri::command]
fn get_status(app_state: State<'_, AppState>) -> Result<Value, String> {
    let clash_running = {
        let proc = app_state.clash_process.lock().unwrap();
        if let Some(ref child) = *proc {
            child.id().is_some()
        } else {
            // Check reuse mode
            *app_state.reuse_mode.lock().unwrap()
        }
    };
    let rdp_port = *app_state.rdp_proxy_port.lock().unwrap();
    Ok(serde_json::json!({
        "clash": clash_running,
        "rdp_proxy_port": rdp_port,
    }))
}

#[tauri::command]
fn get_servers(app_state: State<'_, AppState>) -> Result<Vec<Server>, String> {
    Ok(app_state.servers.lock().unwrap().clone())
}

#[tauri::command]
fn get_subscription_url(app_state: State<'_, AppState>) -> Result<String, String> {
    Ok(app_state.subscription_url.lock().unwrap().clone())
}

#[tauri::command]
fn save_config() -> Result<bool, String> {
    Ok(true)
}

#[tauri::command]
fn get_rdp_proxy_port(app_state: State<'_, AppState>) -> Result<u16, String> {
    Ok(*app_state.rdp_proxy_port.lock().unwrap())
}

#[tauri::command]
fn get_file_transfer_ws_port(app_state: State<'_, AppState>) -> u16 {
    *app_state.file_transfer_ws_port.lock().unwrap()
}

#[tauri::command]
fn get_mac_clipboard_strategy(app_state: State<'_, AppState>) -> Result<String, String> {
    Ok(app_state.mac_clipboard_strategy.lock().unwrap().clone())
}

#[tauri::command]
fn set_mac_clipboard_strategy(
    strategy: String,
    app_state: State<'_, AppState>,
) -> Result<String, String> {
    let normalized = match strategy.as_str() {
        "session-file-url" | "pasteboard-promise" => strategy,
        _ => return Err(format!("Unsupported mac clipboard strategy: {}", strategy)),
    };

    *app_state.mac_clipboard_strategy.lock().unwrap() = normalized.clone();
    Ok(normalized)
}

#[tauri::command]
async fn load_subscription(
    url: String,
    app_state: State<'_, AppState>,
) -> Result<subscription::SubscriptionResult, String> {
    // Determine active proxy port (if any)
    // [DISABLED] 复用模式暂时禁用，始终使用独立内核
    // let proxy_port: Option<u16> = {
    //     let reuse = *app_state.reuse_mode.lock().unwrap();
    //     let has_internal = {
    //         let proc = app_state.clash_process.lock().unwrap();
    //         proc.as_ref().map_or(false, |c| c.id().is_some())
    //     };
    //     if reuse || has_internal {
    //         Some(*app_state.proxy_port.lock().unwrap())
    //     } else {
    //         None // direct connection
    //     }
    // };
    let proxy_port: Option<u16> = {
        let has_internal = {
            let proc = app_state.clash_process.lock().unwrap();
            proc.as_ref().map_or(false, |c| c.id().is_some())
        };
        if has_internal {
            Some(*app_state.proxy_port.lock().unwrap())
        } else {
            None
        }
    };

    match subscription::load_subscription(&url, proxy_port).await {
        Ok(parsed) => {
            let servers = subscription::transform_proxies_to_servers(&parsed.proxies);
            let server_count = servers.len();

            // Save state
            *app_state.servers.lock().unwrap() = servers;
            *app_state.subscription_url.lock().unwrap() = url;

            let server_names: Vec<String> = app_state
                .servers
                .lock()
                .unwrap()
                .iter()
                .map(|s| s.name.clone())
                .collect();
            let groups = config::build_rdp_proxy_groups(&server_names);

            *app_state.proxy_groups.lock().unwrap() = groups.clone();

            // Generate clash config
            if let Some(raw) = &parsed.raw_config {
                config::generate_clash_config_from_subscription(raw);
            } else {
                config::generate_clash_config(&parsed.proxies);
            }

            // Persist config
            let saved = config::SavedConfig {
                subscription_url: app_state.subscription_url.lock().unwrap().clone(),
                servers: app_state.servers.lock().unwrap().clone(),
                proxy_groups: groups.clone(),
                tube_enabled: *app_state.tube_enabled.lock().unwrap(),
                cloud_mode: *app_state.cloud_mode.lock().unwrap(),
                dashboard_url: app_state.dashboard_url.lock().unwrap().clone(),
                relay_api_key: app_state.relay_api_key.lock().unwrap().clone(),
                auto_update_enabled: *app_state.auto_update_enabled.lock().unwrap(),
                last_sync_ts: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
            };
            config::save_config(&saved);
            // Update in-memory last_sync_ts
            *app_state.last_sync_ts.lock().unwrap() = saved.last_sync_ts;

            let pg_json: Vec<Value> = groups
                .iter()
                .map(|g| {
                    serde_json::json!({
                        "name": g.name,
                        "type": g.group_type,
                        "proxies": g.proxies,
                        "now": g.now,
                    })
                })
                .collect();

            Ok(subscription::SubscriptionResult {
                success: true,
                error: None,
                server_count,
                proxy_groups: pg_json,
            })
        }
        Err(e) => Ok(subscription::SubscriptionResult {
            success: false,
            error: Some(e),
            server_count: 0,
            proxy_groups: vec![],
        }),
    }
}

#[tauri::command]
async fn get_proxy_groups(app_state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let groups = app_state.proxy_groups.lock().unwrap().clone();
    let server_names: std::collections::HashSet<String> = app_state
        .servers
        .lock()
        .unwrap()
        .iter()
        .filter(|s| config::is_selectable_proxy_name(&s.name))
        .map(|s| s.name.clone())
        .collect();
    let api = app_state.clash_api_base.lock().unwrap().clone();

    let mut result = vec![];
    for g in &groups {
        let lower = g.name.to_lowercase();
        if !lower.contains("server-") || lower.contains("server-rdp") || lower.contains("auto-rdp")
        {
            continue;
        }
        let proxies: Vec<String> = g
            .proxies
            .iter()
            .filter(|proxy| server_names.contains(*proxy))
            .cloned()
            .collect();
        if proxies.is_empty() {
            continue;
        }
        let now = clash::get_active_proxy(&api, &g.name).await;
        let now = now.filter(|name| server_names.contains(name));
        result.push(serde_json::json!({
            "name": g.name,
            "type": g.group_type,
            "proxies": proxies,
            "now": now,
        }));
    }
    Ok(result)
}

#[tauri::command]
async fn switch_proxy(
    group_name: String,
    proxy_name: String,
    app_state: State<'_, AppState>,
) -> Result<bool, String> {
    let api = app_state.clash_api_base.lock().unwrap().clone();
    Ok(clash::switch_proxy(&api, &group_name, &proxy_name).await)
}

#[tauri::command]
async fn test_group_delays(
    group_name: String,
    app_state: State<'_, AppState>,
) -> Result<HashMap<String, i64>, String> {
    let api = app_state.clash_api_base.lock().unwrap().clone();

    let proxies = {
        let groups = app_state.proxy_groups.lock().unwrap();
        let server_names: std::collections::HashSet<String> = app_state
            .servers
            .lock()
            .unwrap()
            .iter()
            .filter(|s| config::is_selectable_proxy_name(&s.name))
            .map(|s| s.name.clone())
            .collect();
        groups
            .iter()
            .find(|g| g.name == group_name)
            .map(|g| {
                g.proxies
                    .iter()
                    .filter(|proxy| server_names.contains(*proxy))
                    .cloned()
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default()
    };

    Ok(clash::test_group_delays(&api, &group_name, &proxies).await)
}

#[tauri::command]
async fn test_servers_connectivity(app_state: State<'_, AppState>) -> Result<Vec<Server>, String> {
    let mut servers = app_state.servers.lock().unwrap().clone();
    subscription::test_servers_connectivity(&mut servers).await;
    *app_state.servers.lock().unwrap() = servers.clone();
    Ok(servers)
}

#[tauri::command]
async fn get_connections(app_state: State<'_, AppState>) -> Result<Value, String> {
    let api = app_state.clash_api_base.lock().unwrap().clone();
    Ok(clash::get_connections(&api).await)
}

#[tauri::command]
fn get_clash_log() -> Result<String, String> {
    Ok(clash::get_clash_log())
}

#[tauri::command]
async fn check_for_update() -> Result<updater::UpdateInfo, String> {
    Ok(updater::check_for_update().await)
}

#[tauri::command]
fn get_current_version() -> Result<String, String> {
    Ok(updater::get_current_version())
}

#[tauri::command]
fn get_system_language() -> Result<String, String> {
    let locale = sys_locale::get_locale().unwrap_or_default();
    if locale.starts_with("zh") {
        Ok("zh-CN".into())
    } else {
        Ok("en-US".into())
    }
}

/// Structured log entry from frontend rdpLog
#[derive(serde::Deserialize)]
struct RdpLogEntry {
    ts: String,
    level: String,
    module: String,
    msg: String,
    data: Option<String>,
}

const RDP_DEBUG_LOG: &str = "nextdesk_rdp_debug.log";

fn rdp_log_path() -> std::path::PathBuf {
    // Hardcode /tmp/ — macOS std::env::temp_dir() returns /var/folders/…/T/
    // which is harder to discover. /tmp/ is universally accessible.
    std::path::PathBuf::from("/tmp").join(RDP_DEBUG_LOG)
}

#[tauri::command]
fn rdp_log_batch(entries: Vec<RdpLogEntry>) -> Result<(), String> {
    use std::io::Write;
    let path = rdp_log_path();
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    for e in &entries {
        let line = if let Some(ref data) = e.data {
            format!(
                "[{}][{}][{}] {} | {}\n",
                e.ts, e.level, e.module, e.msg, data
            )
        } else {
            format!("[{}][{}][{}] {}\n", e.ts, e.level, e.module, e.msg)
        };
        f.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn rdp_log_clear() -> Result<(), String> {
    let path = rdp_log_path();
    if path.exists() {
        std::fs::write(&path, b"").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Legacy shim — kept for backward compatibility with existing cblog() calls
#[tauri::command]
fn frontend_log(msg: String) -> Result<(), String> {
    const NOISY_PATTERNS: &[&str] = &[
        "FileContentsRequest DATA (async)",
        "Requesting file DATA",
        "[rdpdr-wasm] async read complete",
    ];
    if NOISY_PATTERNS.iter().any(|pattern| msg.contains(pattern)) {
        return Ok(());
    }
    let entry = RdpLogEntry {
        ts: {
            let secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            format!("{secs}")
        },
        level: "info".to_string(),
        module: "clipboard".to_string(),
        msg,
        data: None,
    };
    rdp_log_batch(vec![entry])
}

#[tauri::command]
fn get_run_mode(app_state: State<'_, AppState>) -> Result<RunMode, String> {
    Ok(RunMode {
        reuse_mode: *app_state.reuse_mode.lock().unwrap(),
        clash_api: app_state.clash_api_base.lock().unwrap().clone(),
        proxy_port: *app_state.proxy_port.lock().unwrap(),
        cloud_mode: *app_state.cloud_mode.lock().unwrap(),
        dashboard_url: app_state.dashboard_url.lock().unwrap().clone(),
    })
}

/// Get proxy port synchronously (pure std::net)
#[allow(dead_code)]
fn get_proxy_port_sync(api_port: u16) -> u16 {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    let timeout = Duration::from_secs(2);
    let addr = format!("127.0.0.1:{api_port}");
    if let Ok(mut stream) = TcpStream::connect_timeout(&addr.parse().unwrap(), timeout) {
        stream.set_read_timeout(Some(timeout)).ok();
        stream.set_write_timeout(Some(timeout)).ok();
        let req = format!(
            "GET /configs HTTP/1.1\r\n\
             Host: 127.0.0.1:{api_port}\r\n\
             Connection: close\r\n\r\n"
        );
        if stream.write_all(req.as_bytes()).is_ok() {
            let mut buf = vec![0u8; 4096];
            if let Ok(n) = stream.read(&mut buf) {
                let body = String::from_utf8_lossy(&buf[..n]);
                // Try mixed-port first, then socks-port; skip if 0
                for key in &["\"mixed-port\"", "\"socks-port\""] {
                    if let Some(pos) = body.find(key) {
                        let after = &body[pos..];
                        if let Some(colon) = after.find(':') {
                            let num_str: String = after[colon + 1..]
                                .chars()
                                .take_while(|c| c.is_ascii_digit() || *c == ' ')
                                .collect();
                            if let Ok(p) = num_str.trim().parse::<u16>() {
                                if p > 0 {
                                    return p;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    7897 // default fallback
}

#[tauri::command]
fn get_tube_enabled(app_state: State<'_, AppState>) -> Result<bool, String> {
    Ok(*app_state.tube_enabled.lock().unwrap())
}

#[tauri::command]
fn set_tube_enabled(enabled: bool, app_state: State<'_, AppState>) -> Result<bool, String> {
    *app_state.tube_enabled.lock().unwrap() = enabled;
    // Persist
    let mut saved = config::load_saved_config();
    saved.tube_enabled = enabled;
    config::save_config(&saved);
    log::info!("[tube] Tube Mode = {enabled}");
    Ok(enabled)
}

#[tauri::command]
async fn set_cloud_mode(
    app_state: State<'_, AppState>,
    enabled: bool,
    dashboard_url: String,
    api_key: String,
) -> Result<bool, String> {
    *app_state.cloud_mode.lock().unwrap() = enabled;
    *app_state.dashboard_url.lock().unwrap() = dashboard_url.clone();
    *app_state.relay_api_key.lock().unwrap() = api_key.clone();

    // Persist
    let mut saved = config::load_saved_config();
    saved.cloud_mode = enabled;
    saved.dashboard_url = dashboard_url.clone();
    saved.relay_api_key = api_key.clone();
    config::save_config(&saved);

    // If enabling, fetch endpoints immediately
    if enabled && !dashboard_url.is_empty() && !api_key.is_empty() {
        match relay::fetch_endpoints(&dashboard_url, &api_key).await {
            Ok(eps) => {
                log::info!("[cloud] Fetched {} endpoints", eps.len());
                *app_state.relay_endpoints.lock().unwrap() = eps;
            }
            Err(e) => log::warn!("[cloud] Fetch failed: {e}"),
        }
    } else {
        *app_state.relay_endpoints.lock().unwrap() = Vec::new();
    }
    log::info!("[cloud] Cloud Mode = {enabled}");
    Ok(true)
}

#[tauri::command]
async fn refresh_relay_endpoints(
    app_state: State<'_, AppState>,
) -> Result<Vec<state::RelayEndpoint>, String> {
    let url = app_state.dashboard_url.lock().unwrap().clone();
    let key = app_state.relay_api_key.lock().unwrap().clone();
    let eps = relay::fetch_endpoints(&url, &key).await?;
    *app_state.relay_endpoints.lock().unwrap() = eps.clone();
    Ok(eps)
}

#[tauri::command]
fn get_relay_endpoints(
    app_state: State<'_, AppState>,
) -> Result<Vec<state::RelayEndpoint>, String> {
    Ok(app_state.relay_endpoints.lock().unwrap().clone())
}

// ── Native RDP Session Commands ──────────────────────────────

#[tauri::command]
async fn rdp_native_connect(
    app: tauri::AppHandle,
    tab_id: String,
    host: String,
    port: u16,
    username: String,
    password: String,
    domain: Option<String>,
    width: u16,
    height: u16,
    app_state: State<'_, AppState>,
) -> Result<u16, String> {
    if is_private_or_reserved_host(&host) {
        log::info!("[rdp-native] Private/local target {host}:{port}; using direct route");
    } else {
        log::info!("[rdp-native] Public target {host}:{port}; ensuring internal engine");
        start_engine_inner(app_state.inner()).await?;
    }

    // Start a local WebSocket server on a random port for frame delivery.
    // This bypasses Tauri Channel's 5-layer IPC overhead entirely.
    let (ws_port, frame_tx) = frame_ws::start_frame_server()
        .await
        .map_err(|e| format!("Failed to start frame WS: {e}"))?;
    let socks_port = *app_state.proxy_port.lock().unwrap();

    let handle = rdp_session::spawn_session(
        app,
        tab_id.clone(),
        host,
        port,
        socks_port,
        username,
        password,
        domain,
        width,
        height,
        frame_tx,
    );
    let mut mgr = app_state.native_sessions.lock().unwrap();
    mgr.insert(tab_id, handle);
    Ok(ws_port)
}

#[tauri::command]
fn rdp_native_input(
    tab_id: String,
    scancode: u16,
    is_pressed: bool,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    use ironrdp::pdu::input::fast_path::{FastPathInputEvent, KeyboardFlags};
    use smallvec::smallvec;

    let mgr = app_state.native_sessions.lock().unwrap();
    let tx = mgr
        .get_input_tx(&tab_id)
        .ok_or_else(|| format!("Session not found: {tab_id}"))?;

    let mut flags = KeyboardFlags::empty();
    if !is_pressed {
        flags |= KeyboardFlags::RELEASE;
    }
    // Extended key (scancode >= 0xE000)
    if scancode & 0xFF00 == 0xE000 {
        flags |= KeyboardFlags::EXTENDED;
    }
    let code = (scancode & 0xFF) as u8;

    let event = FastPathInputEvent::KeyboardEvent(flags, code);
    tx.send(rdp_session::NativeRdpInput::FastPath(smallvec![event]))
        .map_err(|e| format!("Send input failed: {e}"))
}

#[tauri::command]
fn rdp_native_mouse(
    tab_id: String,
    x: f64,
    y: f64,
    button: i8,
    is_down: bool,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    use ironrdp::pdu::input::fast_path::FastPathInputEvent;
    use ironrdp::pdu::input::mouse::{MousePdu, PointerFlags};
    use smallvec::smallvec;

    let mgr = app_state.native_sessions.lock().unwrap();
    let tx = mgr
        .get_input_tx(&tab_id)
        .ok_or_else(|| format!("Session not found: {tab_id}"))?;

    let x_pos = x.round().max(0.0) as u16;
    let y_pos = y.round().max(0.0) as u16;

    let mut flags = PointerFlags::empty();
    match button {
        0 => flags |= PointerFlags::LEFT_BUTTON,
        1 => flags |= PointerFlags::MIDDLE_BUTTON_OR_WHEEL,
        2 => flags |= PointerFlags::RIGHT_BUTTON,
        _ => {} // -1 or others = move only
    }
    if is_down && button >= 0 {
        flags |= PointerFlags::DOWN;
    }
    let move_pdu = MousePdu {
        flags: PointerFlags::MOVE,
        number_of_wheel_rotation_units: 0,
        x_position: x_pos,
        y_position: y_pos,
    };

    if button < 0 {
        return tx
            .send(rdp_session::NativeRdpInput::MouseMove {
                x: move_pdu.x_position,
                y: move_pdu.y_position,
            })
            .map_err(|e| format!("Send mouse failed: {e}"));
    }

    log::info!(
        "[rdp-native] mouse button tab={} x={} y={} button={} down={} flags={:?}",
        tab_id,
        x_pos,
        y_pos,
        button,
        is_down,
        flags
    );

    let button_pdu = MousePdu {
        flags,
        number_of_wheel_rotation_units: 0,
        x_position: x_pos,
        y_position: y_pos,
    };
    tx.send(rdp_session::NativeRdpInput::FastPath(smallvec![
        FastPathInputEvent::MouseEvent(move_pdu),
        FastPathInputEvent::MouseEvent(button_pdu)
    ]))
    .map_err(|e| format!("Send mouse failed: {e}"))
}

#[tauri::command]
fn rdp_native_wheel(
    tab_id: String,
    x: f64,
    y: f64,
    delta: i16,
    is_horizontal: bool,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    use ironrdp::pdu::input::fast_path::FastPathInputEvent;
    use ironrdp::pdu::input::mouse::{MousePdu, PointerFlags};
    use smallvec::smallvec;

    let mgr = app_state.native_sessions.lock().unwrap();
    let tx = mgr
        .get_input_tx(&tab_id)
        .ok_or_else(|| format!("Session not found: {tab_id}"))?;

    let x_pos = x.round().max(0.0) as u16;
    let y_pos = y.round().max(0.0) as u16;

    let mut flags = if is_horizontal {
        PointerFlags::HORIZONTAL_WHEEL
    } else {
        PointerFlags::VERTICAL_WHEEL
    };

    // Negative rotation: set WHEEL_NEGATIVE flag
    if delta < 0 {
        flags |= PointerFlags::WHEEL_NEGATIVE;
    }

    let pdu = MousePdu {
        flags,
        number_of_wheel_rotation_units: delta,
        x_position: x_pos,
        y_position: y_pos,
    };
    let event = FastPathInputEvent::MouseEvent(pdu);
    tx.send(rdp_session::NativeRdpInput::FastPath(smallvec![event]))
        .map_err(|e| format!("Send wheel failed: {e}"))
}

#[tauri::command]
fn rdp_native_disconnect(tab_id: String, app_state: State<'_, AppState>) -> Result<(), String> {
    let mut mgr = app_state.native_sessions.lock().unwrap();
    mgr.disconnect(&tab_id);
    Ok(())
}

#[tauri::command]
fn rdp_native_resize(
    tab_id: String,
    width: u16,
    height: u16,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    let mgr = app_state.native_sessions.lock().unwrap();
    let tx = mgr
        .get_input_tx(&tab_id)
        .ok_or_else(|| format!("Session not found: {tab_id}"))?;
    tx.send(rdp_session::NativeRdpInput::Resize { width, height })
        .map_err(|e| format!("Send resize failed: {e}"))
}

// ── RDP Audio Commands ──────────────────────────────────────

#[tauri::command]
fn rdp_audio_set_format(
    tab_id: String,
    channels: u16,
    sample_rate: u32,
    bits_per_sample: u16,
    format_tag: String,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    let mut mgr = app_state.audio_manager.lock().unwrap();
    mgr.set_format(&tab_id, channels, sample_rate, bits_per_sample, &format_tag)
}

#[tauri::command]
fn rdp_audio_push(
    tab_id: String,
    pcm: Vec<u8>,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    let mgr = app_state.audio_manager.lock().unwrap();
    mgr.push(&tab_id, pcm)
}

/// Binary-friendly variant of `rdp_audio_push`.
///
/// Sends PCM bytes via Tauri's raw IPC body (`InvokeBody::Raw`) instead of a
/// JSON `Vec<u8>`. This avoids the ~6× bandwidth bloat caused by serializing
/// each byte to a JSON number on every audio packet.
///
/// Frontend usage:
/// ```ts
/// invoke('rdp_audio_push_raw', uint8Array, { headers: { 'X-Tab-Id': tabId } });
/// ```
#[tauri::command]
fn rdp_audio_push_raw(
    request: tauri::ipc::Request<'_>,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    let tab_id = request
        .headers()
        .get("X-Tab-Id")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing X-Tab-Id header")?
        .to_string();

    let pcm = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("rdp_audio_push_raw expects raw binary body".into())
        }
    };

    let mgr = app_state.audio_manager.lock().unwrap();
    mgr.push(&tab_id, pcm)
}

#[tauri::command]
fn rdp_audio_close(tab_id: String, app_state: State<'_, AppState>) -> Result<(), String> {
    let mut mgr = app_state.audio_manager.lock().unwrap();
    mgr.close(&tab_id);
    Ok(())
}

#[tauri::command]
fn get_auto_update_status(app_state: State<'_, AppState>) -> Result<serde_json::Value, String> {
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
fn set_auto_update_enabled(enabled: bool, app_state: State<'_, AppState>) -> Result<(), String> {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize structured logging FIRST so all subsequent code can log.
    logging::init();

    // Load saved config on startup
    let saved = config::load_saved_config();
    let app_state = AppState::default();
    *app_state.servers.lock().unwrap() = saved.servers;
    *app_state.proxy_groups.lock().unwrap() = saved.proxy_groups;
    *app_state.subscription_url.lock().unwrap() = saved.subscription_url;
    *app_state.tube_enabled.lock().unwrap() = saved.tube_enabled;
    *app_state.cloud_mode.lock().unwrap() = saved.cloud_mode;
    *app_state.dashboard_url.lock().unwrap() = saved.dashboard_url;
    *app_state.relay_api_key.lock().unwrap() = saved.relay_api_key;
    *app_state.auto_update_enabled.lock().unwrap() = saved.auto_update_enabled;
    *app_state.last_sync_ts.lock().unwrap() = saved.last_sync_ts;

    // [DISABLED] 复用模式暂时禁用，始终使用独立内核
    // 待独立内核模式成熟后删除此段注释代码
    // (Original synchronous external Clash detection block commented out)
    eprintln!("[init] Independent kernel mode — skipping external Clash detection");
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
    //                         // Get proxy port
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

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(app_state)
        .setup(|app| {
            // macOS: swizzle [NSCursor setHiddenUntilMouseMoves:] to no-op
            // to prevent cursor from hiding on keyDown in RDP sessions
            macos_cursor_fix::install_cursor_unhide();

            let state = app.state::<AppState>();
            let rdp_port = *state.rdp_proxy_port.lock().unwrap();
            let socks_port = state.proxy_port.clone();
            let tube_enabled = state.tube_enabled.clone();
            let cloud_mode = state.cloud_mode.clone();
            let relay_endpoints = state.relay_endpoints.clone();
            let dashboard_url = state.dashboard_url.clone();
            let relay_api_key = state.relay_api_key.clone();
            tauri::async_runtime::spawn(async move {
                rdp_proxy::start_proxy(
                    rdp_port,
                    socks_port,
                    tube_enabled,
                    cloud_mode,
                    relay_endpoints,
                    dashboard_url,
                    relay_api_key,
                )
                .await;
            });

            // Spawn subscription auto-update scheduler
            let app_handle = app.handle().clone();
            sub_scheduler::spawn(app_handle);

            // Start file transfer WebSocket server for CLIPRDR large file bypass
            let app_handle_for_ft = app.handle().clone();
            let ft_port = tauri::async_runtime::block_on(async {
                crate::file_transfer_ws::start_file_transfer_server(app_handle_for_ft).await
            })
            .map_err(|e| {
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("file_transfer_ws: {e}"),
                )) as Box<dyn std::error::Error>
            })?;
            log::info!("[setup] File transfer WS port: {ft_port}");
            {
                let state = app.state::<AppState>();
                *state.file_transfer_ws_port.lock().unwrap() = ft_port;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_engine,
            stop_engine,
            get_status,
            get_servers,
            get_subscription_url,
            save_config,
            load_subscription,
            get_proxy_groups,
            switch_proxy,
            test_group_delays,
            test_servers_connectivity,
            get_connections,
            get_clash_log,
            check_for_update,
            get_current_version,
            get_system_language,
            get_run_mode,
            get_rdp_proxy_port,
            get_file_transfer_ws_port,
            get_mac_clipboard_strategy,
            set_mac_clipboard_strategy,
            rdpdr_backend::rdpdr_scan_folder,
            rdpdr_backend::rdpdr_scan_folder_metadata,
            rdpdr_backend::rdpdr_read_file_chunk,
            rdpdr_backend::clipboard_read_file,
            rdpdr_backend::clipboard_write_file,
            rdpdr_backend::clipboard_read_file_paths,
            rdpdr_backend::clipboard_read_files_data,
            rdpdr_backend::save_downloaded_file,
            rdpdr_backend::stage_downloaded_files_for_paste,
            rdpdr_backend::get_session_clipboard_state,
            rdpdr_backend::open_session_clipboard_folder,
            rdpdr_backend::clipboard_stage_begin,
            rdpdr_backend::clipboard_stage_chunk,
            rdpdr_backend::clipboard_stage_commit,
            frontend_log,
            rdp_log_batch,
            rdp_log_clear,
            get_tube_enabled,
            set_tube_enabled,
            set_cloud_mode,
            refresh_relay_endpoints,
            get_relay_endpoints,
            rdp_audio_set_format,
            rdp_audio_push,
            rdp_audio_push_raw,
            rdp_audio_close,
            rdp_native_connect,
            rdp_native_input,
            rdp_native_mouse,
            rdp_native_wheel,
            rdp_native_disconnect,
            rdp_native_resize,
            get_auto_update_status,
            set_auto_update_enabled,
            trigger_sync_now,
            logging::log_show_in_finder,
            logging::log_copy_to_desktop,
            logging::log_clear,
            logging::log_file_path_str,
            logging::log_file_size,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::is_private_or_reserved_host;

    #[test]
    fn rdp_engine_guard_treats_private_targets_as_direct() {
        assert!(is_private_or_reserved_host("192.168.3.108"));
        assert!(is_private_or_reserved_host("10.0.0.8"));
        assert!(is_private_or_reserved_host("127.0.0.1"));
    }

    #[test]
    fn rdp_engine_guard_treats_public_targets_as_proxy_required() {
        assert!(!is_private_or_reserved_host("68.64.138.254"));
        assert!(!is_private_or_reserved_host("example.com"));
    }
}

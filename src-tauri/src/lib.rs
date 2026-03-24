mod clash;
mod config;
mod macos_item_provider;
mod macos_pasteboard_promise;
mod macos_file_promise;
mod rdp_proxy;
mod rdpdr_backend;
mod state;
mod subscription;
mod updater;
mod virtual_file_clipboard;
mod windows_virtual_files;

use serde_json::Value;
use state::{AppState, ProxyGroup, RunMode, Server};
use std::collections::HashMap;
use tauri::{Manager, State};

#[tauri::command]
async fn start_engine(
    app_state: State<'_, AppState>,
    force_internal: Option<bool>,
) -> Result<bool, String> {
    let force = force_internal.unwrap_or(false);
    // Detect external clash first (unless forced to internal)
    if !force {
        if let Some((host, port)) =
            clash::detect_external_clash().await
        {
            let api = format!("http://{host}:{port}");
            let proxy_port =
                clash::get_clash_proxy_port(&host, port).await;
            *app_state.clash_api_base.lock().unwrap() =
                api.clone();
            *app_state.proxy_port.lock().unwrap() = proxy_port;
            *app_state.reuse_mode.lock().unwrap() = true;
            // Trigger geodata update in background
            let api_clone = api.clone();
            tokio::spawn(async move {
                clash::trigger_geodata_update(&api_clone)
                    .await;
            });
            return Ok(true);
        }
    }

    // Start our own Clash process
    *app_state.reuse_mode.lock().unwrap() = false;

    // Verify subscription contains required proxy groups
    let config_path = config::get_user_config_dir()
        .join("runtime_clash.yaml");
    if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .unwrap_or_default();
        let required = ["Server-Americas", "Server-Asia", "Server-Global"];
        let missing: Vec<&str> = required.iter()
            .filter(|g| !content.contains(*g))
            .copied()
            .collect();
        if !missing.is_empty() {
            return Err(format!(
                "Unsupported subscription. Missing required groups: {}",
                missing.join(", ")
            ));
        }
    }

    match clash::start_clash_process().await {
        Ok(child) => {
            *app_state.clash_process.lock().unwrap() =
                Some(child);
            // Set default ports for internal engine
            *app_state.clash_api_base.lock().unwrap() =
                "http://127.0.0.1:17891".to_string();
            *app_state.proxy_port.lock().unwrap() = 17897;
            // Wait for Clash API to become ready (up to 15s)
            let ready = {
                let client = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(2))
                    .no_proxy()
                    .build()
                    .unwrap_or_default();
                let mut ok = false;
                for _ in 0..240 {
                    tokio::time::sleep(
                        std::time::Duration::from_millis(500),
                    ).await;
                    if let Ok(resp) = client
                        .get("http://127.0.0.1:17891/version")
                        .send()
                        .await
                    {
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
                tauri::async_runtime::spawn(async {
                    // Wait a few seconds for proxy connections to establish
                    tokio::time::sleep(
                        std::time::Duration::from_secs(5),
                    ).await;
                    eprintln!("[start_engine] Triggering geodata update...");
                    clash::trigger_geodata_update(
                        "http://127.0.0.1:17891",
                    ).await;
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
async fn stop_engine(
    app_state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut proc = app_state.clash_process.lock().unwrap();
    if let Some(ref mut child) = *proc {
        let _ = child.start_kill();
    }
    *proc = None;
    Ok(true)
}

#[tauri::command]
fn get_status(
    app_state: State<'_, AppState>,
) -> Result<Value, String> {
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
fn get_servers(
    app_state: State<'_, AppState>,
) -> Result<Vec<Server>, String> {
    Ok(app_state.servers.lock().unwrap().clone())
}

#[tauri::command]
fn get_subscription_url(
    app_state: State<'_, AppState>,
) -> Result<String, String> {
    Ok(app_state
        .subscription_url
        .lock()
        .unwrap()
        .clone())
}

#[tauri::command]
fn save_config() -> Result<bool, String> {
    Ok(true)
}

#[tauri::command]
fn get_rdp_proxy_port(
    app_state: State<'_, AppState>,
) -> Result<u16, String> {
    Ok(*app_state.rdp_proxy_port.lock().unwrap())
}

#[tauri::command]
fn get_mac_clipboard_strategy(
    app_state: State<'_, AppState>,
) -> Result<String, String> {
    Ok(app_state
        .mac_clipboard_strategy
        .lock()
        .unwrap()
        .clone())
}

#[tauri::command]
fn set_mac_clipboard_strategy(
    strategy: String,
    app_state: State<'_, AppState>,
) -> Result<String, String> {
    let normalized = match strategy.as_str() {
        "session-file-url" | "pasteboard-promise" => strategy,
        _ => {
            return Err(format!(
                "Unsupported mac clipboard strategy: {}",
                strategy
            ))
        }
    };

    *app_state
        .mac_clipboard_strategy
        .lock()
        .unwrap() = normalized.clone();
    Ok(normalized)
}

#[tauri::command]
async fn load_subscription(
    url: String,
    app_state: State<'_, AppState>,
) -> Result<subscription::SubscriptionResult, String> {
    // Determine active proxy port (if any)
    let proxy_port: Option<u16> = {
        let reuse = *app_state.reuse_mode.lock().unwrap();
        let has_internal = {
            let proc = app_state.clash_process.lock().unwrap();
            proc.as_ref().map_or(false, |c| c.id().is_some())
        };
        if reuse || has_internal {
            Some(*app_state.proxy_port.lock().unwrap())
        } else {
            None // direct connection
        }
    };

    match subscription::load_subscription(&url, proxy_port).await {
        Ok(parsed) => {
            let servers =
                subscription::transform_proxies_to_servers(
                    &parsed.proxies,
                );
            let server_count = servers.len();

            // Save state
            *app_state.servers.lock().unwrap() =
                servers;
            *app_state.subscription_url.lock().unwrap() =
                url;

            // Transform proxy groups for frontend
            let groups: Vec<ProxyGroup> = parsed
                .proxy_groups
                .iter()
                .filter_map(|g| {
                    let name = g
                        .get("name")?
                        .as_str()?
                        .to_string();
                    let gtype = g
                        .get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("select")
                        .to_string();
                    let proxies: Vec<String> = g
                        .get("proxies")
                        .and_then(|v| v.as_sequence())
                        .map(|seq| {
                            seq.iter()
                                .filter_map(|p| {
                                    p.as_str().map(
                                        |s| s.to_string(),
                                    )
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(ProxyGroup {
                        name,
                        group_type: gtype,
                        proxies,
                        now: None,
                    })
                })
                .collect();

            *app_state
                .proxy_groups
                .lock()
                .unwrap() = groups.clone();

            // Generate clash config
            if let Some(raw) = &parsed.raw_config {
                config::generate_clash_config_from_subscription(raw);
            } else {
                config::generate_clash_config(
                    &parsed.proxies,
                );
            }

            // Persist config
            let saved = config::SavedConfig {
                subscription_url: app_state
                    .subscription_url
                    .lock()
                    .unwrap()
                    .clone(),
                servers: app_state
                    .servers
                    .lock()
                    .unwrap()
                    .clone(),
                proxy_groups: groups.clone(),
            };
            config::save_config(&saved);

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
        Err(e) => {
            Ok(subscription::SubscriptionResult {
                success: false,
                error: Some(e),
                server_count: 0,
                proxy_groups: vec![],
            })
        }
    }
}

#[tauri::command]
async fn get_proxy_groups(
    app_state: State<'_, AppState>,
) -> Result<Vec<Value>, String> {
    let reuse = *app_state.reuse_mode.lock().unwrap();
    if reuse {
        let api =
            app_state.clash_api_base.lock().unwrap().clone();
        return Ok(clash::fetch_proxy_groups(&api).await);
    }

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

#[tauri::command]
async fn switch_proxy(
    group_name: String,
    proxy_name: String,
    app_state: State<'_, AppState>,
) -> Result<bool, String> {
    let api =
        app_state.clash_api_base.lock().unwrap().clone();
    Ok(clash::switch_proxy(
        &api,
        &group_name,
        &proxy_name,
    )
    .await)
}

#[tauri::command]
async fn test_group_delays(
    group_name: String,
    app_state: State<'_, AppState>,
) -> Result<HashMap<String, i64>, String> {
    let api =
        app_state.clash_api_base.lock().unwrap().clone();
    let reuse = *app_state.reuse_mode.lock().unwrap();

    let proxies = if reuse {
        // Fetch from Clash API
        let groups =
            clash::fetch_proxy_groups(&api).await;
        groups
            .iter()
            .find(|g| {
                g.get("name")
                    .and_then(|n| n.as_str())
                    == Some(&group_name)
            })
            .and_then(|g| g.get("proxies"))
            .and_then(|p| p.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| {
                        v.as_str()
                            .map(|s| s.to_string())
                    })
                    .collect()
            })
            .unwrap_or_default()
    } else {
        let groups =
            app_state.proxy_groups.lock().unwrap();
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

#[tauri::command]
async fn test_servers_connectivity(
    app_state: State<'_, AppState>,
) -> Result<Vec<Server>, String> {
    let mut servers =
        app_state.servers.lock().unwrap().clone();
    subscription::test_servers_connectivity(
        &mut servers,
    )
    .await;
    *app_state.servers.lock().unwrap() = servers.clone();
    Ok(servers)
}

#[tauri::command]
async fn get_connections(
    app_state: State<'_, AppState>,
) -> Result<Value, String> {
    let api =
        app_state.clash_api_base.lock().unwrap().clone();
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
    let locale =
        sys_locale::get_locale().unwrap_or_default();
    if locale.starts_with("zh") {
        Ok("zh-CN".into())
    } else {
        Ok("en-US".into())
    }
}

#[tauri::command]
fn frontend_log(msg: String) -> Result<(), String> {
    const NOISY_PATTERNS: &[&str] = &[
        "FileContentsRequest DATA (async)",
        "Requesting file DATA",
        "[rdpdr-wasm] async read complete",
    ];
    if NOISY_PATTERNS
        .iter()
        .any(|pattern| msg.contains(pattern))
    {
        return Ok(());
    }
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true).append(true)
        .open("/tmp/nextdesk_clipboard.log")
        .map_err(|e| e.to_string())?;
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default().as_secs();
    writeln!(f, "[{secs}] {msg}")
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_run_mode(
    app_state: State<'_, AppState>,
) -> Result<RunMode, String> {
    Ok(RunMode {
        reuse_mode: *app_state
            .reuse_mode
            .lock()
            .unwrap(),
        clash_api: app_state
            .clash_api_base
            .lock()
            .unwrap()
            .clone(),
        proxy_port: *app_state
            .proxy_port
            .lock()
            .unwrap(),
    })
}

/// Get proxy port synchronously (pure std::net)
fn get_proxy_port_sync(api_port: u16) -> u16 {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    let timeout = Duration::from_secs(2);
    let addr = format!("127.0.0.1:{api_port}");
    if let Ok(mut stream) = TcpStream::connect_timeout(
        &addr.parse().unwrap(),
        timeout,
    ) {
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
                let body =
                    String::from_utf8_lossy(&buf[..n]);
                // Try mixed-port first, then socks-port; skip if 0
                for key in &["\"mixed-port\"", "\"socks-port\""] {
                    if let Some(pos) = body.find(key) {
                        let after = &body[pos..];
                        if let Some(colon) = after.find(':') {
                            let num_str: String = after
                                [colon + 1..]
                                .chars()
                                .take_while(|c| {
                                    c.is_ascii_digit()
                                        || *c == ' '
                                })
                                .collect();
                            if let Ok(p) =
                                num_str.trim().parse::<u16>()
                            {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load saved config on startup
    let saved = config::load_saved_config();
    let app_state = AppState::default();
    *app_state.servers.lock().unwrap() = saved.servers;
    *app_state.proxy_groups.lock().unwrap() =
        saved.proxy_groups;
    *app_state.subscription_url.lock().unwrap() =
        saved.subscription_url;

    // Synchronously detect external Clash
    // (pure std::net, no tokio/async)
    {
        use std::io::{Read, Write};
        use std::net::TcpStream;
        use std::time::Duration;

        let ports: &[u16] = &[9090, 9097, 7891, 7890];
        let timeout = Duration::from_secs(1);

        for &port in ports {
            let addr = format!("127.0.0.1:{port}");
            if let Ok(mut stream) =
                TcpStream::connect_timeout(
                    &addr.parse().unwrap(),
                    timeout,
                )
            {
                stream
                    .set_read_timeout(Some(timeout))
                    .ok();
                stream
                    .set_write_timeout(Some(timeout))
                    .ok();
                let req = format!(
                    "GET /version HTTP/1.1\r\n\
                     Host: 127.0.0.1:{port}\r\n\
                     Connection: close\r\n\r\n"
                );
                if stream
                    .write_all(req.as_bytes())
                    .is_ok()
                {
                    let mut buf = vec![0u8; 1024];
                    if let Ok(n) =
                        stream.read(&mut buf)
                    {
                        let resp =
                            String::from_utf8_lossy(
                                &buf[..n],
                            );
                        if resp.contains("200")
                            && resp.contains("version")
                        {
                            let api = format!(
                                "http://127.0.0.1:{port}"
                            );
                            eprintln!(
                                "[init] Detected external Clash at {api}"
                            );

                            // Get proxy port
                            let pp =
                                get_proxy_port_sync(
                                    port,
                                );
                            *app_state
                                .clash_api_base
                                .lock()
                                .unwrap() = api;
                            *app_state
                                .proxy_port
                                .lock()
                                .unwrap() = pp;
                            *app_state
                                .reuse_mode
                                .lock()
                                .unwrap() = true;
                            break;
                        }
                    }
                }
            }
        }
        if !*app_state.reuse_mode.lock().unwrap() {
            eprintln!(
                "[init] No external Clash detected"
            );
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(app_state)
        .setup(|app| {
            let state = app.state::<AppState>();
            let rdp_port = *state.rdp_proxy_port.lock().unwrap();
            let socks_port = state.proxy_port.clone();
            tauri::async_runtime::spawn(async move {
                rdp_proxy::start_proxy(rdp_port, socks_port).await;
            });
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
            frontend_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

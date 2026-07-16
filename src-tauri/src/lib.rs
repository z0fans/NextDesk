#[cfg(any(
    feature = "nextdesk-native-rdp",
    all(feature = "kkterm-rdp", nextdesk_kkterm_rdp)
))]
mod cliprdr;
mod cloud_auth;
mod cloud_gateway;
mod cloud_probe;
mod config;
mod connection_resolver;
mod diagnostic_logs;
mod file_transfer_ws;
#[cfg(feature = "nextdesk-native-rdp")]
mod frame_ws;
#[cfg(all(feature = "kkterm-rdp", nextdesk_kkterm_rdp))]
mod kkterm_rdp;
mod logging;
mod macos_cursor_fix;
mod macos_file_promise;
mod macos_item_provider;
mod macos_pasteboard_promise;
mod rdp_audio;
#[cfg(feature = "nextdesk-native-rdp")]
mod rdp_frame;
#[cfg(feature = "nextdesk-native-rdp")]
mod rdp_gpu_renderer;
mod rdp_native_view;
#[cfg(feature = "nextdesk-native-rdp")]
mod rdp_proxy;
#[cfg(feature = "nextdesk-native-rdp")]
mod rdp_session;
#[cfg(feature = "nextdesk-native-rdp")]
mod rdp_shared_frame;
mod rdpdr_backend;
mod state;
mod updater;
mod virtual_file_clipboard;
mod windows_virtual_files;

use state::AppState;
#[cfg(all(feature = "kkterm-rdp", nextdesk_kkterm_rdp))]
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::ShellExt;

#[cfg(all(feature = "nextdesk-native-rdp", nextdesk_kkterm_rdp))]
compile_error!(
    "Use either the default NextDesk native RDP stack or `--no-default-features --features kkterm-rdp`; the two IronRDP stacks cannot be linked together."
);

#[cfg(all(feature = "kkterm-rdp", not(nextdesk_kkterm_rdp)))]
compile_error!(
    "kkterm-rdp requires RUSTFLAGS=\"--cfg nextdesk_kkterm_rdp\" so Cargo selects the isolated KKTerm dependency graph."
);

#[cfg(all(feature = "kkterm-rdp", nextdesk_kkterm_rdp, target_os = "windows"))]
static KKTERM_RDP_WINDOWS_MANAGER: OnceLock<kkterm_rdp::windows::RdpSessionManager> =
    OnceLock::new();

#[cfg(all(
    feature = "kkterm-rdp",
    nextdesk_kkterm_rdp,
    not(target_os = "windows")
))]
static KKTERM_RDP_MACOS_MANAGER: OnceLock<kkterm_rdp::macos::RdpClientSessionManager> =
    OnceLock::new();

#[cfg(all(feature = "kkterm-rdp", nextdesk_kkterm_rdp, target_os = "windows"))]
fn kkterm_rdp_windows_manager() -> &'static kkterm_rdp::windows::RdpSessionManager {
    KKTERM_RDP_WINDOWS_MANAGER.get_or_init(kkterm_rdp::windows::RdpSessionManager::new)
}

#[cfg(all(
    feature = "kkterm-rdp",
    nextdesk_kkterm_rdp,
    not(target_os = "windows")
))]
fn kkterm_rdp_macos_manager() -> &'static kkterm_rdp::macos::RdpClientSessionManager {
    KKTERM_RDP_MACOS_MANAGER.get_or_init(kkterm_rdp::macos::RdpClientSessionManager::new)
}

#[tauri::command]
fn get_rdp_proxy_port(app_state: State<'_, AppState>) -> Result<u16, String> {
    if let Some(error) = app_state.rdp_proxy_error.lock().unwrap().clone() {
        return Err(error);
    }

    let port = *app_state.rdp_proxy_port.lock().unwrap();
    if port == 0 {
        return Err("RDP local proxy is unavailable; 127.0.0.1:18765 is not bound".into());
    }

    Ok(port)
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

#[cfg(feature = "nextdesk-native-rdp")]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeRdpConnectResponse {
    ws_port: u16,
    route_label: String,
}

const RDP_DEBUG_LOG: &str = "nextdesk_rdp_debug.log";

fn rdp_log_path() -> std::path::PathBuf {
    // Hardcode /tmp/ — macOS std::env::temp_dir() returns /var/folders/…/T/
    // which is harder to discover. /tmp/ is universally accessible.
    let path = std::path::PathBuf::from("/tmp").join(RDP_DEBUG_LOG);
    static SANITIZE_EXISTING_LOGS: std::sync::Once = std::sync::Once::new();
    SANITIZE_EXISTING_LOGS.call_once(|| {
        if let Err(error) = logging::sanitize_log_family(&path) {
            eprintln!("[logging] Failed to sanitize existing RDP logs: {error}");
        }
    });
    path
}

#[tauri::command]
fn rdp_log_file_path_str() -> String {
    rdp_log_path().to_string_lossy().to_string()
}

#[tauri::command]
fn rdp_log_file_size() -> u64 {
    logging::log_family_size(&rdp_log_path())
}

#[tauri::command]
fn diagnostic_log_read(
    limit: Option<usize>,
) -> Result<Vec<diagnostic_logs::DiagnosticLogEntry>, String> {
    diagnostic_logs::read(&logging::log_file_path(), &rdp_log_path(), limit)
}

#[tauri::command]
fn log_copy_diagnostic_bundle_to_desktop() -> Result<String, String> {
    use std::io::Write;

    let desktop =
        dirs::desktop_dir().ok_or_else(|| "could not find Desktop directory".to_string())?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let dest = desktop.join(format!("nextdesk_diagnostics_{ts}"));
    std::fs::create_dir_all(&dest).map_err(|e| format!("create diagnostics dir failed: {e}"))?;

    let entries = diagnostic_logs::read(&logging::log_file_path(), &rdp_log_path(), Some(5000))?;
    let mut jsonl = std::fs::File::create(dest.join("nextdesk_diagnostics.jsonl"))
        .map_err(|e| format!("create diagnostics JSONL failed: {e}"))?;
    for entry in &entries {
        serde_json::to_writer(&mut jsonl, entry)
            .map_err(|e| format!("serialize diagnostic entry failed: {e}"))?;
        writeln!(jsonl).map_err(|e| format!("write diagnostic entry failed: {e}"))?;
    }

    let mut manifest = std::fs::File::create(dest.join("manifest.txt"))
        .map_err(|e| format!("create diagnostics manifest failed: {e}"))?;
    writeln!(manifest, "NextDesk diagnostics bundle").map_err(|e| e.to_string())?;
    writeln!(manifest, "timestamp_unix={ts}").map_err(|e| e.to_string())?;
    writeln!(manifest, "version={}", env!("CARGO_PKG_VERSION")).map_err(|e| e.to_string())?;
    writeln!(manifest, "target_os={}", std::env::consts::OS).map_err(|e| e.to_string())?;
    writeln!(manifest, "target_arch={}", std::env::consts::ARCH).map_err(|e| e.to_string())?;
    writeln!(manifest, "debug_assertions={}", cfg!(debug_assertions)).map_err(|e| e.to_string())?;
    writeln!(manifest, "entry_count={}", entries.len()).map_err(|e| e.to_string())?;
    writeln!(manifest, "format=jsonl").map_err(|e| e.to_string())?;
    writeln!(manifest, "redacted=true").map_err(|e| e.to_string())?;
    writeln!(manifest, "rdp_brand=Next RDP").map_err(|e| e.to_string())?;
    writeln!(manifest, "internal_technology_names=false").map_err(|e| e.to_string())?;

    log::info!("Copied diagnostic bundle to {}", dest.display());
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
fn rdp_log_batch(entries: Vec<RdpLogEntry>) -> Result<(), String> {
    let path = rdp_log_path();
    let mut output = Vec::new();
    let internal = logging::internal_diagnostics_enabled();
    for e in &entries {
        let message = if internal {
            e.msg.clone()
        } else {
            logging::public_log_text(&e.msg)
        };
        let data = e.data.as_ref().map(|data| {
            if internal {
                data.clone()
            } else {
                logging::public_log_text(data)
            }
        });
        let line = if let Some(ref data) = data {
            format!(
                "[{}][{}][{}] {} | {}\n",
                e.ts, e.level, e.module, message, data
            )
        } else {
            format!("[{}][{}][{}] {}\n", e.ts, e.level, e.module, message)
        };
        output.extend_from_slice(line.as_bytes());
    }
    logging::append_rotating(&path, &output).map_err(|e| e.to_string())
}

#[tauri::command]
fn rdp_log_clear() -> Result<(), String> {
    let path = rdp_log_path();
    logging::clear_log_family(&path).map_err(|e| e.to_string())
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

fn cloud_authorization_base_url_from_state(_app_state: &AppState) -> Result<String, String> {
    Ok(config::CLOUD_AUTH_BASE_URL.to_string())
}

fn persist_cloud_authorization_base_url(app_state: &AppState, panel_url: &str) {
    *app_state.cloud_authorization_base_url.lock().unwrap() = panel_url.to_string();
    let mut saved = config::load_saved_config();
    saved.cloud_authorization_base_url = panel_url.to_string();
    config::save_config(&saved);
}

#[tauri::command]
async fn cloud_start_authorization(
    app: AppHandle,
    app_state: State<'_, AppState>,
) -> Result<cloud_gateway::CloudAuthorizationStart, String> {
    let panel_url = cloud_authorization_base_url_from_state(app_state.inner())?;
    persist_cloud_authorization_base_url(app_state.inner(), &panel_url);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("bind cloud callback listener failed: {e}"))?;
    let callback_port = listener
        .local_addr()
        .map_err(|e| format!("read cloud callback listener address failed: {e}"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{callback_port}/cloud/auth/callback");
    log::info!("[cloud-auth] listening on {redirect_uri}");
    let auth = cloud_auth::start_authorization(panel_url, redirect_uri)?;
    spawn_cloud_callback_server(app.clone(), listener, callback_port);
    #[allow(deprecated)]
    app.shell()
        .open(auth.authorize_url.clone(), None)
        .map_err(|e| format!("open authorization url failed: {e}"))?;
    log::info!("[cloud-auth] opened authorization url");
    Ok(auth)
}

#[tauri::command]
async fn cloud_handle_callback(
    callback_url: String,
    app_state: State<'_, AppState>,
) -> Result<cloud_gateway::CloudAccountStatus, String> {
    let status = cloud_auth::handle_callback(callback_url).await?;
    sync_cloud_config_to_state(app_state.inner());
    Ok(status)
}

#[tauri::command]
async fn cloud_get_status() -> Result<cloud_gateway::CloudAccountStatus, String> {
    cloud_auth::status().await
}

#[tauri::command]
async fn cloud_refresh_status() -> Result<cloud_gateway::CloudAccountStatus, String> {
    cloud_auth::status().await
}

#[tauri::command]
async fn cloud_keep_binding_alive(
    session_id: String,
    host: String,
    port: u16,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    connection_resolver::keep_binding_alive(app_state.inner(), Some(&session_id), &host, port).await
}

#[tauri::command]
async fn cloud_disable(app_state: State<'_, AppState>) -> Result<bool, String> {
    app_state.cloud_active_bindings.lock().unwrap().clear();
    cloud_auth::disable().await
}

fn sync_cloud_config_to_state(app_state: &AppState) {
    let saved = config::load_saved_config();
    *app_state.dashboard_url.lock().unwrap() = saved.dashboard_url;
    *app_state.cloud_authorization_base_url.lock().unwrap() = saved.cloud_authorization_base_url;
}

fn is_cloud_auth_callback(url: &str) -> bool {
    url.starts_with("nextdesk://auth/callback")
        || url.starts_with("ndesk://auth/callback")
        || url.starts_with("http://127.0.0.1:")
        || url.starts_with("http://localhost:")
}

async fn complete_cloud_auth_callback(
    app_handle: AppHandle,
    callback_url: String,
) -> Result<(), String> {
    let result = cloud_auth::handle_callback(callback_url).await;
    let payload = match &result {
        Ok(status) => {
            let state = app_handle.state::<AppState>();
            sync_cloud_config_to_state(state.inner());
            serde_json::json!({ "ok": true, "status": status })
        }
        Err(error) => serde_json::json!({ "ok": false, "error": error }),
    };
    let _ = app_handle.emit("cloud-auth-result", payload);
    result.map(|_| ())
}

fn handle_cloud_deep_link_urls(app: AppHandle, urls: Vec<String>) {
    for callback_url in urls {
        if !is_cloud_auth_callback(&callback_url) {
            continue;
        }
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = complete_cloud_auth_callback(app_handle, callback_url).await;
        });
    }
}

async fn write_cloud_callback_response(
    stream: &mut tokio::net::TcpStream,
    status: &str,
    content_type: &str,
    body: &str,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;

    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|e| format!("write cloud callback response failed: {e}"))?;
    stream
        .shutdown()
        .await
        .map_err(|e| format!("shutdown cloud callback response failed: {e}"))
}

#[derive(Clone)]
struct CloudCallbackPage {
    title: &'static str,
    heading: &'static str,
    message: &'static str,
    success: bool,
}

fn cloud_callback_page(completion: &Result<(), String>) -> CloudCallbackPage {
    match completion {
        Ok(()) => CloudCallbackPage {
            title: "NextDesk Cloud 授权完成",
            heading: "授权成功",
            message: "此设备已获得云端加速授权，现在可以返回 NextDesk。",
            success: true,
        },
        Err(error) if error.contains("cloud_auth_too_many_devices") => CloudCallbackPage {
            title: "NextDesk Cloud 设备数量已达上限",
            heading: "已达到用户最大授权设备数",
            message: "请联系管理员移除旧设备授权或调整设备数量上限，然后重新登录。",
            success: false,
        },
        Err(error) if error.contains("cloud_auth_invalid_or_expired") => CloudCallbackPage {
            title: "NextDesk Cloud 授权已失效",
            heading: "授权链接已失效",
            message: "请返回 NextDesk，重新发起登录授权。",
            success: false,
        },
        Err(error) if error.contains("cloud_auth_rate_limited") => CloudCallbackPage {
            title: "NextDesk Cloud 请求过于频繁",
            heading: "授权请求过于频繁",
            message: "请稍后返回 NextDesk 重新登录。",
            success: false,
        },
        Err(_) => CloudCallbackPage {
            title: "NextDesk Cloud 授权失败",
            heading: "授权未完成",
            message: "请返回 NextDesk 查看日志，然后重新发起登录授权。",
            success: false,
        },
    }
}

fn cloud_callback_progress_page() -> &'static str {
    r#"<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NextDesk Cloud 正在完成授权</title>
<style>
body{margin:0;background:#f5f7fb;color:#172033;font:16px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:560px;margin:12vh auto;padding:40px;background:#fff;border:1px solid #dce3ef;border-radius:8px;box-shadow:0 16px 45px rgba(31,45,70,.10)}
.mark{width:44px;height:44px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:#1769e0;color:#fff;font-size:22px;font-weight:700;line-height:1}
.loading-dots{height:8px;display:flex;align-items:center;justify-content:center;gap:4px}
.loading-dots span{width:6px;height:6px;border-radius:50%;background:#fff;animation:pulse 1.1s ease-in-out infinite}
.loading-dots span:nth-child(2){animation-delay:.14s}
.loading-dots span:nth-child(3){animation-delay:.28s}
@keyframes pulse{0%,70%,100%{opacity:.45;transform:scale(.82)}35%{opacity:1;transform:scale(1)}}
h1{font-size:26px;margin:20px 0 8px;letter-spacing:0}
p{margin:0;color:#64748b}
button{margin-top:28px;border:0;border-radius:6px;background:#1769e0;color:#fff;padding:11px 18px;font:inherit;font-weight:600;cursor:pointer}
button:hover{background:#155fc9}
button:focus-visible{outline:3px solid rgba(23,105,224,.28);outline-offset:3px}
.hidden{display:none}
</style>
</head>
<body>
<main>
<div class="mark" id="mark" aria-hidden="true"><span class="loading-dots"><span></span><span></span><span></span></span></div>
<h1 id="heading">正在完成授权</h1>
<p id="message">请稍候，NextDesk 正在确认此设备的云端加速授权。</p>
<button class="hidden" id="return" type="button">返回 NextDesk</button>
</main>
<script>
const mark=document.getElementById('mark');
const heading=document.getElementById('heading');
const message=document.getElementById('message');
const returnButton=document.getElementById('return');
returnButton.addEventListener('click',()=>{
  window.location.href='nextdesk://auth/complete';
  setTimeout(()=>window.close(),350);
});
const poll=async()=>{
  try{
    const response=await fetch('/cloud/auth/result',{cache:'no-store'});
    const result=await response.json();
    if(result.pending){setTimeout(poll,600);return}
    document.title=result.title;
    mark.replaceChildren(document.createTextNode(result.success?'✓':'!'));
    mark.style.background=result.success?'#16a34a':'#dc2626';
    heading.textContent=result.heading;
    message.textContent=result.message;
    returnButton.classList.remove('hidden');
  }catch(_){setTimeout(poll,900)}
};
poll();
</script>
</body>
</html>"#
}

fn spawn_cloud_callback_server(
    app: AppHandle,
    listener: tokio::net::TcpListener,
    callback_port: u16,
) {
    tauri::async_runtime::spawn(async move {
        use tokio::io::AsyncReadExt;
        let result = std::sync::Arc::new(tokio::sync::Mutex::new(None::<CloudCallbackPage>));
        let mut callback_started = false;
        let mut deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(300);

        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                log::warn!("[cloud-auth] loopback callback listener timed out");
                return;
            }
            let accepted = tokio::time::timeout(remaining, listener.accept()).await;
            let Ok(Ok((mut stream, peer))) = accepted else {
                log::warn!("[cloud-auth] loopback callback listener timed out");
                return;
            };

            let mut buffer = [0_u8; 8192];
            let read = match stream.read(&mut buffer).await {
                Ok(read) => read,
                Err(error) => {
                    log::warn!("[cloud-auth] read loopback callback failed: {error}");
                    continue;
                }
            };
            let request = String::from_utf8_lossy(&buffer[..read]);
            let target = request
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or("/");

            if target.starts_with("/cloud/auth/result") {
                let page = result.lock().await.clone();
                let body = match page {
                    Some(page) => serde_json::json!({
                        "pending": false,
                        "title": page.title,
                        "heading": page.heading,
                        "message": page.message,
                        "success": page.success,
                    })
                    .to_string(),
                    None => serde_json::json!({ "pending": true }).to_string(),
                };
                let _ = write_cloud_callback_response(
                    &mut stream,
                    "200 OK",
                    "application/json; charset=utf-8",
                    &body,
                )
                .await;
                continue;
            }

            if !target.starts_with("/cloud/auth/callback?") {
                let body = "Not Found";
                let _ = write_cloud_callback_response(
                    &mut stream,
                    "404 Not Found",
                    "text/plain; charset=utf-8",
                    body,
                )
                .await;
                continue;
            }

            if let Err(error) = write_cloud_callback_response(
                &mut stream,
                "200 OK",
                "text/html; charset=utf-8",
                cloud_callback_progress_page(),
            )
            .await
            {
                log::warn!("[cloud-auth] {error}");
                continue;
            }
            log::info!("[cloud-auth] callback progress page sent");

            if !callback_started {
                callback_started = true;
                deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(300);
                log::info!("[cloud-auth] accepted loopback callback from {peer}");
                let callback_url = format!("http://127.0.0.1:{callback_port}{target}");
                let app_handle = app.clone();
                let result_state = result.clone();
                tauri::async_runtime::spawn(async move {
                    let completion = complete_cloud_auth_callback(app_handle, callback_url).await;
                    *result_state.lock().await = Some(cloud_callback_page(&completion));
                    log::info!("[cloud-auth] callback result ready");
                });
            }
        }
    });
}

// ── Native RDP Session Commands ──────────────────────────────

#[cfg(feature = "nextdesk-native-rdp")]
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
    render_profile: Option<String>,
    reuse_cloud_binding: Option<bool>,
    app_state: State<'_, AppState>,
) -> Result<NativeRdpConnectResponse, String> {
    let resolved = connection_resolver::resolve_connection_target(
        app_state.inner(),
        host.clone(),
        port,
        reuse_cloud_binding.unwrap_or(false),
        Some(tab_id.clone()),
    )
    .await?;
    let route_label = resolved.route_label.clone();
    let connect_host = resolved.host;
    let connect_port = resolved.port;
    log::info!(
        "[rdp-native] target {host}:{port} resolved to {}:{} route={}",
        connect_host,
        connect_port,
        resolved.route_label
    );

    // Start a local WebSocket server on a random port for frame delivery.
    // This bypasses Tauri Channel's 5-layer IPC overhead entirely.
    let (ws_port, frame_tx, frame_ws_shutdown) =
        frame_ws::start_frame_server(tab_id.clone(), connect_host.clone())
            .await
            .map_err(|e| format!("Failed to start frame WS: {e}"))?;
    let frame_transport =
        rdp_session::native_frame_transport_from_profile(render_profile.as_deref());
    log::info!(
        "[rdp-native] connect profile tab={} host={} mode={} transport={}",
        tab_id,
        host,
        render_profile.as_deref().unwrap_or("native"),
        frame_transport.label()
    );

    let handle = rdp_session::spawn_session(
        app,
        tab_id.clone(),
        connect_host,
        connect_port,
        username,
        password,
        domain,
        width,
        height,
        frame_tx,
        ws_port,
        frame_ws_shutdown,
        frame_transport,
    );
    let mut mgr = app_state.native_sessions.lock().unwrap();
    mgr.insert(tab_id, handle);
    Ok(NativeRdpConnectResponse {
        ws_port,
        route_label,
    })
}

#[cfg(feature = "nextdesk-native-rdp")]
#[tauri::command]
fn rdp_native_set_view_bounds(
    app: tauri::AppHandle,
    tab_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale_factor: f64,
    visible: bool,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    let bounds =
        rdp_native_view::NativeViewBounds::new(x, y, width, height, scale_factor, visible)?;
    let changed =
        rdp_native_view::set_bounds(&app_state.native_view_bounds, tab_id.clone(), bounds)?;
    let host_update =
        rdp_native_view::update_host_state(&app_state.native_view_hosts, tab_id.clone(), bounds)?;
    if changed {
        log::debug!(
            "[rdp-native-view] bounds tab={} x={:.1} y={:.1} w={:.1} h={:.1} scale={:.2} visible={}",
            tab_id,
            bounds.x,
            bounds.y,
            bounds.width,
            bounds.height,
            bounds.scale_factor,
            bounds.visible
        );
    }
    if host_update.created || host_update.changed {
        log::debug!(
            "[rdp-native-view] host-state tab={} created={} changed={} visible={} generation={}",
            tab_id,
            host_update.created,
            host_update.changed,
            host_update.visible,
            host_update.generation
        );
    }
    if bounds.visible {
        rdp_native_view::prepare_native_host(&app, &tab_id)?;
        rdp_native_view::mark_host_prepared(&app_state.native_view_hosts, &tab_id)?;
    }
    Ok(())
}

#[cfg(feature = "nextdesk-native-rdp")]
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

#[cfg(feature = "nextdesk-native-rdp")]
#[tauri::command]
fn rdp_native_force_clipboard_check(
    tab_id: String,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    let mgr = app_state.native_sessions.lock().unwrap();
    let tx = mgr
        .get_input_tx(&tab_id)
        .ok_or_else(|| format!("Session not found: {tab_id}"))?;

    tx.send(rdp_session::NativeRdpInput::ForceClipboardCheck)
        .map_err(|e| format!("Send clipboard check failed: {e}"))
}

#[cfg(feature = "nextdesk-native-rdp")]
#[tauri::command]
fn rdp_native_set_active_clipboard_session(tab_id: Option<String>) {
    cliprdr::watcher::set_active_clipboard_session(tab_id);
}

#[cfg(feature = "nextdesk-native-rdp")]
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

#[cfg(feature = "nextdesk-native-rdp")]
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

#[cfg(feature = "nextdesk-native-rdp")]
#[tauri::command]
fn rdp_native_disconnect(tab_id: String, app_state: State<'_, AppState>) -> Result<(), String> {
    rdp_native_view::remove_bounds(&app_state.native_view_bounds, &tab_id)?;
    if rdp_native_view::remove_host(&app_state.native_view_hosts, &tab_id)? {
        log::debug!("[rdp-native-view] removed host-state tab={tab_id}");
    }
    let mut mgr = app_state.native_sessions.lock().unwrap();
    mgr.disconnect(&tab_id);
    Ok(())
}

#[cfg(feature = "nextdesk-native-rdp")]
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

// ── KKTerm Native RDP Commands ──────────────────────────────────────────────

#[cfg(all(feature = "kkterm-rdp", nextdesk_kkterm_rdp, target_os = "windows"))]
#[tauri::command]
async fn kkterm_rdp_start(
    app: tauri::AppHandle,
    mut request: kkterm_rdp::types::KktermRdpStartRequest,
    app_state: State<'_, AppState>,
) -> Result<kkterm_rdp::types::KktermRdpStartResponse, String> {
    let tab_id = request.tab_id.clone();
    let host = request.host.trim().to_string();
    let port = request.port;
    let resolved = connection_resolver::resolve_connection_target(
        app_state.inner(),
        host.clone(),
        port,
        request.reuse_cloud_binding,
        Some(tab_id.clone()),
    )
    .await?;
    request.host = resolved.host.clone();
    request.port = resolved.port;
    log::info!(
        "[kkterm-rdp] Windows target {host}:{port} resolved to {}:{} route={}",
        request.host,
        request.port,
        resolved.route_label
    );
    let start_request = kkterm_rdp::windows::StartRdpSessionRequest::from_kkterm_start(request);
    kkterm_rdp_windows_manager().start_session(app, start_request)?;
    Ok(kkterm_rdp::types::KktermRdpStartResponse {
        session_id: tab_id.clone(),
        tab_id,
        route_label: resolved.route_label,
    })
}

#[cfg(all(
    feature = "kkterm-rdp",
    nextdesk_kkterm_rdp,
    not(target_os = "windows")
))]
#[tauri::command]
async fn kkterm_rdp_start(
    app: tauri::AppHandle,
    mut request: kkterm_rdp::types::KktermRdpStartRequest,
    app_state: State<'_, AppState>,
) -> Result<kkterm_rdp::types::KktermRdpStartResponse, String> {
    let tab_id = request.tab_id.clone();
    let session_id = kkterm_rdp::types::session_id_from_tab_id(&tab_id);
    let host = request.host.trim().to_string();
    let port = request.port;
    let resolved = connection_resolver::resolve_connection_target(
        app_state.inner(),
        host.clone(),
        port,
        request.reuse_cloud_binding,
        Some(tab_id.clone()),
    )
    .await?;
    request.host = resolved.host.clone();
    request.port = resolved.port;
    log::info!(
        "[kkterm-rdp] target {host}:{port} resolved to {}:{} route={}",
        request.host,
        request.port,
        resolved.route_label
    );
    let start_request = kkterm_rdp::macos::StartRdpClientSessionRequest::from_kkterm_start(request);
    tauri::async_runtime::spawn_blocking(move || {
        kkterm_rdp_macos_manager().start_session(app.clone(), start_request)
    })
    .await
    .map_err(|error| format!("RDP startup task failed: {error}"))??;
    Ok(kkterm_rdp::types::KktermRdpStartResponse {
        tab_id,
        session_id,
        route_label: resolved.route_label,
    })
}

#[cfg(all(feature = "kkterm-rdp", nextdesk_kkterm_rdp, target_os = "windows"))]
#[tauri::command]
fn kkterm_rdp_set_bounds(
    app: tauri::AppHandle,
    request: kkterm_rdp::types::KktermRdpBoundsRequest,
) -> Result<(), String> {
    let visibility = kkterm_rdp::windows::SetRdpVisibilityRequest::from_kkterm_bounds(request);
    kkterm_rdp_windows_manager().set_visibility(app, visibility)
}

#[cfg(all(feature = "kkterm-rdp", nextdesk_kkterm_rdp, target_os = "windows"))]
#[tauri::command]
fn kkterm_rdp_status(
    app: tauri::AppHandle,
    request: kkterm_rdp::types::KktermRdpSimpleRequest,
) -> Result<kkterm_rdp::windows::RdpSessionStatus, String> {
    kkterm_rdp_windows_manager().session_status(
        app,
        kkterm_rdp::windows::RdpSimpleRequest::from_kkterm_simple(request),
    )
}

#[cfg(all(feature = "kkterm-rdp", nextdesk_kkterm_rdp, target_os = "windows"))]
#[tauri::command]
fn kkterm_rdp_sync_display_size(
    app: tauri::AppHandle,
    request: kkterm_rdp::types::KktermRdpBoundsRequest,
) -> Result<kkterm_rdp::windows::RdpDisplaySizeSync, String> {
    kkterm_rdp_windows_manager().sync_display_size(
        app,
        kkterm_rdp::windows::SyncRdpDisplaySizeRequest::from_kkterm_bounds(request),
    )
}

#[cfg(all(
    feature = "kkterm-rdp",
    nextdesk_kkterm_rdp,
    not(target_os = "windows")
))]
#[tauri::command]
fn kkterm_rdp_set_bounds(
    _request: kkterm_rdp::types::KktermRdpBoundsRequest,
) -> Result<(), String> {
    Ok(())
}

#[cfg(all(feature = "kkterm-rdp", nextdesk_kkterm_rdp, target_os = "windows"))]
#[tauri::command]
fn kkterm_rdp_pointer(
    app: tauri::AppHandle,
    request: kkterm_rdp::types::KktermRdpPointerRequest,
) -> Result<(), String> {
    if let Some(click) = kkterm_rdp::windows::SendRdpMouseClickRequest::from_kkterm_pointer(request)
    {
        kkterm_rdp_windows_manager().send_mouse_click(app, click)?;
    }
    Ok(())
}

#[cfg(all(
    feature = "kkterm-rdp",
    nextdesk_kkterm_rdp,
    not(target_os = "windows")
))]
#[tauri::command]
fn kkterm_rdp_pointer(request: kkterm_rdp::types::KktermRdpPointerRequest) -> Result<(), String> {
    kkterm_rdp_macos_manager().pointer_event(
        kkterm_rdp::macos::RdpClientPointerEventRequest::from_kkterm_pointer(request),
    )
}

#[cfg(all(feature = "kkterm-rdp", nextdesk_kkterm_rdp, target_os = "windows"))]
#[tauri::command]
fn kkterm_rdp_key(
    app: tauri::AppHandle,
    request: kkterm_rdp::types::KktermRdpKeyRequest,
) -> Result<(), String> {
    kkterm_rdp_windows_manager().send_key_press(
        app,
        kkterm_rdp::windows::SendRdpKeyPressRequest::from_kkterm_key(request),
    )
}

#[cfg(all(
    feature = "kkterm-rdp",
    nextdesk_kkterm_rdp,
    not(target_os = "windows")
))]
#[tauri::command]
fn kkterm_rdp_key(request: kkterm_rdp::types::KktermRdpKeyRequest) -> Result<(), String> {
    kkterm_rdp_macos_manager()
        .key_event(kkterm_rdp::macos::RdpClientKeyEventRequest::from_kkterm_key(request))
}

#[cfg(all(feature = "kkterm-rdp", nextdesk_kkterm_rdp, target_os = "windows"))]
#[tauri::command]
fn kkterm_rdp_text(
    app: tauri::AppHandle,
    request: kkterm_rdp::types::KktermRdpTextRequest,
) -> Result<(), String> {
    kkterm_rdp_windows_manager()
        .send_text(
            app,
            kkterm_rdp::windows::SendRdpTextRequest::from_kkterm_text(request),
        )
        .map(|_| ())
}

#[cfg(all(
    feature = "kkterm-rdp",
    nextdesk_kkterm_rdp,
    not(target_os = "windows")
))]
#[tauri::command]
fn kkterm_rdp_text(request: kkterm_rdp::types::KktermRdpTextRequest) -> Result<(), String> {
    kkterm_rdp_macos_manager().text_input(
        kkterm_rdp::macos::RdpClientTextRequest::from_kkterm_text(request),
    )
}

#[cfg(all(feature = "kkterm-rdp", nextdesk_kkterm_rdp, target_os = "windows"))]
#[tauri::command]
fn kkterm_rdp_ctrl_alt_delete(
    app: tauri::AppHandle,
    request: kkterm_rdp::types::KktermRdpSimpleRequest,
) -> Result<(), String> {
    kkterm_rdp_windows_manager().send_ctrl_alt_delete(
        app,
        kkterm_rdp::windows::RdpSimpleRequest::from_kkterm_simple(request),
    )
}

#[cfg(all(
    feature = "kkterm-rdp",
    nextdesk_kkterm_rdp,
    not(target_os = "windows")
))]
#[tauri::command]
fn kkterm_rdp_ctrl_alt_delete(
    request: kkterm_rdp::types::KktermRdpSimpleRequest,
) -> Result<(), String> {
    kkterm_rdp_macos_manager().send_ctrl_alt_delete(
        kkterm_rdp::macos::RdpClientSimpleRequest::from_kkterm_simple(request),
    )
}

#[cfg(all(
    feature = "kkterm-rdp",
    nextdesk_kkterm_rdp,
    not(target_os = "windows")
))]
#[tauri::command]
fn kkterm_rdp_set_active_clipboard_session(tab_id: Option<String>) {
    let session_id = tab_id
        .as_deref()
        .map(kkterm_rdp::types::session_id_from_tab_id);
    cliprdr::watcher::set_active_clipboard_session(session_id);
}

#[cfg(all(
    feature = "kkterm-rdp",
    nextdesk_kkterm_rdp,
    not(target_os = "windows")
))]
#[tauri::command]
fn kkterm_rdp_force_clipboard_check(
    request: kkterm_rdp::types::KktermRdpSimpleRequest,
) -> Result<(), String> {
    kkterm_rdp_macos_manager().force_clipboard_check(
        kkterm_rdp::macos::RdpClientSimpleRequest::from_kkterm_simple(request),
    )
}

#[cfg(all(feature = "kkterm-rdp", nextdesk_kkterm_rdp, target_os = "windows"))]
#[tauri::command]
fn kkterm_rdp_disconnect(
    app: tauri::AppHandle,
    request: kkterm_rdp::types::KktermRdpSimpleRequest,
) -> Result<(), String> {
    kkterm_rdp_windows_manager().close_session(
        app,
        kkterm_rdp::windows::RdpSimpleRequest::from_kkterm_simple(request),
    )
}

#[cfg(all(
    feature = "kkterm-rdp",
    nextdesk_kkterm_rdp,
    not(target_os = "windows")
))]
#[tauri::command]
fn kkterm_rdp_disconnect(request: kkterm_rdp::types::KktermRdpSimpleRequest) -> Result<(), String> {
    kkterm_rdp_macos_manager()
        .close_session(kkterm_rdp::macos::RdpClientSimpleRequest::from_kkterm_simple(request))
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize structured logging FIRST so all subsequent code can log.
    logging::init();

    // Load saved config on startup
    let saved = config::load_saved_config();
    let app_state = AppState::default();
    *app_state.dashboard_url.lock().unwrap() = saved.dashboard_url;
    *app_state.cloud_authorization_base_url.lock().unwrap() = saved.cloud_authorization_base_url;

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .manage(app_state)
        .setup(|app| {
            // macOS: swizzle [NSCursor setHiddenUntilMouseMoves:] to no-op
            // to prevent cursor from hiding on keyDown in RDP sessions
            macos_cursor_fix::install_cursor_unhide();

            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;

                #[cfg(any(windows, target_os = "linux"))]
                {
                    if let Err(error) = app.deep_link().register_all() {
                        log::warn!("[cloud-auth] deep link register_all failed: {error}");
                    }
                }

                match app.deep_link().get_current() {
                    Ok(Some(urls)) => {
                        let urls = urls.iter().map(ToString::to_string).collect();
                        handle_cloud_deep_link_urls(app.handle().clone(), urls);
                    }
                    Ok(None) => {}
                    Err(error) => log::warn!("[cloud-auth] read startup deep link failed: {error}"),
                }

                let app_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    let urls = event.urls().iter().map(ToString::to_string).collect();
                    handle_cloud_deep_link_urls(app_handle.clone(), urls);
                });
            }

            #[cfg(feature = "nextdesk-native-rdp")]
            {
                let state = app.state::<AppState>();
                let rdp_port = *state.rdp_proxy_port.lock().unwrap();
                let rdp_proxy_port_state = state.rdp_proxy_port.clone();
                let rdp_proxy_error = state.rdp_proxy_error.clone();
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    rdp_proxy::start_proxy(
                        app_handle,
                        rdp_port,
                        rdp_proxy_port_state,
                        rdp_proxy_error,
                    )
                    .await;
                });
            }

            #[cfg(not(feature = "nextdesk-native-rdp"))]
            {
                let state = app.state::<AppState>();
                *state.rdp_proxy_port.lock().unwrap() = 0;
                *state.rdp_proxy_error.lock().unwrap() = Some(
                    "NextDesk native/web RDP proxy is disabled in kkterm-rdp builds".to_string(),
                );
            }

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
            check_for_update,
            get_current_version,
            get_system_language,
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
            rdp_log_file_path_str,
            rdp_log_file_size,
            diagnostic_log_read,
            log_copy_diagnostic_bundle_to_desktop,
            cloud_start_authorization,
            cloud_handle_callback,
            cloud_get_status,
            cloud_refresh_status,
            cloud_keep_binding_alive,
            cloud_disable,
            rdp_audio_set_format,
            rdp_audio_push,
            rdp_audio_push_raw,
            rdp_audio_close,
            #[cfg(feature = "nextdesk-native-rdp")]
            rdp_native_connect,
            #[cfg(feature = "nextdesk-native-rdp")]
            rdp_native_set_view_bounds,
            #[cfg(feature = "nextdesk-native-rdp")]
            rdp_native_input,
            #[cfg(feature = "nextdesk-native-rdp")]
            rdp_native_force_clipboard_check,
            #[cfg(feature = "nextdesk-native-rdp")]
            rdp_native_set_active_clipboard_session,
            #[cfg(feature = "nextdesk-native-rdp")]
            rdp_native_mouse,
            #[cfg(feature = "nextdesk-native-rdp")]
            rdp_native_wheel,
            #[cfg(feature = "nextdesk-native-rdp")]
            rdp_native_disconnect,
            #[cfg(feature = "nextdesk-native-rdp")]
            rdp_native_resize,
            #[cfg(all(feature = "kkterm-rdp", nextdesk_kkterm_rdp))]
            kkterm_rdp_start,
            #[cfg(all(feature = "kkterm-rdp", nextdesk_kkterm_rdp))]
            kkterm_rdp_set_bounds,
            #[cfg(all(feature = "kkterm-rdp", nextdesk_kkterm_rdp, target_os = "windows"))]
            kkterm_rdp_status,
            #[cfg(all(feature = "kkterm-rdp", nextdesk_kkterm_rdp, target_os = "windows"))]
            kkterm_rdp_sync_display_size,
            #[cfg(all(feature = "kkterm-rdp", nextdesk_kkterm_rdp))]
            kkterm_rdp_pointer,
            #[cfg(all(feature = "kkterm-rdp", nextdesk_kkterm_rdp))]
            kkterm_rdp_key,
            #[cfg(all(feature = "kkterm-rdp", nextdesk_kkterm_rdp))]
            kkterm_rdp_text,
            #[cfg(all(feature = "kkterm-rdp", nextdesk_kkterm_rdp))]
            kkterm_rdp_ctrl_alt_delete,
            #[cfg(all(
                feature = "kkterm-rdp",
                nextdesk_kkterm_rdp,
                not(target_os = "windows")
            ))]
            kkterm_rdp_set_active_clipboard_session,
            #[cfg(all(
                feature = "kkterm-rdp",
                nextdesk_kkterm_rdp,
                not(target_os = "windows")
            ))]
            kkterm_rdp_force_clipboard_check,
            #[cfg(all(feature = "kkterm-rdp", nextdesk_kkterm_rdp))]
            kkterm_rdp_disconnect,
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
    use super::cloud_authorization_base_url_from_state;
    use crate::state::AppState;

    #[test]
    fn cloud_authorization_base_url_uses_builtin_default_without_subscription() {
        let app_state = AppState::default();

        assert_eq!(
            cloud_authorization_base_url_from_state(&app_state).unwrap(),
            "https://oauth.mxolab.com"
        );
    }

    #[test]
    fn cloud_authorization_base_url_ignores_saved_override() {
        let app_state = AppState::default();
        *app_state.cloud_authorization_base_url.lock().unwrap() =
            "https://a1.libraslink10.xyz/path".to_string();

        assert_eq!(
            cloud_authorization_base_url_from_state(&app_state).unwrap(),
            "https://oauth.mxolab.com"
        );
    }
}

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::{Child, Command};

use crate::config::{get_log_dir, get_user_config_dir, PROXY_DELAY_TEST_URL};

const PROXY_ENV_VARS: &[&str] = &[
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
];
const PROXY_DELAY_TEST_URLS: &[&str] = &[
    PROXY_DELAY_TEST_URL,
    "http://cp.cloudflare.com/generate_204",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProxyDelayAttempt {
    pub url: String,
    pub status: String,
    pub delay: Option<i64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProxyDelayDetail {
    pub name: String,
    pub delay: i64,
    pub url: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub attempts: Vec<ProxyDelayAttempt>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProxyPlaneDiagnostics {
    pub api_base: String,
    pub api_ready: bool,
    pub proxy_count: usize,
    pub real_proxy_count: usize,
    pub delay_urls: Vec<String>,
    pub details: Vec<ProxyDelayDetail>,
}

fn http_client() -> Client {
    Client::builder()
        .timeout(Duration::from_secs(10))
        .no_proxy() // Always bypass system proxy for local Clash API
        .build()
        .unwrap_or_default()
}

fn encode_proxy_name(name: &str) -> String {
    urlencoding::encode(name).into_owned()
}

fn normalize_delay(delay: i64) -> i64 {
    if delay > 0 {
        delay
    } else {
        -1
    }
}

impl ProxyDelayDetail {
    fn success(name: &str, url: &str, delay: i64, attempts: Vec<ProxyDelayAttempt>) -> Self {
        Self {
            name: name.to_string(),
            delay: normalize_delay(delay),
            url: Some(url.to_string()),
            status: "ok".to_string(),
            error: None,
            attempts,
        }
    }

    fn failed(name: &str, attempts: Vec<ProxyDelayAttempt>) -> Self {
        let error = attempts
            .iter()
            .map(|attempt| {
                let reason = attempt
                    .error
                    .clone()
                    .unwrap_or_else(|| attempt.status.clone());
                format!("{}: {reason}", attempt.url)
            })
            .collect::<Vec<String>>()
            .join("; ");
        Self {
            name: name.to_string(),
            delay: -1,
            url: None,
            status: "failed".to_string(),
            error: Some(error),
            attempts,
        }
    }
}

async fn fetch_proxies_snapshot(api_base: &str) -> Option<Value> {
    let client = http_client();
    let url = format!("{api_base}/proxies");
    let resp = client.get(&url).send().await.ok()?;
    resp.json::<Value>().await.ok()
}

pub async fn get_proxy_group_members(api_base: &str, group_name: &str) -> Option<Vec<String>> {
    let client = http_client();
    let encoded = encode_proxy_name(group_name);
    let url = format!("{api_base}/proxies/{encoded}");
    let resp = client.get(&url).send().await.ok()?;
    let data = resp.json::<Value>().await.ok()?;
    data.get("all")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect::<Vec<String>>()
        })
}

async fn test_proxy_delay_detail(api_base: &str, proxy_name: &str) -> ProxyDelayDetail {
    let client = http_client();
    let encoded = encode_proxy_name(proxy_name);
    let endpoint = format!("{api_base}/proxies/{encoded}/delay");
    let mut attempts = Vec::new();

    for test_url in PROXY_DELAY_TEST_URLS {
        let resp = client
            .get(&endpoint)
            .query(&[("url", *test_url), ("timeout", "5000")])
            .send()
            .await;

        match resp {
            Ok(response) if response.status().is_success() => {
                match response.json::<Value>().await {
                    Ok(payload) => {
                        let raw_delay = payload.get("delay").and_then(|v| v.as_i64());
                        let normalized = raw_delay.map(normalize_delay);
                        if let Some(delay) = normalized.filter(|delay| *delay > 0) {
                            attempts.push(ProxyDelayAttempt {
                                url: (*test_url).to_string(),
                                status: "ok".to_string(),
                                delay: Some(delay),
                                error: None,
                            });
                            return ProxyDelayDetail::success(
                                proxy_name, test_url, delay, attempts,
                            );
                        }

                        let error = match raw_delay {
                            Some(0) => "delay returned 0".to_string(),
                            Some(delay) => format!("delay returned {delay}"),
                            None => "missing delay".to_string(),
                        };
                        attempts.push(ProxyDelayAttempt {
                            url: (*test_url).to_string(),
                            status: "invalid_delay".to_string(),
                            delay: raw_delay,
                            error: Some(error),
                        });
                    }
                    Err(error) => {
                        attempts.push(ProxyDelayAttempt {
                            url: (*test_url).to_string(),
                            status: "invalid_json".to_string(),
                            delay: None,
                            error: Some(error.to_string()),
                        });
                    }
                }
            }
            Ok(response) => {
                attempts.push(ProxyDelayAttempt {
                    url: (*test_url).to_string(),
                    status: "http_error".to_string(),
                    delay: None,
                    error: Some(format!("HTTP {}", response.status())),
                });
            }
            Err(error) => {
                attempts.push(ProxyDelayAttempt {
                    url: (*test_url).to_string(),
                    status: "request_error".to_string(),
                    delay: None,
                    error: Some(error.to_string()),
                });
            }
        }
    }

    ProxyDelayDetail::failed(proxy_name, attempts)
}

pub async fn test_group_delay_details(api_base: &str, proxies: &[String]) -> Vec<ProxyDelayDetail> {
    let mut handles = Vec::with_capacity(proxies.len());
    for proxy in proxies {
        let api_base = api_base.to_string();
        let proxy_name = proxy.clone();
        handles.push((
            proxy.clone(),
            tokio::spawn(async move { test_proxy_delay_detail(&api_base, &proxy_name).await }),
        ));
    }

    let mut details = Vec::with_capacity(handles.len());
    for (proxy_name, handle) in handles {
        match handle.await {
            Ok(detail) => details.push(detail),
            Err(error) => details.push(ProxyDelayDetail::failed(
                &proxy_name,
                vec![ProxyDelayAttempt {
                    url: "internal".to_string(),
                    status: "task_error".to_string(),
                    delay: None,
                    error: Some(error.to_string()),
                }],
            )),
        }
    }
    details
}

/// Trigger geodata update on external Clash
pub async fn trigger_geodata_update(api_base: &str) {
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .no_proxy()
        .build()
        .unwrap_or_default();
    let url = format!("{api_base}/configs/geo");
    let _ = client.post(&url).send().await;
}

/// Start Clash/mihomo process
pub async fn start_clash_process() -> Result<Child, String> {
    let bin_dir = get_bin_dir();
    eprintln!("[clash] bin_dir: {}", bin_dir.display());
    let binary_name = engine_binary_name(&bin_dir);
    let mihomo_path = bin_dir.join(binary_name);
    if !mihomo_path.exists() {
        return Err(format!(
            "Engine binary not found: {}",
            mihomo_path.display()
        ));
    }

    let config_path = get_user_config_dir().join("runtime_clash.yaml");
    if !config_path.exists() {
        return Err("Clash config not found".into());
    }

    // Copy bundled geodata files to config dir so mihomo
    // doesn't need to download them on first launch
    let config_dir = get_user_config_dir();
    for fname in &["Country.mmdb", "geoip.metadb", "geosite.dat"] {
        let src = bin_dir.join(fname);
        let dst = config_dir.join(fname);
        if src.exists() && !dst.exists() {
            if let Err(e) = fs::copy(&src, &dst) {
                eprintln!("[clash] Failed to copy {fname}: {e}");
            } else {
                eprintln!("[clash] Copied {fname} to config dir");
            }
        }
    }

    let log_path = get_log_dir().join("clash.log");
    let log_file = fs::File::create(&log_path).map_err(|e| format!("Log create failed: {e}"))?;
    let stderr_file = log_file
        .try_clone()
        .map_err(|e| format!("Clone failed: {e}"))?;

    let runtime_mihomo_path = prepare_runtime_engine_binary(&mihomo_path)?;

    let mut cmd = Command::new(&runtime_mihomo_path);
    cmd.arg("-f")
        .arg(&config_path)
        .arg("-d")
        .arg(&config_dir)
        .current_dir(&config_dir)
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(stderr_file))
        .kill_on_drop(true);

    for var in PROXY_ENV_VARS {
        cmd.env_remove(var);
    }

    // Hide the console window on Windows
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd.spawn().map_err(|e| format!("Spawn failed: {e}"))?;

    Ok(child)
}

fn engine_binary_name(bin_dir: &Path) -> &'static str {
    if !cfg!(target_os = "windows") {
        return "nextdesk-core";
    }

    let preferred = windows_engine_binary_name();
    if bin_dir.join(preferred).exists() {
        return preferred;
    }

    if bin_dir.join("nextdesk-core-amd64.exe").exists() {
        return "nextdesk-core-amd64.exe";
    }

    "nextdesk-core.exe"
}

#[cfg(target_os = "windows")]
fn windows_engine_binary_name() -> &'static str {
    windows_engine_binary_name_for_native_arch(windows_native_arch())
}

#[cfg(not(target_os = "windows"))]
fn windows_engine_binary_name() -> &'static str {
    "nextdesk-core"
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn windows_engine_binary_name_for_native_arch(native_arch: Option<&str>) -> &'static str {
    match native_arch {
        Some("arm64") => "nextdesk-core-arm64.exe",
        Some("amd64") => "nextdesk-core-amd64.exe",
        _ => "nextdesk-core.exe",
    }
}

#[cfg(target_os = "windows")]
fn windows_native_arch() -> Option<&'static str> {
    use windows::Win32::System::SystemInformation::{
        GetNativeSystemInfo, PROCESSOR_ARCHITECTURE_AMD64, PROCESSOR_ARCHITECTURE_ARM64,
        SYSTEM_INFO,
    };

    let mut info = SYSTEM_INFO::default();
    unsafe {
        GetNativeSystemInfo(&mut info);
        let arch = info.Anonymous.Anonymous.wProcessorArchitecture;
        if arch == PROCESSOR_ARCHITECTURE_ARM64 {
            return Some("arm64");
        }
        if arch == PROCESSOR_ARCHITECTURE_AMD64 {
            return Some("amd64");
        }
    }

    let arch = std::env::var("PROCESSOR_ARCHITEW6432")
        .or_else(|_| std::env::var("PROCESSOR_ARCHITECTURE"))
        .unwrap_or_default()
        .to_ascii_lowercase();

    match arch.as_str() {
        "arm64" => Some("arm64"),
        "amd64" | "x86_64" => Some("amd64"),
        _ => None,
    }
}

fn prepare_runtime_engine_binary(source: &Path) -> Result<PathBuf, String> {
    #[cfg(not(target_os = "windows"))]
    {
        return Ok(source.to_path_buf());
    }

    #[cfg(target_os = "windows")]
    {
        use std::time::{SystemTime, UNIX_EPOCH};

        let runtime_dir = std::env::temp_dir().join("nextdesk-core-runtime");
        fs::create_dir_all(&runtime_dir)
            .map_err(|e| format!("Create runtime engine dir failed: {e}"))?;

        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default();
        let extension = source
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| format!(".{ext}"))
            .unwrap_or_default();
        let runtime_path = runtime_dir.join(format!(
            "nextdesk-core-{}-{suffix}{extension}",
            std::process::id()
        ));

        fs::copy(source, &runtime_path)
            .map_err(|e| format!("Copy runtime engine binary failed: {e}"))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&runtime_path, fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("Set runtime engine permission failed: {e}"))?;
        }

        eprintln!(
            "[clash] runtime core: {} -> {}",
            source.display(),
            runtime_path.display()
        );
        Ok(runtime_path)
    }
}

/// Get bin directory (next to executable or project root)
fn get_bin_dir() -> std::path::PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let bin = parent.join("bin");
            if bin.exists() {
                return bin;
            }
            // macOS: Contents/MacOS/../Resources/bin
            let resources = parent.join("../Resources/bin");
            if resources.exists() {
                return resources;
            }
        }
    }
    // Dev mode fallback: .backend/bin relative to project root
    // (cargo runs from src-tauri/, so go up one level)
    if let Ok(cwd) = std::env::current_dir() {
        // Try cwd/.backend/bin (when run from project root)
        let dev_bin = cwd.join(".backend/bin");
        if dev_bin.exists() {
            return dev_bin;
        }
        // Try cwd/../.backend/bin (when run from src-tauri/)
        if let Some(parent) = cwd.parent() {
            let dev_bin2 = parent.join(".backend/bin");
            if dev_bin2.exists() {
                return dev_bin2;
            }
        }
    }
    // Final fallback
    std::path::PathBuf::from(".backend/bin")
}

/// Get the currently active proxy in a group
pub async fn get_active_proxy(api_base: &str, group_name: &str) -> Option<String> {
    let client = http_client();
    let encoded = encode_proxy_name(group_name);
    let url = format!("{api_base}/proxies/{encoded}");
    let resp = client.get(&url).send().await.ok()?;
    let data: Value = resp.json().await.ok()?;
    data.get("now")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Switch proxy in a group
pub async fn switch_proxy(api_base: &str, group_name: &str, proxy_name: &str) -> bool {
    let client = http_client();
    let encoded = encode_proxy_name(group_name);
    let url = format!("{api_base}/proxies/{encoded}");
    let body = serde_json::json!({"name": proxy_name});
    match client.put(&url).json(&body).send().await {
        Ok(resp) => {
            let success = resp.status().as_u16() == 204;
            if success {
                // Close existing RDP connections (port 3389/22) that were routed
                // through this group, so they reconnect via the new node
                close_rdp_connections(api_base, group_name).await;
            }
            success
        }
        Err(_) => false,
    }
}

/// Close active RDP/SSH connections routed through a specific proxy group.
/// This forces reconnection through the newly selected node after a switch.
async fn close_rdp_connections(api_base: &str, group_name: &str) {
    let client = http_client();
    let url = format!("{api_base}/connections");
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(_) => return,
    };
    let data: Value = match resp.json().await {
        Ok(d) => d,
        Err(_) => return,
    };

    let Some(conns) = data.get("connections").and_then(|v| v.as_array()) else {
        return;
    };

    let rdp_ports: &[u16] = &[3389, 22];

    for conn in conns {
        // Parse destination port
        let dest_port: u16 = conn
            .get("metadata")
            .and_then(|m| m.get("destinationPort"))
            .and_then(|p| {
                p.as_u64()
                    .or_else(|| p.as_str().and_then(|s| s.parse().ok()))
            })
            .unwrap_or(0) as u16;

        if !rdp_ports.contains(&dest_port) {
            continue;
        }

        // Check if this connection goes through the switched group
        let goes_through_group = conn
            .get("chains")
            .and_then(|c| c.as_array())
            .map(|arr| arr.iter().any(|c| c.as_str() == Some(group_name)))
            .unwrap_or(false);

        if !goes_through_group {
            continue;
        }

        // Close this connection
        if let Some(id) = conn.get("id").and_then(|v| v.as_str()) {
            let close_url = format!("{api_base}/connections/{id}");
            let _ = client.delete(&close_url).send().await;
            eprintln!("[clash] Closed RDP connection {id} (port {dest_port}) after node switch in {group_name}");
        }
    }
}

/// Test delays for all proxies in a group
pub async fn test_group_delays(
    api_base: &str,
    _group_name: &str,
    proxies: &[String],
) -> std::collections::HashMap<String, i64> {
    test_group_delay_details(api_base, proxies)
        .await
        .into_iter()
        .map(|detail| (detail.name, detail.delay))
        .collect()
}

pub async fn get_proxy_plane_diagnostics(
    api_base: &str,
    proxy_count: usize,
    proxies: &[String],
) -> ProxyPlaneDiagnostics {
    let api_ready = fetch_proxies_snapshot(api_base).await.is_some();
    let details = test_group_delay_details(api_base, proxies).await;
    ProxyPlaneDiagnostics {
        api_base: api_base.to_string(),
        api_ready,
        proxy_count,
        real_proxy_count: proxies.len(),
        delay_urls: PROXY_DELAY_TEST_URLS
            .iter()
            .map(|url| (*url).to_string())
            .collect(),
        details,
    }
}

/// Get current connections
pub async fn get_connections(api_base: &str) -> Value {
    let client = http_client();
    let url = format!("{api_base}/connections");
    match client.get(&url).send().await {
        Ok(resp) => resp.json().await.unwrap_or_else(|_| {
            serde_json::json!({
                "connections": [],
                "downloadTotal": 0,
                "uploadTotal": 0
            })
        }),
        Err(_) => serde_json::json!({
            "connections": [],
            "downloadTotal": 0,
            "uploadTotal": 0
        }),
    }
}

/// Read last 5000 chars of clash log
pub fn get_clash_log() -> String {
    let log_path = get_log_dir().join("clash.log");
    match fs::read_to_string(&log_path) {
        Ok(content) => {
            let len = content.len();
            if len > 5000 {
                content[len - 5000..].to_string()
            } else {
                content
            }
        }
        Err(_) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    #[cfg(not(target_os = "windows"))]
    use std::fs;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::{
        get_proxy_group_members, prepare_runtime_engine_binary, test_proxy_delay_detail,
        windows_engine_binary_name_for_native_arch, ProxyDelayAttempt, ProxyDelayDetail,
        PROXY_DELAY_TEST_URLS,
    };

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn non_windows_uses_bundled_engine_path() {
        let source =
            std::env::temp_dir().join(format!("nextdesk-core-test-source-{}", std::process::id()));
        fs::write(&source, b"fake core").unwrap();

        let prepared = prepare_runtime_engine_binary(&source).unwrap();

        assert_eq!(prepared, source);
        let _ = fs::remove_file(&prepared);
    }

    #[test]
    fn delay_url_queue_prefers_gstatic_then_cloudflare() {
        assert_eq!(PROXY_DELAY_TEST_URLS.len(), 2);
        assert_eq!(
            PROXY_DELAY_TEST_URLS[0],
            "http://www.gstatic.com/generate_204"
        );
        assert_eq!(
            PROXY_DELAY_TEST_URLS[1],
            "http://cp.cloudflare.com/generate_204"
        );
    }

    #[test]
    fn windows_engine_binary_name_tracks_native_arch() {
        assert_eq!(
            windows_engine_binary_name_for_native_arch(Some("arm64")),
            "nextdesk-core-arm64.exe"
        );
        assert_eq!(
            windows_engine_binary_name_for_native_arch(Some("amd64")),
            "nextdesk-core-amd64.exe"
        );
        assert_eq!(
            windows_engine_binary_name_for_native_arch(Some("unknown")),
            "nextdesk-core.exe"
        );
        assert_eq!(
            windows_engine_binary_name_for_native_arch(None),
            "nextdesk-core.exe"
        );
    }

    #[test]
    fn proxy_delay_detail_failed_keeps_per_url_diagnostics() {
        let detail = ProxyDelayDetail::failed(
            "node-a",
            vec![
                ProxyDelayAttempt {
                    url: "http://www.gstatic.com/generate_204".to_string(),
                    status: "request_error".to_string(),
                    delay: None,
                    error: Some("dns failed".to_string()),
                },
                ProxyDelayAttempt {
                    url: "http://cp.cloudflare.com/generate_204".to_string(),
                    status: "http_error".to_string(),
                    delay: None,
                    error: Some("HTTP 503 Service Unavailable".to_string()),
                },
            ],
        );

        assert_eq!(detail.name, "node-a");
        assert_eq!(detail.delay, -1);
        assert_eq!(detail.status, "failed");
        assert_eq!(detail.attempts.len(), 2);
        assert_eq!(
            detail.attempts[0].url,
            "http://www.gstatic.com/generate_204"
        );
        assert_eq!(detail.attempts[0].status, "request_error");
        assert_eq!(detail.attempts[1].status, "http_error");
        assert!(detail
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("dns failed"));
    }

    #[tokio::test]
    async fn per_node_delay_falls_back_to_cloudflare_after_gstatic_error() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener should bind");
        let addr = listener
            .local_addr()
            .expect("test listener should expose local addr");

        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut stream, _) = listener
                    .accept()
                    .await
                    .expect("test server should accept client");
                let mut buf = [0_u8; 4096];
                let n = stream
                    .read(&mut buf)
                    .await
                    .expect("test server should read request");
                let request = String::from_utf8_lossy(&buf[..n]);
                let response = if request.contains("www.gstatic.com") {
                    "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string()
                } else if request.contains("cp.cloudflare.com") {
                    let body = r#"{"delay":123}"#;
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                } else {
                    let body = r#"{"error":"unexpected url"}"#;
                    format!(
                        "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                };
                stream
                    .write_all(response.as_bytes())
                    .await
                    .expect("test server should write response");
            }
        });

        let detail = test_proxy_delay_detail(&format!("http://{addr}"), "US Server Only 01").await;
        server.await.expect("test server should finish");

        assert_eq!(detail.status, "ok");
        assert_eq!(detail.delay, 123);
        assert_eq!(
            detail.url.as_deref(),
            Some("http://cp.cloudflare.com/generate_204")
        );
        assert_eq!(detail.attempts.len(), 2);
        assert_eq!(detail.attempts[0].status, "http_error");
        assert_eq!(detail.attempts[1].status, "ok");
    }

    #[tokio::test]
    async fn proxy_group_members_come_from_runtime_all_list() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener should bind");
        let addr = listener
            .local_addr()
            .expect("test listener should expose local addr");

        let server = tokio::spawn(async move {
            let (mut stream, _) = listener
                .accept()
                .await
                .expect("test server should accept client");
            let mut buf = [0_u8; 4096];
            let _ = stream
                .read(&mut buf)
                .await
                .expect("test server should read request");
            let body = r#"{"all":["⚡ Auto-Americas","🇺🇸 US Server Only 01","DIRECT"]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .await
                .expect("test server should write response");
        });

        let members = get_proxy_group_members(&format!("http://{addr}"), "🖥 Server-Americas")
            .await
            .expect("runtime group should expose all members");
        server.await.expect("test server should finish");

        assert_eq!(
            members,
            vec![
                "⚡ Auto-Americas".to_string(),
                "🇺🇸 US Server Only 01".to_string(),
                "DIRECT".to_string()
            ]
        );
    }
}

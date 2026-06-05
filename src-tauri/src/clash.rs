use reqwest::Client;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::process::{Child, Command};

use crate::config::{get_log_dir, get_user_config_dir};

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

fn extract_delay_from_proxy_info(info: &Value) -> Option<i64> {
    if let Some(delay) = info
        .get("history")
        .and_then(|v| v.as_array())
        .and_then(|items| items.last())
        .and_then(|entry| entry.get("delay"))
        .and_then(|v| v.as_i64())
    {
        return Some(normalize_delay(delay));
    }

    match info.get("alive").and_then(|v| v.as_bool()) {
        Some(false) => Some(-1),
        _ => None,
    }
}

fn merge_delays_with_snapshot(
    results: &mut std::collections::HashMap<String, i64>,
    proxies: &[String],
    snapshot: &Value,
) {
    let Some(proxy_map) = snapshot.get("proxies").and_then(|v| v.as_object()) else {
        return;
    };

    for proxy in proxies {
        if results.contains_key(proxy) {
            continue;
        }
        let Some(info) = proxy_map.get(proxy) else {
            continue;
        };
        if let Some(delay) = extract_delay_from_proxy_info(info) {
            results.insert(proxy.clone(), delay);
        }
    }
}

async fn fetch_proxies_snapshot(api_base: &str) -> Option<Value> {
    let client = http_client();
    let url = format!("{api_base}/proxies");
    let resp = client.get(&url).send().await.ok()?;
    resp.json::<Value>().await.ok()
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
    let binary_name = if cfg!(target_os = "windows") {
        "nextdesk-core.exe"
    } else {
        "nextdesk-core"
    };
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

fn prepare_runtime_engine_binary(source: &Path) -> Result<PathBuf, String> {
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
    group_name: &str,
    proxies: &[String],
) -> std::collections::HashMap<String, i64> {
    let snapshot = fetch_proxies_snapshot(api_base).await;
    let mut results = std::collections::HashMap::new();

    // Try group delay endpoint first (mihomo)
    let client = http_client();
    let encoded_group = encode_proxy_name(group_name);
    let group_url = format!("{api_base}/group/{encoded_group}/delay");
    eprintln!("[delay] Testing group: {group_name}, url: {group_url}");
    let group_resp = client
        .get(&group_url)
        .query(&[
            ("url", "http://www.gstatic.com/generate_204"),
            ("timeout", "5000"),
        ])
        .send()
        .await;

    if let Ok(resp) = group_resp {
        eprintln!("[delay] Group response status: {}", resp.status());
        if resp.status().is_success() {
            if let Ok(data) = resp
                .json::<std::collections::HashMap<String, Value>>()
                .await
            {
                for (name, val) in &data {
                    let delay = val
                        .as_i64()
                        .or_else(|| val.get("delay").and_then(|d| d.as_i64()))
                        .map(normalize_delay)
                        .unwrap_or(-1);
                    results.insert(name.clone(), delay);
                }
            }
        }
    }

    if let Some(snapshot) = snapshot.as_ref() {
        merge_delays_with_snapshot(&mut results, proxies, snapshot);
    }

    eprintln!(
        "[delay] Merged results: {}/{} nodes",
        results.len(),
        proxies.len()
    );
    if results.len() == proxies.len() {
        return results;
    }

    let missing: Vec<String> = proxies
        .iter()
        .filter(|proxy| !results.contains_key(*proxy))
        .cloned()
        .collect();

    // Fallback: test unresolved proxies individually
    eprintln!(
        "[delay] Fallback: testing {} unresolved proxies individually",
        missing.len()
    );
    let mut handles = vec![];
    for proxy in missing {
        let base = api_base.to_string();
        let name = proxy;
        handles.push(tokio::spawn(async move {
            let client = Client::builder()
                .timeout(Duration::from_secs(10))
                .no_proxy()
                .build()
                .unwrap_or_default();
            let encoded = encode_proxy_name(&name);
            let url = format!("{base}/proxies/{encoded}/delay");
            let resp = client
                .get(&url)
                .query(&[
                    ("url", "http://www.gstatic.com/generate_204"),
                    ("timeout", "5000"),
                ])
                .send()
                .await;
            let delay = match resp {
                Ok(r) if r.status().is_success() => r
                    .json::<Value>()
                    .await
                    .ok()
                    .and_then(|d| d.get("delay").and_then(|v| v.as_i64()))
                    .map(normalize_delay)
                    .unwrap_or(-1),
                Ok(r) => {
                    eprintln!("[delay] {} => HTTP {}", name, r.status());
                    -1
                }
                Err(e) => {
                    eprintln!("[delay] {} => error: {}", name, e);
                    -1
                }
            };
            (name, delay)
        }));
    }

    for handle in handles {
        if let Ok((name, delay)) = handle.await {
            results.insert(name, delay);
        }
    }
    results
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
    use std::collections::HashMap;

    use serde_json::json;

    use super::{extract_delay_from_proxy_info, merge_delays_with_snapshot};

    #[test]
    fn merges_partial_group_results_with_snapshot_failures() {
        let proxies = vec!["US".to_string(), "HK".to_string(), "JP".to_string()];
        let mut results = HashMap::from([("HK".to_string(), 91)]);
        let snapshot = json!({
            "proxies": {
                "US": {
                    "alive": false,
                    "history": [{"delay": 0}]
                },
                "HK": {
                    "alive": true,
                    "history": [{"delay": 91}]
                },
                "JP": {
                    "alive": true,
                    "history": []
                }
            }
        });

        merge_delays_with_snapshot(&mut results, &proxies, &snapshot);

        assert_eq!(results.get("US"), Some(&-1));
        assert_eq!(results.get("HK"), Some(&91));
        assert_eq!(results.get("JP"), None);
    }

    #[test]
    fn extracts_delay_from_proxy_snapshot_history() {
        let success = json!({
            "alive": true,
            "history": [{"delay": 42}]
        });
        let failed = json!({
            "alive": false,
            "history": [{"delay": 0}]
        });
        let pending = json!({
            "alive": true,
            "history": []
        });

        assert_eq!(extract_delay_from_proxy_info(&success), Some(42));
        assert_eq!(extract_delay_from_proxy_info(&failed), Some(-1));
        assert_eq!(extract_delay_from_proxy_info(&pending), None);
    }
}

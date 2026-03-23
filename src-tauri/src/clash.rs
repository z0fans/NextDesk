use reqwest::Client;
use serde_json::Value;
use std::fs;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::{Child, Command};

use crate::config::{get_log_dir, get_user_config_dir};

const CLASH_API_PORTS: &[u16] = &[9090, 9097, 7891, 7890];
#[allow(dead_code)]
const DEFAULT_CLASH_API: &str = "http://127.0.0.1:17891";
const RDP_GROUP_KEYWORDS: &[&str] = &["server-", "auto-"];

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

/// Detect external Clash instance on common ports
pub async fn detect_external_clash()
    -> Option<(String, u16)>
{
    let client = Client::builder()
        .timeout(Duration::from_secs(1))
        .no_proxy() // Bypass system proxy for local detection
        .build()
        .ok()?;

    for &port in CLASH_API_PORTS {
        let url =
            format!("http://127.0.0.1:{port}/version");
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                return Some((
                    "127.0.0.1".into(),
                    port,
                ));
            }
        }
    }
    None
}

/// Get proxy port from external Clash config
pub async fn get_clash_proxy_port(
    host: &str,
    port: u16,
) -> u16 {
    let client = http_client();
    let url = format!("http://{host}:{port}/configs");
    if let Ok(resp) = client.get(&url).send().await {
        if let Ok(data) = resp.json::<Value>().await {
            if let Some(p) = data
                .get("mixed-port")
                .or(data.get("socks-port"))
                .and_then(|v| v.as_u64())
            {
                return p as u16;
            }
        }
    }
    7897
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
pub async fn start_clash_process()
    -> Result<Child, String>
{
    let bin_dir = get_bin_dir();
    eprintln!("[clash] bin_dir: {}", bin_dir.display());
    let binary_name = if cfg!(target_os = "windows") {
        "mihomo.exe"
    } else {
        "mihomo"
    };
    let mihomo_path = bin_dir.join(binary_name);
    if !mihomo_path.exists() {
        return Err(format!(
            "mihomo binary not found: {}",
            mihomo_path.display()
        ));
    }

    let config_path =
        get_user_config_dir().join("runtime_clash.yaml");
    if !config_path.exists() {
        return Err("Clash config not found".into());
    }

    // Copy bundled geodata files to config dir so mihomo
    // doesn't need to download them on first launch
    let config_dir = get_user_config_dir();
    for fname in &[
        "Country.mmdb",
        "geoip.metadb",
        "geosite.dat",
    ] {
        let src = bin_dir.join(fname);
        let dst = config_dir.join(fname);
        if src.exists() && !dst.exists() {
            if let Err(e) = fs::copy(&src, &dst) {
                eprintln!(
                    "[clash] Failed to copy {fname}: {e}"
                );
            } else {
                eprintln!("[clash] Copied {fname} to config dir");
            }
        }
    }

    let log_path = get_log_dir().join("clash.log");
    let log_file = fs::File::create(&log_path)
        .map_err(|e| format!("Log create failed: {e}"))?;
    let stderr_file = log_file
        .try_clone()
        .map_err(|e| format!("Clone failed: {e}"))?;

    let child = Command::new(&mihomo_path)
        .arg("-f")
        .arg(&config_path)
        .current_dir(&config_dir)
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(stderr_file))
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Spawn failed: {e}"))?;

    Ok(child)
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
            let resources = parent
                .join("../Resources/bin");
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

/// Fetch proxy groups filtered by RDP keywords
pub async fn fetch_proxy_groups(
    api_base: &str,
) -> Vec<Value> {
    let client = http_client();
    let url = format!("{api_base}/proxies");
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(_) => return vec![],
    };
    let data: Value = match resp.json().await {
        Ok(d) => d,
        Err(_) => return vec![],
    };
    let proxies = match data.get("proxies") {
        Some(Value::Object(m)) => m,
        _ => return vec![],
    };

    let mut groups = vec![];
    for (name, info) in proxies {
        let ptype = info
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if ptype != "Selector" {
            continue;
        }
        let lower = name.to_lowercase();
        if !RDP_GROUP_KEYWORDS
            .iter()
            .any(|kw| lower.contains(kw))
        {
            continue;
        }
        groups.push(serde_json::json!({
            "name": name,
            "type": "select",
            "proxies": info.get("all")
                .unwrap_or(&Value::Array(vec![])),
            "now": info.get("now"),
        }));
    }
    groups
}

/// Get the currently active proxy in a group
pub async fn get_active_proxy(
    api_base: &str,
    group_name: &str,
) -> Option<String> {
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
pub async fn switch_proxy(
    api_base: &str,
    group_name: &str,
    proxy_name: &str,
) -> bool {
    let client = http_client();
    let encoded = encode_proxy_name(group_name);
    let url = format!("{api_base}/proxies/{encoded}");
    let body = serde_json::json!({"name": proxy_name});
    match client.put(&url).json(&body).send().await {
        Ok(resp) => resp.status().as_u16() == 204,
        Err(_) => false,
    }
}

/// Test delays for all proxies in a group
pub async fn test_group_delays(
    api_base: &str,
    group_name: &str,
    proxies: &[String],
) -> std::collections::HashMap<String, i64> {
    use std::collections::HashMap;

    // Try group delay endpoint first (mihomo)
    let client = http_client();
    let encoded_group = encode_proxy_name(group_name);
    let group_url = format!(
        "{api_base}/group/{encoded_group}/delay"
    );
    eprintln!(
        "[delay] Testing group: {group_name}, url: {group_url}"
    );
    let group_resp = client
        .get(&group_url)
        .query(&[
            ("url", "http://www.gstatic.com/generate_204"),
            ("timeout", "5000"),
        ])
        .send()
        .await;

    if let Ok(resp) = group_resp {
        eprintln!(
            "[delay] Group response status: {}",
            resp.status()
        );
        if resp.status().is_success() {
            if let Ok(data) =
                resp.json::<HashMap<String, Value>>().await
            {
                let mut results = HashMap::new();
                for (name, val) in &data {
                    let delay = val
                        .as_i64()
                        .or_else(|| {
                            val.get("delay")
                                .and_then(|d| d.as_i64())
                        })
                        .unwrap_or(-1);
                    results.insert(name.clone(), delay);
                }
                eprintln!(
                    "[delay] Group results: {} nodes",
                    results.len()
                );
                if !results.is_empty() {
                    return results;
                }
            }
        }
    }

    // Fallback: test each proxy individually
    eprintln!(
        "[delay] Fallback: testing {} proxies individually",
        proxies.len()
    );
    let mut results = HashMap::new();
    let mut handles = vec![];
    for proxy in proxies {
        let base = api_base.to_string();
        let name = proxy.clone();
        handles.push(tokio::spawn(async move {
            let client = Client::builder()
                .timeout(Duration::from_secs(10))
                .no_proxy()
                .build()
                .unwrap_or_default();
            let encoded = encode_proxy_name(&name);
            let url = format!(
                "{base}/proxies/{encoded}/delay"
            );
            let resp = client
                .get(&url)
                .query(&[
                    ("url", "http://www.gstatic.com/generate_204"),
                    ("timeout", "5000"),
                ])
                .send()
                .await;
            let delay = match resp {
                Ok(r) if r.status().is_success() => {
                    r.json::<Value>()
                        .await
                        .ok()
                        .and_then(|d| {
                            d.get("delay")
                                .and_then(|v| v.as_i64())
                        })
                        .unwrap_or(-1)
                }
                Ok(r) => {
                    eprintln!(
                        "[delay] {} => HTTP {}",
                        name,
                        r.status()
                    );
                    -1
                }
                Err(e) => {
                    eprintln!(
                        "[delay] {} => error: {}",
                        name, e
                    );
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
pub async fn get_connections(
    api_base: &str,
) -> Value {
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


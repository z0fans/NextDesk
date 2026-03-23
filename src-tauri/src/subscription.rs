use base64::Engine;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json;
use serde_yaml;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use url::Url;

use crate::state::Server;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscriptionResult {
    pub success: bool,
    pub error: Option<String>,
    pub server_count: usize,
    #[serde(default)]
    pub proxy_groups: Vec<serde_json::Value>,
}

pub struct ParsedSubscription {
    pub proxies: Vec<serde_yaml::Value>,
    pub proxy_groups: Vec<serde_yaml::Value>,
    pub raw_config: Option<serde_yaml::Value>,
}

/// Load subscription from URL
/// If `proxy_port` is provided, route through SOCKS5 proxy at 127.0.0.1:{port}.
/// Otherwise, force direct connection (bypass system proxy settings).
pub async fn load_subscription(
    url: &str,
    proxy_port: Option<u16>,
) -> Result<ParsedSubscription, String> {
    if url.trim().is_empty() {
        return Err("URL is empty".into());
    }
    let mut builder = Client::builder()
        .timeout(Duration::from_secs(15));

    if let Some(port) = proxy_port {
        // Use active SOCKS5 proxy
        let proxy = reqwest::Proxy::all(
            format!("socks5://127.0.0.1:{port}")
        ).map_err(|e| format!("Proxy config error: {e}"))?;
        builder = builder.proxy(proxy);
    } else {
        // No proxy available — force direct connection
        // (bypass stale system proxy settings)
        builder = builder.no_proxy();
    }

    let client = builder.build().map_err(|e| e.to_string())?;

    let resp = client
        .get(url.trim())
        .header("User-Agent", "clash-verge/v1.7.7")
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "Request timeout".to_string()
            } else if e.is_connect() {
                "Connection failed".to_string()
            } else {
                format!("HTTP error: {e}")
            }
        })?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    let content = resp
        .text()
        .await
        .map_err(|e| e.to_string())?;

    parse_subscription(&content)
}

fn parse_subscription(
    content: &str,
) -> Result<ParsedSubscription, String> {
    let content = content.trim();

    // Try base64 decode first
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(content)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok());

    for text in [decoded.as_deref(), Some(content)] {
        let text = match text {
            Some(t) if !t.is_empty() => t,
            _ => continue,
        };

        // Try JSON
        if text.starts_with('{') || text.starts_with('[') {
            if let Some(r) = try_parse_json(text) {
                return Ok(r);
            }
        }

        // Try YAML/Clash config
        if text.contains("proxies:")
            || text.starts_with("port:")
        {
            if let Some(r) = try_parse_clash_yaml(text) {
                return Ok(r);
            }
        }

        // Try URI list
        if ["ss://", "vmess://", "trojan://", "vless://"]
            .iter()
            .any(|s| text.contains(s))
        {
            let proxies = parse_uri_list(text);
            if !proxies.is_empty() {
                return Ok(ParsedSubscription {
                    proxies,
                    proxy_groups: vec![],
                    raw_config: None,
                });
            }
        }
    }

    Err("Unsupported subscription format".into())
}

fn try_parse_clash_yaml(
    content: &str,
) -> Option<ParsedSubscription> {
    let data: serde_yaml::Value =
        serde_yaml::from_str(content).ok()?;
    let map = data.as_mapping()?;

    let proxies = map
        .get(&ykey("proxies"))
        .and_then(|v| v.as_sequence())
        .cloned()
        .unwrap_or_default();

    if proxies.is_empty() {
        return None;
    }

    let proxy_groups = map
        .get(&ykey("proxy-groups"))
        .and_then(|v| v.as_sequence())
        .cloned()
        .unwrap_or_default();

    Some(ParsedSubscription {
        proxies,
        proxy_groups,
        raw_config: Some(data),
    })
}

fn try_parse_json(
    content: &str,
) -> Option<ParsedSubscription> {
    let data: serde_json::Value =
        serde_json::from_str(content).ok()?;

    if let Some(arr) = data.as_array() {
        let proxies: Vec<serde_yaml::Value> = arr
            .iter()
            .filter_map(|v| {
                serde_yaml::to_string(v)
                    .ok()
                    .and_then(|s| {
                        serde_yaml::from_str(&s).ok()
                    })
            })
            .collect();
        if !proxies.is_empty() {
            return Some(ParsedSubscription {
                proxies,
                proxy_groups: vec![],
                raw_config: None,
            });
        }
    }

    if let Some(obj) = data.as_object() {
        let proxy_key = if obj.contains_key("proxies") {
            "proxies"
        } else {
            "outbounds"
        };
        let proxies_json = obj
            .get(proxy_key)
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let proxies: Vec<serde_yaml::Value> = proxies_json
            .iter()
            .filter_map(|v| {
                serde_yaml::to_string(v)
                    .ok()
                    .and_then(|s| {
                        serde_yaml::from_str(&s).ok()
                    })
            })
            .collect();

        let groups_json = obj
            .get("proxy-groups")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let proxy_groups: Vec<serde_yaml::Value> =
            groups_json
                .iter()
                .filter_map(|v| {
                    serde_yaml::to_string(v)
                        .ok()
                        .and_then(|s| {
                            serde_yaml::from_str(&s).ok()
                        })
                })
                .collect();

        let raw = serde_yaml::to_string(&data)
            .ok()
            .and_then(|s| serde_yaml::from_str(&s).ok());

        if !proxies.is_empty() {
            return Some(ParsedSubscription {
                proxies,
                proxy_groups,
                raw_config: raw,
            });
        }
    }
    None
}

fn parse_uri_list(
    content: &str,
) -> Vec<serde_yaml::Value> {
    content
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.starts_with("ss://") {
                parse_ss_uri(line)
            } else if line.starts_with("vmess://") {
                parse_vmess_uri(line)
            } else if line.starts_with("trojan://") {
                parse_trojan_uri(line)
            } else if line.starts_with("vless://") {
                parse_vless_uri(line)
            } else {
                None
            }
        })
        .collect()
}

fn parse_ss_uri(
    uri: &str,
) -> Option<serde_yaml::Value> {
    let uri = &uri[5..]; // strip "ss://"
    let (main, name) = if let Some(idx) = uri.rfind('#') {
        let n = urlencoding::decode(&uri[idx + 1..])
            .unwrap_or_default()
            .to_string();
        (&uri[..idx], n)
    } else {
        (uri, "SS Server".to_string())
    };

    let (method, password, server, port) =
        if let Some(idx) = main.rfind('@') {
            let encoded = &main[..idx];
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(encoded.as_bytes())
                .or_else(|_| {
                    base64::engine::general_purpose::STANDARD
                        .decode(
                            format!("{encoded}==").as_bytes(),
                        )
                })
                .ok()
                .and_then(|b| String::from_utf8(b).ok());
            let (m, p) = match decoded {
                Some(d) => {
                    let parts: Vec<&str> =
                        d.splitn(2, ':').collect();
                    if parts.len() == 2 {
                        (parts[0].to_string(), parts[1].to_string())
                    } else {
                        return None;
                    }
                }
                None => {
                    let parts: Vec<&str> =
                        encoded.splitn(2, ':').collect();
                    if parts.len() == 2 {
                        (parts[0].to_string(), parts[1].to_string())
                    } else {
                        return None;
                    }
                }
            };
            let server_port = &main[idx + 1..];
            let sp: Vec<&str> =
                server_port.splitn(2, ':').collect();
            if sp.len() != 2 {
                return None;
            }
            (m, p, sp[0].to_string(), sp[1].to_string())
        } else {
            return None;
        };

    let port_num: u16 = port.parse().ok()?;
    Some(yaml_map(&[
        ("name", &name),
        ("type", "ss"),
        ("server", &server),
        ("port", &port_num.to_string()),
        ("cipher", &method),
        ("password", &password),
    ]))
}

fn parse_vmess_uri(
    uri: &str,
) -> Option<serde_yaml::Value> {
    let encoded = &uri[8..];
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded.as_bytes())
        .or_else(|_| {
            base64::engine::general_purpose::STANDARD
                .decode(format!("{encoded}==").as_bytes())
        })
        .ok()?;
    let data: HashMap<String, serde_json::Value> =
        serde_json::from_slice(&decoded).ok()?;

    let name = data
        .get("ps")
        .and_then(|v| v.as_str())
        .unwrap_or("VMess Server");
    let server = data
        .get("add")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let port = data
        .get("port")
        .and_then(|v| {
            v.as_u64()
                .or_else(|| {
                    v.as_str()
                        .and_then(|s| s.parse().ok())
                })
        })
        .unwrap_or(443);

    Some(yaml_map(&[
        ("name", name),
        ("type", "vmess"),
        ("server", server),
        ("port", &port.to_string()),
        (
            "uuid",
            data.get("id")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
        ),
    ]))
}

fn parse_trojan_uri(
    uri: &str,
) -> Option<serde_yaml::Value> {
    let parsed = Url::parse(uri).ok()?;
    let name = urlencoding::decode(parsed.fragment()?)
        .unwrap_or_default()
        .to_string();
    let name = if name.is_empty() {
        "Trojan Server"
    } else {
        &name
    };

    Some(yaml_map(&[
        ("name", name),
        ("type", "trojan"),
        ("server", parsed.host_str().unwrap_or("")),
        ("port", &parsed.port().unwrap_or(443).to_string()),
        ("password", parsed.username()),
    ]))
}

fn parse_vless_uri(
    uri: &str,
) -> Option<serde_yaml::Value> {
    let parsed = Url::parse(uri).ok()?;
    let name = urlencoding::decode(
        parsed.fragment().unwrap_or("VLESS Server"),
    )
    .unwrap_or_default()
    .to_string();
    let name = if name.is_empty() {
        "VLESS Server"
    } else {
        &name
    };

    Some(yaml_map(&[
        ("name", name),
        ("type", "vless"),
        ("server", parsed.host_str().unwrap_or("")),
        ("port", &parsed.port().unwrap_or(443).to_string()),
        ("uuid", parsed.username()),
    ]))
}

/// Convert parsed proxies to Server list for frontend
pub fn transform_proxies_to_servers(
    proxies: &[serde_yaml::Value],
) -> Vec<Server> {
    proxies
        .iter()
        .enumerate()
        .map(|(i, proxy)| {
            let fallback =
                format!("Server-{}", i + 1);
            let name = proxy
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or(&fallback)
                .to_string();
            let host = proxy
                .get("server")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            Server {
                id: (i + 1).to_string(),
                name,
                host,
                port: 3389,
                latency: None,
                status: "unknown".into(),
            }
        })
        .collect()
}

/// Test TCP connectivity to servers concurrently
pub async fn test_servers_connectivity(
    servers: &mut [Server],
) {
    let mut handles = vec![];
    for server in servers.iter() {
        let host = server.host.clone();
        let port = server.port;
        let id = server.id.clone();
        handles.push(tokio::spawn(async move {
            let addr = format!("{host}:{port}");
            let start = Instant::now();
            let result = tokio::time::timeout(
                Duration::from_secs(3),
                tokio::net::TcpStream::connect(&addr),
            )
            .await;
            match result {
                Ok(Ok(_)) => {
                    let ms =
                        start.elapsed().as_millis() as i64;
                    (id, "online".to_string(), Some(ms))
                }
                _ => {
                    (id, "offline".to_string(), None)
                }
            }
        }));
    }

    for handle in handles {
        if let Ok((id, status, latency)) = handle.await {
            if let Some(s) =
                servers.iter_mut().find(|s| s.id == id)
            {
                s.status = status;
                s.latency = latency;
            }
        }
    }
}

fn yaml_map(
    pairs: &[(&str, &str)],
) -> serde_yaml::Value {
    let mut m = serde_yaml::Mapping::new();
    for (k, v) in pairs {
        // Try to parse as integer for port
        if *k == "port" {
            if let Ok(n) = v.parse::<i64>() {
                m.insert(
                    serde_yaml::Value::String(
                        k.to_string(),
                    ),
                    serde_yaml::Value::Number(
                        serde_yaml::Number::from(n),
                    ),
                );
                continue;
            }
        }
        m.insert(
            serde_yaml::Value::String(k.to_string()),
            serde_yaml::Value::String(v.to_string()),
        );
    }
    serde_yaml::Value::Mapping(m)
}

fn ykey(s: &str) -> serde_yaml::Value {
    serde_yaml::Value::String(s.to_string())
}


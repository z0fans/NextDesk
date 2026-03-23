use serde::{Deserialize, Serialize};
use serde_json;
use serde_yaml;
use std::fs;
use std::path::PathBuf;

use crate::state::{ProxyGroup, Server};

const SOCKS_PORT: u16 = 17897;
const RDP_GROUP_KEYWORDS: &[&str] = &["server-", "auto-"];

pub fn get_user_config_dir() -> PathBuf {
    let base = dirs::config_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap());
    let config_dir = base.join("NextDesk");
    fs::create_dir_all(&config_dir).ok();
    config_dir
}

pub fn get_log_dir() -> PathBuf {
    let log_dir = get_user_config_dir().join("log");
    fs::create_dir_all(&log_dir).ok();
    log_dir
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct SavedConfig {
    #[serde(default)]
    pub subscription_url: String,
    #[serde(default)]
    pub servers: Vec<Server>,
    #[serde(default)]
    pub proxy_groups: Vec<ProxyGroup>,
}

pub fn load_saved_config() -> SavedConfig {
    let path = get_user_config_dir().join("config.json");
    if !path.exists() {
        return SavedConfig::default();
    }
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content)
            .unwrap_or_default(),
        Err(_) => SavedConfig::default(),
    }
}

pub fn save_config(cfg: &SavedConfig) {
    let path = get_user_config_dir().join("config.json");
    if let Ok(json) = serde_json::to_string_pretty(cfg) {
        fs::write(path, json).ok();
    }
}

pub fn generate_clash_config(
    proxies: &[serde_yaml::Value],
) -> PathBuf {
    let proxy_names: Vec<serde_yaml::Value> = proxies
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let fallback = format!("proxy-{i}");
            let name = p
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or(&fallback);
            serde_yaml::Value::String(name.to_string())
        })
        .collect();

    let default_proxies = if proxy_names.is_empty() {
        vec![serde_yaml::Value::String("DIRECT".into())]
    } else {
        proxy_names
    };

    let mut group = serde_yaml::Mapping::new();
    group.insert(
        serde_yaml::Value::String("name".into()),
        serde_yaml::Value::String("PROXY".into()),
    );
    group.insert(
        serde_yaml::Value::String("type".into()),
        serde_yaml::Value::String("select".into()),
    );
    group.insert(
        serde_yaml::Value::String("proxies".into()),
        serde_yaml::Value::Sequence(default_proxies),
    );

    let mut config = serde_yaml::Mapping::new();
    insert_yaml_int(&mut config, "port", 17890);
    insert_yaml_int(&mut config, "socks-port", SOCKS_PORT as i64);
    insert_yaml_str(
        &mut config,
        "external-controller",
        "127.0.0.1:17891",
    );
    config.insert(
        ykey("allow-lan"),
        serde_yaml::Value::Bool(false),
    );
    insert_yaml_str(&mut config, "mode", "rule");
    config.insert(
        ykey("geodata-mode"),
        serde_yaml::Value::Bool(false),
    );
    config.insert(
        ykey("geo-auto-update"),
        serde_yaml::Value::Bool(false),
    );
    config.insert(
        ykey("proxies"),
        serde_yaml::Value::Sequence(proxies.to_vec()),
    );
    config.insert(
        ykey("proxy-groups"),
        serde_yaml::Value::Sequence(vec![
            serde_yaml::Value::Mapping(group),
        ]),
    );
    config.insert(
        ykey("rules"),
        serde_yaml::Value::Sequence(vec![
            serde_yaml::Value::String("MATCH,PROXY".into()),
        ]),
    );

    let config_path =
        get_user_config_dir().join("runtime_clash.yaml");
    if let Ok(yaml_str) =
        serde_yaml::to_string(&serde_yaml::Value::Mapping(config))
    {
        fs::write(&config_path, yaml_str).ok();
    }
    config_path
}

pub fn generate_clash_config_from_subscription(
    raw_config: &serde_yaml::Value,
) -> PathBuf {
    let map = match raw_config.as_mapping() {
        Some(m) => m,
        None => return generate_clash_config(&[]),
    };

    let proxy_groups = map
        .get(&ykey("proxy-groups"))
        .and_then(|v| v.as_sequence())
        .cloned()
        .unwrap_or_default();

    // Collect all group names for reference resolution
    let all_group_names: std::collections::HashSet<String> = proxy_groups
        .iter()
        .filter_map(|g| g.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
        .collect();

    // Step 1: Find groups matching RDP keywords
    let mut keep_names: std::collections::HashSet<String> = proxy_groups
        .iter()
        .filter_map(|g| {
            let name = g.get("name").and_then(|n| n.as_str())?;
            let lower = name.to_lowercase();
            if RDP_GROUP_KEYWORDS.iter().any(|kw| lower.contains(kw)) {
                Some(name.to_string())
            } else {
                None
            }
        })
        .collect();

    // Step 2: Recursively add referenced sub-groups
    let mut changed = true;
    while changed {
        changed = false;
        for g in &proxy_groups {
            let name = g.get("name").and_then(|n| n.as_str()).unwrap_or("");
            if !keep_names.contains(name) {
                continue;
            }
            if let Some(proxies) = g.get("proxies").and_then(|v| v.as_sequence()) {
                for p in proxies {
                    if let Some(pname) = p.as_str() {
                        // If referenced name is a group (not an individual proxy), keep it
                        if all_group_names.contains(pname) && !keep_names.contains(pname) {
                            keep_names.insert(pname.to_string());
                            changed = true;
                        }
                    }
                }
            }
        }
    }

    // Step 3: Filter groups, preserving order
    let filtered_groups: Vec<serde_yaml::Value> = proxy_groups
        .into_iter()
        .filter(|g| {
            let name = g.get("name").and_then(|n| n.as_str()).unwrap_or("");
            keep_names.contains(name)
        })
        .collect();

    let group_names: Vec<String> = filtered_groups
        .iter()
        .filter_map(|g| {
            g.get("name")
                .and_then(|n| n.as_str())
                .map(|s| s.to_string())
        })
        .collect();

    let rules = map
        .get(&ykey("rules"))
        .and_then(|v| v.as_sequence())
        .cloned()
        .unwrap_or_default();

    let mut filtered_rules: Vec<serde_yaml::Value> = rules
        .into_iter()
        .filter(|r| {
            let s = r.as_str().unwrap_or("");
            if s.starts_with("RULE-SET,") {
                return false;
            }
            let parts: Vec<&str> = s.split(',').collect();
            if parts.len() >= 2 {
                let target = parts.last().unwrap().trim();
                group_names
                    .iter()
                    .any(|gn| gn == target)
                    || target == "DIRECT"
                    || target == "REJECT"
            } else {
                false
            }
        })
        .collect();

    let has_match = filtered_rules.iter().any(|r| {
        r.as_str()
            .map(|s| s.contains("MATCH"))
            .unwrap_or(false)
    });
    if !has_match {
        filtered_rules.push(serde_yaml::Value::String(
            "MATCH,DIRECT".into(),
        ));
    }

    let mode = map
        .get(&ykey("mode"))
        .and_then(|v| v.as_str())
        .unwrap_or("rule");

    let mut config = serde_yaml::Mapping::new();
    insert_yaml_int(&mut config, "port", 17890);
    insert_yaml_int(&mut config, "socks-port", SOCKS_PORT as i64);
    insert_yaml_str(
        &mut config,
        "external-controller",
        "127.0.0.1:17891",
    );
    config.insert(
        ykey("allow-lan"),
        serde_yaml::Value::Bool(false),
    );
    insert_yaml_str(&mut config, "mode", mode);
    config.insert(
        ykey("geodata-mode"),
        serde_yaml::Value::Bool(false),
    );
    config.insert(
        ykey("geo-auto-update"),
        serde_yaml::Value::Bool(false),
    );

    if let Some(proxies) = map.get(&ykey("proxies")) {
        config.insert(ykey("proxies"), proxies.clone());
    }
    config.insert(
        ykey("proxy-groups"),
        serde_yaml::Value::Sequence(filtered_groups),
    );
    config.insert(
        ykey("rules"),
        serde_yaml::Value::Sequence(filtered_rules),
    );

    if let Some(dns) = map.get(&ykey("dns")) {
        config.insert(ykey("dns"), dns.clone());
    }

    let config_path =
        get_user_config_dir().join("runtime_clash.yaml");
    if let Ok(yaml_str) =
        serde_yaml::to_string(&serde_yaml::Value::Mapping(config))
    {
        fs::write(&config_path, yaml_str).ok();
    }
    config_path
}

fn ykey(s: &str) -> serde_yaml::Value {
    serde_yaml::Value::String(s.to_string())
}

fn insert_yaml_str(
    m: &mut serde_yaml::Mapping,
    key: &str,
    val: &str,
) {
    m.insert(ykey(key), serde_yaml::Value::String(val.into()));
}

fn insert_yaml_int(
    m: &mut serde_yaml::Mapping,
    key: &str,
    val: i64,
) {
    m.insert(
        ykey(key),
        serde_yaml::Value::Number(serde_yaml::Number::from(val)),
    );
}


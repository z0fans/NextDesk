use serde::{Deserialize, Serialize};
use serde_json;
use serde_yaml;
use std::fs;
use std::path::PathBuf;
use std::process::Command as StdCommand;

use crate::state::{ProxyGroup, Server};

const SOCKS_PORT: u16 = 17897;
const SERVER_AMERICAS_GROUP: &str = "🖥 Server-Americas";
const SERVER_ASIA_GROUP: &str = "🖥 Server-Asia";
const SERVER_GLOBAL_GROUP: &str = "🖥 Server-Global";
const AUTO_AMERICAS_GROUP: &str = "⚡ Auto-Americas";
const AUTO_ASIA_GROUP: &str = "⚡ Auto-Asia";
const AUTO_GLOBAL_GROUP: &str = "⚡ Auto-Global";

pub(crate) fn is_subscription_metadata_proxy_name(name: &str) -> bool {
    let lower = name.trim().to_lowercase();
    lower.starts_with("traffic reset")
        || lower.starts_with("expire date")
        || lower.starts_with("__nextdesk_subscription_issuer_")
        || lower.starts_with("剩余流量")
        || lower.starts_with("流量重置")
        || lower.starts_with("到期时间")
        || lower.starts_with("过期时间")
        || lower.starts_with("套餐到期")
}

pub(crate) fn is_selectable_proxy_name(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty()
        && trimmed != "DIRECT"
        && trimmed != "REJECT"
        && !is_subscription_metadata_proxy_name(trimmed)
}

pub(crate) fn proxy_name(proxy: &serde_yaml::Value) -> Option<String> {
    proxy
        .get("name")
        .and_then(|n| n.as_str())
        .filter(|name| is_selectable_proxy_name(name))
        .map(|name| name.to_string())
}

#[cfg(test)]
pub(crate) fn real_proxy_names_from_yaml(
    proxies: &[serde_yaml::Value],
) -> std::collections::HashSet<String> {
    proxies.iter().filter_map(proxy_name).collect()
}

fn classify_rdp_proxy_names(proxy_names: &[String]) -> (Vec<String>, Vec<String>) {
    let americas_kw = &[
        "us ",
        "united states",
        "america",
        "canada",
        " ca ",
        "us server",
    ];
    let asia_kw = &[
        "hk ",
        "hong kong",
        "japan",
        " jp ",
        "korea",
        " kr ",
        "singapore",
        " sg ",
        "taiwan",
        " tw ",
        "thailand",
        " th ",
        "vietnam",
        " vn ",
        "indonesia",
        " id ",
        "hk server",
    ];

    let mut americas_nodes = Vec::new();
    let mut asia_nodes = Vec::new();
    for name in proxy_names {
        let lower = format!(" {} ", name.to_lowercase());
        if americas_kw.iter().any(|kw| lower.contains(kw)) {
            americas_nodes.push(name.clone());
        } else if asia_kw.iter().any(|kw| lower.contains(kw)) {
            asia_nodes.push(name.clone());
        }
    }

    (americas_nodes, asia_nodes)
}

pub(crate) fn build_rdp_proxy_groups(proxy_names: &[String]) -> Vec<ProxyGroup> {
    if proxy_names.is_empty() {
        return vec![];
    }

    let (americas_nodes, asia_nodes) = classify_rdp_proxy_names(proxy_names);
    let has_americas = !americas_nodes.is_empty();
    let has_asia = !asia_nodes.is_empty();
    let mut groups = Vec::new();

    if has_americas {
        groups.push(ProxyGroup {
            name: SERVER_AMERICAS_GROUP.to_string(),
            group_type: "select".to_string(),
            proxies: americas_nodes.clone(),
            now: None,
        });
    }

    if has_asia {
        groups.push(ProxyGroup {
            name: SERVER_ASIA_GROUP.to_string(),
            group_type: "select".to_string(),
            proxies: asia_nodes.clone(),
            now: None,
        });
    }

    groups.push(ProxyGroup {
        name: SERVER_GLOBAL_GROUP.to_string(),
        group_type: "select".to_string(),
        proxies: proxy_names.to_vec(),
        now: None,
    });

    groups
}

fn build_rdp_runtime_proxy_groups(proxy_names: &[String]) -> Vec<ProxyGroup> {
    if proxy_names.is_empty() {
        return vec![];
    }

    let (americas_nodes, asia_nodes) = classify_rdp_proxy_names(proxy_names);
    let has_americas = !americas_nodes.is_empty();
    let has_asia = !asia_nodes.is_empty();
    let mut groups = Vec::new();

    if has_americas {
        groups.push(ProxyGroup {
            name: AUTO_AMERICAS_GROUP.to_string(),
            group_type: "fallback".to_string(),
            proxies: americas_nodes.clone(),
            now: None,
        });

        let mut proxies = vec![AUTO_AMERICAS_GROUP.to_string()];
        proxies.extend(americas_nodes.clone());
        proxies.push("DIRECT".to_string());
        groups.push(ProxyGroup {
            name: SERVER_AMERICAS_GROUP.to_string(),
            group_type: "select".to_string(),
            proxies,
            now: None,
        });
    }

    if has_asia {
        groups.push(ProxyGroup {
            name: AUTO_ASIA_GROUP.to_string(),
            group_type: "fallback".to_string(),
            proxies: asia_nodes.clone(),
            now: None,
        });

        let mut proxies = vec![AUTO_ASIA_GROUP.to_string()];
        proxies.extend(asia_nodes.clone());
        proxies.push("DIRECT".to_string());
        groups.push(ProxyGroup {
            name: SERVER_ASIA_GROUP.to_string(),
            group_type: "select".to_string(),
            proxies,
            now: None,
        });
    }

    groups.push(ProxyGroup {
        name: AUTO_GLOBAL_GROUP.to_string(),
        group_type: "fallback".to_string(),
        proxies: proxy_names.to_vec(),
        now: None,
    });
    let mut global_proxies = vec![AUTO_GLOBAL_GROUP.to_string()];
    global_proxies.extend(proxy_names.iter().cloned());
    global_proxies.push("DIRECT".to_string());
    groups.push(ProxyGroup {
        name: SERVER_GLOBAL_GROUP.to_string(),
        group_type: "select".to_string(),
        proxies: global_proxies,
        now: None,
    });

    groups
}

fn proxy_group_to_yaml(group: &ProxyGroup) -> serde_yaml::Value {
    let mut map = serde_yaml::Mapping::new();
    map.insert(ykey("name"), yval(&group.name));
    map.insert(ykey("type"), yval(&group.group_type));
    map.insert(
        ykey("proxies"),
        serde_yaml::Value::Sequence(
            group
                .proxies
                .iter()
                .map(|name| serde_yaml::Value::String(name.clone()))
                .collect(),
        ),
    );
    if group.group_type == "fallback" {
        map.insert(ykey("url"), yval("http://www.gstatic.com/generate_204"));
        map.insert(
            ykey("interval"),
            serde_yaml::Value::Number(serde_yaml::Number::from(240)),
        );
    }
    serde_yaml::Value::Mapping(map)
}

fn build_rdp_rules(group_names: &[String]) -> Vec<serde_yaml::Value> {
    let mut rules = Vec::new();
    if group_names.iter().any(|name| name == SERVER_AMERICAS_GROUP) {
        for cc in &["US", "CA", "GB", "DE"] {
            rules.push(serde_yaml::Value::String(format!(
                "AND,(OR,(DST-PORT,22),(DST-PORT,3389)),\
                 (GEOIP,{cc},no-resolve),{SERVER_AMERICAS_GROUP}"
            )));
        }
    }
    if group_names.iter().any(|name| name == SERVER_ASIA_GROUP) {
        for cc in &["HK", "TW", "JP", "KR", "SG", "TH"] {
            rules.push(serde_yaml::Value::String(format!(
                "AND,(OR,(DST-PORT,22),(DST-PORT,3389)),\
                 (GEOIP,{cc},no-resolve),{SERVER_ASIA_GROUP}"
            )));
        }
    }
    if let Some(catch_all_group) = preferred_rdp_catch_all_group(group_names) {
        ensure_port_rule(&mut rules, 22, &catch_all_group);
        ensure_port_rule(&mut rules, 3389, &catch_all_group);
    }
    rules.push(yval("MATCH,DIRECT"));
    rules
}

fn preferred_rdp_catch_all_group(group_names: &[String]) -> Option<String> {
    group_names
        .iter()
        .find(|name| name.to_lowercase().contains("server-global"))
        .cloned()
        .or_else(|| group_names.first().cloned())
}

fn ensure_port_rule(rules: &mut Vec<serde_yaml::Value>, port: u16, group_name: &str) {
    let prefix = format!("DST-PORT,{port},");
    let exists = rules
        .iter()
        .filter_map(|rule| rule.as_str())
        .any(|rule| rule.starts_with(&prefix));
    if !exists {
        rules.push(serde_yaml::Value::String(format!(
            "DST-PORT,{port},{group_name}"
        )));
    }
}

pub fn get_user_config_dir() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| dirs::home_dir().unwrap());
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
    #[serde(default)]
    pub tube_enabled: bool,
    #[serde(default)]
    pub cloud_mode: bool,
    #[serde(default)]
    pub dashboard_url: String,
    #[serde(default)]
    pub relay_api_key: String,
    #[serde(default = "default_auto_update_enabled")]
    pub auto_update_enabled: bool,
    #[serde(default)]
    pub last_sync_ts: u64,
}

fn default_auto_update_enabled() -> bool {
    true
}

pub fn load_saved_config() -> SavedConfig {
    let path = get_user_config_dir().join("config.json");
    if !path.exists() {
        return SavedConfig::default();
    }
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => SavedConfig::default(),
    }
}

pub fn save_config(cfg: &SavedConfig) {
    let path = get_user_config_dir().join("config.json");
    if let Ok(json) = serde_json::to_string_pretty(cfg) {
        fs::write(path, json).ok();
    }
}

pub fn generate_clash_config(proxies: &[serde_yaml::Value]) -> PathBuf {
    let proxy_names: Vec<String> = proxies
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let fallback = format!("proxy-{i}");
            p.get("name")
                .and_then(|n| n.as_str())
                .unwrap_or(&fallback)
                .to_string()
        })
        .collect();
    let rdp_groups = build_rdp_runtime_proxy_groups(&proxy_names);
    let group_names: Vec<String> = rdp_groups.iter().map(|group| group.name.clone()).collect();
    let groups: Vec<serde_yaml::Value> = rdp_groups.iter().map(proxy_group_to_yaml).collect();
    let rules = build_rdp_rules(&group_names);

    // ── Assemble config ──
    let mut config = serde_yaml::Mapping::new();
    insert_yaml_int(&mut config, "port", 17890);
    insert_yaml_int(&mut config, "socks-port", SOCKS_PORT as i64);
    insert_yaml_str(&mut config, "external-controller", "127.0.0.1:17891");
    config.insert(ykey("allow-lan"), serde_yaml::Value::Bool(false));
    insert_yaml_str(&mut config, "mode", "rule");
    config.insert(ykey("geodata-mode"), serde_yaml::Value::Bool(false));
    config.insert(ykey("geo-auto-update"), serde_yaml::Value::Bool(true));
    config.insert(
        ykey("proxies"),
        serde_yaml::Value::Sequence(proxies.to_vec()),
    );
    config.insert(ykey("proxy-groups"), serde_yaml::Value::Sequence(groups));
    config.insert(ykey("rules"), serde_yaml::Value::Sequence(rules));

    // Bind to physical interface to bypass external TUN/VPN
    apply_interface_name(&mut config);

    let config_path = get_user_config_dir().join("runtime_clash.yaml");
    if let Ok(yaml_str) = serde_yaml::to_string(&serde_yaml::Value::Mapping(config)) {
        fs::write(&config_path, yaml_str).ok();
    }
    config_path
}

pub fn generate_clash_config_from_subscription(raw_config: &serde_yaml::Value) -> PathBuf {
    let map = match raw_config.as_mapping() {
        Some(m) => m,
        None => return generate_clash_config(&[]),
    };

    let original_proxies = map
        .get(&ykey("proxies"))
        .and_then(|v| v.as_sequence())
        .cloned()
        .unwrap_or_default();
    let filtered_proxies: Vec<serde_yaml::Value> = original_proxies
        .into_iter()
        .filter(|proxy| {
            proxy
                .get("name")
                .and_then(|n| n.as_str())
                .map(is_selectable_proxy_name)
                .unwrap_or(false)
        })
        .collect();
    let proxy_names: Vec<String> = filtered_proxies.iter().filter_map(proxy_name).collect();
    let rdp_groups = build_rdp_runtime_proxy_groups(&proxy_names);
    let group_names: Vec<String> = rdp_groups.iter().map(|group| group.name.clone()).collect();
    let filtered_groups: Vec<serde_yaml::Value> =
        rdp_groups.iter().map(proxy_group_to_yaml).collect();
    let filtered_rules = build_rdp_rules(&group_names);

    let mode = map
        .get(&ykey("mode"))
        .and_then(|v| v.as_str())
        .unwrap_or("rule");

    let mut config = serde_yaml::Mapping::new();
    insert_yaml_int(&mut config, "port", 17890);
    insert_yaml_int(&mut config, "socks-port", SOCKS_PORT as i64);
    insert_yaml_str(&mut config, "external-controller", "127.0.0.1:17891");
    config.insert(ykey("allow-lan"), serde_yaml::Value::Bool(false));
    insert_yaml_str(&mut config, "mode", mode);
    config.insert(ykey("geodata-mode"), serde_yaml::Value::Bool(false));
    config.insert(ykey("geo-auto-update"), serde_yaml::Value::Bool(false));

    config.insert(
        ykey("proxies"),
        serde_yaml::Value::Sequence(filtered_proxies),
    );
    config.insert(
        ykey("proxy-groups"),
        serde_yaml::Value::Sequence(filtered_groups),
    );
    config.insert(ykey("rules"), serde_yaml::Value::Sequence(filtered_rules));

    if let Some(dns) = map.get(&ykey("dns")) {
        config.insert(ykey("dns"), dns.clone());
    }

    // Preserve important Clash Meta settings from original config
    for key in &[
        "unified-delay",
        "tcp-concurrent",
        "global-client-fingerprint",
        "find-process-mode",
        "profile",
        "sniffer",
    ] {
        if let Some(val) = map.get(&ykey(key)) {
            config.insert(ykey(key), val.clone());
        }
    }

    // Override DNS listen port to avoid conflict with external Clash instances
    // and add proxy-server-nameserver to bypass fake-ip for proxy server domains
    if let Some(dns) = config.get_mut(&ykey("dns")) {
        if let Some(dns_map) = dns.as_mapping_mut() {
            dns_map.insert(
                ykey("listen"),
                serde_yaml::Value::String("127.0.0.1:11053".into()),
            );

            // Add proxy-server-nameserver if not present
            // This is critical: without it, proxy server hostnames get fake-ip
            // which creates a chicken-and-egg DNS resolution problem
            if !dns_map.contains_key(&ykey("proxy-server-nameserver")) {
                let nameservers = serde_yaml::Value::Sequence(vec![
                    serde_yaml::Value::String("https://doh.pub/dns-query".into()),
                    serde_yaml::Value::String("https://dns.alidns.com/dns-query".into()),
                    serde_yaml::Value::String("tls://223.5.5.5".into()),
                ]);
                dns_map.insert(ykey("proxy-server-nameserver"), nameservers);
            }
        }
    }

    // Bind to physical interface to bypass external TUN/VPN
    apply_interface_name(&mut config);

    let config_path = get_user_config_dir().join("runtime_clash.yaml");
    if let Ok(yaml_str) = serde_yaml::to_string(&serde_yaml::Value::Mapping(config)) {
        fs::write(&config_path, yaml_str).ok();
    }
    config_path
}

fn ykey(s: &str) -> serde_yaml::Value {
    serde_yaml::Value::String(s.to_string())
}

fn yval(s: &str) -> serde_yaml::Value {
    serde_yaml::Value::String(s.to_string())
}

/// Detect the default physical network interface to bypass external TUN/VPN.
/// When another Clash instance runs with TUN mode, its virtual interface (utun*)
/// intercepts all outbound traffic. By binding to the physical interface (e.g. en0),
/// our internal Clash sends proxy connections directly, avoiding double-proxy issues
/// that break VLESS Reality TLS handshakes.
fn detect_default_interface() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let output = StdCommand::new("route")
            .args(["-n", "get", "default"])
            .output()
            .ok()?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("interface:") {
                let iface = trimmed.trim_start_matches("interface:").trim();
                // Only return physical interfaces, not utun/lo
                if !iface.starts_with("utun") && !iface.starts_with("lo") {
                    return Some(iface.to_string());
                }
            }
        }
        None
    }
    #[cfg(target_os = "windows")]
    {
        // On Windows, detect the default interface via `route print 0.0.0.0`
        // and extract the interface name from `netsh interface show interface`
        let output = StdCommand::new("cmd")
            .args(["/C", "route", "print", "0.0.0.0"])
            .output()
            .ok()?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        // Parse the "Active Routes" section for the default route (0.0.0.0)
        // Format: Network Destination  Netmask  Gateway  Interface  Metric
        let mut default_iface_ip: Option<String> = None;
        let mut in_routes = false;
        for line in stdout.lines() {
            if line.contains("Active Routes:") {
                in_routes = true;
                continue;
            }
            if !in_routes {
                continue;
            }
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 5 && parts[0] == "0.0.0.0" && parts[1] == "0.0.0.0" {
                default_iface_ip = Some(parts[3].to_string());
                break;
            }
        }
        let iface_ip = default_iface_ip?;

        // Now find the interface name that has this IP
        let output2 = StdCommand::new("netsh")
            .args(["interface", "ipv4", "show", "addresses"])
            .output()
            .ok()?;
        let stdout2 = String::from_utf8_lossy(&output2.stdout);
        let mut current_iface: Option<String> = None;
        for line in stdout2.lines() {
            let trimmed = line.trim();
            // Interface lines look like: Configuration for interface "Ethernet"
            if trimmed.starts_with("Configuration for interface") {
                if let Some(start) = trimmed.find('"') {
                    if let Some(end) = trimmed.rfind('"') {
                        if end > start {
                            current_iface = Some(trimmed[start + 1..end].to_string());
                        }
                    }
                }
            }
            // IP Address line contains the IP
            if trimmed.contains(&iface_ip) {
                if let Some(ref name) = current_iface {
                    // Skip virtual/VPN interfaces
                    let lower = name.to_lowercase();
                    if !lower.contains("loopback")
                        && !lower.contains("tun")
                        && !lower.contains("wintun")
                    {
                        return Some(name.clone());
                    }
                }
            }
        }
        None
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

/// Apply interface-name to the config to bypass external TUN
fn apply_interface_name(config: &mut serde_yaml::Mapping) {
    if let Some(iface) = detect_default_interface() {
        eprintln!("[config] Detected physical interface: {iface}, binding to bypass external TUN");
        config.insert(ykey("interface-name"), serde_yaml::Value::String(iface));
    }
}

/// Patch an existing runtime_clash.yaml to ensure interface-name is set.
/// Called before starting the Clash process to handle configs generated
/// before this feature was added.
pub fn ensure_interface_name(config_path: &std::path::Path) {
    let Some(iface) = detect_default_interface() else {
        return;
    };

    let content = match fs::read_to_string(config_path) {
        Ok(c) => c,
        Err(_) => return,
    };

    let mut doc: serde_yaml::Value = match serde_yaml::from_str(&content) {
        Ok(v) => v,
        Err(_) => return,
    };

    if let Some(map) = doc.as_mapping_mut() {
        // Always update interface-name (network interface may change between sessions)
        map.insert(
            ykey("interface-name"),
            serde_yaml::Value::String(iface.clone()),
        );
        if let Ok(yaml_str) = serde_yaml::to_string(&doc) {
            fs::write(config_path, yaml_str).ok();
            eprintln!("[config] Patched runtime config with interface-name: {iface}");
        }
    }
}

fn insert_yaml_str(m: &mut serde_yaml::Mapping, key: &str, val: &str) {
    m.insert(ykey(key), serde_yaml::Value::String(val.into()));
}

fn insert_yaml_int(m: &mut serde_yaml::Mapping, key: &str, val: i64) {
    m.insert(
        ykey(key),
        serde_yaml::Value::Number(serde_yaml::Number::from(val)),
    );
}

#[cfg(test)]
mod tests {
    use super::{
        build_rdp_proxy_groups, build_rdp_rules, build_rdp_runtime_proxy_groups, ensure_port_rule,
        generate_clash_config_from_subscription, get_user_config_dir, is_selectable_proxy_name,
        preferred_rdp_catch_all_group, real_proxy_names_from_yaml, ykey, SERVER_AMERICAS_GROUP,
        SERVER_ASIA_GROUP, SERVER_GLOBAL_GROUP,
    };

    fn proxy(name: &str) -> serde_yaml::Value {
        let mut map = serde_yaml::Mapping::new();
        map.insert(ykey("name"), serde_yaml::Value::String(name.to_string()));
        map.insert(ykey("type"), serde_yaml::Value::String("vless".to_string()));
        serde_yaml::Value::Mapping(map)
    }

    #[test]
    fn selectable_proxy_name_filters_metadata_and_built_ins() {
        assert!(!is_selectable_proxy_name("DIRECT"));
        assert!(!is_selectable_proxy_name("Traffic Reset：10617.26 GB"));
        assert!(!is_selectable_proxy_name("Expire Date：Lifetime"));
        assert!(is_selectable_proxy_name("🇺🇸 US Server Only 01"));
    }

    #[test]
    fn real_proxy_names_excludes_subscription_metadata_nodes() {
        let names = real_proxy_names_from_yaml(&[
            proxy("Traffic Reset：10617.26 GB"),
            proxy("Expire Date：Lifetime"),
            proxy("🇺🇸 US Server Only 01"),
        ]);

        assert_eq!(names.len(), 1);
        assert!(names.contains("🇺🇸 US Server Only 01"));
    }

    #[test]
    fn port_rule_guard_adds_missing_rdp_ports_without_duplicates() {
        let groups = vec![SERVER_GLOBAL_GROUP.to_string()];
        let catch_all = preferred_rdp_catch_all_group(&groups).unwrap();
        let mut rules = vec![serde_yaml::Value::String(format!(
            "DST-PORT,22,{catch_all}"
        ))];

        ensure_port_rule(&mut rules, 22, &catch_all);
        ensure_port_rule(&mut rules, 3389, &catch_all);

        let rendered: Vec<&str> = rules.iter().filter_map(|rule| rule.as_str()).collect();
        assert_eq!(rendered.len(), 2);
        assert_eq!(rendered[0], "DST-PORT,22,🖥 Server-Global");
        assert_eq!(rendered[1], "DST-PORT,3389,🖥 Server-Global");
    }

    #[test]
    fn rdp_proxy_groups_include_regional_groups_when_matching_nodes_exist() {
        let proxy_names = vec![
            "🇺🇸 US Server Only 01".to_string(),
            "🇭🇰 HK Server 01".to_string(),
        ];

        let groups = build_rdp_proxy_groups(&proxy_names);
        let names: Vec<&str> = groups.iter().map(|group| group.name.as_str()).collect();

        assert!(!names.contains(&"Server-RDP"));
        assert!(!names.contains(&"Auto-RDP"));
        assert_eq!(
            names,
            vec![
                SERVER_AMERICAS_GROUP,
                SERVER_ASIA_GROUP,
                SERVER_GLOBAL_GROUP
            ]
        );
    }

    #[test]
    fn rdp_runtime_groups_keep_auto_groups_internal_and_direct_last() {
        let proxy_names = vec![
            "🇺🇸 US Server Only 01".to_string(),
            "🇭🇰 HK Server 01".to_string(),
        ];

        let groups = build_rdp_runtime_proxy_groups(&proxy_names);
        let names: Vec<&str> = groups.iter().map(|group| group.name.as_str()).collect();

        assert!(names.contains(&"⚡ Auto-Americas"));
        assert!(names.contains(&"⚡ Auto-Asia"));
        assert!(names.contains(&"⚡ Auto-Global"));
        assert!(names.contains(&SERVER_AMERICAS_GROUP));
        assert!(names.contains(&SERVER_ASIA_GROUP));
        assert!(names.contains(&SERVER_GLOBAL_GROUP));

        for group_name in [
            SERVER_AMERICAS_GROUP,
            SERVER_ASIA_GROUP,
            SERVER_GLOBAL_GROUP,
        ] {
            let group = groups
                .iter()
                .find(|group| group.name == group_name)
                .expect("expected RDP server group");
            assert_eq!(group.proxies.last().map(String::as_str), Some("DIRECT"));
        }
    }

    #[test]
    fn rdp_rules_route_ssh_and_rdp_to_global_group() {
        let group_names = vec![
            SERVER_AMERICAS_GROUP.to_string(),
            SERVER_ASIA_GROUP.to_string(),
            SERVER_GLOBAL_GROUP.to_string(),
        ];

        let rules = build_rdp_rules(&group_names);
        let rendered: Vec<&str> = rules.iter().filter_map(|rule| rule.as_str()).collect();

        assert!(rendered.contains(&"DST-PORT,22,🖥 Server-Global"));
        assert!(rendered.contains(&"DST-PORT,3389,🖥 Server-Global"));
        assert!(rendered.contains(&"MATCH,DIRECT"));
    }

    #[test]
    fn subscription_runtime_config_drops_tun_settings() {
        let config_path = get_user_config_dir().join("runtime_clash.yaml");
        let previous = std::fs::read(&config_path).ok();

        let raw_config: serde_yaml::Value = serde_yaml::from_str(
            r#"
mode: rule
tun:
  enable: true
  stack: system
dns:
  enable: true
  listen: 0.0.0.0:1053
proxies:
  - name: "US Server Only 01"
    type: vless
    server: example.com
    port: 443
"#,
        )
        .expect("test fixture should parse");

        let generated_path = generate_clash_config_from_subscription(&raw_config);
        let generated =
            std::fs::read_to_string(&generated_path).expect("runtime config should be written");

        if let Some(bytes) = previous {
            std::fs::write(&config_path, bytes).ok();
        } else {
            std::fs::remove_file(&config_path).ok();
        }

        let doc: serde_yaml::Value =
            serde_yaml::from_str(&generated).expect("runtime config should parse");
        let map = doc.as_mapping().expect("runtime config should be a map");

        assert!(
            !map.contains_key(&ykey("tun")),
            "NextDesk runtime config must not inherit subscription TUN"
        );
    }
}

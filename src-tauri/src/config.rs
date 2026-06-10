use serde::{Deserialize, Serialize};
use serde_json;
use serde_yaml;
use std::fs;
use std::path::PathBuf;

use crate::state::{ProxyGroup, Server};

const SERVER_AMERICAS_GROUP: &str = "🖥 Server-Americas";
const SERVER_ASIA_GROUP: &str = "🖥 Server-Asia";
const SERVER_GLOBAL_GROUP: &str = "🖥 Server-Global";
const AUTO_AMERICAS_GROUP: &str = "⚡ Auto-Americas";
const AUTO_ASIA_GROUP: &str = "⚡ Auto-Asia";
const AUTO_GLOBAL_GROUP: &str = "⚡ Auto-Global";
pub(crate) const PROXY_DELAY_TEST_URL: &str = "http://www.gstatic.com/generate_204";
const DEFAULT_RUNTIME_FRONTMATTER: &str = r#"
port: 17890
socks-port: 17897
allow-lan: false
bind-address: "*"
mode: rule
log-level: info
ipv6: false
external-controller: 127.0.0.1:17891
profile:
  store-selected: true
  store-fake-ip: true
unified-delay: true
tcp-concurrent: true
dns:
  enable: true
  cache-algorithm: arc
  prefer-h3: false
  use-hosts: true
  use-system-hosts: true
  listen: 127.0.0.1:11053
  ipv6: false
  default-nameserver:
    - 223.5.5.5
    - 119.29.29.29
  nameserver:
    - https://dns.alidns.com/dns-query
    - https://doh.pub/dns-query
  proxy-server-nameserver:
    - https://dns.alidns.com/dns-query
    - https://doh.pub/dns-query
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  fake-ip-filter:
    - '*.lan'
    - '*.local'
    - '*.arpa'
    - 'time.*.com'
    - 'ntp.*.com'
    - '+.market.xiaomi.com'
    - 'localhost.ptlogin2.qq.com'
    - '*.msftncsi.com'
    - 'www.msftconnecttest.com'
"#;

fn apply_flclash_interface_name(config: &mut serde_yaml::Mapping) {
    config.insert(
        ykey("interface-name"),
        serde_yaml::Value::String(String::new()),
    );
    eprintln!("[config] Cleared interface-name; using mihomo/OS route selection");
}

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
        map.insert(ykey("url"), yval(PROXY_DELAY_TEST_URL));
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
    let mut config = default_runtime_frontmatter();
    config.insert(
        ykey("proxies"),
        serde_yaml::Value::Sequence(proxies.to_vec()),
    );
    config.insert(ykey("proxy-groups"), serde_yaml::Value::Sequence(groups));
    config.insert(ykey("rules"), serde_yaml::Value::Sequence(rules));

    // Match FlClash: do not force-bind a guessed interface.
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

    let mut config = default_runtime_frontmatter();
    config.insert(
        ykey("proxies"),
        serde_yaml::Value::Sequence(filtered_proxies),
    );
    config.insert(
        ykey("proxy-groups"),
        serde_yaml::Value::Sequence(filtered_groups),
    );
    config.insert(ykey("rules"), serde_yaml::Value::Sequence(filtered_rules));

    // Keep protocol-level knobs from the subscription, but keep the runtime
    // DNS/fake-ip header fixed to NextDesk's validated template.
    for key in &["global-client-fingerprint", "find-process-mode"] {
        if let Some(val) = map.get(&ykey(key)) {
            config.insert(ykey(key), val.clone());
        }
    }

    // Match FlClash: do not force-bind a guessed interface.
    apply_interface_name(&mut config);

    let config_path = get_user_config_dir().join("runtime_clash.yaml");
    if let Ok(yaml_str) = serde_yaml::to_string(&serde_yaml::Value::Mapping(config)) {
        fs::write(&config_path, yaml_str).ok();
    }
    config_path
}

#[derive(Debug, Clone, Copy)]
pub struct RuntimePorts {
    pub http_port: u16,
    pub socks_port: u16,
    pub controller_port: u16,
    pub dns_port: u16,
}

fn read_runtime_yaml(config_path: &std::path::Path) -> Result<serde_yaml::Value, String> {
    let content =
        fs::read_to_string(config_path).map_err(|e| format!("Read runtime config failed: {e}"))?;
    let content = content.trim_start_matches('\u{feff}');

    for document in serde_yaml::Deserializer::from_str(content) {
        let value = serde_yaml::Value::deserialize(document)
            .map_err(|e| format!("Parse runtime config failed: {e}"))?;
        if !value.is_null() {
            return Ok(value);
        }
    }

    Err("Runtime config is empty".to_string())
}

/// Patch the generated runtime config with per-process local ports.
///
/// Dev and packaged apps can run at the same time on this machine. If both use
/// the fixed default ports, the second mihomo process starts against a stale
/// first process and RDP silently uses the wrong runtime.
pub fn patch_runtime_ports(config_path: &PathBuf, ports: RuntimePorts) -> Result<(), String> {
    let mut config = read_runtime_yaml(config_path)?;
    let map = config
        .as_mapping_mut()
        .ok_or_else(|| "Runtime config is not a YAML object".to_string())?;

    insert_yaml_int(map, "port", i64::from(ports.http_port));
    insert_yaml_int(map, "socks-port", i64::from(ports.socks_port));
    insert_yaml_str(
        map,
        "external-controller",
        &format!("127.0.0.1:{}", ports.controller_port),
    );

    if let Some(dns) = map.get_mut(&ykey("dns")) {
        if let Some(dns_map) = dns.as_mapping_mut() {
            dns_map.insert(
                ykey("listen"),
                serde_yaml::Value::String(format!("127.0.0.1:{}", ports.dns_port)),
            );
        }
    }

    let yaml_str = serde_yaml::to_string(&config)
        .map_err(|e| format!("Serialize runtime config failed: {e}"))?;
    fs::write(config_path, yaml_str).map_err(|e| format!("Write runtime config failed: {e}"))
}

fn default_runtime_frontmatter() -> serde_yaml::Mapping {
    serde_yaml::from_str::<serde_yaml::Value>(DEFAULT_RUNTIME_FRONTMATTER)
        .expect("NextDesk runtime frontmatter template must parse")
        .as_mapping()
        .expect("NextDesk runtime frontmatter template must be a map")
        .clone()
}

fn ykey(s: &str) -> serde_yaml::Value {
    serde_yaml::Value::String(s.to_string())
}

fn yval(s: &str) -> serde_yaml::Value {
    serde_yaml::Value::String(s.to_string())
}

/// Match FlClash's runtime profile behavior: do not force-bind to a guessed
/// network interface. Keep `interface-name` present but empty so mihomo and the
/// OS route table choose the outbound interface.
fn apply_interface_name(config: &mut serde_yaml::Mapping) {
    apply_flclash_interface_name(config);
}

/// Patch an existing runtime_clash.yaml before starting mihomo.
///
/// This handles configs generated by older app versions without forcing users
/// to edit the Clash runtime file manually.
pub fn ensure_runtime_network_config(config_path: &std::path::Path) {
    let mut doc = match read_runtime_yaml(config_path) {
        Ok(v) => v,
        Err(_) => return,
    };

    if let Some(map) = doc.as_mapping_mut() {
        apply_runtime_dns_template(map);

        apply_flclash_interface_name(map);

        if let Ok(yaml_str) = serde_yaml::to_string(&doc) {
            fs::write(config_path, yaml_str).ok();
        }
    }
}

fn apply_runtime_dns_template(map: &mut serde_yaml::Mapping) {
    let Some(default_dns) = default_runtime_frontmatter().get(&ykey("dns")).cloned() else {
        return;
    };

    map.insert(ykey("dns"), default_dns);
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
        apply_flclash_interface_name, build_rdp_proxy_groups, build_rdp_rules,
        build_rdp_runtime_proxy_groups, ensure_port_rule, ensure_runtime_network_config,
        generate_clash_config, generate_clash_config_from_subscription, get_user_config_dir,
        is_selectable_proxy_name, patch_runtime_ports, preferred_rdp_catch_all_group,
        proxy_group_to_yaml, real_proxy_names_from_yaml, ykey, RuntimePorts, PROXY_DELAY_TEST_URL,
        SERVER_AMERICAS_GROUP, SERVER_ASIA_GROUP, SERVER_GLOBAL_GROUP,
    };
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    static CONFIG_FILE_LOCK: Mutex<()> = Mutex::new(());

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
    fn interface_name_is_cleared_like_flclash() {
        let mut map = serde_yaml::Mapping::new();
        map.insert(
            ykey("interface-name"),
            serde_yaml::Value::String("stale-adapter".to_string()),
        );

        apply_flclash_interface_name(&mut map);

        assert_eq!(
            map.get(&ykey("interface-name"))
                .and_then(serde_yaml::Value::as_str),
            Some("")
        );
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
    fn default_delay_url_matches_flclash_baseline() {
        assert_eq!(PROXY_DELAY_TEST_URL, "http://www.gstatic.com/generate_204");
    }

    #[test]
    fn fallback_groups_use_gstatic_delay_url() {
        let groups = build_rdp_runtime_proxy_groups(&[
            "🇺🇸 US Server Only 01".to_string(),
            "🇺🇸 US Server Only 02".to_string(),
        ]);
        let fallback = groups
            .iter()
            .find(|group| group.group_type == "fallback")
            .expect("runtime groups should include fallback groups");
        let yaml = proxy_group_to_yaml(fallback);
        let map = yaml.as_mapping().expect("group yaml should be a map");

        assert_eq!(
            map.get(&ykey("url")).and_then(serde_yaml::Value::as_str),
            Some(PROXY_DELAY_TEST_URL)
        );
        assert_eq!(
            map.get(&ykey("url")).and_then(serde_yaml::Value::as_str),
            Some("http://www.gstatic.com/generate_204")
        );
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
        let _guard = CONFIG_FILE_LOCK.lock().unwrap();
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
        assert_eq!(
            map.get(&ykey("interface-name"))
                .and_then(serde_yaml::Value::as_str),
            Some(""),
            "runtime config should leave interface-name empty like FlClash"
        );
    }

    #[test]
    fn subscription_runtime_config_adds_dns_when_subscription_has_none() {
        let _guard = CONFIG_FILE_LOCK.lock().unwrap();
        let config_path = get_user_config_dir().join("runtime_clash.yaml");
        let previous = std::fs::read(&config_path).ok();

        let raw_config: serde_yaml::Value = serde_yaml::from_str(
            r#"
mode: rule
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
        let dns = doc
            .as_mapping()
            .and_then(|map| map.get(&ykey("dns")))
            .and_then(serde_yaml::Value::as_mapping)
            .expect("runtime config should include dns");

        assert_eq!(
            dns.get(&ykey("enable"))
                .and_then(serde_yaml::Value::as_bool),
            Some(true)
        );
        assert_eq!(
            dns.get(&ykey("listen")).and_then(serde_yaml::Value::as_str),
            Some("127.0.0.1:11053")
        );
        assert!(
            dns.contains_key(&ykey("proxy-server-nameserver")),
            "proxy server hostnames must not depend on fake-ip/system DNS"
        );
        assert_eq!(
            dns.get(&ykey("enhanced-mode"))
                .and_then(serde_yaml::Value::as_str),
            Some("fake-ip")
        );
        assert!(
            !dns.contains_key(&ykey("nameserver-policy")),
            "runtime DNS should stay aligned with the active ClashX Meta vless.yaml baseline"
        );
        assert!(
            dns.get(&ykey("fake-ip-filter"))
                .and_then(serde_yaml::Value::as_sequence)
                .map(|items| items.len() == 9)
                .unwrap_or(false),
            "runtime fake-ip filter should match the active ClashX Meta vless.yaml baseline"
        );
        assert_eq!(
            map.get(&ykey("interface-name"))
                .and_then(serde_yaml::Value::as_str),
            Some(""),
            "subscription runtime config should leave interface-name empty like FlClash"
        );
    }

    #[test]
    fn generated_runtime_config_adds_dns_for_proxy_only_inputs() {
        let _guard = CONFIG_FILE_LOCK.lock().unwrap();
        let config_path = get_user_config_dir().join("runtime_clash.yaml");
        let previous = std::fs::read(&config_path).ok();
        let generated_path = generate_clash_config(&[proxy("US Server Only 01")]);
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
        let dns = doc
            .as_mapping()
            .and_then(|map| map.get(&ykey("dns")))
            .and_then(serde_yaml::Value::as_mapping)
            .expect("runtime config should include dns");

        assert!(
            dns.contains_key(&ykey("proxy-server-nameserver")),
            "proxy-only subscriptions still need proxy server DNS"
        );
        assert_eq!(
            dns.get(&ykey("enhanced-mode"))
                .and_then(serde_yaml::Value::as_str),
            Some("fake-ip")
        );
        assert_eq!(
            map.get(&ykey("interface-name"))
                .and_then(serde_yaml::Value::as_str),
            Some(""),
            "proxy-only runtime config should leave interface-name empty like FlClash"
        );
    }

    #[test]
    fn runtime_port_patch_updates_all_local_listeners() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("nextdesk-runtime-ports-{nonce}.yaml"));
        std::fs::write(
            &path,
            r#"
port: 17890
socks-port: 17897
external-controller: 127.0.0.1:17891
dns:
  enable: true
  listen: 127.0.0.1:11053
"#,
        )
        .expect("fixture should be written");

        patch_runtime_ports(
            &path,
            RuntimePorts {
                http_port: 18080,
                socks_port: 18081,
                controller_port: 18082,
                dns_port: 18083,
            },
        )
        .expect("runtime ports should patch");

        let doc: serde_yaml::Value = serde_yaml::from_str(
            &std::fs::read_to_string(&path).expect("patched config should be readable"),
        )
        .expect("patched config should parse");
        let map = doc.as_mapping().expect("patched config should be a map");
        let dns = map
            .get(&ykey("dns"))
            .and_then(serde_yaml::Value::as_mapping)
            .expect("dns should stay a map");

        assert_eq!(
            map.get(&ykey("port")).and_then(serde_yaml::Value::as_i64),
            Some(18080)
        );
        assert_eq!(
            map.get(&ykey("socks-port"))
                .and_then(serde_yaml::Value::as_i64),
            Some(18081)
        );
        assert_eq!(
            map.get(&ykey("external-controller"))
                .and_then(serde_yaml::Value::as_str),
            Some("127.0.0.1:18082")
        );
        assert_eq!(
            dns.get(&ykey("listen")).and_then(serde_yaml::Value::as_str),
            Some("127.0.0.1:18083")
        );

        std::fs::remove_file(path).ok();
    }

    #[test]
    fn runtime_port_patch_accepts_bom_prefixed_yaml() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("nextdesk-runtime-bom-{nonce}.yaml"));
        std::fs::write(
            &path,
            "\u{feff}port: 17890\nsocks-port: 17897\nexternal-controller: 127.0.0.1:17891\ndns:\n  listen: 127.0.0.1:11053\n",
        )
        .expect("fixture should be written");

        patch_runtime_ports(
            &path,
            RuntimePorts {
                http_port: 19080,
                socks_port: 19081,
                controller_port: 19082,
                dns_port: 19083,
            },
        )
        .expect("BOM-prefixed runtime config should patch");

        let doc: serde_yaml::Value = serde_yaml::from_str(
            &std::fs::read_to_string(&path).expect("patched config should be readable"),
        )
        .expect("patched config should parse");
        let map = doc.as_mapping().expect("patched config should be a map");
        assert_eq!(
            map.get(&ykey("port")).and_then(serde_yaml::Value::as_i64),
            Some(19080)
        );

        std::fs::remove_file(path).ok();
    }

    #[test]
    fn existing_runtime_config_refreshes_network_template_before_start() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("nextdesk-runtime-network-{nonce}.yaml"));
        std::fs::write(
            &path,
            r#"
port: 17890
interface-name: stale-adapter
dns:
  enable: true
  nameserver:
    - 223.5.5.5
  proxy-server-nameserver:
    - 119.29.29.29
proxies:
  - name: "US Server Only 01"
    type: vless
"#,
        )
        .expect("fixture should be written");

        ensure_runtime_network_config(&path);

        let doc: serde_yaml::Value = serde_yaml::from_str(
            &std::fs::read_to_string(&path).expect("patched config should be readable"),
        )
        .expect("patched config should parse");
        let dns = doc
            .as_mapping()
            .and_then(|map| map.get(&ykey("dns")))
            .and_then(serde_yaml::Value::as_mapping)
            .expect("dns should stay a map");

        assert_eq!(
            dns.get(&ykey("nameserver"))
                .and_then(serde_yaml::Value::as_sequence)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(serde_yaml::Value::as_str)
                        .collect::<Vec<_>>()
                }),
            Some(vec![
                "https://dns.alidns.com/dns-query",
                "https://doh.pub/dns-query"
            ])
        );
        assert_eq!(
            dns.get(&ykey("proxy-server-nameserver"))
                .and_then(serde_yaml::Value::as_sequence)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(serde_yaml::Value::as_str)
                        .collect::<Vec<_>>()
                }),
            Some(vec![
                "https://dns.alidns.com/dns-query",
                "https://doh.pub/dns-query"
            ])
        );
        assert_eq!(
            doc.as_mapping()
                .and_then(|map| map.get(&ykey("interface-name")))
                .and_then(serde_yaml::Value::as_str),
            Some(""),
            "startup patch should clear stale interface-name like FlClash"
        );

        std::fs::remove_file(path).ok();
    }
}

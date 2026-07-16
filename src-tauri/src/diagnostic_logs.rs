use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::VecDeque;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

const DEFAULT_LOG_LIMIT: usize = 1000;
const MAX_LOG_LIMIT: usize = 5000;

#[derive(Clone, Debug, Serialize)]
pub struct DiagnosticLogEntry {
    pub timestamp: String,
    pub level: String,
    pub source: String,
    pub module: String,
    pub event: String,
    pub message: String,
    pub session_id: Option<String>,
    pub route: Option<String>,
    pub engine: Option<String>,
    pub duration_ms: Option<u64>,
    pub fields: Value,
}

impl DiagnosticLogEntry {
    #[cfg(test)]
    fn test_entry(timestamp: &str) -> Self {
        Self {
            timestamp: timestamp.to_string(),
            level: "INFO".to_string(),
            source: "test".to_string(),
            module: "app".to_string(),
            event: "app.test".to_string(),
            message: "test".to_string(),
            session_id: None,
            route: None,
            engine: None,
            duration_ms: None,
            fields: json!({}),
        }
    }
}

pub fn read(
    backend_path: &Path,
    rdp_path: &Path,
    limit: Option<usize>,
) -> Result<Vec<DiagnosticLogEntry>, String> {
    let limit = limit.unwrap_or(DEFAULT_LOG_LIMIT).clamp(1, MAX_LOG_LIMIT);
    let backend = read_recent_log_family(backend_path, MAX_LOG_LIMIT)?
        .into_iter()
        .filter_map(|line| parse_backend_line(&line))
        .collect();
    let rdp = read_recent_log_family(rdp_path, MAX_LOG_LIMIT)?
        .into_iter()
        .filter_map(|line| parse_rdp_line(&line))
        .collect();
    Ok(merge_entries(backend, rdp, limit))
}

fn read_recent_lines(path: &Path, limit: usize) -> Result<Vec<String>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file =
        File::open(path).map_err(|error| format!("open {} failed: {error}", path.display()))?;
    let mut lines = VecDeque::with_capacity(limit);
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|error| format!("read {} failed: {error}", path.display()))?;
        if lines.len() == limit {
            lines.pop_front();
        }
        lines.push_back(line);
    }
    Ok(lines.into_iter().collect())
}

fn read_recent_log_family(path: &Path, limit: usize) -> Result<Vec<String>, String> {
    let mut lines = Vec::new();
    for item in crate::logging::log_family_paths(path).into_iter().rev() {
        lines.extend(read_recent_lines(&item, limit)?);
    }
    if lines.len() > limit {
        lines.drain(..lines.len() - limit);
    }
    Ok(lines)
}

fn parse_rdp_line(line: &str) -> Option<DiagnosticLogEntry> {
    let (timestamp, rest) = take_segment(line)?;
    let (level, rest) = take_segment(rest)?;
    let (legacy_module, rest) = take_segment(rest)?;
    let (message, raw_fields) = rest
        .split_once(" | ")
        .map_or((rest.trim(), None), |(message, fields)| {
            (message.trim(), Some(fields))
        });
    let fields = raw_fields
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .unwrap_or_else(|| json!({}));
    let fields = sanitize_value(redact_value(fields));
    let module = normalize_module(legacy_module);
    let event = event_name(&module, message);
    let session_id = string_field(&fields, &["session_id", "sessionId", "tab_id", "tabId"])
        .map(|value| crate::logging::public_log_identifier(&value));
    let route = string_field(&fields, &["route", "route_label", "routeLabel"]);
    let duration_ms = number_field(&fields, &["duration_ms", "durationMs"]);
    let engine =
        string_field(&fields, &["engine"]).or_else(|| infer_engine(legacy_module, message));

    Some(DiagnosticLogEntry {
        timestamp: timestamp.to_string(),
        level: level.trim().to_ascii_uppercase(),
        source: "frontend".to_string(),
        module,
        event,
        message: crate::logging::public_log_text(&redact_text(message)),
        session_id,
        route,
        engine,
        duration_ms,
        fields,
    })
}

fn parse_backend_line(line: &str) -> Option<DiagnosticLogEntry> {
    let (timestamp, rest) = take_segment(line)?;
    let (level, rest) = take_segment(rest)?;
    let (target, rest) = take_segment(rest)?;
    let (location, message) = take_segment(rest)?;
    let module = normalize_backend_target(target);
    let public_target = crate::logging::public_log_target(target);
    let public_location = crate::logging::public_log_location(target, location);

    Some(DiagnosticLogEntry {
        timestamp: timestamp.to_string(),
        level: level.trim().to_ascii_uppercase(),
        source: "backend".to_string(),
        module: module.clone(),
        event: event_name(&module, message.trim()),
        message: crate::logging::public_log_text(&redact_text(message.trim())),
        session_id: None,
        route: route_from_message(message),
        engine: infer_engine(target, message),
        duration_ms: None,
        fields: json!({ "target": public_target, "location": public_location }),
    })
}

fn take_segment(value: &str) -> Option<(&str, &str)> {
    let value = value.trim_start();
    let value = value.strip_prefix('[')?;
    let end = value.find(']')?;
    Some((&value[..end], &value[end + 1..]))
}

fn normalize_module(module: &str) -> String {
    match module.trim().to_ascii_lowercase().as_str() {
        "connection" | "native" | "wasm" | "rdp" => "rdp",
        "render" | "display" => "display",
        "proxy" | "network" => "network",
        "clipboard" => "clipboard",
        "input" => "input",
        "audio" => "audio",
        "file" => "file",
        "auth" => "auth",
        "cloud" => "cloud",
        "route" => "route",
        _ => "app",
    }
    .to_string()
}

fn normalize_backend_target(target: &str) -> String {
    let target = target.to_ascii_lowercase();
    if target.contains("connection_resolver") {
        "route"
    } else if target.contains("cloud_auth") {
        "auth"
    } else if target.contains("cloud_gateway") || target.contains("cloud_probe") {
        "cloud"
    } else if target.contains("cliprdr") || target.contains("clipboard") {
        "clipboard"
    } else if target.contains("rdp_audio") || target.contains("rdpsnd") {
        "audio"
    } else if target.contains("rdpdr") || target.contains("file_transfer") {
        "file"
    } else if target.contains("rdp_proxy") {
        "network"
    } else if target.contains("rdp") || target.contains("kkterm") || target.contains("ironrdp") {
        "rdp"
    } else {
        "app"
    }
    .to_string()
}

fn event_name(module: &str, message: &str) -> String {
    let event = message
        .split_whitespace()
        .next()
        .filter(|value| value.contains('.') && value.chars().all(is_event_char))
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("{module}.log"));
    crate::logging::public_log_identifier(&event)
}

fn is_event_char(value: char) -> bool {
    value.is_ascii_alphanumeric() || matches!(value, '.' | '_' | '-')
}

fn infer_engine(context: &str, message: &str) -> Option<String> {
    let haystack = format!("{context} {message}").to_ascii_lowercase();
    if haystack.contains("kkterm") || haystack.contains("activex") {
        Some("Next RDP".to_string())
    } else if haystack.contains("official-web") || haystack.contains("wasm") {
        Some("Next RDP Web".to_string())
    } else if haystack.contains("rdp-native") || haystack.contains("rdp_session") {
        Some("Next RDP Native".to_string())
    } else {
        None
    }
}

fn route_from_message(message: &str) -> Option<String> {
    ["cloud_fallback", "lan_direct", "local_direct", "cloud"]
        .into_iter()
        .find(|route| message.contains(route))
        .map(ToOwned::to_owned)
}

fn string_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(ToOwned::to_owned)
}

fn number_field(value: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_u64))
}

fn redact_value(value: Value) -> Value {
    match value {
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| {
                    let value = if is_sensitive_key(&key) {
                        Value::String("[REDACTED]".to_string())
                    } else {
                        redact_value(value)
                    };
                    (key, value)
                })
                .collect::<Map<_, _>>(),
        ),
        Value::Array(values) => Value::Array(values.into_iter().map(redact_value).collect()),
        other => other,
    }
}

fn sanitize_value(value: Value) -> Value {
    match value {
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| {
                    (
                        crate::logging::public_log_identifier(&key),
                        sanitize_value(value),
                    )
                })
                .collect::<Map<_, _>>(),
        ),
        Value::Array(values) => Value::Array(values.into_iter().map(sanitize_value).collect()),
        Value::String(value) => Value::String(crate::logging::public_log_text(&value)),
        other => other,
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    [
        "password",
        "token",
        "cookie",
        "secret",
        "credential",
        "authorization_code",
    ]
    .into_iter()
    .any(|sensitive| key.contains(sensitive))
}

fn redact_text(message: &str) -> String {
    message
        .split_whitespace()
        .map(|part| {
            let lower = part.to_ascii_lowercase();
            if ["password=", "token=", "cookie=", "secret="]
                .into_iter()
                .any(|prefix| lower.starts_with(prefix))
            {
                part.split_once('=')
                    .map(|(key, _)| format!("{key}=[REDACTED]"))
                    .unwrap_or_else(|| "[REDACTED]".to_string())
            } else {
                part.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn merge_entries(
    mut backend: Vec<DiagnosticLogEntry>,
    mut rdp: Vec<DiagnosticLogEntry>,
    limit: usize,
) -> Vec<DiagnosticLogEntry> {
    backend.append(&mut rdp);
    backend.sort_by(|left, right| right.timestamp.cmp(&left.timestamp));
    backend.truncate(limit);
    backend
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_normalizes_frontend_rdp_logs() {
        let entry = parse_rdp_line(
            r#"[2026-07-12T12:00:00.000Z][warn][connection] route.selected | {"tabId":"rdp-1","routeLabel":"cloud_fallback","token":"secret"}"#,
        )
        .expect("RDP log should parse");

        assert_eq!(entry.level, "WARN");
        assert_eq!(entry.module, "rdp");
        assert_eq!(entry.source, "frontend");
        assert_eq!(entry.session_id.as_deref(), Some("rdp-1"));
        assert_eq!(entry.route.as_deref(), Some("cloud_fallback"));
        assert_eq!(entry.fields["token"], "[REDACTED]");
    }

    #[test]
    fn brands_frontend_engine_and_clipboard_logs_as_next_rdp() {
        let entry = parse_rdp_line(
            r#"[2026-07-12T12:00:00.000Z][error][rdp] kkterm-rdp error | {"engine":"kkterm-copy","detail":"[cliprdr-watcher] ironrdp_cliprdr failed","errorCode":"0x204"}"#,
        )
        .expect("RDP log should parse");
        let serialized = serde_json::to_string(&entry).unwrap().to_ascii_lowercase();

        assert_eq!(entry.message, "Next RDP error");
        assert_eq!(entry.engine.as_deref(), Some("Next RDP"));
        assert_eq!(entry.fields["errorCode"], "0x204");
        assert!(!serialized.contains("kkterm"));
        assert!(!serialized.contains("cliprdr"));
        assert!(!serialized.contains("ironrdp"));
        assert!(!serialized.contains("activex"));
    }

    #[test]
    fn maps_backend_targets_to_stable_modules() {
        let entry = parse_backend_line(
            "[2026-07-12T12:00:01.000Z][INFO ][nextdesk_lib::connection_resolver][src-tauri/src/connection_resolver.rs:10] cloud route selected",
        )
        .expect("backend log should parse");

        assert_eq!(entry.module, "route");
        assert_eq!(entry.source, "backend");
        assert_eq!(entry.message, "cloud route selected");
        assert_eq!(entry.fields["target"], "nextdesk::route");
        assert_eq!(entry.fields["location"], "nextdesk/route:10");
    }

    #[test]
    fn brands_backend_clipboard_logs_without_losing_line_or_error_code() {
        let entry = parse_backend_line(
            "[2026-07-12T12:00:01.000Z][ERROR][nextdesk_lib::cliprdr::watcher][src-tauri/src/cliprdr/watcher.rs:306] [cliprdr-watcher] kkterm-rdp failed code=0x204",
        )
        .expect("backend log should parse");
        let serialized = serde_json::to_string(&entry).unwrap().to_ascii_lowercase();

        assert_eq!(entry.module, "clipboard");
        assert_eq!(
            entry.message,
            "[Next RDP Clipboard] Next RDP failed code=0x204"
        );
        assert_eq!(entry.fields["target"], "nextdesk::clipboard");
        assert_eq!(entry.fields["location"], "nextdesk/clipboard:306");
        assert!(!serialized.contains("kkterm"));
        assert!(!serialized.contains("cliprdr"));
        assert!(serialized.contains("0x204"));
    }

    #[test]
    fn sorts_merged_logs_newest_first_and_applies_limit() {
        let entries = merge_entries(
            vec![DiagnosticLogEntry::test_entry("2026-07-12T12:00:00.000Z")],
            vec![DiagnosticLogEntry::test_entry("2026-07-12T12:00:02.000Z")],
            1,
        );

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].timestamp, "2026-07-12T12:00:02.000Z");
    }

    #[test]
    fn reads_rotated_log_family_in_chronological_source_order() {
        let path = std::env::temp_dir().join(format!(
            "nextdesk-diagnostic-family-{}.log",
            std::process::id()
        ));
        std::fs::write(path.with_extension("log.1"), "oldest\n").unwrap();
        std::fs::write(&path, "newest\n").unwrap();

        let lines = read_recent_log_family(&path, 10).unwrap();

        assert_eq!(lines, vec!["oldest", "newest"]);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("log.1"));
    }
}

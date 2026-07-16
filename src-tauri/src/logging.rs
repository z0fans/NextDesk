//! Centralized logging setup for NextDesk.
//!
//! Initializes env_logger with:
//! - Output to both stderr (visible in `npx tauri dev` console) and a log file
//! - Log file path: `/tmp/nextdesk_debug.log`
//! - Rotation: 10 MB per file, five retained backups
//! - Default level: INFO in dev and release builds
//! - Override via `RUST_LOG` env var
//! - Public logs use Next RDP branding; debug builds can opt into internal names with
//!   `NEXTDESK_INTERNAL_LOGS=1`
//!
//! ## Usage
//!
//! Call `init()` once at startup from `lib.rs::run()`. Then use the `log` macros:
//!
//! ```rust,ignore
//! log::info!("connected: host={} port={}", host, port);
//! log::debug!("frame received: bytes={}", n);
//! log::trace!("hot path: chunk={}", i);
//! ```

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

pub const LOG_MAX_BYTES: u64 = 10 * 1024 * 1024;
pub const LOG_BACKUP_COUNT: usize = 5;

const PUBLIC_LOG_REPLACEMENTS: &[(&str, &str)] = &[
    (
        "https://docs.rs/rustls/latest/rustls/manual/_03_howto/index.html#unexpected-eof",
        "Next RDP TLS unexpected EOF guidance",
    ),
    ("cliprdr-watcher", "Next RDP Clipboard"),
    ("cliprdr_watcher", "Next RDP Clipboard"),
    ("ironrdp_cliprdr", "Next RDP Clipboard"),
    ("ironrdp-cliprdr", "Next RDP Clipboard"),
    ("kkterm-windows", "Next RDP Windows"),
    ("kkterm_windows", "Next RDP Windows"),
    ("kkterm-macos", "Next RDP macOS"),
    ("kkterm_macos", "Next RDP macOS"),
    ("kkterm-rdp", "Next RDP"),
    ("kkterm_rdp", "Next RDP"),
    ("kkterm rdp", "Next RDP"),
    ("kkterm-copy", "Next RDP"),
    ("kkterm_copy", "Next RDP"),
    ("kkterm-text", "Next RDP text input"),
    ("kkterm_text", "Next RDP text input"),
    ("official-web", "Next RDP Web"),
    ("official_web", "Next RDP Web"),
    ("native-tls", "Next RDP TLS"),
    ("rdcleanpath", "Next RDP transport"),
    ("webcodecs", "Next RDP media"),
    ("webgl2", "Next RDP display"),
    ("webgl", "Next RDP display"),
    ("activex", "Next RDP Windows"),
    ("ironrdp", "Next RDP"),
    ("rustls", "Next RDP TLS"),
    ("wgpu", "Next RDP display"),
    ("cpal", "Next RDP Audio"),
    ("cliprdr", "Next RDP Clipboard"),
    ("rdpsnd", "Next RDP Audio"),
    ("rdpdr", "Next RDP File"),
    ("wasm", "Next RDP Web"),
    ("kkterm", "Next RDP"),
    ("Next RDP Next RDP Windows", "Next RDP Windows"),
    ("Next RDP Next RDP Web", "Next RDP Web"),
    ("Next RDP Next RDP Clipboard", "Next RDP Clipboard"),
    ("Next RDP Next RDP Audio", "Next RDP Audio"),
    ("Next RDP Next RDP File", "Next RDP File"),
];

const PUBLIC_IDENTIFIER_REPLACEMENTS: &[(&str, &str)] = &[
    (
        "https://docs.rs/rustls/latest/rustls/manual/_03_howto/index.html#unexpected-eof",
        "next_rdp_tls_unexpected_eof_guidance",
    ),
    ("cliprdr-watcher", "next_rdp_clipboard"),
    ("cliprdr_watcher", "next_rdp_clipboard"),
    ("ironrdp_cliprdr", "next_rdp_clipboard"),
    ("ironrdp-cliprdr", "next_rdp_clipboard"),
    ("kkterm-windows", "next_rdp_windows"),
    ("kkterm_windows", "next_rdp_windows"),
    ("kkterm-macos", "next_rdp_macos"),
    ("kkterm_macos", "next_rdp_macos"),
    ("kkterm-rdp", "next_rdp"),
    ("kkterm_rdp", "next_rdp"),
    ("kkterm rdp", "next_rdp"),
    ("kkterm-copy", "next_rdp"),
    ("kkterm_copy", "next_rdp"),
    ("kkterm-text", "next_rdp_text_input"),
    ("kkterm_text", "next_rdp_text_input"),
    ("official-web", "next_rdp_web"),
    ("official_web", "next_rdp_web"),
    ("native-tls", "next_rdp_tls"),
    ("rdcleanpath", "next_rdp_transport"),
    ("webcodecs", "next_rdp_media"),
    ("webgl2", "next_rdp_display"),
    ("webgl", "next_rdp_display"),
    ("activex", "next_rdp_windows"),
    ("ironrdp", "next_rdp"),
    ("rustls", "next_rdp_tls"),
    ("wgpu", "next_rdp_display"),
    ("cpal", "next_rdp_audio"),
    ("cliprdr", "next_rdp_clipboard"),
    ("rdpsnd", "next_rdp_audio"),
    ("rdpdr", "next_rdp_file"),
    ("wasm", "next_rdp_web"),
    ("kkterm", "next_rdp"),
    ("next_rdp next_rdp_windows", "next_rdp_windows"),
    ("next_rdp next_rdp_web", "next_rdp_web"),
    ("next_rdp next_rdp_clipboard", "next_rdp_clipboard"),
    ("next_rdp next_rdp_audio", "next_rdp_audio"),
    ("next_rdp next_rdp_file", "next_rdp_file"),
];

pub fn internal_diagnostics_enabled() -> bool {
    cfg!(debug_assertions)
        && std::env::var("NEXTDESK_INTERNAL_LOGS")
            .map(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
            .unwrap_or(false)
}

fn replace_ascii_case_insensitive(value: &str, needle: &str, replacement: &str) -> String {
    let lower = value.to_ascii_lowercase();
    let needle = needle.to_ascii_lowercase();
    let mut output = String::with_capacity(value.len());
    let mut cursor = 0;

    while let Some(relative) = lower[cursor..].find(&needle) {
        let start = cursor + relative;
        output.push_str(&value[cursor..start]);
        output.push_str(replacement);
        cursor = start + needle.len();
    }
    output.push_str(&value[cursor..]);
    output
}

fn apply_replacements(value: &str, replacements: &[(&str, &str)]) -> String {
    replacements
        .iter()
        .fold(value.to_string(), |current, (needle, replacement)| {
            replace_ascii_case_insensitive(&current, needle, replacement)
        })
}

pub fn public_log_text(value: &str) -> String {
    apply_replacements(value, PUBLIC_LOG_REPLACEMENTS)
}

pub fn public_log_identifier(value: &str) -> String {
    apply_replacements(value, PUBLIC_IDENTIFIER_REPLACEMENTS)
}

pub fn public_log_target(target: &str) -> String {
    let target = target.to_ascii_lowercase();
    if let Some(module) = target.strip_prefix("nextdesk::") {
        let module = match module {
            "app" | "auth" | "cloud" | "route" | "next_rdp" | "display" | "network" | "input"
            | "clipboard" | "file" | "audio" => module,
            _ => "app",
        };
        return format!("nextdesk::{module}");
    }
    let module = if target.contains("connection_resolver") {
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
        "next_rdp"
    } else {
        "app"
    };
    format!("nextdesk::{module}")
}

pub fn public_log_location(target: &str, location: &str) -> String {
    let public_target = public_log_target(target);
    let module = public_target.strip_prefix("nextdesk::").unwrap_or("app");
    let line = location
        .rsplit_once(':')
        .and_then(|(_, line)| line.parse::<u32>().ok())
        .unwrap_or(0);
    format!("nextdesk/{module}:{line}")
}

fn take_log_segment(value: &str) -> Option<(&str, &str)> {
    let value = value.strip_prefix('[')?;
    let end = value.find(']')?;
    Some((&value[..end], &value[end + 1..]))
}

pub fn public_log_line(line: &str) -> String {
    let Some((timestamp, rest)) = take_log_segment(line) else {
        return public_log_text(line);
    };
    let Some((level, rest)) = take_log_segment(rest) else {
        return public_log_text(line);
    };
    let Some((target, rest)) = take_log_segment(rest) else {
        return public_log_text(line);
    };
    let Some((location, message)) = take_log_segment(rest) else {
        return public_log_text(line);
    };
    format!(
        "[{timestamp}][{level}][{}][{}] {}",
        public_log_target(target),
        public_log_location(target, location),
        public_log_text(message.trim_start())
    )
}

pub fn sanitize_log_family(path: &std::path::Path) -> std::io::Result<()> {
    if internal_diagnostics_enabled() {
        return Ok(());
    }
    for item in log_family_paths(path) {
        if !item.exists() {
            continue;
        }
        let original = fs::read_to_string(&item)?;
        let mut sanitized = original
            .lines()
            .map(public_log_line)
            .collect::<Vec<_>>()
            .join("\n");
        if original.ends_with('\n') {
            sanitized.push('\n');
        }
        if sanitized != original {
            fs::write(item, sanitized)?;
        }
    }
    Ok(())
}

/// Path to the rotating debug log file.
pub fn log_file_path() -> PathBuf {
    PathBuf::from("/tmp").join("nextdesk_debug.log")
}

#[allow(dead_code)]
pub fn rdp_debug(event: &str, payload: &serde_json::Value) {
    log::debug!(target: "nextdesk_lib::kkterm_rdp", "[kkterm-rdp] {event} {payload}");
}

/// A writer that fans out to both a file and stderr.
struct FanoutWriter {
    file: Mutex<RotatingFile>,
}

impl FanoutWriter {
    fn new(path: PathBuf, file: File) -> Self {
        Self {
            file: Mutex::new(RotatingFile {
                path,
                file: Some(file),
            }),
        }
    }
}

struct RotatingFile {
    path: PathBuf,
    file: Option<File>,
}

impl RotatingFile {
    fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()> {
        let current_size = self
            .file
            .as_ref()
            .and_then(|file| file.metadata().ok())
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if current_size.saturating_add(buf.len() as u64) > LOG_MAX_BYTES {
            self.file.take();
            rotate_log_files(&self.path, LOG_BACKUP_COUNT)?;
            self.file = Some(
                OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&self.path)?,
            );
        }
        self.file
            .as_mut()
            .ok_or_else(|| std::io::Error::other("log file is unavailable"))?
            .write_all(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.file
            .as_mut()
            .ok_or_else(|| std::io::Error::other("log file is unavailable"))?
            .flush()
    }
}

pub fn rotate_log_files(path: &std::path::Path, backup_count: usize) -> std::io::Result<()> {
    if backup_count == 0 || !path.exists() {
        return Ok(());
    }

    let oldest = path.with_extension(format!("log.{backup_count}"));
    if oldest.exists() {
        fs::remove_file(oldest)?;
    }
    for index in (1..backup_count).rev() {
        let source = path.with_extension(format!("log.{index}"));
        if source.exists() {
            fs::rename(source, path.with_extension(format!("log.{}", index + 1)))?;
        }
    }
    fs::rename(path, path.with_extension("log.1"))
}

pub fn append_rotating(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let current_size = fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if current_size.saturating_add(bytes.len() as u64) > LOG_MAX_BYTES {
        rotate_log_files(path, LOG_BACKUP_COUNT)?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?
        .write_all(bytes)
}

pub fn log_family_paths(path: &std::path::Path) -> Vec<PathBuf> {
    let mut paths = vec![path.to_path_buf()];
    paths.extend((1..=LOG_BACKUP_COUNT).map(|index| path.with_extension(format!("log.{index}"))));
    paths
}

pub fn log_family_size(path: &std::path::Path) -> u64 {
    log_family_paths(path)
        .into_iter()
        .filter_map(|item| fs::metadata(item).ok())
        .map(|metadata| metadata.len())
        .sum()
}

pub fn clear_log_family(path: &std::path::Path) -> std::io::Result<()> {
    if path.exists() {
        OpenOptions::new().write(true).truncate(true).open(path)?;
    }
    for backup in log_family_paths(path).into_iter().skip(1) {
        if backup.exists() {
            fs::remove_file(backup)?;
        }
    }
    Ok(())
}

impl Write for FanoutWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        // stderr first (best-effort) so it shows in dev console
        let _ = std::io::stderr().write_all(buf);
        // file is the source of truth
        if let Ok(mut f) = self.file.lock() {
            f.write_all(buf)?;
            f.flush()?;
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        let _ = std::io::stderr().flush();
        if let Ok(mut f) = self.file.lock() {
            f.flush()?;
        }
        Ok(())
    }
}

/// Initialize the global logger. Call once from `lib.rs::run()`.
pub fn init() {
    let path = log_file_path();
    if let Some(parent) = path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            eprintln!(
                "[logging] Failed to create log directory {}: {}",
                parent.display(),
                e
            );
        }
    }

    if let Err(e) = sanitize_log_family(&path) {
        eprintln!("[logging] Failed to sanitize existing logs: {e}");
    }

    let file = match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!(
                "[logging] Failed to open log file {}: {}",
                path.display(),
                e
            );
            return;
        }
    };

    let writer = FanoutWriter::new(path.clone(), file);

    let mut builder = env_logger::Builder::new();

    // High-frequency paths remain DEBUG, while release builds retain the
    // INFO/WARN/ERROR events needed for user-facing diagnostics.
    let default_filters = if cfg!(debug_assertions) {
        "info,\
         nextdesk_lib::cliprdr=trace,\
         nextdesk_lib::rdp_session=debug,\
         nextdesk_lib::rdp_proxy=info,\
         ironrdp=warn,\
         ironrdp_cliprdr=info,\
         ironrdp_session=info,\
         ironrdp_connector=info,\
         tracing=warn"
    } else {
        "info,\
         nextdesk_lib=info,\
         ironrdp=warn,\
         ironrdp_cliprdr=warn,\
         ironrdp_session=warn,\
         ironrdp_connector=warn,\
         tracing=warn"
    };
    builder.parse_filters(default_filters);

    // Allow RUST_LOG to override the defaults
    if let Ok(filter) = std::env::var("RUST_LOG") {
        builder.parse_filters(&filter);
    }

    builder.format(|buf, record| {
        let ts = chrono_lite_now();
        let level = record.level();
        let target = record.target();
        let file = record.file().unwrap_or("?");
        let short_file = file
            .split("/src-tauri/")
            .nth(1)
            .map(|s| format!("src-tauri/{s}"))
            .unwrap_or_else(|| file.to_string());
        let line = record.line().unwrap_or(0);
        let internal = internal_diagnostics_enabled();
        let public_target = if internal {
            target.to_string()
        } else {
            public_log_target(target)
        };
        let public_location = if internal {
            format!("{short_file}:{line}")
        } else {
            public_log_location(target, &format!("{short_file}:{line}"))
        };
        let public_args = if internal {
            record.args().to_string()
        } else {
            public_log_text(&record.args().to_string())
        };
        writeln!(
            buf,
            "[{ts}][{level:5}][{target}][{location}] {args}",
            ts = ts,
            level = level,
            target = public_target,
            location = public_location,
            args = public_args
        )
    });

    builder.target(env_logger::Target::Pipe(Box::new(writer)));

    if let Err(e) = builder.try_init() {
        eprintln!("[logging] Failed to install logger: {e}");
        return;
    }

    log::info!(
        "═══ NextDesk logger initialized — file: {} ═══",
        path.display()
    );
    log::info!("   To live-tail: tail -f {}", path.display());
}

/// Lightweight timestamp formatter (avoids pulling in chrono).
/// Format: 2026-05-17T14:23:01.123Z (UTC)
fn chrono_lite_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let total_secs = now.as_secs();
    let millis = now.subsec_millis();

    let secs_per_day: u64 = 86400;
    let days_since_epoch = total_secs / secs_per_day;
    let secs_today = total_secs % secs_per_day;
    let hour = (secs_today / 3600) as u32;
    let minute = ((secs_today % 3600) / 60) as u32;
    let second = (secs_today % 60) as u32;

    let (year, month, day) = days_to_ymd(days_since_epoch as i64);

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, month, day, hour, minute, second, millis
    )
}

/// Convert days-since-1970-01-01 to (year, month, day).
/// Algorithm from Howard Hinnant's date library (public domain).
fn days_to_ymd(days: i64) -> (i32, u32, u32) {
    let days = days + 719468;
    let era = days.div_euclid(146097);
    let doe = days.rem_euclid(146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    (year as i32, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_days_to_ymd_known_dates() {
        assert_eq!(days_to_ymd(0), (1970, 1, 1));
        assert_eq!(days_to_ymd(20089), (2025, 1, 1));
        // 2024-02-29 (leap year)
        assert_eq!(days_to_ymd(19782), (2024, 2, 29));
    }

    #[test]
    fn test_chrono_lite_format() {
        let s = chrono_lite_now();
        // Pattern: YYYY-MM-DDTHH:MM:SS.mmmZ
        assert_eq!(s.len(), 24);
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[10..11], "T");
        assert_eq!(&s[19..20], ".");
        assert_eq!(&s[23..24], "Z");
    }

    #[test]
    fn rotates_logs_and_keeps_numbered_backups() {
        let base = std::env::temp_dir().join(format!(
            "nextdesk-log-rotation-{}-{}.log",
            std::process::id(),
            chrono_lite_now().replace([':', '.'], "-")
        ));
        fs::write(&base, b"current").unwrap();
        fs::write(base.with_extension("log.1"), b"previous").unwrap();

        rotate_log_files(&base, 2).unwrap();

        assert_eq!(fs::read(base.with_extension("log.1")).unwrap(), b"current");
        assert_eq!(fs::read(base.with_extension("log.2")).unwrap(), b"previous");
        let _ = fs::remove_file(base.with_extension("log.1"));
        let _ = fs::remove_file(base.with_extension("log.2"));
    }

    #[test]
    fn public_logs_hide_internal_rdp_technology_names() {
        let message =
            "[cliprdr-watcher] kkterm-rdp ActiveX ironrdp_cliprdr rustls failure code=0x204";
        let public = public_log_text(message);

        assert_eq!(
            public,
            "[Next RDP Clipboard] Next RDP Windows Next RDP Clipboard Next RDP TLS failure code=0x204"
        );
        assert!(!public.to_ascii_lowercase().contains("kkterm"));
        assert!(!public.to_ascii_lowercase().contains("cliprdr"));
        assert!(!public.to_ascii_lowercase().contains("ironrdp"));
        assert!(!public.to_ascii_lowercase().contains("rustls"));
        assert!(public.contains("code=0x204"));
    }

    #[test]
    fn public_targets_keep_module_and_line_for_troubleshooting() {
        assert_eq!(
            public_log_target("nextdesk_lib::cliprdr::watcher"),
            "nextdesk::clipboard"
        );
        assert_eq!(
            public_log_location(
                "nextdesk_lib::cliprdr::watcher",
                "src-tauri/src/cliprdr/watcher.rs:288"
            ),
            "nextdesk/clipboard:288"
        );
        assert_eq!(
            public_log_target("nextdesk::clipboard"),
            "nextdesk::clipboard"
        );
    }

    #[test]
    fn existing_backend_lines_are_migrated_to_public_targets_and_locations() {
        let public = public_log_line(
            "[2026-07-16T16:17:19.805Z][INFO ][nextdesk_lib::cliprdr::watcher][src/cliprdr/watcher.rs:287] [cliprdr-watcher] kkterm-rdp failed code=0x204",
        );

        assert_eq!(
            public,
            "[2026-07-16T16:17:19.805Z][INFO ][nextdesk::clipboard][nextdesk/clipboard:287] [Next RDP Clipboard] Next RDP failed code=0x204"
        );
    }
}

// ── Tauri commands for the in-app log management UI ──

/// Open the directory containing the log file in the system file manager.
#[tauri::command]
pub fn log_show_in_finder() -> Result<(), String> {
    let path = log_file_path();

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("open -R failed: {e}"))?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("explorer failed: {e}"))?;
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        return Err("show_in_finder not supported on this OS".into());
    }

    Ok(())
}

/// Copy the current log file to the user's Desktop with a timestamped name.
/// Returns the destination path.
#[tauri::command]
pub fn log_copy_to_desktop() -> Result<String, String> {
    let src = log_file_path();
    if !src.exists() {
        return Err(format!("log file does not exist: {}", src.display()));
    }

    let desktop =
        dirs::desktop_dir().ok_or_else(|| "could not find Desktop directory".to_string())?;

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let dest = desktop.join(format!("nextdesk_debug_{ts}.log"));

    std::fs::copy(&src, &dest).map_err(|e| format!("copy failed: {e}"))?;
    log::info!("Copied log to {}", dest.display());

    Ok(dest.to_string_lossy().to_string())
}

/// Truncate the log file (keeps it open and writable).
#[tauri::command]
pub fn log_clear() -> Result<(), String> {
    let path = log_file_path();
    clear_log_family(&path).map_err(|e| format!("clear logs failed: {e}"))?;
    log::info!("Log cleared by user");
    Ok(())
}

/// Get the absolute path to the log file (for display in UI).
#[tauri::command]
pub fn log_file_path_str() -> String {
    log_file_path().to_string_lossy().to_string()
}

/// Get the current size of the log file in bytes (for display in UI).
#[tauri::command]
pub fn log_file_size() -> u64 {
    log_family_size(&log_file_path())
}

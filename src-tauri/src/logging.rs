//! Centralized logging setup for NextDesk.
//!
//! Initializes env_logger with:
//! - Output to both stderr (visible in `npx tauri dev` console) and a log file
//! - Log file path: `/tmp/nextdesk_debug.log` (truncated on every startup)
//! - Default level: INFO
//! - Override via `RUST_LOG` env var
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

use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

/// Path to the rotating debug log file.
pub fn log_file_path() -> PathBuf {
    PathBuf::from("/tmp").join("nextdesk_debug.log")
}

/// A writer that fans out to both a file and stderr.
struct FanoutWriter {
    file: Mutex<File>,
}

impl FanoutWriter {
    fn new(file: File) -> Self {
        Self {
            file: Mutex::new(file),
        }
    }
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
    // Truncate on startup so each session starts clean.
    let file = match File::create(&path) {
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

    let writer = FanoutWriter::new(file);

    let mut builder = env_logger::Builder::new();

    // Default per-module levels.
    builder.parse_filters(
        "info,\
         nextdesk_lib::cliprdr=trace,\
         nextdesk_lib::rdp_session=debug,\
         nextdesk_lib::rdp_proxy=info,\
         ironrdp=warn,\
         ironrdp_cliprdr=info,\
         ironrdp_session=info,\
         ironrdp_connector=info,\
         tracing=warn",
    );

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
        writeln!(
            buf,
            "[{ts}][{level:5}][{target}][{short_file}:{line}] {args}",
            ts = ts,
            level = level,
            target = target,
            short_file = short_file,
            line = line,
            args = record.args()
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
    use std::fs::OpenOptions;
    OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| format!("truncate failed: {e}"))?;
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
    std::fs::metadata(log_file_path())
        .map(|m| m.len())
        .unwrap_or(0)
}

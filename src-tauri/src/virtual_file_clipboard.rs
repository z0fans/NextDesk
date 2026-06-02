use serde::Serialize;
use std::fs;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;

#[cfg(target_os = "macos")]
use crate::macos_file_promise::write_files_with_native_file_promise;
#[cfg(not(target_os = "macos"))]
use crate::macos_file_promise::write_files_with_native_file_promise;
#[cfg(target_os = "macos")]
use crate::macos_item_provider::write_files_with_item_provider;
#[cfg(not(target_os = "macos"))]
use crate::macos_item_provider::write_files_with_item_provider;
#[cfg(target_os = "macos")]
use crate::macos_pasteboard_promise::write_files_with_pasteboard_item_provider;
#[cfg(not(target_os = "macos"))]
use crate::macos_pasteboard_promise::write_files_with_pasteboard_item_provider;
#[cfg(not(target_os = "macos"))]
use crate::windows_virtual_files::write_files_with_native_virtual_data_object;

#[derive(Debug, Clone)]
pub struct VirtualClipboardFile {
    pub name: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VirtualClipboardWriteResult {
    pub strategy: String,
    pub staged_paths: Vec<String>,
}

pub fn write_virtual_files_to_local_clipboard(
    session_id: Option<&str>,
    mac_strategy: Option<&str>,
    files: &[VirtualClipboardFile],
) -> Result<VirtualClipboardWriteResult, String> {
    if files.is_empty() {
        return Ok(VirtualClipboardWriteResult {
            strategy: "empty".to_string(),
            staged_paths: Vec::new(),
        });
    }

    #[cfg(target_os = "macos")]
    {
        if mac_strategy == Some("pasteboard-promise") {
            if let Some(result) = write_files_with_pasteboard_item_provider(files)? {
                return Ok(result);
            }

            if let Some(result) = write_files_with_item_provider(files)? {
                return Ok(result);
            }

            if let Some(result) = write_files_with_native_file_promise(files)? {
                return Ok(result);
            }
        }

        let staged_paths = stage_files(session_id, files)?;
        write_file_urls_to_macos_pasteboard(&staged_paths)?;
        return Ok(VirtualClipboardWriteResult {
            strategy: "macos-session-file-url".to_string(),
            staged_paths,
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Some(result) = write_files_with_pasteboard_item_provider(files)? {
            return Ok(result);
        }

        if let Some(result) = write_files_with_item_provider(files)? {
            return Ok(result);
        }

        if let Some(result) = write_files_with_native_file_promise(files)? {
            return Ok(result);
        }

        if let Some(result) = write_files_with_native_virtual_data_object(files)? {
            return Ok(result);
        }

        let staged_paths = stage_files(session_id, files)?;

        #[cfg(target_os = "macos")]
        {
            write_file_urls_to_macos_pasteboard(&staged_paths)?;
            return Ok(VirtualClipboardWriteResult {
                strategy: "macos-file-url-staging".to_string(),
                staged_paths,
            });
        }

        #[cfg(target_os = "windows")]
        {
            write_file_paths_to_windows_clipboard(&staged_paths)?;
            return Ok(VirtualClipboardWriteResult {
                strategy: "windows-set-clipboard-path".to_string(),
                staged_paths,
            });
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            Ok(VirtualClipboardWriteResult {
                strategy: "staging-only".to_string(),
                staged_paths,
            })
        }
    }
}

fn stage_files(
    session_id: Option<&str>,
    files: &[VirtualClipboardFile],
) -> Result<Vec<String>, String> {
    let stage_root = session_stage_root(session_id);

    fs::create_dir_all(&stage_root).map_err(|e| format!("Failed to create staging dir: {}", e))?;

    let mut staged_paths = Vec::with_capacity(files.len());
    for file in files {
        let dest = unique_path_in_dir(&stage_root, &file.name);
        fs::write(&dest, &file.data).map_err(|e| format!("Failed to write staged file: {}", e))?;
        staged_paths.push(dest.to_string_lossy().to_string());
    }

    Ok(staged_paths)
}

pub fn session_stage_root(session_id: Option<&str>) -> PathBuf {
    let base = dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("NextDesk")
        .join("clipboard");

    let session_segment = session_id
        .filter(|id| !id.trim().is_empty())
        .map(|id| id.to_string())
        .unwrap_or_else(|| "global".to_string());

    base.join(session_segment).join(format!(
        "{}",
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ))
}

pub fn unique_path_in_dir(dir: &Path, file_name: &str) -> PathBuf {
    let dest = dir.join(file_name);
    if !dest.exists() {
        return dest;
    }

    let stem = dest
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(file_name);
    let ext = dest
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_default();

    let mut counter = 1u32;
    loop {
        let candidate = dir.join(format!("{} ({}){}", stem, counter, ext));
        if !candidate.exists() {
            return candidate;
        }
        counter += 1;
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn write_file_urls_to_macos_pasteboard(paths: &[String]) -> Result<(), String> {
    // IMPORTANT: Do NOT mix writeObjects (modern) with addTypes (legacy).
    // Mixing them on macOS 26 causes pasteboard state corruption where Finder
    // reads the PREVIOUS file URL instead of the current one.
    //
    // Use ONLY declareTypes + setPropertyList (legacy API) which is atomic,
    // sets NSFilenamesPboardType, and is recognized by both Finder paste and
    // AppleScript `the clipboard as list`.
    let script = r#"
        use framework "Foundation"
        use framework "AppKit"
        on run argv
            set pb to current application's NSPasteboard's generalPasteboard()

            -- Build path array
            set pathArray to current application's NSMutableArray's alloc()'s init()
            repeat with p in argv
                (pathArray's addObject:(current application's NSString's stringWithString:p))
            end repeat

            -- Atomic: declareTypes clears and declares in one call
            pb's declareTypes:{current application's NSFilenamesPboardType} owner:(missing value)
            pb's setPropertyList:pathArray forType:(current application's NSFilenamesPboardType)

            return ""
        end run
    "#;

    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .args(paths)
        .output()
        .map_err(|e| format!("osascript error: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    log::info!(
        "[clipboard] Pasteboard updated with {} file path(s): {}",
        paths.len(),
        paths.join(", ")
    );

    Ok(())
}

#[cfg(target_os = "windows")]
fn write_file_paths_to_windows_clipboard(paths: &[String]) -> Result<(), String> {
    let joined = paths
        .iter()
        .map(|p| format!("'{}'", p.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(", ");
    let script = format!("Set-Clipboard -Path {}", joined);

    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .map_err(|e| format!("powershell error: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok(())
}

/// Cross-platform helper: write already-staged file paths to the system clipboard.
/// Used by the chunked file transfer commit command.
pub fn write_staged_paths_to_clipboard(paths: &[String]) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        write_file_urls_to_macos_pasteboard(paths)?;
        return Ok("macos-session-file-url".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        write_file_paths_to_windows_clipboard(paths)?;
        return Ok("windows-set-clipboard-path".to_string());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = paths;
        Ok("staging-only".to_string())
    }
}

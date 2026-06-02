use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::fs::File;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;
use tauri::{AppHandle, State};

use crate::state::{AppState, ClipboardSessionState};
use crate::virtual_file_clipboard::{
    session_stage_root, unique_path_in_dir, write_staged_paths_to_clipboard,
    write_virtual_files_to_local_clipboard, VirtualClipboardFile, VirtualClipboardWriteResult,
};

static RDPDR_FILE_HANDLE_CACHE: OnceLock<Mutex<HashMap<String, File>>> = OnceLock::new();

/// File entry for RDPDR drive sharing.
#[derive(Debug, Clone, Serialize)]
pub struct DriveFileEntry {
    pub path: String,
    pub is_dir: bool,
    pub data: Option<Vec<u8>>,
    pub size: u64,
    pub creation_time: i64,
    pub last_access_time: i64,
    pub last_write_time: i64,
}

fn system_time_to_filetime(t: SystemTime) -> i64 {
    // Windows FILETIME: 100ns since Jan 1, 1601
    // Unix epoch (Jan 1, 1970) - FILETIME epoch = 11644473600s
    let unix_secs = t
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    unix_secs * 10_000_000 + 116_444_736_000_000_000
}

/// Scan a folder recursively, collecting entries.
fn scan_folder(
    base: &Path,
    rel_prefix: &str,
    entries: &mut Vec<DriveFileEntry>,
    max_file_size: u64,
) {
    let Ok(read_dir) = fs::read_dir(base) else {
        return;
    };

    for entry in read_dir.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        // Skip hidden files
        if name_str.starts_with('.') {
            continue;
        }

        let rel_path = if rel_prefix.is_empty() {
            name_str.to_string()
        } else {
            format!("{}/{}", rel_prefix, name_str)
        };

        let ctime = system_time_to_filetime(meta.created().unwrap_or(SystemTime::UNIX_EPOCH));
        let atime = system_time_to_filetime(meta.accessed().unwrap_or(SystemTime::UNIX_EPOCH));
        let mtime = system_time_to_filetime(meta.modified().unwrap_or(SystemTime::UNIX_EPOCH));

        if meta.is_dir() {
            entries.push(DriveFileEntry {
                path: rel_path.clone(),
                is_dir: true,
                data: None,
                size: 0,
                creation_time: ctime,
                last_access_time: atime,
                last_write_time: mtime,
            });
            scan_folder(&entry.path(), &rel_path, entries, max_file_size);
        } else if meta.is_file() {
            let size = meta.len();
            let data = if size <= max_file_size {
                fs::read(entry.path()).ok()
            } else {
                None // Too large, skip content
            };
            entries.push(DriveFileEntry {
                path: rel_path,
                is_dir: false,
                data,
                size,
                creation_time: ctime,
                last_access_time: atime,
                last_write_time: mtime,
            });
        }
    }
}

/// Tauri command: scan a folder for RDPDR sharing.
///
/// Returns a list of file entries with metadata and
/// content (for files under 10MB).
#[tauri::command]
pub async fn rdpdr_scan_folder(folder_path: String) -> Result<Vec<DriveFileEntry>, String> {
    let path = Path::new(&folder_path);
    if !path.exists() || !path.is_dir() {
        return Err(format!(
            "Path does not exist or is not a directory: {}",
            folder_path
        ));
    }

    let mut entries = Vec::new();
    // Max file size to load into memory: 10MB
    let max_size = 10 * 1024 * 1024;
    scan_folder(path, "", &mut entries, max_size);

    log::info!(
        "[rdpdr] Scanned {} entries from {}",
        entries.len(),
        folder_path
    );
    Ok(entries)
}

/// Lightweight metadata entry (no file content).
#[derive(Debug, Clone, Serialize)]
pub struct DriveMetadataEntry {
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub creation_time: i64,
    pub last_access_time: i64,
    pub last_write_time: i64,
}

/// Scan a folder recursively, collecting metadata only (no file content).
/// Limits: max_depth controls recursion depth, max_entries caps total entries.
fn scan_folder_metadata(
    base: &Path,
    rel_prefix: &str,
    entries: &mut Vec<DriveMetadataEntry>,
    depth: u32,
    max_depth: u32,
    max_entries: usize,
) {
    if depth > max_depth || entries.len() >= max_entries {
        return;
    }

    let Ok(read_dir) = fs::read_dir(base) else {
        return;
    };

    for entry in read_dir.flatten() {
        if entries.len() >= max_entries {
            return;
        }

        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        if name_str.starts_with('.') {
            continue;
        }

        let rel_path = if rel_prefix.is_empty() {
            name_str.to_string()
        } else {
            format!("{}/{}", rel_prefix, name_str)
        };

        let ctime = system_time_to_filetime(meta.created().unwrap_or(SystemTime::UNIX_EPOCH));
        let atime = system_time_to_filetime(meta.accessed().unwrap_or(SystemTime::UNIX_EPOCH));
        let mtime = system_time_to_filetime(meta.modified().unwrap_or(SystemTime::UNIX_EPOCH));

        if meta.is_dir() {
            entries.push(DriveMetadataEntry {
                path: rel_path.clone(),
                is_dir: true,
                size: 0,
                creation_time: ctime,
                last_access_time: atime,
                last_write_time: mtime,
            });
            scan_folder_metadata(
                &entry.path(),
                &rel_path,
                entries,
                depth + 1,
                max_depth,
                max_entries,
            );
        } else if meta.is_file() {
            entries.push(DriveMetadataEntry {
                path: rel_path,
                is_dir: false,
                size: meta.len(),
                creation_time: ctime,
                last_access_time: atime,
                last_write_time: mtime,
            });
        }
    }
}

/// Tauri command: scan folder metadata only (no file content).
/// Limited to 3 levels deep and 5000 entries max to prevent performance issues.
#[tauri::command]
pub async fn rdpdr_scan_folder_metadata(
    folder_path: String,
) -> Result<Vec<DriveMetadataEntry>, String> {
    let path = Path::new(&folder_path);
    if !path.exists() || !path.is_dir() {
        return Err(format!(
            "Path does not exist or is not a directory: {}",
            folder_path
        ));
    }

    let mut entries = Vec::new();
    let max_depth = 3;
    let max_entries = 5000;
    scan_folder_metadata(path, "", &mut entries, 0, max_depth, max_entries);

    if entries.len() >= max_entries {
        log::warn!(
            "[rdpdr] Metadata scan capped at {} entries (max_depth={}, max_entries={})",
            entries.len(),
            max_depth,
            max_entries
        );
    }

    log::info!(
        "[rdpdr] Metadata scan: {} entries from {}",
        entries.len(),
        folder_path
    );
    Ok(entries)
}

/// Tauri command: read a chunk of a file on-demand.
///
/// Returns raw binary via `tauri::ipc::Response` to avoid JSON serialization
/// of large byte arrays (2MB chunk → ~10MB JSON text otherwise).
#[tauri::command]
pub async fn rdpdr_read_file_chunk(
    base_folder: String,
    relative_path: String,
    offset: u64,
    length: u32,
) -> Result<tauri::ipc::Response, String> {
    #[cfg(not(target_family = "unix"))]
    use std::io::{Read, Seek, SeekFrom};
    #[cfg(target_family = "unix")]
    use std::os::unix::fs::FileExt;

    let full_path = Path::new(&base_folder).join(&relative_path);
    if !full_path.exists() || !full_path.is_file() {
        return Err(format!("File does not exist: {}", full_path.display()));
    }

    let mut buf = vec![0u8; length as usize];
    let cache = RDPDR_FILE_HANDLE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = full_path.to_string_lossy().to_string();
    let mut handles = cache
        .lock()
        .map_err(|_| "RDPDR file handle cache lock poisoned".to_string())?;
    if !handles.contains_key(&key) {
        let opened = File::open(&full_path).map_err(|e| format!("Failed to open file: {}", e))?;
        handles.insert(key.clone(), opened);
    }
    let file = handles
        .get_mut(&key)
        .ok_or_else(|| "RDPDR file handle missing after insert".to_string())?;

    #[cfg(target_family = "unix")]
    let bytes_read = file
        .read_at(&mut buf, offset)
        .map_err(|e| format!("Failed to read: {}", e))?;

    #[cfg(not(target_family = "unix"))]
    let bytes_read = {
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| format!("Failed to seek: {}", e))?;
        file.read(&mut buf)
            .map_err(|e| format!("Failed to read: {}", e))?
    };
    buf.truncate(bytes_read);
    Ok(tauri::ipc::Response::new(buf))
}

/// Tauri command: read a local file for clipboard file transfer.
///
/// Returns the file contents as raw bytes (Vec<u8>).
#[tauri::command]
pub async fn clipboard_read_file(file_path: String) -> Result<Vec<u8>, String> {
    let path = Path::new(&file_path);
    if !path.exists() || !path.is_file() {
        return Err(format!("File does not exist: {}", file_path));
    }

    let data = fs::read(path).map_err(|e| format!("Failed to read file: {}", e))?;

    log::info!(
        "[clipboard] Read file: {} ({} bytes)",
        file_path,
        data.len()
    );
    Ok(data)
}

/// Tauri command: write a file received from clipboard file transfer.
///
/// Saves the file to the user's Downloads directory.
#[tauri::command]
pub async fn clipboard_write_file(file_name: String, data: Vec<u8>) -> Result<String, String> {
    let downloads = dirs::download_dir().unwrap_or_else(|| {
        dirs::home_dir()
            .unwrap_or_else(|| Path::new("/tmp").to_path_buf())
            .join("Downloads")
    });

    // Ensure directory exists
    fs::create_dir_all(&downloads).map_err(|e| format!("Failed to create Downloads dir: {}", e))?;

    let dest = downloads.join(&file_name);

    // Handle duplicate filenames
    let final_path = if dest.exists() {
        let stem = dest
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&file_name);
        let ext = dest
            .extension()
            .and_then(|s| s.to_str())
            .map(|e| format!(".{}", e))
            .unwrap_or_default();

        let mut counter = 1u32;
        loop {
            let candidate = downloads.join(format!("{} ({}){}", stem, counter, ext));
            if !candidate.exists() {
                break candidate;
            }
            counter += 1;
        }
    } else {
        dest
    };

    fs::write(&final_path, &data).map_err(|e| format!("Failed to write file: {}", e))?;

    let path_str = final_path.to_string_lossy().to_string();
    log::info!(
        "[clipboard] Wrote file: {} ({} bytes)",
        path_str,
        data.len()
    );
    Ok(path_str)
}

/// File info for clipboard file transfer.
#[derive(Debug, Clone, Serialize)]
pub struct ClipboardFileInfo {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IncomingClipboardFile {
    pub name: String,
    pub data: Vec<u8>,
}

/// Read file paths from the local clipboard (cross-platform).
///
/// - **macOS**: uses `osascript` with three probe strategies.
/// - **Windows**: uses PowerShell `Get-Clipboard -Format FileDropList`.
/// - **Linux**: returns an empty list (not yet supported).
#[tauri::command]
pub async fn clipboard_read_file_paths() -> Result<Vec<String>, String> {
    #[cfg(target_os = "macos")]
    {
        clipboard_read_file_paths_macos()
    }

    #[cfg(target_os = "windows")]
    {
        clipboard_read_file_paths_windows()
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        log::info!("[clipboard] clipboard_read_file_paths not supported on this OS");
        Ok(Vec::new())
    }
}

#[cfg(target_os = "macos")]
fn clipboard_read_file_paths_macos() -> Result<Vec<String>, String> {
    // We use osascript (subprocess) instead of native NSPasteboard API because
    // NSPasteboard is NOT thread-safe on macOS 26 (Tahoe). Calling it from
    // multiple tokio worker threads concurrently causes SIGSEGV in
    // -[NSPasteboard _updateTypeCacheIfNeeded] (pointer auth failure).
    // A subprocess avoids all threading issues.

    // Strategy 1: POSIX file paths via Finder selection
    let script1 = r#"
        try
            set theFiles to {}
            repeat with f in (the clipboard as list)
                try
                    set end of theFiles to POSIX path of (f as alias)
                end try
            end repeat
            set AppleScript's text item delimiters to linefeed
            return theFiles as text
        end try
    "#;

    if let Ok(output) = std::process::Command::new("osascript")
        .args(["-e", script1])
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let paths: Vec<String> = stdout
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|s| !s.is_empty() && std::path::Path::new(s).exists())
                .collect();
            if !paths.is_empty() {
                log::info!(
                    "[clipboard] Read {} file paths from macOS pasteboard (osascript strategy 1)",
                    paths.len()
                );
                return Ok(paths);
            }
        }
    }

    // Strategy 2: file URL via «class furl»
    let script2 = r#"
        try
            set theFiles to {}
            set rawData to the clipboard as «class furl»
            set end of theFiles to POSIX path of (rawData as alias)
            set AppleScript's text item delimiters to linefeed
            return theFiles as text
        end try
    "#;

    if let Ok(output) = std::process::Command::new("osascript")
        .args(["-e", script2])
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let paths: Vec<String> = stdout
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|s| !s.is_empty() && std::path::Path::new(s).exists())
                .collect();
            if !paths.is_empty() {
                log::info!(
                    "[clipboard] Read {} file paths from macOS pasteboard (osascript strategy 2)",
                    paths.len()
                );
                return Ok(paths);
            }
        }
    }

    log::info!("[clipboard] No file paths found in macOS pasteboard");
    Ok(Vec::new())
}

#[cfg(target_os = "windows")]
fn clipboard_read_file_paths_windows() -> Result<Vec<String>, String> {
    // PowerShell: Get-Clipboard -Format FileDropList returns one path per line
    let ps_script = r#"
        $files = Get-Clipboard -Format FileDropList -ErrorAction SilentlyContinue
        if ($files) {
            foreach ($f in $files) {
                $f.FullName
            }
        }
    "#;

    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", ps_script])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .map_err(|e| format!("PowerShell error: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        log::warn!("[clipboard] PowerShell Get-Clipboard failed: {}", stderr);
        return Ok(Vec::new());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let paths: Vec<String> = stdout
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    log::info!(
        "[clipboard] Read {} file paths from Windows clipboard",
        paths.len()
    );
    Ok(paths)
}

/// Read files from clipboard with their content.
///
/// Returns file info including name, path, size, and data.
#[tauri::command]
pub async fn clipboard_read_files_data() -> Result<Vec<ClipboardFileInfo>, String> {
    let paths = clipboard_read_file_paths().await?;
    let mut files = Vec::new();

    for path_str in &paths {
        let p = Path::new(path_str);
        if !p.is_file() {
            continue;
        }
        let name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();

        let meta = fs::metadata(p).map_err(|e| format!("metadata: {}", e))?;
        let size = meta.len();

        // Small files (< 2MB): read data inline
        // Large files: send only metadata, data will be read on-demand via async callback
        if size <= 2 * 1024 * 1024 {
            let data = fs::read(p).map_err(|e| format!("read: {}", e))?;
            files.push(ClipboardFileInfo {
                name,
                path: path_str.clone(),
                size,
                data,
            });
        } else {
            log::info!(
                "[clipboard] Large file (lazy): {} ({}MB)",
                name,
                size / 1024 / 1024
            );
            files.push(ClipboardFileInfo {
                name,
                path: path_str.clone(),
                size,
                data: Vec::new(), // Empty — will be read via async callback
            });
        }
    }
    Ok(files)
}

/// Save a file downloaded from remote RDP session to the user's Downloads directory.
#[tauri::command]
pub async fn save_downloaded_file(name: String, data: Vec<u8>) -> Result<String, String> {
    let downloads =
        dirs::download_dir().ok_or_else(|| "Cannot find Downloads directory".to_string())?;

    let dest = downloads.join(&name);
    log::info!(
        "[file-transfer] Saving {} ({} bytes) to {:?}",
        name,
        data.len(),
        dest
    );

    fs::write(&dest, &data).map_err(|e| format!("Failed to write file: {}", e))?;

    let path_str = dest.to_string_lossy().to_string();
    log::info!("[file-transfer] ✅ Saved: {}", path_str);
    Ok(path_str)
}

/// Stage downloaded remote files into a temporary folder and put their paths on the local pasteboard.
#[tauri::command]
pub async fn stage_downloaded_files_for_paste(
    app: AppHandle,
    app_state: State<'_, AppState>,
    session_id: Option<String>,
    files: Vec<IncomingClipboardFile>,
) -> Result<VirtualClipboardWriteResult, String> {
    let virtual_files = files
        .into_iter()
        .map(|file| VirtualClipboardFile {
            name: file.name,
            data: file.data,
        })
        .collect::<Vec<_>>();

    let (tx, rx) = std::sync::mpsc::channel();
    let clipboard_session_id = session_id.clone();
    let mac_strategy = app_state
        .mac_clipboard_strategy
        .lock()
        .map_err(|_| "Clipboard strategy state lock poisoned".to_string())?
        .clone();
    let task_files = virtual_files.clone();
    app.run_on_main_thread(move || {
        let result = write_virtual_files_to_local_clipboard(
            clipboard_session_id.as_deref(),
            Some(mac_strategy.as_str()),
            &task_files,
        );
        let _ = tx.send(result);
    })
    .map_err(|e| format!("Failed to dispatch clipboard write to main thread: {}", e))?;

    let result = rx
        .recv()
        .map_err(|e| format!("Failed to receive main-thread clipboard result: {}", e))??;
    for (path, file) in result.staged_paths.iter().zip(virtual_files.iter()) {
        log::info!(
            "[file-transfer] Prepared remote file for local paste via {}: {} ({} bytes)",
            result.strategy,
            path,
            file.data.len()
        );
    }

    if let Some(session_id) = session_id.filter(|id| !id.trim().is_empty()) {
        let mut sessions = app_state
            .clipboard_sessions
            .lock()
            .map_err(|_| "Clipboard session state lock poisoned".to_string())?;
        sessions.insert(
            session_id.clone(),
            ClipboardSessionState {
                session_id,
                strategy: result.strategy.clone(),
                staged_paths: result.staged_paths.clone(),
                updated_at_ms: SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis(),
            },
        );
    }

    Ok(result)
}

#[tauri::command]
pub fn get_session_clipboard_state(
    session_id: String,
    app_state: State<'_, AppState>,
) -> Result<Option<ClipboardSessionState>, String> {
    let sessions = app_state
        .clipboard_sessions
        .lock()
        .map_err(|_| "Clipboard session state lock poisoned".to_string())?;
    Ok(sessions.get(&session_id).cloned())
}

#[tauri::command]
pub fn open_session_clipboard_folder(
    session_id: String,
    app_state: State<'_, AppState>,
) -> Result<bool, String> {
    let sessions = app_state
        .clipboard_sessions
        .lock()
        .map_err(|_| "Clipboard session state lock poisoned".to_string())?;
    let Some(state) = sessions.get(&session_id) else {
        return Ok(false);
    };
    let Some(first_path) = state.staged_paths.first() else {
        return Ok(false);
    };

    let folder = Path::new(first_path)
        .parent()
        .ok_or_else(|| "No parent folder for staged path".to_string())?;

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(folder)
            .status()
            .map_err(|e| format!("Failed to open Finder: {}", e))?;
        return Ok(true);
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(folder)
            .status()
            .map_err(|e| format!("Failed to open Explorer: {}", e))?;
        return Ok(true);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = folder;
        Ok(false)
    }
}

// ── Chunked file staging for large remote files ──
// For files > 10MB, JS sends data in 2MB chunks to avoid OOM from Array.from().

/// Create a staging path for a large file. Returns the full path.
#[tauri::command]
pub async fn clipboard_stage_begin(
    session_id: String,
    file_name: String,
) -> Result<String, String> {
    let stage_root = session_stage_root(Some(&session_id));
    fs::create_dir_all(&stage_root).map_err(|e| format!("Failed to create staging dir: {}", e))?;
    let dest = unique_path_in_dir(&stage_root, &file_name);
    // Create empty file
    File::create(&dest).map_err(|e| format!("Failed to create staged file: {}", e))?;
    log::info!(
        "[file-transfer] Stage begin: {} ({})",
        file_name,
        dest.display()
    );
    Ok(dest.to_string_lossy().to_string())
}

/// Append a data chunk to a staged file.
#[tauri::command]
pub async fn clipboard_stage_chunk(path: String, data: Vec<u8>) -> Result<(), String> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open staged file: {}", e))?;
    f.write_all(&data)
        .map_err(|e| format!("Failed to write chunk: {}", e))?;
    Ok(())
}

/// Finalize staged files: write paths to system clipboard and update session.
#[tauri::command]
pub async fn clipboard_stage_commit(
    app: AppHandle,
    app_state: State<'_, AppState>,
    session_id: String,
    staged_paths: Vec<String>,
) -> Result<VirtualClipboardWriteResult, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let paths_clone = staged_paths.clone();
    app.run_on_main_thread(move || {
        let result = write_staged_paths_to_clipboard(&paths_clone);
        let _ = tx.send(result);
    })
    .map_err(|e| format!("Failed to dispatch: {}", e))?;

    let strategy = rx.recv().map_err(|e| format!("Channel error: {}", e))??;

    let result = VirtualClipboardWriteResult {
        strategy: strategy.clone(),
        staged_paths: staged_paths.clone(),
    };

    for path in &staged_paths {
        let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        log::info!(
            "[file-transfer] Committed staged file via {}: {} ({} bytes)",
            strategy,
            path,
            size
        );
    }

    if !session_id.trim().is_empty() {
        let mut sessions = app_state
            .clipboard_sessions
            .lock()
            .map_err(|_| "Clipboard session lock poisoned".to_string())?;
        sessions.insert(
            session_id.clone(),
            ClipboardSessionState {
                session_id,
                strategy: result.strategy.clone(),
                staged_paths: result.staged_paths.clone(),
                updated_at_ms: SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis(),
            },
        );
    }

    Ok(result)
}

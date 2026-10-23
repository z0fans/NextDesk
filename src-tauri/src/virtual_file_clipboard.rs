use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

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
    validate_clipboard_files(files)?;
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
        let dest = write_unique_file_in_dir(&stage_root, &file.name, &file.data)?;
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
        .map(|id| format!("{:x}", Sha256::digest(id.as_bytes())))
        .unwrap_or_else(|| "global".to_string());

    base.join(session_segment)
        .join(format!("{:032x}", rand::random::<u128>()))
}

pub(crate) fn valid_file_name(name: &str) -> bool {
    if name.is_empty()
        || name.ends_with(['.', ' '])
        || name
            .chars()
            .any(|ch| ch.is_control() || "\\/:<>\"|?*".contains(ch))
    {
        return false;
    }
    // Windows device names are special even when followed by an extension.
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    !matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) && !["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    })
}

pub(crate) fn validate_file_name(name: &str) -> Result<(), String> {
    if valid_file_name(name) {
        Ok(())
    } else {
        Err("Invalid clipboard file name".to_string())
    }
}

pub(crate) fn validate_clipboard_files(files: &[VirtualClipboardFile]) -> Result<(), String> {
    files
        .iter()
        .try_for_each(|file| validate_file_name(&file.name))
}

pub(crate) fn create_unique_file_in_dir(
    dir: &Path,
    file_name: &str,
) -> Result<(PathBuf, fs::File), String> {
    validate_file_name(file_name)?;
    let name = Path::new(file_name);
    let stem = name
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(file_name);
    let extension = name
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| format!(".{ext}"))
        .unwrap_or_default();
    for counter in 0..u32::MAX {
        let path = dir.join(if counter == 0 {
            file_name.to_string()
        } else {
            format!("{stem} ({counter}){extension}")
        });
        match fs::File::create_new(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Failed to create clipboard file: {error}")),
        }
    }
    Err("No available clipboard file name".to_string())
}

pub(crate) fn write_unique_file_in_dir(
    dir: &Path,
    name: &str,
    data: &[u8],
) -> Result<PathBuf, String> {
    let (path, mut file) = create_unique_file_in_dir(dir, name)?;
    if let Err(error) = file.write_all(data) {
        drop(file);
        let _ = fs::remove_file(&path);
        return Err(format!("Failed to write clipboard file: {error}"));
    }
    Ok(path)
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

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "nextdesk-clipboard-test-{:032x}",
                rand::random::<u128>()
            ));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn invalid_names_are_rejected_before_native_provider_dispatch() {
        let files = [
            VirtualClipboardFile {
                name: "valid.txt".into(),
                data: vec![1],
            },
            VirtualClipboardFile {
                name: "../escape.txt".into(),
                data: vec![2],
            },
        ];
        assert_eq!(
            write_virtual_files_to_local_clipboard(
                Some("../session"),
                Some("pasteboard-promise"),
                &files
            )
            .unwrap_err(),
            "Invalid clipboard file name"
        );
        #[cfg(target_os = "macos")]
        {
            assert_eq!(
                write_files_with_native_file_promise(&files).unwrap_err(),
                "Invalid clipboard file name"
            );
            assert_eq!(
                write_files_with_item_provider(&files).unwrap_err(),
                "Invalid clipboard file name"
            );
            assert_eq!(
                write_files_with_pasteboard_item_provider(&files).unwrap_err(),
                "Invalid clipboard file name"
            );
        }
        #[cfg(target_os = "windows")]
        assert_eq!(
            write_files_with_native_virtual_data_object(&files).unwrap_err(),
            "Invalid clipboard file name"
        );
    }

    #[test]
    fn session_ids_are_encoded_beneath_the_clipboard_root() {
        let global = session_stage_root(None);
        let base = global.parent().unwrap().parent().unwrap();
        for id in [
            "../escape",
            "/tmp/escape",
            "C:\\escape",
            "..\\escape",
            "session/../../escape",
            "会话",
        ] {
            let path = session_stage_root(Some(id));
            assert_eq!(path.parent().unwrap().parent().unwrap(), base);
            let segment = path
                .parent()
                .unwrap()
                .file_name()
                .unwrap()
                .to_str()
                .unwrap();
            assert_eq!(segment.len(), 64);
            assert!(segment.chars().all(|ch| ch.is_ascii_hexdigit()));
            assert_ne!(path, session_stage_root(Some(id)));
        }
    }

    #[test]
    fn unsafe_names_cannot_escape_or_change_an_existing_file() {
        let fixture = TestDirectory::new();
        let stage = fixture.0.join("stage");
        fs::create_dir(&stage).unwrap();
        let outside = fixture.0.join("outside.txt");
        fs::write(&outside, b"keep").unwrap();
        for name in [
            "../outside.txt",
            "..\\outside.txt",
            "C:\\outside.txt",
            "name:stream",
            "NUL .txt",
            "COM1.txt",
            ".",
            "..",
            "",
        ] {
            assert!(
                write_unique_file_in_dir(&stage, name, b"replace").is_err(),
                "{name:?}"
            );
        }
        assert!(write_unique_file_in_dir(&stage, outside.to_str().unwrap(), b"replace").is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"keep");
        assert_eq!(fs::read_dir(&stage).unwrap().count(), 0);
    }

    #[test]
    fn legal_and_duplicate_names_preserve_previous_content() {
        let fixture = TestDirectory::new();
        let first = write_unique_file_in_dir(&fixture.0, "文件 (1).txt", b"first").unwrap();
        let second = write_unique_file_in_dir(&fixture.0, "文件 (1).txt", b"second").unwrap();
        assert_ne!(first, second);
        assert_eq!(fs::read(first).unwrap(), b"first");
        assert_eq!(fs::read(second).unwrap(), b"second");
        for name in ["README", ".env", "空格 file.txt"] {
            let path = write_unique_file_in_dir(&fixture.0, name, b"valid").unwrap();
            assert_eq!(path.file_name().unwrap(), name);
            assert_eq!(fs::read(path).unwrap(), b"valid");
        }
    }

    #[cfg(unix)]
    #[test]
    fn existing_and_dangling_symlinks_are_never_followed() {
        let fixture = TestDirectory::new();
        let stage = fixture.0.join("stage");
        fs::create_dir(&stage).unwrap();
        let outside = fixture.0.join("outside.txt");
        fs::write(&outside, b"keep").unwrap();
        std::os::unix::fs::symlink(&outside, stage.join("file.txt")).unwrap();
        let path = write_unique_file_in_dir(&stage, "file.txt", b"new").unwrap();
        assert_eq!(fs::read(path).unwrap(), b"new");
        assert_eq!(fs::read(outside).unwrap(), b"keep");
        let absent = fixture.0.join("absent.txt");
        std::os::unix::fs::symlink(&absent, stage.join("dangling.txt")).unwrap();
        let path = write_unique_file_in_dir(&stage, "dangling.txt", b"new").unwrap();
        assert!(path.is_file());
        assert!(!absent.exists());
    }

    #[test]
    fn simultaneous_allocations_of_one_name_create_distinct_files() {
        let fixture = TestDirectory::new();
        let start = std::sync::Barrier::new(2);
        let (first, second) = std::thread::scope(|scope| {
            let first = scope.spawn(|| {
                start.wait();
                write_unique_file_in_dir(&fixture.0, "shared.txt", b"one").unwrap()
            });
            let second = scope.spawn(|| {
                start.wait();
                write_unique_file_in_dir(&fixture.0, "shared.txt", b"two").unwrap()
            });
            (first.join().unwrap(), second.join().unwrap())
        });
        assert_ne!(first, second);
        assert_eq!(fs::read(first).unwrap(), b"one");
        assert_eq!(fs::read(second).unwrap(), b"two");
    }
}

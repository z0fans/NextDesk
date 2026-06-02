//! macOS NSPasteboard clipboard implementation.
//!
//! Uses objc2 bindings to interact with NSPasteboard directly.
//! All operations are thread-safe (NSPasteboard is thread-safe for read/write).

use super::{ClipError, ClipFormat, ClipResult, OsClipboard};
use std::path::PathBuf;

use objc2_app_kit::NSPasteboard;
use objc2_foundation::{NSData, NSString};

/// macOS clipboard backend using NSPasteboard.
pub struct MacOsClipboard;

impl MacOsClipboard {
    pub fn new() -> Self {
        Self
    }
}

impl OsClipboard for MacOsClipboard {
    fn change_count(&self) -> u64 {
        let pb = unsafe { NSPasteboard::generalPasteboard() };
        pb.changeCount() as u64
    }

    fn available_formats(&self) -> Vec<ClipFormat> {
        let pb = unsafe { NSPasteboard::generalPasteboard() };
        let types = unsafe { pb.types() };
        let Some(types) = types else {
            return Vec::new();
        };

        let mut formats = Vec::new();

        for type_obj in types.iter() {
            let type_str = type_obj.to_string();

            match type_str.as_str() {
                "public.utf8-plain-text" => {
                    if !formats.contains(&ClipFormat::PlainText) {
                        formats.push(ClipFormat::PlainText);
                    }
                }
                "public.html" => {
                    if !formats.contains(&ClipFormat::Html) {
                        formats.push(ClipFormat::Html);
                    }
                }
                "public.png" => {
                    if !formats.contains(&ClipFormat::Png) {
                        formats.push(ClipFormat::Png);
                    }
                }
                "public.tiff" => {
                    if !formats.contains(&ClipFormat::Tiff) {
                        formats.push(ClipFormat::Tiff);
                    }
                    // TIFF can be converted to PNG
                    if !formats.contains(&ClipFormat::Png) {
                        formats.push(ClipFormat::Png);
                    }
                }
                "public.file-url" | "NSFilenamesPboardType" => {
                    if !formats.contains(&ClipFormat::FileList) {
                        formats.push(ClipFormat::FileList);
                    }
                }
                _ => {}
            }
        }

        formats
    }

    fn read(&self, format: ClipFormat) -> ClipResult<Vec<u8>> {
        let pb = unsafe { NSPasteboard::generalPasteboard() };

        match format {
            ClipFormat::PlainText => {
                let type_str = NSString::from_str("public.utf8-plain-text");
                let string = unsafe { pb.stringForType(&type_str) };
                match string {
                    Some(s) => Ok(s.to_string().into_bytes()),
                    None => Err(ClipError::FormatUnavailable),
                }
            }
            ClipFormat::Html => {
                let type_str = NSString::from_str("public.html");
                let data = unsafe { pb.dataForType(&type_str) };
                match data {
                    Some(d) => Ok(d.to_vec()),
                    None => Err(ClipError::FormatUnavailable),
                }
            }
            ClipFormat::Png => {
                // Try PNG first
                let png_type = NSString::from_str("public.png");
                if let Some(data) = unsafe { pb.dataForType(&png_type) } {
                    return Ok(data.to_vec());
                }
                // Fallback: try TIFF and convert to PNG via sips
                let tiff_type = NSString::from_str("public.tiff");
                if let Some(data) = unsafe { pb.dataForType(&tiff_type) } {
                    let tiff_bytes = data.to_vec();
                    return tiff_to_png(&tiff_bytes).map_err(ClipError::ConversionFailed);
                }
                Err(ClipError::FormatUnavailable)
            }
            ClipFormat::Tiff => {
                let type_str = NSString::from_str("public.tiff");
                let data = unsafe { pb.dataForType(&type_str) };
                match data {
                    Some(d) => Ok(d.to_vec()),
                    None => Err(ClipError::FormatUnavailable),
                }
            }
            ClipFormat::FileList => Err(ClipError::AccessFailed(
                "Use read_files() for file list".into(),
            )),
        }
    }

    fn read_files(&self) -> ClipResult<Vec<PathBuf>> {
        let pb = unsafe { NSPasteboard::generalPasteboard() };
        let file_url_type = NSString::from_str("public.file-url");

        let items = unsafe { pb.pasteboardItems() };
        let Some(items) = items else {
            return Err(ClipError::FormatUnavailable);
        };

        let mut paths = Vec::new();

        for item in items.iter() {
            let url_str = unsafe { item.stringForType(&file_url_type) };
            if let Some(url_str) = url_str {
                let url_string: String = url_str.to_string();
                if let Some(path) = file_url_to_path(&url_string) {
                    paths.push(path);
                }
            }
        }

        if paths.is_empty() {
            Err(ClipError::FormatUnavailable)
        } else {
            Ok(paths)
        }
    }

    fn write_multi(&self, items: &[(ClipFormat, Vec<u8>)]) -> ClipResult<()> {
        if items.is_empty() {
            return Ok(());
        }

        let pb = unsafe { NSPasteboard::generalPasteboard() };

        // Clear pasteboard
        unsafe { pb.clearContents() };

        // Write each format
        for (fmt, data) in items {
            let type_str = clip_format_to_uti(fmt);
            let ns_data = NSData::with_bytes(data);
            let success = unsafe { pb.setData_forType(Some(&ns_data), &type_str) };
            if !success {
                log::warn!(
                    "[cliprdr-mac] Failed to write format {:?} to pasteboard",
                    fmt
                );
            }
        }

        Ok(())
    }

    fn write_files(&self, paths: &[PathBuf]) -> ClipResult<()> {
        if paths.is_empty() {
            return Ok(());
        }

        // Verify all files exist (Finder requirement — memory #59)
        for path in paths {
            if !path.exists() {
                return Err(ClipError::AccessFailed(format!(
                    "File does not exist (required for Finder paste): {}",
                    path.display()
                )));
            }
        }

        // Write via native NSPasteboardItem with NSPasteboardTypeFileURL.
        // This is the modern, reliable API (osascript NSFilenamesPboardType
        // sometimes silently no-ops on large files).
        write_file_paths_native(paths).map_err(ClipError::AccessFailed)
    }
}

/// Convert ClipFormat to macOS UTI string.
fn clip_format_to_uti(format: &ClipFormat) -> objc2::rc::Retained<NSString> {
    let uti = match format {
        ClipFormat::PlainText => "public.utf8-plain-text",
        ClipFormat::Html => "public.html",
        ClipFormat::Png => "public.png",
        ClipFormat::Tiff => "public.tiff",
        ClipFormat::FileList => "public.file-url",
    };
    NSString::from_str(uti)
}

/// Convert a file:// URL string to a PathBuf.
///
/// Uses NSURL to resolve the URL — this correctly handles macOS file reference
/// URLs like `file:///.file/id=6571367.1525031688` which point to inodes
/// rather than POSIX paths. NSURL.path() resolves these to real paths.
fn file_url_to_path(url: &str) -> Option<PathBuf> {
    use objc2_foundation::{NSString, NSURL};

    let ns_url_str = NSString::from_str(url);
    let ns_url = unsafe { NSURL::URLWithString(&ns_url_str) }?;

    // .path() resolves /.file/id=... and percent-decodes the path
    let path = unsafe { ns_url.path() }?;
    let path_str: String = path.to_string();

    if path_str.is_empty() {
        return None;
    }
    Some(PathBuf::from(path_str))
}

/// Convert TIFF data to PNG using sips (macOS built-in image converter).
fn tiff_to_png(tiff_data: &[u8]) -> Result<Vec<u8>, String> {
    let tmp_dir = std::env::temp_dir();
    let tiff_path = tmp_dir.join("nextdesk_clip_tmp.tiff");
    let png_path = tmp_dir.join("nextdesk_clip_tmp.png");

    std::fs::write(&tiff_path, tiff_data).map_err(|e| format!("Failed to write temp TIFF: {e}"))?;

    let output = std::process::Command::new("sips")
        .args([
            "-s",
            "format",
            "png",
            tiff_path.to_str().unwrap(),
            "--out",
            png_path.to_str().unwrap(),
        ])
        .output()
        .map_err(|e| format!("sips failed: {e}"))?;

    if !output.status.success() {
        let _ = std::fs::remove_file(&tiff_path);
        return Err(format!(
            "sips conversion failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let png_data =
        std::fs::read(&png_path).map_err(|e| format!("Failed to read converted PNG: {e}"))?;

    let _ = std::fs::remove_file(&tiff_path);
    let _ = std::fs::remove_file(&png_path);

    Ok(png_data)
}

/// Write file paths to NSPasteboard using native NSPasteboardItem API.
///
/// Each path becomes an NSPasteboardItem with `public.file-url` (modern UTI).
/// Multiple items are written via writeObjects() which Finder accepts for paste.
///
/// Why this beats the previous osascript approach:
/// - Direct in-process call: no subprocess timing/spawn race
/// - Synchronous: writeObjects returns bool — we know if it worked
/// - No silent no-ops on large files / unusual paths
fn write_file_paths_native(paths: &[PathBuf]) -> Result<(), String> {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboard, NSPasteboardItem};
    use objc2_foundation::{NSArray, NSString, NSURL};

    let pb = unsafe { NSPasteboard::generalPasteboard() };
    unsafe { pb.clearContents() };

    let file_url_type = NSString::from_str("public.file-url");

    let mut items: Vec<Retained<NSPasteboardItem>> = Vec::with_capacity(paths.len());

    for path in paths {
        let item = NSPasteboardItem::new();
        let path_str = path.to_string_lossy().to_string();

        // Construct file URL via NSURL.fileURLWithPath — this produces the
        // canonical file:// URL with proper percent-encoding.
        let path_ns = NSString::from_str(&path_str);
        let nsurl = unsafe { NSURL::fileURLWithPath(&path_ns) };
        if let Some(url_str) = unsafe { nsurl.absoluteString() } {
            unsafe { item.setString_forType(&url_str, &file_url_type) };
        } else {
            log::warn!(
                "[cliprdr-mac] could not get absoluteString for {}",
                path_str
            );
        }

        items.push(item);
    }

    // Convert Retained<NSPasteboardItem> → &ProtocolObject<dyn NSPasteboardWriting>
    let item_refs: Vec<&ProtocolObject<dyn objc2_app_kit::NSPasteboardWriting>> = items
        .iter()
        .map(|i| {
            let r: &NSPasteboardItem = i;
            ProtocolObject::from_ref(r)
        })
        .collect();
    let array = NSArray::from_slice(&item_refs);

    let success = unsafe { pb.writeObjects(&array) };
    if !success {
        return Err("NSPasteboard.writeObjects returned false".into());
    }

    log::info!(
        "[cliprdr-mac] Wrote {} file(s) via NSPasteboardItem (native)",
        paths.len()
    );
    Ok(())
}

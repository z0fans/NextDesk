//! Windows Win32 Clipboard implementation.
//!
//! Uses the `windows` crate to interact with the Windows clipboard API.
//! Each operation acquires the clipboard via OpenClipboard/CloseClipboard.

use super::{ClipError, ClipFormat, ClipResult, OsClipboard};
use std::path::PathBuf;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HANDLE, HWND};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
    GetClipboardSequenceNumber, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GHND, GLOBAL_ALLOC_FLAGS,
};
use windows::Win32::System::Ole::{CF_DIB, CF_DIBV5, CF_HDROP, CF_UNICODETEXT};
use windows::Win32::UI::Shell::{DragQueryFileW, DROPFILES, HDROP};

/// Windows clipboard backend using Win32 Clipboard APIs.
pub struct WindowsClipboard;

impl WindowsClipboard {
    pub fn new() -> Self {
        Self
    }
}

/// RAII guard for OpenClipboard/CloseClipboard.
struct ClipboardLock;

impl ClipboardLock {
    fn open() -> ClipResult<Self> {
        unsafe {
            OpenClipboard(Some(HWND(std::ptr::null_mut())))
                .map_err(|e| ClipError::AccessFailed(format!("OpenClipboard failed: {e:?}")))?;
        }
        Ok(ClipboardLock)
    }
}

impl Drop for ClipboardLock {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseClipboard();
        }
    }
}

/// Get the clipboard format ID for "HTML Format".
fn cf_html_format() -> u32 {
    unsafe { RegisterClipboardFormatW(w!("HTML Format")) }
}

impl OsClipboard for WindowsClipboard {
    fn change_count(&self) -> u64 {
        unsafe { GetClipboardSequenceNumber() as u64 }
    }

    fn available_formats(&self) -> Vec<ClipFormat> {
        let _lock = match ClipboardLock::open() {
            Ok(l) => l,
            Err(_) => return Vec::new(),
        };

        let mut formats = Vec::new();
        let mut current: u32 = 0;

        let cf_html = cf_html_format();

        loop {
            current = unsafe { EnumClipboardFormats(current) };
            if current == 0 {
                break;
            }

            match current {
                v if v == CF_UNICODETEXT.0 as u32 => {
                    if !formats.contains(&ClipFormat::PlainText) {
                        formats.push(ClipFormat::PlainText);
                    }
                }
                v if v == cf_html => {
                    if !formats.contains(&ClipFormat::Html) {
                        formats.push(ClipFormat::Html);
                    }
                }
                v if v == CF_DIBV5.0 as u32 || v == CF_DIB.0 as u32 => {
                    if !formats.contains(&ClipFormat::Bitmap) {
                        formats.push(ClipFormat::Bitmap);
                    }
                    if !formats.contains(&ClipFormat::Png) {
                        formats.push(ClipFormat::Png);
                    }
                }
                v if v == CF_HDROP.0 as u32 => {
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
        let _lock = ClipboardLock::open()?;

        let cf_id: u32 = match format {
            ClipFormat::PlainText => CF_UNICODETEXT.0 as u32,
            ClipFormat::Html => cf_html_format(),
            ClipFormat::Png | ClipFormat::Bitmap => {
                // Try DIBV5 first, fall back to DIB
                if let Ok(data) = read_clipboard_data(CF_DIBV5.0 as u32) {
                    return Ok(data);
                }
                CF_DIB.0 as u32
            }
            ClipFormat::FileList => {
                return Err(ClipError::AccessFailed(
                    "Use read_files() for file list".into(),
                ))
            }
        };

        let raw = read_clipboard_data(cf_id)?;

        // For PlainText (CF_UNICODETEXT), strip null terminator
        if format == ClipFormat::PlainText {
            // raw is UTF-16LE bytes including null terminator
            // Caller (formats.rs) handles UTF-16LE decoding
            Ok(raw)
        } else {
            Ok(raw)
        }
    }

    fn read_files(&self) -> ClipResult<Vec<PathBuf>> {
        let _lock = ClipboardLock::open()?;

        let handle = unsafe { GetClipboardData(CF_HDROP.0 as u32) }.map_err(|e| {
            ClipError::AccessFailed(format!("GetClipboardData(CF_HDROP) failed: {e:?}"))
        })?;

        let hdrop = HDROP(handle.0);

        // Get file count by passing 0xFFFFFFFF as index
        let count = unsafe { DragQueryFileW(hdrop, 0xFFFFFFFF, None) };
        if count == 0 {
            return Err(ClipError::FormatUnavailable);
        }

        let mut paths = Vec::with_capacity(count as usize);
        for i in 0..count {
            // First call to get required buffer size
            let len = unsafe { DragQueryFileW(hdrop, i, None) };
            if len == 0 {
                continue;
            }

            // Allocate buffer (+1 for null terminator)
            let mut buf = vec![0u16; (len + 1) as usize];
            let written = unsafe { DragQueryFileW(hdrop, i, Some(&mut buf)) };
            if written == 0 {
                continue;
            }

            // Strip null terminator and convert to String
            let path_str = String::from_utf16_lossy(&buf[..written as usize]);
            paths.push(PathBuf::from(path_str));
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

        let _lock = ClipboardLock::open()?;

        unsafe {
            EmptyClipboard()
                .map_err(|e| ClipError::AccessFailed(format!("EmptyClipboard failed: {e:?}")))?;
        }

        for (fmt, data) in items {
            let cf_id: u32 = match fmt {
                ClipFormat::PlainText => CF_UNICODETEXT.0 as u32,
                ClipFormat::Html => cf_html_format(),
                ClipFormat::Bitmap => CF_DIBV5.0 as u32,
                ClipFormat::Png => {
                    // Skip PNG — Windows clipboard uses CF_DIB/DIBV5 for images
                    log::debug!("[cliprdr-win] Skipping PNG format (use Bitmap instead)");
                    continue;
                }
                ClipFormat::FileList => {
                    log::warn!(
                        "[cliprdr-win] write_multi cannot handle FileList — use write_files()"
                    );
                    continue;
                }
            };

            if let Err(e) = write_clipboard_data(cf_id, data) {
                log::warn!("[cliprdr-win] Failed to write format {:?}: {:?}", fmt, e);
            }
        }

        Ok(())
    }

    fn write_files(&self, paths: &[PathBuf]) -> ClipResult<()> {
        if paths.is_empty() {
            return Ok(());
        }

        // Verify all files exist
        for path in paths {
            if !path.exists() {
                return Err(ClipError::AccessFailed(format!(
                    "File does not exist: {}",
                    path.display()
                )));
            }
        }

        // Build DROPFILES structure: header + UTF-16 paths separated by \0, double-null terminated
        let dropfiles_size = std::mem::size_of::<DROPFILES>();

        // Encode paths as UTF-16, separated by null, terminated with double-null
        let mut path_buffer: Vec<u16> = Vec::new();
        for path in paths {
            let s = path.to_string_lossy();
            path_buffer.extend(s.encode_utf16());
            path_buffer.push(0);
        }
        path_buffer.push(0); // double-null terminator

        let path_bytes = path_buffer.len() * 2;
        let total_size = dropfiles_size + path_bytes;

        // Build the buffer
        let mut buffer: Vec<u8> = Vec::with_capacity(total_size);

        let dropfiles = DROPFILES {
            pFiles: dropfiles_size as u32,
            pt: windows::Win32::Foundation::POINT { x: 0, y: 0 },
            fNC: windows::core::BOOL(0),
            fWide: windows::core::BOOL(1), // UTF-16 (wide) paths
        };

        // Append DROPFILES struct as bytes
        let dropfiles_bytes = unsafe {
            std::slice::from_raw_parts(&dropfiles as *const _ as *const u8, dropfiles_size)
        };
        buffer.extend_from_slice(dropfiles_bytes);

        // Append path bytes
        let path_byte_slice =
            unsafe { std::slice::from_raw_parts(path_buffer.as_ptr() as *const u8, path_bytes) };
        buffer.extend_from_slice(path_byte_slice);

        let _lock = ClipboardLock::open()?;
        unsafe {
            EmptyClipboard()
                .map_err(|e| ClipError::AccessFailed(format!("EmptyClipboard failed: {e:?}")))?;
        }

        write_clipboard_data(CF_HDROP.0 as u32, &buffer)?;

        Ok(())
    }
}

/// Read clipboard data for a given format ID. Caller must hold ClipboardLock.
fn read_clipboard_data(cf_id: u32) -> ClipResult<Vec<u8>> {
    let handle = unsafe { GetClipboardData(cf_id) }
        .map_err(|e| ClipError::AccessFailed(format!("GetClipboardData({cf_id}) failed: {e:?}")))?;

    if handle.is_invalid() {
        return Err(ClipError::FormatUnavailable);
    }

    let hglobal = windows::Win32::Foundation::HGLOBAL(handle.0);
    let size = unsafe { GlobalSize(hglobal) };
    if size == 0 {
        return Err(ClipError::FormatUnavailable);
    }

    let ptr = unsafe { GlobalLock(hglobal) };
    if ptr.is_null() {
        return Err(ClipError::AccessFailed("GlobalLock returned null".into()));
    }

    // Copy data
    let data = unsafe { std::slice::from_raw_parts(ptr as *const u8, size) }.to_vec();

    let _ = unsafe { GlobalUnlock(hglobal) };

    Ok(data)
}

/// Write clipboard data for a given format ID. Caller must hold ClipboardLock and have called EmptyClipboard.
fn write_clipboard_data(cf_id: u32, data: &[u8]) -> ClipResult<()> {
    // Allocate global memory
    let hglobal = unsafe { GlobalAlloc(GHND, data.len()) }
        .map_err(|e| ClipError::AccessFailed(format!("GlobalAlloc failed: {e:?}")))?;

    let ptr = unsafe { GlobalLock(hglobal) };
    if ptr.is_null() {
        return Err(ClipError::AccessFailed("GlobalLock returned null".into()));
    }

    unsafe {
        std::ptr::copy_nonoverlapping(data.as_ptr(), ptr as *mut u8, data.len());
    }

    let _ = unsafe { GlobalUnlock(hglobal) };

    let handle = HANDLE(hglobal.0);
    unsafe {
        SetClipboardData(cf_id, Some(handle))
            .map_err(|e| ClipError::AccessFailed(format!("SetClipboardData failed: {e:?}")))?;
    }

    Ok(())
}

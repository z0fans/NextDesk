//! Cross-platform clipboard abstraction.

use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ClipFormat {
    PlainText,
    Html,
    Png,
    #[cfg(target_os = "macos")]
    Tiff,
    #[cfg(target_os = "windows")]
    Bitmap,
    FileList,
}

#[derive(Debug, Error)]
pub enum ClipError {
    #[error("clipboard format not available")]
    FormatUnavailable,
    #[error("os clipboard access failed: {0}")]
    AccessFailed(String),
    #[error("data conversion failed: {0}")]
    ConversionFailed(String),
}

pub type ClipResult<T> = Result<T, ClipError>;

/// Platform-agnostic clipboard interface.
/// Each platform implements this trait to read/write the system clipboard.
pub trait OsClipboard: Send + Sync {
    /// Returns a monotonically increasing counter that changes when clipboard content changes.
    fn change_count(&self) -> u64;

    /// Returns the formats currently available on the clipboard.
    fn available_formats(&self) -> Vec<ClipFormat>;

    /// Read clipboard data in the specified format.
    fn read(&self, format: ClipFormat) -> ClipResult<Vec<u8>>;

    /// Read file paths from clipboard (for file copy/paste).
    fn read_files(&self) -> ClipResult<Vec<PathBuf>>;

    /// Write multiple format representations atomically to clipboard.
    fn write_multi(&self, items: &[(ClipFormat, Vec<u8>)]) -> ClipResult<()>;

    /// Write file references to clipboard (paths must exist on disk).
    fn write_files(&self, paths: &[PathBuf]) -> ClipResult<()>;
}

/// Create the platform-appropriate OsClipboard implementation.
pub fn create_os_clipboard() -> Box<dyn OsClipboard> {
    #[cfg(target_os = "macos")]
    {
        Box::new(macos::MacOsClipboard::new())
    }
    #[cfg(target_os = "windows")]
    {
        Box::new(windows::WindowsClipboard::new())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        compile_error!("Unsupported platform — only macOS and Windows are supported")
    }
}

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "macos")]
pub mod macos_presenter;

#[cfg(target_os = "windows")]
pub mod windows;

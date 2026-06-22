//! Cross-platform CLIPRDR clipboard module.
//!
//! Replaces the legacy `cliprdr_backend.rs` with a modular architecture:
//! - `os/` — Platform-specific clipboard access (trait OsClipboard)
//! - `watcher` — Clipboard change detection with throttling
//! - `formats` — RDP ↔ native format conversions
//! - `backend` — IronRDP CliprdrBackend implementation

pub mod backend;
pub mod formats;
pub mod os;
pub mod watcher;

use tauri::AppHandle;
use tokio::sync::mpsc;

/// Actions produced by `NextDeskCliprdrBackend` callbacks, consumed by the
/// active RDP event loop which has access to `Cliprdr` / `ActiveStage`.
#[derive(Debug)]
pub enum CliprdrAction {
    /// Local clipboard changed -> send FormatList to server.
    InitiateCopy(Vec<ironrdp::cliprdr::pdu::ClipboardFormat>),
    /// Remote copied -> request format data from server.
    InitiatePaste(ironrdp::cliprdr::pdu::ClipboardFormatId),
    /// Server requested our data -> submit format data response.
    SubmitFormatData(ironrdp::cliprdr::pdu::OwnedFormatDataResponse),
    /// Server requested file contents -> submit file contents response.
    SubmitFileContents(ironrdp::cliprdr::pdu::FileContentsResponse<'static>),
    /// We need a file chunk from server -> send FileContentsRequest.
    RequestFileContents(ironrdp::cliprdr::pdu::FileContentsRequest),
}

/// Build the CLIPRDR backend factory for use with IronRDP session.
///
/// This is the main entry point — called from `rdp_session.rs` during connection setup.
pub fn build_factory(
    action_tx: mpsc::UnboundedSender<CliprdrAction>,
    app_handle: AppHandle,
    temp_dir: String,
    session_id: String,
) -> backend::NextDeskCliprdrFactory {
    backend::NextDeskCliprdrFactory::new(action_tx, app_handle, temp_dir, session_id)
}

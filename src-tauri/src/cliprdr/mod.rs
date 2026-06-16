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

use crate::rdp_session::CliprdrAction;

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

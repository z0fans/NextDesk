//! IronRDP CliprdrBackend implementation.
//!
//! Bridges between IronRDP's CLIPRDR callbacks and our OS clipboard + watcher.
//!
//! Data flow:
//!   - **Local copy**: ClipboardWatcher detects change → sends InitiateCopy
//!   - **Remote copy**: Server sends FormatList → on_remote_copy() picks best format → InitiatePaste
//!   - **Server requests our data**: on_format_data_request() → read OS → convert → SubmitFormatData
//!   - **Server sends data**: on_format_data_response() → convert → write OS → notify watcher
//!
//! Win→Mac file paste flow comes in two flavours:
//!   - **macOS (lazy via NSFilePresenter)**: on remote copy we only stage 0-byte
//!     placeholder paths and register an `NSFilePresenter` per top-level entry
//!     plus write the placeholder URLs to NSPasteboard. The actual byte download
//!     is deferred until Finder paste (Cmd+V) triggers our presenter's
//!     `relinquishPresentedItemToReader:` callback, which synchronously invokes
//!     a `Fetcher` closure that kicks off the existing `request_size` cascade
//!     and blocks until completion.
//!   - **Windows (eager)**: unchanged — the cascade fires immediately at
//!     `start_incoming_file_transfer` time and the OS clipboard is updated
//!     once all bytes are on disk.

#[cfg(target_os = "macos")]
use std::path::Path;
use std::sync::atomic::Ordering;
#[cfg(target_os = "macos")]
use std::sync::Condvar;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ironrdp::cliprdr::backend::{CliprdrBackend, CliprdrBackendFactory};
use ironrdp::cliprdr::pdu::{
    ClipboardFormat, ClipboardFormatId, ClipboardGeneralCapabilityFlags, FileContentsRequest,
    FileContentsResponse, FormatDataRequest, FormatDataResponse, LockDataId,
    OwnedFormatDataResponse,
};
use ironrdp_core::impl_as_any;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use super::formats;
use super::os::{create_os_clipboard, ClipFormat, OsClipboard};
use super::watcher::ClipboardWatcher;
use super::CliprdrAction;

// ── Well-known CLIPRDR format IDs ──
const CF_TEXT: u32 = 1;
const CF_DIB: u32 = 8;
const CF_UNICODETEXT: u32 = 13;
const CF_DIBV5: u32 = 17;

// Custom format IDs for long-name formats (>= 0xC000 per RDP convention)
const CF_PRIVATE_HTML: u32 = 0xC001;
const CF_PRIVATE_PNG: u32 = 0xC002;
const CF_PRIVATE_FILE_GROUP: u32 = 0xC003;
const CF_PRIVATE_TEXT_HTML: u32 = 0xC004;

// Long format names
const FORMAT_NAME_HTML: &str = "HTML Format";
const FORMAT_NAME_PNG: &str = "PNG";
const FORMAT_NAME_FILE_GROUP: &str = "FileGroupDescriptorW";
const FORMAT_NAME_TEXT_HTML: &str = "text/html";

// Windows Explorer commonly asks for 256 KiB CLIPRDR file-content chunks, but
// sending that as one FileContentsResponse expands to a large burst of static
// virtual-channel fragments. Keep responses smaller so Explorer keeps pulling.
const OUTGOING_FILE_CONTENTS_CHUNK_LIMIT: u64 = 64 * 1024;
const OUTGOING_FILE_CONTENTS_RESPONSE_PACE_MS: u64 = 4;

fn capped_outgoing_file_contents_size(requested_size: u64) -> u64 {
    requested_size.min(OUTGOING_FILE_CONTENTS_CHUNK_LIMIT)
}

// ── Factory ──

/// Factory that creates `NextDeskCliprdrBackend` instances.
/// Called by IronRDP when the CLIPRDR channel is (re-)initialized.
pub struct NextDeskCliprdrFactory {
    action_tx: mpsc::UnboundedSender<CliprdrAction>,
    app_handle: AppHandle,
    temp_dir: String,
    session_id: String,
}

impl NextDeskCliprdrFactory {
    pub fn new(
        action_tx: mpsc::UnboundedSender<CliprdrAction>,
        app_handle: AppHandle,
        temp_dir: String,
        session_id: String,
    ) -> Self {
        Self {
            action_tx,
            app_handle,
            temp_dir,
            session_id,
        }
    }
}

impl CliprdrBackendFactory for NextDeskCliprdrFactory {
    fn build_cliprdr_backend(&self) -> Box<dyn CliprdrBackend> {
        let os: Arc<dyn OsClipboard> = Arc::from(create_os_clipboard());
        let watcher = ClipboardWatcher::new(
            Arc::clone(&os),
            self.action_tx.clone(),
            self.session_id.clone(),
        );

        Box::new(NextDeskCliprdrBackend {
            session_id: self.session_id.clone(),
            os,
            watcher,
            action_tx: self.action_tx.clone(),
            app_handle: self.app_handle.clone(),
            temp_dir: self.temp_dir.clone(),
            remote_formats: Vec::new(),
            capabilities: ClipboardGeneralCapabilityFlags::empty(),
            local_files: Vec::new(),
            incoming_transfer: Arc::new(Mutex::new(None)),
            #[cfg(target_os = "macos")]
            lazy_state: None,
            pending_paste_format_id: 0,
            outgoing_watchdog: None,
        })
    }
}

// ── Backend ──

pub struct NextDeskCliprdrBackend {
    session_id: String,
    os: Arc<dyn OsClipboard>,
    watcher: ClipboardWatcher,
    action_tx: mpsc::UnboundedSender<CliprdrAction>,
    app_handle: AppHandle,
    temp_dir: String,
    remote_formats: Vec<ClipboardFormat>,
    capabilities: ClipboardGeneralCapabilityFlags,
    /// Cache of local files when responding to FileGroupDescriptorW.
    /// Index in this vec corresponds to the `index` field in FileContentsRequest.
    local_files: Vec<std::path::PathBuf>,
    /// In-progress Win→Mac file transfer state (None if no transfer active).
    ///
    /// Wrapped in `Arc<Mutex<>>` so the macOS NSFilePresenter `Fetcher`
    /// closure (running on a non-main NSOperationQueue thread) can drive the
    /// cascade by allocating stream_ids and pushing `RequestFileContents`
    /// actions, while the main session loop concurrently handles responses
    /// here in `on_file_contents_response`. On Windows the Mutex sees no
    /// contention because the cascade is purely main-thread.
    incoming_transfer: Arc<Mutex<Option<IncomingTransfer>>>,
    /// macOS-only: synchronisation primitive for the lazy paste flow.
    /// `None` outside an active lazy transfer; `Some` while a Fetcher may be
    /// blocked waiting for completion. See `LazyDownloadState` docs.
    #[cfg(target_os = "macos")]
    lazy_state: Option<Arc<LazyDownloadState>>,
    /// Last format ID we requested via InitiatePaste (used to dispatch on_format_data_response).
    pending_paste_format_id: u32,
    /// Watchdog task handle for outgoing file transfer timeout.
    /// Automatically releases `transfer_in_progress` lock after 30s of
    /// no FileContentsRequest activity (Mac→Win direction).
    outgoing_watchdog: Option<tokio::task::JoinHandle<()>>,
}

impl Drop for NextDeskCliprdrBackend {
    fn drop(&mut self) {
        if let Some(handle) = self.outgoing_watchdog.take() {
            handle.abort();
        }
        self.abort_incoming_transfer();
        #[cfg(target_os = "macos")]
        {
            if let Some(state) = self.lazy_state.take() {
                state.finish_err("RDP session closed".to_string());
            }
            super::os::macos_presenter::unregister_lazy_paste_for(&self.session_id);
        }
        self.watcher.set_transfer_in_progress(false);
    }
}

/// State machine for receiving files from remote (Win→Mac).
struct IncomingTransfer {
    files: Vec<IncomingFile>,
    /// Index of the file currently being downloaded (vec position, not server index).
    current_vec_index: u32,
    /// Sequence counter for stream_id values we send to server.
    next_stream_id: u32,
    /// Mapping stream_id → (vec_index, expected_mode) for response dispatch.
    /// expected_mode = 0 (size), 1 (data).
    pending_requests: std::collections::HashMap<u32, (u32, u8)>,
    /// Staging directory for this transfer.
    stage_dir: std::path::PathBuf,
    /// Top-level paths (files + directory roots) to write to OS clipboard.
    /// When user pastes a folder, only the folder root goes to NSPasteboard;
    /// Finder copies the whole tree.
    top_level_paths: Vec<std::path::PathBuf>,
    /// Frontend-facing session id (for clipboard-file-* events).
    session_id: String,
    /// First top-level entry name, shown in the progress dialog.
    display_name: String,
    /// Total bytes across all regular-file descriptors (for progress %).
    total_bytes: u64,
    /// Cumulative bytes received across all files in this transfer.
    bytes_received_total: u64,
    /// Last bytes_received_total at which we emitted a progress event.
    last_progress_emit_bytes: u64,
}

struct IncomingFile {
    /// Display name (relative path with `\` separators as received from server).
    #[allow(dead_code)]
    name: String,
    size: u64,
    bytes_received: u64,
    /// Open file handle for streaming write.
    file: Option<std::fs::File>,
    /// Final staged path on disk (with subdirectories created).
    path: std::path::PathBuf,
    /// Original 0-based index in the server's FileGroupDescriptorW list.
    /// Must be used in FileContentsRequest, NOT the vec position
    /// (because directory entries are also indexed by the server but skipped here).
    server_index: u32,
}

// ── Lazy download (macOS NSFilePresenter) ──────────────────────────────────

/// Lifecycle state of a lazy download triggered by Finder Cmd+V.
///
/// The state machine:
///
/// ```text
///   Idle ──Fetcher kicks cascade──▶ InProgress ──complete──▶ Done
///                                              ──abort───▶ Failed(reason)
/// ```
///
/// All threads observing the state wait on `LazyDownloadState::cv` until the
/// terminal `Done` / `Failed` state is reached.
#[cfg(target_os = "macos")]
#[derive(Debug, Clone)]
enum LazyDownloadStatus {
    /// No Fetcher has fired yet — bytes are still 0 on disk.
    Idle,
    /// First Fetcher fired, request_size(0) has been queued. Subsequent
    /// Fetcher invocations should just wait on `cv` instead of re-triggering.
    InProgress,
    /// All file bytes have been written to disk.
    Done,
    /// Transfer was aborted; reason is in the inner string.
    Failed(String),
}

/// Shared between cliprdr backend (response cascade) and the NSFilePresenter
/// `Fetcher` closure. Both sides synchronise via `cv` to know when the file
/// content has been fully populated on disk.
#[cfg(target_os = "macos")]
struct LazyDownloadState {
    status: Mutex<LazyDownloadStatus>,
    cv: Condvar,
}

#[cfg(target_os = "macos")]
impl LazyDownloadState {
    fn new() -> Self {
        Self {
            status: Mutex::new(LazyDownloadStatus::Idle),
            cv: Condvar::new(),
        }
    }

    /// Atomically transition to `InProgress` if currently `Idle`.
    /// Returns `true` if this caller wins the race and should kick off the
    /// download cascade; `false` if another thread already kicked it off (or
    /// it's already finished).
    fn try_start(&self) -> bool {
        let mut s = self.status.lock().expect("lazy status mutex poisoned");
        if matches!(*s, LazyDownloadStatus::Idle) {
            *s = LazyDownloadStatus::InProgress;
            true
        } else {
            false
        }
    }

    /// Mark the download as finished. Wakes any blocked Fetchers.
    fn finish_ok(&self) {
        let mut s = self.status.lock().expect("lazy status mutex poisoned");
        // Only transition forward — a late `finish_ok` after `finish_err`
        // shouldn't downgrade the failure (defensive).
        if !matches!(*s, LazyDownloadStatus::Failed(_)) {
            *s = LazyDownloadStatus::Done;
        }
        self.cv.notify_all();
    }

    /// Mark the download as failed. Wakes any blocked Fetchers with the
    /// supplied reason.
    fn finish_err(&self, reason: String) {
        let mut s = self.status.lock().expect("lazy status mutex poisoned");
        *s = LazyDownloadStatus::Failed(reason);
        self.cv.notify_all();
    }

    /// Block until the status reaches a terminal state (`Done` or `Failed`).
    /// Returns `Ok(())` for `Done`, `Err(reason)` for `Failed`.
    fn wait_done(&self) -> Result<(), String> {
        let mut s = self.status.lock().expect("lazy status mutex poisoned");
        loop {
            match &*s {
                LazyDownloadStatus::Done => return Ok(()),
                LazyDownloadStatus::Failed(reason) => return Err(reason.clone()),
                LazyDownloadStatus::Idle | LazyDownloadStatus::InProgress => {
                    s = self.cv.wait(s).expect("lazy status mutex poisoned");
                }
            }
        }
    }
}

/// Send a SIZE FileContentsRequest. Free function so the lazy fetcher (which
/// only has shared `Arc<Mutex<IncomingTransfer>>` access, not `&mut self`)
/// can drive the cascade without going through `NextDeskCliprdrBackend`.
fn enqueue_request_size(
    transfer: &mut IncomingTransfer,
    action_tx: &mpsc::UnboundedSender<CliprdrAction>,
    vec_index: u32,
) {
    use ironrdp::cliprdr::pdu::{FileContentsFlags, FileContentsRequest};

    let Some(f) = transfer.files.get(vec_index as usize) else {
        log::debug!(
            "[cliprdr] enqueue_request_size: vec_index {} out of range",
            vec_index
        );
        return;
    };
    let server_index = f.server_index;
    let Ok(server_index) = i32::try_from(server_index) else {
        log::warn!(
            "[cliprdr] enqueue_request_size: server_index {} exceeds i32",
            f.server_index
        );
        return;
    };

    let stream_id = transfer.next_stream_id;
    transfer.next_stream_id = transfer.next_stream_id.wrapping_add(1);
    transfer.pending_requests.insert(stream_id, (vec_index, 0));
    transfer.current_vec_index = vec_index;

    let request = FileContentsRequest {
        stream_id,
        index: server_index,
        flags: FileContentsFlags::SIZE,
        position: 0,
        requested_size: 8,
        data_id: None,
    };
    log::debug!(
        "[cliprdr] → Requesting SIZE: stream_id={} server_index={} (vec={})",
        stream_id,
        server_index,
        vec_index
    );
    let _ = action_tx.send(CliprdrAction::RequestFileContents(request));
}

/// Send a DATA FileContentsRequest for the next chunk.
fn enqueue_request_next_chunk(
    transfer: &mut IncomingTransfer,
    action_tx: &mpsc::UnboundedSender<CliprdrAction>,
    vec_index: u32,
) {
    use ironrdp::cliprdr::pdu::{FileContentsFlags, FileContentsRequest};

    const CHUNK_SIZE: u32 = 256 * 1024; // 256 KB

    let (server_index, position, remaining) = match transfer.files.get(vec_index as usize) {
        Some(f) => (
            f.server_index,
            f.bytes_received,
            f.size.saturating_sub(f.bytes_received),
        ),
        None => {
            log::debug!(
                "[cliprdr] enqueue_request_next_chunk: vec_index {} out of range",
                vec_index
            );
            return;
        }
    };

    if remaining == 0 {
        return;
    }
    let Ok(server_index) = i32::try_from(server_index) else {
        log::warn!(
            "[cliprdr] enqueue_request_next_chunk: server_index {} exceeds i32",
            server_index
        );
        return;
    };

    let chunk_size = std::cmp::min(remaining, CHUNK_SIZE as u64) as u32;
    let stream_id = transfer.next_stream_id;
    transfer.next_stream_id = transfer.next_stream_id.wrapping_add(1);
    transfer.pending_requests.insert(stream_id, (vec_index, 1));

    let request = FileContentsRequest {
        stream_id,
        index: server_index,
        flags: FileContentsFlags::RANGE,
        position,
        requested_size: chunk_size,
        data_id: None,
    };
    log::debug!(
        "[cliprdr] → Requesting DATA: stream_id={} server_index={} (vec={}) pos={} size={}",
        stream_id,
        server_index,
        vec_index,
        position,
        chunk_size
    );
    let _ = action_tx.send(CliprdrAction::RequestFileContents(request));
}

/// Result of a "what should I do next?" decision made under the
/// `incoming_transfer` lock. The actual side effect (e.g. completing the
/// transfer, which calls `&mut self` methods that re-lock) is performed
/// outside the lock to avoid recursive Mutex acquisition.
enum NextStep {
    None,
    Complete,
}

impl std::fmt::Debug for NextDeskCliprdrBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NextDeskCliprdrBackend")
            .field("temp_dir", &self.temp_dir)
            .field("remote_formats", &self.remote_formats.len())
            .field("capabilities", &self.capabilities)
            .finish()
    }
}

impl_as_any!(NextDeskCliprdrBackend);

impl CliprdrBackend for NextDeskCliprdrBackend {
    fn temporary_directory(&self) -> &str {
        &self.temp_dir
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        ClipboardGeneralCapabilityFlags::USE_LONG_FORMAT_NAMES
            | ClipboardGeneralCapabilityFlags::STREAM_FILECLIP_ENABLED
            | ClipboardGeneralCapabilityFlags::FILECLIP_NO_FILE_PATHS
            | ClipboardGeneralCapabilityFlags::HUGE_FILE_SUPPORT_ENABLED
    }

    fn on_ready(&mut self) {
        log::info!(
            "[cliprdr] session={} CLIPRDR channel ready — starting watcher",
            self.session_id
        );
        self.watcher.start();
    }

    fn on_process_negotiated_capabilities(
        &mut self,
        capabilities: ClipboardGeneralCapabilityFlags,
    ) {
        log::info!(
            "[cliprdr] session={} Negotiated capabilities: {capabilities:?}",
            self.session_id
        );
        self.capabilities = capabilities;
    }

    /// Called during initialization — report local clipboard formats once.
    fn on_request_format_list(&mut self) {
        log::debug!(
            "[cliprdr] session={} on_request_format_list",
            self.session_id
        );
        let os_formats = self.os.available_formats();
        let rdp_formats = map_os_formats_to_rdp(&os_formats);
        log::info!(
            "[cliprdr] session={} Initial format list: {} OS formats {:?} -> {} RDP formats [{}]",
            self.session_id,
            os_formats.len(),
            os_formats,
            rdp_formats.len(),
            describe_clipboard_formats(&rdp_formats)
        );
        if !rdp_formats.is_empty() {
            let _ = self
                .action_tx
                .send(CliprdrAction::InitiateCopy(rdp_formats));
        }
    }

    /// Remote performed copy — pick best format and request data.
    fn on_remote_copy(&mut self, available_formats: &[ClipboardFormat]) {
        if !super::watcher::is_active_clipboard_session(&self.session_id) {
            log::debug!(
                "[cliprdr] session={} ignoring remote copy while another session owns the clipboard",
                self.session_id
            );
            return;
        }

        log::info!(
            "[cliprdr] session={} Remote copy: {} formats",
            self.session_id,
            available_formats.len()
        );
        log::info!(
            "[cliprdr] session={} Remote formats: {}",
            self.session_id,
            describe_clipboard_formats(available_formats)
        );

        // Don't kick off another file paste while a download is still running.
        // The cleanest signal is the FormatDataResponse we'd request next, but
        // intercepting at this earlier stage avoids extra wire traffic.
        if self
            .incoming_transfer
            .lock()
            .expect("incoming_transfer poisoned")
            .is_some()
        {
            let preview = pick_preferred_format(available_formats);
            let is_files = preview
                .and_then(|fid| {
                    available_formats
                        .iter()
                        .find(|f| f.id() == fid)
                        .and_then(|f| f.name())
                })
                .map(|n| n.value() == FORMAT_NAME_FILE_GROUP)
                .unwrap_or(false);
            if is_files {
                log::warn!(
                    "[cliprdr] Ignoring on_remote_copy: a file transfer is already in progress"
                );
                return;
            }
        }

        self.remote_formats = available_formats.to_vec();

        let preferred = pick_preferred_format(available_formats);

        if let Some(format_id) = preferred {
            log::info!(
                "[cliprdr] Requesting preferred format id={}",
                format_id.value()
            );
            self.pending_paste_format_id = format_id.value();
            let _ = self.action_tx.send(CliprdrAction::InitiatePaste(format_id));
        } else {
            log::warn!("[cliprdr] No preferred format available in remote copy");
        }
    }

    /// Server requests data from our local clipboard.
    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        let format_id = request.format.value();
        log::info!(
            "[cliprdr] session={} Server requests format id={}",
            self.session_id,
            format_id
        );

        let response = match self.read_format_for_request(format_id) {
            Ok(data) => {
                log::debug!(
                    "[cliprdr] Read {} bytes for format id={}",
                    data.len(),
                    format_id
                );
                OwnedFormatDataResponse::new_data(data)
            }
            Err(e) => {
                log::warn!("[cliprdr] Failed to read format {}: {}", format_id, e);
                OwnedFormatDataResponse::new_error()
            }
        };

        let _ = self
            .action_tx
            .send(CliprdrAction::SubmitFormatData(response));
    }

    /// Server sends data response — write to local clipboard.
    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        if response.is_error() {
            log::warn!("[cliprdr] Remote returned error for format data");
            return;
        }

        if !super::watcher::is_active_clipboard_session(&self.session_id) {
            self.pending_paste_format_id = 0;
            log::debug!(
                "[cliprdr] session={} dropping remote clipboard data after ownership changed",
                self.session_id
            );
            return;
        }

        let data = response.data();
        log::info!(
            "[cliprdr] session={} Received {} bytes from remote",
            self.session_id,
            data.len()
        );

        // Check if this is a FileGroupDescriptorW response (Win→Mac file paste)
        let is_file_group = self.pending_paste_format_id != 0
            && self.is_file_group_format_id(self.pending_paste_format_id);

        if is_file_group {
            // Reject overlapping transfers: if one is already running, the
            // server-initiated FormatDataResponse here is most likely a
            // duplicate (user re-Ctrl+C'd while still downloading) or a
            // retry. Coalescing them would discard partial progress.
            if self
                .incoming_transfer
                .lock()
                .expect("incoming_transfer poisoned")
                .is_some()
            {
                log::warn!(
                    "[cliprdr] Ignoring new FileGroupDescriptorW: an incoming transfer is already in progress"
                );
                return;
            }
            if let Err(e) = self.start_incoming_file_transfer(data) {
                log::warn!("[cliprdr] Failed to start incoming file transfer: {}", e);
            }
            return;
        }

        if let Err(e) = self.write_remote_data_to_clipboard(data) {
            log::warn!("[cliprdr] Failed to write remote data: {}", e);
        } else {
            log::debug!("[cliprdr] Wrote remote data to OS clipboard");
            self.watcher.notify_remote_write();
        }
    }

    fn on_file_contents_request(&mut self, request: FileContentsRequest) {
        use ironrdp::cliprdr::pdu::{FileContentsFlags, FileContentsResponse};

        let stream_id = request.stream_id;
        let index = request.index as usize;

        log::debug!(
            "[cliprdr] FileContentsRequest stream_id={} index={} flags={:?} pos={} size={}",
            stream_id,
            request.index,
            request.flags,
            request.position,
            request.requested_size
        );

        // Refresh the outgoing transfer watchdog on every chunk request.
        // This prevents the watcher from sending FormatList mid-transfer.
        self.refresh_outgoing_watchdog();

        // Out-of-range: respond synchronously with error (no I/O needed)
        if index >= self.local_files.len() {
            log::debug!(
                "[cliprdr] FileContentsRequest: index {} out of range (have {})",
                index,
                self.local_files.len()
            );
            let _ = self.action_tx.send(CliprdrAction::SubmitFileContents(
                FileContentsResponse::new_error(stream_id),
            ));
            return;
        }

        // Plan B: offload disk I/O to a blocking thread so the main RDP
        // session loop (rdp_session::active_session tokio::select!) is not
        // blocked. Without this, every 256 KB chunk read serializes mouse
        // input + GraphicsUpdate frame writes, freezing the canvas.
        let path = self.local_files[index].clone();
        let action_tx = self.action_tx.clone();
        let position = request.position;
        let requested_size = request.requested_size as u64;
        let flags = request.flags;

        tokio::task::spawn_blocking(move || {
            let is_data_request = flags.contains(FileContentsFlags::RANGE);
            #[cfg(target_os = "macos")]
            if let Err(e) = super::os::macos_presenter::fetch_registered_path(&path) {
                log::debug!(
                    "[cliprdr] FileContentsRequest lazy fetch failed: {}: {}",
                    path.display(),
                    e
                );
                let _ = action_tx.send(CliprdrAction::SubmitFileContents(
                    FileContentsResponse::new_error(stream_id),
                ));
                return;
            }

            let response = if flags.contains(FileContentsFlags::SIZE) {
                match std::fs::metadata(&path) {
                    Ok(meta) => {
                        let size = meta.len();
                        log::debug!(
                            "[cliprdr] FileContentsRequest SIZE: {} = {} bytes",
                            path.display(),
                            size
                        );
                        FileContentsResponse::new_size_response(stream_id, size)
                    }
                    Err(e) => {
                        log::debug!(
                            "[cliprdr] FileContentsRequest SIZE failed: {}: {}",
                            path.display(),
                            e
                        );
                        FileContentsResponse::new_error(stream_id)
                    }
                }
            } else if flags.contains(FileContentsFlags::RANGE) {
                let response_size = capped_outgoing_file_contents_size(requested_size);
                if response_size < requested_size {
                    log::debug!(
                        "[cliprdr] FileContentsRequest DATA capped: requested={} capped={}",
                        requested_size,
                        response_size
                    );
                }
                match read_file_range_blocking(&path, position, response_size) {
                    Ok(data) => {
                        log::debug!(
                            "[cliprdr] FileContentsRequest DATA: {} pos={} requested={} sent={} bytes",
                            path.display(), position, requested_size, data.len()
                        );
                        FileContentsResponse::new_data_response(stream_id, data)
                    }
                    Err(e) => {
                        log::debug!(
                            "[cliprdr] FileContentsRequest DATA failed: {}: {}",
                            path.display(),
                            e
                        );
                        FileContentsResponse::new_error(stream_id)
                    }
                }
            } else {
                log::debug!("[cliprdr] FileContentsRequest unknown flags: {:?}", flags);
                FileContentsResponse::new_error(stream_id)
            };

            if is_data_request && OUTGOING_FILE_CONTENTS_RESPONSE_PACE_MS > 0 {
                std::thread::sleep(Duration::from_millis(
                    OUTGOING_FILE_CONTENTS_RESPONSE_PACE_MS,
                ));
            }

            let _ = action_tx.send(CliprdrAction::SubmitFileContents(response));
        });
    }

    fn on_file_contents_response(&mut self, response: FileContentsResponse<'_>) {
        let stream_id = response.stream_id();
        let data_len = response.data().len();

        log::debug!(
            "[cliprdr] FileContentsResponse stream_id={} data_len={}",
            stream_id,
            data_len
        );

        // Find what this response is for
        let pending = {
            let mut guard = self
                .incoming_transfer
                .lock()
                .expect("incoming_transfer poisoned");
            guard
                .as_mut()
                .and_then(|t| t.pending_requests.remove(&stream_id))
        };

        let Some((file_index, mode)) = pending else {
            log::debug!(
                "[cliprdr] FileContentsResponse stream_id={} has no matching request — ignoring",
                stream_id
            );
            return;
        };

        if mode == 0 {
            // SIZE response — data should be exactly 8 bytes (u64 LE)
            match response.data_as_size() {
                Ok(size) => {
                    log::debug!(
                        "[cliprdr] Got file size: index={} size={}",
                        file_index,
                        size
                    );

                    // Update size, decide next step inside the lock.
                    let next_step = {
                        let mut guard = self
                            .incoming_transfer
                            .lock()
                            .expect("incoming_transfer poisoned");
                        let Some(t) = guard.as_mut() else {
                            return;
                        };
                        if let Some(f) = t.files.get_mut(file_index as usize) {
                            f.size = size;
                        }
                        if size == 0 {
                            // Empty file — create it and move to next.
                            if let Some(f) = t.files.get(file_index as usize) {
                                let _ = std::fs::write(&f.path, b"");
                            }
                            if (file_index as usize + 1) >= t.files.len() {
                                NextStep::Complete
                            } else {
                                enqueue_request_size(t, &self.action_tx, file_index + 1);
                                NextStep::None
                            }
                        } else {
                            enqueue_request_next_chunk(t, &self.action_tx, file_index);
                            NextStep::None
                        }
                    };

                    if matches!(next_step, NextStep::Complete) {
                        self.complete_incoming_transfer();
                    }
                }
                Err(e) => {
                    log::debug!(
                        "[cliprdr] Failed to parse size response (probably error): {:?}",
                        e
                    );
                    self.abort_incoming_transfer();
                }
            }
        } else {
            // DATA response
            if data_len == 0 {
                log::debug!("[cliprdr] DATA response empty — treating as error");
                self.abort_incoming_transfer();
                return;
            }

            let chunk = response.data().to_vec();
            if let Err(e) = self.append_chunk(file_index, &chunk) {
                log::debug!("[cliprdr] Failed to append chunk: {}", e);
                self.abort_incoming_transfer();
                return;
            }

            // Decide next step under the lock.
            let next_step = {
                let mut guard = self
                    .incoming_transfer
                    .lock()
                    .expect("incoming_transfer poisoned");
                let Some(t) = guard.as_mut() else {
                    return;
                };
                let f = &t.files[file_index as usize];
                let this_file_done = f.bytes_received >= f.size;
                let all_done = this_file_done && (file_index as usize + 1) >= t.files.len();
                if all_done {
                    NextStep::Complete
                } else if this_file_done {
                    enqueue_request_size(t, &self.action_tx, file_index + 1);
                    NextStep::None
                } else {
                    enqueue_request_next_chunk(t, &self.action_tx, file_index);
                    NextStep::None
                }
            };

            if matches!(next_step, NextStep::Complete) {
                self.complete_incoming_transfer();
            }
        }
    }

    fn on_lock(&mut self, data_id: LockDataId) {
        log::debug!("[cliprdr] Lock: {data_id:?}");
    }

    fn on_unlock(&mut self, data_id: LockDataId) {
        log::debug!("[cliprdr] Unlock: {data_id:?}");
    }
}

impl NextDeskCliprdrBackend {
    /// Run an explicit local clipboard check for tab/window focus changes.
    /// The watcher still owns throttling and feedback-loop prevention.
    pub async fn force_local_clipboard_check(&self) {
        self.watcher.force_check().await;
    }

    /// Read format data from OS clipboard for a server request.
    fn read_format_for_request(&mut self, format_id: u32) -> Result<Vec<u8>, String> {
        match format_id {
            CF_UNICODETEXT => {
                let text = self
                    .os
                    .read(ClipFormat::PlainText)
                    .map_err(|e| format!("read PlainText: {e}"))?;
                let s = String::from_utf8(text).map_err(|e| format!("text not UTF-8: {e}"))?;
                Ok(formats::text_to_utf16le(&s))
            }
            CF_DIBV5 | CF_DIB => {
                let png_data = self
                    .os
                    .read(ClipFormat::Png)
                    .map_err(|e| format!("read Png: {e}"))?;
                formats::png_to_dibv5(&png_data)
            }
            CF_TEXT => {
                let text = self
                    .os
                    .read(ClipFormat::PlainText)
                    .map_err(|e| format!("read PlainText: {e}"))?;
                Ok(text)
            }
            CF_PRIVATE_HTML => {
                let html_bytes = self
                    .os
                    .read(ClipFormat::Html)
                    .map_err(|e| format!("read Html: {e}"))?;
                let html =
                    String::from_utf8(html_bytes).map_err(|e| format!("html not UTF-8: {e}"))?;
                Ok(formats::html_to_cf_html(&html))
            }
            CF_PRIVATE_TEXT_HTML => self
                .os
                .read(ClipFormat::Html)
                .map_err(|e| format!("read Html: {e}")),
            CF_PRIVATE_PNG => self
                .os
                .read(ClipFormat::Png)
                .map_err(|e| format!("read Png: {e}")),
            CF_PRIVATE_FILE_GROUP => self.build_file_group_descriptor(),
            _ => Err(format!("Unsupported format: id={format_id}")),
        }
    }

    /// Build a FileGroupDescriptorW PDU payload from local clipboard files.
    fn build_file_group_descriptor(&mut self) -> Result<Vec<u8>, String> {
        let paths = self
            .os
            .read_files()
            .map_err(|e| format!("read_files: {e}"))?;

        if paths.is_empty() {
            return Err("No files on clipboard".into());
        }

        // Cache paths so on_file_contents_request can serve chunks
        self.local_files = paths.clone();

        // Lock the watcher to prevent FormatList during outgoing file transfer.
        // Without this, a spurious clipboard change (screenshot, other app)
        // sends FormatList mid-transfer, causing Windows to abandon the
        // FileContentsRequest chain and leaving the copy stuck.
        log::info!(
            "[cliprdr] Outgoing file transfer started ({} files), locking watcher",
            paths.len()
        );
        self.watcher.set_transfer_in_progress(true);
        self.refresh_outgoing_watchdog();

        // FILEDESCRIPTORW size = 592 bytes per MS-RDPECLIP
        const FD_SIZE: usize = 592;
        let mut buf = Vec::with_capacity(4 + paths.len() * FD_SIZE);

        // cItems (u32 LE)
        buf.extend_from_slice(&(paths.len() as u32).to_le_bytes());

        for path in &paths {
            let mut fd = [0u8; FD_SIZE];

            // dwFlags (offset 0, u32 LE) per MS-RDPECLIP §2.2.5.2.3.1
            //   FD_ATTRIBUTES = 0x00000004
            //   FD_WRITESTIME = 0x00000020
            //   FD_FILESIZE   = 0x00000040
            //   FD_PROGRESSUI = 0x00004000  ← REQUIRED for Windows explorer to show
            //                                 the native "Copying..." progress dialog.
            //                                 Without it the paste finishes silently.
            let flags: u32 = 0x4 | 0x20 | 0x40 | 0x4000;
            fd[0..4].copy_from_slice(&flags.to_le_bytes());

            #[cfg(target_os = "macos")]
            if let Err(e) = super::os::macos_presenter::fetch_registered_path(path) {
                return Err(format!(
                    "fetch lazy clipboard file {}: {}",
                    path.display(),
                    e
                ));
            }

            // Read file metadata
            let metadata = std::fs::metadata(path)
                .map_err(|e| format!("metadata {}: {}", path.display(), e))?;

            // dwFileAttributes at offset 36 (u32 LE) — per MS-RDPECLIP §2.2.5.2.3.1
            // (offset 0 dwFlags + 4 clsid GUID(16) + 8 sizel + 8 pointl = 36)
            let file_attrs: u32 = if metadata.is_dir() { 0x10 } else { 0x80 };
            fd[36..40].copy_from_slice(&file_attrs.to_le_bytes());

            // ftLastWriteTime at offset 56 (FILETIME, 8 bytes — u64 LE 100ns since 1601)
            // (36 dwFileAttributes(4) + 40 ftCreationTime(8) + 48 ftLastAccessTime(8) = 56)
            if let Ok(modified) = metadata.modified() {
                if let Ok(epoch_secs) = modified.duration_since(std::time::UNIX_EPOCH) {
                    let filetime: u64 = (epoch_secs.as_secs() + 11_644_473_600) * 10_000_000;
                    fd[56..64].copy_from_slice(&filetime.to_le_bytes());
                }
            }

            // nFileSizeHigh at offset 64 (u32 LE), nFileSizeLow at offset 68 (u32 LE)
            let file_size = metadata.len();
            let size_high = (file_size >> 32) as u32;
            let size_low = (file_size & 0xFFFF_FFFF) as u32;
            fd[64..68].copy_from_slice(&size_high.to_le_bytes());
            fd[68..72].copy_from_slice(&size_low.to_le_bytes());

            // cFileName at offset 72 (520 bytes = 260 wchar_t UTF-16LE, null terminated)
            let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
            let utf16: Vec<u16> = file_name.encode_utf16().take(259).collect();
            for (i, ch) in utf16.iter().enumerate() {
                let off = 72 + i * 2;
                fd[off..off + 2].copy_from_slice(&ch.to_le_bytes());
            }

            buf.extend_from_slice(&fd);
        }

        log::debug!(
            "[cliprdr] Built FileGroupDescriptorW: {} files, {} bytes",
            paths.len(),
            buf.len()
        );
        Ok(buf)
    }

    /// Read a byte range from a local file (for FileContentsRequest DATA).
    /// Sync wrapper kept for callers that aren't on the blocking pool.
    #[allow(dead_code)]
    fn read_file_range(
        &self,
        path: &std::path::Path,
        offset: u64,
        size: u64,
    ) -> Result<Vec<u8>, String> {
        read_file_range_blocking(path, offset, size)
    }

    // ── Win→Mac file transfer helpers ──

    /// Check if a format ID corresponds to FileGroupDescriptorW (by remote_formats name).
    fn is_file_group_format_id(&self, format_id: u32) -> bool {
        self.remote_formats.iter().any(|f| {
            f.id().value() == format_id
                && f.name()
                    .map(|n| n.value() == FORMAT_NAME_FILE_GROUP)
                    .unwrap_or(false)
        })
    }

    /// Parse FileGroupDescriptorW PDU and start downloading files.
    /// Supports nested directory structure (e.g. `LOIC_2.9.9.99\LOIC.exe`).
    fn start_incoming_file_transfer(&mut self, data: &[u8]) -> Result<(), String> {
        if data.len() < 4 {
            return Err("FileGroupDescriptorW too short".into());
        }
        let count = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;
        log::debug!("[cliprdr] Parsing FileGroupDescriptorW: {} entries", count);

        const FD_SIZE: usize = 592;
        let expected_len = 4 + count * FD_SIZE;
        if data.len() < expected_len {
            return Err(format!(
                "FileGroupDescriptorW length mismatch: got {} expected {}",
                data.len(),
                expected_len
            ));
        }

        // Create staging directory: ~/Library/Caches/NextDesk/clipboard/<timestamp>/
        let stage_dir = dirs::cache_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("NextDesk")
            .join("clipboard")
            .join(format!(
                "{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
            ));
        std::fs::create_dir_all(&stage_dir).map_err(|e| format!("create stage_dir: {e}"))?;

        let mut files = Vec::with_capacity(count);
        let mut top_level_paths: Vec<std::path::PathBuf> = Vec::new();
        let mut top_level_seen = std::collections::HashSet::new();

        const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;

        for i in 0..count {
            let off = 4 + i * FD_SIZE;
            let fd = &data[off..off + FD_SIZE];

            let flags = u32::from_le_bytes([fd[0], fd[1], fd[2], fd[3]]);
            let file_attrs = u32::from_le_bytes([fd[36], fd[37], fd[38], fd[39]]);
            let size_high = u32::from_le_bytes([fd[64], fd[65], fd[66], fd[67]]) as u64;
            let size_low = u32::from_le_bytes([fd[68], fd[69], fd[70], fd[71]]) as u64;
            let size = (size_high << 32) | size_low;

            // cFileName: up to 260 wchar_t (UTF-16LE), null-terminated
            let mut wide: Vec<u16> = Vec::with_capacity(260);
            for j in 0..260 {
                let p = 72 + j * 2;
                let ch = u16::from_le_bytes([fd[p], fd[p + 1]]);
                if ch == 0 {
                    break;
                }
                wide.push(ch);
            }
            let raw_name = String::from_utf16_lossy(&wide);

            // Convert Windows path separators to platform separators and sanitize each segment.
            // Per MS-RDPECLIP §2.2.5.2.3.1, names use `\` as a separator for nested entries.
            let rel_path = match windows_relative_to_pathbuf(&raw_name) {
                Some(p) => p,
                None => {
                    log::warn!(
                        "[cliprdr] Skipping descriptor {}: invalid name '{}'",
                        i,
                        raw_name
                    );
                    continue;
                }
            };

            let abs_path = stage_dir.join(&rel_path);

            // Track the top-level path (first segment) for later writing to OS clipboard
            if let Some(first_seg) = rel_path.iter().next() {
                let seg_str = first_seg.to_string_lossy().to_string();
                if top_level_seen.insert(seg_str) {
                    top_level_paths.push(stage_dir.join(first_seg));
                }
            }

            if file_attrs & FILE_ATTRIBUTE_DIRECTORY != 0 {
                // Directory entry: just create the directory.
                // No FileContentsRequest will be issued for it (server returns no data).
                if let Err(e) = std::fs::create_dir_all(&abs_path) {
                    log::warn!(
                        "[cliprdr] create_dir_all {} failed: {}",
                        abs_path.display(),
                        e
                    );
                }
                log::debug!(
                    "[cliprdr] Descriptor {}: directory '{}' → {}",
                    i,
                    raw_name,
                    abs_path.display()
                );
                continue;
            }

            // Ensure the parent directory exists before any data arrives.
            if let Some(parent) = abs_path.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    log::warn!("[cliprdr] create parent {} failed: {}", parent.display(), e);
                }
            }

            log::debug!(
                "[cliprdr] Descriptor {}: file '{}' size={} flags=0x{:x} → {}",
                i,
                raw_name,
                size,
                flags,
                abs_path.display()
            );

            files.push(IncomingFile {
                name: raw_name,
                size,
                bytes_received: 0,
                file: None,
                path: abs_path,
                server_index: i as u32,
            });
        }

        if files.is_empty() {
            return Err("No regular files in FileGroupDescriptorW".into());
        }

        let total_bytes: u64 = files.iter().map(|f| f.size).sum();
        let display_name = top_level_paths
            .first()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("{} files", files.len()));

        let session_id = format!(
            "cliprdr-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        );

        log::info!(
            "[cliprdr] Starting transfer session={} '{}': {} file(s), {} top-level, {} bytes",
            session_id,
            display_name,
            files.len(),
            top_level_paths.len(),
            total_bytes
        );

        // ── macOS lazy path ─────────────────────────────────────────────
        // On macOS we don't download eagerly. Instead:
        //   1) Build the IncomingTransfer behind a Mutex (no cascade kicked yet)
        //   2) Stage 0-byte placeholders for every file (not just top-level —
        //      the on-disk tree must mirror what server will send so that
        //      relative paths resolve correctly when Finder copies)
        //   3) Register an NSFilePresenter for each top-level path with a
        //      Fetcher closure that, on first invocation, kicks off the
        //      cascade and blocks until completion
        //   4) Write the top-level URLs to NSPasteboard so Finder sees them
        //
        // We deliberately skip the `clipboard-file-begin` event because
        // Finder shows its own native progress UI; we don't want a duplicate
        // toast on top.
        #[cfg(target_os = "macos")]
        {
            // Stage 0-byte placeholders so NSFileCoordinator can route reads
            // through us, and so any nested files (inside a folder paste) also
            // exist when Finder enumerates them. Top-level placeholders also
            // get touched again by `register_lazy_paste`, which is idempotent.
            for f in &files {
                if let Some(parent) = f.path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if !f.path.exists() {
                    if let Err(e) = std::fs::write(&f.path, b"") {
                        log::warn!(
                            "[cliprdr] failed to create placeholder {}: {}",
                            f.path.display(),
                            e
                        );
                    }
                }
            }

            let lazy_state = Arc::new(LazyDownloadState::new());

            *self
                .incoming_transfer
                .lock()
                .expect("incoming_transfer poisoned") = Some(IncomingTransfer {
                files,
                current_vec_index: 0,
                next_stream_id: 1,
                pending_requests: std::collections::HashMap::new(),
                stage_dir,
                top_level_paths: top_level_paths.clone(),
                session_id: session_id.clone(),
                display_name: display_name.clone(),
                total_bytes,
                bytes_received_total: 0,
                last_progress_emit_bytes: 0,
            });

            // Block the watcher from sending FormatList during transfer
            self.watcher.set_transfer_in_progress(true);

            self.lazy_state = Some(Arc::clone(&lazy_state));

            // Build the Fetcher: invoked synchronously on a non-main thread
            // when Finder paste reads the placeholder. First caller kicks off
            // the cascade; everyone blocks on the Condvar until the backend's
            // response handler signals Done/Failed.
            let action_tx = self.action_tx.clone();
            let transfer = Arc::clone(&self.incoming_transfer);
            let fetcher: super::os::macos_presenter::Fetcher = Arc::new({
                let lazy_state = Arc::clone(&lazy_state);
                move |path: &Path| -> Result<(), String> {
                    log::info!("[cliprdr] lazy fetcher invoked for {}", path.display());
                    if lazy_state.try_start() {
                        // We won the race — kick off SIZE for vec_index 0.
                        let mut guard = transfer.lock().expect("incoming_transfer poisoned");
                        if let Some(t) = guard.as_mut() {
                            log::info!(
                                "[cliprdr] lazy: kicking off cascade, {} file(s) to fetch",
                                t.files.len()
                            );
                            enqueue_request_size(t, &action_tx, 0);
                        } else {
                            // Transfer was already cleared (race against
                            // session shutdown). Treat as failure for the
                            // waiter; Finder will see the empty placeholder.
                            return Err("transfer cleared before download started".into());
                        }
                    }
                    // All Fetchers — winner or not — block here until the
                    // response cascade reaches its terminal state.
                    lazy_state.wait_done()
                }
            });

            if let Err(e) = super::os::macos_presenter::register_lazy_paste(
                &self.session_id,
                &top_level_paths,
                fetcher,
            ) {
                // Rollback: clear `incoming_transfer` so subsequent
                // on_remote_copy() / on_format_data_response() calls aren't
                // blocked by the `is_some()` guard.
                *self
                    .incoming_transfer
                    .lock()
                    .expect("incoming_transfer poisoned") = None;
                self.lazy_state = None;
                self.watcher.set_transfer_in_progress(false);
                return Err(format!("register_lazy_paste: {e}"));
            }

            // Now write the placeholder URLs to NSPasteboard so Finder sees
            // them as the current selection.
            if let Err(e) = self.os.write_files(&top_level_paths) {
                // Rollback registration + state on pasteboard write failure.
                super::os::macos_presenter::unregister_lazy_paste_for(&self.session_id);
                *self
                    .incoming_transfer
                    .lock()
                    .expect("incoming_transfer poisoned") = None;
                self.lazy_state = None;
                self.watcher.set_transfer_in_progress(false);
                return Err(format!("write_files: {e}"));
            }
            self.watcher.notify_remote_write();

            log::info!(
                "[cliprdr] Lazy paste registered: {} top-level entries (download deferred until Cmd+V)",
                top_level_paths.len()
            );
            return Ok(());
        }

        // ── Eager path (Windows + any other platform) ───────────────────
        // Notify the frontend so the user sees a progress dialog.
        #[cfg(not(target_os = "macos"))]
        {
            let _ = self.app_handle.emit(
                "clipboard-file-begin",
                ClipboardFileBegin {
                    session_id: session_id.clone(),
                    display_name: display_name.clone(),
                    file_count: files.len() as u32,
                    total_bytes,
                },
            );

            *self
                .incoming_transfer
                .lock()
                .expect("incoming_transfer poisoned") = Some(IncomingTransfer {
                files,
                current_vec_index: 0,
                next_stream_id: 1,
                pending_requests: std::collections::HashMap::new(),
                stage_dir,
                top_level_paths,
                session_id,
                display_name,
                total_bytes,
                bytes_received_total: 0,
                last_progress_emit_bytes: 0,
            });

            // Block the watcher from sending FormatList during transfer
            self.watcher.set_transfer_in_progress(true);

            // Start by requesting size for the first file (vec position 0)
            self.request_size(0);
            Ok(())
        }
    }

    /// Send a FileContentsRequest with SIZE flag.
    /// `vec_index` is the position in `self.incoming_transfer.files`;
    /// the actual `index` field in the wire request is the file's `server_index`.
    ///
    /// Only used by the eager (non-macOS) path; on macOS the lazy fetcher and
    /// the response cascade both call `enqueue_request_size` directly while
    /// already holding the `incoming_transfer` lock.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    fn request_size(&mut self, vec_index: u32) {
        let mut guard = self
            .incoming_transfer
            .lock()
            .expect("incoming_transfer poisoned");
        let Some(t) = guard.as_mut() else {
            return;
        };
        enqueue_request_size(t, &self.action_tx, vec_index);
    }

    /// Send a FileContentsRequest with DATA flag for the next chunk of the given file.
    /// `vec_index` is the position in `self.incoming_transfer.files`;
    /// the actual wire `index` is the file's `server_index`.
    #[allow(dead_code)]
    fn request_next_chunk(&mut self, vec_index: u32) {
        let mut guard = self
            .incoming_transfer
            .lock()
            .expect("incoming_transfer poisoned");
        let Some(t) = guard.as_mut() else {
            return;
        };
        enqueue_request_next_chunk(t, &self.action_tx, vec_index);
    }

    /// Append a received chunk to the staging file and emit a progress event
    /// to the frontend roughly every PROGRESS_EMIT_INTERVAL_BYTES.
    ///
    /// On macOS lazy path the progress emit is skipped — Finder shows native
    /// progress UI; emitting our own toast on top would be redundant.
    fn append_chunk(&mut self, file_index: u32, chunk: &[u8]) -> Result<(), String> {
        use std::io::Write;

        const PROGRESS_EMIT_INTERVAL_BYTES: u64 = 2 * 1024 * 1024; // 2 MB

        let progress_event = {
            let mut guard = self
                .incoming_transfer
                .lock()
                .expect("incoming_transfer poisoned");
            let Some(t) = guard.as_mut() else {
                return Err("no active transfer".into());
            };
            let Some(f) = t.files.get_mut(file_index as usize) else {
                return Err("file index out of range".into());
            };

            if f.file.is_none() {
                let handle = std::fs::File::create(&f.path)
                    .map_err(|e| format!("create staging file {}: {}", f.path.display(), e))?;
                f.file = Some(handle);
            }

            let handle = f.file.as_mut().expect("file handle just created");
            handle
                .write_all(chunk)
                .map_err(|e| format!("write staging file {}: {}", f.path.display(), e))?;
            f.bytes_received += chunk.len() as u64;
            t.bytes_received_total += chunk.len() as u64;

            let should_emit = t
                .bytes_received_total
                .saturating_sub(t.last_progress_emit_bytes)
                >= PROGRESS_EMIT_INTERVAL_BYTES
                || t.bytes_received_total >= t.total_bytes;

            if should_emit {
                t.last_progress_emit_bytes = t.bytes_received_total;
                Some(ClipboardFileProgress {
                    session_id: t.session_id.clone(),
                    display_name: t.display_name.clone(),
                    bytes_received: t.bytes_received_total,
                    total_bytes: t.total_bytes,
                    file_index,
                    file_count: t.files.len() as u32,
                })
            } else {
                None
            }
        };

        // Skip per-chunk progress emit on the macOS lazy path: Finder owns
        // the user-facing progress UI in that flow.
        let _ = progress_event;
        #[cfg(not(target_os = "macos"))]
        {
            if let Some(p) = progress_event {
                let _ = self.app_handle.emit("clipboard-file-progress", p);
            }
        }

        Ok(())
    }

    /// All files downloaded — flush, write to OS clipboard (if eager), cleanup state.
    ///
    /// On the macOS lazy path the OS clipboard was already populated at
    /// `start_incoming_file_transfer` time with placeholder URLs; we just
    /// need to flush the file handles, signal the waiting Fetcher, and emit
    /// the `clipboard-file-ready` event for any backend telemetry consumers.
    fn complete_incoming_transfer(&mut self) {
        let mut t = match self
            .incoming_transfer
            .lock()
            .expect("incoming_transfer poisoned")
            .take()
        {
            Some(t) => t,
            None => return,
        };

        // Flush all file handles
        for f in &mut t.files {
            if let Some(mut h) = f.file.take() {
                use std::io::Write;
                let _ = h.flush();
            }
        }

        let paths_to_paste = t.top_level_paths.clone();
        log::info!(
            "[cliprdr] Incoming transfer complete: {} file(s) staged, {} top-level path(s) at {}",
            t.files.len(),
            paths_to_paste.len(),
            t.stage_dir.display()
        );

        // ── macOS lazy path: signal the Fetcher and emit ready event ──
        #[cfg(target_os = "macos")]
        {
            if let Some(state) = self.lazy_state.take() {
                state.finish_ok();
                let _ = self.app_handle.emit(
                    "clipboard-file-ready",
                    ClipboardFileReady {
                        session_id: t.session_id.clone(),
                        display_name: t.display_name.clone(),
                        file_count: t.files.len() as u32,
                        total_bytes: t.total_bytes,
                    },
                );
                self.watcher.set_transfer_in_progress(false);
                // Note: leave the NSFilePresenter registered. The bytes are
                // now on disk, so subsequent `relinquishPresentedItemToReader:`
                // calls (if Finder pastes again or refreshes) will re-enter
                // the Fetcher, which immediately returns Ok because the
                // status is Done. The presenter is replaced by the next
                // remote file copy, or removed when this session closes.
                return;
            }
        }

        // ── Eager path: write paths to OS clipboard now ──
        let write_result = self.os.write_files(&paths_to_paste);
        match &write_result {
            Ok(_) => {
                log::info!(
                    "[cliprdr] OS clipboard updated with {} top-level path(s)",
                    paths_to_paste.len()
                );
                self.watcher.notify_remote_write();
                let _ = self.app_handle.emit(
                    "clipboard-file-ready",
                    ClipboardFileReady {
                        session_id: t.session_id.clone(),
                        display_name: t.display_name.clone(),
                        file_count: t.files.len() as u32,
                        total_bytes: t.total_bytes,
                    },
                );
            }
            Err(e) => {
                log::warn!("[cliprdr] Failed to write files to OS clipboard: {}", e);
                let _ = self.app_handle.emit(
                    "clipboard-file-error",
                    ClipboardFileError {
                        session_id: t.session_id.clone(),
                        display_name: t.display_name.clone(),
                        error: format!("{}", e),
                    },
                );
            }
        }

        self.watcher.set_transfer_in_progress(false);
    }

    /// Abort the incoming transfer and cleanup partial files.
    ///
    /// On the macOS lazy path: signal the waiting Fetcher with `Failed` so
    /// it returns from `relinquish` (Finder will see the empty placeholder).
    /// Refresh (or start) the outgoing file transfer watchdog timer.
    ///
    /// The watchdog releases `transfer_in_progress` after 30s of inactivity
    /// (no `FileContentsRequest` received). This is the release mechanism
    /// for outgoing (Mac→Win) transfers, where there is no explicit
    /// "transfer complete" signal from the remote side.
    fn refresh_outgoing_watchdog(&mut self) {
        // Cancel previous watchdog if any
        if let Some(handle) = self.outgoing_watchdog.take() {
            handle.abort();
        }

        let watcher_inner = self.watcher.transfer_in_progress_flag();
        self.outgoing_watchdog = Some(tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(30)).await;
            // Timer fired — no new FileContentsRequest for 30s.
            // Release the watcher lock.
            log::info!(
                "[cliprdr] Outgoing transfer watchdog: 30s idle, \
                 releasing watcher lock"
            );
            watcher_inner
                .transfer_in_progress
                .store(false, Ordering::SeqCst);
        }));
    }

    fn abort_incoming_transfer(&mut self) {
        let mut t = match self
            .incoming_transfer
            .lock()
            .expect("incoming_transfer poisoned")
            .take()
        {
            Some(t) => t,
            None => return,
        };
        log::warn!(
            "[cliprdr] Aborting incoming file transfer (session={} '{}')",
            t.session_id,
            t.display_name
        );
        for f in &mut t.files {
            f.file.take(); // close handle
            let _ = std::fs::remove_file(&f.path);
        }
        let _ = std::fs::remove_dir_all(&t.stage_dir);

        #[cfg(target_os = "macos")]
        {
            if let Some(state) = self.lazy_state.take() {
                state.finish_err("Transfer aborted".to_string());
            }
            // Tear down presenters — the placeholder paths are gone.
            super::os::macos_presenter::unregister_lazy_paste_for(&self.session_id);
        }

        let _ = self.app_handle.emit(
            "clipboard-file-error",
            ClipboardFileError {
                session_id: t.session_id.clone(),
                display_name: t.display_name.clone(),
                error: "Transfer aborted".to_string(),
            },
        );
        self.watcher.set_transfer_in_progress(false);
    }

    /// Write remote data to OS clipboard. Uses content heuristics to detect format.
    fn write_remote_data_to_clipboard(&self, data: &[u8]) -> Result<(), String> {
        // PNG magic bytes
        if data.len() >= 8 && data.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
            let items = vec![(ClipFormat::Png, data.to_vec())];
            return self
                .os
                .write_multi(&items)
                .map_err(|e| format!("write PNG: {e}"));
        }

        if data.len() >= 4 {
            let size = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
            if size == 124 {
                let png = formats::dibv5_to_png(data)?;
                let items = vec![(ClipFormat::Png, png)];
                return self
                    .os
                    .write_multi(&items)
                    .map_err(|e| format!("write DIBV5→PNG: {e}"));
            }
            if size == 40 {
                let png = formats::dib_to_png(data)?;
                let items = vec![(ClipFormat::Png, png)];
                return self
                    .os
                    .write_multi(&items)
                    .map_err(|e| format!("write DIB→PNG: {e}"));
            }
        }

        // CF_HTML
        if data.starts_with(b"Version:") {
            if let Some(html) = formats::cf_html_to_html(data) {
                let items = vec![
                    (ClipFormat::Html, html.as_bytes().to_vec()),
                    (ClipFormat::PlainText, html.into_bytes()),
                ];
                return self
                    .os
                    .write_multi(&items)
                    .map_err(|e| format!("write HTML: {e}"));
            }
        }

        // UTF-16LE text
        if let Some(text) = formats::utf16le_to_text(data) {
            let items = vec![(ClipFormat::PlainText, text.into_bytes())];
            return self
                .os
                .write_multi(&items)
                .map_err(|e| format!("write text: {e}"));
        }

        // Fallback
        let text = String::from_utf8_lossy(data).to_string();
        let items = vec![(ClipFormat::PlainText, text.into_bytes())];
        self.os
            .write_multi(&items)
            .map_err(|e| format!("write fallback text: {e}"))
    }
}

// ── Format selection helpers ──

/// Pick the best format from remote_formats by priority.
fn pick_preferred_format(formats: &[ClipboardFormat]) -> Option<ClipboardFormatId> {
    // FileGroupDescriptorW
    for f in formats {
        if let Some(name) = f.name() {
            if name.value() == FORMAT_NAME_FILE_GROUP {
                return Some(f.id());
            }
        }
    }
    // PNG (long name)
    for f in formats {
        if let Some(name) = f.name() {
            if name.value() == FORMAT_NAME_PNG {
                return Some(f.id());
            }
        }
    }
    // CF_DIBV5
    for f in formats {
        if f.id().value() == CF_DIBV5 {
            return Some(f.id());
        }
    }
    // CF_DIB
    for f in formats {
        if f.id().value() == CF_DIB {
            return Some(f.id());
        }
    }
    // HTML Format
    for f in formats {
        if let Some(name) = f.name() {
            if name.value() == FORMAT_NAME_HTML {
                return Some(f.id());
            }
        }
    }
    // text/html
    for f in formats {
        if let Some(name) = f.name() {
            if name.value() == FORMAT_NAME_TEXT_HTML {
                return Some(f.id());
            }
        }
    }
    // CF_UNICODETEXT
    for f in formats {
        if f.id().value() == CF_UNICODETEXT {
            return Some(f.id());
        }
    }
    // CF_TEXT
    for f in formats {
        if f.id().value() == CF_TEXT {
            return Some(f.id());
        }
    }
    None
}

fn describe_clipboard_formats(formats: &[ClipboardFormat]) -> String {
    formats
        .iter()
        .map(|format| {
            let name = format
                .name()
                .map(|name| name.value().to_string())
                .unwrap_or_else(|| "-".to_string());
            format!("id={} name={}", format.id().value(), name)
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Convert OS clipboard formats to RDP advertisement formats.
fn map_os_formats_to_rdp(os_formats: &[ClipFormat]) -> Vec<ClipboardFormat> {
    let mut formats = Vec::new();
    let mut has_text = false;
    let mut has_image = false;

    for fmt in os_formats {
        match fmt {
            ClipFormat::PlainText => {
                if !has_text {
                    formats.push(ClipboardFormat::new(ClipboardFormatId::new(CF_UNICODETEXT)));
                    has_text = true;
                }
            }
            ClipFormat::Html => {
                push_named(&mut formats, CF_PRIVATE_HTML, FORMAT_NAME_HTML);
                push_named(&mut formats, CF_PRIVATE_TEXT_HTML, FORMAT_NAME_TEXT_HTML);
                if !has_text {
                    formats.push(ClipboardFormat::new(ClipboardFormatId::new(CF_UNICODETEXT)));
                    has_text = true;
                }
            }
            #[cfg(target_os = "macos")]
            ClipFormat::Tiff => {
                if !has_image {
                    advertise_image(&mut formats);
                    has_image = true;
                }
            }
            ClipFormat::Png => {
                if !has_image {
                    advertise_image(&mut formats);
                    has_image = true;
                }
            }
            #[cfg(target_os = "windows")]
            ClipFormat::Bitmap => {
                if !has_image {
                    advertise_image(&mut formats);
                    has_image = true;
                }
            }
            ClipFormat::FileList => {
                push_named(&mut formats, CF_PRIVATE_FILE_GROUP, FORMAT_NAME_FILE_GROUP);
            }
        }
    }

    formats
}

fn push_named(formats: &mut Vec<ClipboardFormat>, id: u32, name: &'static str) {
    formats.push(
        ClipboardFormat::new(ClipboardFormatId::new(id))
            .with_name(ironrdp::cliprdr::pdu::ClipboardFormatName::new(name)),
    );
}

fn advertise_image(formats: &mut Vec<ClipboardFormat>) {
    push_named(formats, CF_PRIVATE_PNG, FORMAT_NAME_PNG);
    formats.push(ClipboardFormat::new(ClipboardFormatId::new(CF_DIBV5)));
    formats.push(ClipboardFormat::new(ClipboardFormatId::new(CF_DIB)));
}

/// Read a byte range from a local file. Used from `tokio::task::spawn_blocking`
/// to keep the main RDP session loop responsive while serving CLIPRDR
/// FileContentsRequest DATA chunks (Plan B for canvas-freeze fix).
fn read_file_range_blocking(
    path: &std::path::Path,
    offset: u64,
    size: u64,
) -> Result<Vec<u8>, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).map_err(|e| format!("open {}: {}", path.display(), e))?;
    f.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("seek {}: {}", path.display(), e))?;

    let mut buf = vec![0u8; size as usize];
    let n = f
        .read(&mut buf)
        .map_err(|e| format!("read {}: {}", path.display(), e))?;
    buf.truncate(n);
    Ok(buf)
}

/// Convert a Windows-style relative path (using `\` separators, e.g.
/// `LOIC_2.9.9.99\LOIC.exe`) to a platform-native `PathBuf`, sanitizing
/// each segment to avoid traversal or invalid characters.
///
/// Returns `None` if the name is empty, contains absolute components,
/// or contains a segment that resolves to nothing (e.g. only control chars).
fn windows_relative_to_pathbuf(name: &str) -> Option<std::path::PathBuf> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Disallow drive letters and absolute paths from the server
    if trimmed.contains(':') || trimmed.starts_with('/') || trimmed.starts_with('\\') {
        return None;
    }

    let mut buf = std::path::PathBuf::new();
    for raw_segment in trimmed.split(|c| c == '\\' || c == '/') {
        if raw_segment.is_empty() || raw_segment == "." || raw_segment == ".." {
            continue;
        }
        let safe = sanitize_segment(raw_segment);
        if safe.is_empty() {
            return None;
        }
        buf.push(safe);
    }

    if buf.as_os_str().is_empty() {
        None
    } else {
        Some(buf)
    }
}

/// Sanitize a single path segment (no separators, no control chars, no NUL).
fn sanitize_segment(seg: &str) -> String {
    seg.chars()
        .map(|c| {
            if c == '/' || c == '\\' || c == '\0' || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect::<String>()
        .trim()
        .to_string()
}

#[cfg(test)]
mod path_tests {
    use super::*;

    #[test]
    fn flat_filename() {
        let p = windows_relative_to_pathbuf("276M.zip").unwrap();
        assert_eq!(p, std::path::PathBuf::from("276M.zip"));
    }

    #[test]
    fn nested_directory() {
        let p = windows_relative_to_pathbuf("LOIC_2.9.9.99\\LOIC.exe").unwrap();
        assert_eq!(
            p,
            std::path::PathBuf::from("LOIC_2.9.9.99").join("LOIC.exe")
        );
    }

    #[test]
    fn deeply_nested() {
        let p = windows_relative_to_pathbuf("a\\b\\c\\d.txt").unwrap();
        assert_eq!(
            p,
            std::path::PathBuf::from("a")
                .join("b")
                .join("c")
                .join("d.txt")
        );
    }

    #[test]
    fn rejects_drive_letter() {
        assert!(windows_relative_to_pathbuf("C:\\Windows\\evil.exe").is_none());
    }

    #[test]
    fn rejects_absolute_unix() {
        assert!(windows_relative_to_pathbuf("/etc/passwd").is_none());
    }

    #[test]
    fn rejects_empty() {
        assert!(windows_relative_to_pathbuf("").is_none());
        assert!(windows_relative_to_pathbuf("   ").is_none());
    }

    #[test]
    fn dot_dot_segments_dropped() {
        let p = windows_relative_to_pathbuf("foo\\..\\bar.txt").unwrap();
        // ".." segment is silently dropped, becoming foo/bar.txt
        assert_eq!(p, std::path::PathBuf::from("foo").join("bar.txt"));
    }

    #[test]
    fn outgoing_file_contents_size_is_capped() {
        assert_eq!(capped_outgoing_file_contents_size(8), 8);
        assert_eq!(
            capped_outgoing_file_contents_size(256 * 1024),
            OUTGOING_FILE_CONTENTS_CHUNK_LIMIT
        );
    }

    #[test]
    fn outgoing_file_contents_response_pace_is_small() {
        assert!(
            OUTGOING_FILE_CONTENTS_RESPONSE_PACE_MS <= 8,
            "response pacing should preserve file-transfer throughput"
        );
    }
}

// ── Frontend-facing event payloads (Tauri emit) ──

/// Emitted when a Win→Mac CLIPRDR file transfer starts.
///
/// Skipped on macOS (lazy path): Finder shows its own native progress UI
/// once the user hits Cmd+V; we don't want a duplicate toast on top.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(target_os = "macos", allow(dead_code))]
struct ClipboardFileBegin {
    session_id: String,
    display_name: String,
    file_count: u32,
    total_bytes: u64,
}

/// Emitted periodically as bytes arrive (every ~2 MB).
#[derive(Debug, Clone, Serialize)]
struct ClipboardFileProgress {
    session_id: String,
    display_name: String,
    bytes_received: u64,
    total_bytes: u64,
    file_index: u32,
    file_count: u32,
}

/// Emitted when all bytes are written and the OS clipboard has been updated
/// (i.e. user can Cmd+V right now).
#[derive(Debug, Clone, Serialize)]
struct ClipboardFileReady {
    session_id: String,
    display_name: String,
    file_count: u32,
    total_bytes: u64,
}

/// Emitted on transfer error/abort.
#[derive(Debug, Clone, Serialize)]
struct ClipboardFileError {
    session_id: String,
    display_name: String,
    error: String,
}

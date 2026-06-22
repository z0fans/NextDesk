//! Clipboard change detection with throttling.
//!
//! Polls OS clipboard `change_count()` at 500ms intervals. When changes are detected,
//! reads available formats and sends `InitiateCopy` to the RDP session.
//!
//! ## Throttling Rules (memory #46 — FormatList rejected → channel dies)
//!
//! 1. **Init cooldown 10s**: No FormatList sent for 10s after connection ready
//! 2. **Min interval 5s**: At least 5s between FormatList sends
//! 3. **Transfer lock**: Skip while file transfer is in progress
//! 4. **Feedback loop prevention**: After remote write, expect changeCount to bump.
//!    Skip the bump that matches `last_remote_write_count + 1`.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use ironrdp::cliprdr::pdu::{ClipboardFormat, ClipboardFormatId};

use super::os::{ClipFormat, OsClipboard};
use super::CliprdrAction;

const POLL_INTERVAL: Duration = Duration::from_millis(500);
const INIT_COOLDOWN: Duration = Duration::from_secs(10);
const MIN_FORMAT_LIST_INTERVAL: Duration = Duration::from_secs(5);

// ── Well-known CLIPRDR format IDs ──
const CF_DIB: u32 = 8;
const CF_UNICODETEXT: u32 = 13;
const CF_DIBV5: u32 = 17;
// Custom IDs for long-name formats (must match backend.rs)
const CF_PRIVATE_HTML: u32 = 0xC001;
const CF_PRIVATE_PNG: u32 = 0xC002;
const CF_PRIVATE_FILE_GROUP: u32 = 0xC003;
const CF_PRIVATE_TEXT_HTML: u32 = 0xC004;
// Long format names (registered)
const FORMAT_NAME_HTML: &str = "HTML Format";
const FORMAT_NAME_PNG: &str = "PNG";
const FORMAT_NAME_FILE_GROUP: &str = "FileGroupDescriptorW";
const FORMAT_NAME_TEXT_HTML: &str = "text/html";

static ACTIVE_CLIPBOARD_SESSION: OnceLock<StdMutex<Option<String>>> = OnceLock::new();

fn active_clipboard_session() -> &'static StdMutex<Option<String>> {
    ACTIVE_CLIPBOARD_SESSION.get_or_init(|| StdMutex::new(None))
}

pub fn set_active_clipboard_session(session_id: Option<String>) {
    if let Ok(mut active) = active_clipboard_session().lock() {
        *active = session_id;
    }
}

fn is_active_clipboard_session(session_id: &str) -> bool {
    active_clipboard_session()
        .lock()
        .map(|active| match active.as_deref() {
            Some(active_session_id) => active_session_id == session_id,
            None => true,
        })
        .unwrap_or(true)
}

/// Watcher for local clipboard changes.
///
/// Spawns a background task that polls `os.change_count()` every 500ms.
/// When changes are detected and throttling rules pass, sends
/// `CliprdrAction::InitiateCopy` to the session.
pub struct ClipboardWatcher {
    inner: Arc<WatcherInner>,
    handle: Option<JoinHandle<()>>,
}

pub(crate) struct WatcherInner {
    session_id: String,
    os: Arc<dyn OsClipboard>,
    action_tx: mpsc::UnboundedSender<CliprdrAction>,
    last_change_count: AtomicU64,
    last_format_list_sent_at: Mutex<Option<Instant>>,
    connected_at: Instant,
    pub(crate) transfer_in_progress: AtomicBool,
    last_remote_write_count: AtomicU64,
    cancel: CancellationToken,
}

impl ClipboardWatcher {
    /// Create a new watcher. Call `start()` to begin polling.
    pub fn new(
        os: Arc<dyn OsClipboard>,
        action_tx: mpsc::UnboundedSender<CliprdrAction>,
        session_id: String,
    ) -> Self {
        let initial_count = os.change_count();
        Self {
            inner: Arc::new(WatcherInner {
                session_id,
                os,
                action_tx,
                last_change_count: AtomicU64::new(initial_count),
                last_format_list_sent_at: Mutex::new(None),
                connected_at: Instant::now(),
                transfer_in_progress: AtomicBool::new(false),
                last_remote_write_count: AtomicU64::new(0),
                cancel: CancellationToken::new(),
            }),
            handle: None,
        }
    }

    /// Start the polling task.
    pub fn start(&mut self) {
        if self.handle.is_some() {
            return;
        }
        log::debug!(
            "[cliprdr-watcher] session={} start() — spawning poll task (init cooldown 10s)",
            self.inner.session_id
        );
        let inner = Arc::clone(&self.inner);
        let handle = tokio::spawn(async move {
            poll_loop(inner).await;
        });
        self.handle = Some(handle);
    }

    /// Force an immediate check (e.g., on window focus/tab switch).
    /// Bypasses the poll interval and initial connection cooldown, while still
    /// respecting transfer locks, feedback-loop suppression, change detection,
    /// and the 5s FormatList throttle.
    pub async fn force_check(&self) {
        check_and_send_with_options(
            &self.inner,
            CheckOptions {
                bypass_init_cooldown: true,
            },
        )
        .await;
    }

    /// Stop the watcher and cancel the polling task.
    pub fn stop(&mut self) {
        self.inner.cancel.cancel();
        if let Some(handle) = self.handle.take() {
            handle.abort();
        }
    }

    /// Notify the watcher that we just wrote to the OS clipboard from a remote action.
    /// This prevents the next change_count bump from triggering a feedback loop.
    pub fn notify_remote_write(&self) {
        // The OS write has ALREADY changed change_count by the time we're called.
        // Record the current count so the next poll sees `current == last_remote`
        // and skips it. Also bump last_change_count to the same value so we don't
        // even reach the feedback check.
        let count = self.inner.os.change_count();
        self.inner
            .last_remote_write_count
            .store(count, Ordering::SeqCst);
        self.inner.last_change_count.store(count, Ordering::SeqCst);
    }

    /// Set the file transfer in-progress state (locks/unlocks the watcher).
    pub fn set_transfer_in_progress(&self, active: bool) {
        self.inner
            .transfer_in_progress
            .store(active, Ordering::SeqCst);
    }

    /// Get a shared reference to the transfer-in-progress flag.
    /// Used by the outgoing transfer watchdog to release the lock
    /// from a spawned async task without holding &self.
    pub fn transfer_in_progress_flag(&self) -> Arc<WatcherInner> {
        Arc::clone(&self.inner)
    }
}

impl Drop for ClipboardWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}

async fn poll_loop(inner: Arc<WatcherInner>) {
    let mut ticker = tokio::time::interval(POLL_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = inner.cancel.cancelled() => {
                log::debug!(
                    "[cliprdr-watcher] session={} cancelled",
                    inner.session_id
                );
                return;
            }
            _ = ticker.tick() => {
                check_and_send(&inner).await;
            }
        }
    }
}

/// Check clipboard and send InitiateCopy if all throttle rules pass.
async fn check_and_send(inner: &Arc<WatcherInner>) {
    check_and_send_with_options(
        inner,
        CheckOptions {
            bypass_init_cooldown: false,
        },
    )
    .await;
}

struct CheckOptions {
    bypass_init_cooldown: bool,
}

/// Check clipboard and send InitiateCopy if all throttle rules pass.
async fn check_and_send_with_options(inner: &Arc<WatcherInner>, options: CheckOptions) {
    if !is_active_clipboard_session(&inner.session_id) {
        return;
    }

    // 1. Skip if file transfer is in progress
    if inner.transfer_in_progress.load(Ordering::SeqCst) {
        return;
    }

    // 2. Init cooldown: skip during the first 10s
    let elapsed = inner.connected_at.elapsed();
    if !options.bypass_init_cooldown && elapsed < INIT_COOLDOWN {
        return;
    }

    // 3. Check if change_count has actually changed
    let current = inner.os.change_count();
    let last = inner.last_change_count.load(Ordering::SeqCst);
    if current == last {
        return;
    }

    // 4. Feedback loop prevention: if this change is from our own remote write, skip
    let last_remote = inner.last_remote_write_count.load(Ordering::SeqCst);
    if last_remote != 0 && current == last_remote {
        // Update last_change_count to ack this change so we don't recheck
        inner.last_change_count.store(current, Ordering::SeqCst);
        // Clear remote write marker — only suppress the immediate next bump
        inner.last_remote_write_count.store(0, Ordering::SeqCst);
        return;
    }

    // 5. Min interval: skip if last FormatList was less than 5s ago
    {
        let last_sent = inner.last_format_list_sent_at.lock().await;
        if let Some(t) = *last_sent {
            if t.elapsed() < MIN_FORMAT_LIST_INTERVAL {
                return;
            }
        }
    }

    // All checks passed — read formats and send InitiateCopy
    let os_formats = inner.os.available_formats();
    if os_formats.is_empty() {
        // Update count anyway so we don't spam this
        inner.last_change_count.store(current, Ordering::SeqCst);
        return;
    }

    let rdp_formats = map_os_formats_to_rdp(&os_formats);
    if rdp_formats.is_empty() {
        inner.last_change_count.store(current, Ordering::SeqCst);
        return;
    }

    // Update tracking state
    inner.last_change_count.store(current, Ordering::SeqCst);
    {
        let mut last_sent = inner.last_format_list_sent_at.lock().await;
        *last_sent = Some(Instant::now());
    }

    log::info!(
        "[cliprdr-watcher] session={} Sending FormatList ({} formats from {:?}) [{}]",
        inner.session_id,
        rdp_formats.len(),
        os_formats,
        describe_clipboard_formats(&rdp_formats)
    );
    log::debug!(
        "[cliprdr-watcher] session={} Sending FormatList ({} formats from {:?}) [{}]",
        inner.session_id,
        rdp_formats.len(),
        os_formats,
        describe_clipboard_formats(&rdp_formats)
    );

    if let Err(e) = inner
        .action_tx
        .send(CliprdrAction::InitiateCopy(rdp_formats))
    {
        log::warn!("[cliprdr-watcher] Failed to send InitiateCopy: {e}");
    }
}

/// Convert OS-level clipboard formats to RDP ClipboardFormat advertisements.
///
/// Format mapping (per spec):
/// - PlainText → CF_UNICODETEXT
/// - Html → CF_HTML + text/html + CF_UNICODETEXT
/// - Png/Tiff/Bitmap → PNG + CF_DIBV5 + CF_DIB
/// - FileList → FileGroupDescriptorW
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
                // CF_HTML (long name)
                push_named_format(&mut formats, CF_PRIVATE_HTML, FORMAT_NAME_HTML);
                // Also text/html for compatibility
                push_named_format(&mut formats, CF_PRIVATE_TEXT_HTML, FORMAT_NAME_TEXT_HTML);
                // Also fall back to plain text if no text yet
                if !has_text {
                    formats.push(ClipboardFormat::new(ClipboardFormatId::new(CF_UNICODETEXT)));
                    has_text = true;
                }
            }
            #[cfg(target_os = "macos")]
            ClipFormat::Tiff => {
                if !has_image {
                    advertise_image_formats(&mut formats);
                    has_image = true;
                }
            }
            ClipFormat::Png => {
                if !has_image {
                    advertise_image_formats(&mut formats);
                    has_image = true;
                }
            }
            #[cfg(target_os = "windows")]
            ClipFormat::Bitmap => {
                if !has_image {
                    advertise_image_formats(&mut formats);
                    has_image = true;
                }
            }
            ClipFormat::FileList => {
                push_named_format(&mut formats, CF_PRIVATE_FILE_GROUP, FORMAT_NAME_FILE_GROUP);
            }
        }
    }

    formats
}

/// Push a registered (long-name) format. The actual ID is assigned by the server.
fn push_named_format(formats: &mut Vec<ClipboardFormat>, id: u32, name: &'static str) {
    formats.push(
        ClipboardFormat::new(ClipboardFormatId::new(id))
            .with_name(ironrdp::cliprdr::pdu::ClipboardFormatName::new(name)),
    );
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

/// Advertise PNG + CF_DIBV5 + CF_DIB for maximum compatibility (memory #58).
fn advertise_image_formats(formats: &mut Vec<ClipboardFormat>) {
    push_named_format(formats, CF_PRIVATE_PNG, FORMAT_NAME_PNG);
    formats.push(ClipboardFormat::new(ClipboardFormatId::new(CF_DIBV5)));
    formats.push(ClipboardFormat::new(ClipboardFormatId::new(CF_DIB)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    static ACTIVE_SESSION_TEST_LOCK: StdMutex<()> = StdMutex::new(());

    /// Mock OsClipboard for testing.
    struct MockClipboard {
        change_count: AtomicU64,
        formats: StdMutex<Vec<ClipFormat>>,
    }

    impl MockClipboard {
        fn new() -> Self {
            Self {
                change_count: AtomicU64::new(0),
                formats: StdMutex::new(Vec::new()),
            }
        }

        fn bump(&self, formats: Vec<ClipFormat>) {
            self.change_count.fetch_add(1, Ordering::SeqCst);
            *self.formats.lock().unwrap() = formats;
        }
    }

    impl OsClipboard for MockClipboard {
        fn change_count(&self) -> u64 {
            self.change_count.load(Ordering::SeqCst)
        }

        fn available_formats(&self) -> Vec<ClipFormat> {
            self.formats.lock().unwrap().clone()
        }

        fn read(&self, _format: ClipFormat) -> super::super::os::ClipResult<Vec<u8>> {
            Ok(Vec::new())
        }

        fn read_files(&self) -> super::super::os::ClipResult<Vec<std::path::PathBuf>> {
            Ok(Vec::new())
        }

        fn write_multi(
            &self,
            _items: &[(ClipFormat, Vec<u8>)],
        ) -> super::super::os::ClipResult<()> {
            Ok(())
        }

        fn write_files(&self, _paths: &[std::path::PathBuf]) -> super::super::os::ClipResult<()> {
            Ok(())
        }
    }

    #[test]
    fn test_map_text_format() {
        let formats = map_os_formats_to_rdp(&[ClipFormat::PlainText]);
        assert_eq!(formats.len(), 1);
        assert_eq!(formats[0].id().value(), CF_UNICODETEXT);
    }

    #[test]
    fn test_map_html_format() {
        let formats = map_os_formats_to_rdp(&[ClipFormat::Html]);
        // HTML advertises CF_HTML + text/html + CF_UNICODETEXT
        assert_eq!(formats.len(), 3);
    }

    #[test]
    fn test_map_image_format() {
        let formats = map_os_formats_to_rdp(&[ClipFormat::Png]);
        // Image advertises PNG + CF_DIBV5 + CF_DIB
        assert_eq!(formats.len(), 3);
    }

    #[test]
    fn test_map_file_list() {
        let formats = map_os_formats_to_rdp(&[ClipFormat::FileList]);
        assert_eq!(formats.len(), 1);
        // FileGroupDescriptorW uses our private ID with the long name attached
        assert_eq!(formats[0].id().value(), CF_PRIVATE_FILE_GROUP);
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn test_init_cooldown_blocks_send() {
        let _active_session_guard = ACTIVE_SESSION_TEST_LOCK.lock().unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mock = Arc::new(MockClipboard::new());
        mock.bump(vec![ClipFormat::PlainText]);

        set_active_clipboard_session(None);
        let watcher = ClipboardWatcher::new(mock.clone(), tx, "test-session".to_string());

        // Reset last_change_count so the bump is detected
        watcher.inner.last_change_count.store(0, Ordering::SeqCst);

        // Within cooldown — should NOT send
        check_and_send(&watcher.inner).await;
        assert!(
            rx.try_recv().is_err(),
            "Should not send during init cooldown"
        );

        // Advance past cooldown
        tokio::time::advance(INIT_COOLDOWN + Duration::from_millis(100)).await;

        // Now should send
        check_and_send(&watcher.inner).await;
        let action = rx.try_recv().expect("Should send after cooldown");
        match action {
            CliprdrAction::InitiateCopy(_) => {}
            _ => panic!("Expected InitiateCopy"),
        }
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn test_min_interval_throttle() {
        let _active_session_guard = ACTIVE_SESSION_TEST_LOCK.lock().unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mock = Arc::new(MockClipboard::new());
        mock.bump(vec![ClipFormat::PlainText]);

        set_active_clipboard_session(None);
        let watcher = ClipboardWatcher::new(mock.clone(), tx, "test-session".to_string());
        watcher.inner.last_change_count.store(0, Ordering::SeqCst);

        // Skip cooldown
        tokio::time::advance(INIT_COOLDOWN + Duration::from_secs(1)).await;

        // First send: should succeed
        check_and_send(&watcher.inner).await;
        assert!(matches!(rx.try_recv(), Ok(CliprdrAction::InitiateCopy(_))));

        // Second clipboard change immediately
        mock.bump(vec![ClipFormat::PlainText]);

        // Within min interval — should NOT send
        check_and_send(&watcher.inner).await;
        assert!(
            rx.try_recv().is_err(),
            "Should throttle within min interval"
        );

        // Advance past min interval
        tokio::time::advance(MIN_FORMAT_LIST_INTERVAL + Duration::from_millis(100)).await;

        // Now should send again
        mock.bump(vec![ClipFormat::PlainText]);
        check_and_send(&watcher.inner).await;
        assert!(matches!(rx.try_recv(), Ok(CliprdrAction::InitiateCopy(_))));
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn test_transfer_lock_blocks_send() {
        let _active_session_guard = ACTIVE_SESSION_TEST_LOCK.lock().unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mock = Arc::new(MockClipboard::new());
        mock.bump(vec![ClipFormat::PlainText]);

        set_active_clipboard_session(None);
        let watcher = ClipboardWatcher::new(mock.clone(), tx, "test-session".to_string());
        watcher.inner.last_change_count.store(0, Ordering::SeqCst);

        tokio::time::advance(INIT_COOLDOWN + Duration::from_secs(1)).await;

        // Activate transfer lock
        watcher.set_transfer_in_progress(true);

        check_and_send(&watcher.inner).await;
        assert!(
            rx.try_recv().is_err(),
            "Should not send while transfer in progress"
        );

        // Release lock
        watcher.set_transfer_in_progress(false);
        check_and_send(&watcher.inner).await;
        assert!(matches!(rx.try_recv(), Ok(CliprdrAction::InitiateCopy(_))));
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn test_feedback_loop_prevention() {
        let _active_session_guard = ACTIVE_SESSION_TEST_LOCK.lock().unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mock = Arc::new(MockClipboard::new());

        set_active_clipboard_session(None);
        let watcher = ClipboardWatcher::new(mock.clone(), tx, "test-session".to_string());
        tokio::time::advance(INIT_COOLDOWN + Duration::from_secs(1)).await;

        // Simulate remote write: bump first (OS clipboard now changed), then notify
        // (this matches real call order: os.write_files() → notify_remote_write())
        mock.bump(vec![ClipFormat::PlainText]);
        watcher.notify_remote_write();

        // The bump just caused should be skipped (last_change_count == current)
        check_and_send(&watcher.inner).await;
        assert!(
            rx.try_recv().is_err(),
            "Should suppress feedback loop after remote write"
        );

        // A subsequent independent change (different bump from user's local copy) should trigger
        mock.bump(vec![ClipFormat::PlainText]);
        check_and_send(&watcher.inner).await;
        assert!(matches!(rx.try_recv(), Ok(CliprdrAction::InitiateCopy(_))));
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn test_force_check_bypasses_init_cooldown_but_respects_throttle() {
        let _active_session_guard = ACTIVE_SESSION_TEST_LOCK.lock().unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mock = Arc::new(MockClipboard::new());
        mock.bump(vec![ClipFormat::PlainText]);

        set_active_clipboard_session(None);
        let watcher = ClipboardWatcher::new(mock.clone(), tx, "test-session".to_string());
        watcher.inner.last_change_count.store(0, Ordering::SeqCst);

        // Explicit focus/tab-switch checks should bypass the initial poll
        // cooldown so copy/paste between two active sessions is available
        // immediately after switching tabs.
        watcher.force_check().await;
        assert!(matches!(rx.try_recv(), Ok(CliprdrAction::InitiateCopy(_))));

        mock.bump(vec![ClipFormat::PlainText]);
        watcher.force_check().await;
        assert!(
            rx.try_recv().is_err(),
            "force_check should still preserve the 5s FormatList throttle"
        );
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn test_inactive_session_does_not_send_clipboard_formats() {
        let _active_session_guard = ACTIVE_SESSION_TEST_LOCK.lock().unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mock = Arc::new(MockClipboard::new());
        mock.bump(vec![ClipFormat::PlainText]);

        set_active_clipboard_session(Some("active-session".to_string()));
        let watcher = ClipboardWatcher::new(mock.clone(), tx, "inactive-session".to_string());
        watcher.inner.last_change_count.store(0, Ordering::SeqCst);
        tokio::time::advance(INIT_COOLDOWN + Duration::from_secs(1)).await;

        check_and_send(&watcher.inner).await;
        assert!(
            rx.try_recv().is_err(),
            "inactive RDP sessions must not advertise the shared macOS clipboard"
        );

        set_active_clipboard_session(None);
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn test_active_session_sends_clipboard_formats() {
        let _active_session_guard = ACTIVE_SESSION_TEST_LOCK.lock().unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mock = Arc::new(MockClipboard::new());
        mock.bump(vec![ClipFormat::PlainText]);

        set_active_clipboard_session(Some("active-session".to_string()));
        let watcher = ClipboardWatcher::new(mock.clone(), tx, "active-session".to_string());
        watcher.inner.last_change_count.store(0, Ordering::SeqCst);
        tokio::time::advance(INIT_COOLDOWN + Duration::from_secs(1)).await;

        check_and_send(&watcher.inner).await;
        assert!(matches!(rx.try_recv(), Ok(CliprdrAction::InitiateCopy(_))));

        set_active_clipboard_session(None);
    }
}

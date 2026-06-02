# CLIPRDR Cross-Platform Clipboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement full bidirectional clipboard (text/HTML/image/file) for native RDP mode on macOS + Windows, replacing the current text-only cliprdr_backend.rs.

**Architecture:** Modular `src-tauri/src/cliprdr/` directory with `trait OsClipboard` for cross-platform abstraction, `ClipboardWatcher` for change detection with throttling, `formats.rs` for codec conversions, and `FileTransferManager` for async file downloads with progress events.

**Tech Stack:** Rust, Tauri 2, IronRDP (cliprdr + cliprdr_format), objc2-app-kit (macOS), windows crate (Windows), tokio, thiserror

**Spec:** `docs/superpowers/specs/2026-05-16-cliprdr-cross-platform-design.md`

**Key constraints:**
- FormatList throttle: ≥5s interval, 10s init cooldown (server enters Failed state if spammed)
- macOS: no native clipboard notification API, must poll NSPasteboard.changeCount every 500ms
- macOS Finder paste: file must exist on disk before writing URL to pasteboard
- Image formats: advertise PNG + CF_DIBV5 + CF_DIB simultaneously
- File transfer timeout: 10s per chunk, 3 consecutive timeouts = cancel entire transfer

---

## File Structure

```
src-tauri/src/cliprdr/          (NEW directory)
├── mod.rs                      — Public API, build_factory(), re-exports
├── backend.rs                  — NextDeskCliprdrFactory + impl CliprdrBackend
├── watcher.rs                  — ClipboardWatcher (poll + focus + throttle)
├── formats.rs                  — Format conversions (pure functions)
├── file_transfer.rs            — FileTransferManager (async download + progress)
└── os/
    ├── mod.rs                  — trait OsClipboard + create_os_clipboard()
    ├── macos.rs                — macOS NSPasteboard implementation
    └── windows.rs              — Windows Win32 Clipboard implementation

src-tauri/src/cliprdr_backend.rs  — REMOVE (replaced by cliprdr/)
src-tauri/src/rdp_session.rs      — MODIFY (use cliprdr::build_factory)
src-tauri/src/lib.rs              — MODIFY (mod cliprdr, remove mod cliprdr_backend)
src-tauri/Cargo.toml              — MODIFY (add windows features)
```

## Task Dependency Graph

- Tasks 1-2: Independent (scaffold + formats)
- Tasks 3-4: Independent (mac vs win OS impl)
- Task 5: Depends on Task 1 (uses trait)
- Task 6: Depends on Tasks 2+5 (uses formats + watcher)
- Task 7: Depends on Task 1 (uses trait for write_files)
- Task 8: Depends on all previous tasks

---

## Task 1: Scaffold cliprdr/ module + trait OsClipboard

**Files:**
- Create: `src-tauri/src/cliprdr/mod.rs`
- Create: `src-tauri/src/cliprdr/os/mod.rs`
- Create: `src-tauri/src/cliprdr/os/macos.rs` (stub)
- Create: `src-tauri/src/cliprdr/os/windows.rs` (stub)
- Create: `src-tauri/src/cliprdr/formats.rs` (empty placeholder)
- Create: `src-tauri/src/cliprdr/watcher.rs` (empty placeholder)
- Create: `src-tauri/src/cliprdr/backend.rs` (empty placeholder)
- Create: `src-tauri/src/cliprdr/file_transfer.rs` (empty placeholder)
- Modify: `src-tauri/src/lib.rs` (add `mod cliprdr;`)

- [ ] Create directory `src-tauri/src/cliprdr/os/`
- [ ] Write `cliprdr/os/mod.rs` with `ClipFormat` enum, `ClipError`, `ClipResult`, `trait OsClipboard`, `create_os_clipboard()` factory
- [ ] Write `cliprdr/os/macos.rs` stub (all methods `todo!("Task 3")`)
- [ ] Write `cliprdr/os/windows.rs` stub (all methods `todo!("Task 4")`)
- [ ] Write `cliprdr/mod.rs` with `pub mod os/formats/watcher/backend/file_transfer` + `build_factory()` stub
- [ ] Write empty placeholder files for formats/watcher/backend/file_transfer
- [ ] Add `mod cliprdr;` to `lib.rs`
- [ ] Run `cargo check -p nextdesk` — should compile with warnings
- [ ] Commit: `feat(cliprdr): scaffold cross-platform clipboard module with trait OsClipboard`

---

## Task 2: formats.rs — codec conversions

**Files:**
- Modify: `src-tauri/src/cliprdr/formats.rs`

- [ ] Implement `text_to_utf16le(text: &str) -> Vec<u8>` (UTF-8 → UTF-16LE + null terminator)
- [ ] Implement `utf16le_to_text(data: &[u8]) -> Option<String>` (UTF-16LE → UTF-8, strip null)
- [ ] Implement `html_to_cf_html(html: &str) -> Vec<u8>` (calls `ironrdp_cliprdr_format::html::plain_html_to_cf_html`)
- [ ] Implement `cf_html_to_html(data: &[u8]) -> Option<String>` (calls `ironrdp_cliprdr_format::html::cf_html_to_plain_html`)
- [ ] Implement `png_to_dibv5(png: &[u8]) -> Result<Vec<u8>, String>` (calls `ironrdp_cliprdr_format::bitmap::png_to_cf_dibv5`)
- [ ] Implement `dibv5_to_png(data: &[u8]) -> Result<Vec<u8>, String>` (calls `ironrdp_cliprdr_format::bitmap::dibv5_to_png`)
- [ ] Implement `dib_to_png(data: &[u8]) -> Result<Vec<u8>, String>` (calls `ironrdp_cliprdr_format::bitmap::dib_to_png`)
- [ ] Write unit tests: text round-trip, HTML round-trip, image round-trip (use small test vectors)
- [ ] Run `cargo test -p nextdesk -- cliprdr::formats` — all pass
- [ ] Commit: `feat(cliprdr): implement format conversions (text/html/image codecs)`

---

## Task 3: os/macos.rs — full NSPasteboard implementation

**Files:**
- Modify: `src-tauri/src/cliprdr/os/macos.rs`

- [ ] Implement `change_count()` via `unsafe { NSPasteboard::generalPasteboard().changeCount() as u64 }`
- [ ] Implement `available_formats()` — check pasteboard `types()` for known UTIs (public.utf8-plain-text, public.html, public.png, public.tiff, public.file-url)
- [ ] Implement `read(PlainText)` — `stringForType:` → UTF-8 bytes
- [ ] Implement `read(Html)` — `dataForType:public.html`
- [ ] Implement `read(Png)` — `dataForType:NSPasteboardTypePNG`, fallback TIFF→PNG
- [ ] Implement `read_files()` — read file URLs from pasteboard → resolve to PathBuf
- [ ] Implement `write_multi()` — `clearContents()` + loop `setData:forType:` (atomic)
- [ ] Implement `write_files()` — `declareTypes` + `setPropertyList` with file URL array (reference `virtual_file_clipboard.rs` pattern)
- [ ] Run `cargo check -p nextdesk` — compiles
- [ ] Commit: `feat(cliprdr): implement macOS NSPasteboard clipboard backend`

---

## Task 4: os/windows.rs — full Win32 Clipboard implementation

**Files:**
- Modify: `src-tauri/src/cliprdr/os/windows.rs`
- Modify: `src-tauri/Cargo.toml` (add windows features)

- [ ] Add to Cargo.toml `windows` features: `"Win32_System_DataExchange"`, `"Win32_System_Memory"`, `"Win32_UI_Shell_Common"`
- [ ] Implement `change_count()` via `GetClipboardSequenceNumber()`
- [ ] Implement `available_formats()` — `EnumClipboardFormats` loop
- [ ] Implement `read(PlainText)` — `GetClipboardData(CF_UNICODETEXT)` → GlobalLock → UTF-16→UTF-8
- [ ] Implement `read(Html)` — `RegisterClipboardFormatW("HTML Format")` → GetClipboardData → CF_HTML bytes
- [ ] Implement `read(Bitmap)` — `GetClipboardData(CF_DIBV5)` fallback `CF_DIB`
- [ ] Implement `read_files()` — `GetClipboardData(CF_HDROP)` + `DragQueryFileW` loop
- [ ] Implement `write_multi()` — `OpenClipboard` + `EmptyClipboard` + `GlobalAlloc/Lock/Unlock` + `SetClipboardData` × N + `CloseClipboard`
- [ ] Implement `write_files()` — construct DROPFILES struct + `SetClipboardData(CF_HDROP)`
- [ ] Run `cargo check -p nextdesk` (mac: windows code behind cfg, syntax only)
- [ ] Commit: `feat(cliprdr): implement Windows Win32 clipboard backend`

---

## Task 5: watcher.rs — ClipboardWatcher with throttling

**Files:**
- Modify: `src-tauri/src/cliprdr/watcher.rs`

- [ ] Define `ClipboardWatcher` struct with fields: `os`, `action_tx`, `last_change_count`, `last_format_list_sent_at`, `connected_at`, `transfer_in_progress`, `last_remote_write_count`, `cancel_token`
- [ ] Implement `start()` — spawn tokio task with 500ms interval, each tick: check change_count → apply 3-layer throttle → if pass: read formats → send InitiateCopy
- [ ] Implement `force_check()` — bypass poll interval, run check immediately
- [ ] Implement `stop()` — set cancel token
- [ ] Implement `notify_remote_write(count: u64)` — update last_remote_write_count for feedback loop prevention
- [ ] Implement `set_transfer_in_progress(active: bool)` — lock/unlock
- [ ] Implement format mapping: `ClipFormat` → `Vec<ironrdp::cliprdr::pdu::ClipboardFormat>` (text→CF_UNICODETEXT, html→CF_HTML+text/html+CF_UNICODETEXT, png→PNG+CF_DIBV5+CF_DIB, files→FileGroupDescriptorW)
- [ ] Write unit tests with mock OsClipboard: test init cooldown, min interval, transfer lock, feedback loop, force_check
- [ ] Run `cargo test -p nextdesk -- cliprdr::watcher` — all pass
- [ ] Commit: `feat(cliprdr): implement ClipboardWatcher with throttling and feedback loop prevention`

---

## Task 6: backend.rs — IronRDP CliprdrBackend implementation

**Files:**
- Modify: `src-tauri/src/cliprdr/backend.rs`

- [ ] Define `NextDeskCliprdrFactory` (holds `action_tx`, `app_handle`, `temp_dir`)
- [ ] Implement `CliprdrBackendFactory` for `NextDeskCliprdrFactory`
- [ ] Define `NextDeskCliprdrBackend` (holds `os`, `watcher`, `file_transfer_mgr`, `action_tx`, `app_handle`, `remote_formats`)
- [ ] Implement `on_ready()` — start watcher
- [ ] Implement `on_remote_copy(formats)` — select best format by priority (FileList > PNG > DIBV5 > DIB > HTML > text) → `InitiatePaste`
- [ ] Implement `on_format_data_request(request)` — read from `os` → convert via `formats.rs` → `SubmitFormatData`
- [ ] Implement `on_format_data_response(response)` — convert → `os.write_multi()` → `watcher.notify_remote_write()`
- [ ] Implement `on_request_format_list()` — read `os.available_formats()` → map → `InitiateCopy`
- [ ] Implement `on_file_contents_request(request)` — read local file chunk → `SubmitFileContents`
- [ ] Implement `on_file_contents_response(response)` — forward to FileTransferManager
- [ ] Run `cargo check -p nextdesk` — compiles
- [ ] Commit: `feat(cliprdr): implement IronRDP CliprdrBackend with full format support`

---

## Task 7: file_transfer.rs — FileTransferManager

**Files:**
- Modify: `src-tauri/src/cliprdr/file_transfer.rs`

- [ ] Define `TransferConfig` struct (max_file_size: 2GB, chunk_timeout: 10s, max_consecutive_timeouts: 3, chunk_size: 256KB)
- [ ] Define `FileTransferManager` struct (session_id, stage_dir, action_tx, app_handle, config, cancel: AtomicBool)
- [ ] Implement `staging_dir()` — platform-specific cache path (`~/Library/Caches/NextDesk/clipboard/<session>/` on mac, `%LOCALAPPDATA%\NextDesk\clipboard\<session>\` on win)
- [ ] Implement `start_transfer(descriptors)` — spawn async task: create stage_dir, for each file download all chunks with timeout, emit progress events, on completion write_files to pasteboard
- [ ] Implement per-chunk timeout logic: `tokio::time::timeout(10s)`, consecutive failure counter, cancel on 3
- [ ] Implement progress events: emit `clipboard-file-progress` every 1MB or 10 chunks
- [ ] Implement completion: `os.write_files(staged_paths)` + emit `clipboard-file-ready`
- [ ] Implement failure: cleanup stage_dir + emit `clipboard-file-error`
- [ ] Implement `cancel()` — set AtomicBool
- [ ] Implement `cleanup_session()` — remove stage_dir
- [ ] Run `cargo check -p nextdesk` — compiles
- [ ] Commit: `feat(cliprdr): implement FileTransferManager with timeout and progress events`

---

## Task 8: Integration — wire into rdp_session.rs + cleanup

**Files:**
- Modify: `src-tauri/src/rdp_session.rs`
- Modify: `src-tauri/src/lib.rs`
- Remove: `src-tauri/src/cliprdr_backend.rs`

- [ ] In `rdp_session.rs`: replace `use crate::cliprdr_backend::NextDeskCliprdrFactory` with `use crate::cliprdr`
- [ ] Replace factory creation: `cliprdr::build_factory(cliprdr_tx.clone(), app_handle.clone(), temp_dir.clone())`
- [ ] In `lib.rs`: remove `mod cliprdr_backend;` line
- [ ] Delete `src-tauri/src/cliprdr_backend.rs`
- [ ] Add Tauri window focus listener → emit event that watcher can pick up for `force_check()`
- [ ] Run `cargo check -p nextdesk` — compiles clean
- [ ] Run `cargo test -p nextdesk` — all tests pass
- [ ] Manual test: `npx tauri dev` → connect RDP → copy text both directions
- [ ] Commit: `feat(cliprdr): integrate new clipboard module, remove legacy cliprdr_backend`

---

## Post-Implementation Testing Checklist

After all tasks complete, run through these scenarios:

1. ✅ Mac copy text → Win Notepad paste
2. ✅ Win copy text → Mac TextEdit paste
3. ✅ Mac screenshot (Cmd+Shift+4) → Win Paint paste
4. ✅ Win screenshot (PrtSc) → Mac Preview paste
5. ✅ Mac copy HTML (from Safari) → Win Word paste (should preserve formatting)
6. ✅ Win copy HTML (from Edge) → Mac TextEdit paste
7. ✅ Mac Finder copy file → Win Explorer paste
8. ✅ Win Explorer copy file (100MB) → Mac Finder paste (verify progress + toast)
9. ✅ Win copy large file → disconnect mid-transfer → verify cleanup + error toast
10. ✅ Rapid copy (5x in 3 seconds) → verify throttle prevents FormatList spam

//! Dedicated WebSocket server for CLIPRDR large file transfer.
//!
//! WASM pushes file data directly to this server, bypassing the slow
//! JS callback chain. Protocol uses binary messages:
//!
//! ```text
//! cmd=0x01 FILE_BEGIN:      [1B cmd][2B name_len LE][N name_utf8][8B file_size LE][32B session_id]
//! cmd=0x02 FILE_CHUNK:      [1B cmd][32B session_id][4B chunk_len LE][N data]
//! cmd=0x03 FILE_COMPLETE:   [1B cmd][32B session_id][1B file_index][1B total_files]
//! cmd=0x04 TRANSFER_DONE:   [1B cmd][32B session_id]
//! ```

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

use crate::virtual_file_clipboard::{
    create_unique_file_in_dir, session_stage_root, valid_file_name,
};

// ── Protocol command bytes ──

const CMD_FILE_BEGIN: u8 = 0x01;
const CMD_FILE_CHUNK: u8 = 0x02;
const CMD_FILE_COMPLETE: u8 = 0x03;
const CMD_TRANSFER_DONE: u8 = 0x04;

const SESSION_ID_LEN: usize = 32;

/// Progress logging interval (10 MB).
const PROGRESS_LOG_INTERVAL: u64 = 10 * 1024 * 1024;

// ── Per-session transfer state ──

struct FileState {
    file: std::fs::File,
    path: PathBuf,
    name: String,
    size: u64,
    written: u64,
    last_logged: u64,
}

struct TransferState {
    stage_dir: PathBuf,
    current_file: Option<FileState>,
    completed_paths: Vec<String>,
    committed: bool,
}

impl TransferState {
    fn new(root: PathBuf) -> std::io::Result<Self> {
        std::fs::create_dir_all(&root)?;
        let stage_dir = root.join(format!("{:016x}", rand::random::<u64>()));
        std::fs::create_dir(&stage_dir)?;
        Ok(Self {
            stage_dir,
            current_file: None,
            completed_paths: Vec::new(),
            committed: false,
        })
    }

    fn commit(mut self) -> Vec<String> {
        self.committed = true;
        std::mem::take(&mut self.completed_paths)
    }
}

impl Drop for TransferState {
    fn drop(&mut self) {
        // Close the file before deleting its directory, including on Windows.
        self.current_file.take();
        if !self.committed {
            if let Err(error) = std::fs::remove_dir_all(&self.stage_dir) {
                log::warn!("[file_transfer_ws] Failed to remove uncommitted staging: {error}");
            }
        }
    }
}

// ── JSON response types ──

#[derive(Serialize)]
struct AckResponse {
    r#type: &'static str,
    session_id: String,
}

#[derive(Serialize)]
struct ErrorResponse {
    r#type: &'static str,
    session_id: String,
    message: String,
}

#[derive(Serialize)]
struct CommittedResponse {
    r#type: &'static str,
    session_id: String,
    paths: Vec<String>,
}

// ── Tauri event payload ──

#[derive(Clone, Serialize)]
struct FileTransferCommitted {
    session_id: String,
    paths: Vec<String>,
}

// ── Connection-owned state: WASM clients reuse the same protocol session ID ──

type Sessions = HashMap<String, TransferState>;

/// Start the file transfer WebSocket server on a random loopback port.
/// Returns the bound port number.
pub async fn start_file_transfer_server(app: AppHandle) -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();

    log::info!("[file_transfer_ws] File transfer WebSocket on 127.0.0.1:{port}");

    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, peer)) => {
                    log::info!("[file_transfer_ws] Client connected: {peer}");
                    let app = app.clone();
                    tokio::spawn(handle_client(stream, app));
                }
                Err(e) => {
                    log::error!("[file_transfer_ws] Accept error: {e}");
                }
            }
        }
    });

    Ok(port)
}

/// Handle a single WebSocket client connection.
async fn handle_client(stream: tokio::net::TcpStream, app: AppHandle) {
    let ws = match tokio_tungstenite::accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            log::error!("[file_transfer_ws] WS handshake failed: {e}");
            return;
        }
    };

    let (mut ws_tx, mut ws_rx) = ws.split();
    let mut sessions = Sessions::new();

    while let Some(msg) = ws_rx.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(e) => {
                log::error!("[file_transfer_ws] Read error: {e}");
                break;
            }
        };

        match msg {
            Message::Binary(data) => {
                if let Some(response) = handle_binary_message(&data, &mut sessions, &app) {
                    if ws_tx.send(Message::Text(response.into())).await.is_err() {
                        break;
                    }
                }
            }
            Message::Close(_) => break,
            _ => {} // Ignore text/ping/pong
        }
    }

    log::info!("[file_transfer_ws] Client disconnected");
}

/// Process a binary protocol message. Returns an optional JSON text response.
fn handle_binary_message(data: &[u8], sessions: &mut Sessions, app: &AppHandle) -> Option<String> {
    if data.is_empty() {
        return None;
    }

    let cmd = data[0];
    match cmd {
        CMD_FILE_BEGIN => handle_file_begin(&data[1..], sessions),
        CMD_FILE_CHUNK => handle_file_chunk(&data[1..], sessions),
        CMD_FILE_COMPLETE => handle_file_complete(&data[1..], sessions),
        CMD_TRANSFER_DONE => handle_transfer_done(&data[1..], sessions, app),
        _ => {
            log::warn!("[file_transfer_ws] Unknown command: 0x{cmd:02x}");
            None
        }
    }
}

/// Parse session_id from a 32-byte zero-padded UTF-8 field.
fn parse_session_id(buf: &[u8]) -> String {
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).to_string()
}

fn transfer_error(sessions: &mut Sessions, session_id: &str, message: &str) -> Option<String> {
    sessions.remove(session_id);
    Some(
        serde_json::to_string(&ErrorResponse {
            r#type: "error",
            session_id: session_id.to_string(),
            message: message.to_string(),
        })
        .unwrap_or_default(),
    )
}

/// FILE_BEGIN: [2B name_len LE][N name_utf8][8B file_size LE][32B session_id]
fn handle_file_begin(payload: &[u8], sessions: &mut Sessions) -> Option<String> {
    if payload.len() < 2 {
        return None;
    }

    let name_len = u16::from_le_bytes([payload[0], payload[1]]) as usize;
    let min_len = 2 + name_len + 8 + SESSION_ID_LEN;
    if payload.len() < min_len {
        log::error!("[file_transfer_ws] FILE_BEGIN too short");
        return None;
    }

    let file_size = u64::from_le_bytes(payload[2 + name_len..2 + name_len + 8].try_into().unwrap());
    let session_id = parse_session_id(&payload[2 + name_len + 8..min_len]);
    let name = match std::str::from_utf8(&payload[2..2 + name_len]) {
        Ok(name) if valid_file_name(name) => name.to_string(),
        _ => return transfer_error(sessions, &session_id, "Invalid file name"),
    };

    let state = match sessions.entry(session_id.clone()) {
        std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
        std::collections::hash_map::Entry::Vacant(entry) => {
            // Protocol session IDs are routing metadata, never filesystem paths.
            match TransferState::new(session_stage_root(None)) {
                Ok(state) => entry.insert(state),
                Err(error) => {
                    log::error!("[file_transfer_ws] Failed to create staging directory: {error}");
                    return transfer_error(
                        sessions,
                        &session_id,
                        "Failed to create staging directory",
                    );
                }
            }
        }
    };
    if state.current_file.is_some() {
        return transfer_error(sessions, &session_id, "Previous file is incomplete");
    }

    match create_unique_file_in_dir(&state.stage_dir, &name) {
        Ok((file_path, file)) => {
            state.current_file = Some(FileState {
                file,
                path: file_path,
                name,
                size: file_size,
                written: 0,
                last_logged: 0,
            });
        }
        Err(error) => {
            log::error!("[file_transfer_ws] Failed to create file: {error}");
            return transfer_error(sessions, &session_id, "Failed to create file");
        }
    }

    Some(
        serde_json::to_string(&AckResponse {
            r#type: "ack",
            session_id,
        })
        .unwrap_or_default(),
    )
}

/// FILE_CHUNK: [32B session_id][4B chunk_len LE][N data]
fn handle_file_chunk(payload: &[u8], sessions: &mut Sessions) -> Option<String> {
    if payload.len() < SESSION_ID_LEN + 4 {
        log::error!("[file_transfer_ws] FILE_CHUNK too short");
        return None;
    }

    let session_id = parse_session_id(&payload[..SESSION_ID_LEN]);
    let chunk_len = u32::from_le_bytes(
        payload[SESSION_ID_LEN..SESSION_ID_LEN + 4]
            .try_into()
            .unwrap(),
    ) as usize;
    let data_start = SESSION_ID_LEN + 4;
    if chunk_len != payload.len() - data_start {
        return transfer_error(sessions, &session_id, "Invalid chunk length");
    }
    let Some(file) = sessions
        .get_mut(&session_id)
        .and_then(|state| state.current_file.as_mut())
    else {
        return transfer_error(sessions, &session_id, "No file is open");
    };
    if chunk_len as u64 > file.size.saturating_sub(file.written) {
        return transfer_error(sessions, &session_id, "Chunk exceeds declared file size");
    }
    if let Err(error) = file.file.write_all(&payload[data_start..]) {
        log::error!("[file_transfer_ws] Write error: {error}");
        return transfer_error(sessions, &session_id, "Failed to write file");
    }
    file.written += chunk_len as u64;
    if file.written / PROGRESS_LOG_INTERVAL > file.last_logged / PROGRESS_LOG_INTERVAL {
        file.last_logged = file.written;
        log::info!(
            "[file_transfer_ws] Progress: {} — {:.1} MB / {:.1} MB",
            file.name,
            file.written as f64 / (1024.0 * 1024.0),
            file.size as f64 / (1024.0 * 1024.0),
        );
    }
    None // No response for successful chunks (performance).
}

/// FILE_COMPLETE: [32B session_id][1B file_index][1B total_files]
fn handle_file_complete(payload: &[u8], sessions: &mut Sessions) -> Option<String> {
    if payload.len() < SESSION_ID_LEN + 2 {
        log::error!("[file_transfer_ws] FILE_COMPLETE too short");
        return None;
    }

    let session_id = parse_session_id(&payload[..SESSION_ID_LEN]);
    let Some(state) = sessions.get_mut(&session_id) else {
        return transfer_error(sessions, &session_id, "No transfer is open");
    };
    let Some(mut file) = state.current_file.take() else {
        return transfer_error(sessions, &session_id, "No file is open");
    };
    if file.written != file.size || file.file.flush().is_err() {
        drop(file);
        return transfer_error(
            sessions,
            &session_id,
            "File is incomplete or could not be flushed",
        );
    }
    state
        .completed_paths
        .push(file.path.to_string_lossy().to_string());
    log::info!(
        "[file_transfer_ws] FILE_COMPLETE file={} ({}/{}) size={:.1} MB",
        file.name,
        u16::from(payload[SESSION_ID_LEN]) + 1,
        payload[SESSION_ID_LEN + 1],
        file.written as f64 / (1024.0 * 1024.0),
    );

    Some(
        serde_json::to_string(&AckResponse {
            r#type: "ack",
            session_id,
        })
        .unwrap_or_default(),
    )
}

/// TRANSFER_DONE: [32B session_id]
fn handle_transfer_done(
    payload: &[u8],
    sessions: &mut Sessions,
    app: &AppHandle,
) -> Option<String> {
    if payload.len() < SESSION_ID_LEN {
        log::error!("[file_transfer_ws] TRANSFER_DONE too short");
        return None;
    }

    let session_id = parse_session_id(&payload[..SESSION_ID_LEN]);

    let Some(state) = sessions.remove(&session_id) else {
        return transfer_error(sessions, &session_id, "No transfer is open");
    };
    if state.current_file.is_some() || state.completed_paths.is_empty() {
        return transfer_error(sessions, &session_id, "Transfer is incomplete");
    }
    let paths = &state.completed_paths;

    log::info!(
        "[file_transfer_ws] TRANSFER_DONE session={session_id} files={}",
        paths.len()
    );

    // Write to macOS pasteboard
    #[cfg(target_os = "macos")]
    {
        use crate::virtual_file_clipboard::write_file_urls_to_macos_pasteboard;
        if let Err(e) = write_file_urls_to_macos_pasteboard(&paths) {
            log::error!("[file_transfer_ws] Pasteboard write failed: {e}");
            return Some(
                serde_json::to_string(&ErrorResponse {
                    r#type: "error",
                    session_id,
                    message: format!("Pasteboard write failed: {e}"),
                })
                .unwrap_or_default(),
            );
        }
    }

    let paths = state.commit();

    // Emit Tauri event
    let event_payload = FileTransferCommitted {
        session_id: session_id.clone(),
        paths: paths.clone(),
    };
    if let Err(e) = app.emit("file-transfer://committed", &event_payload) {
        log::error!("[file_transfer_ws] Failed to emit event: {e}");
    }

    Some(
        serde_json::to_string(&CommittedResponse {
            r#type: "committed",
            session_id,
            paths,
        })
        .unwrap_or_default(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "00000000000000000000wasm-cliprdr";

    struct Fixture {
        root: PathBuf,
        sessions: Sessions,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "nextdesk-transfer-test-{:016x}",
                rand::random::<u64>()
            ));
            let mut sessions = Sessions::new();
            sessions.insert(ID.to_string(), TransferState::new(root.clone()).unwrap());
            Self { root, sessions }
        }

        fn begin(&mut self, name: &str, size: u64) -> Option<String> {
            let mut payload = (name.len() as u16).to_le_bytes().to_vec();
            payload.extend_from_slice(name.as_bytes());
            payload.extend_from_slice(&size.to_le_bytes());
            payload.extend_from_slice(&session_field());
            handle_file_begin(&payload, &mut self.sessions)
        }

        fn chunk(&mut self, data: &[u8]) -> Option<String> {
            let mut payload = session_field();
            payload.extend_from_slice(&(data.len() as u32).to_le_bytes());
            payload.extend_from_slice(data);
            handle_file_chunk(&payload, &mut self.sessions)
        }

        fn complete(&mut self) -> Option<String> {
            let mut payload = session_field();
            payload.extend_from_slice(&[0, 1]);
            handle_file_complete(&payload, &mut self.sessions)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.sessions.clear();
            std::fs::remove_dir_all(&self.root).unwrap();
        }
    }

    fn session_field() -> Vec<u8> {
        let mut field = ID.as_bytes().to_vec();
        field.resize(SESSION_ID_LEN, 0);
        field
    }

    fn response_type(response: Option<String>) -> String {
        serde_json::from_str::<serde_json::Value>(&response.unwrap()).unwrap()["type"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn identical_session_ids_keep_connections_and_staging_isolated() {
        let mut first = Fixture::new();
        let mut second = Fixture::new();
        second.sessions.insert(
            ID.to_string(),
            TransferState::new(first.root.clone()).unwrap(),
        );
        assert_eq!(response_type(first.begin("same.txt", 3)), "ack");
        assert_eq!(response_type(second.begin("same.txt", 3)), "ack");
        assert!(first.chunk(b"one").is_none());
        assert!(second.chunk(b"two").is_none());
        let first_path = first.sessions[ID]
            .current_file
            .as_ref()
            .unwrap()
            .path
            .clone();
        let second_path = second.sessions[ID]
            .current_file
            .as_ref()
            .unwrap()
            .path
            .clone();
        assert_ne!(first_path, second_path);
        assert_eq!(std::fs::read(&first_path).unwrap(), b"one");
        assert_eq!(std::fs::read(&second_path).unwrap(), b"two");
        first.sessions.clear();
        assert!(!first_path.exists());
        assert_eq!(std::fs::read(&second_path).unwrap(), b"two");
        second.sessions.clear();
        assert!(!second_path.exists());
    }

    #[test]
    fn disconnect_removes_completed_but_uncommitted_files() {
        let mut fixture = Fixture::new();
        assert_eq!(response_type(fixture.begin("data.txt", 3)), "ack");
        fixture.chunk(b"abc");
        assert_eq!(response_type(fixture.complete()), "ack");
        let directory = fixture.sessions[ID].stage_dir.clone();
        assert!(directory.join("data.txt").exists());
        fixture.sessions.clear();
        assert!(!directory.exists());
    }

    #[test]
    fn commit_preserves_files_and_duplicate_names_do_not_overwrite() {
        let mut fixture = Fixture::new();
        for data in [b"one", b"two"] {
            assert_eq!(response_type(fixture.begin("data.txt", 3)), "ack");
            assert!(fixture.chunk(data).is_none());
            assert_eq!(response_type(fixture.complete()), "ack");
        }
        let paths = fixture.sessions.remove(ID).unwrap().commit();
        assert_eq!(paths.len(), 2);
        assert_ne!(paths[0], paths[1]);
        assert_eq!(std::fs::read(&paths[0]).unwrap(), b"one");
        assert_eq!(std::fs::read(&paths[1]).unwrap(), b"two");
    }

    #[test]
    fn unsafe_names_are_rejected_before_file_creation() {
        for name in [
            "",
            ".",
            "..",
            "../outside",
            "/tmp/outside",
            "dir/file",
            "dir\\file",
            "C:\\outside",
            "name:stream",
            "NUL.txt",
            "COM1",
            "LPT²",
            "CONOUT$",
            "trailing.",
            "name\0",
        ] {
            let mut fixture = Fixture::new();
            let directory = fixture.sessions[ID].stage_dir.clone();
            assert_eq!(response_type(fixture.begin(name, 0)), "error", "{name:?}");
            assert!(fixture.sessions.is_empty());
            assert!(!directory.exists());
        }
        assert!(valid_file_name("文件 (1).txt"));
    }

    #[test]
    fn incomplete_and_oversized_files_are_aborted() {
        let mut fixture = Fixture::new();
        fixture.begin("short.txt", 4);
        fixture.chunk(b"abc");
        let directory = fixture.sessions[ID].stage_dir.clone();
        assert_eq!(response_type(fixture.complete()), "error");
        assert!(!directory.exists());
        assert!(fixture.sessions.is_empty());

        let mut fixture = Fixture::new();
        fixture.begin("long.txt", 2);
        let directory = fixture.sessions[ID].stage_dir.clone();
        assert_eq!(response_type(fixture.chunk(b"abc")), "error");
        assert!(!directory.exists());
    }

    #[test]
    fn malformed_chunks_and_write_errors_cannot_complete() {
        let mut fixture = Fixture::new();
        fixture.begin("data.txt", 3);
        let mut payload = session_field();
        payload.extend_from_slice(&3_u32.to_le_bytes());
        payload.extend_from_slice(b"ab");
        assert_eq!(
            response_type(handle_file_chunk(&payload, &mut fixture.sessions)),
            "error"
        );
        assert_eq!(response_type(fixture.complete()), "error");

        let mut fixture = Fixture::new();
        fixture.begin("data.txt", 3);
        let file = fixture
            .sessions
            .get_mut(ID)
            .unwrap()
            .current_file
            .as_mut()
            .unwrap();
        file.file = std::fs::File::open(&file.path).unwrap();
        assert_eq!(response_type(fixture.chunk(b"abc")), "error");
        assert!(fixture.sessions.is_empty());
    }

    #[test]
    fn empty_file_completes_and_overlapping_begin_aborts() {
        let mut fixture = Fixture::new();
        fixture.begin("empty.txt", 0);
        assert_eq!(response_type(fixture.complete()), "ack");
        fixture.begin("active.txt", 1);
        let directory = fixture.sessions[ID].stage_dir.clone();
        assert_eq!(response_type(fixture.begin("replacement.txt", 1)), "error");
        assert!(!directory.exists());
    }
}

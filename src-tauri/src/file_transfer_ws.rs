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
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

use crate::virtual_file_clipboard::session_stage_root;

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
    name: String,
    size: u64,
    written: u64,
    last_logged: u64,
}

struct TransferState {
    stage_dir: PathBuf,
    current_file: Option<FileState>,
    completed_paths: Vec<String>,
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

// ── Shared state across connections ──

type Sessions = Arc<Mutex<HashMap<String, TransferState>>>;

/// Start the file transfer WebSocket server on a random loopback port.
/// Returns the bound port number.
pub async fn start_file_transfer_server(app: AppHandle) -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();

    log::info!("[file_transfer_ws] File transfer WebSocket on 127.0.0.1:{port}");

    let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));

    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, peer)) => {
                    log::info!("[file_transfer_ws] Client connected: {peer}");
                    let sessions = sessions.clone();
                    let app = app.clone();
                    tokio::spawn(handle_client(stream, sessions, app));
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
async fn handle_client(stream: tokio::net::TcpStream, sessions: Sessions, app: AppHandle) {
    let ws = match tokio_tungstenite::accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            log::error!("[file_transfer_ws] WS handshake failed: {e}");
            return;
        }
    };

    let (mut ws_tx, mut ws_rx) = ws.split();

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
                if let Some(response) = handle_binary_message(&data, &sessions, &app).await {
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
async fn handle_binary_message(
    data: &[u8],
    sessions: &Sessions,
    app: &AppHandle,
) -> Option<String> {
    if data.is_empty() {
        return None;
    }

    let cmd = data[0];
    match cmd {
        CMD_FILE_BEGIN => handle_file_begin(&data[1..], sessions).await,
        CMD_FILE_CHUNK => {
            handle_file_chunk(&data[1..], sessions).await;
            None // No response for chunks (performance)
        }
        CMD_FILE_COMPLETE => handle_file_complete(&data[1..], sessions).await,
        CMD_TRANSFER_DONE => handle_transfer_done(&data[1..], sessions, app).await,
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

/// FILE_BEGIN: [2B name_len LE][N name_utf8][8B file_size LE][32B session_id]
async fn handle_file_begin(payload: &[u8], sessions: &Sessions) -> Option<String> {
    if payload.len() < 2 {
        return None;
    }

    let name_len = u16::from_le_bytes([payload[0], payload[1]]) as usize;
    let min_len = 2 + name_len + 8 + SESSION_ID_LEN;
    if payload.len() < min_len {
        log::error!(
            "[file_transfer_ws] FILE_BEGIN too short: {} < {min_len}",
            payload.len()
        );
        return None;
    }

    let name = String::from_utf8_lossy(&payload[2..2 + name_len]).to_string();
    let file_size = u64::from_le_bytes(payload[2 + name_len..2 + name_len + 8].try_into().unwrap());
    let session_id =
        parse_session_id(&payload[2 + name_len + 8..2 + name_len + 8 + SESSION_ID_LEN]);

    log::info!("[file_transfer_ws] FILE_BEGIN session={session_id} name={name} size={file_size}");

    let mut map = sessions.lock().await;
    let state = map.entry(session_id.clone()).or_insert_with(|| {
        let stage_dir = session_stage_root(Some(&session_id));
        TransferState {
            stage_dir,
            current_file: None,
            completed_paths: Vec::new(),
        }
    });

    // Ensure staging directory exists
    if let Err(e) = std::fs::create_dir_all(&state.stage_dir) {
        log::error!("[file_transfer_ws] Failed to create stage dir: {e}");
        return Some(
            serde_json::to_string(&ErrorResponse {
                r#type: "error",
                session_id,
                message: format!("Failed to create staging directory: {e}"),
            })
            .unwrap_or_default(),
        );
    }

    // Open file for writing
    let file_path = state.stage_dir.join(&name);
    match std::fs::File::create(&file_path) {
        Ok(file) => {
            state.current_file = Some(FileState {
                file,
                name,
                size: file_size,
                written: 0,
                last_logged: 0,
            });
        }
        Err(e) => {
            log::error!(
                "[file_transfer_ws] Failed to create file {}: {e}",
                file_path.display()
            );
            return Some(
                serde_json::to_string(&ErrorResponse {
                    r#type: "error",
                    session_id,
                    message: format!("Failed to create file: {e}"),
                })
                .unwrap_or_default(),
            );
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
async fn handle_file_chunk(payload: &[u8], sessions: &Sessions) {
    if payload.len() < SESSION_ID_LEN + 4 {
        log::error!("[file_transfer_ws] FILE_CHUNK too short");
        return;
    }

    let session_id = parse_session_id(&payload[..SESSION_ID_LEN]);
    let chunk_len = u32::from_le_bytes(
        payload[SESSION_ID_LEN..SESSION_ID_LEN + 4]
            .try_into()
            .unwrap(),
    ) as usize;

    let data_start = SESSION_ID_LEN + 4;
    if payload.len() < data_start + chunk_len {
        log::error!(
            "[file_transfer_ws] FILE_CHUNK data truncated: expected {chunk_len}, got {}",
            payload.len() - data_start
        );
        return;
    }

    let chunk_data = &payload[data_start..data_start + chunk_len];

    let mut map = sessions.lock().await;
    if let Some(state) = map.get_mut(&session_id) {
        if let Some(ref mut fs) = state.current_file {
            match fs.file.write_all(chunk_data) {
                Ok(()) => {
                    fs.written += chunk_len as u64;
                    // Log every 10MB of progress
                    if fs.written / PROGRESS_LOG_INTERVAL > fs.last_logged / PROGRESS_LOG_INTERVAL {
                        fs.last_logged = fs.written;
                        log::info!(
                            "[file_transfer_ws] Progress: {} — {:.1} MB / {:.1} MB",
                            fs.name,
                            fs.written as f64 / (1024.0 * 1024.0),
                            fs.size as f64 / (1024.0 * 1024.0),
                        );
                    }
                }
                Err(e) => {
                    log::error!("[file_transfer_ws] Write error for {}: {e}", fs.name);
                }
            }
        }
    }
}

/// FILE_COMPLETE: [32B session_id][1B file_index][1B total_files]
async fn handle_file_complete(payload: &[u8], sessions: &Sessions) -> Option<String> {
    if payload.len() < SESSION_ID_LEN + 2 {
        log::error!("[file_transfer_ws] FILE_COMPLETE too short");
        return None;
    }

    let session_id = parse_session_id(&payload[..SESSION_ID_LEN]);
    let file_index = payload[SESSION_ID_LEN];
    let total_files = payload[SESSION_ID_LEN + 1];

    let mut map = sessions.lock().await;
    if let Some(state) = map.get_mut(&session_id) {
        if let Some(mut fs) = state.current_file.take() {
            // Flush and close
            if let Err(e) = fs.file.flush() {
                log::error!("[file_transfer_ws] Flush error for {}: {e}", fs.name);
            }
            let file_path = state.stage_dir.join(&fs.name);
            state
                .completed_paths
                .push(file_path.to_string_lossy().to_string());
            log::info!(
                "[file_transfer_ws] FILE_COMPLETE session={session_id} file={} ({}/{}) size={:.1} MB",
                fs.name,
                file_index + 1,
                total_files,
                fs.written as f64 / (1024.0 * 1024.0),
            );
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

/// TRANSFER_DONE: [32B session_id]
async fn handle_transfer_done(
    payload: &[u8],
    sessions: &Sessions,
    app: &AppHandle,
) -> Option<String> {
    if payload.len() < SESSION_ID_LEN {
        log::error!("[file_transfer_ws] TRANSFER_DONE too short");
        return None;
    }

    let session_id = parse_session_id(&payload[..SESSION_ID_LEN]);

    let paths = {
        let mut map = sessions.lock().await;
        match map.remove(&session_id) {
            Some(state) => state.completed_paths,
            None => Vec::new(),
        }
    };

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

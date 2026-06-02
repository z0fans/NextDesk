//! Local WebSocket server for zero-overhead frame delivery.
//!
//! Carries bitmap frames:
//! `[12B header: 6×u16 LE] + [RGBA pixels]`.
//! Compressed frames set bit15 on desktop_width and append
//! `[4B uncompressed_len] + [LZ4 data]`.
//!
//! Rust → ws.send(Binary) → JS ws.onmessage(ArrayBuffer) — one hop.

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::Message;

/// Sender half — clone into the RDP session loop to push frames.
pub type FrameSender = broadcast::Sender<Vec<u8>>;

/// Start a local WebSocket frame server on a random port.
/// Returns (port, sender) — the sender is used by the RDP session to push frames.
pub async fn start_frame_server() -> std::io::Result<(u16, FrameSender)> {
    // Bind to random port on loopback
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();

    // Broadcast channel: 32 slots buffered (if consumer is slow, old frames are dropped)
    let (tx, _) = broadcast::channel::<Vec<u8>>(32);
    let tx_for_server = tx.clone();

    log::info!("[frame_ws] Frame WebSocket on 127.0.0.1:{port}");

    // Accept loop — runs forever in background
    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, peer)) => {
                    log::info!("[frame_ws] Client connected: {peer}");
                    let rx = tx_for_server.subscribe();
                    tokio::spawn(handle_client(stream, rx));
                }
                Err(e) => {
                    log::error!("[frame_ws] Accept error: {e}");
                }
            }
        }
    });

    Ok((port, tx))
}

/// Per-client: forward broadcast frames as binary WS messages.
async fn handle_client(stream: tokio::net::TcpStream, mut rx: broadcast::Receiver<Vec<u8>>) {
    let ws = match tokio_tungstenite::accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            log::error!("[frame_ws] WS handshake failed: {e}");
            return;
        }
    };

    let (mut ws_tx, _ws_rx) = ws.split();

    loop {
        match rx.recv().await {
            Ok(frame) => {
                let msg = Message::Binary(frame.into());
                if ws_tx.send(msg).await.is_err() {
                    // Client disconnected
                    break;
                }
            }
            Err(broadcast::error::RecvError::Lagged(n)) => {
                // Consumer too slow — skip old frames (acceptable for video)
                log::debug!("[frame_ws] Skipped {n} frames (consumer lag)");
            }
            Err(broadcast::error::RecvError::Closed) => {
                // Session ended
                break;
            }
        }
    }
    log::info!("[frame_ws] Client disconnected");
}

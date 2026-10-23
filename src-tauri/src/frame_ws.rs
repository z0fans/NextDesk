//! Local WebSocket server for zero-overhead frame delivery.
//!
//! Carries bitmap frames:
//! `[12B header: 6×u16 LE] + [RGBA pixels]`.
//! Compressed frames set bit15 on desktop_width and append
//! `[4B uncompressed_len] + [LZ4 data]`.
//!
//! Rust → ws.send(Binary) → JS ws.onmessage(ArrayBuffer) — one hop.

use futures_util::{SinkExt, StreamExt};
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, oneshot};
use tokio::task::JoinSet;
use tokio_tungstenite::tungstenite::Message;

/// Sender half — clone into the RDP session loop to push frames.
pub type FrameSender = broadcast::Sender<Vec<u8>>;
pub struct FrameServerShutdown {
    signal: oneshot::Sender<()>,
    completion: tauri::async_runtime::JoinHandle<()>,
}

impl FrameServerShutdown {
    pub async fn shutdown(self) {
        let _ = self.signal.send(());
        if let Err(error) = self.completion.await {
            log::warn!("[frame_ws] Server shutdown failed: {error}");
        }
    }
}

#[derive(Clone)]
struct FrameStreamMetadata {
    tab_id: String,
    host: String,
}

/// Start a local WebSocket frame server on a random port.
/// Returns (port, sender) — the sender is used by the RDP session to push frames.
pub async fn start_frame_server(
    tab_id: String,
    host: String,
) -> std::io::Result<(u16, FrameSender, FrameServerShutdown)> {
    // Bind to random port on loopback
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let meta = FrameStreamMetadata { tab_id, host };

    // Broadcast channel: 32 slots buffered (if consumer is slow, old frames are dropped)
    let (tx, _) = broadcast::channel::<Vec<u8>>(32);
    let tx_for_server = tx.clone();
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();

    log::info!(
        "[frame_ws] Frame WebSocket on 127.0.0.1:{port} tab={} host={}",
        meta.tab_id,
        meta.host
    );

    let completion = tauri::async_runtime::spawn(async move {
        let mut clients = JoinSet::new();
        loop {
            tokio::select! {
                biased;
                _ = &mut shutdown_rx => {
                    log::info!(
                        "[frame_ws] Server shutting down tab={} ws_port={port} host={}",
                        meta.tab_id,
                        meta.host
                    );
                    break;
                }
                _ = clients.join_next(), if !clients.is_empty() => {}
                accepted = listener.accept() => {
                    match accepted {
                        Ok((stream, peer)) => {
                            log::info!(
                                "[frame_ws] Client connected: {peer} tab={} ws_port={port} host={}",
                                meta.tab_id,
                                meta.host
                            );
                            let rx = tx_for_server.subscribe();
                            clients.spawn(handle_client(stream, rx, port, meta.clone()));
                        }
                        Err(e) => {
                            log::error!("[frame_ws] Accept error: {e}");
                            break;
                        }
                    }
                }
            }
        }
        drop(listener);
        // Abort blocked handshakes and sends too, then wait for every socket to drop.
        clients.shutdown().await;
    });

    Ok((
        port,
        tx,
        FrameServerShutdown {
            signal: shutdown_tx,
            completion,
        },
    ))
}

/// Per-client: forward broadcast frames as binary WS messages.
async fn handle_client(
    stream: tokio::net::TcpStream,
    mut rx: broadcast::Receiver<Vec<u8>>,
    ws_port: u16,
    meta: FrameStreamMetadata,
) {
    let ws = match tokio_tungstenite::accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            log::error!("[frame_ws] WS handshake failed: {e}");
            return;
        }
    };

    let (mut ws_tx, mut ws_rx) = ws.split();
    let started_at = Instant::now();
    let mut last_log_at = Instant::now();
    let mut total_frames: u64 = 0;
    let mut total_bytes: u64 = 0;
    let mut interval_frames: u64 = 0;
    let mut interval_bytes: u64 = 0;
    let mut lagged_frames: u64 = 0;

    loop {
        let frame = tokio::select! {
            message = ws_rx.next() => {
                match message {
                    None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                    Some(Ok(Message::Ping(_))) => {
                        if ws_tx.flush().await.is_err() { break; }
                    }
                    _ => {}
                }
                continue;
            }
            frame = rx.recv() => frame,
        };
        match frame {
            Ok(frame) => {
                let frame_len = frame.len() as u64;
                let msg = Message::Binary(frame.into());
                if ws_tx.send(msg).await.is_err() {
                    // Client disconnected
                    break;
                }
                total_frames += 1;
                total_bytes += frame_len;
                interval_frames += 1;
                interval_bytes += frame_len;

                let elapsed = last_log_at.elapsed();
                if elapsed >= Duration::from_secs(5) {
                    let secs = elapsed.as_secs_f64().max(0.001);
                    log::info!(
                        "[frame_ws][stats] tab={} ws_port={} host={} sent_frames={} sent_fps={:.1} sent_mib_s={:.2} queued_lagged={} total_frames={} total_mib={:.2}",
                        meta.tab_id,
                        ws_port,
                        meta.host,
                        interval_frames,
                        interval_frames as f64 / secs,
                        bytes_to_mib(interval_bytes) / secs,
                        lagged_frames,
                        total_frames,
                        bytes_to_mib(total_bytes)
                    );
                    interval_frames = 0;
                    interval_bytes = 0;
                    lagged_frames = 0;
                    last_log_at = Instant::now();
                }
            }
            Err(broadcast::error::RecvError::Lagged(n)) => {
                // Consumer too slow — skip old frames (acceptable for video)
                lagged_frames += n;
                log::debug!(
                    "[frame_ws] Skipped {n} frames (consumer lag) tab={} ws_port={ws_port} host={}",
                    meta.tab_id,
                    meta.host
                );
            }
            Err(broadcast::error::RecvError::Closed) => {
                // Session ended
                break;
            }
        }
    }
    log::info!(
        "[frame_ws] Client disconnected tab={} ws_port={} host={} total_frames={} total_mib={:.2} duration_s={:.1}",
        meta.tab_id,
        ws_port,
        meta.host,
        total_frames,
        bytes_to_mib(total_bytes),
        started_at.elapsed().as_secs_f64()
    );
}

fn bytes_to_mib(bytes: u64) -> f64 {
    bytes as f64 / 1024.0 / 1024.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;
    use tokio::net::TcpStream;
    use tokio::time::timeout;

    async fn wait_for_receivers(sender: &FrameSender, count: usize) {
        timeout(Duration::from_secs(3), async {
            while sender.receiver_count() != count {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("frame client tasks should release their receivers");
    }

    #[tokio::test]
    async fn idle_disconnect_releases_client_without_another_frame() {
        let (port, sender, shutdown) = start_frame_server("test".into(), "localhost".into())
            .await
            .unwrap();
        let (mut client, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}"))
            .await
            .unwrap();
        wait_for_receivers(&sender, 1).await;
        client.close(None).await.unwrap();
        wait_for_receivers(&sender, 0).await;
        timeout(Duration::from_secs(3), shutdown.shutdown())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn shutdown_joins_connected_and_unfinished_handshake_clients() {
        let (port, sender, shutdown) = start_frame_server("test".into(), "localhost".into())
            .await
            .unwrap();
        let (mut client, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}"))
            .await
            .unwrap();
        let mut handshake = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        wait_for_receivers(&sender, 2).await;
        sender.send(vec![1, 2, 3]).unwrap();
        assert_eq!(
            timeout(Duration::from_secs(3), client.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap(),
            Message::Binary(vec![1, 2, 3].into())
        );
        timeout(Duration::from_secs(3), shutdown.shutdown())
            .await
            .unwrap();
        assert_eq!(sender.receiver_count(), 0);
        assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
        assert_eq!(
            timeout(Duration::from_secs(3), handshake.read(&mut [0; 1]))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        assert!(!matches!(
            timeout(Duration::from_secs(3), client.next())
                .await
                .unwrap(),
            Some(Ok(Message::Binary(_)))
        ));
    }

    #[tokio::test]
    async fn dropping_shutdown_handle_still_reclaims_clients() {
        let (port, sender, shutdown) = start_frame_server("test".into(), "localhost".into())
            .await
            .unwrap();
        let handshake = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        wait_for_receivers(&sender, 1).await;
        drop(shutdown);
        wait_for_receivers(&sender, 0).await;
        drop(handshake);
    }
}

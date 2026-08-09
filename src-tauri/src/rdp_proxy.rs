use futures_util::{SinkExt, StreamExt};
use ironrdp_rdcleanpath::RDCleanPathPdu;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Instant;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{tungstenite::Message, WebSocketStream};

type SharedRdpProxyPort = Arc<Mutex<u16>>;
type SharedRdpProxyError = Arc<Mutex<Option<String>>>;

struct RdpRouteReleaseGuard {
    app: AppHandle,
    session_id: Option<String>,
    lease_id: Option<u64>,
}

impl Drop for RdpRouteReleaseGuard {
    fn drop(&mut self) {
        let (Some(session_id), Some(lease_id)) = (self.session_id.as_deref(), self.lease_id) else {
            return;
        };
        let state = self.app.state::<crate::state::AppState>();
        crate::connection_resolver::release_session_route_if_current(
            state.inner(),
            crate::connection_resolver::ServiceKind::Rdp,
            session_id,
            lease_id,
        );
    }
}

/// Start the WS-to-TCP RDCleanPath proxy.
pub async fn start_proxy(
    app_handle: AppHandle,
    port: u16,
    advertised_port: SharedRdpProxyPort,
    bind_error: SharedRdpProxyError,
) {
    // Official-web connects to ws://127.0.0.1:<port>, so this proxy must bind
    // IPv4 loopback. Falling back to [::1] makes the backend look healthy while
    // the frontend still connects to a stale or wrong IPv4 listener.
    let listener = match TcpListener::bind(format!("127.0.0.1:{port}")).await {
        Ok(l) => {
            *advertised_port.lock().unwrap() = port;
            *bind_error.lock().unwrap() = None;
            log::info!("[rdp_proxy] RDCleanPath proxy on 127.0.0.1:{port} (IPv4)");
            l
        }
        Err(e) => {
            let message = format!(
                "[rdp_proxy] Cannot bind 127.0.0.1:{port}: {e}. official-web requires the IPv4 loopback proxy; stale NextDesk processes may still own the port."
            );
            *advertised_port.lock().unwrap() = 0;
            *bind_error.lock().unwrap() = Some(message.clone());
            log::error!("{message}");
            return;
        }
    };

    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                log::info!("[rdp_proxy] Client: {peer}");
                let app = app_handle.clone();
                tauri::async_runtime::spawn(handle_client(app, stream));
            }
            Err(e) => log::error!("[rdp_proxy] Accept: {e}"),
        }
    }
}

async fn handle_client(app_handle: AppHandle, stream: TcpStream) {
    if let Err(e) = handle_inner(app_handle, stream).await {
        log::error!("[rdp_proxy] Error: {e}");
    }
}

async fn relay_tls_to_websocket<S>(
    tls: S,
    dest: &str,
    label: &str,
    tx: &mut futures_util::stream::SplitSink<WebSocketStream<TcpStream>, Message>,
    rx: &mut futures_util::stream::SplitStream<WebSocketStream<TcpStream>>,
) -> Result<(), Box<dyn std::error::Error>>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let started = Instant::now();
    let c2s_bytes = Arc::new(AtomicU64::new(0));
    let c2s_frames = Arc::new(AtomicU64::new(0));
    let s2c_bytes = Arc::new(AtomicU64::new(0));
    let s2c_frames = Arc::new(AtomicU64::new(0));
    let (mut tr, mut tw) = tokio::io::split(tls);

    let c2s_bytes_write = c2s_bytes.clone();
    let c2s_frames_write = c2s_frames.clone();
    let w2t = async {
        while let Some(message) = rx.next().await {
            match message {
                Ok(Message::Binary(data)) => {
                    let len = data.len() as u64;
                    if let Err(error) = tw.write_all(&data).await {
                        return format!("client->server write error: {error}");
                    }
                    if let Err(error) = tw.flush().await {
                        return format!("client->server flush error: {error}");
                    }
                    c2s_bytes_write.fetch_add(len, Ordering::Relaxed);
                    c2s_frames_write.fetch_add(1, Ordering::Relaxed);
                }
                Ok(Message::Close(frame)) => {
                    let _ = tw.shutdown().await;
                    return format!("client websocket close: {frame:?}");
                }
                Ok(Message::Text(_)) => {
                    log::debug!("[rdp_proxy] {label} ignoring websocket text message for {dest}");
                }
                Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {
                    log::debug!("[rdp_proxy] {label} websocket control frame for {dest}");
                }
                Ok(_) => {
                    log::debug!(
                        "[rdp_proxy] {label} ignoring non-binary websocket message for {dest}"
                    );
                }
                Err(error) => return format!("client websocket error: {error}"),
            }
        }

        let _ = tw.shutdown().await;
        "client websocket EOF".to_string()
    };

    let s2c_bytes_read = s2c_bytes.clone();
    let s2c_frames_read = s2c_frames.clone();
    let t2w = async {
        let mut buffer = vec![0u8; 16384];
        loop {
            match tr.read(&mut buffer).await {
                Ok(0) => return "server TLS EOF".to_string(),
                Ok(n) => {
                    s2c_bytes_read.fetch_add(n as u64, Ordering::Relaxed);
                    s2c_frames_read.fetch_add(1, Ordering::Relaxed);
                    let msg = Message::Binary(buffer[..n].to_vec().into());
                    if let Err(error) = tx.send(msg).await {
                        return format!("server->client websocket send error: {error}");
                    }
                }
                Err(error) => return format!("server TLS read error: {error}"),
            }
        }
    };

    let reason = tokio::select! {
        reason = w2t => reason,
        reason = t2w => reason,
    };

    log::info!(
        "[rdp_proxy] {label} relay end dest={dest} reason={reason}; c2s={}B/{}f s2c={}B/{}f elapsed={}ms",
        c2s_bytes.load(Ordering::Relaxed),
        c2s_frames.load(Ordering::Relaxed),
        s2c_bytes.load(Ordering::Relaxed),
        s2c_frames.load(Ordering::Relaxed),
        started.elapsed().as_millis(),
    );
    log::info!("[rdp_proxy] {label} Done {dest}");

    Ok(())
}

async fn handle_inner(
    app_handle: AppHandle,
    stream: TcpStream,
) -> Result<(), Box<dyn std::error::Error>> {
    let ws: WebSocketStream<TcpStream> = tokio_tungstenite::accept_async(stream).await?;
    let (mut tx, mut rx) = ws.split();

    // 1: Read RDCleanPath Request
    let first = rx.next().await.ok_or("WS closed early")??;
    let req_bytes = match first {
        Message::Binary(b) => b.to_vec(),
        _ => return Err("Expected binary".into()),
    };

    // 2: Decode
    let pdu = RDCleanPathPdu::from_der(&req_bytes).map_err(|e| format!("decode: {e}"))?;
    let cpath = pdu.into_enum().map_err(|e| format!("enum: {e}"))?;
    let (x224_req_os, dest, proxy_auth) = match cpath {
        ironrdp_rdcleanpath::RDCleanPath::Request {
            x224_connection_request,
            destination,
            proxy_auth,
            ..
        } => (x224_connection_request, destination, proxy_auth),
        _ => return Err("Not a Request".into()),
    };
    let x224_req = x224_req_os.as_bytes().to_vec();
    log::info!("[rdp_proxy] dest={dest}");
    eprintln!("[rdp_proxy] dest={dest}, x224_req_len={}", x224_req.len());

    // 3: Resolve cloud relay or local direct route.
    let (dest_host, dest_port_text) = dest
        .rsplit_once(':')
        .ok_or_else(|| format!("invalid destination: {dest}"))?;
    let dest_port: u16 = dest_port_text.parse()?;
    let app_state = app_handle.state::<crate::state::AppState>();
    let session_id = proxy_auth
        .strip_prefix("nextdesk-local:")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let mut route_release = RdpRouteReleaseGuard {
        app: app_handle.clone(),
        session_id: session_id.clone(),
        lease_id: None,
    };
    let resolved = crate::connection_resolver::resolve_connection_target(
        app_state.inner(),
        dest_host.to_string(),
        dest_port,
        false,
        session_id,
    )
    .await?;
    route_release.lease_id = Some(resolved.route_lease_id);
    let resolved_dest = format!("{}:{}", resolved.host, resolved.port);
    log::info!(
        "[rdp_proxy] route target={dest_host}:{dest_port} resolved={resolved_dest} label={} binding={:?}",
        resolved.route_label,
        resolved.binding_id
    );
    let mut tcp = TcpStream::connect(&resolved_dest)
        .await
        .map_err(|error| format!("tcp connect {resolved_dest}: {error}"))?;

    // 4: X.224 request
    tcp.write_all(&x224_req).await?;
    eprintln!("[rdp_proxy] X.224 req sent ({} bytes)", x224_req.len());

    // 5: X.224 response
    let mut buf = vec![0u8; 4096];
    let n = tcp.read(&mut buf).await?;
    let x224_resp = buf[..n].to_vec();
    eprintln!(
        "[rdp_proxy] X.224 resp received ({n} bytes): {:?}",
        &x224_resp[..n.min(32)]
    );

    // 6: TLS + cert
    let tls_cx = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .build()?;
    let tls_cx = tokio_native_tls::TlsConnector::from(tls_cx);
    let host = dest.split(':').next().unwrap_or(&dest);
    eprintln!("[rdp_proxy] TLS handshake starting to {host}");
    let tls = tls_cx.connect(host, tcp).await.map_err(|e| {
        eprintln!("[rdp_proxy] TLS FAILED: {e}");
        format!("tls: {e}")
    })?;
    eprintln!("[rdp_proxy] TLS handshake OK");
    let chain: Vec<Vec<u8>> = tls
        .get_ref()
        .peer_certificate()
        .ok()
        .flatten()
        .and_then(|c| c.to_der().ok())
        .map(|d| vec![d])
        .unwrap_or_default();
    eprintln!("[rdp_proxy] cert chain len: {} entries", chain.len());

    // 7: Response
    let resp = RDCleanPathPdu::new_response(dest.clone(), x224_resp, chain)
        .map_err(|e| format!("resp: {e}"))?;
    let resp_bytes = resp.to_der().map_err(|e| format!("enc: {e}"))?;
    eprintln!(
        "[rdp_proxy] sending response ({} bytes) to client",
        resp_bytes.len()
    );
    tx.send(Message::Binary(resp_bytes.into())).await?;
    eprintln!("[rdp_proxy] Response sent, entering relay phase");
    log::info!("[rdp_proxy] Response sent, relay");

    relay_tls_to_websocket(tls, &dest, "normal", &mut tx, &mut rx).await
}

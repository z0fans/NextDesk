use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use ironrdp_rdcleanpath::RDCleanPathPdu;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};
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

fn parse_proxy_outcome_context(
    proxy_auth: &str,
) -> (
    Option<String>,
    Option<String>,
    crate::connection_resolver::RoutePolicy,
    HashMap<String, crate::connection_resolver::RoutePolicy>,
) {
    let Some(raw) = proxy_auth.strip_prefix("nextdesk-local:").map(str::trim) else {
        return (
            None,
            None,
            crate::connection_resolver::RoutePolicy::Auto,
            HashMap::new(),
        );
    };
    if raw.is_empty() {
        return (
            None,
            None,
            crate::connection_resolver::RoutePolicy::Auto,
            HashMap::new(),
        );
    }
    let mut parts = raw.splitn(4, '|');
    let session_id = parts.next().unwrap_or_default().trim();
    let attempt_id = parts.next().map(str::trim);
    let route_policy = match parts.next().map(str::trim) {
        Some("direct") => crate::connection_resolver::RoutePolicy::Direct,
        Some("cloud_only") => crate::connection_resolver::RoutePolicy::CloudOnly,
        _ => crate::connection_resolver::RoutePolicy::Auto,
    };
    let session_id = (!session_id.is_empty()).then(|| session_id.to_string());
    let attempt_id = attempt_id
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let network_route_preferences = parts
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|encoded| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(encoded)
                .ok()
        })
        .and_then(|json| {
            serde_json::from_slice::<HashMap<String, crate::connection_resolver::RoutePolicy>>(
                &json,
            )
            .ok()
        })
        .unwrap_or_default()
        .into_iter()
        .filter(|(scope, _)| {
            (16..=64).contains(&scope.len()) && scope.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
        .take(32)
        .collect();
    (
        session_id,
        attempt_id,
        route_policy,
        network_route_preferences,
    )
}

fn emit_route_status(
    app: &AppHandle,
    session_id: Option<&str>,
    attempt_id: Option<&str>,
    route_lease_id: u64,
    status: &str,
) {
    let (Some(tab_id), Some(attempt_id)) = (session_id, attempt_id) else {
        return;
    };
    let _ = app.emit(
        "rdp://status",
        crate::rdp_session::RdpStatusEvent {
            tab_id: tab_id.to_string(),
            status: status.to_string(),
            message: None,
            route_lease_id,
            attempt_id: attempt_id.to_string(),
        },
    );
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
    let (session_id, attempt_id, route_policy, network_route_preferences) =
        parse_proxy_outcome_context(&proxy_auth);
    let mut route_release = RdpRouteReleaseGuard {
        app: app_handle.clone(),
        session_id: session_id.clone(),
        lease_id: None,
    };
    let resolved = crate::connection_resolver::resolve_connection(
        app_state.inner(),
        crate::connection_resolver::ConnectionIntent {
            service_kind: crate::connection_resolver::ServiceKind::Rdp,
            session_id: session_id.clone(),
            host: dest_host.to_string(),
            port: dest_port,
            reuse_cloud_binding: false,
            route_policy,
            preferred_region: None,
            network_route_preferences,
        },
    )
    .await?;
    route_release.lease_id = Some(resolved.lease_id);
    let resolved_dest = format!(
        "{}:{}",
        resolved.dial_target.host, resolved.dial_target.port
    );
    log::info!(
        "[rdp_proxy] route target={dest_host}:{dest_port} resolved={resolved_dest} label={} binding={:?}",
        resolved.route_label,
        resolved.binding_id
    );
    emit_route_status(
        &app_handle,
        session_id.as_deref(),
        attempt_id.as_deref(),
        resolved.lease_id,
        "candidate_validation",
    );
    emit_route_status(
        &app_handle,
        session_id.as_deref(),
        attempt_id.as_deref(),
        resolved.lease_id,
        "transport",
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
    emit_route_status(
        &app_handle,
        session_id.as_deref(),
        attempt_id.as_deref(),
        resolved.lease_id,
        "protocol_handshake",
    );
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
    emit_route_status(
        &app_handle,
        session_id.as_deref(),
        attempt_id.as_deref(),
        resolved.lease_id,
        "authentication",
    );
    eprintln!("[rdp_proxy] Response sent, entering relay phase");
    log::info!("[rdp_proxy] Response sent, relay");

    relay_tls_to_websocket(tls, &dest, "normal", &mut tx, &mut rx).await
}

#[cfg(test)]
mod tests {
    use super::parse_proxy_outcome_context;
    use base64::Engine as _;

    #[test]
    fn proxy_auth_carries_the_tab_and_attempt_without_breaking_legacy_tokens() {
        assert_eq!(
            parse_proxy_outcome_context("nextdesk-local:tab-7|rdp-tab-7-42"),
            (
                Some("tab-7".to_string()),
                Some("rdp-tab-7-42".to_string()),
                crate::connection_resolver::RoutePolicy::Auto,
                std::collections::HashMap::new(),
            )
        );
        assert_eq!(
            parse_proxy_outcome_context("nextdesk-local:legacy-tab"),
            (
                Some("legacy-tab".to_string()),
                None,
                crate::connection_resolver::RoutePolicy::Auto,
                std::collections::HashMap::new(),
            )
        );
        assert_eq!(
            parse_proxy_outcome_context("nextdesk-local:tab-8|attempt-8|cloud_only"),
            (
                Some("tab-8".to_string()),
                Some("attempt-8".to_string()),
                crate::connection_resolver::RoutePolicy::CloudOnly,
                std::collections::HashMap::new(),
            )
        );
    }

    #[test]
    fn proxy_auth_carries_sanitized_network_route_preferences() {
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"0123456789abcdef0123456789abcdef":"direct","unsafe":"cloud_only"}"#);
        let (_, _, policy, preferences) =
            parse_proxy_outcome_context(&format!("nextdesk-local:tab-9|attempt-9|auto|{encoded}"));

        assert_eq!(policy, crate::connection_resolver::RoutePolicy::Auto);
        assert_eq!(preferences.len(), 1);
        assert_eq!(
            preferences.get("0123456789abcdef0123456789abcdef"),
            Some(&crate::connection_resolver::RoutePolicy::Direct)
        );
    }
}

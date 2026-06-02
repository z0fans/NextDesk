use futures_util::{SinkExt, StreamExt};
use ironrdp_rdcleanpath::RDCleanPathPdu;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{tungstenite::Message, WebSocketStream};

/// Shared SOCKS5 port that can be updated at runtime (after Clash detect).
pub type SharedSocksPort = Arc<Mutex<u16>>;

/// Cloud mode shared state types
type SharedBool = Arc<Mutex<bool>>;
type SharedString = Arc<Mutex<String>>;
type SharedEndpoints = Arc<Mutex<Vec<crate::state::RelayEndpoint>>>;

/// Start the WS→TCP RDCleanPath proxy with optional SOCKS5 upstream.
pub async fn start_proxy(
    port: u16,
    socks_port: SharedSocksPort,
    tube_enabled: crate::tube::TubeEnabled,
    cloud_mode: SharedBool,
    relay_endpoints: SharedEndpoints,
    dashboard_url: SharedString,
    relay_api_key: SharedString,
) {
    // Bind to 127.0.0.1 (IPv4 loopback). If that fails, try [::1] (IPv6).
    let listener = match TcpListener::bind(format!("127.0.0.1:{port}")).await {
        Ok(l) => {
            log::info!("[rdp_proxy] RDCleanPath proxy on 127.0.0.1:{port} (IPv4)");
            l
        }
        Err(_) => match TcpListener::bind(format!("[::1]:{port}")).await {
            Ok(l) => {
                log::info!("[rdp_proxy] RDCleanPath proxy on [::1]:{port} (IPv6)");
                l
            }
            Err(e) => {
                log::error!("[rdp_proxy] Cannot bind port {port}: {e}");
                return;
            }
        },
    };

    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                log::info!("[rdp_proxy] Client: {peer}");
                let sp = *socks_port.lock().unwrap();
                let te = tube_enabled.clone();
                let cm = cloud_mode.clone();
                let re = relay_endpoints.clone();
                let du = dashboard_url.clone();
                let rk = relay_api_key.clone();
                tokio::spawn(handle_client(stream, sp, te, cm, re, du, rk));
            }
            Err(e) => log::error!("[rdp_proxy] Accept: {e}"),
        }
    }
}

async fn handle_client(
    stream: TcpStream,
    socks_port: u16,
    tube_enabled: crate::tube::TubeEnabled,
    cloud_mode: SharedBool,
    relay_endpoints: SharedEndpoints,
    dashboard_url: SharedString,
    relay_api_key: SharedString,
) {
    if let Err(e) = handle_inner(
        stream,
        socks_port,
        tube_enabled,
        cloud_mode,
        relay_endpoints,
        dashboard_url,
        relay_api_key,
    )
    .await
    {
        log::error!("[rdp_proxy] Error: {e}");
    }
}

/// Connect to destination, trying SOCKS5 proxy first (with timeout),
/// falling back to direct TCP. Private IPs always use direct connection.
async fn connect_to_dest(
    dest: &str,
    socks_port: u16,
) -> Result<TcpStream, Box<dyn std::error::Error>> {
    let parts: Vec<&str> = dest.rsplitn(2, ':').collect();
    if parts.len() != 2 {
        return Err(format!("invalid dest: {dest}").into());
    }
    let port: u16 = parts[0].parse().map_err(|e| format!("bad port: {e}"))?;
    let host = parts[1];

    // Skip SOCKS5 for private/LAN IPs — they must be reached directly
    let use_proxy = !is_private_ip(host);

    if use_proxy {
        // Try SOCKS5 via Clash, with 3s timeout
        let socks_addr = format!("127.0.0.1:{socks_port}");
        let socks_result = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            tokio_socks::tcp::Socks5Stream::connect(socks_addr.as_str(), (host, port)),
        )
        .await;

        match socks_result {
            Ok(Ok(socks_stream)) => {
                log::info!("[rdp_proxy] Connected via SOCKS5:{socks_port} → {dest}");
                return Ok(socks_stream.into_inner());
            }
            Ok(Err(e)) => {
                log::warn!("[rdp_proxy] SOCKS5 error: {e}, fallback direct");
            }
            Err(_) => {
                log::warn!("[rdp_proxy] SOCKS5 timeout (3s), fallback direct");
            }
        }
    } else {
        log::info!("[rdp_proxy] Private IP detected, using direct connection for {dest}");
    }

    // Direct fallback
    let tcp = TcpStream::connect(dest)
        .await
        .map_err(|e| format!("direct tcp {dest}: {e}"))?;
    log::info!("[rdp_proxy] Connected direct → {dest}");
    Ok(tcp)
}

/// Check if a host is a private/reserved IP that should bypass proxy.
/// Covers: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12,
///   192.0.0/24, 192.0.2/24, 192.168/16, 192.88.99/24,
///   198.18/15, 198.51.100/24, 203.0.113/24, 224/3,
///   ::/127, fc00::/7, fe80::/10, ff00::/8
fn is_private_ip(host: &str) -> bool {
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        match ip {
            std::net::IpAddr::V4(v4) => {
                let o = v4.octets();
                o[0] == 0                                       // 0.0.0.0/8
                || o[0] == 10                                   // 10.0.0.0/8
                || (o[0] == 100 && (o[1] & 0xC0) == 64)        // 100.64.0.0/10
                || o[0] == 127                                  // 127.0.0.0/8
                || (o[0] == 169 && o[1] == 254)                 // 169.254.0.0/16
                || (o[0] == 172 && (o[1] & 0xF0) == 16)        // 172.16.0.0/12
                || (o[0] == 192 && o[1] == 0 && o[2] == 0)     // 192.0.0.0/24
                || (o[0] == 192 && o[1] == 0 && o[2] == 2)     // 192.0.2.0/24
                || (o[0] == 192 && o[1] == 168)                 // 192.168.0.0/16
                || (o[0] == 192 && o[1] == 88 && o[2] == 99)   // 192.88.99.0/24
                || (o[0] == 198 && (o[1] & 0xFE) == 18)        // 198.18.0.0/15
                || (o[0] == 198 && o[1] == 51 && o[2] == 100)  // 198.51.100.0/24
                || (o[0] == 203 && o[1] == 0 && o[2] == 113)   // 203.0.113.0/24
                || o[0] >= 224 // 224.0.0.0/3
            }
            std::net::IpAddr::V6(v6) => {
                let s = v6.segments();
                v6.is_loopback()                                // ::/127 (::1)
                || (s[0] & 0xFE00) == 0xFC00                   // fc00::/7
                || (s[0] & 0xFFC0) == 0xFE80                   // fe80::/10
                || (s[0] & 0xFF00) == 0xFF00                    // ff00::/8
                || v6.is_unspecified() // ::
            }
        }
    } else {
        false // hostname, not IP — use proxy
    }
}

async fn handle_inner(
    stream: TcpStream,
    socks_port: u16,
    tube_enabled: crate::tube::TubeEnabled,
    cloud_mode: SharedBool,
    relay_endpoints: SharedEndpoints,
    dashboard_url: SharedString,
    relay_api_key: SharedString,
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
    let (x224_req_os, dest) = match cpath {
        ironrdp_rdcleanpath::RDCleanPath::Request {
            x224_connection_request,
            destination,
            ..
        } => (x224_connection_request, destination),
        _ => return Err("Not a Request".into()),
    };
    let x224_req = x224_req_os.as_bytes().to_vec();
    log::info!("[rdp_proxy] dest={dest}");
    eprintln!("[rdp_proxy] dest={dest}, x224_req_len={}", x224_req.len());

    // 3: TCP connect - Tube Mode or normal
    let tube_on = *tube_enabled.lock().unwrap();
    let dest_host = dest.split(':').next().unwrap_or(&dest);

    if tube_on {
        if let Some(dispatcher) = crate::tube::resolve_dispatcher(dest_host) {
            log::info!("[rdp_proxy] Tube Mode -> {dispatcher}");
            match crate::tube::connect_tube(&dispatcher, socks_port, &dest, 3).await {
                Ok(tube_io) => {
                    return handle_tube_path(
                        tube_io, &dest, dest_host, &x224_req, &mut tx, &mut rx,
                    )
                    .await;
                }
                Err(e) => {
                    log::warn!("[rdp_proxy] Tube failed: {e}, fallback normal");
                }
            }
        }
    }

    // Cloud Mode: connect through relay server
    let cloud_on = *cloud_mode.lock().unwrap();
    if cloud_on {
        let dest_port: u16 = dest
            .split(':')
            .last()
            .and_then(|p| p.parse().ok())
            .unwrap_or(3389);

        // Try cached endpoints first
        let endpoints = relay_endpoints.lock().unwrap().clone();
        let relay_addr = crate::relay::find_relay_for_dest(&endpoints, dest_host, dest_port);

        // If no cached match, auto-create via Dashboard
        let relay_addr = match relay_addr {
            Some(addr) => {
                log::info!("[rdp_proxy] Cloud: cached relay {}:{}", addr.0, addr.1);
                Some(addr)
            }
            None => {
                let url = dashboard_url.lock().unwrap().clone();
                let key = relay_api_key.lock().unwrap().clone();
                if !url.is_empty() && !key.is_empty() {
                    match crate::relay::auto_create_route(&url, &key, dest_host, dest_port).await {
                        Ok(addr) => {
                            log::info!(
                                "[rdp_proxy] Cloud: auto-created relay {}:{}",
                                addr.0,
                                addr.1
                            );
                            Some(addr)
                        }
                        Err(e) => {
                            log::warn!(
                                "[rdp_proxy] Cloud auto-create failed: {e}, fallback normal"
                            );
                            None
                        }
                    }
                } else {
                    log::warn!("[rdp_proxy] Cloud: no dashboard URL/key, fallback normal");
                    None
                }
            }
        };

        if let Some((relay_host, relay_port)) = relay_addr {
            let relay_dest = format!("{relay_host}:{relay_port}");
            match TcpStream::connect(&relay_dest).await {
                Ok(tcp) => {
                    log::info!("[rdp_proxy] Cloud: connected to relay {relay_dest}");
                    // Relay handles TCP-level forwarding, use normal X.224/TLS path
                    return handle_normal_path(tcp, &dest, dest_host, &x224_req, &mut tx, &mut rx)
                        .await;
                }
                Err(e) => {
                    log::warn!("[rdp_proxy] Cloud: relay connect failed: {e}, fallback normal");
                }
            }
        }
    }

    // Fallback: normal single-path connection
    let mut tcp = connect_to_dest(&dest, socks_port).await?;
    eprintln!("[rdp_proxy] TCP connected to {dest}");

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

    // 8: Raw relay
    let (mut tr, mut tw) = tokio::io::split(tls);
    let w2t = async {
        while let Some(Ok(m)) = rx.next().await {
            if let Message::Binary(d) = m {
                if tw.write_all(&d).await.is_err() {
                    break;
                }
            }
        }
    };
    let t2w = async {
        let mut b = vec![0u8; 16384];
        loop {
            match tr.read(&mut b).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let msg = Message::Binary(b[..n].to_vec().into());
                    if tx.send(msg).await.is_err() {
                        break;
                    }
                }
            }
        }
    };
    tokio::select! { _ = w2t => {} _ = t2w => {} }
    log::info!("[rdp_proxy] Done {dest}");
    Ok(())
}
/// Handle normal X.224 → TLS → bidirectional relay path.
/// Used by both the default flow and cloud mode flow.
async fn handle_normal_path(
    mut tcp: TcpStream,
    dest: &str,
    _dest_host: &str,
    x224_req: &[u8],
    tx: &mut futures_util::stream::SplitSink<WebSocketStream<TcpStream>, Message>,
    rx: &mut futures_util::stream::SplitStream<WebSocketStream<TcpStream>>,
) -> Result<(), Box<dyn std::error::Error>> {
    // X.224 request
    tcp.write_all(x224_req).await?;

    // X.224 response
    let mut buf = vec![0u8; 4096];
    let n = tcp.read(&mut buf).await?;
    let x224_resp = buf[..n].to_vec();

    // TLS + cert
    let tls_cx = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .build()?;
    let tls_cx = tokio_native_tls::TlsConnector::from(tls_cx);
    let host = dest.split(':').next().unwrap_or(dest);
    let tls = tls_cx
        .connect(host, tcp)
        .await
        .map_err(|e| format!("tls: {e}"))?;
    let chain: Vec<Vec<u8>> = tls
        .get_ref()
        .peer_certificate()
        .ok()
        .flatten()
        .and_then(|c| c.to_der().ok())
        .map(|d| vec![d])
        .unwrap_or_default();

    // RDCleanPath Response
    let resp = RDCleanPathPdu::new_response(dest.to_string(), x224_resp, chain)
        .map_err(|e| format!("resp: {e}"))?;
    let resp_bytes = resp.to_der().map_err(|e| format!("enc: {e}"))?;
    tx.send(Message::Binary(resp_bytes.into())).await?;
    log::info!("[rdp_proxy] Response sent, relay");

    // Raw bidirectional relay
    let (mut tr, mut tw) = tokio::io::split(tls);
    let w2t = async {
        while let Some(Ok(m)) = rx.next().await {
            if let Message::Binary(d) = m {
                if tw.write_all(&d).await.is_err() {
                    break;
                }
            }
        }
    };
    let t2w = async {
        let mut b = vec![0u8; 16384];
        loop {
            match tr.read(&mut b).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let msg = Message::Binary(b[..n].to_vec().into());
                    if tx.send(msg).await.is_err() {
                        break;
                    }
                }
            }
        }
    };
    tokio::select! { _ = w2t => {} _ = t2w => {} }
    log::info!("[rdp_proxy] Done {dest}");
    Ok(())
}

/// Handle the full RDP path over an Aggligator tube stream.
async fn handle_tube_path(
    mut tube_io: aggligator::alc::Stream,
    dest: &str,
    dest_host: &str,
    x224_req: &[u8],
    tx: &mut futures_util::stream::SplitSink<WebSocketStream<TcpStream>, Message>,
    rx: &mut futures_util::stream::SplitStream<WebSocketStream<TcpStream>>,
) -> Result<(), Box<dyn std::error::Error>> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // X.224 over tube
    tube_io.write_all(x224_req).await?;
    let mut buf = vec![0u8; 4096];
    let n = tube_io.read(&mut buf).await?;
    let x224_resp = buf[..n].to_vec();

    // TLS over tube
    let tls_cx = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .build()?;
    let tls_cx = tokio_native_tls::TlsConnector::from(tls_cx);
    let tls = tls_cx
        .connect(dest_host, tube_io)
        .await
        .map_err(|e| format!("tls: {e}"))?;
    let chain: Vec<Vec<u8>> = tls
        .get_ref()
        .peer_certificate()
        .ok()
        .flatten()
        .and_then(|c| c.to_der().ok())
        .map(|d| vec![d])
        .unwrap_or_default();

    // RDCleanPath response
    let resp = RDCleanPathPdu::new_response(dest.to_string(), x224_resp, chain)
        .map_err(|e| format!("resp: {e}"))?;
    let resp_bytes = resp.to_der().map_err(|e| format!("enc: {e}"))?;
    tx.send(Message::Binary(resp_bytes.into())).await?;
    log::info!("[rdp_proxy] [TUBE] Response sent, relay");

    // Raw relay over TLS-over-Tube
    let (mut tr, mut tw) = tokio::io::split(tls);
    let w2t = async {
        while let Some(Ok(m)) = rx.next().await {
            if let Message::Binary(d) = m {
                if tw.write_all(&d).await.is_err() {
                    break;
                }
            }
        }
    };
    let t2w = async {
        let mut b = vec![0u8; 16384];
        loop {
            match tr.read(&mut b).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let msg = Message::Binary(b[..n].to_vec().into());
                    if tx.send(msg).await.is_err() {
                        break;
                    }
                }
            }
        }
    };
    tokio::select! { _ = w2t => {} _ = t2w => {} }
    log::info!("[rdp_proxy] [TUBE] Done {dest}");
    Ok(())
}

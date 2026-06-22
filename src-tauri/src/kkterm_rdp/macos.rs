#![allow(dead_code)]

//! macOS RDP client built on IronRDP. Decodes the RDP framebuffer to RGBA and
//! emits `rdp-canvas-event`s for the workspace canvas. Windows uses the native
//! ActiveX path in `rdp.rs` instead; this module is compiled only off-Windows.
//!
//! # Pinned IronRDP connect sequence (verified against ironrdp 0.15 / ironrdp-tokio 0.9)
//!
//! ## Dependencies used
//! - `ironrdp = "0.15"` with features `["connector", "session", "graphics", "pdu", "input"]`
//! - `ironrdp-tokio = "0.9"` (re-exports all of `ironrdp_async` via `pub use ironrdp_async::*`)
//! - `tokio-rustls = "0.26"` (for TLS upgrade — we implement the upgrade directly, no ironrdp-tls)
//! - `sspi = "0.21"` (for CredSSP/NTLM)
//!
//! ## Key types
//! ```text
//! // TokioFramed<S> = Framed<TokioStream<S>>
//! // Framed::new(stream: S::InnerStream) -> Self
//! // TokioStream<S>::InnerStream = S  =>  TokioFramed::new(tcp_stream) works directly
//! ironrdp_tokio::TokioFramed<tokio::net::TcpStream>                       // pre-TLS
//! ironrdp_tokio::TokioFramed<tokio_rustls::client::TlsStream<TcpStream>>  // post-TLS (concrete; see UpgradedFramed)
//! ironrdp::connector::ClientConnector  // config: connector::Config, client_addr: SocketAddr
//! ironrdp::connector::ConnectionResult  // returned by connect_finalize on success
//! ```
//!
//! ## Connect sequence (exact function paths, all from ironrdp_tokio namespace)
//! ```text
//! // Step 1: TCP connect + create framed
//! let stream = tokio::net::TcpStream::connect((host, port)).await?;
//! let client_addr = stream.local_addr()?;
//! let mut framed = ironrdp_tokio::TokioFramed::new(stream);
//!
//! // Step 2: Create connector
//! let mut connector = ironrdp::connector::ClientConnector::new(config, client_addr);
//!
//! // Step 3: Begin connection (negotiation / NLA pre-TLS handshake)
//! let should_upgrade = ironrdp_tokio::connect_begin(&mut framed, &mut connector).await?;
//!
//! // Step 4: Extract inner TCP stream + any leftover bytes
//! let (initial_stream, leftover_bytes) = framed.into_inner();
//!
//! // Step 5: TLS upgrade via tokio-rustls
//! let tls_stream = tls_upgrade(initial_stream, &host).await?;
//!
//! // Step 6: Extract server public key
//! let server_public_key = extract_server_public_key(&tls_stream)?;
//!
//! // Step 7: Mark as upgraded
//! let upgraded = ironrdp_tokio::mark_as_upgraded(should_upgrade, &mut connector);
//!
//! // Step 8: Create upgraded framed over the concrete TLS stream (kept concrete,
//! // not box-erased, so the spawned session future stays `Send`).
//! let mut upgraded_framed = ironrdp_tokio::TokioFramed::new_with_leftover(tls_stream, leftover_bytes);
//!
//! // Step 9: Finalize connection
//! let connection_result = ironrdp_tokio::connect_finalize(
//!     upgraded, connector, &mut upgraded_framed, &mut NoopNetworkClient,
//!     ServerName::new(host), server_public_key, None,
//! ).await?;
//! ```

use crate::cliprdr as cliprdr_module;
use crate::cliprdr::CliprdrAction;
use crate::logging::rdp_debug;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use ironrdp::cliprdr;
use ironrdp::cliprdr::backend::CliprdrBackendFactory as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, MutexGuard},
};
use tauri::{AppHandle, Emitter};
use tokio::{
    net::TcpStream,
    runtime::Runtime,
    sync::{mpsc, oneshot},
};

const DEFAULT_RDP_PORT: u16 = 3389;
const DEFAULT_RDP_WIDTH: u16 = 1280;
const DEFAULT_RDP_HEIGHT: u16 = 800;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RdpClientRoute {
    Direct,
    Socks5 { port: u16 },
}

fn rdp_client_route_label(route: RdpClientRoute) -> String {
    match route {
        RdpClientRoute::Direct => "direct".to_string(),
        RdpClientRoute::Socks5 { port } => format!("socks5:{port}"),
    }
}

fn choose_rdp_client_route(host: &str, socks_port: Option<u16>) -> RdpClientRoute {
    match socks_port {
        Some(port) if port > 0 && !is_private_or_reserved_ip(host) => {
            RdpClientRoute::Socks5 { port }
        }
        _ => RdpClientRoute::Direct,
    }
}

fn is_private_or_reserved_ip(host: &str) -> bool {
    let Ok(ip) = host.parse::<std::net::IpAddr>() else {
        return false;
    };

    match ip {
        std::net::IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 0
                || o[0] == 10
                || (o[0] == 100 && (o[1] & 0xC0) == 64)
                || o[0] == 127
                || (o[0] == 169 && o[1] == 254)
                || (o[0] == 172 && (o[1] & 0xF0) == 16)
                || (o[0] == 192 && o[1] == 0 && o[2] == 0)
                || (o[0] == 192 && o[1] == 0 && o[2] == 2)
                || (o[0] == 192 && o[1] == 168)
                || (o[0] == 192 && o[1] == 88 && o[2] == 99)
                || (o[0] == 198 && (o[1] & 0xFE) == 18)
                || (o[0] == 198 && o[1] == 51 && o[2] == 100)
                || (o[0] == 203 && o[1] == 0 && o[2] == 113)
                || o[0] >= 224
        }
        std::net::IpAddr::V6(v6) => {
            let s = v6.segments();
            v6.is_loopback()
                || v6.is_unspecified()
                || (s[0] & 0xFE00) == 0xFC00
                || (s[0] & 0xFFC0) == 0xFE80
                || (s[0] & 0xFF00) == 0xFF00
        }
    }
}

// ── Session manager ───────────────────────────────────────────────────────────

pub struct RdpClientSessionManager {
    runtime: Runtime,
    sessions: Mutex<HashMap<String, RdpClientSession>>,
    starting_sessions: Mutex<HashSet<String>>,
}

struct RdpClientSession {
    input: mpsc::UnboundedSender<RdpInput>,
    stop: Option<oneshot::Sender<()>>,
    connected: bool,
}

/// Input operations queued from the frontend, translated to IronRDP input in
/// the event loop (Task 4/5).
enum RdpInput {
    Pointer {
        x: u16,
        y: u16,
        button_mask: u8,
    },
    Key {
        scancode: u16,
        down: bool,
    },
    /// Composed text (IME / printable characters) sent as RDP Unicode keyboard
    /// events — layout- and IME-independent, unlike scancodes.
    Text(String),
    CtrlAltDelete,
}

fn rdp_input_debug(input: &RdpInput) -> serde_json::Value {
    match input {
        RdpInput::Pointer { x, y, button_mask } => {
            json!({ "kind": "pointer", "x": x, "y": y, "buttonMask": button_mask })
        }
        RdpInput::Key { scancode, down } => {
            json!({ "kind": "key", "scancode": scancode, "down": down })
        }
        RdpInput::Text(text) => {
            json!({ "kind": "text", "length": text.chars().count(), "text": text })
        }
        RdpInput::CtrlAltDelete => json!({ "kind": "ctrlAltDelete" }),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRdpClientSessionRequest {
    session_id: String,
    host: String,
    port: Option<u16>,
    username: String,
    #[serde(default)]
    domain: Option<String>,
    #[serde(rename = "secretOwnerId")]
    _secret_owner_id: Option<String>,
    password: Option<String>,
    #[serde(default)]
    desktop_width: Option<u16>,
    #[serde(default)]
    desktop_height: Option<u16>,
    #[serde(default)]
    socks_proxy_port: Option<u16>,
}

impl StartRdpClientSessionRequest {
    pub fn from_kkterm_start(
        request: crate::kkterm_rdp::types::KktermRdpStartRequest,
        socks_proxy_port: Option<u16>,
    ) -> Self {
        let session_id = crate::kkterm_rdp::types::session_id_from_tab_id(&request.tab_id);
        Self {
            session_id,
            host: request.host,
            port: Some(request.port),
            username: request.username,
            domain: request.domain,
            _secret_owner_id: None,
            password: Some(request.password),
            desktop_width: request.desktop_width,
            desktop_height: request.desktop_height,
            socks_proxy_port,
        }
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    fn desktop_width(&self) -> u16 {
        self.desktop_width
            .filter(|v| *v > 0)
            .unwrap_or(DEFAULT_RDP_WIDTH)
    }
    fn desktop_height(&self) -> u16 {
        self.desktop_height
            .filter(|v| *v > 0)
            .unwrap_or(DEFAULT_RDP_HEIGHT)
    }
    pub fn set_socks_proxy_port(&mut self, port: Option<u16>) {
        self.socks_proxy_port = port;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpClientSessionStarted {
    session_id: String,
    host: String,
    port: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpClientSessionStatus {
    session_id: String,
    connected: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpClientPointerEventRequest {
    session_id: String,
    x: u16,
    y: u16,
    button_mask: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpClientKeyEventRequest {
    session_id: String,
    scancode: u16,
    down: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpClientTextRequest {
    session_id: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpClientSimpleRequest {
    session_id: String,
}

impl RdpClientPointerEventRequest {
    pub fn from_kkterm_pointer(request: crate::kkterm_rdp::types::KktermRdpPointerRequest) -> Self {
        Self {
            session_id: crate::kkterm_rdp::types::session_id_from_tab_id(&request.tab_id),
            x: request.x,
            y: request.y,
            button_mask: request.button_mask,
        }
    }
}

impl RdpClientKeyEventRequest {
    pub fn from_kkterm_key(request: crate::kkterm_rdp::types::KktermRdpKeyRequest) -> Self {
        Self {
            session_id: crate::kkterm_rdp::types::session_id_from_tab_id(&request.tab_id),
            scancode: request.scancode,
            down: request.down,
        }
    }
}

impl RdpClientTextRequest {
    pub fn from_kkterm_text(request: crate::kkterm_rdp::types::KktermRdpTextRequest) -> Self {
        Self {
            session_id: crate::kkterm_rdp::types::session_id_from_tab_id(&request.tab_id),
            text: request.text,
        }
    }
}

impl RdpClientSimpleRequest {
    pub fn from_kkterm_simple(request: crate::kkterm_rdp::types::KktermRdpSimpleRequest) -> Self {
        Self {
            session_id: crate::kkterm_rdp::types::session_id_from_tab_id(&request.tab_id),
        }
    }

    pub fn from_tab_id(tab_id: String) -> Self {
        Self {
            session_id: crate::kkterm_rdp::types::session_id_from_tab_id(&tab_id),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
enum RdpCanvasEvent {
    Connected {
        session_id: String,
        name: String,
    },
    Resolution {
        session_id: String,
        width: u16,
        height: u16,
    },
    RawImage {
        session_id: String,
        x: u16,
        y: u16,
        width: u16,
        height: u16,
        rgba: String,
    },
    SetCursor {
        session_id: String,
        width: u16,
        height: u16,
        hot_x: u16,
        hot_y: u16,
        rgba: String,
    },
    Error {
        session_id: String,
        message: String,
    },
    Disconnected {
        session_id: String,
    },
}

impl RdpClientSessionManager {
    pub fn new() -> Self {
        Self {
            runtime: Runtime::new().expect("RDP client runtime initializes"),
            sessions: Mutex::new(HashMap::new()),
            starting_sessions: Mutex::new(HashSet::new()),
        }
    }

    pub fn start_session(
        &self,
        app: AppHandle,
        request: StartRdpClientSessionRequest,
    ) -> Result<RdpClientSessionStarted, String> {
        let session_id = required_id(request.session_id.clone())?;
        let host = {
            let h = request.host.trim().to_string();
            if h.is_empty() {
                return Err("RDP host is required".to_string());
            }
            h
        };
        let port = request.port.unwrap_or(DEFAULT_RDP_PORT);
        if port == 0 {
            return Err("RDP port must be between 1 and 65535".to_string());
        }

        {
            let sessions = self.lock_sessions()?;
            if sessions.contains_key(&session_id) {
                rdp_debug(
                    "ironrdp.start.duplicate_active",
                    &json!({
                        "sessionId": session_id,
                        "host": host,
                        "port": port,
                    }),
                );
                return Ok(RdpClientSessionStarted {
                    session_id,
                    host,
                    port,
                });
            }
        }

        if !self.reserve_session_start(&session_id)? {
            rdp_debug(
                "ironrdp.start.duplicate_in_flight",
                &json!({
                    "sessionId": session_id,
                    "host": host,
                    "port": port,
                }),
            );
            return Ok(RdpClientSessionStarted {
                session_id,
                host,
                port,
            });
        }

        let width = request.desktop_width();
        let height = request.desktop_height();
        let username = request.username.clone();
        let password = request.password.clone().unwrap_or_default();
        let domain = request.domain.clone();
        let socks_proxy_port = request.socks_proxy_port;

        rdp_debug(
            "ironrdp.start.request",
            &rdp_client_start_debug_payload(
                &session_id,
                &host,
                port,
                &username,
                domain.as_deref(),
                width,
                height,
                socks_proxy_port,
            ),
        );

        let (cliprdr_tx, cliprdr_rx) = mpsc::unbounded_channel::<CliprdrAction>();
        let temp_dir = dirs::cache_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("NextDesk")
            .join("kkterm-cliprdr");
        let _ = std::fs::create_dir_all(&temp_dir);
        let temp_dir_str = temp_dir.to_string_lossy().to_string();

        let (connection_result, framed) = match self.runtime.block_on(rdp_connect(
            session_id.clone(),
            host.clone(),
            port,
            username,
            password,
            domain,
            width,
            height,
            socks_proxy_port,
            cliprdr_tx,
            app.clone(),
            temp_dir_str,
        )) {
            Ok(result) => result,
            Err(error) => {
                self.release_session_start(&session_id);
                rdp_debug(
                    "ironrdp.start.error",
                    &json!({
                        "sessionId": session_id,
                        "host": host,
                        "port": port,
                        "error": error,
                    }),
                );
                return Err(format!("RDP connect failed: {error}"));
            }
        };

        rdp_debug(
            "ironrdp.start.ok",
            &json!({
                "sessionId": session_id,
                "host": host,
                "port": port,
                "desktopWidth": connection_result.desktop_size.width,
                "desktopHeight": connection_result.desktop_size.height,
            }),
        );

        let (stop_tx, stop_rx) = oneshot::channel();
        let (input_tx, input_rx) = mpsc::unbounded_channel();

        spawn_rdp_event_loop(
            &self.runtime,
            app,
            session_id.clone(),
            connection_result,
            framed,
            input_rx,
            cliprdr_rx,
            stop_rx,
        );

        let mut sessions = match self.lock_sessions() {
            Ok(sessions) => sessions,
            Err(error) => {
                self.release_session_start(&session_id);
                return Err(error);
            }
        };
        sessions.insert(
            session_id.clone(),
            RdpClientSession {
                input: input_tx,
                stop: Some(stop_tx),
                connected: true,
            },
        );
        self.release_session_start(&session_id);

        Ok(RdpClientSessionStarted {
            session_id,
            host,
            port,
        })
    }

    pub fn pointer_event(&self, request: RdpClientPointerEventRequest) -> Result<(), String> {
        self.queue_input(
            &request.session_id,
            RdpInput::Pointer {
                x: request.x,
                y: request.y,
                button_mask: request.button_mask,
            },
        )
    }

    pub fn key_event(&self, request: RdpClientKeyEventRequest) -> Result<(), String> {
        self.queue_input(
            &request.session_id,
            RdpInput::Key {
                scancode: request.scancode,
                down: request.down,
            },
        )
    }

    pub fn text_input(&self, request: RdpClientTextRequest) -> Result<(), String> {
        self.queue_input(&request.session_id, RdpInput::Text(request.text))
    }

    pub fn send_ctrl_alt_delete(&self, request: RdpClientSimpleRequest) -> Result<(), String> {
        self.queue_input(&request.session_id, RdpInput::CtrlAltDelete)
    }

    pub fn close_session(&self, request: RdpClientSimpleRequest) -> Result<(), String> {
        let removed = {
            let mut sessions = self.lock_sessions()?;
            sessions.remove(&request.session_id)
        };
        if let Some(mut session) = removed {
            if let Some(stop) = session.stop.take() {
                let _ = stop.send(());
            }
        }
        Ok(())
    }

    pub fn session_status(
        &self,
        request: RdpClientSimpleRequest,
    ) -> Result<RdpClientSessionStatus, String> {
        let sessions = self.lock_sessions()?;
        let connected = sessions
            .get(&request.session_id)
            .map(|s| s.connected)
            .unwrap_or(false);
        Ok(RdpClientSessionStatus {
            session_id: request.session_id,
            connected,
        })
    }

    fn queue_input(&self, session_id: &str, input: RdpInput) -> Result<(), String> {
        let debug = rdp_input_debug(&input);
        rdp_debug(
            "input.queue",
            &json!({
                "sessionId": session_id,
                "input": debug,
            }),
        );
        let sessions = self.lock_sessions()?;
        let tx = sessions
            .get(session_id)
            .map(|s| s.input.clone())
            .ok_or_else(|| format!("RDP session '{session_id}' was not found"))?;
        tx.send(input)
            .map_err(|_| format!("RDP session '{session_id}' input channel is closed"))
    }

    fn lock_sessions(&self) -> Result<MutexGuard<'_, HashMap<String, RdpClientSession>>, String> {
        self.sessions
            .lock()
            .map_err(|_| "RDP session lock is poisoned".to_string())
    }

    fn reserve_session_start(&self, session_id: &str) -> Result<bool, String> {
        let mut starting = self
            .starting_sessions
            .lock()
            .map_err(|_| "RDP starting-session lock is poisoned".to_string())?;
        Ok(starting.insert(session_id.to_string()))
    }

    fn release_session_start(&self, session_id: &str) {
        if let Ok(mut starting) = self.starting_sessions.lock() {
            starting.remove(session_id);
        }
    }
}

fn rdp_client_start_debug_payload(
    session_id: &str,
    host: &str,
    port: u16,
    username: &str,
    domain: Option<&str>,
    desktop_width: u16,
    desktop_height: u16,
    socks_proxy_port: Option<u16>,
) -> Value {
    let route = choose_rdp_client_route(host, socks_proxy_port);
    json!({
        "sessionId": session_id,
        "host": host,
        "port": port,
        "username": username,
        "domain": domain,
        "desktopWidth": desktop_width,
        "desktopHeight": desktop_height,
        "route": rdp_client_route_label(route),
        "socksProxyPort": socks_proxy_port,
        "security": {
            "enableCredSsp": true,
            "enableTls": false,
            "requestedProtocols": ["HYBRID", "HYBRID_EX"],
            "legacyTlsFallbackAllowed": false,
        },
    })
}

// ── No-op NetworkClient (safe for NTLM; Kerberos KDC round-trips never happen) ──

struct NoopNetworkClient;

impl ironrdp_tokio::NetworkClient for NoopNetworkClient {
    async fn send(
        &mut self,
        _request: &ironrdp::connector::sspi::generator::NetworkRequest,
    ) -> ironrdp::connector::ConnectorResult<Vec<u8>> {
        Err(ironrdp::connector::general_err!(
            "no KDC network client; use NTLM credentials not Kerberos"
        ))
    }
}

// ── TLS: NoCertificateVerification (RDP never verifies the cert chain) ────────

#[derive(Debug)]
struct NoCertificateVerification(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for NoCertificateVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dsa: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dsa,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dsa: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dsa,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

async fn tls_upgrade(
    stream: TcpStream,
    session_id: &str,
    host: &str,
    port: u16,
    server_name: &str,
) -> Result<tokio_rustls::client::TlsStream<TcpStream>, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let cipher_suites: Vec<String> = provider
        .cipher_suites
        .iter()
        .map(|suite| format!("{:?}", suite.suite()))
        .collect();
    rdp_debug(
        "ironrdp.tls.start",
        &json!({
            "sessionId": session_id,
            "host": host,
            "port": port,
            "serverName": server_name,
            "protocolVersions": ["TLS1.2", "TLS1.3"],
            "cipherSuites": cipher_suites,
            "sessionResumption": false,
            "certificateVerification": "disabled_for_rdp",
        }),
    );

    let tls_config = rustls::ClientConfig::builder_with_provider(Arc::clone(&provider))
        .with_protocol_versions(&[&rustls::version::TLS12, &rustls::version::TLS13])
        .map_err(|e| format!("TLS config error: {e}"))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(NoCertificateVerification(provider)))
        .with_no_client_auth();

    // Disable TLS session resumption — CredSSP/MS-CSSP requires it.
    let mut tls_config = tls_config;
    tls_config.resumption = rustls::client::Resumption::disabled();

    let connector = tokio_rustls::TlsConnector::from(Arc::new(tls_config));
    let dns_name = rustls::pki_types::ServerName::try_from(server_name.to_string())
        .map_err(|e| format!("invalid server name '{server_name}': {e}"))?;
    match connector.connect(dns_name, stream).await {
        Ok(tls_stream) => {
            let (_, session) = tls_stream.get_ref();
            rdp_debug(
                "ironrdp.tls.ok",
                &json!({
                    "sessionId": session_id,
                    "host": host,
                    "port": port,
                    "protocolVersion": session.protocol_version().map(|version| format!("{version:?}")),
                    "cipherSuite": session
                        .negotiated_cipher_suite()
                        .map(|suite| format!("{:?}", suite.suite())),
                    "peerCertificateCount": session.peer_certificates().map(|certs| certs.len()).unwrap_or(0),
                }),
            );
            Ok(tls_stream)
        }
        Err(error) => {
            rdp_debug(
                "ironrdp.tls.error",
                &json!({
                    "sessionId": session_id,
                    "host": host,
                    "port": port,
                    "error": error.to_string(),
                    "errorKind": tls_error_kind(&error),
                }),
            );
            Err(format!("TLS handshake failed: {error}"))
        }
    }
}

fn extract_server_public_key(
    session_id: &str,
    tls_stream: &tokio_rustls::client::TlsStream<TcpStream>,
) -> Result<Vec<u8>, String> {
    use x509_cert::der::Decode as _;

    let (_, session) = tls_stream.get_ref();
    let cert_der = session
        .peer_certificates()
        .and_then(|certs| certs.first())
        .ok_or_else(|| "RDP server sent no TLS certificate".to_string())?;

    let cert = x509_cert::Certificate::from_der(cert_der.as_ref())
        .map_err(|e| format!("failed to parse server certificate: {e}"))?;

    let spki_bytes = cert
        .tbs_certificate
        .subject_public_key_info
        .subject_public_key
        .as_bytes()
        .ok_or_else(|| "server certificate subject public key is not a bitstring".to_string())?
        .to_vec();

    rdp_debug(
        "ironrdp.certificate.ok",
        &json!({
            "sessionId": session_id,
            "peerCertificateCount": session.peer_certificates().map(|certs| certs.len()).unwrap_or(0),
            "subjectPublicKeyBytes": spki_bytes.len(),
        }),
    );

    Ok(spki_bytes)
}

// ── Connect helper ────────────────────────────────────────────────────────────

type UpgradedFramed = ironrdp_tokio::TokioFramed<tokio_rustls::client::TlsStream<TcpStream>>;

/// Flatten an error and its `source()` chain into one message, so a generic
/// top-level label (e.g. "CredSSP") surfaces the underlying reason
/// (e.g. an NTLM logon failure) instead of being swallowed.
fn error_chain(error: &dyn std::error::Error) -> String {
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(inner) = source {
        let inner_text = inner.to_string();
        if !message.ends_with(&inner_text) {
            message.push_str(": ");
            message.push_str(&inner_text);
        }
        source = inner.source();
    }
    message
}

fn tls_error_kind(error: &std::io::Error) -> String {
    format!("{:?}", error.kind())
}

async fn rdp_connect(
    session_id: String,
    host: String,
    port: u16,
    username: String,
    password: String,
    domain: Option<String>,
    width: u16,
    height: u16,
    socks_proxy_port: Option<u16>,
    cliprdr_action_tx: mpsc::UnboundedSender<CliprdrAction>,
    app: AppHandle,
    cliprdr_temp_dir: String,
) -> Result<(ironrdp::connector::ConnectionResult, UpgradedFramed), String> {
    use ironrdp::connector::{
        credssp::KerberosConfig, ClientConnector, Config, Credentials, DesktopSize, ServerName,
    };
    use ironrdp::pdu::gcc::KeyboardType;
    use ironrdp::pdu::rdp::capability_sets::MajorPlatformType;
    use ironrdp_tokio::{connect_begin, connect_finalize, mark_as_upgraded, TokioFramed};

    // CredSSP/NTLM needs the domain separated from the username. Split a
    // `DOMAIN\user` login into (domain, user); otherwise keep the requested
    // domain and the username as-is (UPN `user@domain` is left intact).
    let (username, domain) = match username.split_once('\\') {
        Some((d, u)) if !d.trim().is_empty() && !u.trim().is_empty() => {
            (u.trim().to_string(), Some(d.trim().to_string()))
        }
        _ => (username, domain),
    };

    // Step 1: TCP connect + create framed
    let route = choose_rdp_client_route(&host, socks_proxy_port);
    let route_label = rdp_client_route_label(route);
    rdp_debug(
        "ironrdp.tcp.start",
        &json!({
            "sessionId": session_id,
            "host": host,
            "port": port,
            "route": route_label,
            "socksProxyPort": socks_proxy_port,
        }),
    );
    let stream = match connect_rdp_transport(host.as_str(), port, route).await {
        Ok(stream) => stream,
        Err(error) => {
            rdp_debug(
                "ironrdp.tcp.error",
                &json!({
                    "sessionId": session_id,
                    "host": host,
                    "port": port,
                    "route": route_label,
                    "socksProxyPort": socks_proxy_port,
                    "error": error,
                }),
            );
            return Err(format!(
                "TCP connect to {host}:{port} via {route_label} failed: {error}"
            ));
        }
    };
    let client_addr = stream.local_addr().map_err(|e| e.to_string())?;
    let peer_addr = stream.peer_addr().ok();
    rdp_debug(
        "ironrdp.tcp.ok",
        &json!({
            "sessionId": session_id,
            "host": host,
            "port": port,
            "route": route_label,
            "socksProxyPort": socks_proxy_port,
            "clientAddr": client_addr.to_string(),
            "peerAddr": peer_addr.map(|addr| addr.to_string()),
        }),
    );
    let mut framed: TokioFramed<TcpStream> = TokioFramed::new(stream);

    // Step 2: Build connector config
    let config = Config {
        credentials: Credentials::UsernamePassword { username, password },
        domain,
        enable_tls: false,
        enable_credssp: true,
        desktop_size: DesktopSize { width, height },
        desktop_scale_factor: 0,
        keyboard_type: KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_functional_keys_count: 12,
        keyboard_layout: 0x0409, // en-US
        ime_file_name: String::new(),
        enable_server_pointer: true,
        pointer_software_rendering: false,
        client_build: 0,
        client_name: "KKTerm".to_string(),
        client_dir: String::new(),
        platform: MajorPlatformType::UNIX,
        hardware_id: None,
        bitmap: None,
        compression_type: None,
        performance_flags: ironrdp::pdu::rdp::client_info::PerformanceFlags::default(),
        autologon: false,
        enable_audio_playback: false,
        timezone_info: ironrdp::pdu::rdp::client_info::TimezoneInfo::default(),
        license_cache: None,
        multitransport_flags: None,
        alternate_shell: String::new(),
        work_dir: String::new(),
        dig_product_id: String::new(),
        request_data: None,
    };

    // Step 3: Create connector + begin
    rdp_debug(
        "ironrdp.connect_begin.start",
        &json!({
            "sessionId": session_id,
            "host": host,
            "port": port,
            "clientAddr": client_addr.to_string(),
            "username": match &config.credentials {
                Credentials::UsernamePassword { username, .. } => username.as_str(),
                Credentials::SmartCard { .. } => "smart_card",
            },
            "domain": config.domain.as_deref(),
            "desktopWidth": width,
            "desktopHeight": height,
            "security": {
                "enableCredSsp": config.enable_credssp,
                "enableTls": config.enable_tls,
                "requestedProtocols": ["HYBRID", "HYBRID_EX"],
                "legacyTlsFallbackAllowed": config.enable_tls,
            },
        }),
    );
    let cliprdr_factory =
        cliprdr_module::build_factory(cliprdr_action_tx, app, cliprdr_temp_dir, session_id.clone());
    let cliprdr = cliprdr::Cliprdr::new(cliprdr_factory.build_cliprdr_backend());
    let mut connector = ClientConnector::new(config, client_addr);
    connector.attach_static_channel(cliprdr);
    rdp_debug(
        "ironrdp.cliprdr.attach",
        &json!({
            "sessionId": session_id,
            "host": host,
            "port": port,
        }),
    );
    let should_upgrade = match connect_begin(&mut framed, &mut connector).await {
        Ok(should_upgrade) => should_upgrade,
        Err(error) => {
            let error = error_chain(&error);
            rdp_debug(
                "ironrdp.connect_begin.error",
                &json!({
                    "sessionId": session_id,
                    "host": host,
                    "port": port,
                    "error": error,
                }),
            );
            return Err(format!("RDP connect_begin failed: {error}"));
        }
    };
    rdp_debug(
        "ironrdp.connect_begin.ok",
        &json!({
            "sessionId": session_id,
            "host": host,
            "port": port,
        }),
    );

    // Step 4: Extract inner stream
    let (tcp_stream, leftover) = framed.into_inner();
    rdp_debug(
        "ironrdp.security_upgrade.ready",
        &json!({
            "sessionId": session_id,
            "host": host,
            "port": port,
            "leftoverBytes": leftover.len(),
        }),
    );

    // Step 5: TLS upgrade
    let tls_stream = tls_upgrade(tcp_stream, &session_id, &host, port, &host).await?;

    // Step 6: Extract server public key
    let server_public_key = extract_server_public_key(&session_id, &tls_stream)?;

    // Step 7: Mark as upgraded
    let upgraded = mark_as_upgraded(should_upgrade, &mut connector);

    // Step 8: Create upgraded framed over the concrete TLS stream
    let mut upgraded_framed: UpgradedFramed = TokioFramed::new_with_leftover(tls_stream, leftover);

    // Step 9: Finalize
    rdp_debug(
        "ironrdp.connect_finalize.start",
        &json!({
            "sessionId": session_id,
            "host": host,
            "port": port,
        }),
    );
    let connection_result = match connect_finalize::<_, NoopNetworkClient>(
        upgraded,
        connector,
        &mut upgraded_framed,
        &mut NoopNetworkClient,
        ServerName::new(host.clone()),
        server_public_key,
        None::<KerberosConfig>,
    )
    .await
    {
        Ok(connection_result) => connection_result,
        Err(error) => {
            let error = error_chain(&error);
            rdp_debug(
                "ironrdp.connect_finalize.error",
                &json!({
                    "sessionId": session_id,
                    "host": host,
                    "port": port,
                    "error": error,
                }),
            );
            return Err(format!("RDP connect_finalize failed: {error}"));
        }
    };
    rdp_debug(
        "ironrdp.connect_finalize.ok",
        &json!({
            "sessionId": session_id,
            "host": host,
            "port": port,
            "desktopWidth": connection_result.desktop_size.width,
            "desktopHeight": connection_result.desktop_size.height,
        }),
    );

    Ok((connection_result, upgraded_framed))
}

async fn connect_rdp_transport(
    host: &str,
    port: u16,
    route: RdpClientRoute,
) -> Result<TcpStream, String> {
    match route {
        RdpClientRoute::Direct => TcpStream::connect((host, port))
            .await
            .map_err(|error| error.to_string()),
        RdpClientRoute::Socks5 { port: socks_port } => {
            let socks_addr = format!("127.0.0.1:{socks_port}");
            tokio_socks::tcp::Socks5Stream::connect(socks_addr.as_str(), (host, port))
                .await
                .map(|stream| stream.into_inner())
                .map_err(|error| error.to_string())
        }
    }
}

// ── Event loop ────────────────────────────────────────────────────────────────

fn spawn_rdp_event_loop(
    runtime: &Runtime,
    app: AppHandle,
    session_id: String,
    connection_result: ironrdp::connector::ConnectionResult,
    mut framed: UpgradedFramed,
    mut input_rx: mpsc::UnboundedReceiver<RdpInput>,
    mut cliprdr_rx: mpsc::UnboundedReceiver<CliprdrAction>,
    mut stop: oneshot::Receiver<()>,
) {
    runtime.spawn(async move {
        eprintln!("[rdp {session_id}] event loop starting");
        rdp_debug(
            "ironrdp.event_loop.start",
            &json!({
                "sessionId": session_id,
            }),
        );

        let width = connection_result.desktop_size.width;
        let height = connection_result.desktop_size.height;

        emit_rdp_event(
            &app,
            RdpCanvasEvent::Connected {
                session_id: session_id.clone(),
                name: "RDP".to_string(),
            },
        );
        emit_rdp_event(
            &app,
            RdpCanvasEvent::Resolution { session_id: session_id.clone(), width, height },
        );

        let mut image = ironrdp::session::image::DecodedImage::new(
            ironrdp::graphics::image_processing::PixelFormat::RgbA32,
            width,
            height,
        );
        let mut active_stage = ironrdp::session::ActiveStage::new(connection_result);
        let mut input_db = ironrdp::input::Database::new();
        let mut last_button_mask: u8 = 0;

        use ironrdp_tokio::FramedWrite as _;

        loop {
            tokio::select! {
                _ = &mut stop => {
                    eprintln!("[rdp {session_id}] stop signal received");
                    break;
                }
                input = input_rx.recv() => {
                    match input {
                        Some(rdp_input) => {
                            if let Err(e) = send_rdp_input(&mut framed, &mut input_db, &mut last_button_mask, rdp_input).await {
                                eprintln!("[rdp {session_id}] send_rdp_input error: {e}");
                                rdp_debug(
                                    "ironrdp.input.error",
                                    &json!({
                                        "sessionId": session_id,
                                        "error": e,
                                    }),
                                );
                                emit_rdp_event(&app, RdpCanvasEvent::Error {
                                    session_id: session_id.clone(),
                                    message: e,
                                });
                                break;
                            }
                        }
                        None => break,
                    }
                }
                cliprdr_action = cliprdr_rx.recv() => {
                    let Some(action) = cliprdr_action else {
                        continue;
                    };
                    use ironrdp::cliprdr::Client as CliprdrClient;
                    use ironrdp::cliprdr::Cliprdr;

                    let svc_messages = {
                        let Some(cliprdr) = active_stage
                            .get_svc_processor_mut::<Cliprdr<CliprdrClient>>()
                        else {
                            rdp_debug(
                                "ironrdp.cliprdr.processor_missing",
                                &json!({
                                    "sessionId": session_id,
                                }),
                            );
                            continue;
                        };

                        match action {
                        CliprdrAction::InitiateCopy(formats) => {
                            rdp_debug(
                                "ironrdp.cliprdr.initiate_copy",
                                &json!({
                                    "sessionId": session_id,
                                    "formatCount": formats.len(),
                                }),
                            );
                            match cliprdr.initiate_copy(&formats) {
                                Ok(messages) => messages,
                                Err(error) => {
                                    rdp_debug(
                                        "ironrdp.cliprdr.initiate_copy.error",
                                        &json!({
                                            "sessionId": session_id,
                                            "error": error.to_string(),
                                        }),
                                    );
                                    continue;
                                }
                            }
                        }
                        CliprdrAction::InitiatePaste(format_id) => {
                            rdp_debug(
                                "ironrdp.cliprdr.initiate_paste",
                                &json!({
                                    "sessionId": session_id,
                                    "formatId": format_id.value(),
                                }),
                            );
                            match cliprdr.initiate_paste(format_id) {
                                Ok(messages) => messages,
                                Err(error) => {
                                    rdp_debug(
                                        "ironrdp.cliprdr.initiate_paste.error",
                                        &json!({
                                            "sessionId": session_id,
                                            "formatId": format_id.value(),
                                            "error": error.to_string(),
                                        }),
                                    );
                                    continue;
                                }
                            }
                        }
                        CliprdrAction::SubmitFormatData(response) => {
                            rdp_debug(
                                "ironrdp.cliprdr.submit_format_data",
                                &json!({
                                    "sessionId": session_id,
                                }),
                            );
                            match cliprdr.submit_format_data(response) {
                                Ok(messages) => messages,
                                Err(error) => {
                                    rdp_debug(
                                        "ironrdp.cliprdr.submit_format_data.error",
                                        &json!({
                                            "sessionId": session_id,
                                            "error": error.to_string(),
                                        }),
                                    );
                                    continue;
                                }
                            }
                        }
                        CliprdrAction::SubmitFileContents(response) => {
                            let stream_id = response.stream_id();
                            let data_len = response.data().len();
                            rdp_debug(
                                "ironrdp.cliprdr.submit_file_contents",
                                &json!({
                                    "sessionId": session_id,
                                    "streamId": stream_id,
                                    "dataLen": data_len,
                                }),
                            );
                            match cliprdr.submit_file_contents(response) {
                                Ok(messages) => messages,
                                Err(error) => {
                                    rdp_debug(
                                        "ironrdp.cliprdr.submit_file_contents.error",
                                        &json!({
                                            "sessionId": session_id,
                                            "streamId": stream_id,
                                            "error": error.to_string(),
                                        }),
                                    );
                                    continue;
                                }
                            }
                        }
                        CliprdrAction::RequestFileContents(request) => {
                            rdp_debug(
                                "ironrdp.cliprdr.request_file_contents",
                                &json!({
                                    "sessionId": session_id,
                                    "streamId": request.stream_id,
                                }),
                            );
                            match cliprdr.request_file_contents(request) {
                                Ok(messages) => messages,
                                Err(error) => {
                                    rdp_debug(
                                        "ironrdp.cliprdr.request_file_contents.error",
                                        &json!({
                                            "sessionId": session_id,
                                            "error": error.to_string(),
                                        }),
                                    );
                                    continue;
                                }
                            }
                        }
                        }
                    };

                    let frame = match active_stage.process_svc_processor_messages(svc_messages) {
                        Ok(frame) => frame,
                        Err(error) => {
                            rdp_debug(
                                "ironrdp.cliprdr.encode.error",
                                &json!({
                                    "sessionId": session_id,
                                    "error": error.to_string(),
                                }),
                            );
                            continue;
                        }
                    };
                    if let Err(error) = framed.write_all(&frame).await {
                        rdp_debug(
                            "ironrdp.cliprdr.write.error",
                            &json!({
                                "sessionId": session_id,
                                "error": error.to_string(),
                            }),
                        );
                        emit_rdp_event(&app, RdpCanvasEvent::Error {
                            session_id: session_id.clone(),
                            message: error.to_string(),
                        });
                        break;
                    }
                }
                pdu = framed.read_pdu() => {
                    match pdu {
                        Ok((action, payload)) => {
                            let outputs = match active_stage.process(&mut image, action, &payload) {
                                Ok(outputs) => outputs,
                                Err(e) => {
                                    eprintln!("[rdp {session_id}] active_stage.process error: {e}");
                                    rdp_debug(
                                        "ironrdp.active_stage.error",
                                        &json!({
                                            "sessionId": session_id,
                                            "error": e.to_string(),
                                        }),
                                    );
                                    emit_rdp_event(&app, RdpCanvasEvent::Error {
                                        session_id: session_id.clone(),
                                        message: e.to_string(),
                                    });
                                    break;
                                }
                            };

                            let mut should_break = false;
                            for output in outputs {
                                use ironrdp::session::ActiveStageOutput;
                                match output {
                                    ActiveStageOutput::ResponseFrame(frame) => {
                                        if let Err(e) = framed.write_all(&frame).await {
                                            eprintln!("[rdp {session_id}] write_all error: {e}");
                                            rdp_debug(
                                                "ironrdp.write.error",
                                                &json!({
                                                    "sessionId": session_id,
                                                    "error": e.to_string(),
                                                }),
                                            );
                                            emit_rdp_event(&app, RdpCanvasEvent::Error {
                                                session_id: session_id.clone(),
                                                message: e.to_string(),
                                            });
                                            should_break = true;
                                            break;
                                        }
                                    }
                                    ActiveStageOutput::GraphicsUpdate(region) => {
                                        let rx = u16::try_from(region.left).unwrap_or(0);
                                        let ry = u16::try_from(region.top).unwrap_or(0);
                                        let rw = u16::try_from(
                                            region.right.saturating_sub(region.left).saturating_add(1)
                                        ).unwrap_or(0);
                                        let rh = u16::try_from(
                                            region.bottom.saturating_sub(region.top).saturating_add(1)
                                        ).unwrap_or(0);
                                        let image_data = image.data();
                                        let rect_rgba = extract_rgba_rect(image_data, width, rx, ry, rw, rh);
                                        emit_rdp_event(&app, RdpCanvasEvent::RawImage {
                                            session_id: session_id.clone(),
                                            x: rx,
                                            y: ry,
                                            width: rw,
                                            height: rh,
                                            rgba: BASE64.encode(rect_rgba),
                                        });
                                    }
                                    ActiveStageOutput::PointerBitmap(pointer) => {
                                        let event = cursor_event(&session_id, &pointer);
                                        emit_rdp_event(&app, event);
                                    }
                                    ActiveStageOutput::Terminate(_reason) => {
                                        eprintln!("[rdp {session_id}] server initiated disconnect");
                                        rdp_debug(
                                            "ironrdp.server_disconnect",
                                            &json!({
                                                "sessionId": session_id,
                                            }),
                                        );
                                        should_break = true;
                                        break;
                                    }
                                    _ => {}
                                }
                            }
                            if should_break {
                                break;
                            }
                        }
                        Err(e) => {
                            eprintln!("[rdp {session_id}] read_pdu error: {e}");
                            rdp_debug(
                                "ironrdp.read.error",
                                &json!({
                                    "sessionId": session_id,
                                    "error": e.to_string(),
                                }),
                            );
                            emit_rdp_event(&app, RdpCanvasEvent::Error {
                                session_id: session_id.clone(),
                                message: e.to_string(),
                            });
                            break;
                        }
                    }
                }
            }
        }

        eprintln!("[rdp {session_id}] event loop exiting");
        rdp_debug(
            "ironrdp.event_loop.exit",
            &json!({
                "sessionId": session_id,
            }),
        );
        emit_rdp_event(&app, RdpCanvasEvent::Disconnected { session_id });
    });
}

// ── Input stub (Task 5 fills in real IronRDP input encoding) ──────────────────

/// Detect press/release transitions for the three primary mouse buttons between
/// a previous and current VNC-style button mask (bit 0 = left, 1 = middle,
/// 2 = right). Returns `(button_bit, pressed)` for each changed button.
fn primary_button_transitions(prev: u8, now: u8) -> Vec<(u8, bool)> {
    let mut out = Vec::new();
    for bit in 0..3u8 {
        let was = prev & (1 << bit) != 0;
        let is = now & (1 << bit) != 0;
        if is != was {
            out.push((bit, is));
        }
    }
    out
}

fn mouse_button_for_bit(bit: u8) -> ironrdp::input::MouseButton {
    use ironrdp::input::MouseButton;
    match bit {
        0 => MouseButton::Left,
        1 => MouseButton::Middle,
        _ => MouseButton::Right,
    }
}

/// Translate a queued `RdpInput` into IronRDP input operations, apply them to the
/// keyboard/mouse state `db`, encode the resulting FastPath events, and write the
/// PDU to the server. `last_button_mask` carries the previous primary-button mask
/// so press/release can be derived from the absolute mask the frontend sends.
async fn send_rdp_input(
    framed: &mut UpgradedFramed,
    db: &mut ironrdp::input::Database,
    last_button_mask: &mut u8,
    input: RdpInput,
) -> Result<(), String> {
    use ironrdp::input::{MousePosition, Operation, Scancode, WheelRotations};
    use ironrdp_tokio::FramedWrite as _;

    let debug = rdp_input_debug(&input);
    let mut ops: Vec<Operation> = Vec::new();
    match input {
        RdpInput::Pointer { x, y, button_mask } => {
            ops.push(Operation::MouseMove(MousePosition { x, y }));
            for (bit, pressed) in primary_button_transitions(*last_button_mask, button_mask) {
                let button = mouse_button_for_bit(bit);
                ops.push(if pressed {
                    Operation::MouseButtonPressed(button)
                } else {
                    Operation::MouseButtonReleased(button)
                });
            }
            // RFB-style wheel bits (3 = up, 4 = down) are momentary notches.
            if button_mask & (1 << 3) != 0 {
                ops.push(Operation::WheelRotations(WheelRotations {
                    is_vertical: true,
                    rotation_units: 120,
                }));
            }
            if button_mask & (1 << 4) != 0 {
                ops.push(Operation::WheelRotations(WheelRotations {
                    is_vertical: true,
                    rotation_units: -120,
                }));
            }
            // Remember only the three primary buttons; wheel bits are momentary.
            *last_button_mask = button_mask & 0b0000_0111;
        }
        RdpInput::Key { scancode, down } => {
            let sc = Scancode::from(scancode);
            ops.push(if down {
                Operation::KeyPressed(sc)
            } else {
                Operation::KeyReleased(sc)
            });
        }
        RdpInput::Text(text) => {
            // Each character is sent as a Unicode keyboard event (press + release),
            // so IME-composed and layout-specific characters reach the server
            // correctly regardless of the remote keyboard layout.
            for character in text.chars() {
                ops.push(Operation::UnicodeKeyPressed(character));
                ops.push(Operation::UnicodeKeyReleased(character));
            }
        }
        RdpInput::CtrlAltDelete => {
            let ctrl = Scancode::from_u16(0x001D);
            let alt = Scancode::from_u16(0x0038);
            let delete = Scancode::from_u16(0xE053);
            ops.extend([
                Operation::KeyPressed(ctrl),
                Operation::KeyPressed(alt),
                Operation::KeyPressed(delete),
                Operation::KeyReleased(delete),
                Operation::KeyReleased(alt),
                Operation::KeyReleased(ctrl),
            ]);
        }
    }

    let events = db.apply(ops);
    rdp_debug(
        "input.apply",
        &json!({
            "input": debug,
            "eventCount": events.len(),
        }),
    );
    if events.is_empty() {
        return Ok(());
    }

    let pdu = ironrdp::pdu::input::fast_path::FastPathInput::new(events.to_vec())
        .map_err(|e| format!("failed to build RDP input PDU: {e}"))?;
    let bytes =
        ironrdp::core::encode_vec(&pdu).map_err(|e| format!("failed to encode RDP input: {e}"))?;
    rdp_debug(
        "input.write",
        &json!({
            "bytes": bytes.len(),
        }),
    );
    framed
        .write_all(&bytes)
        .await
        .map_err(|e| format!("failed to send RDP input: {e}"))?;
    Ok(())
}

// ── Cursor stub (Task 5 fills in real pointer decoding) ───────────────────────

fn cursor_event(
    session_id: &str,
    pointer: &ironrdp::graphics::pointer::DecodedPointer,
) -> RdpCanvasEvent {
    // Task 5 may refine the pixel format; `bitmap_data` is the decoded pointer
    // bitmap and `hotspot_x/y` the click hotspot.
    RdpCanvasEvent::SetCursor {
        session_id: session_id.to_string(),
        width: pointer.width,
        height: pointer.height,
        hot_x: pointer.hotspot_x,
        hot_y: pointer.hotspot_y,
        rgba: BASE64.encode(&pointer.bitmap_data),
    }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

fn emit_rdp_event(app: &AppHandle, event: RdpCanvasEvent) {
    let _ = app.emit("kkterm-rdp-canvas-event", event);
}

fn required_id(value: String) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("RDP session id is required".to_string());
    }
    if trimmed.len() > 96 {
        return Err("RDP session id must be 96 characters or fewer".to_string());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err("RDP session id may only contain letters, digits, '-' or '_'".to_string());
    }
    Ok(trimmed.to_string())
}

/// Copy the `(x, y, w, h)` sub-rectangle out of a full-frame RGBA buffer
/// (`stride = full_width * 4`) into a tightly packed RGBA buffer.
fn extract_rgba_rect(full_rgba: &[u8], full_width: u16, x: u16, y: u16, w: u16, h: u16) -> Vec<u8> {
    let stride = full_width as usize * 4;
    let mut out = Vec::with_capacity(w as usize * h as usize * 4);
    for row in 0..h as usize {
        let src_y = y as usize + row;
        let start = src_y * stride + x as usize * 4;
        let end = start + w as usize * 4;
        if end <= full_rgba.len() {
            out.extend_from_slice(&full_rgba[start..end]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_session_ids() {
        assert_eq!(required_id("rdp-1".to_string()).as_deref(), Ok("rdp-1"));
        assert!(required_id("bad/session".to_string()).is_err());
    }

    #[test]
    fn reserves_session_start_once_until_released() {
        let manager = RdpClientSessionManager::new();

        assert!(manager
            .reserve_session_start("rdp-1")
            .expect("first reserve"));
        assert!(!manager
            .reserve_session_start("rdp-1")
            .expect("duplicate reserve"));

        manager.release_session_start("rdp-1");
        assert!(manager
            .reserve_session_start("rdp-1")
            .expect("reserve after release"));
    }

    #[test]
    fn rdp_client_start_debug_payload_excludes_password() {
        let payload = rdp_client_start_debug_payload(
            "rdp-1",
            "server.example.test",
            3389,
            "admin",
            Some("EXAMPLE"),
            1440,
            900,
            Some(17897),
        );

        assert_eq!(payload["sessionId"], "rdp-1");
        assert_eq!(payload["host"], "server.example.test");
        assert_eq!(payload["port"], 3389);
        assert_eq!(payload["username"], "admin");
        assert_eq!(payload["domain"], "EXAMPLE");
        assert_eq!(payload["desktopWidth"], 1440);
        assert_eq!(payload["desktopHeight"], 900);
        assert_eq!(payload["route"], "socks5:17897");
        assert_eq!(payload["socksProxyPort"], 17897);
        assert_eq!(payload["security"]["enableCredSsp"], true);
        assert_eq!(payload["security"]["enableTls"], false);
        assert!(payload.get("password").is_none());
    }

    #[test]
    fn chooses_socks_for_public_hosts_and_direct_for_private_hosts() {
        assert_eq!(
            choose_rdp_client_route("64.20.10.254", Some(17897)),
            RdpClientRoute::Socks5 { port: 17897 }
        );
        assert_eq!(
            choose_rdp_client_route("rdp.example.test", Some(17897)),
            RdpClientRoute::Socks5 { port: 17897 }
        );
        assert_eq!(
            choose_rdp_client_route("192.168.3.105", Some(17897)),
            RdpClientRoute::Direct
        );
        assert_eq!(
            choose_rdp_client_route("127.0.0.1", Some(17897)),
            RdpClientRoute::Direct
        );
        assert_eq!(
            choose_rdp_client_route("64.20.10.254", None),
            RdpClientRoute::Direct
        );
    }

    #[test]
    fn start_request_deserializes_with_defaults() {
        let json = r#"{"sessionId":"rdp-1","host":"win.local","username":"u","password":"p"}"#;
        let request: StartRdpClientSessionRequest =
            serde_json::from_str(json).expect("request deserializes");
        assert_eq!(request.host, "win.local");
        assert!(request.domain.is_none());
        assert_eq!(request.desktop_width(), DEFAULT_RDP_WIDTH);
        assert_eq!(request.desktop_height(), DEFAULT_RDP_HEIGHT);
        assert_eq!(request.socks_proxy_port, None);
    }

    #[test]
    fn extracts_rgba_rect_from_framebuffer() {
        // 2x2 RGBA image, extract the bottom-right 1x1 pixel.
        let width = 2u16;
        let full = vec![0, 0, 0, 255, 1, 1, 1, 255, 2, 2, 2, 255, 3, 3, 3, 255];
        let rect = extract_rgba_rect(&full, width, 1, 1, 1, 1);
        assert_eq!(rect, vec![3, 3, 3, 255]);
    }

    #[test]
    fn button_transitions_detect_press_and_release() {
        assert_eq!(primary_button_transitions(0b000, 0b001), vec![(0, true)]); // left down
        assert_eq!(primary_button_transitions(0b001, 0b000), vec![(0, false)]); // left up
        assert_eq!(primary_button_transitions(0b001, 0b001), vec![]); // held, no change
        assert_eq!(primary_button_transitions(0b000, 0b100), vec![(2, true)]); // right down
        assert_eq!(
            primary_button_transitions(0b000, 0b101),
            vec![(0, true), (2, true)] // left + right down
        );
    }
}

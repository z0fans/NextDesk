#![allow(dead_code)]

//! macOS RDP client built on IronRDP. Decodes the RDP framebuffer to RGBA and
//! emits `rdp-canvas-event`s for the workspace canvas. Windows uses the native
//! ActiveX path in `rdp.rs` instead; this module is compiled only off-Windows.
//!
//! # Pinned IronRDP connect sequence (verified against ironrdp 0.16 / ironrdp-tokio 0.9)
//!
//! ## Dependencies used
//! - `ironrdp = "0.16"` with features `["connector", "session", "graphics", "pdu", "input"]`
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
    time::{timeout, Duration},
};

const DEFAULT_RDP_PORT: u16 = 3389;
const DEFAULT_RDP_WIDTH: u16 = 1280;
const DEFAULT_RDP_HEIGHT: u16 = 800;
const RDP_TCP_CONNECT_TIMEOUT_SECONDS: u64 = 8;
const RDP_NEGOTIATION_TIMEOUT_SECONDS: u64 = 15;
const RDP_FINALIZE_TIMEOUT_SECONDS: u64 = 25;

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
    ForceClipboardCheck,
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
        RdpInput::ForceClipboardCheck => json!({ "kind": "forceClipboardCheck" }),
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
}

impl StartRdpClientSessionRequest {
    pub fn from_kkterm_start(request: crate::kkterm_rdp::types::KktermRdpStartRequest) -> Self {
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

    pub fn force_clipboard_check(&self, request: RdpClientSimpleRequest) -> Result<(), String> {
        self.queue_input(&request.session_id, RdpInput::ForceClipboardCheck)
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
) -> Value {
    json!({
        "sessionId": session_id,
        "host": host,
        "port": port,
        "username": username,
        "domain": domain,
        "desktopWidth": desktop_width,
        "desktopHeight": desktop_height,
        "route": "direct",
        "security": {
            "enableCredSsp": true,
            "enableTls": false,
            "requestedProtocols": ["HYBRID", "HYBRID_EX"],
            "legacyTlsFallbackAllowed": true,
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum TlsBackend {
    Rustls,
    NativeTls,
}

impl TlsBackend {
    fn label(self) -> &'static str {
        match self {
            Self::Rustls => "rustls",
            Self::NativeTls => "native-tls",
        }
    }
}

enum RdpTlsStream {
    Rustls(Box<tokio_rustls::client::TlsStream<TcpStream>>),
    NativeTls(tokio_native_tls::TlsStream<TcpStream>),
}

impl tokio::io::AsyncRead for RdpTlsStream {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            Self::Rustls(stream) => std::pin::Pin::new(stream).poll_read(cx, buf),
            Self::NativeTls(stream) => std::pin::Pin::new(stream).poll_read(cx, buf),
        }
    }
}

impl tokio::io::AsyncWrite for RdpTlsStream {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        match self.get_mut() {
            Self::Rustls(stream) => std::pin::Pin::new(stream).poll_write(cx, buf),
            Self::NativeTls(stream) => std::pin::Pin::new(stream).poll_write(cx, buf),
        }
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            Self::Rustls(stream) => std::pin::Pin::new(stream).poll_flush(cx),
            Self::NativeTls(stream) => std::pin::Pin::new(stream).poll_flush(cx),
        }
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            Self::Rustls(stream) => std::pin::Pin::new(stream).poll_shutdown(cx),
            Self::NativeTls(stream) => std::pin::Pin::new(stream).poll_shutdown(cx),
        }
    }
}

async fn tls_upgrade(
    stream: TcpStream,
    session_id: &str,
    host: &str,
    port: u16,
    server_name: &str,
    backend: TlsBackend,
) -> Result<RdpTlsStream, String> {
    match backend {
        TlsBackend::Rustls => tls_upgrade_rustls(stream, session_id, host, port, server_name).await,
        TlsBackend::NativeTls => {
            tls_upgrade_native(stream, session_id, host, port, server_name).await
        }
    }
}

async fn tls_upgrade_native(
    stream: TcpStream,
    session_id: &str,
    host: &str,
    port: u16,
    server_name: &str,
) -> Result<RdpTlsStream, String> {
    use tokio_native_tls::native_tls;

    rdp_debug(
        "ironrdp.tls.start",
        &json!({
            "sessionId": session_id,
            "host": host,
            "port": port,
            "serverName": server_name,
            "backend": TlsBackend::NativeTls.label(),
            "protocolVersions": ["TLS1.0", "TLS1.1", "TLS1.2"],
            "certificateVerification": "disabled_for_rdp",
        }),
    );

    let connector = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .min_protocol_version(Some(native_tls::Protocol::Tlsv10))
        .build()
        .map_err(|error| format!("TLS config error: {error}"))?;
    let connector = tokio_native_tls::TlsConnector::from(connector);
    match connector.connect(server_name, stream).await {
        Ok(stream) => {
            rdp_debug(
                "ironrdp.tls.ok",
                &json!({
                    "sessionId": session_id,
                    "host": host,
                    "port": port,
                    "backend": TlsBackend::NativeTls.label(),
                }),
            );
            Ok(RdpTlsStream::NativeTls(stream))
        }
        Err(error) => {
            let error = error_chain(&error);
            rdp_debug(
                "ironrdp.tls.error",
                &json!({
                    "sessionId": session_id,
                    "host": host,
                    "port": port,
                    "backend": TlsBackend::NativeTls.label(),
                    "error": error,
                }),
            );
            Err(format!("TLS handshake failed: {error}"))
        }
    }
}

async fn tls_upgrade_rustls(
    stream: TcpStream,
    session_id: &str,
    host: &str,
    port: u16,
    server_name: &str,
) -> Result<RdpTlsStream, String> {
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
            "backend": TlsBackend::Rustls.label(),
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
            Ok(RdpTlsStream::Rustls(Box::new(tls_stream)))
        }
        Err(error) => {
            rdp_debug(
                "ironrdp.tls.error",
                &json!({
                    "sessionId": session_id,
                    "host": host,
                    "port": port,
                    "backend": TlsBackend::Rustls.label(),
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
    tls_stream: &RdpTlsStream,
) -> Result<Vec<u8>, String> {
    let (cert_der, peer_certificate_count) = match tls_stream {
        RdpTlsStream::Rustls(tls_stream) => {
            let (_, session) = tls_stream.get_ref();
            let cert_der = session
                .peer_certificates()
                .and_then(|certs| certs.first())
                .ok_or_else(|| "RDP server sent no TLS certificate".to_string())?;
            (
                cert_der.as_ref().to_vec(),
                session
                    .peer_certificates()
                    .map(|certs| certs.len())
                    .unwrap_or(0),
            )
        }
        RdpTlsStream::NativeTls(tls_stream) => {
            let cert = tls_stream
                .get_ref()
                .peer_certificate()
                .map_err(|error| format!("failed to read server certificate: {error}"))?
                .ok_or_else(|| "RDP server sent no TLS certificate".to_string())?;
            let cert_der = cert
                .to_der()
                .map_err(|error| format!("failed to encode server certificate: {error}"))?;
            (cert_der, 1)
        }
    };
    let spki_bytes = subject_public_key_from_cert_der(&cert_der)?;

    rdp_debug(
        "ironrdp.certificate.ok",
        &json!({
            "sessionId": session_id,
            "peerCertificateCount": peer_certificate_count,
            "subjectPublicKeyBytes": spki_bytes.len(),
        }),
    );

    Ok(spki_bytes)
}

fn subject_public_key_from_cert_der(cert_der: &[u8]) -> Result<Vec<u8>, String> {
    use x509_cert::der::Decode as _;

    let cert = x509_cert::Certificate::from_der(cert_der)
        .map_err(|e| format!("failed to parse server certificate: {e}"))?;
    Ok(cert
        .tbs_certificate
        .subject_public_key_info
        .subject_public_key
        .as_bytes()
        .ok_or_else(|| "server certificate subject public key is not a bitstring".to_string())?
        .to_vec())
}

// ── Connect helper ────────────────────────────────────────────────────────────

type UpgradedFramed = ironrdp_tokio::TokioFramed<RdpTlsStream>;

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
    cliprdr_action_tx: mpsc::UnboundedSender<CliprdrAction>,
    app: AppHandle,
    cliprdr_temp_dir: String,
) -> Result<(ironrdp::connector::ConnectionResult, UpgradedFramed), String> {
    match rdp_connect_attempt(
        session_id.clone(),
        host.clone(),
        port,
        username.clone(),
        password.clone(),
        domain.clone(),
        width,
        height,
        cliprdr_action_tx.clone(),
        app.clone(),
        cliprdr_temp_dir.clone(),
        TlsBackend::Rustls,
    )
    .await
    {
        Ok(result) => Ok(result),
        Err(rustls_error) if is_tls_handshake_error(&rustls_error) => {
            rdp_debug(
                "ironrdp.tls.fallback",
                &json!({
                    "sessionId": &session_id,
                    "host": &host,
                    "port": port,
                    "from": TlsBackend::Rustls.label(),
                    "to": TlsBackend::NativeTls.label(),
                    "reason": &rustls_error,
                }),
            );
            rdp_connect_attempt(
                session_id,
                host,
                port,
                username,
                password,
                domain,
                width,
                height,
                cliprdr_action_tx,
                app,
                cliprdr_temp_dir,
                TlsBackend::NativeTls,
            )
            .await
            .map_err(|fallback_error| {
                format!("{rustls_error}; legacy TLS fallback failed: {fallback_error}")
            })
        }
        Err(error) => Err(error),
    }
}

fn is_tls_handshake_error(error: &str) -> bool {
    error.starts_with("TLS handshake failed:") || error.starts_with("RDP TLS handshake timed out")
}

#[allow(clippy::too_many_arguments)]
async fn rdp_connect_attempt(
    session_id: String,
    host: String,
    port: u16,
    username: String,
    password: String,
    domain: Option<String>,
    width: u16,
    height: u16,
    cliprdr_action_tx: mpsc::UnboundedSender<CliprdrAction>,
    app: AppHandle,
    cliprdr_temp_dir: String,
    tls_backend: TlsBackend,
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
    let route_label = "direct";
    rdp_debug(
        "ironrdp.tcp.start",
        &json!({
            "sessionId": session_id,
            "host": host,
            "port": port,
            "route": route_label,
        }),
    );
    let stream = match connect_rdp_transport(host.as_str(), port).await {
        Ok(stream) => stream,
        Err(error) => {
            rdp_debug(
                "ironrdp.tcp.error",
                &json!({
                    "sessionId": session_id,
                    "host": host,
                    "port": port,
                    "route": route_label,
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
                "legacyTlsFallbackAllowed": true,
                "tlsBackend": tls_backend.label(),
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
    let should_upgrade = match timeout(
        Duration::from_secs(RDP_NEGOTIATION_TIMEOUT_SECONDS),
        connect_begin(&mut framed, &mut connector),
    )
    .await
    {
        Ok(Ok(should_upgrade)) => should_upgrade,
        Ok(Err(error)) => {
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
        Err(_) => {
            let error = "server did not respond during RDP negotiation";
            rdp_debug(
                "ironrdp.connect_begin.timeout",
                &json!({
                    "sessionId": session_id,
                    "host": host,
                    "port": port,
                    "timeoutSeconds": RDP_NEGOTIATION_TIMEOUT_SECONDS,
                    "error": error,
                }),
            );
            return Err(format!(
                "RDP connect_begin timed out after {RDP_NEGOTIATION_TIMEOUT_SECONDS}s: {error}"
            ));
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
    let tls_stream = timeout(
        Duration::from_secs(RDP_NEGOTIATION_TIMEOUT_SECONDS),
        tls_upgrade(tcp_stream, &session_id, &host, port, &host, tls_backend),
    )
    .await
    .map_err(|_| {
        format!("RDP TLS handshake timed out after {RDP_NEGOTIATION_TIMEOUT_SECONDS}s")
    })??;

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
    let connection_result = match timeout(
        Duration::from_secs(RDP_FINALIZE_TIMEOUT_SECONDS),
        connect_finalize::<_, NoopNetworkClient>(
            upgraded,
            connector,
            &mut upgraded_framed,
            &mut NoopNetworkClient,
            ServerName::new(host.clone()),
            server_public_key,
            None::<KerberosConfig>,
        ),
    )
    .await
    {
        Ok(Ok(connection_result)) => connection_result,
        Ok(Err(error)) => {
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
        Err(_) => {
            let error = "server did not complete RDP finalization";
            rdp_debug(
                "ironrdp.connect_finalize.timeout",
                &json!({
                    "sessionId": session_id,
                    "host": host,
                    "port": port,
                    "timeoutSeconds": RDP_FINALIZE_TIMEOUT_SECONDS,
                    "error": error,
                }),
            );
            return Err(format!(
                "RDP connect_finalize timed out after {RDP_FINALIZE_TIMEOUT_SECONDS}s: {error}"
            ));
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

async fn connect_rdp_transport(host: &str, port: u16) -> Result<TcpStream, String> {
    timeout(
        Duration::from_secs(RDP_TCP_CONNECT_TIMEOUT_SECONDS),
        TcpStream::connect((host, port)),
    )
    .await
    .map_err(|_| format!("TCP connect timed out after {RDP_TCP_CONNECT_TIMEOUT_SECONDS}s"))?
    .map_err(|error| error.to_string())
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
                        Some(RdpInput::ForceClipboardCheck) => {
                            use ironrdp::cliprdr::Client as CliprdrClient;
                            use ironrdp::cliprdr::Cliprdr;

                            if let Some(cliprdr) =
                                active_stage.get_svc_processor_mut::<Cliprdr<CliprdrClient>>()
                            {
                                if let Some(backend) = cliprdr.downcast_backend_mut::<
                                    cliprdr_module::backend::NextDeskCliprdrBackend,
                                >() {
                                    backend.force_local_clipboard_check().await;
                                } else {
                                    log::warn!(
                                        "[cliprdr] KKTerm force check skipped: backend downcast failed"
                                    );
                                }
                            } else {
                                log::debug!(
                                    "[cliprdr] KKTerm force check skipped: processor not ready"
                                );
                            }
                        }
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
        RdpInput::ForceClipboardCheck => return Ok(()),
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
        );

        assert_eq!(payload["sessionId"], "rdp-1");
        assert_eq!(payload["host"], "server.example.test");
        assert_eq!(payload["port"], 3389);
        assert_eq!(payload["username"], "admin");
        assert_eq!(payload["domain"], "EXAMPLE");
        assert_eq!(payload["desktopWidth"], 1440);
        assert_eq!(payload["desktopHeight"], 900);
        assert_eq!(payload["route"], "direct");
        assert_eq!(payload["security"]["enableCredSsp"], true);
        assert_eq!(payload["security"]["enableTls"], false);
        assert_eq!(payload["security"]["legacyTlsFallbackAllowed"], true);
        assert!(payload.get("password").is_none());
    }

    #[test]
    fn retries_only_tls_handshake_failures_with_legacy_backend() {
        assert!(is_tls_handshake_error(
            "TLS handshake failed: connection reset by peer"
        ));
        assert!(is_tls_handshake_error(
            "RDP TLS handshake timed out after 15s"
        ));
        assert!(!is_tls_handshake_error(
            "RDP connect_begin failed: rejected"
        ));
        assert!(!is_tls_handshake_error("CredSSP authentication failed"));
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

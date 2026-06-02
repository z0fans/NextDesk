//! Native RDP Session — full Rust RDP client embedded in Tauri.
//!
//! # Frame Transport (Raw Binary via Channel)
//! Uses `tauri::ipc::Channel` for zero-overhead binary streaming.
//!
//! Binary frame format (little-endian):
//! ```text
//! Offset  Size  Field
//! 0       2     desktop_width  (u16le)
//! 2       2     desktop_height (u16le)
//! 4       2     region_x       (u16le)
//! 6       2     region_y       (u16le)
//! 8       2     region_width   (u16le)
//! 10      2     region_height  (u16le)
//! 12      N     RGBA pixel data (row-major, 4 bytes/pixel)
//!               where N = region_width * region_height * 4
//! ```
//! Total header: 12 bytes. Frontend receives ArrayBuffer directly.

use crate::cliprdr as cliprdr_module;
use crate::frame_ws::FrameSender;
use ironrdp::cliprdr;
use ironrdp::cliprdr::backend::CliprdrBackendFactory as _;
use ironrdp::connector::{self, ConnectionResult, ConnectorResult};
use ironrdp::displaycontrol::client::DisplayControlClient;
use ironrdp::echo::client::EchoClient;
use ironrdp::graphics::image_processing::PixelFormat;
use ironrdp::pdu::geometry::Rectangle as _;
use ironrdp::pdu::input::fast_path::FastPathInputEvent;
use ironrdp::session::image::DecodedImage;
use ironrdp::session::{ActiveStage, ActiveStageOutput, GracefulDisconnectReason, SessionResult};
use ironrdp::{rdpdr, rdpsnd, session};
use ironrdp_core::WriteBuf;
use ironrdp_rdpsnd_native::cpal::RdpsndBackend;
use ironrdp_tokio::{single_sequence_step_read, split_tokio_framed, FramedWrite};
use rdpdr::NoopRdpdrBackend;
use serde::Serialize;
use smallvec::SmallVec;
use tauri::Emitter;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

/// Binary frame header size: 6 × u16 = 12 bytes
const FRAME_HEADER_SIZE: usize = 12;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NativeRdpRoute {
    Direct,
    Socks5 { port: u16 },
}

/// Build a raw binary frame packet with LZ4 compression.
///
/// Compressed format: [12B header] + [4B uncompressed_len] + [LZ4 compressed pixels]
/// The compression flag is bit15 of desktop_width in the header.
/// Uncompressed fallback (for tiny regions): [12B header] + [raw RGBA pixels]
fn build_raw_frame(
    desktop_width: u16,
    desktop_height: u16,
    x: u16,
    y: u16,
    width: u16,
    height: u16,
    pixel_data: &[u8],
) -> Vec<u8> {
    // Skip compression for tiny regions (overhead > savings)
    if pixel_data.len() < 256 {
        let mut buf = Vec::with_capacity(FRAME_HEADER_SIZE + pixel_data.len());
        buf.extend_from_slice(&desktop_width.to_le_bytes());
        buf.extend_from_slice(&desktop_height.to_le_bytes());
        buf.extend_from_slice(&x.to_le_bytes());
        buf.extend_from_slice(&y.to_le_bytes());
        buf.extend_from_slice(&width.to_le_bytes());
        buf.extend_from_slice(&height.to_le_bytes());
        buf.extend_from_slice(pixel_data);
        return buf;
    }

    let compressed = lz4_flex::compress_prepend_size(pixel_data);

    // Use compressed only if it actually saves space
    if compressed.len() >= pixel_data.len() {
        let mut buf = Vec::with_capacity(FRAME_HEADER_SIZE + pixel_data.len());
        buf.extend_from_slice(&desktop_width.to_le_bytes());
        buf.extend_from_slice(&desktop_height.to_le_bytes());
        buf.extend_from_slice(&x.to_le_bytes());
        buf.extend_from_slice(&y.to_le_bytes());
        buf.extend_from_slice(&width.to_le_bytes());
        buf.extend_from_slice(&height.to_le_bytes());
        buf.extend_from_slice(pixel_data);
        return buf;
    }

    // Compressed frame: set bit15 on desktop_width as flag
    let flagged_width = desktop_width | 0x8000;
    let uncompressed_len = pixel_data.len() as u32;

    let mut buf = Vec::with_capacity(FRAME_HEADER_SIZE + 4 + compressed.len());
    buf.extend_from_slice(&flagged_width.to_le_bytes());
    buf.extend_from_slice(&desktop_height.to_le_bytes());
    buf.extend_from_slice(&x.to_le_bytes());
    buf.extend_from_slice(&y.to_le_bytes());
    buf.extend_from_slice(&width.to_le_bytes());
    buf.extend_from_slice(&height.to_le_bytes());
    buf.extend_from_slice(&uncompressed_len.to_le_bytes());
    buf.extend_from_slice(&compressed);
    buf
}

// ── Tauri Event Payloads (small, infrequent) ────────────────

/// Session status change event (via `emit`, not Channel).
#[derive(Clone, Serialize)]
pub struct RdpStatusEvent {
    pub tab_id: String,
    pub status: String, // "connected" | "disconnected" | "error"
    pub message: Option<String>,
}

/// Pointer (cursor) event (via `emit`, not Channel).
#[derive(Clone, Serialize, Default)]
pub struct RdpPointerEvent {
    pub tab_id: String,
    pub kind: String, // "default" | "hidden" | "position" | "bitmap"
    pub x: Option<u16>,
    pub y: Option<u16>,
    pub width: Option<u16>,
    pub height: Option<u16>,
    pub hotspot_x: Option<u16>,
    pub hotspot_y: Option<u16>,
    /// RGBA bitmap data for custom cursor
    pub bitmap: Option<Vec<u8>>,
}

// ── Input Events (Frontend → Rust) ──────────────────────────

#[derive(Debug)]
pub enum NativeRdpInput {
    FastPath(SmallVec<[FastPathInputEvent; 2]>),
    Resize { width: u16, height: u16 },
    Close,
}
// ── Clipboard Actions (Backend → Session Loop) ──────────────

/// Actions produced by `NextDeskCliprdrBackend` callbacks, consumed by the
/// session event loop which has access to `Cliprdr` / `ActiveStage`.
#[derive(Debug)]
pub enum CliprdrAction {
    /// Local clipboard changed → send FormatList to server
    InitiateCopy(Vec<ironrdp::cliprdr::pdu::ClipboardFormat>),
    /// Remote copied → request format data from server
    InitiatePaste(ironrdp::cliprdr::pdu::ClipboardFormatId),
    /// Server requested our data → submit format data response
    SubmitFormatData(ironrdp::cliprdr::pdu::OwnedFormatDataResponse),
    /// Server requested file contents → submit file contents response
    SubmitFileContents(ironrdp::cliprdr::pdu::FileContentsResponse<'static>),
    /// We need a file chunk from server → send FileContentsRequest
    RequestFileContents(ironrdp::cliprdr::pdu::FileContentsRequest),
}

// ── Session Management ──────────────────────────────────────

/// Handle to a running native RDP session.
pub struct SessionHandle {
    pub input_tx: mpsc::UnboundedSender<NativeRdpInput>,
    #[allow(dead_code)]
    join_handle: Option<std::thread::JoinHandle<()>>,
}

/// Manages all active native RDP sessions.
#[derive(Default)]
pub struct SessionManager {
    sessions: std::collections::HashMap<String, SessionHandle>,
}

impl SessionManager {
    pub fn get_input_tx(&self, tab_id: &str) -> Option<&mpsc::UnboundedSender<NativeRdpInput>> {
        self.sessions.get(tab_id).map(|h| &h.input_tx)
    }

    pub fn insert(&mut self, tab_id: String, handle: SessionHandle) {
        // Close existing session if any
        if let Some(old) = self.sessions.remove(&tab_id) {
            log::info!("[rdp-native] Replacing existing session: {tab_id}");
            let _ = old.input_tx.send(NativeRdpInput::Close);
        }
        self.sessions.insert(tab_id, handle);
    }

    pub fn disconnect(&mut self, tab_id: &str) {
        if let Some(handle) = self.sessions.remove(tab_id) {
            log::info!("[rdp-native] Disconnect requested: {tab_id}");
            let _ = handle.input_tx.send(NativeRdpInput::Close);
        }
    }
}

// ── Connection Configuration ────────────────────────────────

/// Build IronRDP connector config from frontend parameters.
pub fn connect_config(
    username: &str,
    password: &str,
    domain: Option<&str>,
    width: u16,
    height: u16,
) -> connector::Config {
    use ironrdp::pdu::gcc;
    use ironrdp::pdu::rdp::capability_sets;
    use ironrdp::pdu::rdp::client_info;

    connector::Config {
        credentials: connector::Credentials::UsernamePassword {
            username: username.to_string(),
            password: password.to_string(),
        },
        domain: domain.map(|d| d.to_string()),
        enable_tls: true,
        enable_credssp: true,
        desktop_size: connector::DesktopSize { width, height },
        desktop_scale_factor: 0,
        client_build: 0,
        client_name: "NextDesk".to_string(),
        keyboard_type: gcc::KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_functional_keys_count: 12,
        keyboard_layout: 0x0409, // US English
        ime_file_name: String::new(),
        bitmap: None,
        dig_product_id: String::new(),
        client_dir: "C:\\Windows\\System32\\mstscax.dll".to_string(),
        alternate_shell: String::new(),
        work_dir: String::new(),
        platform: capability_sets::MajorPlatformType::UNSPECIFIED,
        hardware_id: None,
        request_data: None,
        autologon: true,
        enable_audio_playback: true,
        performance_flags: client_info::PerformanceFlags::default(),
        license_cache: None,
        timezone_info: client_info::TimezoneInfo::default(),
        compression_type: None,
        enable_server_pointer: true,
        pointer_software_rendering: false,
        multitransport_flags: None,
    }
}

/// Spawn a native RDP session as a background OS thread.
///
/// The `frame_channel` is a Tauri `Channel` passed from the frontend
/// `invoke('rdp_native_connect', { onFrame: channel })` call.
/// It provides high-performance streaming — no global event broadcast,
/// no JSON array-of-numbers serialization.
///
/// Returns a `SessionHandle` for sending input and managing lifecycle.
pub fn spawn_session(
    app: tauri::AppHandle,
    tab_id: String,
    host: String,
    port: u16,
    socks_port: u16,
    username: String,
    password: String,
    domain: Option<String>,
    width: u16,
    height: u16,
    frame_tx: FrameSender,
) -> SessionHandle {
    let (input_tx, input_rx) = mpsc::unbounded_channel::<NativeRdpInput>();

    // Spawn on a dedicated OS thread with its own tokio runtime.
    // This avoids the Send bound issues with ironrdp_tokio::connect_finalize
    // which uses &NetworkRequest with non-general lifetimes.
    let join_handle = std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("failed to build tokio runtime for RDP session");

        rt.block_on(async move {
            let tab_id_inner = tab_id.clone();
            let app_inner = app.clone();
            let result = run_session(
                app_inner,
                tab_id_inner,
                host,
                port,
                socks_port,
                username,
                password,
                domain,
                width,
                height,
                input_rx,
                frame_tx,
            )
            .await;

            match &result {
                Ok(reason) => {
                    log::info!("[rdp-native] Session {tab_id} ended: {reason:?}");
                    let _ = app.emit(
                        "rdp://status",
                        RdpStatusEvent {
                            tab_id,
                            status: "disconnected".into(),
                            message: Some(format!("{reason:?}")),
                        },
                    );
                }
                Err(e) => {
                    log::error!("[rdp-native] Session {tab_id} error: {e}");
                    let _ = app.emit(
                        "rdp://status",
                        RdpStatusEvent {
                            tab_id,
                            status: "error".into(),
                            message: Some(format!("{e}")),
                        },
                    );
                }
            }
        });
    });

    SessionHandle {
        input_tx,
        join_handle: Some(join_handle),
    }
}

// ── Session Runner ──────────────────────────────────────────

trait AsyncReadWrite: AsyncRead + AsyncWrite {}
impl<T> AsyncReadWrite for T where T: AsyncRead + AsyncWrite {}

type UpgradedFramed = ironrdp_tokio::TokioFramed<Box<dyn AsyncReadWrite + Unpin + Send + Sync>>;

/// Main session lifecycle: connect → active loop → disconnect.
async fn run_session(
    app: tauri::AppHandle,
    tab_id: String,
    host: String,
    port: u16,
    socks_port: u16,
    username: String,
    password: String,
    domain: Option<String>,
    width: u16,
    height: u16,
    mut input_rx: mpsc::UnboundedReceiver<NativeRdpInput>,
    frame_tx: FrameSender,
) -> Result<GracefulDisconnectReason, String> {
    let config = connect_config(&username, &password, domain.as_deref(), width, height);

    // Create cliprdr action channel (backend → session loop)
    let (cliprdr_tx, mut cliprdr_rx) = mpsc::unbounded_channel::<CliprdrAction>();
    let temp_dir = dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("NextDesk")
        .join("cliprdr");
    let _ = std::fs::create_dir_all(&temp_dir);
    let temp_dir_str = temp_dir.to_string_lossy().to_string();

    // Connect through the NextDesk acceleration core for public targets.
    let (connection_result, framed) = connect_tcp(
        &host,
        port,
        socks_port,
        &config,
        cliprdr_tx,
        &temp_dir_str,
        frame_tx.clone(),
        app.clone(),
    )
    .await
    .map_err(|e| format!("Connect failed: {e}"))?;

    log::info!(
        "[rdp-native] Connected: {}x{}",
        connection_result.desktop_size.width,
        connection_result.desktop_size.height,
    );

    // Notify frontend: connected
    let _ = app.emit(
        "rdp://status",
        RdpStatusEvent {
            tab_id: tab_id.clone(),
            status: "connected".into(),
            message: None,
        },
    );

    // Run active session loop
    active_session(
        app,
        &tab_id,
        framed,
        connection_result,
        &mut input_rx,
        &mut cliprdr_rx,
        frame_tx,
    )
    .await
    .map_err(|e| format!("Session error: {e}"))
}

// ── TCP Accelerated Connection ───────────────────────────────

/// Connect to RDP server via SOCKS5 acceleration for public targets, then TLS.
///
/// Flow: TCP connect → X.224 negotiate → TLS upgrade → NLA/CredSSP → channel join
async fn connect_tcp(
    host: &str,
    port: u16,
    socks_port: u16,
    config: &connector::Config,
    cliprdr_action_tx: mpsc::UnboundedSender<CliprdrAction>,
    temp_dir: &str,
    _frame_tx: FrameSender,
    app_handle: tauri::AppHandle,
) -> ConnectorResult<(ConnectionResult, UpgradedFramed)> {
    let stream = connect_rdp_transport(host, port, socks_port).await?;

    stream
        .set_nodelay(true)
        .map_err(|e| connector::custom_err!("TCP_NODELAY", e))?;

    let client_addr = stream
        .local_addr()
        .map_err(|e| connector::custom_err!("local address", e))?;

    let mut framed = ironrdp_tokio::TokioFramed::new(stream);

    // Do NOT register GFX Pipeline — let server use FastPath Surface Commands
    // which ActiveStage's built-in decoder handles perfectly (RFX, RLE, Bitmap).
    // This matches WASM behavior when no gfx_callback is provided.
    eprintln!("[rdp-native] Using ActiveStage built-in decoders (no GFX Pipeline)");

    let drdynvc = ironrdp::dvc::DrdynvcClient::new()
        .with_dynamic_channel(DisplayControlClient::new(|_| Ok(Vec::new())))
        .with_dynamic_channel(EchoClient::new());
    eprintln!("[rdp-native] DrdynvcClient channels: {:?}", drdynvc);

    let cliprdr_factory =
        cliprdr_module::build_factory(cliprdr_action_tx, app_handle.clone(), temp_dir.to_string());
    let cliprdr = cliprdr::Cliprdr::new(cliprdr_factory.build_cliprdr_backend());

    let mut connector = connector::ClientConnector::new(config.clone(), client_addr)
        .with_static_channel(drdynvc)
        .with_static_channel(rdpsnd::client::Rdpsnd::new(Box::new(RdpsndBackend::new())))
        .with_static_channel(
            rdpdr::Rdpdr::new(Box::new(NoopRdpdrBackend {}), "NextDesk".to_owned())
                .with_smartcard(0),
        );
    connector.attach_static_channel(cliprdr);

    // Phase 1: X.224 Connection Request/Confirm
    let should_upgrade = ironrdp_tokio::connect_begin(&mut framed, &mut connector).await?;

    // Phase 2: TLS upgrade
    log::debug!("[rdp-native] TLS upgrade");
    let (initial_stream, leftover_bytes) = framed.into_inner();

    let (upgraded_stream, tls_cert) = ironrdp_tls::upgrade(initial_stream, host)
        .await
        .map_err(|e| connector::custom_err!("TLS upgrade", e))?;

    let upgraded = ironrdp_tokio::mark_as_upgraded(should_upgrade, &mut connector);

    let erased_stream: Box<dyn AsyncReadWrite + Unpin + Send + Sync> = Box::new(upgraded_stream);
    let mut upgraded_framed =
        ironrdp_tokio::TokioFramed::new_with_leftover(erased_stream, leftover_bytes);

    // Phase 3: NLA/CredSSP + Channel Join + Capabilities
    let server_public_key = ironrdp_tls::extract_tls_server_public_key(&tls_cert)
        .ok_or_else(|| connector::general_err!("extract TLS server public key"))?;

    let connection_result = ironrdp_tokio::connect_finalize(
        upgraded,
        connector,
        &mut upgraded_framed,
        &mut ironrdp_tokio::reqwest::ReqwestNetworkClient::new(),
        connector::ServerName::new(host.to_string()),
        server_public_key.to_owned(),
        None,
    )
    .await?;

    // Diagnostic: list all joined static channels
    eprintln!(
        "[rdp-native] RDP handshake complete: {:?}, io={}, user={}",
        connection_result.desktop_size,
        connection_result.io_channel_id,
        connection_result.user_channel_id,
    );
    for (type_id, channel) in connection_result.static_channels.iter() {
        let ch_id = connection_result
            .static_channels
            .get_channel_id_by_type_id(type_id);
        eprintln!(
            "[rdp-native] Joined channel: '{:?}' id={:?}",
            channel.channel_name(),
            ch_id,
        );
    }

    Ok((connection_result, upgraded_framed))
}

async fn connect_rdp_transport(
    host: &str,
    port: u16,
    socks_port: u16,
) -> ConnectorResult<TcpStream> {
    let dest = format!("{host}:{port}");
    match choose_native_rdp_route(host, socks_port) {
        NativeRdpRoute::Direct => {
            log::info!("[rdp-native] Direct TCP -> {dest}");
            TcpStream::connect(&dest)
                .await
                .map_err(|e| connector::custom_err!("TCP connect direct", e))
        }
        NativeRdpRoute::Socks5 { port: route_port } => {
            let socks_addr = format!("127.0.0.1:{route_port}");
            log::info!("[rdp-native] SOCKS5:{route_port} -> {dest}");
            tokio_socks::tcp::Socks5Stream::connect(socks_addr.as_str(), (host, port))
                .await
                .map(|stream| stream.into_inner())
                .map_err(|e| connector::custom_err!("TCP connect SOCKS5", e))
        }
    }
}

fn choose_native_rdp_route(host: &str, socks_port: u16) -> NativeRdpRoute {
    if is_private_or_reserved_ip(host) {
        NativeRdpRoute::Direct
    } else {
        NativeRdpRoute::Socks5 { port: socks_port }
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

// ── Active Session Event Loop ───────────────────────────────

/// Drive the active RDP session: process server frames + frontend input + clipboard.
async fn active_session(
    app: tauri::AppHandle,
    tab_id: &str,
    framed: UpgradedFramed,
    connection_result: ConnectionResult,
    input_rx: &mut mpsc::UnboundedReceiver<NativeRdpInput>,
    cliprdr_rx: &mut mpsc::UnboundedReceiver<CliprdrAction>,
    frame_tx: FrameSender,
) -> SessionResult<GracefulDisconnectReason> {
    use ironrdp::connector::connection_activation::ConnectionActivationState;
    use ironrdp::session::fast_path;

    let (mut reader, mut writer) = split_tokio_framed(framed);

    // ── Writer task ───────────────────────────────────────────────────
    // The main `tokio::select!` loop must NOT block on `writer.write_all`.
    // During a Mac→Win large file paste, ~1500 chunks (50–65ms each)
    // produce a steady stream of `SubmitFileContents` actions. If each one's
    // resulting `ResponseFrame` is awaited inline, the `input_rx` arm gets
    // starved and the user can't click anything in the RDP canvas.
    //
    // Solution: drain `frame_out_rx` in a dedicated task that owns the
    // socket writer. The main loop only does `frame_out_tx.send(frame)`,
    // which is synchronous and ~free.
    let (frame_out_tx, mut frame_out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    tokio::spawn(async move {
        while let Some(frame) = frame_out_rx.recv().await {
            let frame_len = frame.len();
            let start = std::time::Instant::now();
            if frame_len >= 64 * 1024 {
                log::info!("[rdp-native] writer large frame start: {frame_len} bytes");
            }
            if let Err(e) = writer.write_all(&frame).await {
                log::warn!("[rdp-native] writer task failed: {e}");
                return;
            }
            let elapsed = start.elapsed();
            if frame_len >= 64 * 1024 || elapsed >= std::time::Duration::from_millis(250) {
                log::info!(
                    "[rdp-native] writer frame done: {frame_len} bytes in {} ms",
                    elapsed.as_millis()
                );
            }
        }
        log::debug!("[rdp-native] writer task ended (channel closed)");
    });
    let mut image = DecodedImage::new(
        PixelFormat::RgbA32,
        connection_result.desktop_size.width,
        connection_result.desktop_size.height,
    );

    let mut active_stage = ActiveStage::new(connection_result);

    let disconnect_reason = 'outer: loop {
        let outputs = tokio::select! {
            biased;
            input_event = input_rx.recv() => {
                let Some(ev) = input_event else {
                    log::warn!("[rdp-native] input channel closed; treating as user disconnect");
                    break 'outer GracefulDisconnectReason::UserInitiated;
                };

                match ev {
                    NativeRdpInput::FastPath(events) => {
                        active_stage
                            .process_fastpath_input(&mut image, &events)?
                    }
                    NativeRdpInput::Resize { width, height } => {
                        // Use DisplayControl DVC for dynamic resize (no reconnect needed)
                        if let Some(result) = active_stage.encode_resize(
                            width as u32, height as u32, None, None,
                        ) {
                            match result {
                                Ok(frame) => {
                                    log::info!("[rdp-native] DVC resize {width}x{height}");
                                    vec![ActiveStageOutput::ResponseFrame(frame)]
                                }
                                Err(e) => {
                                    log::warn!("[rdp-native] DVC resize encode error: {e}");
                                    Vec::new()
                                }
                            }
                        } else {
                            log::debug!("[rdp-native] DVC not ready, resize {width}x{height} ignored");
                            Vec::new()
                        }
                    }
                    NativeRdpInput::Close => {
                        active_stage.graceful_shutdown()?
                    }
                }
            }
            frame = reader.read_pdu() => {
                let (action, payload) = match frame {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("[rdp-native] read_pdu error: {e:?}");
                        return Err(session::custom_err!("read frame", e));
                    }
                };
                match active_stage.process(&mut image, action, &payload) {
                    Ok(outputs) => outputs,
                    Err(e) => {
                        eprintln!("[rdp-native] process error: {e:?}");
                        return Err(e);
                    }
                }
            }
            cliprdr_action = cliprdr_rx.recv() => {
                if let Some(action) = cliprdr_action {
                    use ironrdp::cliprdr::Cliprdr;
                    use ironrdp::cliprdr::Client as CliprdrClient;

                    let cliprdr = active_stage
                        .get_svc_processor::<Cliprdr<CliprdrClient>>()
                        .expect("CLIPRDR processor not found");

                    let svc_messages = match action {
                        CliprdrAction::InitiateCopy(formats) => {
                            log::info!("[cliprdr] Sending FormatList ({} formats)", formats.len());
                            cliprdr.initiate_copy(&formats)
                                .map_err(|e| session::custom_err!("cliprdr initiate_copy", e))?
                        }
                        CliprdrAction::InitiatePaste(format_id) => {
                            log::info!("[cliprdr] Requesting format {:?}", format_id);
                            cliprdr.initiate_paste(format_id)
                                .map_err(|e| session::custom_err!("cliprdr initiate_paste", e))?
                        }
                        CliprdrAction::SubmitFormatData(response) => {
                            log::info!("[cliprdr] Submitting format data");
                            cliprdr.submit_format_data(response)
                                .map_err(|e| session::custom_err!("cliprdr submit_format_data", e))?
                        }
                        CliprdrAction::SubmitFileContents(response) => {
                            let stream_id = response.stream_id();
                            let data_len = response.data().len();
                            log::info!(
                                "[cliprdr] Submitting file contents stream_id={stream_id} data_len={data_len}"
                            );
                            cliprdr.submit_file_contents(response)
                                .map_err(|e| session::custom_err!("cliprdr submit_file_contents", e))?
                        }
                        CliprdrAction::RequestFileContents(request) => {
                            log::info!("[cliprdr] Requesting file contents");
                            cliprdr.request_file_contents(request)
                                .map_err(|e| session::custom_err!("cliprdr request_file_contents", e))?
                        }
                    };

                    // Encode SVC messages into wire frames
                    let frame = active_stage
                        .process_svc_processor_messages(svc_messages)
                        .map_err(|e| session::custom_err!("cliprdr encode", e))?;

                    vec![ActiveStageOutput::ResponseFrame(frame)]
                } else {
                    Vec::new()
                }
            }
        };

        for out in outputs {
            match out {
                ActiveStageOutput::ResponseFrame(frame) => {
                    // Hand the frame to the writer task; never block the
                    // main select loop on socket writes (see writer task above).
                    if frame_out_tx.send(frame).is_err() {
                        return Err(session::general_err!("writer task ended"));
                    }
                }

                ActiveStageOutput::GraphicsUpdate(region) => {
                    // Extract dirty region pixels from DecodedImage
                    let rw = region.width();
                    let rh = region.height();
                    let stride = image.stride();
                    let bpp = image.bytes_per_pixel();
                    let src = image.data();

                    // Copy dirty rect into contiguous buffer
                    let row_bytes = usize::from(rw) * bpp;
                    let mut region_data = Vec::with_capacity(usize::from(rh) * row_bytes);
                    for row in 0..usize::from(rh) {
                        let y = usize::from(region.top) + row;
                        let off = y * stride + usize::from(region.left) * bpp;
                        let end = off + row_bytes;
                        if end <= src.len() {
                            region_data.extend_from_slice(&src[off..end]);
                        }
                    }

                    // Send via Channel as LZ4-compressed binary frame
                    let raw_len = region_data.len();
                    let frame = build_raw_frame(
                        image.width(),
                        image.height(),
                        region.left,
                        region.top,
                        rw,
                        rh,
                        &region_data,
                    );

                    // Log compression stats periodically
                    static FRAME_COUNT: std::sync::atomic::AtomicU64 =
                        std::sync::atomic::AtomicU64::new(0);
                    let n = FRAME_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    if n < 5 || n % 100 == 0 {
                        let compressed_len = frame.len();
                        let ratio = if compressed_len > 0 {
                            raw_len as f64 / compressed_len as f64
                        } else {
                            0.0
                        };
                        eprintln!("[frame] #{n} region={}x{} raw={raw_len}B sent={compressed_len}B ratio={ratio:.1}x",
                            rw, rh);
                    }

                    let _ = frame_tx.send(frame);
                }

                ActiveStageOutput::PointerDefault => {
                    let _ = app.emit(
                        "rdp://pointer",
                        RdpPointerEvent {
                            tab_id: tab_id.to_string(),
                            kind: "default".into(),
                            ..Default::default()
                        },
                    );
                }

                ActiveStageOutput::PointerHidden => {
                    let _ = app.emit(
                        "rdp://pointer",
                        RdpPointerEvent {
                            tab_id: tab_id.to_string(),
                            kind: "hidden".into(),
                            ..Default::default()
                        },
                    );
                }

                ActiveStageOutput::PointerPosition { x, y } => {
                    let _ = app.emit(
                        "rdp://pointer",
                        RdpPointerEvent {
                            tab_id: tab_id.to_string(),
                            kind: "position".into(),
                            x: Some(x),
                            y: Some(y),
                            ..Default::default()
                        },
                    );
                }

                ActiveStageOutput::PointerBitmap(pointer) => {
                    let _ = app.emit(
                        "rdp://pointer",
                        RdpPointerEvent {
                            tab_id: tab_id.to_string(),
                            kind: "bitmap".into(),
                            width: Some(pointer.width),
                            height: Some(pointer.height),
                            hotspot_x: Some(pointer.hotspot_x),
                            hotspot_y: Some(pointer.hotspot_y),
                            bitmap: Some(pointer.bitmap_data.clone()),
                            ..Default::default()
                        },
                    );
                }

                ActiveStageOutput::DeactivateAll(mut ca) => {
                    log::debug!("[rdp-native] Deactivation-Reactivation");
                    let mut buf = WriteBuf::new();
                    'reactivate: loop {
                        let written = single_sequence_step_read(&mut reader, &mut *ca, &mut buf)
                            .await
                            .map_err(|e| session::custom_err!("reactivation", e))?;

                        if written.size().is_some() {
                            frame_out_tx.send(buf.filled().to_vec()).map_err(|_| {
                                session::general_err!("writer task ended during reactivation")
                            })?;
                        }

                        if let ConnectionActivationState::Finalized {
                            io_channel_id,
                            user_channel_id,
                            desktop_size,
                            share_id,
                            enable_server_pointer,
                            pointer_software_rendering,
                        } = ca.connection_activation_state()
                        {
                            log::debug!("[rdp-native] Reactivated: {desktop_size:?}");
                            image = DecodedImage::new(
                                PixelFormat::RgbA32,
                                desktop_size.width,
                                desktop_size.height,
                            );
                            active_stage.set_fastpath_processor(
                                fast_path::ProcessorBuilder {
                                    io_channel_id,
                                    user_channel_id,
                                    share_id,
                                    enable_server_pointer,
                                    pointer_software_rendering,
                                    bulk_decompressor: None,
                                }
                                .build(),
                            );
                            active_stage.set_share_id(share_id);
                            active_stage.set_enable_server_pointer(enable_server_pointer);
                            break 'reactivate;
                        }
                    }
                }

                ActiveStageOutput::MultitransportRequest(_pdu) => {
                    log::debug!("[rdp-native] Multitransport request (UDP not impl)");
                }

                ActiveStageOutput::Terminate(reason) => break 'outer reason,
            }
        }
    };

    Ok(disconnect_reason)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_rdp_routes_public_targets_through_socks() {
        assert_eq!(
            choose_native_rdp_route("64.20.10.254", 17897),
            NativeRdpRoute::Socks5 { port: 17897 }
        );
        assert_eq!(
            choose_native_rdp_route("rdp.example.com", 17897),
            NativeRdpRoute::Socks5 { port: 17897 }
        );
    }

    #[test]
    fn native_rdp_routes_private_targets_directly() {
        assert_eq!(
            choose_native_rdp_route("192.168.3.10", 17897),
            NativeRdpRoute::Direct
        );
        assert_eq!(
            choose_native_rdp_route("127.0.0.1", 17897),
            NativeRdpRoute::Direct
        );
    }
}

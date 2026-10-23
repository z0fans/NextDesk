use super::host_keys::{self, HostKeyStatus};
use super::manager::SshControl;
use super::monitor::{collect_monitor_snapshot, MonitorRuntime};
use super::sftp::SftpRuntime;
use super::types::{
    SshAuthMethod, SshEvent, SshHostKeyPreview, SshProxyType, SshStartRequest,
    StoredPrivateKeyCredential,
};
use crate::connection_outcome::{
    spawn_report_for_lease, ConnectionOutcomeInput, OutcomeStage, OutcomeStatus,
};
use crate::connection_resolver::{self, RouteLease, ServiceKind};
use crate::state::AppState;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use russh::client;
use russh::keys::{
    decode_secret_key, load_secret_key, ssh_key::PublicKey, PrivateKey, PrivateKeyWithHashAlg,
};
use russh::{ChannelMsg, Disconnect};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::time::Instant;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

const SSH_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const SSH_AUTH_TIMEOUT: Duration = Duration::from_secs(30);
const SSH_CHANNEL_TIMEOUT: Duration = Duration::from_secs(15);
const SSH_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
const SSH_KEEPALIVE_MAX_MISSED: usize = 4;
const ROUTE_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Default)]
struct HostKeyCapture {
    rejected: Mutex<Option<SshHostKeyPreview>>,
    server_key_seen: AtomicBool,
}

pub(super) struct NextDeskSshClient {
    identity_host: String,
    identity_port: u16,
    capture: Arc<HostKeyCapture>,
}

impl client::Handler for NextDeskSshClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        self.capture.server_key_seen.store(true, Ordering::Release);
        let status = host_keys::host_key_status(
            &self.identity_host,
            self.identity_port,
            server_public_key,
            &host_keys::known_hosts_path(),
        );
        match status {
            Ok(HostKeyStatus::Trusted) => Ok(true),
            Ok(status @ (HostKeyStatus::Unknown | HostKeyStatus::Changed { .. })) => {
                let preview = SshHostKeyPreview {
                    host: self.identity_host.clone(),
                    port: self.identity_port,
                    status: match status {
                        HostKeyStatus::Unknown => "unknown".to_string(),
                        HostKeyStatus::Changed { .. } => "changed".to_string(),
                        HostKeyStatus::Trusted => unreachable!(),
                    },
                    algorithm: server_public_key.algorithm().to_string(),
                    fingerprint: host_keys::fingerprint(server_public_key),
                    public_key: server_public_key.to_openssh().unwrap_or_default(),
                };
                *self.capture.rejected.lock().unwrap() = Some(preview);
                Ok(false)
            }
            Err(_) => Ok(false),
        }
    }
}

pub async fn run_session(
    app: AppHandle,
    request: SshStartRequest,
    lease: RouteLease,
    route_duration_ms: u64,
    control_rx: mpsc::Receiver<SshControl>,
    on_output: Channel<InvokeResponseBody>,
    on_event: Channel<SshEvent>,
    cancellation: CancellationToken,
) {
    let session_id = request.session_id.clone();
    let mut lease = lease;
    let outcome_attempt_id = format!("ssh-{}-lease-{}", session_id, lease.lease_id);
    let session_started = Instant::now();
    let mut stage_durations_ms = BTreeMap::from([
        ("scheduling".to_string(), route_duration_ms),
        ("candidate_validation".to_string(), 0),
    ]);
    let mut connecting = ConnectionOutcomeInput::new(
        session_id.clone(),
        ServiceKind::Ssh,
        OutcomeStatus::Connecting,
        OutcomeStage::Transport,
    );
    connecting.attempt_id = Some(outcome_attempt_id.clone());
    connecting.duration_ms = Some(0);
    connecting.stage_durations_ms = stage_durations_ms.clone();
    spawn_report_for_lease(connecting, Some(lease.clone()));
    let result = run_session_inner(
        &app,
        &request,
        &mut lease,
        control_rx,
        &on_output,
        &on_event,
        &cancellation,
        session_started,
        &outcome_attempt_id,
        &mut stage_durations_ms,
    )
    .await;
    let route_label = lease.route_label.clone();
    let state = app.state::<AppState>();

    let mut emit_disconnected = true;
    let mut release_route = cancellation.is_cancelled();
    if let Err(failure) = result {
        let mut outcome = ConnectionOutcomeInput::new(
            session_id.clone(),
            ServiceKind::Ssh,
            OutcomeStatus::Failed,
            outcome_stage_for_failure(&failure),
        );
        outcome.attempt_id = Some(outcome_attempt_id.clone());
        outcome.duration_ms = Some(session_started.elapsed().as_millis() as u64);
        outcome.stage_durations_ms = stage_durations_ms.clone();
        match failure {
            SessionFailure::HostKey(preview) => {
                outcome.outcome_category = Some("host_identity_untrusted".to_string());
                outcome.error_code = Some("ssh_host_key_untrusted".to_string());
                release_route = true;
                let _ = on_event.send(SshEvent::HostKey {
                    session_id: session_id.clone(),
                    preview,
                });
            }
            SessionFailure::Message(message) => {
                outcome.error_code = Some(super::sanitize_diagnostic_code(&message));
                release_route |= !reconnect_grace_allowed(&message);
                emit_disconnected = false;
                log::warn!(
                    "[ssh] session failed code={}",
                    super::sanitize_diagnostic_code(&message)
                );
                let _ = on_event.send(SshEvent::state(
                    &session_id,
                    "error",
                    Some(&route_label),
                    Some(message),
                ));
            }
            SessionFailure::Cancelled => {
                outcome.status = OutcomeStatus::Disconnected;
                outcome.stage = OutcomeStage::Disconnected;
                outcome.user_initiated = true;
                release_route = true;
            }
        }
        spawn_report_for_lease(outcome, Some(lease.clone()));
    } else {
        let mut outcome = ConnectionOutcomeInput::new(
            session_id.clone(),
            ServiceKind::Ssh,
            OutcomeStatus::Disconnected,
            OutcomeStage::Disconnected,
        );
        outcome.attempt_id = Some(outcome_attempt_id.clone());
        outcome.session_duration_ms = Some(session_started.elapsed().as_millis() as u64);
        outcome.stage_durations_ms = stage_durations_ms;
        outcome.user_initiated = cancellation.is_cancelled();
        spawn_report_for_lease(outcome, Some(lease.clone()));
    }
    if emit_disconnected {
        let _ = on_event.send(SshEvent::state(
            &session_id,
            "disconnected",
            Some(&route_label),
            None,
        ));
    }
    if release_route {
        connection_resolver::release_route_lease(state.inner(), &lease);
    } else {
        log::info!(
            "[ssh] retaining route for reconnect grace service=ssh session={}",
            session_id
        );
    }
    state.ssh_sessions.lock().unwrap().remove(&session_id);
}

fn outcome_stage_for_failure(failure: &SessionFailure) -> OutcomeStage {
    let SessionFailure::Message(message) = failure else {
        return match failure {
            SessionFailure::HostKey(_) => OutcomeStage::HostIdentity,
            SessionFailure::Cancelled => OutcomeStage::Disconnected,
            SessionFailure::Message(_) => unreachable!(),
        };
    };
    if message.starts_with("ssh_password_")
        || message.starts_with("ssh_key_")
        || message.starts_with("ssh_private_key_")
        || message.starts_with("ssh_authentication_")
    {
        OutcomeStage::Authentication
    } else if message.starts_with("ssh_kex_") || message.starts_with("ssh_proxy_handshake_") {
        OutcomeStage::ProtocolHandshake
    } else if message.starts_with("ssh_transport_") || message.starts_with("ssh_proxy_connect_") {
        OutcomeStage::Transport
    } else {
        OutcomeStage::Failed
    }
}

fn reconnect_grace_allowed(message: &str) -> bool {
    [
        "ssh_transport_",
        "ssh_channel_",
        "ssh_pty_",
        "ssh_shell_",
        "ssh_input_",
        "ssh_output_",
        "ssh_resize_",
    ]
    .iter()
    .any(|prefix| message.starts_with(prefix))
}

#[derive(Debug)]
enum SessionFailure {
    HostKey(SshHostKeyPreview),
    Message(String),
    Cancelled,
}

impl From<String> for SessionFailure {
    fn from(value: String) -> Self {
        Self::Message(value)
    }
}

fn should_retry_direct_after_transport_failure(
    request: &SshStartRequest,
    lease: &RouteLease,
    failure: &SessionFailure,
) -> bool {
    request.route_policy == crate::connection_resolver::RoutePolicy::Auto
        && lease.binding_id.is_some()
        && matches!(
            failure,
            SessionFailure::Message(message) if message.starts_with("ssh_transport_")
        )
}

async fn connect_transport(
    request: &SshStartRequest,
    lease: &RouteLease,
    cancellation: &CancellationToken,
) -> Result<client::Handle<NextDeskSshClient>, SessionFailure> {
    let capture = Arc::new(HostKeyCapture::default());
    let handler = NextDeskSshClient {
        identity_host: lease.identity_target.host.clone(),
        identity_port: lease.identity_target.port,
        capture: Arc::clone(&capture),
    };
    let config = Arc::new(client::Config {
        keepalive_interval: Some(SSH_KEEPALIVE_INTERVAL),
        keepalive_max: SSH_KEEPALIVE_MAX_MISSED,
        nodelay: true,
        ..Default::default()
    });
    let connect = establish_transport(request, lease, config, handler);
    let connect_result = tokio::select! {
        _ = cancellation.cancelled() => return Err(SessionFailure::Cancelled),
        result = tokio::time::timeout(SSH_CONNECT_TIMEOUT, connect) => result,
    };
    match connect_result {
        Ok(Ok(session)) => Ok(session),
        Ok(Err(error)) => {
            if let Some(preview) = capture.rejected.lock().unwrap().clone() {
                return Err(SessionFailure::HostKey(preview));
            }
            if capture.server_key_seen.load(Ordering::Acquire) {
                return Err(SessionFailure::Message(format!("ssh_kex_failed:{error}")));
            }
            if error.starts_with("ssh_proxy_") {
                Err(SessionFailure::Message(error))
            } else {
                Err(SessionFailure::Message(format!(
                    "ssh_transport_connect_failed:{error}"
                )))
            }
        }
        Err(_) => Err(SessionFailure::Message(
            "ssh_transport_connect_timeout".to_string(),
        )),
    }
}

async fn establish_transport(
    request: &SshStartRequest,
    lease: &RouteLease,
    config: Arc<client::Config>,
    handler: NextDeskSshClient,
) -> Result<client::Handle<NextDeskSshClient>, String> {
    if request.proxy_type == SshProxyType::None {
        return client::connect(
            config,
            (lease.dial_target.host.as_str(), lease.dial_target.port),
            handler,
        )
        .await
        .map_err(|error| error.to_string());
    }

    let proxy_host = request
        .proxy_host
        .as_deref()
        .ok_or_else(|| "ssh_proxy_host_required".to_string())?;
    let proxy_port = request
        .proxy_port
        .ok_or_else(|| "ssh_proxy_port_invalid".to_string())?;
    let proxy_password = request
        .resolve_proxy_secret()
        .map_err(|_| "ssh_proxy_credential_failed".to_string())?;
    let mut stream = TcpStream::connect((proxy_host, proxy_port))
        .await
        .map_err(|_| "ssh_proxy_connect_failed".to_string())?;
    stream
        .set_nodelay(true)
        .map_err(|_| "ssh_proxy_connect_failed".to_string())?;
    match request.proxy_type {
        SshProxyType::Socks5 => {
            socks5_connect(
                &mut stream,
                &lease.dial_target.host,
                lease.dial_target.port,
                request.proxy_username.as_deref(),
                proxy_password.as_deref(),
            )
            .await?;
        }
        SshProxyType::Http => {
            http_connect(
                &mut stream,
                &lease.dial_target.host,
                lease.dial_target.port,
                request.proxy_username.as_deref(),
                proxy_password.as_deref(),
            )
            .await?;
        }
        SshProxyType::None => unreachable!(),
    }
    client::connect_stream(config, stream, handler)
        .await
        .map_err(|error| error.to_string())
}

async fn socks5_connect(
    stream: &mut TcpStream,
    target_host: &str,
    target_port: u16,
    username: Option<&str>,
    password: Option<&str>,
) -> Result<(), String> {
    let use_auth = username.is_some() || password.is_some();
    let greeting = if use_auth {
        [5_u8, 2, 0, 2].as_slice()
    } else {
        [5_u8, 1, 0].as_slice()
    };
    stream
        .write_all(greeting)
        .await
        .map_err(|_| "ssh_proxy_handshake_failed".to_string())?;
    let mut selection = [0_u8; 2];
    stream
        .read_exact(&mut selection)
        .await
        .map_err(|_| "ssh_proxy_handshake_failed".to_string())?;
    if selection[0] != 5 || selection[1] == 0xff {
        return Err("ssh_proxy_authentication_failed".to_string());
    }
    if selection[1] == 2 {
        let username = username.unwrap_or_default().as_bytes();
        let password = password.unwrap_or_default().as_bytes();
        if username.len() > 255 || password.len() > 255 {
            return Err("ssh_proxy_credential_invalid".to_string());
        }
        let mut auth = Vec::with_capacity(username.len() + password.len() + 3);
        auth.extend_from_slice(&[1, username.len() as u8]);
        auth.extend_from_slice(username);
        auth.push(password.len() as u8);
        auth.extend_from_slice(password);
        stream
            .write_all(&auth)
            .await
            .map_err(|_| "ssh_proxy_handshake_failed".to_string())?;
        let mut response = [0_u8; 2];
        stream
            .read_exact(&mut response)
            .await
            .map_err(|_| "ssh_proxy_handshake_failed".to_string())?;
        if response != [1, 0] {
            return Err("ssh_proxy_authentication_failed".to_string());
        }
    } else if selection[1] != 0 {
        return Err("ssh_proxy_authentication_failed".to_string());
    }

    let host = target_host.as_bytes();
    if host.is_empty() || host.len() > 255 {
        return Err("ssh_proxy_target_invalid".to_string());
    }
    let mut request = Vec::with_capacity(host.len() + 7);
    request.extend_from_slice(&[5, 1, 0, 3, host.len() as u8]);
    request.extend_from_slice(host);
    request.extend_from_slice(&target_port.to_be_bytes());
    stream
        .write_all(&request)
        .await
        .map_err(|_| "ssh_proxy_handshake_failed".to_string())?;
    let mut response = [0_u8; 4];
    stream
        .read_exact(&mut response)
        .await
        .map_err(|_| "ssh_proxy_handshake_failed".to_string())?;
    if response[0] != 5 || response[1] != 0 {
        return Err("ssh_proxy_connect_failed".to_string());
    }
    let address_length = match response[3] {
        1 => 4,
        4 => 16,
        3 => {
            let mut length = [0_u8; 1];
            stream
                .read_exact(&mut length)
                .await
                .map_err(|_| "ssh_proxy_handshake_failed".to_string())?;
            length[0] as usize
        }
        _ => return Err("ssh_proxy_handshake_failed".to_string()),
    };
    let mut remainder = vec![0_u8; address_length + 2];
    stream
        .read_exact(&mut remainder)
        .await
        .map_err(|_| "ssh_proxy_handshake_failed".to_string())?;
    Ok(())
}

async fn http_connect(
    stream: &mut TcpStream,
    target_host: &str,
    target_port: u16,
    username: Option<&str>,
    password: Option<&str>,
) -> Result<(), String> {
    let authority = format!("{target_host}:{target_port}");
    let mut request = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
    if let Some(username) = username {
        let credentials =
            BASE64_STANDARD.encode(format!("{username}:{}", password.unwrap_or_default()));
        request.push_str(&format!("Proxy-Authorization: Basic {credentials}\r\n"));
    }
    request.push_str("Proxy-Connection: Keep-Alive\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|_| "ssh_proxy_handshake_failed".to_string())?;
    let mut response = Vec::with_capacity(512);
    let mut byte = [0_u8; 1];
    while response.len() < 16 * 1024 {
        stream
            .read_exact(&mut byte)
            .await
            .map_err(|_| "ssh_proxy_handshake_failed".to_string())?;
        response.push(byte[0]);
        if response.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    if !response.ends_with(b"\r\n\r\n") {
        return Err("ssh_proxy_handshake_failed".to_string());
    }
    let response =
        String::from_utf8(response).map_err(|_| "ssh_proxy_handshake_failed".to_string())?;
    let status = response.lines().next().unwrap_or_default();
    if !status
        .split_whitespace()
        .nth(1)
        .is_some_and(|code| code == "200")
    {
        return Err(if status.contains(" 407 ") {
            "ssh_proxy_authentication_failed".to_string()
        } else {
            "ssh_proxy_connect_failed".to_string()
        });
    }
    Ok(())
}

async fn run_session_inner(
    app: &AppHandle,
    request: &SshStartRequest,
    lease: &mut RouteLease,
    control_rx: mpsc::Receiver<SshControl>,
    on_output: &Channel<InvokeResponseBody>,
    on_event: &Channel<SshEvent>,
    cancellation: &CancellationToken,
    session_started: Instant,
    outcome_attempt_id: &str,
    stage_durations_ms: &mut BTreeMap<String, u64>,
) -> Result<(), SessionFailure> {
    let _ = on_event.send(SshEvent::state(
        &request.session_id,
        "connecting_transport",
        Some(&lease.route_label),
        None,
    ));
    let transport_started = Instant::now();
    let mut ssh = match connect_transport(request, lease, cancellation).await {
        Err(failure) if should_retry_direct_after_transport_failure(request, lease, &failure) => {
            log::warn!(
                "[ssh] cloud transport failed before server identity; retrying direct code={}",
                match &failure {
                    SessionFailure::Message(message) => super::sanitize_diagnostic_code(message),
                    _ => "ssh_transport_connect_failed".to_string(),
                }
            );
            let state = app.state::<AppState>();
            *lease = connection_resolver::replace_route_with_direct_fallback(state.inner(), lease)
                .map_err(SessionFailure::Message)?;
            let _ = on_event.send(SshEvent::state(
                &request.session_id,
                "connecting_transport",
                Some(&lease.route_label),
                None,
            ));
            connect_transport(request, lease, cancellation).await?
        }
        result => result?,
    };
    stage_durations_ms.insert(
        "transport".to_string(),
        transport_started.elapsed().as_millis() as u64,
    );

    let mut handshake = ConnectionOutcomeInput::new(
        request.session_id.clone(),
        ServiceKind::Ssh,
        OutcomeStatus::Connecting,
        OutcomeStage::ProtocolHandshake,
    );
    handshake.attempt_id = Some(outcome_attempt_id.to_string());
    handshake.duration_ms = Some(session_started.elapsed().as_millis() as u64);
    handshake.stage_durations_ms = stage_durations_ms.clone();
    spawn_report_for_lease(handshake, Some(lease.clone()));

    let _ = on_event.send(SshEvent::state(
        &request.session_id,
        "authenticating",
        Some(&lease.route_label),
        None,
    ));
    let mut authenticating = ConnectionOutcomeInput::new(
        request.session_id.clone(),
        ServiceKind::Ssh,
        OutcomeStatus::Connecting,
        OutcomeStage::Authentication,
    );
    authenticating.attempt_id = Some(outcome_attempt_id.to_string());
    authenticating.duration_ms = Some(session_started.elapsed().as_millis() as u64);
    authenticating.stage_durations_ms = stage_durations_ms.clone();
    spawn_report_for_lease(authenticating, Some(lease.clone()));
    let authentication_started = Instant::now();
    let secret = request.resolve_secret().map_err(SessionFailure::Message)?;
    let auth_result = match request.auth_method {
        SshAuthMethod::Password => {
            let password = secret
                .ok_or_else(|| SessionFailure::Message("ssh_password_required".to_string()))?;
            let authentication =
                ssh.authenticate_password(request.username.trim().to_string(), password);
            match tokio::select! {
                _ = cancellation.cancelled() => return Err(SessionFailure::Cancelled),
                result = tokio::time::timeout(SSH_AUTH_TIMEOUT, authentication) => result,
            } {
                Ok(result) => result.map_err(|error| {
                    SessionFailure::Message(format!("ssh_password_authentication_failed:{error}"))
                })?,
                Err(_) => {
                    return Err(SessionFailure::Message(
                        "ssh_authentication_timeout".to_string(),
                    ))
                }
            }
        }
        SshAuthMethod::PrivateKey => {
            let key_path = request
                .private_key_path
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(expand_private_key_path)
                .transpose()?;
            let stored_credential = secret;
            let key_loader = tauri::async_runtime::spawn_blocking(move || {
                if let Some(key_path) = key_path {
                    return load_secret_key(key_path, stored_credential.as_deref()).map_err(
                        |error| {
                            SessionFailure::Message(format!("ssh_private_key_load_failed:{error}"))
                        },
                    );
                }
                let stored_credential = stored_credential.ok_or_else(|| {
                    SessionFailure::Message("ssh_private_key_required".to_string())
                })?;
                decode_inline_private_key(&stored_credential)
            });
            let key = match tokio::select! {
                _ = cancellation.cancelled() => return Err(SessionFailure::Cancelled),
                result = key_loader => result,
            } {
                Ok(result) => result?,
                Err(error) => {
                    return Err(SessionFailure::Message(format!(
                        "ssh_private_key_task_failed:{error}"
                    )))
                }
            };
            let hash_query = ssh.best_supported_rsa_hash();
            let hash = match tokio::select! {
                _ = cancellation.cancelled() => return Err(SessionFailure::Cancelled),
                result = tokio::time::timeout(SSH_CHANNEL_TIMEOUT, hash_query) => result,
            } {
                Ok(result) => result
                    .map_err(|error| {
                        SessionFailure::Message(format!("ssh_key_algorithm_failed:{error}"))
                    })?
                    .flatten(),
                Err(_) => {
                    return Err(SessionFailure::Message(
                        "ssh_key_algorithm_timeout".to_string(),
                    ))
                }
            };
            let authentication = ssh.authenticate_publickey(
                request.username.trim().to_string(),
                PrivateKeyWithHashAlg::new(Arc::new(key), hash),
            );
            match tokio::select! {
                _ = cancellation.cancelled() => return Err(SessionFailure::Cancelled),
                result = tokio::time::timeout(SSH_AUTH_TIMEOUT, authentication) => result,
            } {
                Ok(result) => result.map_err(|error| {
                    SessionFailure::Message(format!("ssh_key_authentication_failed:{error}"))
                })?,
                Err(_) => {
                    return Err(SessionFailure::Message(
                        "ssh_authentication_timeout".to_string(),
                    ))
                }
            }
        }
    };
    if !auth_result.success() {
        return Err(SessionFailure::Message(
            "ssh_authentication_rejected".to_string(),
        ));
    }
    stage_durations_ms.insert(
        "authentication".to_string(),
        authentication_started.elapsed().as_millis() as u64,
    );

    let ssh = Arc::new(ssh);
    let session_establish_started = Instant::now();
    let channel = match tokio::select! {
        _ = cancellation.cancelled() => return Err(SessionFailure::Cancelled),
        result = tokio::time::timeout(SSH_CHANNEL_TIMEOUT, ssh.channel_open_session()) => result,
    } {
        Ok(result) => result
            .map_err(|error| SessionFailure::Message(format!("ssh_channel_open_failed:{error}")))?,
        Err(_) => {
            return Err(SessionFailure::Message(
                "ssh_channel_open_timeout".to_string(),
            ))
        }
    };
    let pty_request = channel.request_pty(
        true,
        "xterm-256color",
        u32::from(request.cols.max(1)),
        u32::from(request.rows.max(1)),
        u32::from(request.pixel_width),
        u32::from(request.pixel_height),
        &[],
    );
    match tokio::select! {
        _ = cancellation.cancelled() => return Err(SessionFailure::Cancelled),
        result = tokio::time::timeout(SSH_CHANNEL_TIMEOUT, pty_request) => result,
    } {
        Ok(result) => {
            result.map_err(|error| SessionFailure::Message(format!("ssh_pty_failed:{error}")))?
        }
        Err(_) => return Err(SessionFailure::Message("ssh_pty_timeout".to_string())),
    }
    match tokio::select! {
        _ = cancellation.cancelled() => return Err(SessionFailure::Cancelled),
        result = tokio::time::timeout(SSH_CHANNEL_TIMEOUT, channel.request_shell(true)) => result,
    } {
        Ok(result) => {
            result.map_err(|error| SessionFailure::Message(format!("ssh_shell_failed:{error}")))?
        }
        Err(_) => return Err(SessionFailure::Message("ssh_shell_timeout".to_string())),
    }
    let _ = on_event.send(SshEvent::state(
        &request.session_id,
        "connected",
        Some(&lease.route_label),
        None,
    ));
    let mut connected = ConnectionOutcomeInput::new(
        request.session_id.clone(),
        ServiceKind::Ssh,
        OutcomeStatus::Connected,
        OutcomeStage::SessionEstablished,
    );
    stage_durations_ms.insert(
        "session_established".to_string(),
        session_establish_started.elapsed().as_millis() as u64,
    );
    connected.attempt_id = Some(outcome_attempt_id.to_string());
    connected.duration_ms = Some(session_started.elapsed().as_millis() as u64);
    connected.stage_durations_ms = stage_durations_ms.clone();
    spawn_report_for_lease(connected, Some(lease.clone()));

    let interactive_started = Instant::now();
    run_connected_session(
        ssh,
        channel.split(),
        control_rx,
        on_output,
        cancellation,
        |event| match event {
            ConnectedEvent::FirstOutput => {
                let mut interactive = ConnectionOutcomeInput::new(
                    request.session_id.clone(),
                    ServiceKind::Ssh,
                    OutcomeStatus::Connected,
                    OutcomeStage::FirstInteractiveResult,
                );
                interactive.attempt_id = Some(outcome_attempt_id.to_string());
                interactive.duration_ms = Some(session_started.elapsed().as_millis() as u64);
                stage_durations_ms.insert(
                    "first_interactive_result".to_string(),
                    interactive_started.elapsed().as_millis() as u64,
                );
                interactive.stage_durations_ms = stage_durations_ms.clone();
                spawn_report_for_lease(interactive, Some(lease.clone()));
            }
            ConnectedEvent::Exit(exit_status) => {
                let _ = on_event.send(SshEvent::state(
                    &request.session_id,
                    "exited",
                    Some(&lease.route_label),
                    Some(exit_status.to_string()),
                ));
            }
        },
        || async {
            let state = app.state::<AppState>();
            if let Err(error) = connection_resolver::keep_route_alive(
                state.inner(),
                ServiceKind::Ssh,
                Some(&request.session_id),
                &lease.identity_target.host,
                lease.identity_target.port,
            )
            .await
            {
                log::warn!("[ssh] cloud route keepalive failed service=ssh error={error}");
            }
        },
    )
    .await
}

enum ConnectedEvent {
    FirstOutput,
    Exit(u32),
}

async fn run_connected_session<
    H: client::Handler + Send + 'static,
    F: std::future::Future<Output = ()>,
>(
    ssh: Arc<client::Handle<H>>,
    channel: (russh::ChannelReadHalf, russh::ChannelWriteHalf<client::Msg>),
    mut control_rx: mpsc::Receiver<SshControl>,
    on_output: &Channel<InvokeResponseBody>,
    cancellation: &CancellationToken,
    mut on_activity: impl FnMut(ConnectedEvent),
    mut keep_route_alive: impl FnMut() -> F,
) -> Result<(), SessionFailure> {
    let (mut read_half, write_half) = channel;
    let mut route_tick = tokio::time::interval(ROUTE_KEEPALIVE_INTERVAL);
    let closing = cancellation.child_token();
    let sftp_runtime = Arc::new(tokio::sync::Mutex::new(SftpRuntime::new(closing.clone())));
    let monitor_runtime = Arc::new(Mutex::new(MonitorRuntime::default()));
    let mut tasks = JoinSet::new();
    let mut first_interactive_reported = false;
    let mut remote_exit_seen = false;
    route_tick.tick().await;
    // Cancellation also interrupts blocked input, resize and route keepalive awaits.
    let result = tokio::select! {
        biased;
        _ = cancellation.cancelled() => Ok(()),
        result = async {
            loop {
                tokio::select! {
                    message = read_half.wait() => {
                        match message {
                            Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                                on_output
                                    .send(InvokeResponseBody::Raw(data.to_vec()))
                                    .map_err(|error| SessionFailure::Message(format!("ssh_output_channel_failed:{error}")))?;
                                if !first_interactive_reported {
                                    first_interactive_reported = true;
                                    on_activity(ConnectedEvent::FirstOutput);
                                }
                            }
                            Some(ChannelMsg::ExitStatus { exit_status }) => {
                                remote_exit_seen = true;
                                on_activity(ConnectedEvent::Exit(exit_status));
                            }
                            Some(ChannelMsg::Eof | ChannelMsg::Close) | None => {
                                break if remote_exit_seen {
                                    Ok(())
                                } else {
                                    Err(SessionFailure::Message("ssh_transport_lost".to_string()))
                                };
                            }
                            _ => {}
                        }
                    }
                    control = control_rx.recv() => {
                        match control {
                            Some(SshControl::Input(data)) => {
                                write_half.data(&data[..]).await.map_err(|error| {
                                    SessionFailure::Message(format!("ssh_input_failed:{error}"))
                                })?;
                            }
                            Some(SshControl::Resize { cols, rows, pixel_width, pixel_height }) => {
                                write_half.window_change(
                                    u32::from(cols),
                                    u32::from(rows),
                                    u32::from(pixel_width),
                                    u32::from(pixel_height),
                                ).await.map_err(|error| {
                                    SessionFailure::Message(format!("ssh_resize_failed:{error}"))
                                })?;
                            }
                            Some(SshControl::Sftp(control)) => {
                                let runtime = Arc::clone(&sftp_runtime);
                                let ssh = Arc::clone(&ssh);
                                tasks.spawn_on(async move {
                                    runtime.lock().await.handle(control, ssh.as_ref()).await;
                                }, tauri::async_runtime::handle().inner());
                            }
                            Some(SshControl::Monitor { reply }) => {
                                let ssh = Arc::clone(&ssh);
                                let runtime = Arc::clone(&monitor_runtime);
                                let closing = closing.clone();
                                tasks.spawn_on(async move {
                                    let result = tokio::select! {
                                        biased;
                                        _ = closing.cancelled() => Err("ssh_monitor_session_closed".to_string()),
                                        result = collect_monitor_snapshot(ssh, runtime) => result,
                                    };
                                    let _ = reply.send(result);
                                }, tauri::async_runtime::handle().inner());
                            }
                            Some(SshControl::Close) | None => break Ok(()),
                        }
                    }
                    _ = tasks.join_next(), if !tasks.is_empty() => {}
                    _ = route_tick.tick() => keep_route_alive().await,
                }
            }
        } => result,
    };

    control_rx.close();
    while control_rx.try_recv().is_ok() {}
    closing.cancel();
    // Join dispatchers before acquiring the runtime lock: an SFTP open may own it.
    tasks.shutdown().await;
    sftp_runtime.lock().await.shutdown().await;
    let _ = tokio::time::timeout(Duration::from_secs(3), async {
        let _ = write_half.eof().await;
        let _ = write_half.close().await;
        let _ = ssh
            .disconnect(Disconnect::ByApplication, "session closed", "en")
            .await;
    })
    .await;
    result
}

fn expand_private_key_path(path: &str) -> Result<PathBuf, SessionFailure> {
    let path = path.trim();
    if path.is_empty() {
        return Err(SessionFailure::Message(
            "ssh_private_key_required".to_string(),
        ));
    }
    if path == "~" {
        return dirs::home_dir()
            .ok_or_else(|| SessionFailure::Message("ssh_home_directory_unavailable".to_string()));
    }
    if let Some(relative) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        let home = dirs::home_dir()
            .ok_or_else(|| SessionFailure::Message("ssh_home_directory_unavailable".to_string()))?;
        return Ok(home.join(relative));
    }
    if path.starts_with('~') {
        return Err(SessionFailure::Message(
            "ssh_private_key_path_invalid".to_string(),
        ));
    }
    Ok(Path::new(path).to_path_buf())
}

fn decode_inline_private_key(stored: &str) -> Result<PrivateKey, SessionFailure> {
    let credential = StoredPrivateKeyCredential::decode(stored).map_err(SessionFailure::Message)?;
    decode_secret_key(credential.private_key(), credential.passphrase())
        .map_err(|error| SessionFailure::Message(format!("ssh_private_key_load_failed:{error}")))
}

#[cfg(test)]
mod tests {
    use super::{
        decode_inline_private_key, expand_private_key_path, http_connect,
        should_retry_direct_after_transport_failure, socks5_connect, SessionFailure,
    };
    use crate::connection_resolver::{RouteLease, RoutePolicy, ServiceKind, TargetAddress};
    use crate::ssh::types::{
        SshAuthMethod, SshProxyType, SshStartRequest, StoredPrivateKeyCredential,
    };
    use std::collections::HashMap;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    fn request(route_policy: RoutePolicy) -> SshStartRequest {
        SshStartRequest {
            session_id: "ssh-test".to_string(),
            host: "203.0.113.10".to_string(),
            port: 22,
            username: "root".to_string(),
            auth_method: SshAuthMethod::Password,
            credential_reference: Some("ssh-test".to_string()),
            private_key_path: None,
            cols: 80,
            rows: 24,
            pixel_width: 0,
            pixel_height: 0,
            route_policy,
            preferred_region: None,
            network_route_preferences: HashMap::new(),
            reuse_cloud_binding: false,
            replace_existing: false,
            proxy_type: SshProxyType::None,
            proxy_host: None,
            proxy_port: None,
            proxy_username: None,
            proxy_credential_reference: None,
        }
    }

    fn cloud_lease() -> RouteLease {
        RouteLease {
            lease_id: 1,
            service_kind: ServiceKind::Ssh,
            session_id: Some("ssh-test".to_string()),
            dial_target: TargetAddress {
                host: "relay.example.com".to_string(),
                port: 42022,
            },
            identity_target: TargetAddress {
                host: "203.0.113.10".to_string(),
                port: 22,
            },
            binding_id: Some("binding-test".to_string()),
            route_label: "cloud".to_string(),
            force_direct: true,
            route_policy: RoutePolicy::Auto,
            policy_revision: Some("routing-test-v1".to_string()),
            route_diagnostics: None,
            network_scope_id: None,
        }
    }

    #[tokio::test]
    async fn negotiates_authenticated_socks5_connect_tunnels() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut greeting = [0_u8; 4];
            stream.read_exact(&mut greeting).await.unwrap();
            assert_eq!(greeting, [5, 2, 0, 2]);
            stream.write_all(&[5, 2]).await.unwrap();

            let mut auth_header = [0_u8; 2];
            stream.read_exact(&mut auth_header).await.unwrap();
            let mut username = vec![0_u8; auth_header[1] as usize];
            stream.read_exact(&mut username).await.unwrap();
            let mut password_length = [0_u8; 1];
            stream.read_exact(&mut password_length).await.unwrap();
            let mut password = vec![0_u8; password_length[0] as usize];
            stream.read_exact(&mut password).await.unwrap();
            assert_eq!(username, b"proxy-user");
            assert_eq!(password, b"proxy-pass");
            stream.write_all(&[1, 0]).await.unwrap();

            let mut connect_header = [0_u8; 5];
            stream.read_exact(&mut connect_header).await.unwrap();
            assert_eq!(&connect_header[..4], &[5, 1, 0, 3]);
            let mut target = vec![0_u8; connect_header[4] as usize];
            stream.read_exact(&mut target).await.unwrap();
            let mut port = [0_u8; 2];
            stream.read_exact(&mut port).await.unwrap();
            assert_eq!(target, b"server.example.com");
            assert_eq!(u16::from_be_bytes(port), 22);
            stream
                .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 22])
                .await
                .unwrap();
        });

        let mut stream = TcpStream::connect(address).await.unwrap();
        socks5_connect(
            &mut stream,
            "server.example.com",
            22,
            Some("proxy-user"),
            Some("proxy-pass"),
        )
        .await
        .unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn negotiates_authenticated_http_connect_tunnels() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut byte = [0_u8; 1];
            while !request.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).await.unwrap();
                request.push(byte[0]);
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with("CONNECT server.example.com:22 HTTP/1.1\r\n"));
            assert!(request.contains("Proxy-Authorization: Basic cHJveHktdXNlcjpwcm94eS1wYXNz\r\n"));
            stream
                .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                .await
                .unwrap();
        });

        let mut stream = TcpStream::connect(address).await.unwrap();
        http_connect(
            &mut stream,
            "server.example.com",
            22,
            Some("proxy-user"),
            Some("proxy-pass"),
        )
        .await
        .unwrap();
        server.await.unwrap();
    }

    #[test]
    fn expands_home_relative_private_key_paths() {
        let home = dirs::home_dir().expect("test user should have a home directory");
        assert_eq!(
            expand_private_key_path("~/.ssh/id_ed25519").unwrap(),
            home.join(".ssh/id_ed25519")
        );
    }

    #[test]
    fn rejects_named_user_tilde_paths() {
        assert!(expand_private_key_path("~other/.ssh/id_ed25519").is_err());
    }

    #[test]
    fn decodes_an_inline_private_key_bundle_from_the_credential_vault() {
        let private_key = "-----BEGIN PRIVATE KEY-----\n\
MC4CAQAwBQYDK2VwBCIEINTuctv5E1hK1bbY8fdp+K06/nwoy/HU++CXqI9EdVhC\n\
-----END PRIVATE KEY-----";
        let stored = StoredPrivateKeyCredential::new(
            "Test key".to_string(),
            private_key.to_string(),
            None,
            None,
        )
        .unwrap()
        .encode()
        .unwrap();

        let decoded = decode_inline_private_key(&stored).unwrap();
        assert_eq!(
            decoded.algorithm(),
            russh::keys::ssh_key::Algorithm::Ed25519
        );
    }

    #[test]
    fn auto_cloud_retries_direct_only_for_pre_identity_transport_failure() {
        let transport_failure =
            SessionFailure::Message("ssh_transport_connect_failed:connection reset".to_string());
        let kex_failure = SessionFailure::Message("ssh_kex_failed:no common algorithm".to_string());
        let lease = cloud_lease();

        assert!(should_retry_direct_after_transport_failure(
            &request(RoutePolicy::Auto),
            &lease,
            &transport_failure,
        ));
        assert!(!should_retry_direct_after_transport_failure(
            &request(RoutePolicy::Auto),
            &lease,
            &kex_failure,
        ));
        assert!(!should_retry_direct_after_transport_failure(
            &request(RoutePolicy::CloudOnly),
            &lease,
            &transport_failure,
        ));

        let mut direct_lease = lease;
        direct_lease.binding_id = None;
        direct_lease.route_label = "cloud_fallback".to_string();
        assert!(!should_retry_direct_after_transport_failure(
            &request(RoutePolicy::Auto),
            &direct_lease,
            &transport_failure,
        ));
    }
}

#[cfg(test)]
#[path = "session_lifecycle_tests.rs"]
mod lifecycle_tests;

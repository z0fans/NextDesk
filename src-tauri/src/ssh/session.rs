use super::host_keys::{self, HostKeyStatus};
use super::manager::SshControl;
use super::types::{SshAuthMethod, SshEvent, SshHostKeyPreview, SshStartRequest};
use crate::connection_resolver::{self, RouteLease, ServiceKind};
use crate::state::AppState;
use russh::client;
use russh::keys::{load_secret_key, ssh_key::PublicKey, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, Disconnect};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc;
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

struct NextDeskSshClient {
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
    control_rx: mpsc::Receiver<SshControl>,
    on_output: Channel<InvokeResponseBody>,
    on_event: Channel<SshEvent>,
    cancellation: CancellationToken,
) {
    let session_id = request.session_id.clone();
    let route_label = lease.route_label.clone();
    let result = run_session_inner(
        &app,
        &request,
        &lease,
        control_rx,
        &on_output,
        &on_event,
        &cancellation,
    )
    .await;
    let state = app.state::<AppState>();
    state.ssh_sessions.lock().unwrap().remove(&session_id);

    let mut emit_disconnected = true;
    let mut release_route = cancellation.is_cancelled();
    if let Err(failure) = result {
        match failure {
            SessionFailure::HostKey(preview) => {
                release_route = true;
                let _ = on_event.send(SshEvent::HostKey {
                    session_id: session_id.clone(),
                    preview,
                });
            }
            SessionFailure::Message(message) => {
                release_route = !reconnect_grace_allowed(&message);
                emit_disconnected = false;
                let _ = on_event.send(SshEvent::state(
                    &session_id,
                    "error",
                    Some(&route_label),
                    Some(message),
                ));
            }
            SessionFailure::Cancelled => {
                release_route = true;
            }
        }
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

async fn run_session_inner(
    app: &AppHandle,
    request: &SshStartRequest,
    lease: &RouteLease,
    mut control_rx: mpsc::Receiver<SshControl>,
    on_output: &Channel<InvokeResponseBody>,
    on_event: &Channel<SshEvent>,
    cancellation: &CancellationToken,
) -> Result<(), SessionFailure> {
    let _ = on_event.send(SshEvent::state(
        &request.session_id,
        "connecting_transport",
        Some(&lease.route_label),
        None,
    ));
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
    let connect = client::connect(
        config,
        (lease.dial_target.host.as_str(), lease.dial_target.port),
        handler,
    );
    let connect_result = tokio::select! {
        _ = cancellation.cancelled() => return Err(SessionFailure::Cancelled),
        result = tokio::time::timeout(SSH_CONNECT_TIMEOUT, connect) => result,
    };
    let mut ssh = match connect_result {
        Ok(Ok(session)) => session,
        Ok(Err(error)) => {
            if let Some(preview) = capture.rejected.lock().unwrap().clone() {
                return Err(SessionFailure::HostKey(preview));
            }
            if capture.server_key_seen.load(Ordering::Acquire) {
                return Err(SessionFailure::Message(format!("ssh_kex_failed:{error}")));
            }
            return Err(SessionFailure::Message(format!(
                "ssh_transport_connect_failed:{error}"
            )));
        }
        Err(_) => {
            return Err(SessionFailure::Message(
                "ssh_transport_connect_timeout".to_string(),
            ));
        }
    };

    let _ = on_event.send(SshEvent::state(
        &request.session_id,
        "authenticating",
        Some(&lease.route_label),
        None,
    ));
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
            let key_path =
                expand_private_key_path(request.private_key_path.as_deref().unwrap_or_default())?;
            let passphrase = secret;
            let key_loader = tauri::async_runtime::spawn_blocking(move || {
                load_secret_key(key_path, passphrase.as_deref())
            });
            let key = match tokio::select! {
                _ = cancellation.cancelled() => return Err(SessionFailure::Cancelled),
                result = key_loader => result,
            } {
                Ok(result) => result.map_err(|error| {
                    SessionFailure::Message(format!("ssh_private_key_load_failed:{error}"))
                })?,
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
    let (mut read_half, write_half) = channel.split();
    let _ = on_event.send(SshEvent::state(
        &request.session_id,
        "connected",
        Some(&lease.route_label),
        None,
    ));

    let mut route_tick = tokio::time::interval(ROUTE_KEEPALIVE_INTERVAL);
    route_tick.tick().await;
    loop {
        tokio::select! {
            _ = cancellation.cancelled() => break,
            message = read_half.wait() => {
                match message {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        on_output
                            .send(InvokeResponseBody::Raw(data.to_vec()))
                            .map_err(|error| SessionFailure::Message(format!("ssh_output_channel_failed:{error}")))?;
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        let _ = on_event.send(SshEvent::state(
                            &request.session_id,
                            "exited",
                            Some(&lease.route_label),
                            Some(exit_status.to_string()),
                        ));
                    }
                    Some(ChannelMsg::Eof | ChannelMsg::Close) | None => break,
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
                    Some(SshControl::Close) | None => break,
                }
            }
            _ = route_tick.tick() => {
                let state = app.state::<AppState>();
                if let Err(error) = connection_resolver::keep_route_alive(
                    state.inner(),
                    ServiceKind::Ssh,
                    Some(&request.session_id),
                    &lease.identity_target.host,
                    lease.identity_target.port,
                ).await {
                    log::warn!("[ssh] cloud route keepalive failed service=ssh error={error}");
                }
            }
        }
    }

    let _ = write_half.eof().await;
    let _ = write_half.close().await;
    let _ = ssh
        .disconnect(Disconnect::ByApplication, "session closed", "en")
        .await;
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::expand_private_key_path;

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
}

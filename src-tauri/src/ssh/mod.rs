mod host_keys;
pub(crate) mod manager;
mod monitor;
mod session;
mod sftp;
mod types;

use crate::connection_resolver::{self, ConnectionIntent, ServiceKind};
use crate::credential_vault;
use crate::state::AppState;
use manager::{SshControl, SshSessionHandle};
use russh::keys::{decode_secret_key, ssh_key::PublicKey};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, State};
use types::{
    validate_sftp_session_id, validate_ssh_session_id, SftpCreateDirectoryRequest, SftpListRequest,
    SftpListResponse, SftpOpenResponse, SftpReadTextRequest, SftpReadTextResponse,
    SftpRemoveRequest, SftpRenameRequest, SftpSetPermissionsRequest, SftpTransferDirection,
    SftpTransferEvent, SftpTransferRequest, SftpWriteTextRequest, SshEvent, SshHostKeyTrustRequest,
    SshKnownHostEntry, SshMonitorSnapshot, SshStartRequest, SshStartResponse,
    StoredPrivateKeyCredential,
};

#[tauri::command]
pub async fn ssh_session_start(
    app: AppHandle,
    request: SshStartRequest,
    on_output: Channel<InvokeResponseBody>,
    on_event: Channel<SshEvent>,
    app_state: State<'_, AppState>,
) -> Result<SshStartResponse, String> {
    request.validate().map_err(|error| {
        log::warn!(
            "[ssh] start rejected phase=validation code={}",
            sanitize_diagnostic_code(&error)
        );
        error
    })?;
    let session_id = request.session_id.clone();
    {
        let manager = app_state.ssh_sessions.lock().unwrap();
        if manager.contains(&session_id) {
            log::warn!("[ssh] start rejected phase=reservation code=ssh_session_already_exists");
            return Err("ssh_session_already_exists".to_string());
        }
    }

    let _ = on_event.send(SshEvent::state(&session_id, "resolving_route", None, None));
    let (control_tx, control_rx) = tokio::sync::mpsc::channel(128);
    let handle = SshSessionHandle::new(control_tx);
    let cancellation = handle.cancellation_token();
    app_state
        .ssh_sessions
        .lock()
        .unwrap()
        .insert(session_id.clone(), handle)
        .map_err(|error| {
            log::warn!(
                "[ssh] start rejected phase=reservation code={}",
                sanitize_diagnostic_code(&error)
            );
            error
        })?;
    let resolve = connection_resolver::resolve_connection(
        app_state.inner(),
        ConnectionIntent {
            service_kind: ServiceKind::Ssh,
            session_id: Some(session_id.clone()),
            host: request.host.clone(),
            port: request.port,
            reuse_cloud_binding: request.reuse_cloud_binding,
            route_policy: request.route_policy,
            preferred_region: request.preferred_region.clone(),
        },
    );
    let lease = tokio::select! {
        _ = cancellation.cancelled() => {
            log::warn!("[ssh] start rejected phase=route code=ssh_session_cancelled");
            app_state.ssh_sessions.lock().unwrap().remove(&session_id);
            connection_resolver::release_session_route(
                app_state.inner(),
                ServiceKind::Ssh,
                &session_id,
            );
            return Err("ssh_session_cancelled".to_string());
        }
        result = resolve => match result {
            Ok(lease) => lease,
            Err(error) => {
                log::warn!(
                    "[ssh] start rejected phase=route code={}",
                    sanitize_diagnostic_code(&error)
                );
                app_state.ssh_sessions.lock().unwrap().remove(&session_id);
                connection_resolver::release_session_route(
                    app_state.inner(),
                    ServiceKind::Ssh,
                    &session_id,
                );
                return Err(error);
            }
        }
    };
    let route_label = lease.route_label.clone();

    tauri::async_runtime::spawn(session::run_session(
        app,
        request,
        lease,
        control_rx,
        on_output,
        on_event,
        cancellation,
    ));

    Ok(SshStartResponse {
        session_id,
        route_label,
    })
}

#[tauri::command]
pub async fn ssh_session_input(
    session_id: String,
    data: Vec<u8>,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    if data.len() > 64 * 1024 {
        return Err("ssh_input_too_large".to_string());
    }
    let sender = app_state
        .ssh_sessions
        .lock()
        .unwrap()
        .control_sender(&session_id)?;
    sender
        .send(SshControl::Input(data))
        .await
        .map_err(|_| "ssh_session_closed".to_string())
}

#[tauri::command]
pub fn ssh_session_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    pixel_width: u16,
    pixel_height: u16,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    app_state.ssh_sessions.lock().unwrap().send(
        &session_id,
        SshControl::Resize {
            cols: cols.max(1),
            rows: rows.max(1),
            pixel_width,
            pixel_height,
        },
    )
}

#[tauri::command]
pub fn ssh_session_close(session_id: String, app_state: State<'_, AppState>) -> Result<(), String> {
    let active = app_state.ssh_sessions.lock().unwrap().close(&session_id);
    if active.is_err() {
        connection_resolver::release_session_route(
            app_state.inner(),
            ServiceKind::Ssh,
            &session_id,
        );
    }
    match active {
        Ok(()) => Ok(()),
        Err(error) if error == "ssh_session_not_found" => Ok(()),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub async fn ssh_monitor_snapshot(
    session_id: String,
    app_state: State<'_, AppState>,
) -> Result<SshMonitorSnapshot, String> {
    validate_ssh_session_id(&session_id)?;
    let sender = app_state
        .ssh_sessions
        .lock()
        .unwrap()
        .control_sender(&session_id)?;
    let (reply, result) = tokio::sync::oneshot::channel();
    sender
        .send(SshControl::Monitor { reply })
        .await
        .map_err(|_| "ssh_session_closed".to_string())?;
    result
        .await
        .map_err(|_| "ssh_monitor_session_closed".to_string())?
}

fn sanitize_diagnostic_code(value: &str) -> String {
    let candidate = value.split(':').next().unwrap_or_default().trim();
    let allowed_prefix = candidate.starts_with("ssh_")
        || candidate.starts_with("cloud_")
        || candidate.starts_with("credential_");
    let allowed_chars = candidate.chars().all(|character| {
        character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
    });
    if allowed_prefix && allowed_chars && candidate.len() <= 96 {
        candidate.to_string()
    } else {
        "ssh_start_failed".to_string()
    }
}

#[tauri::command]
pub fn ssh_log_start_failure(code: String) -> Result<(), String> {
    log::warn!(
        "[ssh] frontend start failed code={}",
        sanitize_diagnostic_code(&code)
    );
    Ok(())
}

#[tauri::command]
pub fn ssh_credential_store(reference: String, secret: String) -> Result<(), String> {
    credential_vault::store(&reference, &secret)
}

#[tauri::command]
pub async fn ssh_private_key_credential_store(
    reference: String,
    label: String,
    private_key: String,
    public_key: Option<String>,
    passphrase: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let stored =
            encode_validated_private_key_credential(label, private_key, public_key, passphrase)?;
        credential_vault::store(&reference, &stored)
    })
    .await
    .map_err(|_| "ssh_private_key_task_failed".to_string())?
}

fn encode_validated_private_key_credential(
    label: String,
    private_key: String,
    public_key: Option<String>,
    passphrase: Option<String>,
) -> Result<String, String> {
    let credential = StoredPrivateKeyCredential::new(label, private_key, public_key, passphrase)?;
    let private_key = decode_secret_key(credential.private_key(), credential.passphrase())
        .map_err(|error| format!("ssh_private_key_load_failed:{error}"))?;
    if let Some(public_key) = credential.public_key() {
        let public_key = PublicKey::from_openssh(public_key)
            .map_err(|_| "ssh_public_key_invalid".to_string())?;
        if public_key.key_data() != private_key.public_key().key_data() {
            return Err("ssh_public_key_mismatch".to_string());
        }
    }
    credential.encode()
}

#[tauri::command]
pub fn ssh_credential_delete(reference: String) -> Result<(), String> {
    credential_vault::delete(&reference)
}

#[tauri::command]
pub fn ssh_credential_exists(reference: String) -> Result<bool, String> {
    credential_vault::exists(&reference)
}

#[tauri::command]
pub fn ssh_trust_host_key(request: SshHostKeyTrustRequest) -> Result<(), String> {
    request.validate()?;
    let public_key = PublicKey::from_openssh(&request.public_key)
        .map_err(|error| format!("ssh_host_key_invalid:{error}"))?;
    host_keys::trust_host_key(
        &request.host,
        request.port,
        &public_key,
        &host_keys::known_hosts_path(),
    )
}

#[tauri::command]
pub fn ssh_known_hosts_list() -> Result<Vec<SshKnownHostEntry>, String> {
    host_keys::list_known_hosts(&host_keys::known_hosts_path())
}

#[tauri::command]
pub fn ssh_known_host_remove(host: String) -> Result<(), String> {
    host_keys::remove_known_host(&host, &host_keys::known_hosts_path())
}

#[tauri::command]
pub fn ssh_known_hosts_import(contents: String) -> Result<usize, String> {
    host_keys::import_known_hosts(&contents, &host_keys::known_hosts_path())
}

#[tauri::command]
pub fn ssh_known_hosts_export() -> Result<String, String> {
    host_keys::export_known_hosts(&host_keys::known_hosts_path())
}

#[tauri::command]
pub async fn ssh_sftp_open(
    session_id: String,
    app_state: State<'_, AppState>,
) -> Result<SftpOpenResponse, String> {
    validate_sftp_session_id(&session_id)?;
    let sender = app_state
        .ssh_sessions
        .lock()
        .unwrap()
        .control_sender(&session_id)?;
    let (reply, result) = tokio::sync::oneshot::channel();
    sender
        .send(SshControl::Sftp(sftp::SftpControl::Open { reply }))
        .await
        .map_err(|_| "ssh_session_closed".to_string())?;
    result
        .await
        .map_err(|_| "sftp_session_closed".to_string())?
}

#[tauri::command]
pub async fn ssh_sftp_list(
    session_id: String,
    path: String,
    app_state: State<'_, AppState>,
) -> Result<SftpListResponse, String> {
    let request = SftpListRequest { session_id, path };
    request.validate()?;
    let sender = app_state
        .ssh_sessions
        .lock()
        .unwrap()
        .control_sender(&request.session_id)?;
    let (reply, result) = tokio::sync::oneshot::channel();
    sender
        .send(SshControl::Sftp(sftp::SftpControl::List { request, reply }))
        .await
        .map_err(|_| "ssh_session_closed".to_string())?;
    result
        .await
        .map_err(|_| "sftp_session_closed".to_string())?
}

async fn send_sftp_transfer(
    request: SftpTransferRequest,
    on_progress: Channel<SftpTransferEvent>,
    direction: SftpTransferDirection,
    app_state: &AppState,
) -> Result<(), String> {
    request.validate()?;
    let sender = app_state
        .ssh_sessions
        .lock()
        .unwrap()
        .control_sender(&request.session_id)?;
    let (reply, result) = tokio::sync::oneshot::channel();
    let control = match direction {
        SftpTransferDirection::Upload => sftp::SftpControl::Upload {
            request,
            on_progress,
            reply,
        },
        SftpTransferDirection::Download => sftp::SftpControl::Download {
            request,
            on_progress,
            reply,
        },
    };
    sender
        .send(SshControl::Sftp(control))
        .await
        .map_err(|_| "ssh_session_closed".to_string())?;
    result
        .await
        .map_err(|_| "sftp_session_closed".to_string())?
}

#[tauri::command]
pub async fn ssh_sftp_upload(
    request: SftpTransferRequest,
    on_progress: Channel<SftpTransferEvent>,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    send_sftp_transfer(
        request,
        on_progress,
        SftpTransferDirection::Upload,
        app_state.inner(),
    )
    .await
}

#[tauri::command]
pub async fn ssh_sftp_download(
    request: SftpTransferRequest,
    on_progress: Channel<SftpTransferEvent>,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    send_sftp_transfer(
        request,
        on_progress,
        SftpTransferDirection::Download,
        app_state.inner(),
    )
    .await
}

#[tauri::command]
pub async fn ssh_sftp_cancel(
    session_id: String,
    transfer_id: String,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    validate_sftp_session_id(&session_id)?;
    if transfer_id.is_empty()
        || transfer_id.len() > 128
        || !transfer_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err("sftp_transfer_id_invalid".to_string());
    }
    let sender = app_state
        .ssh_sessions
        .lock()
        .unwrap()
        .control_sender(&session_id)?;
    let (reply, result) = tokio::sync::oneshot::channel();
    sender
        .send(SshControl::Sftp(sftp::SftpControl::Cancel {
            transfer_id,
            reply,
        }))
        .await
        .map_err(|_| "ssh_session_closed".to_string())?;
    result
        .await
        .map_err(|_| "sftp_session_closed".to_string())?
}

#[tauri::command]
pub async fn ssh_sftp_create_directory(
    request: SftpCreateDirectoryRequest,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    request.validate()?;
    let sender = app_state
        .ssh_sessions
        .lock()
        .unwrap()
        .control_sender(&request.session_id)?;
    let (reply, result) = tokio::sync::oneshot::channel();
    sender
        .send(SshControl::Sftp(sftp::SftpControl::CreateDirectory {
            request,
            reply,
        }))
        .await
        .map_err(|_| "ssh_session_closed".to_string())?;
    result
        .await
        .map_err(|_| "sftp_session_closed".to_string())?
}

#[tauri::command]
pub async fn ssh_sftp_rename(
    request: SftpRenameRequest,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    request.validate()?;
    let sender = app_state
        .ssh_sessions
        .lock()
        .unwrap()
        .control_sender(&request.session_id)?;
    let (reply, result) = tokio::sync::oneshot::channel();
    sender
        .send(SshControl::Sftp(sftp::SftpControl::Rename {
            request,
            reply,
        }))
        .await
        .map_err(|_| "ssh_session_closed".to_string())?;
    result
        .await
        .map_err(|_| "sftp_session_closed".to_string())?
}

#[tauri::command]
pub async fn ssh_sftp_remove(
    request: SftpRemoveRequest,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    request.validate()?;
    let sender = app_state
        .ssh_sessions
        .lock()
        .unwrap()
        .control_sender(&request.session_id)?;
    let (reply, result) = tokio::sync::oneshot::channel();
    sender
        .send(SshControl::Sftp(sftp::SftpControl::Remove {
            request,
            reply,
        }))
        .await
        .map_err(|_| "ssh_session_closed".to_string())?;
    result
        .await
        .map_err(|_| "sftp_session_closed".to_string())?
}

#[tauri::command]
pub async fn ssh_sftp_read_text(
    request: SftpReadTextRequest,
    app_state: State<'_, AppState>,
) -> Result<SftpReadTextResponse, String> {
    request.validate()?;
    let sender = app_state
        .ssh_sessions
        .lock()
        .unwrap()
        .control_sender(&request.session_id)?;
    let (reply, result) = tokio::sync::oneshot::channel();
    sender
        .send(SshControl::Sftp(sftp::SftpControl::ReadText {
            request,
            reply,
        }))
        .await
        .map_err(|_| "ssh_session_closed".to_string())?;
    result
        .await
        .map_err(|_| "sftp_session_closed".to_string())?
}

#[tauri::command]
pub async fn ssh_sftp_write_text(
    request: SftpWriteTextRequest,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    request.validate()?;
    let sender = app_state
        .ssh_sessions
        .lock()
        .unwrap()
        .control_sender(&request.session_id)?;
    let (reply, result) = tokio::sync::oneshot::channel();
    sender
        .send(SshControl::Sftp(sftp::SftpControl::WriteText {
            request,
            reply,
        }))
        .await
        .map_err(|_| "ssh_session_closed".to_string())?;
    result
        .await
        .map_err(|_| "sftp_session_closed".to_string())?
}

#[tauri::command]
pub async fn ssh_sftp_set_permissions(
    request: SftpSetPermissionsRequest,
    app_state: State<'_, AppState>,
) -> Result<(), String> {
    request.validate()?;
    let sender = app_state
        .ssh_sessions
        .lock()
        .unwrap()
        .control_sender(&request.session_id)?;
    let (reply, result) = tokio::sync::oneshot::channel();
    sender
        .send(SshControl::Sftp(sftp::SftpControl::SetPermissions {
            request,
            reply,
        }))
        .await
        .map_err(|_| "ssh_session_closed".to_string())?;
    result
        .await
        .map_err(|_| "sftp_session_closed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::{encode_validated_private_key_credential, sanitize_diagnostic_code};
    use russh::keys::decode_secret_key;

    const TEST_PRIVATE_KEY: &str = "-----BEGIN PRIVATE KEY-----\n\
MC4CAQAwBQYDK2VwBCIEINTuctv5E1hK1bbY8fdp+K06/nwoy/HU++CXqI9EdVhC\n\
-----END PRIVATE KEY-----";

    #[test]
    fn private_key_credential_validates_the_optional_public_key() {
        let decoded = decode_secret_key(TEST_PRIVATE_KEY, None).unwrap();
        let public_key = decoded.public_key().to_openssh().unwrap();

        assert!(encode_validated_private_key_credential(
            "Deployment key".to_string(),
            TEST_PRIVATE_KEY.to_string(),
            Some(public_key),
            None,
        )
        .is_ok());
        assert_eq!(
            encode_validated_private_key_credential(
                "Deployment key".to_string(),
                TEST_PRIVATE_KEY.to_string(),
                Some("not-an-ssh-public-key".to_string()),
                None,
            ),
            Err("ssh_public_key_invalid".to_string()),
        );
    }

    #[test]
    fn diagnostic_code_keeps_only_a_bounded_ssh_error_identifier() {
        assert_eq!(
            sanitize_diagnostic_code("ssh_session_already_exists"),
            "ssh_session_already_exists"
        );
        assert_eq!(
            sanitize_diagnostic_code("ssh_transport_failed:password=secret"),
            "ssh_transport_failed"
        );
        assert_eq!(
            sanitize_diagnostic_code("Error: unexpected IPC failure"),
            "ssh_start_failed"
        );
    }
}

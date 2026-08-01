mod host_keys;
pub(crate) mod manager;
mod session;
mod types;

use crate::connection_resolver::{self, ConnectionIntent, ServiceKind};
use crate::credential_vault;
use crate::state::AppState;
use manager::{SshControl, SshSessionHandle};
use russh::keys::ssh_key::PublicKey;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, State};
use types::{SshEvent, SshHostKeyTrustRequest, SshStartRequest, SshStartResponse};

#[tauri::command]
pub async fn ssh_session_start(
    app: AppHandle,
    request: SshStartRequest,
    on_output: Channel<InvokeResponseBody>,
    on_event: Channel<SshEvent>,
    app_state: State<'_, AppState>,
) -> Result<SshStartResponse, String> {
    request.validate()?;
    let session_id = request.session_id.clone();
    {
        let manager = app_state.ssh_sessions.lock().unwrap();
        if manager.contains(&session_id) {
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
        .insert(session_id.clone(), handle)?;
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
pub fn ssh_credential_store(reference: String, secret: String) -> Result<(), String> {
    credential_vault::store(&reference, &secret)
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

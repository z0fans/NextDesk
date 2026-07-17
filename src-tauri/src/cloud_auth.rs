use crate::cloud_gateway::{self, CloudAccountStatus, CloudAuthorizationStart};
use crate::config;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::fs;
#[cfg(target_os = "macos")]
use std::process::Command;
use url::Url;

const DEFAULT_REDIRECT_URI: &str = "nextdesk://auth/callback";
const SERVICE_NAME: &str = "NextDesk Connect Gateway";

#[derive(Debug, Serialize, Deserialize)]
struct PendingAuth {
    panel_url: String,
    state: String,
    verifier: String,
    #[serde(default = "default_redirect_uri")]
    redirect_uri: String,
}

fn default_redirect_uri() -> String {
    DEFAULT_REDIRECT_URI.to_string()
}

fn random_hex(bytes: usize) -> String {
    let mut out = vec![0u8; bytes];
    OsRng.fill_bytes(&mut out);
    out.iter().map(|b| format!("{b:02x}")).collect()
}

fn ensure_installation_id(saved: &mut config::SavedConfig) -> String {
    if saved.cloud_installation_id.trim().is_empty() {
        saved.cloud_installation_id = format!("inst_{}", random_hex(24));
    }
    saved.cloud_installation_id.clone()
}

fn pending_path() -> std::path::PathBuf {
    config::get_user_config_dir().join("cloud_auth_pending.json")
}

fn credential_path(device_id: &str) -> std::path::PathBuf {
    config::get_user_config_dir().join(format!("cloud_device_{device_id}.token"))
}

fn pkce_challenge(verifier: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

fn build_authorize_url(
    panel_url: &str,
    state: &str,
    challenge: &str,
    redirect_uri: &str,
) -> Result<String, String> {
    let mut url = Url::parse(panel_url.trim_end_matches('/'))
        .map_err(|e| format!("invalid panel url: {e}"))?;
    url.set_path("/connect/authorize");
    url.query_pairs_mut()
        .append_pair("client_id", "desktop")
        .append_pair("state", state)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("device_name", "NextDesk");
    Ok(url.to_string())
}

pub fn start_authorization(
    panel_url: String,
    redirect_uri: String,
) -> Result<CloudAuthorizationStart, String> {
    let state = random_hex(24);
    let verifier = random_hex(32);
    let challenge = pkce_challenge(&verifier);
    let authorize_url = build_authorize_url(&panel_url, &state, &challenge, &redirect_uri)?;

    fs::write(
        pending_path(),
        serde_json::to_vec_pretty(&PendingAuth {
            panel_url,
            state: state.clone(),
            verifier,
            redirect_uri,
        })
        .map_err(|e| format!("serialize pending auth failed: {e}"))?,
    )
    .map_err(|e| format!("write pending auth failed: {e}"))?;

    Ok(CloudAuthorizationStart {
        authorize_url,
        state,
    })
}

pub async fn handle_callback(callback_url: String) -> Result<CloudAccountStatus, String> {
    let pending: PendingAuth = serde_json::from_slice(
        &fs::read(pending_path()).map_err(|e| format!("read pending auth failed: {e}"))?,
    )
    .map_err(|e| format!("parse pending auth failed: {e}"))?;
    let url = Url::parse(&callback_url).map_err(|e| format!("invalid callback url: {e}"))?;
    let code = url
        .query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.to_string())
        .ok_or("callback missing code")?;
    let state = url
        .query_pairs()
        .find(|(k, _)| k == "state")
        .map(|(_, v)| v.to_string())
        .ok_or("callback missing state")?;
    if state != pending.state {
        return Err("callback state mismatch".to_string());
    }

    let mut saved = config::load_saved_config();
    let installation_id = ensure_installation_id(&mut saved);
    config::save_config(&saved);

    let token = cloud_gateway::exchange_code(
        &pending.panel_url,
        &code,
        &pending.verifier,
        &pending.redirect_uri,
        "NextDesk",
        std::env::consts::OS,
        env!("CARGO_PKG_VERSION"),
        &installation_id,
    )
    .await?;

    store_device_token(&token.device_id, &token.device_token)?;
    saved.dashboard_url = pending.panel_url;
    saved.cloud_authorization_base_url = saved.dashboard_url.clone();
    saved.cloud_device_id = token.device_id;
    saved.cloud_device_expires_at = token.device_expires_at.clone().unwrap_or_default();
    saved.cloud_account_display = token.account.display.clone().unwrap_or_default();
    saved.cloud_account_available = token.account.available;
    saved.cloud_account_available_until = token.account.available_until.clone().unwrap_or_default();
    saved.cloud_account_reason = token.account.reason.clone().unwrap_or_default();
    config::save_config(&saved);
    let _ = fs::remove_file(pending_path());

    Ok(CloudAccountStatus {
        enabled: true,
        authorized: true,
        account_available: token.account.available,
        account_available_until: token.account.available_until,
        device_expires_at: token.device_expires_at,
        display: token.account.display,
        reason: token.account.reason,
    })
}

#[cfg(test)]
mod tests {
    use super::{build_authorize_url, ensure_installation_id};
    use crate::config::SavedConfig;
    use url::Url;

    #[test]
    fn authorize_url_uses_supplied_loopback_redirect_uri() {
        let url = build_authorize_url(
            "https://oauth.mxolab.com",
            "state-1",
            "challenge-1",
            "http://127.0.0.1:43123/cloud/auth/callback",
        )
        .unwrap();
        let parsed = Url::parse(&url).unwrap();

        assert_eq!(
            parsed.as_str().split('?').next().unwrap(),
            "https://oauth.mxolab.com/connect/authorize"
        );
        assert!(parsed
            .query_pairs()
            .any(|(key, value)| key == "redirect_uri"
                && value == "http://127.0.0.1:43123/cloud/auth/callback"));
    }

    #[test]
    fn installation_id_is_created_once_and_survives_reauthorization() {
        let mut saved = SavedConfig::default();
        let first = ensure_installation_id(&mut saved);
        let second = ensure_installation_id(&mut saved);

        assert!(first.starts_with("inst_"));
        assert_eq!(first, second);
        assert_eq!(saved.cloud_installation_id, first);
    }
}

pub async fn status() -> Result<CloudAccountStatus, String> {
    let saved = config::load_saved_config();
    if saved.dashboard_url.is_empty() || saved.cloud_device_id.is_empty() {
        return Ok(CloudAccountStatus::default());
    }
    let token = load_device_token(&saved.cloud_device_id)?;
    match cloud_gateway::me(&saved.dashboard_url, &saved.cloud_device_id, &token).await {
        Ok(status) => {
            persist_account_status(&status);
            Ok(status)
        }
        Err(error) if is_cloud_auth_rejected(&error) => {
            invalidate_authorization();
            Ok(CloudAccountStatus {
                enabled: true,
                authorized: false,
                account_available: false,
                account_available_until: None,
                device_expires_at: None,
                display: (!saved.cloud_account_display.is_empty())
                    .then_some(saved.cloud_account_display.clone()),
                reason: Some("cloud_authorization_expired".to_string()),
            })
        }
        Err(error) => Err(error),
    }
}

fn persist_account_status(status: &CloudAccountStatus) {
    let mut saved = config::load_saved_config();
    saved.cloud_account_available = status.account_available;
    saved.cloud_account_available_until =
        status.account_available_until.clone().unwrap_or_default();
    saved.cloud_device_expires_at = status.device_expires_at.clone().unwrap_or_default();
    saved.cloud_account_display = status.display.clone().unwrap_or_default();
    saved.cloud_account_reason = status.reason.clone().unwrap_or_default();
    config::save_config(&saved);
}

pub fn invalidate_authorization() {
    let mut saved = config::load_saved_config();
    if !saved.cloud_device_id.is_empty() {
        let _ = delete_device_token(&saved.cloud_device_id);
    }
    saved.cloud_device_id.clear();
    saved.cloud_device_expires_at.clear();
    saved.cloud_account_available = false;
    saved.cloud_account_reason = "cloud_authorization_expired".to_string();
    config::save_config(&saved);
}

fn is_cloud_auth_rejected(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("401")
        || error.contains("403")
        || error.contains("unauthorized")
        || error.contains("forbidden")
}

pub async fn disable() -> Result<bool, String> {
    let mut saved = config::load_saved_config();
    if !saved.cloud_device_id.is_empty() {
        if !saved.dashboard_url.is_empty() {
            match load_device_token(&saved.cloud_device_id) {
                Ok(token) => {
                    if let Err(error) =
                        cloud_gateway::revoke(&saved.dashboard_url, &saved.cloud_device_id, &token)
                            .await
                    {
                        log::warn!("[cloud-auth] server device revoke failed: {error}");
                    } else {
                        log::info!("[cloud-auth] server device authorization revoked");
                    }
                }
                Err(error) => {
                    log::warn!("[cloud-auth] device token unavailable during sign out: {error}");
                }
            }
        }
        let _ = delete_device_token(&saved.cloud_device_id);
    }
    saved.dashboard_url.clear();
    saved.cloud_authorization_base_url.clear();
    saved.cloud_device_id.clear();
    saved.cloud_device_expires_at.clear();
    saved.cloud_account_display.clear();
    saved.cloud_account_available = false;
    saved.cloud_account_available_until.clear();
    saved.cloud_account_reason.clear();
    config::save_config(&saved);
    Ok(true)
}

pub fn load_device_token(device_id: &str) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("/usr/bin/security")
            .args([
                "find-generic-password",
                "-s",
                SERVICE_NAME,
                "-a",
                device_id,
                "-w",
            ])
            .output()
            .map_err(|e| format!("keychain read failed: {e}"))?;
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
        }
    }
    fs::read_to_string(credential_path(device_id))
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("device token not found: {e}"))
}

fn store_device_token(device_id: &str, token: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("/usr/bin/security")
            .args([
                "delete-generic-password",
                "-s",
                SERVICE_NAME,
                "-a",
                device_id,
            ])
            .output();
        let status = Command::new("/usr/bin/security")
            .args([
                "add-generic-password",
                "-s",
                SERVICE_NAME,
                "-a",
                device_id,
                "-w",
                token,
            ])
            .status()
            .map_err(|e| format!("keychain write failed: {e}"))?;
        if status.success() {
            return Ok(());
        }
    }
    fs::write(credential_path(device_id), token)
        .map_err(|e| format!("fallback token write failed: {e}"))
}

fn delete_device_token(device_id: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("/usr/bin/security")
            .args([
                "delete-generic-password",
                "-s",
                SERVICE_NAME,
                "-a",
                device_id,
            ])
            .output();
    }
    let _ = fs::remove_file(credential_path(device_id));
    Ok(())
}

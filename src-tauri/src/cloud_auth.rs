use crate::cloud_gateway::{self, CloudAccountStatus, CloudAuthorizationStart};
use crate::{cloud_credentials, config};
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::fs;
use std::sync::Mutex;
use url::Url;

const DEFAULT_REDIRECT_URI: &str = "nextdesk://auth/callback";
// Keep credential side effects ordered with the corresponding config commit.
static AUTH_COMMIT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct DeviceIdentity {
    dashboard_url: String,
    authorization_base_url: String,
    device_id: String,
    installation_id: String,
    authorization_revision: u64,
}

impl From<&config::SavedConfig> for DeviceIdentity {
    fn from(saved: &config::SavedConfig) -> Self {
        Self {
            dashboard_url: saved.dashboard_url.clone(),
            authorization_base_url: saved.cloud_authorization_base_url.clone(),
            device_id: saved.cloud_device_id.clone(),
            installation_id: saved.cloud_installation_id.clone(),
            authorization_revision: saved.cloud_authorization_revision,
        }
    }
}

impl DeviceIdentity {
    fn ensure_current(&self, saved: &config::SavedConfig) -> Result<(), String> {
        if self == &Self::from(saved) {
            Ok(())
        } else {
            Err("cloud_authorization_changed".to_string())
        }
    }
}

fn advance_authorization_revision(saved: &mut config::SavedConfig) -> Result<(), String> {
    saved.cloud_authorization_revision = saved
        .cloud_authorization_revision
        .checked_add(1)
        .ok_or_else(|| "cloud_authorization_revision_exhausted".to_string())?;
    Ok(())
}

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

    let (installation_id, identity) = config::update_saved_config(|saved| {
        let installation_id = ensure_installation_id(saved);
        Ok((installation_id, DeviceIdentity::from(&*saved)))
    })?;

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

    let _guard = AUTH_COMMIT_LOCK
        .lock()
        .map_err(|_| "cloud_auth_lock_poisoned")?;
    let (old_reference, old_device_id) =
        cloud_credentials::store_and_commit(&token.device_token, |reference| {
            config::update_saved_config(|saved| {
                identity.ensure_current(saved)?;
                advance_authorization_revision(saved)?;
                let retired = (
                    saved.cloud_credential_reference.clone(),
                    saved.cloud_device_id.clone(),
                );
                saved.cloud_credential_reference = reference.to_string();
                saved.dashboard_url = pending.panel_url;
                saved.cloud_authorization_base_url = saved.dashboard_url.clone();
                saved.cloud_device_id = token.device_id;
                saved.cloud_device_expires_at = token.device_expires_at.clone().unwrap_or_default();
                saved.cloud_account_display = token.account.display.clone().unwrap_or_default();
                saved.cloud_account_available = token.account.available;
                saved.cloud_account_available_until =
                    token.account.available_until.clone().unwrap_or_default();
                saved.cloud_account_reason = token.account.reason.clone().unwrap_or_default();
                Ok(retired)
            })
        })?;
    cloud_credentials::retire(&old_reference, &old_device_id);
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
    use super::{
        advance_authorization_revision, apply_account_status, build_authorize_url,
        ensure_installation_id, mark_authorization_expired, DeviceIdentity,
    };
    use crate::cloud_gateway::CloudAccountStatus;
    use crate::config::{tests::TestConfig, update_saved_config_at, SavedConfig};
    use url::Url;

    #[test]
    fn same_device_reauthorization_rejects_late_status_and_expiry() {
        let fixture = TestConfig::new();
        let previous = update_saved_config_at(&fixture.path, |saved| {
            saved.dashboard_url = "https://auth.example".into();
            saved.cloud_device_id = "reused-device".into();
            saved.cloud_installation_id = "same-installation".into();
            Ok(DeviceIdentity::from(&*saved))
        })
        .unwrap();
        let current = update_saved_config_at(&fixture.path, |saved| {
            advance_authorization_revision(saved)?;
            saved.cloud_account_display = "Reauthorized account".into();
            Ok(DeviceIdentity::from(&*saved))
        })
        .unwrap();
        assert_eq!(previous.device_id, current.device_id);
        assert_eq!(previous.authorization_revision, 0);
        assert_eq!(current.authorization_revision, 1);
        let committed = std::fs::read(&fixture.path).unwrap();
        let result = update_saved_config_at(&fixture.path, |saved| {
            apply_account_status(saved, &previous, &CloudAccountStatus::default())
        });
        assert_eq!(result.unwrap_err(), "cloud_authorization_changed");
        let result = update_saved_config_at(&fixture.path, |saved| {
            mark_authorization_expired(saved, &previous)
        });
        assert_eq!(result.unwrap_err(), "cloud_authorization_changed");
        assert_eq!(std::fs::read(&fixture.path).unwrap(), committed);
        update_saved_config_at(&fixture.path, |saved| {
            mark_authorization_expired(saved, &current)
        })
        .unwrap();
        let saved: SavedConfig =
            serde_json::from_slice(&std::fs::read(&fixture.path).unwrap()).unwrap();
        assert_eq!(saved.cloud_authorization_revision, 2);
        assert!(saved.cloud_device_id.is_empty());
    }

    #[tokio::test]
    async fn late_status_and_expiry_cannot_overwrite_new_identity() {
        let fixture = TestConfig::new();
        let identity = update_saved_config_at(&fixture.path, |saved| {
            saved.cloud_device_id = "old-device".into();
            saved.dashboard_url = "https://old.example".into();
            Ok(DeviceIdentity::from(&*saved))
        })
        .unwrap();
        let old_identity = identity.clone();
        let path = fixture.path.clone();
        let (respond, response) = tokio::sync::oneshot::channel();
        let delayed = tokio::spawn(async move {
            let status = response.await.unwrap();
            update_saved_config_at(&path, |saved| {
                apply_account_status(saved, &old_identity, &status)
            })
        });
        update_saved_config_at(&fixture.path, |saved| {
            saved.cloud_device_id = "new-device".into();
            saved.cloud_account_display = "New account".into();
            Ok(())
        })
        .unwrap();
        let original = std::fs::read(&fixture.path).unwrap();
        respond
            .send(CloudAccountStatus {
                display: Some("Old account".into()),
                ..CloudAccountStatus::default()
            })
            .unwrap();
        assert_eq!(
            delayed.await.unwrap().unwrap_err(),
            "cloud_authorization_changed"
        );
        let expired = update_saved_config_at(&fixture.path, |saved| {
            mark_authorization_expired(saved, &identity)
        });
        assert_eq!(expired.unwrap_err(), "cloud_authorization_changed");
        assert_eq!(std::fs::read(&fixture.path).unwrap(), original);
    }

    #[test]
    fn account_updates_preserve_preferences_changed_while_request_was_in_flight() {
        let fixture = TestConfig::new();
        let identity = update_saved_config_at(&fixture.path, |saved| {
            saved.cloud_device_id = "device".into();
            Ok(DeviceIdentity::from(&*saved))
        })
        .unwrap();
        update_saved_config_at(&fixture.path, |saved| {
            saved.anonymous_quality_feedback_enabled = Some(false);
            saved.rdp_resolution_mode = Some("1280x720".into());
            Ok(())
        })
        .unwrap();
        update_saved_config_at(&fixture.path, |saved| {
            apply_account_status(
                saved,
                &identity,
                &CloudAccountStatus {
                    account_available: true,
                    display: Some("Account".into()),
                    ..CloudAccountStatus::default()
                },
            )
        })
        .unwrap();
        let saved: SavedConfig =
            serde_json::from_slice(&std::fs::read(&fixture.path).unwrap()).unwrap();
        assert_eq!(saved.anonymous_quality_feedback_enabled, Some(false));
        assert_eq!(saved.rdp_resolution_mode.as_deref(), Some("1280x720"));
        assert_eq!(saved.cloud_account_display, "Account");
    }

    #[test]
    fn identity_check_includes_authority_and_installation() {
        let mut saved = SavedConfig {
            cloud_device_id: "device".into(),
            dashboard_url: "https://first.example".into(),
            cloud_installation_id: "installation".into(),
            ..SavedConfig::default()
        };
        let expected = DeviceIdentity::from(&saved);
        saved.dashboard_url = "https://second.example".into();
        assert!(expected.ensure_current(&saved).is_err());
        saved.dashboard_url = "https://first.example".into();
        saved.cloud_installation_id = "replacement".into();
        assert!(expected.ensure_current(&saved).is_err());
    }

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
    let identity = DeviceIdentity::from(&saved);
    let token = load_device_token(&saved)?;
    match cloud_gateway::me(&saved.dashboard_url, &saved.cloud_device_id, &token).await {
        Ok(status) => {
            config::update_saved_config(|saved| apply_account_status(saved, &identity, &status))?;
            Ok(status)
        }
        Err(error) if error == cloud_gateway::AUTHORIZATION_EXPIRED => {
            invalidate_authorization(&identity)?;
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

fn apply_account_status(
    saved: &mut config::SavedConfig,
    identity: &DeviceIdentity,
    status: &CloudAccountStatus,
) -> Result<(), String> {
    identity.ensure_current(saved)?;
    saved.cloud_account_available = status.account_available;
    saved.cloud_account_available_until =
        status.account_available_until.clone().unwrap_or_default();
    saved.cloud_device_expires_at = status.device_expires_at.clone().unwrap_or_default();
    saved.cloud_account_display = status.display.clone().unwrap_or_default();
    saved.cloud_account_reason = status.reason.clone().unwrap_or_default();
    Ok(())
}

fn mark_authorization_expired(
    saved: &mut config::SavedConfig,
    identity: &DeviceIdentity,
) -> Result<(), String> {
    identity.ensure_current(saved)?;
    advance_authorization_revision(saved)?;
    saved.cloud_device_id.clear();
    saved.cloud_credential_reference.clear();
    saved.cloud_device_expires_at.clear();
    saved.cloud_account_available = false;
    saved.cloud_account_reason = "cloud_authorization_expired".to_string();
    Ok(())
}

pub fn invalidate_authorization(identity: &DeviceIdentity) -> Result<(), String> {
    let _guard = AUTH_COMMIT_LOCK
        .lock()
        .map_err(|_| "cloud_auth_lock_poisoned")?;
    let reference = config::update_saved_config(|saved| {
        let reference = saved.cloud_credential_reference.clone();
        mark_authorization_expired(saved, identity)?;
        Ok(reference)
    })?;
    cloud_credentials::retire(&reference, &identity.device_id);
    Ok(())
}

pub async fn disable() -> Result<bool, String> {
    let saved = config::load_saved_config();
    let identity = DeviceIdentity::from(&saved);
    if !saved.cloud_device_id.is_empty() {
        if !saved.dashboard_url.is_empty() {
            match load_device_token(&saved) {
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
    }
    let _guard = AUTH_COMMIT_LOCK
        .lock()
        .map_err(|_| "cloud_auth_lock_poisoned")?;
    let reference = config::update_saved_config(|saved| {
        identity.ensure_current(saved)?;
        advance_authorization_revision(saved)?;
        let reference = std::mem::take(&mut saved.cloud_credential_reference);
        saved.dashboard_url.clear();
        saved.cloud_authorization_base_url.clear();
        saved.cloud_device_id.clear();
        saved.cloud_device_expires_at.clear();
        saved.cloud_account_display.clear();
        saved.cloud_account_available = false;
        saved.cloud_account_available_until.clear();
        saved.cloud_account_reason.clear();
        Ok(reference)
    })?;
    cloud_credentials::retire(&reference, &identity.device_id);
    Ok(true)
}

pub fn load_device_token(snapshot: &config::SavedConfig) -> Result<String, String> {
    let _guard = AUTH_COMMIT_LOCK
        .lock()
        .map_err(|_| "cloud_auth_lock_poisoned")?;
    let identity = DeviceIdentity::from(snapshot);
    let current = config::load_saved_config();
    identity.ensure_current(&current)?;
    cloud_credentials::load(
        &current.cloud_device_id,
        &current.cloud_credential_reference,
        |reference| {
            config::update_saved_config(|saved| {
                identity.ensure_current(saved)?;
                saved.cloud_credential_reference = reference.to_string();
                Ok(())
            })
        },
    )
}

use crate::connection_resolver::RoutePolicy;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SshAuthMethod {
    Password,
    PrivateKey,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshStartRequest {
    pub session_id: String,
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub username: String,
    pub auth_method: SshAuthMethod,
    #[serde(default)]
    pub credential_reference: Option<String>,
    #[serde(default)]
    pub private_key_path: Option<String>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    #[serde(default)]
    pub pixel_width: u16,
    #[serde(default)]
    pub pixel_height: u16,
    #[serde(default)]
    pub route_policy: RoutePolicy,
    #[serde(default)]
    pub preferred_region: Option<String>,
    #[serde(default)]
    pub reuse_cloud_binding: bool,
}

impl SshStartRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.session_id.trim().is_empty() || self.session_id.len() > 128 {
            return Err("ssh_session_id_invalid".to_string());
        }
        if self.host.trim().is_empty()
            || self.host.len() > 255
            || self.host.chars().any(char::is_whitespace)
        {
            return Err("ssh_host_invalid".to_string());
        }
        if self.port == 0 {
            return Err("ssh_port_invalid".to_string());
        }
        if self.username.trim().is_empty() || self.username.len() > 128 {
            return Err("ssh_username_required".to_string());
        }
        if self
            .credential_reference
            .as_deref()
            .is_some_and(|reference| reference.trim().is_empty() || reference.len() > 128)
        {
            return Err("credential_reference_invalid".to_string());
        }
        if self
            .private_key_path
            .as_deref()
            .is_some_and(|path| path.len() > 4096)
        {
            return Err("ssh_private_key_path_invalid".to_string());
        }
        if self.auth_method == SshAuthMethod::PrivateKey
            && self
                .private_key_path
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .is_none()
        {
            return Err("ssh_private_key_required".to_string());
        }
        if self
            .credential_reference
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
            && self.auth_method == SshAuthMethod::Password
        {
            return Err("ssh_password_required".to_string());
        }
        Ok(())
    }

    pub fn resolve_secret(&self) -> Result<Option<String>, String> {
        self.credential_reference
            .as_deref()
            .map(crate::credential_vault::load)
            .transpose()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshStartResponse {
    pub session_id: String,
    pub route_label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostKeyPreview {
    pub host: String,
    pub port: u16,
    pub status: String,
    pub algorithm: String,
    pub fingerprint: String,
    pub public_key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SshEvent {
    State {
        session_id: String,
        state: String,
        route_label: Option<String>,
        message: Option<String>,
    },
    HostKey {
        session_id: String,
        preview: SshHostKeyPreview,
    },
}

impl SshEvent {
    pub fn state(
        session_id: &str,
        state: &str,
        route_label: Option<&str>,
        message: Option<String>,
    ) -> Self {
        Self::State {
            session_id: session_id.to_string(),
            state: state.to_string(),
            route_label: route_label.map(str::to_string),
            message,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostKeyTrustRequest {
    pub host: String,
    pub port: u16,
    pub public_key: String,
}

impl SshHostKeyTrustRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.host.trim().is_empty()
            || self.host.len() > 255
            || self.port == 0
            || self.public_key.trim().is_empty()
            || self.public_key.len() > 16 * 1024
        {
            return Err("ssh_host_key_trust_request_invalid".to_string());
        }
        Ok(())
    }
}

const fn default_ssh_port() -> u16 {
    22
}

const fn default_cols() -> u16 {
    80
}

const fn default_rows() -> u16 {
    24
}

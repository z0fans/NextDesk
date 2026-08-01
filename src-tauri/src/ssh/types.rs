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

pub fn validate_sftp_session_id(session_id: &str) -> Result<(), String> {
    if session_id.trim().is_empty() || session_id.len() > 128 {
        return Err("sftp_session_id_invalid".to_string());
    }
    Ok(())
}

pub fn validate_sftp_remote_path(path: &str) -> Result<(), String> {
    if path.trim().is_empty() || path.len() > 4096 || path.contains('\0') {
        return Err("sftp_remote_path_invalid".to_string());
    }
    Ok(())
}

pub fn validate_sftp_operation_id(operation_id: &str) -> Result<(), String> {
    if operation_id.is_empty()
        || operation_id.len() > 128
        || !operation_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err("sftp_operation_id_invalid".to_string());
    }
    Ok(())
}

fn validate_sftp_mutation_path(path: &str) -> Result<(), String> {
    validate_sftp_remote_path(path)?;
    if path.ends_with('/') {
        return Err("sftp_mutation_path_invalid".to_string());
    }
    let normalized = path.trim_end_matches('/');
    let name = normalized.rsplit('/').next().unwrap_or_default();
    if normalized.is_empty()
        || name.is_empty()
        || name == "."
        || name == ".."
        || (!normalized.contains('/') && name.ends_with(':'))
    {
        return Err("sftp_mutation_path_invalid".to_string());
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SftpEntryKind {
    Directory,
    File,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub kind: SftpEntryKind,
    pub size: u64,
    pub modified: Option<u64>,
    pub permissions: Option<u32>,
    pub owner: Option<String>,
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpOpenResponse {
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpListRequest {
    pub session_id: String,
    pub path: String,
}

impl SftpListRequest {
    pub fn validate(&self) -> Result<(), String> {
        validate_sftp_session_id(&self.session_id)?;
        validate_sftp_remote_path(&self.path)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpListResponse {
    pub path: String,
    pub entries: Vec<SftpEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpCreateDirectoryRequest {
    pub session_id: String,
    pub operation_id: String,
    pub path: String,
}

impl SftpCreateDirectoryRequest {
    pub fn validate(&self) -> Result<(), String> {
        validate_sftp_session_id(&self.session_id)?;
        validate_sftp_operation_id(&self.operation_id)?;
        validate_sftp_mutation_path(&self.path)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpRenameRequest {
    pub session_id: String,
    pub operation_id: String,
    pub from_path: String,
    pub to_path: String,
    pub overwrite: bool,
}

impl SftpRenameRequest {
    pub fn validate(&self) -> Result<(), String> {
        validate_sftp_session_id(&self.session_id)?;
        validate_sftp_operation_id(&self.operation_id)?;
        validate_sftp_mutation_path(&self.from_path)?;
        validate_sftp_mutation_path(&self.to_path)?;
        if self.from_path == self.to_path {
            return Err("sftp_rename_same_path".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpRemoveRequest {
    pub session_id: String,
    pub operation_id: String,
    pub path: String,
    pub recursive: bool,
}

impl SftpRemoveRequest {
    pub fn validate(&self) -> Result<(), String> {
        validate_sftp_session_id(&self.session_id)?;
        validate_sftp_operation_id(&self.operation_id)?;
        validate_sftp_mutation_path(&self.path)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpTransferRequest {
    pub session_id: String,
    pub transfer_id: String,
    pub local_path: String,
    pub remote_path: String,
    pub overwrite: bool,
}

impl SftpTransferRequest {
    pub fn validate(&self) -> Result<(), String> {
        validate_sftp_session_id(&self.session_id)?;
        validate_sftp_operation_id(&self.transfer_id)
            .map_err(|_| "sftp_transfer_id_invalid".to_string())?;
        if self.local_path.trim().is_empty()
            || self.local_path.len() > 32_768
            || self.local_path.contains('\0')
        {
            return Err("sftp_local_path_invalid".to_string());
        }
        validate_sftp_remote_path(&self.remote_path)
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SftpTransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SftpTransferState {
    Queued,
    Running,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpTransferEvent {
    pub transfer_id: String,
    pub direction: SftpTransferDirection,
    pub state: SftpTransferState,
    pub transferred_bytes: u64,
    pub total_bytes: u64,
    pub message: Option<String>,
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

#[cfg(test)]
mod tests {
    use super::{
        SftpCreateDirectoryRequest, SftpEntry, SftpEntryKind, SftpListRequest, SftpRemoveRequest,
        SftpRenameRequest, SftpTransferDirection, SftpTransferEvent, SftpTransferRequest,
        SftpTransferState,
    };

    #[test]
    fn sftp_list_requests_validate_the_public_remote_path_boundary() {
        assert!(SftpListRequest {
            session_id: "ssh-tab".to_string(),
            path: "/home/root".to_string(),
        }
        .validate()
        .is_ok());
        assert!(SftpListRequest {
            session_id: "ssh-tab".to_string(),
            path: "/tmp/unsafe\0name".to_string(),
        }
        .validate()
        .is_err());
    }

    #[test]
    fn sftp_entries_serialize_for_the_frontend_contract() {
        let value = serde_json::to_value(SftpEntry {
            name: "notes.txt".to_string(),
            path: "/home/root/notes.txt".to_string(),
            kind: SftpEntryKind::File,
            size: 12,
            modified: Some(1_722_470_500),
            permissions: Some(0o644),
            owner: Some("root".to_string()),
            group: Some("root".to_string()),
        })
        .unwrap();
        assert_eq!(value["kind"], "file");
        assert_eq!(value["modified"], 1_722_470_500u64);
        assert!(value.get("session_id").is_none());
    }

    #[test]
    fn sftp_transfer_requests_validate_local_remote_and_task_boundaries() {
        let valid = SftpTransferRequest {
            session_id: "ssh-tab".to_string(),
            transfer_id: "transfer-123".to_string(),
            local_path: "/tmp/notes.txt".to_string(),
            remote_path: "/home/root/notes.txt".to_string(),
            overwrite: false,
        };
        assert!(valid.validate().is_ok());
        assert!(SftpTransferRequest {
            transfer_id: "../escape".to_string(),
            ..valid.clone()
        }
        .validate()
        .is_err());
        assert!(SftpTransferRequest {
            local_path: String::new(),
            ..valid
        }
        .validate()
        .is_err());
    }

    #[test]
    fn sftp_progress_events_use_the_frontend_contract() {
        let value = serde_json::to_value(SftpTransferEvent {
            transfer_id: "transfer-123".to_string(),
            direction: SftpTransferDirection::Upload,
            state: SftpTransferState::Running,
            transferred_bytes: 5,
            total_bytes: 10,
            message: None,
        })
        .unwrap();
        assert_eq!(value["transferId"], "transfer-123");
        assert_eq!(value["direction"], "upload");
        assert_eq!(value["state"], "running");
        assert_eq!(value["transferredBytes"], 5);
    }

    #[test]
    fn sftp_mutation_requests_validate_operation_and_remote_path_boundaries() {
        assert!(SftpCreateDirectoryRequest {
            session_id: "ssh-tab".to_string(),
            operation_id: "mkdir-1".to_string(),
            path: "/home/root/archive".to_string(),
        }
        .validate()
        .is_ok());
        assert!(SftpRenameRequest {
            session_id: "ssh-tab".to_string(),
            operation_id: "../invalid".to_string(),
            from_path: "/home/root/notes.txt".to_string(),
            to_path: "/home/root/renamed.txt".to_string(),
            overwrite: false,
        }
        .validate()
        .is_err());
        assert!(SftpRemoveRequest {
            session_id: "ssh-tab".to_string(),
            operation_id: "remove-1".to_string(),
            path: "/home/root/unsafe\0name".to_string(),
            recursive: true,
        }
        .validate()
        .is_err());
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

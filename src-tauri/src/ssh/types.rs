use crate::connection_resolver::RoutePolicy;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SshAuthMethod {
    Password,
    PrivateKey,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SshProxyType {
    #[default]
    None,
    Socks5,
    Http,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum StoredCredentialKind {
    PrivateKey,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredPrivateKeyCredential {
    kind: StoredCredentialKind,
    version: u8,
    label: String,
    private_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    public_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    passphrase: Option<String>,
}

impl StoredPrivateKeyCredential {
    const VERSION: u8 = 1;

    pub(crate) fn new(
        label: String,
        private_key: String,
        public_key: Option<String>,
        passphrase: Option<String>,
    ) -> Result<Self, String> {
        let label = label.trim().to_string();
        if label.is_empty() || label.len() > 128 {
            return Err("ssh_private_key_label_invalid".to_string());
        }
        let private_key = private_key.trim().to_string();
        if private_key.is_empty() || private_key.len() > 60 * 1024 {
            return Err("ssh_private_key_credential_invalid".to_string());
        }
        let passphrase = passphrase.filter(|value| !value.is_empty());
        if passphrase
            .as_deref()
            .is_some_and(|value| value.len() > 4096)
        {
            return Err("ssh_private_key_passphrase_invalid".to_string());
        }
        let public_key = public_key
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if public_key
            .as_deref()
            .is_some_and(|value| value.len() > 16 * 1024)
        {
            return Err("ssh_public_key_invalid".to_string());
        }
        Ok(Self {
            kind: StoredCredentialKind::PrivateKey,
            version: Self::VERSION,
            label,
            private_key,
            public_key,
            passphrase,
        })
    }

    pub(crate) fn encode(&self) -> Result<String, String> {
        serde_json::to_string(self).map_err(|_| "ssh_private_key_credential_invalid".to_string())
    }

    pub(crate) fn decode(stored: &str) -> Result<Self, String> {
        let credential: Self = serde_json::from_str(stored)
            .map_err(|_| "ssh_private_key_credential_invalid".to_string())?;
        if credential.version != Self::VERSION || credential.private_key.trim().is_empty() {
            return Err("ssh_private_key_credential_invalid".to_string());
        }
        Ok(credential)
    }

    pub(crate) fn private_key(&self) -> &str {
        &self.private_key
    }

    pub(crate) fn public_key(&self) -> Option<&str> {
        self.public_key.as_deref()
    }

    pub(crate) fn passphrase(&self) -> Option<&str> {
        self.passphrase.as_deref()
    }
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
    #[serde(default)]
    pub proxy_type: SshProxyType,
    #[serde(default)]
    pub proxy_host: Option<String>,
    #[serde(default)]
    pub proxy_port: Option<u16>,
    #[serde(default)]
    pub proxy_username: Option<String>,
    #[serde(default)]
    pub proxy_credential_reference: Option<String>,
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
                .or_else(|| {
                    self.credential_reference
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                })
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
        if self.proxy_type != SshProxyType::None {
            let proxy_host = self
                .proxy_host
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "ssh_proxy_host_required".to_string())?;
            if proxy_host.len() > 255 || proxy_host.chars().any(char::is_whitespace) {
                return Err("ssh_proxy_host_invalid".to_string());
            }
            if self.proxy_port.is_none_or(|port| port == 0) {
                return Err("ssh_proxy_port_invalid".to_string());
            }
            if self
                .proxy_username
                .as_deref()
                .is_some_and(|value| value.len() > 255)
            {
                return Err("ssh_proxy_username_invalid".to_string());
            }
            if self
                .proxy_credential_reference
                .as_deref()
                .is_some_and(|value| value.trim().is_empty() || value.len() > 128)
            {
                return Err("ssh_proxy_credential_invalid".to_string());
            }
        }
        Ok(())
    }

    pub fn resolve_secret(&self) -> Result<Option<String>, String> {
        self.credential_reference
            .as_deref()
            .map(crate::credential_vault::load)
            .transpose()
    }

    pub fn resolve_proxy_secret(&self) -> Result<Option<String>, String> {
        self.proxy_credential_reference
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

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SshMonitorProcess {
    pub memory_bytes: u64,
    pub cpu_percent: f64,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SshMonitorDisk {
    pub path: String,
    pub available_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SshMonitorSnapshot {
    pub supported: bool,
    pub platform: String,
    pub uptime_seconds: u64,
    pub load_average: [f64; 3],
    pub cpu_percent: f64,
    pub memory_used_bytes: u64,
    pub memory_total_bytes: u64,
    pub swap_used_bytes: u64,
    pub swap_total_bytes: u64,
    pub processes: Vec<SshMonitorProcess>,
    pub network_interface: Option<String>,
    pub network_receive_bytes_per_second: f64,
    pub network_transmit_bytes_per_second: f64,
    pub latency_ms: f64,
    pub disks: Vec<SshMonitorDisk>,
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshKnownHostEntry {
    pub host: String,
    pub algorithm: String,
    pub fingerprint: String,
    pub public_key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
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

fn session_id_is_valid(session_id: &str) -> bool {
    !session_id.trim().is_empty() && session_id.len() <= 128
}

pub fn validate_ssh_session_id(session_id: &str) -> Result<(), String> {
    if !session_id_is_valid(session_id) {
        return Err("ssh_session_id_invalid".to_string());
    }
    Ok(())
}

pub fn validate_sftp_session_id(session_id: &str) -> Result<(), String> {
    if !session_id_is_valid(session_id) {
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpReadTextRequest {
    pub session_id: String,
    pub path: String,
}

impl SftpReadTextRequest {
    pub fn validate(&self) -> Result<(), String> {
        validate_sftp_session_id(&self.session_id)?;
        validate_sftp_mutation_path(&self.path)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpReadTextResponse {
    pub path: String,
    pub content: String,
    pub modified: Option<u64>,
    pub permissions: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpWriteTextRequest {
    pub session_id: String,
    pub operation_id: String,
    pub path: String,
    pub content: String,
}

impl SftpWriteTextRequest {
    pub fn validate(&self) -> Result<(), String> {
        validate_sftp_session_id(&self.session_id)?;
        validate_sftp_operation_id(&self.operation_id)?;
        validate_sftp_mutation_path(&self.path)?;
        if self.content.len() > 2 * 1024 * 1024 {
            return Err("sftp_text_file_too_large".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpSetPermissionsRequest {
    pub session_id: String,
    pub operation_id: String,
    pub path: String,
    pub permissions: u32,
}

impl SftpSetPermissionsRequest {
    pub fn validate(&self) -> Result<(), String> {
        validate_sftp_session_id(&self.session_id)?;
        validate_sftp_operation_id(&self.operation_id)?;
        validate_sftp_mutation_path(&self.path)?;
        if self.permissions > 0o7777 {
            return Err("sftp_permissions_invalid".to_string());
        }
        Ok(())
    }
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
    #[serde(default)]
    pub recursive: bool,
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
        SftpTransferState, SshAuthMethod, SshEvent, SshHostKeyPreview, SshMonitorDisk,
        SshMonitorProcess, SshMonitorSnapshot, SshProxyType, SshStartRequest,
    };
    use crate::connection_resolver::RoutePolicy;

    #[test]
    fn inline_private_key_auth_uses_a_vault_reference_without_a_file_path() {
        let request = SshStartRequest {
            session_id: "ssh-inline-key".to_string(),
            host: "server.example.com".to_string(),
            port: 22,
            username: "deploy".to_string(),
            auth_method: SshAuthMethod::PrivateKey,
            credential_reference: Some("ssh-inline-key".to_string()),
            private_key_path: None,
            cols: 80,
            rows: 24,
            pixel_width: 0,
            pixel_height: 0,
            route_policy: RoutePolicy::Direct,
            preferred_region: None,
            reuse_cloud_binding: false,
            proxy_type: SshProxyType::None,
            proxy_host: None,
            proxy_port: None,
            proxy_username: None,
            proxy_credential_reference: None,
        };

        assert!(request.validate().is_ok());

        let mut missing_key = request;
        missing_key.credential_reference = None;
        assert_eq!(
            missing_key.validate(),
            Err("ssh_private_key_required".to_string())
        );
    }

    #[test]
    fn proxy_settings_require_a_valid_endpoint_without_embedding_credentials() {
        let mut request = SshStartRequest {
            session_id: "ssh-proxy".to_string(),
            host: "server.example.com".to_string(),
            port: 22,
            username: "deploy".to_string(),
            auth_method: SshAuthMethod::Password,
            credential_reference: Some("ssh-proxy-main".to_string()),
            private_key_path: None,
            cols: 80,
            rows: 24,
            pixel_width: 0,
            pixel_height: 0,
            route_policy: RoutePolicy::Direct,
            preferred_region: None,
            reuse_cloud_binding: false,
            proxy_type: SshProxyType::Socks5,
            proxy_host: Some("127.0.0.1".to_string()),
            proxy_port: Some(1080),
            proxy_username: Some("proxy-user".to_string()),
            proxy_credential_reference: Some("ssh-proxy-secret".to_string()),
        };
        assert!(request.validate().is_ok());

        request.proxy_host = Some("invalid proxy".to_string());
        assert_eq!(
            request.validate(),
            Err("ssh_proxy_host_invalid".to_string())
        );
    }

    #[test]
    fn ssh_events_use_frontend_camel_case_field_names() {
        let state = serde_json::to_value(SshEvent::state(
            "tab-1",
            "connecting_transport",
            Some("direct"),
            None,
        ))
        .unwrap();
        assert_eq!(state["kind"], "state");
        assert_eq!(state["sessionId"], "tab-1");
        assert_eq!(state["routeLabel"], "direct");
        assert!(state.get("session_id").is_none());

        let host_key = serde_json::to_value(SshEvent::HostKey {
            session_id: "tab-1".to_string(),
            preview: SshHostKeyPreview {
                host: "server.example.com".to_string(),
                port: 22,
                status: "unknown".to_string(),
                algorithm: "ssh-ed25519".to_string(),
                fingerprint: "SHA256:test".to_string(),
                public_key: "ssh-ed25519 test".to_string(),
            },
        })
        .unwrap();
        assert_eq!(host_key["kind"], "host_key");
        assert_eq!(host_key["sessionId"], "tab-1");
        assert!(host_key.get("session_id").is_none());
    }

    #[test]
    fn monitor_snapshots_use_the_frontend_camel_case_contract() {
        let value = serde_json::to_value(SshMonitorSnapshot {
            supported: true,
            platform: "linux".to_string(),
            uptime_seconds: 60,
            load_average: [0.1, 0.2, 0.3],
            cpu_percent: 12.5,
            memory_used_bytes: 1024,
            memory_total_bytes: 4096,
            swap_used_bytes: 0,
            swap_total_bytes: 0,
            processes: vec![SshMonitorProcess {
                memory_bytes: 512,
                cpu_percent: 1.0,
                command: "sshd".to_string(),
            }],
            network_interface: Some("eth0".to_string()),
            network_receive_bytes_per_second: 2048.0,
            network_transmit_bytes_per_second: 1024.0,
            latency_ms: 10.5,
            disks: vec![SshMonitorDisk {
                path: "/".to_string(),
                available_bytes: 8192,
                total_bytes: 16384,
            }],
        })
        .unwrap();

        assert_eq!(value["uptimeSeconds"], 60);
        assert_eq!(value["platform"], "linux");
        assert_eq!(value["processes"][0]["memoryBytes"], 512);
        assert_eq!(value["networkInterface"], "eth0");
        assert_eq!(value["disks"][0]["availableBytes"], 8192);
        assert!(value.get("uptime_seconds").is_none());
    }

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
            recursive: false,
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

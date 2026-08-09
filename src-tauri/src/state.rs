use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub type CloudResolveResult = Result<crate::connection_resolver::ResolvedTarget, String>;
pub type CloudResolveSender = tokio::sync::watch::Sender<Option<CloudResolveResult>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveCloudBinding {
    pub binding_id: String,
    pub original_host: String,
    pub original_port: u16,
    pub endpoint_host: String,
    pub endpoint_port: u16,
    pub expires_at_ms: u128,
    pub renew_at_ms: u128,
    pub renew_after_seconds: u64,
    pub reconnect_until_ms: u128,
}

impl ActiveCloudBinding {
    pub fn from_response(
        original_host: &str,
        original_port: u16,
        response: &crate::cloud_gateway::CloudBindingResponse,
    ) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let expires_at_ms = time::OffsetDateTime::parse(
            &response.expires_at,
            &time::format_description::well_known::Rfc3339,
        )
        .ok()
        .and_then(|value| u128::try_from(value.unix_timestamp_nanos() / 1_000_000).ok())
        .filter(|value| *value > now)
        .unwrap_or(now + 180_000);
        let renew_at_ms = (now + u128::from(response.renew_after_seconds) * 1000)
            .min(expires_at_ms.saturating_sub(30_000));
        Self {
            binding_id: response.binding_id.clone(),
            original_host: original_host.to_string(),
            original_port,
            endpoint_host: response.endpoint.host.clone(),
            endpoint_port: response.endpoint.port,
            expires_at_ms,
            renew_at_ms,
            renew_after_seconds: response.renew_after_seconds,
            reconnect_until_ms: now + u128::from(response.reconnect_grace_seconds) * 1000,
        }
    }

    pub fn resolved(&self) -> crate::connection_resolver::ResolvedTarget {
        crate::connection_resolver::ResolvedTarget {
            host: self.endpoint_host.clone(),
            port: self.endpoint_port,
            binding_id: Some(self.binding_id.clone()),
            route_label: "cloud".to_string(),
            force_direct: true,
            route_lease_id: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ClipboardSessionState {
    pub session_id: String,
    pub strategy: String,
    pub staged_paths: Vec<String>,
    pub updated_at_ms: u128,
}

pub struct AppState {
    pub rdp_proxy_port: Arc<Mutex<u16>>,
    pub rdp_proxy_error: Arc<Mutex<Option<String>>>,
    pub clipboard_sessions: Arc<Mutex<HashMap<String, ClipboardSessionState>>>,
    pub mac_clipboard_strategy: Arc<Mutex<String>>,
    pub dashboard_url: Arc<Mutex<String>>,
    pub cloud_authorization_base_url: Arc<Mutex<String>>,
    pub cloud_active_bindings: Arc<Mutex<HashMap<String, ActiveCloudBinding>>>,
    pub cloud_resolve_inflight: Arc<Mutex<HashMap<String, CloudResolveSender>>>,
    pub active_route_leases: Arc<Mutex<HashMap<String, crate::connection_resolver::RouteLease>>>,
    pub ssh_sessions: Arc<Mutex<crate::ssh::manager::SshSessionManager>>,
    pub audio_manager: Arc<Mutex<crate::rdp_audio::AudioManager>>,
    #[cfg(feature = "nextdesk-native-rdp")]
    pub native_sessions: Arc<Mutex<crate::rdp_session::SessionManager>>,
    pub native_view_bounds: crate::rdp_native_view::NativeViewBoundsStore,
    pub native_view_hosts: crate::rdp_native_view::NativeViewHostStore,
    pub file_transfer_ws_port: Arc<Mutex<u16>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            rdp_proxy_port: Arc::new(Mutex::new(18765)),
            rdp_proxy_error: Arc::new(Mutex::new(None)),
            clipboard_sessions: Arc::new(Mutex::new(HashMap::new())),
            mac_clipboard_strategy: Arc::new(Mutex::new("session-file-url".to_string())),
            dashboard_url: Arc::new(Mutex::new(String::new())),
            cloud_authorization_base_url: Arc::new(Mutex::new(String::new())),
            cloud_active_bindings: Arc::new(Mutex::new(HashMap::new())),
            cloud_resolve_inflight: Arc::new(Mutex::new(HashMap::new())),
            active_route_leases: Arc::new(Mutex::new(HashMap::new())),
            ssh_sessions: Arc::new(Mutex::new(crate::ssh::manager::SshSessionManager::default())),
            audio_manager: Arc::new(Mutex::new(crate::rdp_audio::AudioManager::default())),
            #[cfg(feature = "nextdesk-native-rdp")]
            native_sessions: Arc::new(Mutex::new(crate::rdp_session::SessionManager::default())),
            native_view_bounds: crate::rdp_native_view::create_bounds_store(),
            native_view_hosts: crate::rdp_native_view::create_host_store(),
            file_transfer_ws_port: Arc::new(Mutex::new(0)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ActiveCloudBinding;
    use crate::cloud_gateway::{CloudBindingResponse, CloudEndpoint};
    use time::format_description::well_known::Rfc3339;

    #[test]
    fn cloud_binding_uses_server_expiry_and_renew_schedule() {
        let expires_at = time::OffsetDateTime::now_utc() + time::Duration::minutes(10);
        let response = CloudBindingResponse {
            binding_id: "bnd_test".to_string(),
            endpoint: CloudEndpoint {
                host: "edge.example.com".to_string(),
                port: 42001,
                protocols: vec!["tcp".to_string()],
            },
            expires_at: expires_at.format(&Rfc3339).unwrap(),
            renew_after_seconds: 60,
            reconnect_grace_seconds: 120,
            status: Some("active".to_string()),
        };

        let binding = ActiveCloudBinding::from_response("203.0.113.10", 3389, &response);
        let expected_expiry =
            u128::try_from(expires_at.unix_timestamp_nanos() / 1_000_000).unwrap();
        assert!(binding.expires_at_ms.abs_diff(expected_expiry) < 1_000);
        assert!(binding.renew_at_ms < binding.expires_at_ms);
        assert_eq!(binding.renew_after_seconds, 60);
    }
}

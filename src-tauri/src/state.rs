use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::process::Child;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SyncState {
    Idle,
    Syncing,
    Failed {
        error_category: String,
        error_detail: String,
    },
}

impl Default for SyncState {
    fn default() -> Self {
        SyncState::Idle
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Server {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency: Option<i64>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyGroup {
    pub name: String,
    #[serde(rename = "type")]
    pub group_type: String,
    pub proxies: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub now: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunMode {
    pub reuse_mode: bool,
    pub clash_api: String,
    pub proxy_port: u16,
    pub cloud_mode: bool,
    pub dashboard_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayEndpoint {
    pub id: i64,
    pub name: String,
    pub host: String,
    pub port: i64,
    pub protocol: String,
    pub server_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ClipboardSessionState {
    pub session_id: String,
    pub strategy: String,
    pub staged_paths: Vec<String>,
    pub updated_at_ms: u128,
}

pub struct AppState {
    pub servers: Arc<Mutex<Vec<Server>>>,
    pub proxy_groups: Arc<Mutex<Vec<ProxyGroup>>>,
    pub subscription_url: Arc<Mutex<String>>,
    pub clash_process: Arc<Mutex<Option<Child>>>,
    pub clash_api_base: Arc<Mutex<String>>,
    pub proxy_port: Arc<Mutex<u16>>,
    pub reuse_mode: Arc<Mutex<bool>>,
    pub rdp_proxy_port: Arc<Mutex<u16>>,
    pub rdp_proxy_error: Arc<Mutex<Option<String>>>,
    pub clipboard_sessions: Arc<Mutex<HashMap<String, ClipboardSessionState>>>,
    pub mac_clipboard_strategy: Arc<Mutex<String>>,
    pub tube_enabled: Arc<Mutex<bool>>,
    pub cloud_mode: Arc<Mutex<bool>>,
    pub dashboard_url: Arc<Mutex<String>>,
    pub relay_api_key: Arc<Mutex<String>>,
    pub relay_endpoints: Arc<Mutex<Vec<RelayEndpoint>>>,
    pub auto_update_enabled: Arc<Mutex<bool>>,
    pub last_sync_ts: Arc<Mutex<u64>>,
    pub sync_state: Arc<Mutex<SyncState>>,
    pub audio_manager: Arc<Mutex<crate::rdp_audio::AudioManager>>,
    pub native_sessions: Arc<Mutex<crate::rdp_session::SessionManager>>,
    pub native_view_bounds: crate::rdp_native_view::NativeViewBoundsStore,
    pub native_view_hosts: crate::rdp_native_view::NativeViewHostStore,
    pub file_transfer_ws_port: Arc<Mutex<u16>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            servers: Arc::new(Mutex::new(Vec::new())),
            proxy_groups: Arc::new(Mutex::new(Vec::new())),
            subscription_url: Arc::new(Mutex::new(String::new())),
            clash_process: Arc::new(Mutex::new(None)),
            clash_api_base: Arc::new(Mutex::new("http://127.0.0.1:17891".to_string())),
            proxy_port: Arc::new(Mutex::new(17897)),
            reuse_mode: Arc::new(Mutex::new(false)),
            rdp_proxy_port: Arc::new(Mutex::new(18765)),
            rdp_proxy_error: Arc::new(Mutex::new(None)),
            clipboard_sessions: Arc::new(Mutex::new(HashMap::new())),
            mac_clipboard_strategy: Arc::new(Mutex::new("session-file-url".to_string())),
            tube_enabled: Arc::new(Mutex::new(false)),
            cloud_mode: Arc::new(Mutex::new(false)),
            dashboard_url: Arc::new(Mutex::new(String::new())),
            relay_api_key: Arc::new(Mutex::new(String::new())),
            relay_endpoints: Arc::new(Mutex::new(Vec::new())),
            auto_update_enabled: Arc::new(Mutex::new(true)),
            last_sync_ts: Arc::new(Mutex::new(0)),
            sync_state: Arc::new(Mutex::new(SyncState::default())),
            audio_manager: Arc::new(Mutex::new(crate::rdp_audio::AudioManager::default())),
            native_sessions: Arc::new(Mutex::new(crate::rdp_session::SessionManager::default())),
            native_view_bounds: crate::rdp_native_view::create_bounds_store(),
            native_view_hosts: crate::rdp_native_view::create_host_store(),
            file_transfer_ws_port: Arc::new(Mutex::new(0)),
        }
    }
}

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::process::Child;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdaterState {
    pub download_url: Option<String>,
    pub status: String,
    pub progress: f32,
    pub downloaded_path: Option<String>,
}

impl Default for UpdaterState {
    fn default() -> Self {
        Self {
            download_url: None,
            status: "idle".to_string(),
            progress: 0.0,
            downloaded_path: None,
        }
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
    pub clipboard_sessions: Arc<Mutex<HashMap<String, ClipboardSessionState>>>,
    pub mac_clipboard_strategy: Arc<Mutex<String>>,
    pub updater_state: Arc<Mutex<UpdaterState>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            servers: Arc::new(Mutex::new(Vec::new())),
            proxy_groups: Arc::new(Mutex::new(
                Vec::new(),
            )),
            subscription_url: Arc::new(Mutex::new(
                String::new(),
            )),
            clash_process: Arc::new(Mutex::new(None)),
            clash_api_base: Arc::new(Mutex::new(
                "http://127.0.0.1:17891".to_string(),
            )),
            proxy_port: Arc::new(Mutex::new(17897)),
            reuse_mode: Arc::new(Mutex::new(false)),
            rdp_proxy_port: Arc::new(Mutex::new(18765)),
            clipboard_sessions: Arc::new(Mutex::new(HashMap::new())),
            mac_clipboard_strategy: Arc::new(Mutex::new("session-file-url".to_string())),
            updater_state: Arc::new(Mutex::new(UpdaterState::default())),
        }
    }
}

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

pub(crate) const CLOUD_AUTH_BASE_URL: &str = "https://oauth.mxolab.com";

pub fn get_user_config_dir() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| dirs::home_dir().unwrap());
    let config_dir = base.join("NextDesk");
    fs::create_dir_all(&config_dir).ok();
    config_dir
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct SavedConfig {
    #[serde(default)]
    pub dashboard_url: String,
    #[serde(default)]
    pub cloud_authorization_base_url: String,
    #[serde(default)]
    pub cloud_device_id: String,
    #[serde(default)]
    pub cloud_installation_id: String,
    #[serde(default)]
    pub cloud_device_expires_at: String,
    #[serde(default)]
    pub cloud_account_display: String,
    #[serde(default)]
    pub cloud_account_available: bool,
    #[serde(default)]
    pub cloud_account_available_until: String,
    #[serde(default)]
    pub cloud_account_reason: String,
    #[serde(default)]
    pub rdp_resolution_mode: Option<String>,
}

pub fn load_saved_config() -> SavedConfig {
    let path = get_user_config_dir().join("config.json");
    if !path.exists() {
        return SavedConfig::default();
    }
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => SavedConfig::default(),
    }
}

pub fn save_config(cfg: &SavedConfig) {
    let path = get_user_config_dir().join("config.json");
    if let Ok(json) = serde_json::to_string_pretty(cfg) {
        fs::write(path, json).ok();
    }
}

#[tauri::command]
pub fn rdp_resolution_get() -> String {
    load_saved_config()
        .rdp_resolution_mode
        .unwrap_or_else(|| "adaptive".into())
}

#[tauri::command]
pub fn rdp_resolution_set(mode: String) -> Result<(), String> {
    if !matches!(
        mode.as_str(),
        "adaptive"
            | "smartSizing"
            | "1920x1080"
            | "1600x900"
            | "1440x900"
            | "1366x768"
            | "1280x720"
    ) {
        return Err("Unsupported RDP resolution mode".into());
    }
    let mut saved = load_saved_config();
    saved.rdp_resolution_mode = Some(mode);
    let json = serde_json::to_string_pretty(&saved).map_err(|error| error.to_string())?;
    fs::write(get_user_config_dir().join("config.json"), json).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::SavedConfig;

    #[test]
    fn rdp_resolution_preference_survives_config_round_trip() {
        let legacy: SavedConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(legacy.rdp_resolution_mode, None);
        for mode in ["adaptive", "smartSizing", "1920x1080"] {
            let saved = SavedConfig {
                rdp_resolution_mode: Some(mode.into()),
                ..SavedConfig::default()
            };
            let restored: SavedConfig =
                serde_json::from_str(&serde_json::to_string(&saved).unwrap()).unwrap();
            assert_eq!(restored.rdp_resolution_mode.as_deref(), Some(mode));
        }
        assert!(super::rdp_resolution_set("invalid".into()).is_err());
    }

    #[test]
    fn legacy_subscription_and_engine_fields_are_ignored() {
        let saved: SavedConfig = serde_json::from_value(serde_json::json!({
            "subscription_url": "https://example.com/subscription",
            "servers": [{ "id": "node-1" }],
            "proxy_groups": [{ "name": "Server-Global" }],
            "tube_enabled": true,
            "cloud_mode": true,
            "relay_api_key": "legacy-secret",
            "auto_update_enabled": true,
            "last_sync_ts": 42,
            "dashboard_url": "https://oauth.mxolab.com",
            "cloud_device_id": "device-1",
            "cloud_account_display": "User"
        }))
        .expect("legacy config should remain readable");

        assert_eq!(saved.dashboard_url, "https://oauth.mxolab.com");
        assert_eq!(saved.cloud_device_id, "device-1");
        assert_eq!(saved.cloud_account_display, "User");
    }

    #[test]
    fn serialized_config_omits_removed_subscription_and_engine_fields() {
        let saved = SavedConfig {
            dashboard_url: "https://oauth.mxolab.com".to_string(),
            cloud_device_id: "device-1".to_string(),
            ..SavedConfig::default()
        };

        let value = serde_json::to_value(saved).expect("serialize config");
        assert_eq!(value["dashboard_url"], "https://oauth.mxolab.com");
        assert!(value.get("subscription_url").is_none());
        assert!(value.get("proxy_groups").is_none());
        assert!(value.get("cloud_mode").is_none());
        assert!(value.get("relay_api_key").is_none());
    }
}

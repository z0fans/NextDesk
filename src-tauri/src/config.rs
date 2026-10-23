use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub(crate) const CLOUD_AUTH_BASE_URL: &str = "https://oauth.mxolab.com";
static CONFIG_UPDATE_LOCK: Mutex<()> = Mutex::new(());

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
    pub cloud_authorization_revision: u64,
    #[serde(default)]
    pub cloud_credential_reference: String,
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
    /// `None` preserves the privacy setting used by releases before this
    /// option existed: anonymous quality feedback is enabled by default.
    #[serde(default)]
    pub anonymous_quality_feedback_enabled: Option<bool>,
    #[serde(default)]
    pub rdp_resolution_mode: Option<String>,
}

impl SavedConfig {
    pub fn anonymous_quality_feedback_enabled(&self) -> bool {
        self.anonymous_quality_feedback_enabled.unwrap_or(true)
    }
}

pub fn load_saved_config() -> SavedConfig {
    read_saved_config(&get_user_config_dir().join("config.json")).unwrap_or_default()
}

fn read_saved_config(path: &Path) -> Result<SavedConfig, String> {
    match fs::read(path) {
        Ok(content) => {
            serde_json::from_slice(&content).map_err(|error| format!("config_parse_failed:{error}"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(SavedConfig::default()),
        Err(error) => Err(format!("config_read_failed:{error}")),
    }
}

pub fn update_saved_config<T>(
    update: impl FnOnce(&mut SavedConfig) -> Result<T, String>,
) -> Result<T, String> {
    update_saved_config_at(&get_user_config_dir().join("config.json"), update)
}

pub(crate) fn update_saved_config_at<T>(
    path: &Path,
    update: impl FnOnce(&mut SavedConfig) -> Result<T, String>,
) -> Result<T, String> {
    let _guard = CONFIG_UPDATE_LOCK
        .lock()
        .map_err(|_| "config_lock_poisoned".to_string())?;
    let mut saved = read_saved_config(path)?;
    let result = update(&mut saved)?;
    let json = serde_json::to_vec_pretty(&saved)
        .map_err(|error| format!("config_serialize_failed:{error}"))?;
    let temporary = path.with_file_name(format!(".config-{:016x}.tmp", rand::random::<u64>()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("config_write_failed:{error}"))?;
    let written = file.write_all(&json).and_then(|_| file.sync_all());
    drop(file);
    let replaced = written.and_then(|_| fs::rename(&temporary, path));
    if let Err(error) = replaced {
        let _ = fs::remove_file(&temporary);
        return Err(format!("config_write_failed:{error}"));
    }
    Ok(result)
}

#[tauri::command]
pub fn anonymous_quality_feedback_get() -> bool {
    load_saved_config().anonymous_quality_feedback_enabled()
}

#[tauri::command]
pub fn anonymous_quality_feedback_set(enabled: bool) -> Result<bool, String> {
    update_saved_config(|saved| {
        saved.anonymous_quality_feedback_enabled = Some(enabled);
        Ok(enabled)
    })
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
    update_saved_config(|saved| {
        saved.rdp_resolution_mode = Some(mode);
        Ok(())
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::{read_saved_config, update_saved_config_at, SavedConfig};
    use std::fs;
    use std::path::PathBuf;

    pub(crate) struct TestConfig {
        pub path: PathBuf,
    }

    impl TestConfig {
        pub fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "nextdesk-config-test-{:016x}",
                rand::random::<u64>()
            ));
            fs::create_dir(&root).unwrap();
            Self {
                path: root.join("config.json"),
            }
        }
    }

    impl Drop for TestConfig {
        fn drop(&mut self) {
            let root = self.path.parent().unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(root, fs::Permissions::from_mode(0o700)).unwrap();
            }
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn concurrent_updates_preserve_independent_fields() {
        let fixture = TestConfig::new();
        let start = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                start.wait();
                for _ in 0..20 {
                    update_saved_config_at(&fixture.path, |saved| {
                        saved.anonymous_quality_feedback_enabled = Some(false);
                        Ok(())
                    })
                    .unwrap();
                }
            });
            scope.spawn(|| {
                start.wait();
                for _ in 0..20 {
                    update_saved_config_at(&fixture.path, |saved| {
                        saved.rdp_resolution_mode = Some("1280x720".into());
                        Ok(())
                    })
                    .unwrap();
                }
            });
        });
        let saved = read_saved_config(&fixture.path).unwrap();
        assert_eq!(saved.anonymous_quality_feedback_enabled, Some(false));
        assert_eq!(saved.rdp_resolution_mode.as_deref(), Some("1280x720"));
        assert_eq!(
            fs::read_dir(fixture.path.parent().unwrap())
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn rejected_update_and_corrupt_config_preserve_original_bytes() {
        let fixture = TestConfig::new();
        let original = br#"{"rdp_resolution_mode":"1280x720"}"#;
        fs::write(&fixture.path, original).unwrap();
        let result = update_saved_config_at(&fixture.path, |saved| {
            saved.rdp_resolution_mode = None;
            Err::<(), _>("rejected".to_string())
        });
        assert_eq!(result.unwrap_err(), "rejected");
        assert_eq!(fs::read(&fixture.path).unwrap(), original);

        fs::write(&fixture.path, b"{corrupted").unwrap();
        let mut called = false;
        let result = update_saved_config_at(&fixture.path, |_| {
            called = true;
            Ok(())
        });
        assert!(result.unwrap_err().starts_with("config_parse_failed:"));
        assert!(!called);
        assert_eq!(fs::read(&fixture.path).unwrap(), b"{corrupted");
    }

    #[cfg(unix)]
    #[test]
    fn write_failure_keeps_existing_config() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = TestConfig::new();
        let original = br#"{"anonymous_quality_feedback_enabled":false}"#;
        fs::write(&fixture.path, original).unwrap();
        fs::set_permissions(
            fixture.path.parent().unwrap(),
            fs::Permissions::from_mode(0o500),
        )
        .unwrap();
        let result = update_saved_config_at(&fixture.path, |saved| {
            saved.rdp_resolution_mode = Some("1920x1080".into());
            Ok(())
        });
        assert!(result.unwrap_err().starts_with("config_write_failed:"));
        assert_eq!(fs::read(&fixture.path).unwrap(), original);
    }

    #[test]
    fn rdp_resolution_preference_survives_config_round_trip() {
        let legacy: SavedConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(legacy.rdp_resolution_mode, None);
        assert_eq!(legacy.cloud_authorization_revision, 0);
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

    #[test]
    fn legacy_config_keeps_anonymous_quality_feedback_enabled() {
        let saved: SavedConfig = serde_json::from_value(serde_json::json!({
            "dashboard_url": "https://oauth.mxolab.com"
        }))
        .expect("legacy config should remain readable");

        assert!(saved.anonymous_quality_feedback_enabled());
    }

    #[test]
    fn anonymous_quality_feedback_opt_out_round_trips() {
        let saved: SavedConfig = serde_json::from_value(serde_json::json!({
            "anonymous_quality_feedback_enabled": false
        }))
        .expect("privacy setting should deserialize");

        assert!(!saved.anonymous_quality_feedback_enabled());
        let value = serde_json::to_value(saved).expect("privacy setting should serialize");
        assert_eq!(value["anonymous_quality_feedback_enabled"], false);
    }
}

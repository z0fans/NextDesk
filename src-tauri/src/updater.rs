use crate::state::AppState;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Write;
use std::time::Duration;
use tauri::State;

const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const GITHUB_REPO: &str = "z0fans/NextDesk";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub has_update: bool,
    pub current_version: String,
    pub latest_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn get_current_version() -> String {
    CURRENT_VERSION.to_string()
}

pub async fn check_for_update(app_state: State<'_, AppState>) -> UpdateInfo {
    let url = format!(
        "https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
    );
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_default();

    let resp = match client
        .get(&url)
        .header("User-Agent", "NextDesk")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return UpdateInfo {
                has_update: false,
                current_version: CURRENT_VERSION.into(),
                latest_version: None,
                download_url: None,
                error: Some(e.to_string()),
            };
        }
    };

    let data: Value = match resp.json().await {
        Ok(d) => d,
        Err(e) => {
            return UpdateInfo {
                has_update: false,
                current_version: CURRENT_VERSION.into(),
                latest_version: None,
                download_url: None,
                error: Some(e.to_string()),
            };
        }
    };

    let tag = data
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let latest = tag.trim_start_matches('v').to_string();

    let download_url = data
        .get("assets")
        .and_then(|v| v.as_array())
        .and_then(|assets| {
            assets.iter().find_map(|a| {
                let name = a
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("");
                if name.ends_with(".exe")
                    || name.ends_with(".dmg")
                {
                    a.get("browser_download_url")
                        .and_then(|u| u.as_str())
                        .map(|s| s.to_string())
                } else {
                    None
                }
            })
        });

    let has_update =
        compare_versions(&latest, CURRENT_VERSION) > 0;

    if let Some(url) = &download_url {
        app_state.updater_state.lock().unwrap().download_url = Some(url.clone());
    }

    UpdateInfo {
        has_update,
        current_version: CURRENT_VERSION.into(),
        latest_version: Some(latest),
        download_url,
        error: None,
    }
}

fn compare_versions(v1: &str, v2: &str) -> i32 {
    let parse = |v: &str| -> Vec<i32> {
        v.split('.')
            .filter_map(|s| s.parse().ok())
            .collect()
    };
    let p1 = parse(v1);
    let p2 = parse(v2);
    for (a, b) in p1.iter().zip(p2.iter()) {
        if a > b {
            return 1;
        }
        if a < b {
            return -1;
        }
    }
    (p1.len() as i32) - (p2.len() as i32)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadStatus {
    pub status: String,
    pub progress: f32,
}

pub async fn start_download_update(app_state: State<'_, AppState>) -> Result<bool, String> {
    let url = {
        let state = app_state.updater_state.lock().unwrap();
        state.download_url.clone()
    };
    
    let url = match url {
        Some(u) => u,
        None => return Err("No download URL found. Check for updates first.".to_string()),
    };

    {
        let mut state = app_state.updater_state.lock().unwrap();
        state.status = "downloading".to_string();
        state.progress = 0.0;
        state.downloaded_path = None;
    }

    let state_arc = app_state.updater_state.clone();
    
    tauri::async_runtime::spawn(async move {
        let client = Client::new();
        let mut resp = match client.get(&url).send().await {
            Ok(r) => r,
            Err(e) => {
                state_arc.lock().unwrap().status = format!("error: {}", e);
                return;
            }
        };

        if !resp.status().is_success() {
            state_arc.lock().unwrap().status = format!("error: HTTP {}", resp.status());
            return;
        }

        let total_size = resp
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|ct_len| ct_len.to_str().ok())
            .and_then(|ct_len| ct_len.parse::<f32>().ok())
            .unwrap_or(0.0);

        let file_name = url.split('/').last().unwrap_or("update_package");
        let temp_dir = std::env::temp_dir();
        let dest_path = temp_dir.join(file_name);
        
        let mut file = match std::fs::File::create(&dest_path) {
            Ok(f) => f,
            Err(e) => {
                state_arc.lock().unwrap().status = format!("error: {}", e);
                return;
            }
        };

        let mut downloaded = 0.0;
        while let Ok(Some(chunk)) = resp.chunk().await {
            if let Err(e) = file.write_all(&chunk) {
                state_arc.lock().unwrap().status = format!("error: {}", e);
                return;
            }
            downloaded += chunk.len() as f32;
            if total_size > 0.0 {
                let mut st = state_arc.lock().unwrap();
                st.progress = (downloaded / total_size) * 100.0;
            }
        }

        let mut st = state_arc.lock().unwrap();
        st.status = "ready".to_string();
        st.progress = 100.0;
        st.downloaded_path = Some(dest_path.to_string_lossy().to_string());
    });

    Ok(true)
}

pub fn get_download_status(app_state: State<'_, AppState>) -> DownloadStatus {
    let state = app_state.updater_state.lock().unwrap();
    DownloadStatus {
        status: state.status.clone(),
        progress: state.progress,
    }
}

pub fn install_update(app_state: State<'_, AppState>) -> Result<bool, String> {
    let path = {
        let state = app_state.updater_state.lock().unwrap();
        state.downloaded_path.clone()
    };

    let path = match path {
        Some(p) => p,
        None => return Err("Update not downloaded yet".to_string()),
    };

    #[cfg(target_os = "windows")]
    {
        // Directly launch the NSIS installer exe
        let _ = std::process::Command::new(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
        std::process::exit(0);
    }

    #[cfg(target_os = "macos")]
    {
        // Shell script: mount DMG → copy .app → detach → relaunch
        let script = format!(
            r#"
sleep 1
MOUNT_DIR=$(hdiutil attach "{dmg}" -nobrowse -noverify | grep '/Volumes/' | awk -F'\t' '{{print $NF}}')
if [ -z "$MOUNT_DIR" ]; then exit 1; fi
APP_PATH=$(find "$MOUNT_DIR" -maxdepth 1 -name '*.app' | head -1)
if [ -z "$APP_PATH" ]; then hdiutil detach "$MOUNT_DIR" -quiet; exit 1; fi
APP_NAME=$(basename "$APP_PATH")
rm -rf "/Applications/$APP_NAME"
cp -R "$APP_PATH" /Applications/
hdiutil detach "$MOUNT_DIR" -quiet
open "/Applications/$APP_NAME"
"#,
            dmg = path
        );
        let _ = std::process::Command::new("sh")
            .args(&["-c", &script])
            .spawn()
            .map_err(|e| e.to_string())?;
        std::process::exit(0);
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        std::process::exit(0);
    }
}

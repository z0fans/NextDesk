use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

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

pub async fn check_for_update() -> UpdateInfo {
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

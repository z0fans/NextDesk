use reqwest::Client;
use serde::{Deserialize, Serialize};
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

#[derive(Deserialize)]
struct Release {
    tag_name: String,
}

pub async fn check_for_update() -> UpdateInfo {
    check_for_update_at(&format!(
        "https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
    ))
    .await
}

async fn check_for_update_at(url: &str) -> UpdateInfo {
    let result = async {
        let client = Client::builder().timeout(Duration::from_secs(10)).build()?;
        client
            .get(url)
            .header("User-Agent", "NextDesk")
            .send()
            .await?
            .error_for_status()?
            .json::<Release>()
            .await
    }
    .await;
    match result {
        Ok(release) if !release.tag_name.trim().is_empty() => {
            let latest = release.tag_name.trim_start_matches('v').to_string();
            UpdateInfo {
                has_update: compare_versions(&latest, CURRENT_VERSION) > 0,
                current_version: CURRENT_VERSION.into(),
                latest_version: Some(latest),
                download_url: None,
                error: None,
            }
        }
        result => UpdateInfo {
            has_update: false,
            current_version: CURRENT_VERSION.into(),
            latest_version: None,
            download_url: None,
            error: Some(match result {
                Err(error) => error.without_url().to_string(),
                Ok(_) => "Release response has no version".to_string(),
            }),
        },
    }
}

fn compare_versions(v1: &str, v2: &str) -> i32 {
    let parse = |v: &str| -> Vec<i32> { v.split('.').filter_map(|s| s.parse().ok()).collect() };
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

#[cfg(test)]
mod tests {
    use super::check_for_update_at;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    #[tokio::test]
    async fn failed_update_checks_are_never_reported_as_up_to_date() {
        for (status, body, failed) in [
            (403, r#"{"message":"rate limit"}"#, true),
            (200, r#"{"message":"missing version"}"#, true),
            (200, r#"{"tag_name":""}"#, true),
            (200, r#"{"tag_name":"v999.0.0"}"#, false),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut stream = BufReader::new(stream);
                loop {
                    let mut line = String::new();
                    if stream.read_line(&mut line).await.unwrap() == 0 || line == "\r\n" {
                        break;
                    }
                }
                stream.get_mut().write_all(format!(
                    "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()
                ).as_bytes()).await.unwrap();
            });
            let result = check_for_update_at(&url).await;
            server.await.unwrap();
            assert_eq!(result.error.is_some(), failed);
            assert_eq!(result.has_update, !failed);
            assert_eq!(result.latest_version.is_none(), failed);
        }
    }
}

use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CloudAccount {
    pub user_id: Option<i64>,
    pub display: Option<String>,
    pub available: bool,
    pub available_until: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CloudAccountStatus {
    pub enabled: bool,
    pub authorized: bool,
    pub account_available: bool,
    pub account_available_until: Option<String>,
    pub device_expires_at: Option<String>,
    pub display: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudAuthorizationStart {
    pub authorize_url: String,
    pub state: String,
}

#[derive(Debug, Deserialize)]
struct DiscoveryData {
    authorization_base_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DiscoveryResponse {
    data: DiscoveryData,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudEndpoint {
    pub host: String,
    pub port: u16,
    pub protocols: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudBindingResponse {
    pub binding_id: String,
    pub endpoint: CloudEndpoint,
    pub expires_at: String,
    pub renew_after_seconds: u64,
    pub reconnect_grace_seconds: u64,
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudPrepareCandidate {
    pub binding_id: String,
    pub agent_id: String,
    pub region: Option<String>,
    pub endpoint: CloudEndpoint,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CloudPrepareMode {
    Candidates,
    Reused,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudPrepareResponse {
    pub prepare_id: Option<String>,
    pub mode: CloudPrepareMode,
    #[serde(default)]
    pub probe_timeout_ms: Option<u64>,
    #[serde(default)]
    pub commit_deadline_at: Option<String>,
    #[serde(default)]
    pub candidates: Vec<CloudPrepareCandidate>,
    #[serde(default)]
    pub binding: Option<CloudBindingResponse>,
}

#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub device_id: String,
    pub device_token: String,
    pub device_expires_at: Option<String>,
    pub account: CloudAccount,
}

#[derive(Debug, Deserialize)]
struct MeData {
    device_expires_at: Option<String>,
    account: CloudAccount,
}

#[derive(Debug, Deserialize)]
struct MeResponse {
    data: MeData,
}

#[derive(Debug, Deserialize)]
struct GatewayErrorResponse {
    message: Option<String>,
    error: Option<String>,
}

fn token_rejection(status: reqwest::StatusCode, body: &str) -> (String, String) {
    let server_code = serde_json::from_str::<GatewayErrorResponse>(body)
        .ok()
        .and_then(|response| response.message.or(response.error))
        .unwrap_or_default();
    let client_error = match server_code.as_str() {
        "too_many_devices" => "cloud_auth_too_many_devices",
        "invalid_code" | "invalid_pkce" => "cloud_auth_invalid_or_expired",
        _ if status == reqwest::StatusCode::TOO_MANY_REQUESTS => "cloud_auth_rate_limited",
        _ => "cloud_auth_token_rejected",
    };

    (client_error.to_string(), server_code)
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .no_proxy()
        .build()
        .map_err(|e| format!("cloud client build failed: {e}"))
}

fn base(panel_url: &str) -> String {
    panel_url.trim_end_matches('/').to_string()
}

async fn discover_url_from_path(panel_url: &str, path: &str) -> Result<Option<String>, String> {
    let response = client()?
        .get(format!("{}{}", base(panel_url), path))
        .send()
        .await
        .map_err(|e| format!("cloud discovery request failed: {e}"))?;

    if response.status().as_u16() == 404 {
        return Ok(None);
    }

    let body = response
        .error_for_status()
        .map_err(|e| format!("cloud discovery rejected: {e}"))?
        .json::<DiscoveryResponse>()
        .await
        .map_err(|e| format!("cloud discovery parse failed: {e}"))?;

    Ok(body
        .data
        .authorization_base_url
        .map(|url| url.trim_end_matches('/').to_string())
        .filter(|url| !url.is_empty()))
}

pub async fn discover_authorization_base_url(panel_url: &str) -> Result<Option<String>, String> {
    discover_url_from_path(panel_url, "/api/v1/connect/discovery").await
}

pub async fn exchange_code(
    panel_url: &str,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
    device_name: &str,
    platform: &str,
    app_version: &str,
) -> Result<TokenResponse, String> {
    let response = client()?
        .post(format!("{}/api/v1/connect/token", base(panel_url)))
        .json(&serde_json::json!({
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": verifier,
            "redirect_uri": redirect_uri,
            "device": {
                "name": device_name,
                "platform": platform,
                "app_version": app_version
            }
        }))
        .send()
        .await
        .map_err(|e| format!("cloud token request failed: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let (client_error, server_code) = token_rejection(status, &body);
        log::warn!(
            "[cloud-auth] token exchange rejected status={} server_code={}",
            status.as_u16(),
            if server_code.is_empty() {
                "unknown"
            } else {
                &server_code
            }
        );
        return Err(format!("{client_error} (HTTP {})", status.as_u16()));
    }

    response
        .json::<TokenResponse>()
        .await
        .map_err(|e| format!("cloud token parse failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::token_rejection;
    use reqwest::StatusCode;

    #[test]
    fn token_rejection_identifies_device_limit() {
        let (client_error, server_code) = token_rejection(
            StatusCode::TOO_MANY_REQUESTS,
            r#"{"message":"too_many_devices"}"#,
        );

        assert_eq!(client_error, "cloud_auth_too_many_devices");
        assert_eq!(server_code, "too_many_devices");
    }

    #[test]
    fn token_rejection_distinguishes_generic_rate_limit() {
        let (client_error, server_code) =
            token_rejection(StatusCode::TOO_MANY_REQUESTS, "rate limited upstream");

        assert_eq!(client_error, "cloud_auth_rate_limited");
        assert!(server_code.is_empty());
    }
}

pub async fn me(
    panel_url: &str,
    device_id: &str,
    token: &str,
) -> Result<CloudAccountStatus, String> {
    let body = client()?
        .get(format!("{}/api/v1/connect/me", base(panel_url)))
        .bearer_auth(token)
        .header("X-Device-Id", device_id)
        .send()
        .await
        .map_err(|e| format!("cloud status request failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("cloud status rejected: {e}"))?
        .json::<MeResponse>()
        .await
        .map_err(|e| format!("cloud status parse failed: {e}"))?;

    Ok(CloudAccountStatus {
        enabled: true,
        authorized: true,
        account_available: body.data.account.available,
        account_available_until: body.data.account.available_until,
        device_expires_at: body.data.device_expires_at,
        display: body.data.account.display,
        reason: body.data.account.reason,
    })
}

pub async fn bind(
    panel_url: &str,
    device_id: &str,
    token: &str,
    host: &str,
    port: u16,
    preferred_region: &str,
) -> Result<CloudBindingResponse, String> {
    client()?
        .post(format!("{}/api/v1/connect/bind", base(panel_url)))
        .bearer_auth(token)
        .header("X-Device-Id", device_id)
        .json(&serde_json::json!({
            "target_host": host,
            "target_port": port,
            "preferred_region": preferred_region,
            "client": {
                "platform": std::env::consts::OS,
                "app_version": env!("CARGO_PKG_VERSION")
            }
        }))
        .send()
        .await
        .map_err(|e| format!("cloud bind request failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("cloud bind rejected: {e}"))?
        .json::<CloudBindingResponse>()
        .await
        .map_err(|e| format!("cloud bind parse failed: {e}"))
}

pub async fn prepare(
    panel_url: &str,
    device_id: &str,
    token: &str,
    host: &str,
    port: u16,
    preferred_region: &str,
    reuse_existing: bool,
    session_id: Option<&str>,
) -> Result<CloudPrepareResponse, String> {
    client()?
        .post(format!("{}/api/v1/connect/prepare", base(panel_url)))
        .bearer_auth(token)
        .header("X-Device-Id", device_id)
        .json(&serde_json::json!({
            "target_host": host,
            "target_port": port,
            "preferred_region": preferred_region,
            "reuse_existing": reuse_existing,
            "session_id": session_id,
            "client": {
                "platform": std::env::consts::OS,
                "app_version": env!("CARGO_PKG_VERSION")
            }
        }))
        .send()
        .await
        .map_err(|e| format!("cloud prepare request failed: {e}"))?
        .error_for_status()
        .map_err(|e| {
            if e.status().map(|status| status.as_u16()) == Some(404) {
                "cloud_prepare_unsupported".to_string()
            } else {
                format!("cloud prepare rejected: {e}")
            }
        })?
        .json::<CloudPrepareResponse>()
        .await
        .map_err(|e| format!("cloud prepare parse failed: {e}"))
}

pub async fn commit(
    panel_url: &str,
    device_id: &str,
    token: &str,
    prepare_id: &str,
    winner_binding_id: &str,
    results: &[crate::cloud_probe::CloudProbeResult],
) -> Result<CloudBindingResponse, String> {
    client()?
        .post(format!("{}/api/v1/connect/commit", base(panel_url)))
        .bearer_auth(token)
        .header("X-Device-Id", device_id)
        .json(&serde_json::json!({
            "prepare_id": prepare_id,
            "winner_binding_id": winner_binding_id,
            "results": results
        }))
        .send()
        .await
        .map_err(|e| format!("cloud commit request failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("cloud commit rejected: {e}"))?
        .json::<CloudBindingResponse>()
        .await
        .map_err(|e| format!("cloud commit parse failed: {e}"))
}

pub async fn abort(panel_url: &str, device_id: &str, token: &str, prepare_id: &str, reason: &str) {
    let Ok(client) = client() else {
        return;
    };
    let _ = client
        .post(format!("{}/api/v1/connect/abort", base(panel_url)))
        .bearer_auth(token)
        .header("X-Device-Id", device_id)
        .json(&serde_json::json!({
            "prepare_id": prepare_id,
            "reason": reason
        }))
        .send()
        .await;
}

pub async fn renew(
    panel_url: &str,
    device_id: &str,
    token: &str,
    binding_id: &str,
) -> Result<CloudBindingResponse, String> {
    client()?
        .post(format!("{}/api/v1/connect/renew", base(panel_url)))
        .bearer_auth(token)
        .header("X-Device-Id", device_id)
        .json(&serde_json::json!({ "binding_id": binding_id }))
        .send()
        .await
        .map_err(|e| format!("cloud renew request failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("cloud renew rejected: {e}"))?
        .json::<CloudBindingResponse>()
        .await
        .map_err(|e| format!("cloud renew parse failed: {e}"))
}

pub async fn close(panel_url: &str, device_id: &str, token: &str, binding_id: &str) {
    let Ok(client) = client() else {
        return;
    };
    let _ = client
        .post(format!("{}/api/v1/connect/close", base(panel_url)))
        .bearer_auth(token)
        .header("X-Device-Id", device_id)
        .json(&serde_json::json!({ "binding_id": binding_id }))
        .send()
        .await;
}

pub async fn revoke(panel_url: &str, device_id: &str, token: &str) -> Result<(), String> {
    client()?
        .post(format!("{}/api/v1/connect/revoke", base(panel_url)))
        .bearer_auth(token)
        .header("X-Device-Id", device_id)
        .send()
        .await
        .map_err(|e| format!("cloud revoke request failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("cloud revoke rejected: {e}"))?;
    Ok(())
}

//! Cloud Mode: fetch relay endpoints from Dashboard API
//! and auto-create routes on demand.

use crate::state::RelayEndpoint;
use serde::Deserialize;

#[derive(Deserialize)]
struct EndpointsResponse {
    success: bool,
    endpoints: Option<Vec<RelayEndpoint>>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct AutoCreateEndpoint {
    host: String,
    port: i64,
    server_name: String,
}

#[derive(Deserialize)]
struct AutoCreateResponse {
    success: bool,
    created: Option<bool>,
    endpoint: Option<AutoCreateEndpoint>,
    error: Option<String>,
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| format!("http client: {e}"))
}

/// Fetch all relay endpoints from Dashboard.
pub async fn fetch_endpoints(
    dashboard_url: &str,
    api_key: &str,
) -> Result<Vec<RelayEndpoint>, String> {
    if dashboard_url.is_empty() || api_key.is_empty() {
        return Err("Dashboard URL and API Key required".into());
    }
    let url = format!(
        "{}/api/relay/endpoints",
        dashboard_url.trim_end_matches('/')
    );
    let resp = build_client()?
        .get(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .send()
        .await
        .map_err(|e| format!("request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body: EndpointsResponse = resp.json().await.map_err(|e| format!("parse: {e}"))?;
    if !body.success {
        return Err(body.error.unwrap_or("Unknown".into()));
    }
    Ok(body.endpoints.unwrap_or_default())
}

/// Request Dashboard to auto-create a relay route.
/// Returns (relay_host, relay_port).
pub async fn auto_create_route(
    dashboard_url: &str,
    api_key: &str,
    target_host: &str,
    target_port: u16,
) -> Result<(String, u16), String> {
    if dashboard_url.is_empty() || api_key.is_empty() {
        return Err("Dashboard URL and API Key required".into());
    }
    let url = format!(
        "{}/api/relay/routes/auto",
        dashboard_url.trim_end_matches('/')
    );
    let body = serde_json::json!({
        "target_host": target_host,
        "target_port": target_port,
        "target_name": format!("{}:{}", target_host, target_port),
    });
    let resp = build_client()?
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("request: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {text}"));
    }
    let data: AutoCreateResponse = resp.json().await.map_err(|e| format!("parse: {e}"))?;
    if !data.success {
        return Err(data.error.unwrap_or("Unknown".into()));
    }
    let ep = data.endpoint.ok_or("No endpoint in response")?;
    log::info!(
        "[relay] {} route: {}:{} via {}",
        if data.created.unwrap_or(false) {
            "Created"
        } else {
            "Reused"
        },
        ep.host,
        ep.port,
        ep.server_name
    );
    Ok((ep.host, ep.port as u16))
}

/// Find cached relay endpoint matching an RDP destination.
pub fn find_relay_for_dest(
    endpoints: &[RelayEndpoint],
    dest_host: &str,
    dest_port: u16,
) -> Option<(String, u16)> {
    let dest_key = format!("{}:{}", dest_host, dest_port);
    endpoints
        .iter()
        .find(|e| e.name == dest_key || e.name.contains(dest_host))
        .map(|e| (e.host.clone(), e.port as u16))
}

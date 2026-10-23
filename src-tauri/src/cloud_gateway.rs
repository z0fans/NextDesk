use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
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

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct CloudCarrierCapabilities {
    #[serde(default)]
    pub ingress: Vec<String>,
    #[serde(default)]
    pub egress: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct CloudAsnCapabilities {
    #[serde(default)]
    pub ingress: Vec<u64>,
    #[serde(default)]
    pub egress: Vec<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct CloudAgentDiagnostics {
    #[serde(default)]
    pub agent_ref: String,
    #[serde(default)]
    pub country_code: String,
    #[serde(default)]
    pub subregion: String,
    #[serde(default)]
    pub routing_group: String,
    #[serde(default)]
    pub line_tags: Vec<String>,
    #[serde(default)]
    pub carrier_capabilities: CloudCarrierCapabilities,
    #[serde(default)]
    pub asn_capabilities: CloudAsnCapabilities,
    #[serde(default)]
    pub supported_protocols: Vec<String>,
    #[serde(default)]
    pub capacity: u32,
    #[serde(default)]
    pub failure_domain: String,
    #[serde(default)]
    pub software_version: String,
    #[serde(default)]
    pub declared_capabilities: serde_json::Value,
    #[serde(default)]
    pub recommendation_rank: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct CloudClientNetworkDiagnostics {
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub country_code: String,
    #[serde(default)]
    pub province: String,
    #[serde(default)]
    pub asn: Option<u64>,
    #[serde(default)]
    pub carrier: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub classification_source: String,
    #[serde(default)]
    pub network_scope_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct CloudNetworkContextResponse {
    pub data: CloudClientNetworkDiagnostics,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct CloudShadowCandidateDiagnostics {
    #[serde(flatten)]
    pub agent: CloudAgentDiagnostics,
    #[serde(default)]
    pub shadow_score: Option<f64>,
    #[serde(default)]
    pub affinity_reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct CloudShadowInputSummary {
    #[serde(default)]
    pub country_code: String,
    #[serde(default)]
    pub province: String,
    #[serde(default)]
    pub asn: Option<u64>,
    #[serde(default)]
    pub carrier: String,
    #[serde(default)]
    pub requested_protocols: Vec<String>,
    #[serde(default)]
    pub target_group: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct CloudShadowComparison {
    #[serde(default)]
    pub same_order: bool,
    #[serde(default)]
    pub reordered: bool,
    #[serde(default)]
    pub entered: Vec<String>,
    #[serde(default)]
    pub exited: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct CloudShadowEvaluation {
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub policy_revision: String,
    #[serde(default)]
    pub production_policy_revision: String,
    #[serde(default)]
    pub input_summary: CloudShadowInputSummary,
    #[serde(default)]
    pub current_candidates: Vec<CloudShadowCandidateDiagnostics>,
    #[serde(default)]
    pub shadow_candidates: Vec<CloudShadowCandidateDiagnostics>,
    #[serde(default)]
    pub excluded_summary: BTreeMap<String, u32>,
    #[serde(default)]
    pub comparison: CloudShadowComparison,
    #[serde(default)]
    pub rollout: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct CloudFastPathDiagnostics {
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub eligible: bool,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub confidence: f64,
    #[serde(default)]
    pub sample_count: u32,
    #[serde(default)]
    pub success_ewma: Option<f64>,
    #[serde(default)]
    pub consecutive_failures: u32,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub scope: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct CloudRouteDiagnostics {
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub agent: CloudAgentDiagnostics,
    #[serde(default)]
    pub client_network: CloudClientNetworkDiagnostics,
    #[serde(default)]
    pub shadow_evaluation: Option<CloudShadowEvaluation>,
    #[serde(default)]
    pub agent_target_probe: Option<serde_json::Value>,
    #[serde(default)]
    pub quality_shadow: Option<serde_json::Value>,
    #[serde(default)]
    pub fast_path: Option<CloudFastPathDiagnostics>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct CloudRacePolicy {
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub second_candidate_delay_ms: u64,
    #[serde(default)]
    pub history_fast_path_budget_ms: u64,
    #[serde(default)]
    pub cold_start_budget_ms: u64,
    #[serde(default)]
    pub max_active_cloud_validations: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct CloudDegradationPolicy {
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub improvement_threshold_percent: f64,
    #[serde(default)]
    pub check_interval_ms: u64,
    #[serde(default)]
    pub required_observations: u32,
    #[serde(default)]
    pub recovery_observations: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudBindingResponse {
    pub binding_id: String,
    pub endpoint: CloudEndpoint,
    pub expires_at: String,
    pub renew_after_seconds: u64,
    pub reconnect_grace_seconds: u64,
    #[serde(default)]
    pub policy_revision: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub route_diagnostics: Option<CloudRouteDiagnostics>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudPrepareCandidate {
    pub binding_id: String,
    pub endpoint: CloudEndpoint,
    pub expires_at: String,
    #[serde(default)]
    pub route_diagnostics: Option<CloudRouteDiagnostics>,
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
    pub policy_revision: Option<String>,
    #[serde(default)]
    pub policy_manifest: Option<serde_json::Value>,
    #[serde(default)]
    pub probe_timeout_ms: Option<u64>,
    #[serde(default)]
    pub race_policy: Option<CloudRacePolicy>,
    #[serde(default)]
    pub degradation_policy: Option<CloudDegradationPolicy>,
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

pub const AUTHORIZATION_EXPIRED: &str = "cloud_authorization_expired";
pub const RATE_LIMITED: &str = "cloud_rate_limited";
pub const BINDING_GONE: &str = "cloud_binding_gone";

// Interpret HTTP status before errors cross the gateway seam as command strings.
fn rejection(operation: &str, error: reqwest::Error) -> String {
    match error.status().map(|status| status.as_u16()) {
        Some(401 | 403) => AUTHORIZATION_EXPIRED.to_string(),
        Some(429) => RATE_LIMITED.to_string(),
        Some(410) if operation == "renew" => BINDING_GONE.to_string(),
        Some(404) if operation == "prepare" => "cloud_prepare_unsupported".to_string(),
        _ => format!("cloud {operation} rejected: {}", error.without_url()),
    }
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
    installation_id: &str,
) -> Result<TokenResponse, String> {
    let response = client()?
        .post(format!("{}/api/v1/connect/token", base(panel_url)))
        .json(&token_request_body(
            code,
            verifier,
            redirect_uri,
            device_name,
            platform,
            app_version,
            installation_id,
        ))
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

fn token_request_body(
    code: &str,
    verifier: &str,
    redirect_uri: &str,
    device_name: &str,
    platform: &str,
    app_version: &str,
    installation_id: &str,
) -> serde_json::Value {
    serde_json::json!({
        "grant_type": "authorization_code",
        "code": code,
        "code_verifier": verifier,
        "redirect_uri": redirect_uri,
        "device": {
            "name": device_name,
            "platform": platform,
            "app_version": app_version,
            "installation_id": installation_id
        }
    })
}

#[cfg(test)]
mod tests {
    use super::{
        abort_payload, commit_payload, prepare_request_body, token_rejection, token_request_body,
        CloudPrepareResponse,
    };
    use crate::cloud_probe::CloudProbeResult;
    use crate::connection_resolver::ServiceKind;
    use reqwest::StatusCode;

    async fn gateway_with_status(status: u16) -> String {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            loop {
                let mut line = String::new();
                if stream.read_line(&mut line).await.unwrap() == 0 || line == "\r\n" {
                    break;
                }
            }
            stream
                .get_mut()
                .write_all(
                    format!(
                "HTTP/1.1 {status} Test\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
            )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        // Digits in a URL must never determine authorization or retry policy.
        format!("http://{address}/401/403/429/410")
    }

    #[tokio::test]
    async fn gateway_status_is_classified_before_crossing_the_command_seam() {
        for (status, expected) in [
            (401, super::AUTHORIZATION_EXPIRED),
            (403, super::AUTHORIZATION_EXPIRED),
            (429, super::RATE_LIMITED),
        ] {
            let url = gateway_with_status(status).await;
            assert_eq!(
                super::me(&url, "test-device", "test-token")
                    .await
                    .unwrap_err(),
                expected
            );
        }
        let url = gateway_with_status(500).await;
        let error = super::me(&url, "test-device", "test-token")
            .await
            .unwrap_err();
        assert!(error.starts_with("cloud status rejected:"));
        assert!(!error.contains(&url));
        assert_ne!(error, super::AUTHORIZATION_EXPIRED);
        assert_ne!(error, super::RATE_LIMITED);
    }

    #[tokio::test]
    async fn gateway_route_errors_remain_operation_specific() {
        let url = gateway_with_status(404).await;
        assert_eq!(
            super::prepare(
                &url,
                "device",
                "token",
                "target",
                22,
                "",
                false,
                None,
                ServiceKind::Ssh
            )
            .await
            .unwrap_err(),
            "cloud_prepare_unsupported"
        );
        let url = gateway_with_status(410).await;
        assert_eq!(
            super::renew(&url, "device", "token", "binding")
                .await
                .unwrap_err(),
            super::BINDING_GONE
        );
        let url = gateway_with_status(410).await;
        assert_ne!(
            super::me(&url, "device", "token").await.unwrap_err(),
            super::BINDING_GONE
        );
    }

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

    #[test]
    fn token_request_includes_stable_installation_id() {
        let body = token_request_body(
            "code-1",
            "verifier-1",
            "nextdesk://auth/callback",
            "NextDesk",
            "windows",
            "1.0.126",
            "inst_1234567890abcdef",
        );

        assert_eq!(body["device"]["installation_id"], "inst_1234567890abcdef");
    }

    #[test]
    fn ssh_prepare_requests_a_tcp_only_service_binding() {
        let body = prepare_request_body(
            "server.example.com",
            22,
            "auto",
            true,
            Some("ssh-tab-a"),
            ServiceKind::Ssh,
        );

        assert_eq!(body["service_kind"], "ssh");
        assert_eq!(body["requested_protocols"], serde_json::json!(["tcp"]));
        assert_eq!(body["target_host"], "server.example.com");
        assert_eq!(body["target_port"], 22);
    }

    #[test]
    fn abort_payload_keeps_probe_results_for_diagnostics() {
        let payload = abort_payload(
            "prep_test",
            "all_candidates_failed",
            &[CloudProbeResult {
                binding_id: "bnd_test".to_string(),
                service_kind: ServiceKind::Rdp,
                validation_mode: "cold_start".to_string(),
                ok: false,
                tcp_connect_ms: Some(701),
                protocol_handshake_ms: None,
                x224_ms: None,
                tls_ms: None,
                total_ms: 2500,
                jitter_ms: 0,
                error: Some("probe_timeout".to_string()),
                score_ms: 2500,
                winner_eligible: false,
            }],
            true,
        );

        assert_eq!(payload["prepare_id"], "prep_test");
        assert_eq!(payload["reason"], "all_candidates_failed");
        assert_eq!(payload["results"][0]["binding_id"], "bnd_test");
        assert_eq!(payload["results"][0]["error"], "probe_timeout");
        assert_eq!(payload["results"][0]["validation_mode"], "cold_start");
        assert!(payload["results"][0].get("score_ms").is_none());
        assert!(payload["results"][0].get("winner_eligible").is_none());
    }

    #[test]
    fn quality_feedback_opt_out_keeps_route_control_but_omits_probe_samples() {
        let result = CloudProbeResult {
            binding_id: "bnd_private".to_string(),
            service_kind: ServiceKind::Ssh,
            validation_mode: "cold_start".to_string(),
            ok: true,
            tcp_connect_ms: Some(23),
            protocol_handshake_ms: Some(12),
            x224_ms: None,
            tls_ms: None,
            total_ms: 35,
            jitter_ms: 2,
            error: None,
            score_ms: 39,
            winner_eligible: true,
        };
        let commit = commit_payload("prep_private", "bnd_private", &[result.clone()], false);
        let abort = abort_payload("prep_private", "client_abort", &[result], false);

        assert_eq!(commit["winner_binding_id"], "bnd_private");
        assert_eq!(commit["results"], serde_json::json!([]));
        assert_eq!(commit["quality_feedback_enabled"], false);
        assert_eq!(abort["results"], serde_json::json!([]));
        assert_eq!(abort["quality_feedback_enabled"], false);
    }

    #[test]
    fn prepare_candidate_accepts_only_sanitized_route_diagnostics() {
        let prepared: CloudPrepareResponse = serde_json::from_value(serde_json::json!({
            "prepare_id": "prep_test",
            "mode": "candidates",
            "policy_manifest": {
                "schema_version": 1,
                "revision": "carrier-diversity-shadow-v1",
                "production_revision": "routing-v1",
                "valid": true
            },
            "race_policy": {
                "schema_version": 1,
                "second_candidate_delay_ms": 150,
                "history_fast_path_budget_ms": 500,
                "cold_start_budget_ms": 1500,
                "max_active_cloud_validations": 2
            },
            "degradation_policy": {
                "schema_version": 1,
                "improvement_threshold_percent": 20,
                "check_interval_ms": 15000,
                "required_observations": 2,
                "recovery_observations": 2
            },
            "candidates": [{
                "binding_id": "bnd_test",
                "agent_id": "agt_should_stay_private",
                "region": "HKG",
                "endpoint": {
                    "host": "relay.example.com",
                    "port": 443,
                    "protocols": ["tcp"]
                },
                "expires_at": "2026-07-23T00:00:00Z",
                "route_diagnostics": {
                    "schema_version": 1,
                    "agent": {
                        "agent_ref": "agent_opaque",
                        "country_code": "JP",
                        "subregion": "tokyo",
                        "failure_domain": "jp-tokyo-a",
                        "line_tags": ["cn-optimized"],
                        "supported_protocols": ["tcp", "udp"],
                        "capacity": 100
                    },
                    "client_network": {
                        "schema_version": 1,
                        "country_code": "CN",
                        "province": "Guangdong",
                        "asn": 4134,
                        "carrier": "telecom"
                    },
                    "shadow_evaluation": {
                        "schema_version": 1,
                        "mode": "observe_only",
                        "policy_revision": "carrier-diversity-shadow-v1",
                        "production_policy_revision": "routing-v1",
                        "input_summary": {
                            "country_code": "CN",
                            "province": "Guangdong",
                            "asn": 4134,
                            "carrier": "telecom",
                            "requested_protocols": ["tcp"],
                            "target_group": "apac"
                        },
                        "current_candidates": [{
                            "agent_ref": "agent_current",
                            "country_code": "JP",
                            "failure_domain": "jp-tokyo-a",
                            "recommendation_rank": 1
                        }],
                        "shadow_candidates": [{
                            "agent_ref": "agent_shadow",
                            "country_code": "MY",
                            "failure_domain": "my-kuala-lumpur-a",
                            "recommendation_rank": 1,
                            "shadow_score": -0.65,
                            "affinity_reasons": ["carrier_match"]
                        }],
                        "comparison": {
                            "same_order": false,
                            "entered": ["agent_shadow"],
                            "exited": ["agent_current"]
                        },
                        "rollout": {
                            "mode": "canary_control",
                            "service_kind": "ssh",
                            "rollout_percentage": 25,
                            "candidate_applied": false
                        }
                    },
                    "quality_shadow": {
                        "schema_version": 1,
                        "mode": "shadow",
                        "production_winner_binding_id": "bnd_test",
                        "shadow_winner_binding_id": "bnd_alternative",
                        "same_winner": false,
                        "score_delta": 18.5
                    },
                    "fast_path": {
                        "schema_version": 1,
                        "eligible": true,
                        "reason": "trusted",
                        "confidence": 1.0,
                        "sample_count": 8,
                        "success_ewma": 0.98,
                        "consecutive_failures": 0,
                        "expires_at": "2026-07-23T00:05:00Z",
                        "scope": "network_exact"
                    }
                }
            }]
        }))
        .expect("prepare response should accept additive diagnostics");

        let public_candidate = serde_json::to_value(&prepared.candidates[0]).unwrap();
        assert_eq!(public_candidate["binding_id"], "bnd_test");
        assert!(public_candidate.get("agent_id").is_none());
        assert!(public_candidate.get("region").is_none());
        assert_eq!(
            public_candidate["route_diagnostics"]["agent"]["agent_ref"],
            "agent_opaque"
        );
        assert_eq!(
            public_candidate["route_diagnostics"]["client_network"]["carrier"],
            "telecom"
        );
        assert_eq!(
            public_candidate["route_diagnostics"]["agent"]["capacity"],
            100
        );
        assert_eq!(
            public_candidate["route_diagnostics"]["shadow_evaluation"]["mode"],
            "observe_only"
        );
        assert_eq!(
            public_candidate["route_diagnostics"]["shadow_evaluation"]["shadow_candidates"][0]
                ["agent_ref"],
            "agent_shadow"
        );
        assert_eq!(
            public_candidate["route_diagnostics"]["shadow_evaluation"]["rollout"]
                ["rollout_percentage"],
            25
        );
        assert_eq!(
            public_candidate["route_diagnostics"]["quality_shadow"]["shadow_winner_binding_id"],
            "bnd_alternative"
        );
        assert_eq!(
            public_candidate["route_diagnostics"]["fast_path"]["eligible"],
            true
        );
        assert_eq!(
            prepared
                .race_policy
                .as_ref()
                .expect("race policy should be available")
                .second_candidate_delay_ms,
            150
        );
        assert_eq!(
            prepared
                .degradation_policy
                .as_ref()
                .expect("degradation policy should be available")
                .check_interval_ms,
            15_000
        );
        assert_eq!(
            prepared.policy_manifest.as_ref().unwrap()["revision"],
            "carrier-diversity-shadow-v1"
        );
        assert!(!public_candidate
            .to_string()
            .contains("agt_should_stay_private"));
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
        .map_err(|e| rejection("status", e))?
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
        .map_err(|e| rejection("bind", e))?
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
    service_kind: crate::connection_resolver::ServiceKind,
) -> Result<CloudPrepareResponse, String> {
    client()?
        .post(format!("{}/api/v1/connect/prepare", base(panel_url)))
        .bearer_auth(token)
        .header("X-Device-Id", device_id)
        .json(&prepare_request_body(
            host,
            port,
            preferred_region,
            reuse_existing,
            session_id,
            service_kind,
        ))
        .send()
        .await
        .map_err(|e| format!("cloud prepare request failed: {e}"))?
        .error_for_status()
        .map_err(|e| rejection("prepare", e))?
        .json::<CloudPrepareResponse>()
        .await
        .map_err(|e| format!("cloud prepare parse failed: {e}"))
}

pub async fn network_context(
    panel_url: &str,
    device_id: &str,
    token: &str,
) -> Result<CloudClientNetworkDiagnostics, String> {
    client()?
        .get(format!(
            "{}/api/v1/connect/network-context",
            base(panel_url)
        ))
        .bearer_auth(token)
        .header("X-Device-Id", device_id)
        .send()
        .await
        .map_err(|e| format!("cloud network context request failed: {e}"))?
        .error_for_status()
        .map_err(|e| rejection("network context", e))?
        .json::<CloudNetworkContextResponse>()
        .await
        .map(|response| response.data)
        .map_err(|e| format!("cloud network context parse failed: {e}"))
}

fn prepare_request_body(
    host: &str,
    port: u16,
    preferred_region: &str,
    reuse_existing: bool,
    session_id: Option<&str>,
    service_kind: crate::connection_resolver::ServiceKind,
) -> serde_json::Value {
    let requested_protocols = match service_kind {
        crate::connection_resolver::ServiceKind::Rdp => vec!["tcp", "udp"],
        crate::connection_resolver::ServiceKind::Ssh => vec!["tcp"],
    };
    serde_json::json!({
        "service_kind": service_kind,
        "target_host": host,
        "target_port": port,
        "preferred_region": preferred_region,
        "requested_protocols": requested_protocols,
        "reuse_existing": reuse_existing,
        "session_id": session_id,
        "client": {
            "platform": std::env::consts::OS,
            "app_version": env!("CARGO_PKG_VERSION")
        }
    })
}

pub async fn commit(
    panel_url: &str,
    device_id: &str,
    token: &str,
    prepare_id: &str,
    winner_binding_id: &str,
    results: &[crate::cloud_probe::CloudProbeResult],
    include_quality_feedback: bool,
) -> Result<CloudBindingResponse, String> {
    client()?
        .post(format!("{}/api/v1/connect/commit", base(panel_url)))
        .bearer_auth(token)
        .header("X-Device-Id", device_id)
        .json(&commit_payload(
            prepare_id,
            winner_binding_id,
            results,
            include_quality_feedback,
        ))
        .send()
        .await
        .map_err(|e| format!("cloud commit request failed: {e}"))?
        .error_for_status()
        .map_err(|e| rejection("commit", e))?
        .json::<CloudBindingResponse>()
        .await
        .map_err(|e| format!("cloud commit parse failed: {e}"))
}

fn commit_payload(
    prepare_id: &str,
    winner_binding_id: &str,
    results: &[crate::cloud_probe::CloudProbeResult],
    include_quality_feedback: bool,
) -> serde_json::Value {
    serde_json::json!({
        "prepare_id": prepare_id,
        "winner_binding_id": winner_binding_id,
        "results": if include_quality_feedback {
            serde_json::to_value(results).unwrap_or_else(|_| serde_json::json!([]))
        } else {
            serde_json::json!([])
        },
        "quality_feedback_enabled": include_quality_feedback,
    })
}

fn abort_payload(
    prepare_id: &str,
    reason: &str,
    results: &[crate::cloud_probe::CloudProbeResult],
    include_quality_feedback: bool,
) -> serde_json::Value {
    serde_json::json!({
        "prepare_id": prepare_id,
        "reason": reason,
        "results": if include_quality_feedback {
            serde_json::to_value(results).unwrap_or_else(|_| serde_json::json!([]))
        } else {
            serde_json::json!([])
        },
        "quality_feedback_enabled": include_quality_feedback,
    })
}

pub async fn abort(
    panel_url: &str,
    device_id: &str,
    token: &str,
    prepare_id: &str,
    reason: &str,
    results: &[crate::cloud_probe::CloudProbeResult],
    include_quality_feedback: bool,
) {
    let Ok(client) = client() else {
        return;
    };
    let _ = client
        .post(format!("{}/api/v1/connect/abort", base(panel_url)))
        .bearer_auth(token)
        .header("X-Device-Id", device_id)
        .json(&abort_payload(
            prepare_id,
            reason,
            results,
            include_quality_feedback,
        ))
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
        .map_err(|e| rejection("renew", e))?
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

pub async fn report_connection_outcome<T: Serialize + ?Sized>(
    panel_url: &str,
    device_id: &str,
    token: &str,
    report: &T,
) -> Result<(), String> {
    client()?
        .post(format!("{}/api/v1/connect/report", base(panel_url)))
        .bearer_auth(token)
        .header("X-Device-Id", device_id)
        .json(report)
        .send()
        .await
        .map_err(|error| format!("cloud connection report request failed: {error}"))?
        .error_for_status()
        .map_err(|error| rejection("connection report", error))?;
    Ok(())
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
        .map_err(|e| rejection("revoke", e))?;
    Ok(())
}

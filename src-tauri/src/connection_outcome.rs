use crate::cloud_auth;
use crate::cloud_gateway;
use crate::config;
use crate::connection_resolver::{RouteLease, ServiceKind};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::Duration;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpStartError {
    message: String,
    outcome_reported: bool,
}

impl RdpStartError {
    pub fn reported(message: String) -> Self {
        Self {
            message,
            outcome_reported: true,
        }
    }
}

impl From<String> for RdpStartError {
    fn from(message: String) -> Self {
        Self {
            message,
            outcome_reported: false,
        }
    }
}

const SHARED_STAGES: [&str; 10] = [
    "scheduling",
    "candidate_validation",
    "transport",
    "protocol_handshake",
    "host_identity",
    "authentication",
    "session_established",
    "first_interactive_result",
    "disconnected",
    "failed",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutcomeStatus {
    Connecting,
    Connected,
    Failed,
    Disconnected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutcomeStage {
    Scheduling,
    CandidateValidation,
    Transport,
    ProtocolHandshake,
    HostIdentity,
    Authentication,
    SessionEstablished,
    FirstInteractiveResult,
    Disconnected,
    Failed,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionOutcomeInput {
    pub session_id: String,
    pub service_kind: ServiceKind,
    pub status: OutcomeStatus,
    pub stage: OutcomeStage,
    #[serde(default)]
    pub route_lease_id: Option<u64>,
    #[serde(default)]
    pub use_current_route: Option<bool>,
    #[serde(default)]
    pub attempt_id: Option<String>,
    #[serde(default)]
    pub event_id: Option<String>,
    #[serde(default)]
    pub outcome_category: Option<String>,
    #[serde(default)]
    pub error_code: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub session_duration_ms: Option<u64>,
    #[serde(default)]
    pub user_initiated: bool,
    #[serde(default)]
    pub stage_durations_ms: BTreeMap<String, u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CloudConnectionOutcomeReport {
    pub schema_version: u8,
    pub attempt_id: String,
    pub event_id: String,
    pub binding_id: Option<String>,
    pub session_id: String,
    pub service_kind: ServiceKind,
    pub status: OutcomeStatus,
    pub stage: OutcomeStage,
    pub outcome_category: String,
    pub network_penalty: bool,
    pub route_mode: String,
    pub candidate_type: String,
    pub policy_revision: Option<String>,
    pub duration_ms: Option<u64>,
    pub session_duration_ms: Option<u64>,
    pub user_initiated: bool,
    pub stage_durations_ms: BTreeMap<String, u64>,
    pub error_code: Option<String>,
    pub client_version: &'static str,
}

impl ConnectionOutcomeInput {
    pub fn new(
        session_id: impl Into<String>,
        service_kind: ServiceKind,
        status: OutcomeStatus,
        stage: OutcomeStage,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            service_kind,
            status,
            stage,
            route_lease_id: None,
            use_current_route: None,
            attempt_id: None,
            event_id: None,
            outcome_category: None,
            error_code: None,
            duration_ms: None,
            session_duration_ms: None,
            user_initiated: false,
            stage_durations_ms: BTreeMap::new(),
        }
    }
}

pub fn build_report(
    input: &ConnectionOutcomeInput,
    lease: Option<&RouteLease>,
) -> CloudConnectionOutcomeReport {
    let error_code = input.error_code.as_deref().and_then(sanitize_error_code);
    let outcome_category = normalize_category(input, error_code.as_deref());
    let network_penalty = matches!(
        outcome_category.as_str(),
        "network_timeout"
            | "network_refused"
            | "network_reset"
            | "protocol_timeout"
            | "transport_lost"
            | "session_interrupted"
    );
    let (route_mode, candidate_type) = route_context(lease);
    let attempt_id = input
        .attempt_id
        .as_deref()
        .and_then(|value| sanitize_identifier(value, 128))
        .unwrap_or_else(|| default_attempt_id(input, lease));
    let event_id = input
        .event_id
        .as_deref()
        .and_then(|value| sanitize_identifier(value, 128))
        .unwrap_or_else(|| default_event_id(&attempt_id, input.status, input.stage));
    let stage_durations_ms = input
        .stage_durations_ms
        .iter()
        .filter(|(stage, _)| SHARED_STAGES.contains(&stage.as_str()))
        .map(|(stage, duration)| (stage.clone(), (*duration).min(86_400_000)))
        .collect();

    CloudConnectionOutcomeReport {
        schema_version: 2,
        attempt_id,
        event_id,
        binding_id: lease.and_then(|value| value.binding_id.clone()),
        session_id: sanitize_session_id(&input.session_id),
        service_kind: input.service_kind,
        status: input.status,
        stage: input.stage,
        outcome_category,
        network_penalty,
        route_mode: route_mode.to_string(),
        candidate_type: candidate_type.to_string(),
        policy_revision: lease.and_then(|value| value.policy_revision.clone()),
        duration_ms: input.duration_ms.map(|value| value.min(86_400_000)),
        session_duration_ms: input.session_duration_ms.map(|value| value.min(86_400_000)),
        user_initiated: input.user_initiated,
        stage_durations_ms,
        error_code,
        client_version: env!("CARGO_PKG_VERSION"),
    }
}

fn route_context(lease: Option<&RouteLease>) -> (&'static str, &'static str) {
    let route_mode = match lease.map(|value| value.route_policy) {
        Some(crate::connection_resolver::RoutePolicy::Direct) => "direct",
        Some(crate::connection_resolver::RoutePolicy::CloudOnly) => "cloud",
        _ => "auto",
    };
    let candidate_type = match lease.map(|value| value.route_label.as_str()) {
        Some("cloud") => ("auto", "cloud"),
        Some("cloud_fallback") => ("auto", "fallback"),
        Some("lan_direct") => ("direct", "lan"),
        Some("local_direct") => ("direct", "direct"),
        _ => ("auto", "direct"),
    }
    .1;
    (route_mode, candidate_type)
}

fn sanitize_identifier(value: &str, max_len: usize) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > max_len
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | ':' | '@')
        })
    {
        return None;
    }
    Some(value.to_string())
}

fn default_attempt_id(input: &ConnectionOutcomeInput, lease: Option<&RouteLease>) -> String {
    format!(
        "{}-{}-lease-{}",
        input.service_kind.as_str(),
        sanitize_session_id(&input.session_id),
        lease.map(|value| value.lease_id).unwrap_or_default()
    )
}

fn default_event_id(attempt_id: &str, status: OutcomeStatus, stage: OutcomeStage) -> String {
    let status = match status {
        OutcomeStatus::Connecting => "connecting",
        OutcomeStatus::Connected => "connected",
        OutcomeStatus::Failed => "failed",
        OutcomeStatus::Disconnected => "disconnected",
    };
    let stage = match stage {
        OutcomeStage::Scheduling => "scheduling",
        OutcomeStage::CandidateValidation => "candidate_validation",
        OutcomeStage::Transport => "transport",
        OutcomeStage::ProtocolHandshake => "protocol_handshake",
        OutcomeStage::HostIdentity => "host_identity",
        OutcomeStage::Authentication => "authentication",
        OutcomeStage::SessionEstablished => "session_established",
        OutcomeStage::FirstInteractiveResult => "first_interactive_result",
        OutcomeStage::Disconnected => "disconnected",
        OutcomeStage::Failed => "failed",
    };
    format!("{attempt_id}-{status}-{stage}")
}

fn normalize_category(input: &ConnectionOutcomeInput, error_code: Option<&str>) -> String {
    if let Some(category) = input.outcome_category.as_deref().filter(|value| {
        matches!(
            *value,
            "progress"
                | "success"
                | "network_timeout"
                | "network_refused"
                | "network_reset"
                | "protocol_timeout"
                | "transport_lost"
                | "session_interrupted"
                | "authentication_failed"
                | "host_identity_untrusted"
                | "user_cancelled"
                | "normal_disconnect"
                | "unknown_failure"
        )
    }) {
        return category.to_string();
    }

    match input.status {
        OutcomeStatus::Connecting => return "progress".to_string(),
        OutcomeStatus::Connected => return "success".to_string(),
        OutcomeStatus::Disconnected if input.user_initiated => return "user_cancelled".to_string(),
        OutcomeStatus::Disconnected => return "normal_disconnect".to_string(),
        OutcomeStatus::Failed => {}
    }

    let code = error_code.unwrap_or_default();
    if code.contains("host_key") || code.contains("host_identity") || code.contains("untrusted") {
        return "host_identity_untrusted".to_string();
    }
    if code.contains("auth") || code.contains("password") || code.contains("private_key") {
        return "authentication_failed".to_string();
    }
    if code.contains("cancel") {
        return "user_cancelled".to_string();
    }
    if code.contains("refused") {
        return "network_refused".to_string();
    }
    if code.contains("reset") {
        return "network_reset".to_string();
    }
    if code.contains("timeout") || code.contains("timed_out") {
        return if input.stage == OutcomeStage::ProtocolHandshake {
            "protocol_timeout"
        } else {
            "network_timeout"
        }
        .to_string();
    }
    if code.contains("transport") {
        return "transport_lost".to_string();
    }
    if code.contains("channel")
        || code.contains("input")
        || code.contains("output")
        || code.contains("disconnect")
        || code.contains("interrupted")
    {
        return "session_interrupted".to_string();
    }
    "unknown_failure".to_string()
}

fn sanitize_error_code(value: &str) -> Option<String> {
    let candidate = value
        .split(':')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if candidate.is_empty()
        || candidate.len() > 96
        || !candidate.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
        })
    {
        return None;
    }
    Some(candidate)
}

fn sanitize_session_id(value: &str) -> String {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 128
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | ':' | '@')
        })
    {
        return "invalid-session".to_string();
    }
    value.to_string()
}

pub async fn report_for_lease(
    input: ConnectionOutcomeInput,
    lease: Option<&RouteLease>,
) -> Result<(), String> {
    let saved = config::load_saved_config();
    if !saved.anonymous_quality_feedback_enabled() {
        return Ok(());
    }
    let report = build_report(&input, lease);
    if saved.dashboard_url.is_empty() || saved.cloud_device_id.is_empty() {
        return Ok(());
    }
    let token = cloud_auth::load_device_token(&saved.cloud_device_id)?;
    let mut last_error = None;
    for delay in [
        Duration::ZERO,
        Duration::from_millis(250),
        Duration::from_secs(1),
    ] {
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        match cloud_gateway::report_connection_outcome(
            &saved.dashboard_url,
            &saved.cloud_device_id,
            &token,
            &report,
        )
        .await
        {
            Ok(()) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| "connection_outcome_report_failed".to_string()))
}

pub fn spawn_report_for_lease(input: ConnectionOutcomeInput, lease: Option<RouteLease>) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = report_for_lease(input, lease.as_ref()).await {
            log::warn!("[cloud] connection outcome report failed: {error}");
        }
    });
}

pub fn spawn_rdp_start_failure(session_id: &str, error: &str, lease: Option<RouteLease>) {
    let lower = error.to_ascii_lowercase();
    let (stage, code) = if lower.contains("password") || lower.contains("auth") {
        (OutcomeStage::Authentication, "rdp_authentication_failed")
    } else if lower.contains("certificate")
        || lower.contains("identity")
        || lower.contains("untrusted")
    {
        (OutcomeStage::HostIdentity, "rdp_host_identity_untrusted")
    } else if lower.contains("refused") {
        (OutcomeStage::Transport, "rdp_transport_refused")
    } else if lower.contains("reset") {
        (OutcomeStage::Transport, "rdp_transport_reset")
    } else if lower.contains("timeout") || lower.contains("timed out") {
        (OutcomeStage::Transport, "rdp_transport_timeout")
    } else {
        (OutcomeStage::Transport, "rdp_start_failed")
    };
    let mut input =
        ConnectionOutcomeInput::new(session_id, ServiceKind::Rdp, OutcomeStatus::Failed, stage);
    input.route_lease_id = lease.as_ref().map(|value| value.lease_id);
    input.error_code = Some(code.to_string());
    spawn_report_for_lease(input, lease);
}

fn select_report_lease(
    current: Option<RouteLease>,
    expected_lease_id: Option<u64>,
) -> Result<Option<RouteLease>, String> {
    match (current, expected_lease_id) {
        (Some(lease), Some(expected)) if lease.lease_id == expected => Ok(Some(lease)),
        (Some(_), Some(_)) | (None, Some(_)) => Err("stale_route_lease".to_string()),
        (current, None) => Ok(current),
    }
}

#[tauri::command]
pub async fn connection_outcome_report(
    input: ConnectionOutcomeInput,
    app_state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let current_lease = if input.use_current_route == Some(false) {
        None
    } else {
        crate::connection_resolver::current_route_lease(
            app_state.inner(),
            input.service_kind,
            &input.session_id,
        )
    };
    let lease = select_report_lease(current_lease, input.route_lease_id)?;
    report_for_lease(input, lease.as_ref()).await
}

#[cfg(test)]
mod tests {
    use super::{
        build_report, select_report_lease, ConnectionOutcomeInput, OutcomeStage, OutcomeStatus,
    };
    use crate::connection_resolver::{RouteLease, RoutePolicy, ServiceKind, TargetAddress};
    use std::collections::BTreeMap;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn startup_error_encodes_report_ownership_separately_from_its_message() {
        let reported =
            serde_json::to_value(super::RdpStartError::reported("refused".into())).unwrap();
        assert_eq!(
            reported,
            serde_json::json!({ "message": "refused", "outcomeReported": true })
        );
        let unreported =
            serde_json::to_value(super::RdpStartError::from("timeout".to_string())).unwrap();
        assert_eq!(
            unreported,
            serde_json::json!({ "message": "timeout", "outcomeReported": false })
        );
    }

    fn lease(route_label: &str, binding_id: Option<&str>) -> RouteLease {
        RouteLease {
            lease_id: 7,
            service_kind: ServiceKind::Ssh,
            session_id: Some("ssh-tab-7".to_string()),
            dial_target: TargetAddress {
                host: "relay.example.com".to_string(),
                port: 42022,
            },
            identity_target: TargetAddress {
                host: "server.example.com".to_string(),
                port: 22,
            },
            binding_id: binding_id.map(str::to_string),
            route_label: route_label.to_string(),
            force_direct: true,
            route_policy: RoutePolicy::Auto,
            policy_revision: Some("routing-test-v1".to_string()),
            route_diagnostics: None,
            network_scope_id: None,
        }
    }

    #[test]
    fn authentication_failures_are_not_network_penalties_and_diagnostics_are_sanitized() {
        let input = ConnectionOutcomeInput {
            session_id: "ssh-tab-7".to_string(),
            service_kind: ServiceKind::Ssh,
            status: OutcomeStatus::Failed,
            stage: OutcomeStage::Authentication,
            route_lease_id: Some(7),
            use_current_route: None,
            attempt_id: Some("attempt-7".to_string()),
            event_id: Some("event-auth-7".to_string()),
            outcome_category: None,
            error_code: Some("ssh_authentication_rejected:password=hunter2".to_string()),
            duration_ms: Some(820),
            session_duration_ms: None,
            user_initiated: false,
            stage_durations_ms: BTreeMap::from([
                ("transport".to_string(), 120),
                ("authentication".to_string(), 420),
                ("password".to_string(), 999),
            ]),
        };

        let report = build_report(&input, Some(&lease("cloud", Some("bnd_7"))));
        assert_eq!(report.outcome_category, "authentication_failed");
        assert!(!report.network_penalty);
        assert_eq!(report.binding_id.as_deref(), Some("bnd_7"));
        assert_eq!(report.candidate_type, "cloud");
        assert_eq!(report.route_mode, "auto");
        assert_eq!(report.policy_revision.as_deref(), Some("routing-test-v1"));
        assert_eq!(report.attempt_id, "attempt-7");
        assert_eq!(report.event_id, "event-auth-7");
        assert_eq!(
            report.error_code.as_deref(),
            Some("ssh_authentication_rejected")
        );
        assert_eq!(
            report.stage_durations_ms,
            BTreeMap::from([
                ("authentication".to_string(), 420),
                ("transport".to_string(), 120),
            ])
        );
        let serialized = serde_json::to_string(&report).unwrap();
        assert!(!serialized.contains("hunter2"));
        assert!(!serialized.contains("password="));
        assert!(!serialized.contains("server.example.com"));
    }

    #[test]
    fn transport_timeouts_penalize_cloud_fallback_but_direct_reports_need_no_binding() {
        let mut input = ConnectionOutcomeInput {
            session_id: "ssh-tab-8".to_string(),
            service_kind: ServiceKind::Ssh,
            status: OutcomeStatus::Failed,
            stage: OutcomeStage::Transport,
            route_lease_id: Some(7),
            use_current_route: None,
            attempt_id: None,
            event_id: None,
            outcome_category: None,
            error_code: Some("ssh_transport_connect_timeout".to_string()),
            duration_ms: Some(15_000),
            session_duration_ms: None,
            user_initiated: false,
            stage_durations_ms: BTreeMap::new(),
        };

        let fallback = build_report(&input, Some(&lease("cloud_fallback", None)));
        assert_eq!(fallback.outcome_category, "network_timeout");
        assert!(fallback.network_penalty);
        assert_eq!(fallback.route_mode, "auto");
        assert_eq!(fallback.candidate_type, "fallback");
        assert_eq!(fallback.binding_id, None);

        input.status = OutcomeStatus::Connected;
        input.stage = OutcomeStage::SessionEstablished;
        input.error_code = None;
        let mut direct_lease = lease("local_direct", None);
        direct_lease.route_policy = RoutePolicy::Direct;
        let direct = build_report(&input, Some(&direct_lease));
        assert_eq!(direct.outcome_category, "success");
        assert!(!direct.network_penalty);
        assert_eq!(direct.route_mode, "direct");
        assert_eq!(direct.candidate_type, "direct");
    }

    #[test]
    fn cloud_only_outcomes_keep_cloud_route_mode_and_server_policy_revision() {
        let mut cloud_only = lease("cloud", Some("bnd-cloud-only"));
        cloud_only.route_policy = RoutePolicy::CloudOnly;
        cloud_only.policy_revision = Some("routing-v9".to_string());
        let input = ConnectionOutcomeInput::new(
            "ssh-tab-cloud-only",
            ServiceKind::Ssh,
            OutcomeStatus::Connected,
            OutcomeStage::SessionEstablished,
        );

        let report = build_report(&input, Some(&cloud_only));

        assert_eq!(report.route_mode, "cloud");
        assert_eq!(report.candidate_type, "cloud");
        assert_eq!(report.policy_revision.as_deref(), Some("routing-v9"));
    }

    #[test]
    fn stale_route_lease_ids_never_bind_an_outcome_to_a_replacement_route() {
        let current = lease("cloud", Some("replacement-binding"));

        assert_eq!(
            select_report_lease(Some(current.clone()), Some(6)).unwrap_err(),
            "stale_route_lease"
        );
        assert_eq!(
            select_report_lease(Some(current), Some(7))
                .unwrap()
                .and_then(|value| value.binding_id)
                .as_deref(),
            Some("replacement-binding")
        );
    }

    #[tokio::test]
    async fn report_posts_only_the_sanitized_contract_to_the_gateway() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut received = Vec::new();
            let mut buffer = [0_u8; 2048];
            loop {
                let count = stream.read(&mut buffer).await.unwrap();
                if count == 0 {
                    break;
                }
                received.extend_from_slice(&buffer[..count]);
                let text = String::from_utf8_lossy(&received);
                let Some(header_end) = text.find("\r\n\r\n") else {
                    continue;
                };
                let content_length = text[..header_end]
                    .lines()
                    .find_map(|line| {
                        line.strip_prefix("content-length: ")
                            .or_else(|| line.strip_prefix("Content-Length: "))
                    })
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or_default();
                if received.len() >= header_end + 4 + content_length {
                    break;
                }
            }
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .await
                .unwrap();
            String::from_utf8(received).unwrap()
        });

        let mut input = ConnectionOutcomeInput::new(
            "ssh-tab-http",
            ServiceKind::Ssh,
            OutcomeStatus::Failed,
            OutcomeStage::Authentication,
        );
        input.error_code = Some("ssh_authentication_rejected:password=hunter2".to_string());
        let report = build_report(&input, Some(&lease("cloud", Some("bnd_http"))));
        crate::cloud_gateway::report_connection_outcome(
            &format!("http://{address}"),
            "dev_http",
            "token_http",
            &report,
        )
        .await
        .unwrap();

        let request = server.await.unwrap();
        assert!(request.starts_with("POST /api/v1/connect/report HTTP/1.1"));
        assert!(request
            .to_ascii_lowercase()
            .contains("x-device-id: dev_http"));
        assert!(request.contains("\"service_kind\":\"ssh\""));
        assert!(request.contains("\"binding_id\":\"bnd_http\""));
        assert!(!request.contains("hunter2"));
        assert!(!request.contains("password="));
    }
}

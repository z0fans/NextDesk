use crate::cloud_auth;
use crate::cloud_gateway::{
    self, CloudBindingResponse, CloudPrepareCandidate, CloudPrepareMode, CloudPrepareResponse,
    CloudRouteDiagnostics,
};
use crate::config;
use crate::state::{ActiveCloudBinding, AppState, CloudResolveResult, CloudResolveSender};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::net::TcpStream;
use tokio::sync::watch;
use tokio::time::{sleep, timeout, Duration, Instant};

const CLOUD_BINDING_RENEW_WINDOW_MS: u128 = 30_000;
const CLOUD_PREPARE_RETRY_DELAYS_MS: [u64; 3] = [800, 1_600, 2_800];
const CLOUD_RENEW_RETRY_DELAYS_MS: [u64; 2] = [800, 1_600];
const CLOUD_ENDPOINT_READY_TIMEOUT_MS: u64 = 12_000;
const CLOUD_ENDPOINT_READY_CONNECT_TIMEOUT_MS: u64 = 700;
const CLOUD_ENDPOINT_READY_INTERVAL_MS: u64 = 300;
const CLOUD_ENDPOINT_READY_SETTLE_MS: u64 = 500;
static NEXT_ROUTE_LEASE_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceKind {
    Rdp,
    Ssh,
}

impl ServiceKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Rdp => "rdp",
            Self::Ssh => "ssh",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RoutePolicy {
    #[default]
    Auto,
    Direct,
    CloudOnly,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TargetAddress {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone)]
pub struct ConnectionIntent {
    pub service_kind: ServiceKind,
    pub session_id: Option<String>,
    pub host: String,
    pub port: u16,
    pub reuse_cloud_binding: bool,
    pub route_policy: RoutePolicy,
    pub preferred_region: Option<String>,
    pub network_route_preferences: HashMap<String, RoutePolicy>,
}

#[derive(Debug, Clone)]
pub struct RouteLease {
    pub lease_id: u64,
    pub service_kind: ServiceKind,
    pub session_id: Option<String>,
    pub dial_target: TargetAddress,
    pub identity_target: TargetAddress,
    pub binding_id: Option<String>,
    pub route_label: String,
    pub force_direct: bool,
    pub route_policy: RoutePolicy,
    pub policy_revision: Option<String>,
    pub route_diagnostics: Option<CloudRouteDiagnostics>,
    pub network_scope_id: Option<String>,
}

impl RouteLease {
    fn from_resolved(intent: &ConnectionIntent, resolved: ResolvedTarget) -> Self {
        Self {
            lease_id: NEXT_ROUTE_LEASE_ID.fetch_add(1, Ordering::Relaxed),
            service_kind: intent.service_kind,
            session_id: intent.session_id.clone(),
            dial_target: TargetAddress {
                host: resolved.host,
                port: resolved.port,
            },
            identity_target: TargetAddress {
                host: intent.host.clone(),
                port: intent.port,
            },
            binding_id: resolved.binding_id,
            route_label: resolved.route_label,
            force_direct: resolved.force_direct,
            route_policy: intent.route_policy,
            policy_revision: resolved.policy_revision,
            route_diagnostics: resolved.route_diagnostics,
            network_scope_id: resolved.network_scope_id,
        }
    }

    fn into_resolved(self) -> ResolvedTarget {
        ResolvedTarget {
            host: self.dial_target.host,
            port: self.dial_target.port,
            binding_id: self.binding_id,
            route_label: self.route_label,
            force_direct: self.force_direct,
            route_lease_id: self.lease_id,
            policy_revision: self.policy_revision,
            route_diagnostics: self.route_diagnostics,
            network_scope_id: self.network_scope_id,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedTarget {
    pub host: String,
    pub port: u16,
    pub binding_id: Option<String>,
    pub route_label: String,
    pub force_direct: bool,
    pub route_lease_id: u64,
    pub policy_revision: Option<String>,
    pub route_diagnostics: Option<CloudRouteDiagnostics>,
    pub network_scope_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RouteHealthPath {
    pub route_label: String,
    pub reachable: bool,
    pub score_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub country_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subregion: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RouteHealthAssessment {
    pub supported: bool,
    pub checked_at_ms: u64,
    pub recommendation: bool,
    pub threshold_percent: f64,
    pub check_interval_ms: u64,
    pub required_observations: u32,
    pub recovery_observations: u32,
    pub improvement_percent: Option<f64>,
    pub reason: String,
    pub current: Option<RouteHealthPath>,
    pub alternative: Option<RouteHealthPath>,
}

enum CloudResolveFlight {
    Leader(CloudResolveSender),
    Follower(watch::Receiver<Option<CloudResolveResult>>),
}

struct CloudResolveLeader {
    key: String,
    inflight: Arc<Mutex<std::collections::HashMap<String, CloudResolveSender>>>,
    sender: Option<CloudResolveSender>,
}

impl CloudResolveLeader {
    fn new(
        key: String,
        inflight: Arc<Mutex<std::collections::HashMap<String, CloudResolveSender>>>,
        sender: CloudResolveSender,
    ) -> Self {
        Self {
            key,
            inflight,
            sender: Some(sender),
        }
    }

    fn finish(mut self, result: &CloudResolveResult) {
        if let Some(sender) = self.sender.take() {
            let _ = sender.send(Some(result.clone()));
        }
        self.inflight.lock().unwrap().remove(&self.key);
    }
}

impl Drop for CloudResolveLeader {
    fn drop(&mut self) {
        let Some(sender) = self.sender.take() else {
            return;
        };
        let _ = sender.send(Some(Err("cloud_resolve_cancelled".to_string())));
        self.inflight.lock().unwrap().remove(&self.key);
    }
}

fn direct_target(host: String, port: u16, route_label: &str) -> ResolvedTarget {
    ResolvedTarget {
        host,
        port,
        binding_id: None,
        route_label: route_label.to_string(),
        force_direct: true,
        route_lease_id: 0,
        policy_revision: Some("direct-policy-v1".to_string()),
        route_diagnostics: None,
        network_scope_id: None,
    }
}

fn direct_fallback_lease(current: &RouteLease) -> RouteLease {
    RouteLease {
        lease_id: NEXT_ROUTE_LEASE_ID.fetch_add(1, Ordering::Relaxed),
        service_kind: current.service_kind,
        session_id: current.session_id.clone(),
        dial_target: current.identity_target.clone(),
        identity_target: current.identity_target.clone(),
        binding_id: None,
        route_label: "cloud_fallback".to_string(),
        force_direct: true,
        route_policy: current.route_policy,
        policy_revision: current.policy_revision.clone(),
        route_diagnostics: current.route_diagnostics.clone(),
        network_scope_id: current.network_scope_id.clone(),
    }
}

pub fn replace_route_with_direct_fallback(
    app_state: &AppState,
    current: &RouteLease,
) -> Result<RouteLease, String> {
    let session_id = current
        .session_id
        .as_deref()
        .ok_or_else(|| "ssh_route_session_required".to_string())?;
    let key = active_route_key(current.service_kind, session_id);
    let fallback = direct_fallback_lease(current);
    let replaced = {
        let mut leases = app_state.active_route_leases.lock().unwrap();
        let is_current = leases
            .get(&key)
            .is_some_and(|lease| lease.lease_id == current.lease_id);
        if !is_current {
            return Err("ssh_route_lease_stale".to_string());
        }
        leases.insert(key, fallback.clone())
    };
    if let Some(replaced) = replaced {
        release_lease_resources(app_state, replaced);
    }
    Ok(fallback)
}

fn cloud_credentials_present(saved: &config::SavedConfig) -> bool {
    saved.cloud_account_available
        && !saved.dashboard_url.is_empty()
        && !saved.cloud_device_id.is_empty()
}

fn resolve_cloud_result(
    host: String,
    port: u16,
    result: Result<ResolvedTarget, String>,
) -> ResolvedTarget {
    match result {
        Ok(resolved) => resolved,
        Err(error) => {
            log::warn!(
                "[cloud] route unavailable target={}:{} error={}; falling back to direct",
                host,
                port,
                error
            );
            direct_target(host, port, "cloud_fallback")
        }
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn cloud_binding_key(
    service_kind: ServiceKind,
    session_id: Option<&str>,
    host: &str,
    port: u16,
) -> String {
    let session_id = session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("__legacy__");
    format!(
        "{}|{session_id}|{}:{port}",
        service_kind.as_str(),
        host.to_ascii_lowercase()
    )
}

fn active_route_key(service_kind: ServiceKind, session_id: &str) -> String {
    format!("{}|{}", service_kind.as_str(), session_id.trim())
}

async fn wait_for_cloud_resolve(
    mut receiver: watch::Receiver<Option<CloudResolveResult>>,
) -> CloudResolveResult {
    loop {
        if let Some(result) = receiver.borrow().clone() {
            return result;
        }
        receiver
            .changed()
            .await
            .map_err(|_| "cloud_resolve_cancelled".to_string())?;
    }
}

async fn run_cloud_resolve_singleflight<F, Fut>(
    app_state: &AppState,
    key: String,
    operation: F,
) -> CloudResolveResult
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = CloudResolveResult>,
{
    let flight = {
        let mut inflight = app_state.cloud_resolve_inflight.lock().unwrap();
        if let Some(sender) = inflight.get(&key) {
            CloudResolveFlight::Follower(sender.subscribe())
        } else {
            let (sender, _receiver) = watch::channel(None);
            inflight.insert(key.clone(), sender.clone());
            CloudResolveFlight::Leader(sender)
        }
    };

    match flight {
        CloudResolveFlight::Follower(receiver) => {
            log::info!("[cloud] joining in-flight route target={key}");
            wait_for_cloud_resolve(receiver).await
        }
        CloudResolveFlight::Leader(sender) => {
            let leader =
                CloudResolveLeader::new(key, Arc::clone(&app_state.cloud_resolve_inflight), sender);
            let result = operation().await;
            leader.finish(&result);
            result
        }
    }
}

fn binding_is_valid(binding: &ActiveCloudBinding, now: u128) -> bool {
    binding.expires_at_ms > now
}

fn can_reuse_cached_binding(
    binding: &ActiveCloudBinding,
    now: u128,
    reuse_cloud_binding: bool,
) -> bool {
    reuse_cloud_binding && binding_is_valid(binding, now)
}

fn binding_needs_renewal(binding: &ActiveCloudBinding, now: u128) -> bool {
    now >= binding.renew_at_ms || binding.expires_at_ms < now + CLOUD_BINDING_RENEW_WINDOW_MS
}

fn should_bypass_cloud_for_host(host: &str) -> bool {
    let host = host.trim();
    let lower = host.to_ascii_lowercase();
    if lower == "localhost" || lower.ends_with(".localhost") || lower.ends_with(".local") {
        return true;
    }

    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            let octets = ip.octets();
            octets[0] == 0
                || octets[0] == 10
                || (octets[0] == 100 && (octets[1] & 0xC0) == 64)
                || octets[0] == 127
                || (octets[0] == 169 && octets[1] == 254)
                || (octets[0] == 172 && (octets[1] & 0xF0) == 16)
                || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
                || (octets[0] == 192 && octets[1] == 0 && octets[2] == 2)
                || (octets[0] == 192 && octets[1] == 168)
                || (octets[0] == 192 && octets[1] == 88 && octets[2] == 99)
                || (octets[0] == 198 && (octets[1] & 0xFE) == 18)
                || (octets[0] == 198 && octets[1] == 51 && octets[2] == 100)
                || (octets[0] == 203 && octets[1] == 0 && octets[2] == 113)
                || octets[0] >= 224
        }
        Ok(IpAddr::V6(ip)) => {
            let segments = ip.segments();
            ip.is_loopback()
                || ip.is_unspecified()
                || (segments[0] & 0xFE00) == 0xFC00
                || (segments[0] & 0xFFC0) == 0xFE80
                || (segments[0] & 0xFF00) == 0xFF00
        }
        Err(_) => false,
    }
}

async fn prepare_with_retry(
    panel_url: &str,
    device_id: &str,
    token: &str,
    host: &str,
    port: u16,
    preferred_region: &str,
    reuse_existing: bool,
    session_id: Option<&str>,
    service_kind: ServiceKind,
) -> Result<CloudPrepareResponse, String> {
    let mut last_error = None;
    for attempt in 0..=CLOUD_PREPARE_RETRY_DELAYS_MS.len() {
        match cloud_gateway::prepare(
            panel_url,
            device_id,
            token,
            host,
            port,
            preferred_region,
            reuse_existing,
            session_id,
            service_kind,
        )
        .await
        {
            Ok(response) => return Ok(response),
            Err(error)
                if error == cloud_gateway::RATE_LIMITED
                    && attempt < CLOUD_PREPARE_RETRY_DELAYS_MS.len() =>
            {
                let delay = CLOUD_PREPARE_RETRY_DELAYS_MS[attempt];
                log::warn!(
                    "[cloud] prepare rate limited target={}:{} attempt={}/{}; retrying in {}ms",
                    host,
                    port,
                    attempt + 1,
                    CLOUD_PREPARE_RETRY_DELAYS_MS.len() + 1,
                    delay
                );
                last_error = Some(error);
                sleep(Duration::from_millis(delay)).await;
            }
            Err(error) => return Err(error),
        }
    }
    Err(last_error.unwrap_or_else(|| "cloud prepare failed".to_string()))
}

async fn renew_with_retry(
    panel_url: &str,
    device_id: &str,
    token: &str,
    binding_id: &str,
) -> Result<CloudBindingResponse, String> {
    let mut last_error = None;
    for attempt in 0..=CLOUD_RENEW_RETRY_DELAYS_MS.len() {
        match cloud_gateway::renew(panel_url, device_id, token, binding_id).await {
            Ok(response) => return Ok(response),
            Err(error)
                if error == cloud_gateway::RATE_LIMITED
                    && attempt < CLOUD_RENEW_RETRY_DELAYS_MS.len() =>
            {
                let delay = CLOUD_RENEW_RETRY_DELAYS_MS[attempt];
                log::warn!(
                    "[cloud] renew rate limited binding={} attempt={}/{}; retrying in {}ms",
                    binding_id,
                    attempt + 1,
                    CLOUD_RENEW_RETRY_DELAYS_MS.len() + 1,
                    delay
                );
                last_error = Some(error);
                sleep(Duration::from_millis(delay)).await;
            }
            Err(error) => return Err(error),
        }
    }
    Err(last_error.unwrap_or_else(|| "cloud renew failed".to_string()))
}

async fn wait_for_cloud_endpoint_ready(binding: &CloudBindingResponse) -> Result<(), String> {
    wait_for_endpoint_ready(
        &binding.binding_id,
        &binding.endpoint.host,
        binding.endpoint.port,
    )
    .await
}

async fn wait_for_cached_endpoint_ready(binding: &ActiveCloudBinding) -> Result<(), String> {
    wait_for_endpoint_ready(
        &binding.binding_id,
        &binding.endpoint_host,
        binding.endpoint_port,
    )
    .await
}

async fn wait_for_endpoint_ready(binding_id: &str, host: &str, port: u16) -> Result<(), String> {
    let started = Instant::now();
    loop {
        let attempt = timeout(
            Duration::from_millis(CLOUD_ENDPOINT_READY_CONNECT_TIMEOUT_MS),
            TcpStream::connect((host, port)),
        )
        .await;
        if matches!(attempt, Ok(Ok(_))) {
            sleep(Duration::from_millis(CLOUD_ENDPOINT_READY_SETTLE_MS)).await;
            log::info!(
                "[cloud] endpoint ready binding={} endpoint={}:{} wait_ms={}",
                binding_id,
                host,
                port,
                started.elapsed().as_millis()
            );
            return Ok(());
        }
        if started.elapsed() >= Duration::from_millis(CLOUD_ENDPOINT_READY_TIMEOUT_MS) {
            log::warn!(
                "[cloud] endpoint readiness timed out binding={} endpoint={}:{} wait_ms={}",
                binding_id,
                host,
                port,
                started.elapsed().as_millis()
            );
            return Err("cloud_endpoint_not_ready".to_string());
        }
        sleep(Duration::from_millis(CLOUD_ENDPOINT_READY_INTERVAL_MS)).await;
    }
}

pub async fn keep_binding_alive(
    app_state: &AppState,
    session_id: Option<&str>,
    host: &str,
    port: u16,
) -> Result<(), String> {
    keep_route_alive(app_state, ServiceKind::Rdp, session_id, host, port).await
}

const CLOUD_BINDING_GONE_ERROR: &str = cloud_gateway::BINDING_GONE;

fn invalidate_cloud_binding_if_current(app_state: &AppState, key: &str, binding_id: &str) -> bool {
    let mut bindings = app_state.cloud_active_bindings.lock().unwrap();
    if bindings
        .get(key)
        .is_some_and(|binding| binding.binding_id == binding_id)
    {
        bindings.remove(key);
        return true;
    }
    false
}

pub async fn keep_route_alive(
    app_state: &AppState,
    service_kind: ServiceKind,
    session_id: Option<&str>,
    host: &str,
    port: u16,
) -> Result<(), String> {
    if should_bypass_cloud_for_host(host) {
        return Ok(());
    }

    let saved = config::load_saved_config();
    if saved.dashboard_url.is_empty() || saved.cloud_device_id.is_empty() {
        return Ok(());
    }

    let key = cloud_binding_key(service_kind, session_id, host, port);
    let Some(binding) = app_state
        .cloud_active_bindings
        .lock()
        .unwrap()
        .get(&key)
        .cloned()
    else {
        return Ok(());
    };

    let now = now_ms();
    if binding_is_valid(&binding, now) && !binding_needs_renewal(&binding, now) {
        return Ok(());
    }

    let token = cloud_auth::load_device_token(&saved)?;
    match renew_with_retry(
        &saved.dashboard_url,
        &saved.cloud_device_id,
        &token,
        &binding.binding_id,
    )
    .await
    {
        Ok(renewed) => {
            let updated = ActiveCloudBinding::from_response(host, port, &renewed);
            app_state
                .cloud_active_bindings
                .lock()
                .unwrap()
                .insert(key, updated.clone());
            log::info!(
                "[cloud] keepalive renewed target={}:{} binding={} endpoint={}:{}",
                host,
                port,
                updated.binding_id,
                updated.endpoint_host,
                updated.endpoint_port
            );
            Ok(())
        }
        Err(error) if error == cloud_gateway::BINDING_GONE => {
            let invalidated =
                invalidate_cloud_binding_if_current(app_state, &key, &binding.binding_id);
            log::warn!(
                "[cloud] keepalive binding gone target={}:{} binding={} invalidated={}",
                host,
                port,
                binding.binding_id,
                invalidated
            );
            Err(CLOUD_BINDING_GONE_ERROR.to_string())
        }
        Err(error) if binding_is_valid(&binding, now_ms()) => {
            log::warn!(
                "[cloud] keepalive renewal failed but current route is still valid target={}:{} binding={} error={}",
                host,
                port,
                binding.binding_id,
                error
            );
            Ok(())
        }
        Err(error) => Err(error),
    }
}

async fn resolve_connection_target_inner(
    app_state: &AppState,
    saved: &config::SavedConfig,
    host: String,
    port: u16,
    reuse_cloud_binding: bool,
    session_id: Option<&str>,
    service_kind: ServiceKind,
    route_policy: RoutePolicy,
    preferred_region: Option<&str>,
) -> Result<ResolvedTarget, String> {
    if should_bypass_cloud_for_host(&host) {
        return Ok(direct_target(host, port, "lan_direct"));
    }

    if route_policy == RoutePolicy::Direct {
        return Ok(direct_target(host, port, "local_direct"));
    }

    if !cloud_credentials_present(&saved) {
        if route_policy == RoutePolicy::CloudOnly {
            return Err("cloud_authorization_required".to_string());
        }
        return Ok(direct_target(host, port, "local_direct"));
    }
    let key = cloud_binding_key(service_kind, session_id, &host, port);
    let now = now_ms();
    let cached_binding = {
        app_state
            .cloud_active_bindings
            .lock()
            .unwrap()
            .get(&key)
            .cloned()
    };
    if let Some(binding) = cached_binding {
        if can_reuse_cached_binding(&binding, now, reuse_cloud_binding) {
            if binding_needs_renewal(&binding, now) {
                let token = cloud_auth::load_device_token(&saved)?;
                match renew_with_retry(
                    &saved.dashboard_url,
                    &saved.cloud_device_id,
                    &token,
                    &binding.binding_id,
                )
                .await
                {
                    Ok(renewed) => {
                        let updated = ActiveCloudBinding::from_response(&host, port, &renewed);
                        app_state
                            .cloud_active_bindings
                            .lock()
                            .unwrap()
                            .insert(key.clone(), updated.clone());
                        log::info!(
                            "[cloud] renewed cached route target={}:{} binding={} endpoint={}:{}",
                            host,
                            port,
                            updated.binding_id,
                            updated.endpoint_host,
                            updated.endpoint_port
                        );
                        if reuse_cloud_binding {
                            if let Err(error) = wait_for_cached_endpoint_ready(&updated).await {
                                app_state.cloud_active_bindings.lock().unwrap().remove(&key);
                                return Err(error);
                            }
                        }
                        return Ok(updated.resolved());
                    }
                    Err(error) => {
                        if error == cloud_gateway::BINDING_GONE {
                            let invalidated = invalidate_cloud_binding_if_current(
                                app_state,
                                &key,
                                &binding.binding_id,
                            );
                            log::warn!(
                                "[cloud] cached binding gone target={}:{} binding={} invalidated={}; recalculating",
                                host,
                                port,
                                binding.binding_id,
                                invalidated
                            );
                        } else if binding_is_valid(&binding, now_ms()) {
                            log::warn!(
                                "[cloud] cached route renewal failed target={}:{} binding={} error={}; keeping current route until expiry",
                                host,
                                port,
                                binding.binding_id,
                                error
                            );
                            if reuse_cloud_binding {
                                if let Err(error) = wait_for_cached_endpoint_ready(&binding).await {
                                    app_state.cloud_active_bindings.lock().unwrap().remove(&key);
                                    return Err(error);
                                }
                            }
                            return Ok(binding.resolved());
                        } else {
                            log::warn!(
                                "[cloud] cached route renewal failed after expiry target={}:{} binding={} error={}; recalculating",
                                host,
                                port,
                                binding.binding_id,
                                error
                            );
                            invalidate_cloud_binding_if_current(
                                app_state,
                                &key,
                                &binding.binding_id,
                            );
                        }
                    }
                }
            } else {
                log::info!(
                    "[cloud] reusing cached route target={}:{} binding={} endpoint={}:{}",
                    host,
                    port,
                    binding.binding_id,
                    binding.endpoint_host,
                    binding.endpoint_port
                );
                if reuse_cloud_binding {
                    if let Err(error) = wait_for_cached_endpoint_ready(&binding).await {
                        app_state.cloud_active_bindings.lock().unwrap().remove(&key);
                        return Err(error);
                    }
                }
                return Ok(binding.resolved());
            }
        } else if reuse_cloud_binding {
            log::info!(
                "[cloud] cached route expired target={}:{} binding={}; recalculating",
                host,
                port,
                binding.binding_id
            );
            app_state.cloud_active_bindings.lock().unwrap().remove(&key);
        } else {
            log::info!(
                "[cloud] fresh route requested target={}:{} binding={}; recalculating",
                host,
                port,
                binding.binding_id
            );
            app_state.cloud_active_bindings.lock().unwrap().remove(&key);
        }
    }
    log::info!(
        "[cloud] preparing route target={}:{} reuse_requested={} reuse_existing=false",
        host,
        port,
        reuse_cloud_binding
    );

    let token = cloud_auth::load_device_token(&saved)?;
    let prepared = prepare_with_retry(
        &saved.dashboard_url,
        &saved.cloud_device_id,
        &token,
        &host,
        port,
        preferred_region.unwrap_or("auto"),
        reuse_cloud_binding,
        session_id,
        service_kind,
    )
    .await?;

    let (ready, endpoint_was_probed) = match prepared.mode {
        CloudPrepareMode::Reused => (
            prepared
                .binding
                .ok_or_else(|| "cloud_prepare_missing_reused_binding".to_string())?,
            false,
        ),
        CloudPrepareMode::Candidates => {
            let prepare_id = prepared
                .prepare_id
                .clone()
                .ok_or_else(|| "cloud_prepare_missing_prepare_id".to_string())?;
            if prepared.candidates.is_empty() {
                cloud_gateway::abort(
                    &saved.dashboard_url,
                    &saved.cloud_device_id,
                    &token,
                    &prepare_id,
                    "not_enough_candidates",
                    &[],
                    saved.anonymous_quality_feedback_enabled(),
                )
                .await;
                return Err("cloud_no_candidates".to_string());
            }

            log::info!(
                "[cloud] probing {} candidates for target={}:{} prepare_id={}",
                prepared.candidates.len(),
                host,
                port,
                prepare_id
            );
            let probe_timeout_ms = prepared.probe_timeout_ms.unwrap_or(2500);
            let mut validation_candidates = prepared.candidates.clone();
            if route_policy == RoutePolicy::Auto {
                validation_candidates.push(crate::cloud_probe::direct_candidate(
                    &host,
                    port,
                    service_kind,
                ));
            }
            let results = crate::cloud_probe::probe_candidates_for_connection(
                &validation_candidates,
                probe_timeout_ms,
                service_kind,
                prepared.race_policy.as_ref(),
            )
            .await;
            let cloud_results = results
                .iter()
                .filter(|result| result.binding_id != crate::cloud_probe::DIRECT_CANDIDATE_ID)
                .cloned()
                .collect::<Vec<_>>();
            let winner = if route_policy == RoutePolicy::Auto {
                match crate::cloud_probe::select_intelligent_route(&results) {
                    crate::cloud_probe::IntelligentRouteChoice::Cloud(result) => result,
                    crate::cloud_probe::IntelligentRouteChoice::Direct(result) => {
                        log::info!(
                            "[cloud] intelligent mode kept direct target={}:{} score_ms={}",
                            host,
                            port,
                            result.score_ms
                        );
                        cloud_gateway::abort(
                            &saved.dashboard_url,
                            &saved.cloud_device_id,
                            &token,
                            &prepare_id,
                            "intelligent_direct_selected",
                            &cloud_results,
                            saved.anonymous_quality_feedback_enabled(),
                        )
                        .await;
                        let mut direct = direct_target(host, port, "local_direct");
                        direct.network_scope_id = prepared
                            .candidates
                            .iter()
                            .filter_map(|candidate| candidate.route_diagnostics.as_ref())
                            .map(|diagnostics| {
                                diagnostics
                                    .client_network
                                    .network_scope_id
                                    .trim()
                                    .to_string()
                            })
                            .find(|scope| !scope.is_empty());
                        return Ok(direct);
                    }
                    crate::cloud_probe::IntelligentRouteChoice::Unavailable => {
                        log::warn!(
                            "[cloud] all intelligent candidates failed target={}:{} prepare_id={} results={:?}",
                            host,
                            port,
                            prepare_id,
                            results
                        );
                        cloud_gateway::abort(
                            &saved.dashboard_url,
                            &saved.cloud_device_id,
                            &token,
                            &prepare_id,
                            "all_candidates_failed",
                            &cloud_results,
                            saved.anonymous_quality_feedback_enabled(),
                        )
                        .await;
                        return Err("cloud_all_candidates_failed".to_string());
                    }
                }
            } else {
                match crate::cloud_probe::select_winner(&cloud_results) {
                    Some(result) => result,
                    None => {
                        log::warn!(
                        "[cloud] all candidate probes failed target={}:{} prepare_id={} results={:?}",
                        host,
                        port,
                        prepare_id,
                        cloud_results
                    );
                        cloud_gateway::abort(
                            &saved.dashboard_url,
                            &saved.cloud_device_id,
                            &token,
                            &prepare_id,
                            "all_candidates_failed",
                            &cloud_results,
                            saved.anonymous_quality_feedback_enabled(),
                        )
                        .await;
                        return Err("cloud_all_candidates_failed".to_string());
                    }
                }
            };
            log::info!(
                "[cloud] candidate winner target={}:{} prepare_id={} binding={} total_ms={}",
                host,
                port,
                prepare_id,
                winner.binding_id,
                winner.total_ms
            );
            (
                cloud_gateway::commit(
                    &saved.dashboard_url,
                    &saved.cloud_device_id,
                    &token,
                    &prepare_id,
                    &winner.binding_id,
                    &cloud_results,
                    saved.anonymous_quality_feedback_enabled(),
                )
                .await?,
                true,
            )
        }
    };

    if !endpoint_was_probed {
        if let Err(error) = wait_for_cloud_endpoint_ready(&ready).await {
            cloud_gateway::close(
                &saved.dashboard_url,
                &saved.cloud_device_id,
                &token,
                &ready.binding_id,
            )
            .await;
            return Err(error);
        }
    }

    let binding = ActiveCloudBinding::from_response(&host, port, &ready);
    if let Some(diagnostics) = binding.route_diagnostics.as_ref() {
        let summary = serde_json::json!({
            "schema_version": diagnostics.schema_version,
            "candidate": {
                "reference": diagnostics.agent.agent_ref,
                "country": diagnostics.agent.country_code,
                "subregion": diagnostics.agent.subregion,
                "routing_group": diagnostics.agent.routing_group,
                "line_tags": diagnostics.agent.line_tags,
                "supported_protocols": diagnostics.agent.supported_protocols,
                "capacity": diagnostics.agent.capacity,
                "failure_domain": diagnostics.agent.failure_domain,
                "recommendation_rank": diagnostics.agent.recommendation_rank,
            },
            "client_network": {
                "country": diagnostics.client_network.country_code,
                "province": diagnostics.client_network.province,
                "asn": diagnostics.client_network.asn,
                "carrier": diagnostics.client_network.carrier,
                "classification_source": diagnostics.client_network.classification_source,
            },
            "shadow_evaluation": diagnostics.shadow_evaluation.as_ref().map(|shadow| serde_json::json!({
                "mode": shadow.mode,
                "policy_revision": shadow.policy_revision,
                "current_candidates": shadow.current_candidates.iter().map(|candidate| &candidate.agent.agent_ref).collect::<Vec<_>>(),
                "shadow_candidates": shadow.shadow_candidates.iter().map(|candidate| &candidate.agent.agent_ref).collect::<Vec<_>>(),
                "same_order": shadow.comparison.same_order,
                "excluded_summary": shadow.excluded_summary,
            })),
            "agent_target_probe": diagnostics.agent_target_probe,
            "quality_shadow": diagnostics.quality_shadow,
        });
        log::info!("[cloud] sanitized route diagnostics={summary}");
    }
    app_state
        .cloud_active_bindings
        .lock()
        .unwrap()
        .insert(key, binding.clone());
    Ok(binding.resolved())
}

const ROUTE_DEGRADATION_IMPROVEMENT_THRESHOLD_PERCENT: f64 = 20.0;
const ROUTE_DEGRADATION_CHECK_INTERVAL_MS: u64 = 15_000;
const ROUTE_DEGRADATION_REQUIRED_OBSERVATIONS: u32 = 2;

fn effective_degradation_policy(
    policy: Option<&crate::cloud_gateway::CloudDegradationPolicy>,
) -> (f64, u64, u32, u32) {
    let threshold = policy
        .map(|value| value.improvement_threshold_percent)
        .filter(|value| value.is_finite())
        .unwrap_or(ROUTE_DEGRADATION_IMPROVEMENT_THRESHOLD_PERCENT)
        .clamp(10.0, 50.0);
    let interval = policy
        .map(|value| value.check_interval_ms)
        .unwrap_or(ROUTE_DEGRADATION_CHECK_INTERVAL_MS)
        .clamp(5_000, 60_000);
    let required = policy
        .map(|value| value.required_observations)
        .unwrap_or(ROUTE_DEGRADATION_REQUIRED_OBSERVATIONS)
        .clamp(2, 4);
    let recovery = policy
        .map(|value| value.recovery_observations)
        .unwrap_or(ROUTE_DEGRADATION_REQUIRED_OBSERVATIONS)
        .clamp(2, 4);
    (threshold, interval, required, recovery)
}

fn route_health_path(
    candidate: Option<&CloudPrepareCandidate>,
    route_label: &str,
    result: &crate::cloud_probe::CloudProbeResult,
) -> RouteHealthPath {
    let diagnostics = candidate.and_then(|value| value.route_diagnostics.as_ref());
    RouteHealthPath {
        route_label: route_label.to_string(),
        reachable: result.ok && result.winner_eligible,
        score_ms: (result.ok && result.winner_eligible).then_some(result.score_ms),
        candidate_ref: diagnostics
            .map(|value| value.agent.agent_ref.trim().to_string())
            .filter(|value| !value.is_empty()),
        country_code: diagnostics
            .map(|value| value.agent.country_code.trim().to_string())
            .filter(|value| !value.is_empty()),
        subregion: diagnostics
            .map(|value| value.agent.subregion.trim().to_string())
            .filter(|value| !value.is_empty()),
    }
}

fn route_improvement_percent(
    current: &RouteHealthPath,
    alternative: &RouteHealthPath,
) -> Option<f64> {
    if !alternative.reachable {
        return None;
    }
    if !current.reachable {
        return Some(100.0);
    }
    let current_score = current.score_ms?;
    let alternative_score = alternative.score_ms?;
    if current_score == 0 || alternative_score >= current_score {
        return Some(0.0);
    }
    Some((((current_score - alternative_score) as f64 / current_score as f64) * 100.0).min(100.0))
}

fn unsupported_route_health(reason: &str) -> RouteHealthAssessment {
    RouteHealthAssessment {
        supported: false,
        checked_at_ms: now_ms().min(u128::from(u64::MAX)) as u64,
        recommendation: false,
        threshold_percent: ROUTE_DEGRADATION_IMPROVEMENT_THRESHOLD_PERCENT,
        check_interval_ms: ROUTE_DEGRADATION_CHECK_INTERVAL_MS,
        required_observations: ROUTE_DEGRADATION_REQUIRED_OBSERVATIONS,
        recovery_observations: ROUTE_DEGRADATION_REQUIRED_OBSERVATIONS,
        improvement_percent: None,
        reason: reason.to_string(),
        current: None,
        alternative: None,
    }
}

/// Reassess an established route without replacing or interrupting its lease.
///
/// The temporary candidate allocation is always aborted after bounded protocol
/// validation. The caller only receives privacy-safe route evidence; endpoints
/// and binding identities remain inside the Rust process.
pub async fn assess_route_health(
    app_state: &AppState,
    service_kind: ServiceKind,
    session_id: &str,
) -> Result<RouteHealthAssessment, String> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err("route_health_session_required".to_string());
    }
    let current_lease = current_route_lease(app_state, service_kind, session_id)
        .ok_or_else(|| "route_health_session_not_found".to_string())?;
    if current_lease.route_policy == RoutePolicy::Direct {
        return Ok(unsupported_route_health("explicit_direct"));
    }
    if current_lease.route_label == "lan_direct" {
        return Ok(unsupported_route_health("lan_direct"));
    }

    let saved = config::load_saved_config();
    if !cloud_credentials_present(&saved) {
        return Ok(unsupported_route_health("cloud_unavailable"));
    }
    let token = cloud_auth::load_device_token(&saved)?;
    let prepared = cloud_gateway::prepare(
        &saved.dashboard_url,
        &saved.cloud_device_id,
        &token,
        &current_lease.identity_target.host,
        current_lease.identity_target.port,
        "auto",
        false,
        Some(session_id),
        service_kind,
    )
    .await?;

    let prepare_id = match prepared.mode {
        CloudPrepareMode::Candidates => prepared
            .prepare_id
            .clone()
            .ok_or_else(|| "cloud_prepare_missing_prepare_id".to_string())?,
        CloudPrepareMode::Reused => return Err("route_health_unexpected_reuse".to_string()),
    };
    let (threshold_percent, check_interval_ms, required_observations, recovery_observations) =
        effective_degradation_policy(prepared.degradation_policy.as_ref());
    if prepared.candidates.is_empty() {
        cloud_gateway::abort(
            &saved.dashboard_url,
            &saved.cloud_device_id,
            &token,
            &prepare_id,
            "route_health_no_alternative",
            &[],
            saved.anonymous_quality_feedback_enabled(),
        )
        .await;
        return Ok(RouteHealthAssessment {
            supported: true,
            checked_at_ms: now_ms().min(u128::from(u64::MAX)) as u64,
            recommendation: false,
            threshold_percent,
            check_interval_ms,
            required_observations,
            recovery_observations,
            improvement_percent: None,
            reason: "no_alternative".to_string(),
            current: None,
            alternative: None,
        });
    }

    let current_is_cloud =
        current_lease.binding_id.is_some() && current_lease.route_label == "cloud";
    let current_agent_ref = current_lease
        .route_diagnostics
        .as_ref()
        .map(|value| value.agent.agent_ref.trim().to_string())
        .filter(|value| !value.is_empty());
    let alternative_limit = if current_is_cloud { 1 } else { 2 };
    let alternatives = prepared
        .candidates
        .iter()
        .filter(|candidate| {
            let candidate_ref = candidate
                .route_diagnostics
                .as_ref()
                .map(|value| value.agent.agent_ref.trim());
            current_agent_ref
                .as_deref()
                .zip(candidate_ref)
                .is_none_or(|(current, candidate)| current != candidate)
        })
        .take(alternative_limit)
        .cloned()
        .collect::<Vec<_>>();

    let current_binding_id = current_lease
        .binding_id
        .clone()
        .unwrap_or_else(|| crate::cloud_probe::DIRECT_CANDIDATE_ID.to_string());
    let mut validation_candidates = Vec::with_capacity(4);
    if current_is_cloud {
        validation_candidates.push(CloudPrepareCandidate {
            binding_id: current_binding_id.clone(),
            endpoint: crate::cloud_gateway::CloudEndpoint {
                host: current_lease.dial_target.host.clone(),
                port: current_lease.dial_target.port,
                protocols: vec!["tcp".to_string()],
            },
            expires_at: String::new(),
            route_diagnostics: current_lease.route_diagnostics.clone(),
        });
    } else {
        validation_candidates.push(crate::cloud_probe::direct_candidate(
            &current_lease.identity_target.host,
            current_lease.identity_target.port,
            service_kind,
        ));
    }
    validation_candidates.extend(alternatives.iter().cloned());
    if current_is_cloud && current_lease.route_policy == RoutePolicy::Auto {
        validation_candidates.push(crate::cloud_probe::direct_candidate(
            &current_lease.identity_target.host,
            current_lease.identity_target.port,
            service_kind,
        ));
    }

    let results = crate::cloud_probe::probe_candidates_for_service_with_policy(
        &validation_candidates,
        prepared.probe_timeout_ms.unwrap_or(2500),
        service_kind,
        prepared.race_policy.as_ref(),
    )
    .await;
    let prepared_binding_ids = prepared
        .candidates
        .iter()
        .map(|candidate| candidate.binding_id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let reportable_results = results
        .iter()
        .filter(|result| prepared_binding_ids.contains(result.binding_id.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    cloud_gateway::abort(
        &saved.dashboard_url,
        &saved.cloud_device_id,
        &token,
        &prepare_id,
        "route_health_complete",
        &reportable_results,
        saved.anonymous_quality_feedback_enabled(),
    )
    .await;

    if !route_lease_is_current(app_state, service_kind, session_id, current_lease.lease_id) {
        return Err("route_health_session_changed".to_string());
    }

    let current_result = results
        .iter()
        .find(|result| result.binding_id == current_binding_id)
        .ok_or_else(|| "route_health_current_not_probed".to_string())?;
    let current_candidate = current_is_cloud.then(|| CloudPrepareCandidate {
        binding_id: current_binding_id.clone(),
        endpoint: crate::cloud_gateway::CloudEndpoint {
            host: current_lease.dial_target.host.clone(),
            port: current_lease.dial_target.port,
            protocols: vec!["tcp".to_string()],
        },
        expires_at: String::new(),
        route_diagnostics: current_lease.route_diagnostics.clone(),
    });
    let current = route_health_path(
        current_candidate.as_ref(),
        &current_lease.route_label,
        current_result,
    );
    let best_alternative_result = results
        .iter()
        .filter(|result| result.binding_id != current_binding_id)
        .filter(|result| result.ok && result.winner_eligible)
        .min_by_key(|result| result.score_ms);
    let alternative = best_alternative_result.map(|result| {
        let candidate = prepared
            .candidates
            .iter()
            .find(|candidate| candidate.binding_id == result.binding_id);
        let label = if result.binding_id == crate::cloud_probe::DIRECT_CANDIDATE_ID {
            "local_direct"
        } else {
            "cloud"
        };
        route_health_path(candidate, label, result)
    });
    let improvement_percent = alternative
        .as_ref()
        .and_then(|candidate| route_improvement_percent(&current, candidate));
    let recommendation = improvement_percent.is_some_and(|value| value >= threshold_percent);
    let reason = if alternative.is_none() {
        "no_reachable_alternative"
    } else if !current.reachable && recommendation {
        "current_unreachable"
    } else if recommendation {
        "better_route_observed"
    } else {
        "improvement_below_threshold"
    };

    Ok(RouteHealthAssessment {
        supported: true,
        checked_at_ms: now_ms().min(u128::from(u64::MAX)) as u64,
        recommendation,
        threshold_percent,
        check_interval_ms,
        required_observations,
        recovery_observations,
        improvement_percent,
        reason: reason.to_string(),
        current: Some(current),
        alternative,
    })
}

pub async fn resolve_connection(
    app_state: &AppState,
    intent: ConnectionIntent,
) -> Result<RouteLease, String> {
    let original_host = intent.host.clone();
    let host = intent.host.clone();
    let port = intent.port;
    let is_private_target = should_bypass_cloud_for_host(&host);
    let mut effective_intent = intent.clone();
    if is_private_target {
        // Private and reserved destinations are never meaningful cloud relay
        // targets. Freeze the actual decision as direct so audit events match
        // the route that was used, even when a saved fixed-cloud preference
        // came from a different network.
        effective_intent.route_policy = RoutePolicy::Direct;
    }
    let mut resolved_network_scope = None;
    if !is_private_target
        && intent.route_policy == RoutePolicy::Auto
        && !intent.network_route_preferences.is_empty()
    {
        let saved = config::load_saved_config();
        if cloud_credentials_present(&saved) {
            if let Ok(token) = cloud_auth::load_device_token(&saved) {
                match cloud_gateway::network_context(
                    &saved.dashboard_url,
                    &saved.cloud_device_id,
                    &token,
                )
                .await
                {
                    Ok(context) => {
                        let scope = context.network_scope_id.trim().to_string();
                        if !scope.is_empty() {
                            effective_intent.route_policy = intent
                                .network_route_preferences
                                .get(&scope)
                                .copied()
                                .unwrap_or(RoutePolicy::Auto);
                            resolved_network_scope = Some(scope);
                        }
                    }
                    Err(error) => log::warn!(
                        "[cloud] network-scoped route preference unavailable; using intelligent mode: {}",
                        error
                    ),
                }
            }
        }
    }
    let saved = if is_private_target || effective_intent.route_policy == RoutePolicy::Direct {
        config::SavedConfig::default()
    } else {
        config::load_saved_config()
    };
    let identity = cloud_auth::DeviceIdentity::from(&saved);
    let result = if is_private_target || effective_intent.route_policy == RoutePolicy::Direct {
        resolve_connection_target_inner(
            app_state,
            &saved,
            host,
            port,
            effective_intent.reuse_cloud_binding,
            effective_intent.session_id.as_deref(),
            effective_intent.service_kind,
            effective_intent.route_policy,
            effective_intent.preferred_region.as_deref(),
        )
        .await
    } else {
        let key = cloud_binding_key(
            effective_intent.service_kind,
            effective_intent.session_id.as_deref(),
            &host,
            port,
        );
        // A new account must not join an old account's in-flight authorization result.
        let key = format!(
            "{key}|{}|{}|{}",
            saved.dashboard_url, saved.cloud_device_id, saved.cloud_authorization_revision
        );
        run_cloud_resolve_singleflight(app_state, key, || {
            resolve_connection_target_inner(
                app_state,
                &saved,
                host,
                port,
                effective_intent.reuse_cloud_binding,
                effective_intent.session_id.as_deref(),
                effective_intent.service_kind,
                effective_intent.route_policy,
                effective_intent.preferred_region.as_deref(),
            )
        })
        .await
    };
    if result
        .as_ref()
        .is_err_and(|error| error == cloud_gateway::AUTHORIZATION_EXPIRED)
    {
        match cloud_auth::invalidate_authorization(&identity) {
            Ok(()) => app_state.cloud_active_bindings.lock().unwrap().clear(),
            Err(error) => log::warn!("[cloud] authorization invalidation skipped: {error}"),
        }
    }
    let mut resolved = match effective_intent.route_policy {
        RoutePolicy::Auto => resolve_cloud_result(original_host, port, result),
        RoutePolicy::Direct | RoutePolicy::CloudOnly => result?,
    };
    if resolved.network_scope_id.is_none() {
        resolved.network_scope_id = resolved_network_scope.or_else(|| {
            resolved
                .route_diagnostics
                .as_ref()
                .map(|diagnostics| {
                    diagnostics
                        .client_network
                        .network_scope_id
                        .trim()
                        .to_string()
                })
                .filter(|scope| !scope.is_empty())
        });
    }
    let lease = RouteLease::from_resolved(&effective_intent, resolved);
    if let Some(session_id) = lease
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let replaced = app_state.active_route_leases.lock().unwrap().insert(
            active_route_key(lease.service_kind, session_id),
            lease.clone(),
        );
        if let Some(replaced) = replaced {
            if replaced.binding_id != lease.binding_id {
                release_lease_resources(app_state, replaced);
            }
        }
    }
    Ok(lease)
}

pub async fn resolve_connection_target(
    app_state: &AppState,
    host: String,
    port: u16,
    reuse_cloud_binding: bool,
    session_id: Option<String>,
) -> Result<ResolvedTarget, String> {
    resolve_connection(
        app_state,
        ConnectionIntent {
            service_kind: ServiceKind::Rdp,
            session_id,
            host,
            port,
            reuse_cloud_binding,
            route_policy: RoutePolicy::Auto,
            preferred_region: None,
            network_route_preferences: HashMap::new(),
        },
    )
    .await
    .map(RouteLease::into_resolved)
}

pub fn clear_binding(app_state: &AppState, session_id: Option<&str>, host: &str, port: u16) {
    app_state
        .cloud_active_bindings
        .lock()
        .unwrap()
        .remove(&cloud_binding_key(ServiceKind::Rdp, session_id, host, port));
}

pub fn release_session_route(
    app_state: &AppState,
    service_kind: ServiceKind,
    session_id: &str,
) -> bool {
    release_session_route_inner(app_state, service_kind, session_id, None)
}

pub fn release_session_route_if_current(
    app_state: &AppState,
    service_kind: ServiceKind,
    session_id: &str,
    expected_lease_id: u64,
) -> bool {
    release_session_route_inner(app_state, service_kind, session_id, Some(expected_lease_id))
}

pub fn route_lease_is_current(
    app_state: &AppState,
    service_kind: ServiceKind,
    session_id: &str,
    lease_id: u64,
) -> bool {
    app_state
        .active_route_leases
        .lock()
        .unwrap()
        .get(&active_route_key(service_kind, session_id))
        .is_some_and(|lease| lease.lease_id == lease_id)
}

pub fn current_route_lease(
    app_state: &AppState,
    service_kind: ServiceKind,
    session_id: &str,
) -> Option<RouteLease> {
    app_state
        .active_route_leases
        .lock()
        .unwrap()
        .get(&active_route_key(service_kind, session_id))
        .cloned()
}

pub fn release_route_lease(app_state: &AppState, lease: &RouteLease) -> bool {
    let Some(session_id) = lease.session_id.as_deref() else {
        return false;
    };
    release_session_route_if_current(app_state, lease.service_kind, session_id, lease.lease_id)
}

fn release_session_route_inner(
    app_state: &AppState,
    service_kind: ServiceKind,
    session_id: &str,
    expected_lease_id: Option<u64>,
) -> bool {
    let key = active_route_key(service_kind, session_id);
    let lease = {
        let mut leases = app_state.active_route_leases.lock().unwrap();
        let Some(current) = leases.get(&key) else {
            return false;
        };
        if expected_lease_id.is_some_and(|expected| current.lease_id != expected) {
            log::debug!(
                "[cloud] ignored stale route release service={} session={} expected_lease={} current_lease={}",
                service_kind.as_str(),
                session_id,
                expected_lease_id.unwrap_or_default(),
                current.lease_id
            );
            return false;
        }
        leases
            .remove(&key)
            .expect("route lease disappeared while locked")
    };

    release_lease_resources(app_state, lease);
    true
}

fn release_lease_resources(app_state: &AppState, lease: RouteLease) {
    let service_kind = lease.service_kind;
    let binding_key = cloud_binding_key(
        lease.service_kind,
        lease.session_id.as_deref(),
        &lease.identity_target.host,
        lease.identity_target.port,
    );
    let mut bindings = app_state.cloud_active_bindings.lock().unwrap();
    if bindings
        .get(&binding_key)
        .is_some_and(|binding| Some(&binding.binding_id) == lease.binding_id.as_ref())
    {
        bindings.remove(&binding_key);
    }
    drop(bindings);

    if let Some(binding_id) = lease.binding_id {
        tauri::async_runtime::spawn(async move {
            let saved = config::load_saved_config();
            if saved.dashboard_url.is_empty() || saved.cloud_device_id.is_empty() {
                log::warn!(
                    "[cloud] route released locally but remote close credentials are unavailable service={}",
                    service_kind.as_str()
                );
                return;
            }
            let Ok(token) = cloud_auth::load_device_token(&saved) else {
                log::warn!(
                    "[cloud] route released locally but remote close token is unavailable service={}",
                    service_kind.as_str()
                );
                return;
            };
            cloud_gateway::close(
                &saved.dashboard_url,
                &saved.cloud_device_id,
                &token,
                &binding_id,
            )
            .await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{
        binding_is_valid, binding_needs_renewal, can_reuse_cached_binding, cloud_binding_key,
        cloud_credentials_present, direct_fallback_lease, direct_target,
        invalidate_cloud_binding_if_current, release_session_route,
        release_session_route_if_current, resolve_cloud_result, resolve_connection,
        resolve_connection_target, route_improvement_percent, run_cloud_resolve_singleflight,
        ConnectionIntent, ResolvedTarget, RouteHealthPath, RouteLease, RoutePolicy, ServiceKind,
        TargetAddress,
    };
    use crate::config::SavedConfig;
    use crate::state::{ActiveCloudBinding, AppState};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn binding(expires_at_ms: u128) -> ActiveCloudBinding {
        ActiveCloudBinding {
            binding_id: "bnd_test".to_string(),
            original_host: "203.0.113.10".to_string(),
            original_port: 3389,
            endpoint_host: "104.245.12.19".to_string(),
            endpoint_port: 42001,
            expires_at_ms,
            renew_at_ms: expires_at_ms.saturating_sub(60_000),
            renew_after_seconds: 120,
            reconnect_until_ms: expires_at_ms,
            policy_revision: Some("routing-test-v1".to_string()),
            route_diagnostics: None,
        }
    }

    #[test]
    fn route_health_requires_a_twenty_percent_measured_advantage() {
        let current = RouteHealthPath {
            route_label: "cloud".to_string(),
            reachable: true,
            score_ms: Some(200),
            candidate_ref: Some("agent-a".to_string()),
            country_code: Some("JP".to_string()),
            subregion: Some("Tokyo".to_string()),
        };
        let clearly_better = RouteHealthPath {
            route_label: "cloud".to_string(),
            reachable: true,
            score_ms: Some(150),
            candidate_ref: Some("agent-b".to_string()),
            country_code: Some("MY".to_string()),
            subregion: Some("Kuala Lumpur".to_string()),
        };
        let noise = RouteHealthPath {
            score_ms: Some(180),
            ..clearly_better.clone()
        };

        assert_eq!(
            route_improvement_percent(&current, &clearly_better),
            Some(25.0)
        );
        assert_eq!(route_improvement_percent(&current, &noise), Some(10.0));
    }

    #[test]
    fn unreachable_current_route_can_recommend_a_live_alternative() {
        let current = RouteHealthPath {
            route_label: "cloud".to_string(),
            reachable: false,
            score_ms: None,
            candidate_ref: Some("agent-a".to_string()),
            country_code: None,
            subregion: None,
        };
        let alternative = RouteHealthPath {
            route_label: "local_direct".to_string(),
            reachable: true,
            score_ms: Some(90),
            candidate_ref: None,
            country_code: None,
            subregion: None,
        };

        assert_eq!(
            route_improvement_percent(&current, &alternative),
            Some(100.0)
        );
    }

    #[test]
    fn cached_binding_is_reused_until_lease_expires() {
        let now = 10_000;
        let binding = binding(now + 120_000);

        assert!(binding_is_valid(&binding, now));
        assert!(!binding_needs_renewal(&binding, now));
        assert!(can_reuse_cached_binding(&binding, now, true));
    }

    #[test]
    fn fresh_route_request_skips_a_valid_cached_binding() {
        let now = 10_000;
        let binding = binding(now + 120_000);

        assert!(!can_reuse_cached_binding(&binding, now, false));
    }

    #[test]
    fn cloud_binding_cache_is_isolated_per_rdp_session() {
        let first = cloud_binding_key(ServiceKind::Rdp, Some("tab-a"), "203.0.113.10", 3389);
        let second = cloud_binding_key(ServiceKind::Rdp, Some("tab-b"), "203.0.113.10", 3389);
        let first_reconnect =
            cloud_binding_key(ServiceKind::Rdp, Some("tab-a"), "203.0.113.10", 3389);

        assert_ne!(first, second);
        assert_eq!(first, first_reconnect);
    }

    #[test]
    fn cloud_binding_cache_is_isolated_per_service() {
        let rdp = cloud_binding_key(ServiceKind::Rdp, Some("tab-a"), "203.0.113.10", 22);
        let ssh = cloud_binding_key(ServiceKind::Ssh, Some("tab-a"), "203.0.113.10", 22);

        assert_ne!(rdp, ssh);
        assert!(rdp.starts_with("rdp|"));
        assert!(ssh.starts_with("ssh|"));
    }

    #[test]
    fn cached_binding_enters_renewal_window_before_expiry() {
        let now = 10_000;
        let binding = binding(now + 20_000);

        assert!(binding_is_valid(&binding, now));
        assert!(binding_needs_renewal(&binding, now));
    }

    #[test]
    fn invalidation_only_removes_the_binding_that_failed() {
        let state = AppState::default();
        let key = cloud_binding_key(ServiceKind::Rdp, Some("tab-a"), "203.0.113.10", 3389);
        state
            .cloud_active_bindings
            .lock()
            .unwrap()
            .insert(key.clone(), binding(120_000));

        assert!(!invalidate_cloud_binding_if_current(
            &state,
            &key,
            "newer_binding"
        ));
        assert!(state
            .cloud_active_bindings
            .lock()
            .unwrap()
            .contains_key(&key));

        assert!(invalidate_cloud_binding_if_current(
            &state, &key, "bnd_test"
        ));
        assert!(!state
            .cloud_active_bindings
            .lock()
            .unwrap()
            .contains_key(&key));
    }

    #[test]
    fn direct_fallback_preserves_the_requested_public_target() {
        let resolved = direct_target("8.8.8.8".to_string(), 3389, "cloud_fallback");

        assert_eq!(resolved.host, "8.8.8.8");
        assert_eq!(resolved.port, 3389);
        assert_eq!(resolved.binding_id, None);
        assert_eq!(resolved.route_label, "cloud_fallback");
        assert!(resolved.force_direct);
        assert_eq!(
            resolved.policy_revision.as_deref(),
            Some("direct-policy-v1")
        );
    }

    #[test]
    fn direct_fallback_lease_dials_the_original_ssh_identity() {
        let cloud = RouteLease {
            lease_id: 41,
            service_kind: ServiceKind::Ssh,
            session_id: Some("ssh-tab".to_string()),
            dial_target: TargetAddress {
                host: "relay.example.com".to_string(),
                port: 42022,
            },
            identity_target: TargetAddress {
                host: "203.0.113.10".to_string(),
                port: 22,
            },
            binding_id: Some("binding-test".to_string()),
            route_label: "cloud".to_string(),
            force_direct: true,
            route_policy: RoutePolicy::Auto,
            policy_revision: Some("routing-test-v1".to_string()),
            route_diagnostics: None,
            network_scope_id: None,
        };

        let fallback = direct_fallback_lease(&cloud);

        assert_ne!(fallback.lease_id, cloud.lease_id);
        assert_eq!(fallback.dial_target, cloud.identity_target);
        assert_eq!(fallback.identity_target, cloud.identity_target);
        assert_eq!(fallback.binding_id, None);
        assert_eq!(fallback.route_label, "cloud_fallback");
        assert!(fallback.force_direct);
    }

    #[test]
    fn cloud_attempt_requires_device_credentials() {
        let mut saved = SavedConfig::default();
        assert!(!cloud_credentials_present(&saved));

        saved.dashboard_url = "https://oauth.mxolab.com".to_string();
        saved.cloud_device_id = "dev_test".to_string();
        saved.cloud_account_available = true;
        assert!(cloud_credentials_present(&saved));
    }

    #[test]
    fn cloud_failure_falls_back_to_the_requested_target() {
        let resolved = resolve_cloud_result(
            "8.8.8.8".to_string(),
            3389,
            Err("cloud_no_candidates".to_string()),
        );

        assert_eq!(resolved.host, "8.8.8.8");
        assert_eq!(resolved.port, 3389);
        assert_eq!(resolved.binding_id, None);
        assert_eq!(resolved.route_label, "cloud_fallback");
        assert!(resolved.force_direct);
    }

    #[tokio::test]
    async fn private_targets_always_route_directly() {
        let app_state = AppState::default();

        let resolved = resolve_connection_target(
            &app_state,
            "192.168.3.105".to_string(),
            3389,
            false,
            Some("tab-private".to_string()),
        )
        .await
        .expect("private target should not require cloud authorization");

        assert_eq!(resolved.host, "192.168.3.105");
        assert_eq!(resolved.port, 3389);
        assert_eq!(resolved.binding_id, None);
        assert_eq!(resolved.route_label, "lan_direct");
        assert!(resolved.force_direct);
    }

    #[tokio::test]
    async fn fixed_direct_public_target_bypasses_cloud_candidate_allocation() {
        let app_state = AppState::default();
        let lease = resolve_connection(
            &app_state,
            ConnectionIntent {
                service_kind: ServiceKind::Ssh,
                session_id: Some("ssh-direct-public".to_string()),
                host: "8.8.8.8".to_string(),
                port: 22,
                reuse_cloud_binding: false,
                route_policy: RoutePolicy::Direct,
                preferred_region: None,
                network_route_preferences: HashMap::new(),
            },
        )
        .await
        .expect("fixed direct must not require a cloud authorization or candidate request");

        assert_eq!(lease.route_label, "local_direct");
        assert_eq!(lease.route_policy, RoutePolicy::Direct);
        assert_eq!(lease.binding_id, None);
        assert!(app_state.cloud_active_bindings.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn ssh_route_keeps_dial_and_identity_targets_separate() {
        let app_state = AppState::default();
        let intent = ConnectionIntent {
            service_kind: ServiceKind::Ssh,
            session_id: Some("ssh-tab-a".to_string()),
            host: "192.168.3.105".to_string(),
            port: 22,
            reuse_cloud_binding: false,
            route_policy: RoutePolicy::Auto,
            preferred_region: None,
            network_route_preferences: HashMap::new(),
        };

        let lease = resolve_connection(&app_state, intent)
            .await
            .expect("private SSH target should resolve directly");

        assert_eq!(lease.dial_target.host, "192.168.3.105");
        assert_eq!(lease.dial_target.port, 22);
        assert_eq!(lease.identity_target.host, "192.168.3.105");
        assert_eq!(lease.identity_target.port, 22);
        assert_eq!(lease.service_kind, ServiceKind::Ssh);
        assert_eq!(lease.route_label, "lan_direct");
    }

    #[tokio::test]
    async fn private_target_overrides_a_stale_cloud_only_preference() {
        let app_state = AppState::default();
        let lease = resolve_connection(
            &app_state,
            ConnectionIntent {
                service_kind: ServiceKind::Ssh,
                session_id: Some("ssh-cloud-only".to_string()),
                host: "192.168.3.105".to_string(),
                port: 22,
                reuse_cloud_binding: false,
                route_policy: RoutePolicy::CloudOnly,
                preferred_region: None,
                network_route_preferences: HashMap::new(),
            },
        )
        .await
        .expect("private target must bypass cloud allocation");

        assert_eq!(lease.route_label, "lan_direct");
        assert_eq!(lease.route_policy, RoutePolicy::Direct);
        assert_eq!(lease.binding_id, None);
    }

    #[tokio::test]
    async fn route_lease_is_released_by_service_and_session() {
        let app_state = AppState::default();
        let intent = ConnectionIntent {
            service_kind: ServiceKind::Ssh,
            session_id: Some("ssh-tab-release".to_string()),
            host: "192.168.3.105".to_string(),
            port: 22,
            reuse_cloud_binding: false,
            route_policy: RoutePolicy::Auto,
            preferred_region: None,
            network_route_preferences: HashMap::new(),
        };

        resolve_connection(&app_state, intent).await.unwrap();
        assert_eq!(app_state.active_route_leases.lock().unwrap().len(), 1);

        assert!(release_session_route(
            &app_state,
            ServiceKind::Ssh,
            "ssh-tab-release"
        ));
        assert!(app_state.active_route_leases.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn stale_release_cannot_remove_a_replacement_lease() {
        let app_state = AppState::default();
        let intent = || ConnectionIntent {
            service_kind: ServiceKind::Ssh,
            session_id: Some("ssh-tab-generation".to_string()),
            host: "192.168.3.105".to_string(),
            port: 22,
            reuse_cloud_binding: false,
            route_policy: RoutePolicy::Auto,
            preferred_region: None,
            network_route_preferences: HashMap::new(),
        };
        let first = resolve_connection(&app_state, intent()).await.unwrap();
        let replacement = resolve_connection(&app_state, intent()).await.unwrap();

        assert_ne!(first.lease_id, replacement.lease_id);
        assert!(!release_session_route_if_current(
            &app_state,
            ServiceKind::Ssh,
            "ssh-tab-generation",
            first.lease_id,
        ));
        assert_eq!(
            app_state
                .active_route_leases
                .lock()
                .unwrap()
                .get("ssh|ssh-tab-generation")
                .unwrap()
                .lease_id,
            replacement.lease_id
        );
    }

    #[tokio::test]
    async fn concurrent_resolves_for_the_same_target_share_one_operation() {
        let app_state = AppState::default();
        let calls = AtomicUsize::new(0);
        let key = "23.95.179.128:3389".to_string();

        let first = run_cloud_resolve_singleflight(&app_state, key.clone(), || async {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            Ok(ResolvedTarget {
                host: "us-agent-01.mxolab.com".to_string(),
                port: 42001,
                binding_id: Some("bnd_shared".to_string()),
                route_label: "cloud".to_string(),
                force_direct: true,
                route_lease_id: 0,
                policy_revision: Some("routing-test-v1".to_string()),
                route_diagnostics: None,
                network_scope_id: None,
            })
        });
        let second = run_cloud_resolve_singleflight(&app_state, key, || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(ResolvedTarget {
                host: "should-not-run.example.com".to_string(),
                port: 49999,
                binding_id: Some("bnd_duplicate".to_string()),
                route_label: "cloud".to_string(),
                force_direct: true,
                route_lease_id: 0,
                policy_revision: Some("routing-test-v1".to_string()),
                route_diagnostics: None,
                network_scope_id: None,
            })
        });

        let (first_result, second_result) = tokio::join!(first, second);
        let first_result = first_result.expect("leader should resolve");
        let second_result = second_result.expect("follower should share leader result");

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(first_result.binding_id.as_deref(), Some("bnd_shared"));
        assert_eq!(second_result.binding_id.as_deref(), Some("bnd_shared"));
        assert!(app_state.cloud_resolve_inflight.lock().unwrap().is_empty());
    }
}

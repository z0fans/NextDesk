use crate::cloud_auth;
use crate::cloud_gateway::{self, CloudBindingResponse, CloudPrepareMode, CloudPrepareResponse};
use crate::config;
use crate::state::{ActiveCloudBinding, AppState, CloudResolveResult, CloudResolveSender};
use std::future::Future;
use std::net::IpAddr;
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

#[derive(Debug, Clone)]
pub struct ResolvedTarget {
    pub host: String,
    pub port: u16,
    pub binding_id: Option<String>,
    pub route_label: String,
    pub force_direct: bool,
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
    }
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

fn cloud_binding_key(session_id: Option<&str>, host: &str, port: u16) -> String {
    let session_id = session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("__legacy__");
    format!("{session_id}|{}:{port}", host.to_ascii_lowercase())
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

fn cloud_auth_error(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("401")
        || error.contains("403")
        || error.contains("unauthorized")
        || error.contains("forbidden")
        || error.contains("cloud_authorization_expired")
}

fn normalize_cloud_error(error: String) -> String {
    if cloud_auth_error(&error) {
        "cloud_authorization_expired".to_string()
    } else {
        error
    }
}

fn cloud_rate_limited(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("429") || error.contains("too many requests") || error.contains("rate limit")
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
        )
        .await
        {
            Ok(response) => return Ok(response),
            Err(error)
                if cloud_rate_limited(&error) && attempt < CLOUD_PREPARE_RETRY_DELAYS_MS.len() =>
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
                if cloud_rate_limited(&error) && attempt < CLOUD_RENEW_RETRY_DELAYS_MS.len() =>
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

async fn wait_for_cloud_endpoint_ready(binding: &CloudBindingResponse) {
    let host = binding.endpoint.host.as_str();
    let port = binding.endpoint.port;
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
                binding.binding_id,
                host,
                port,
                started.elapsed().as_millis()
            );
            return;
        }
        if started.elapsed() >= Duration::from_millis(CLOUD_ENDPOINT_READY_TIMEOUT_MS) {
            log::warn!(
                "[cloud] endpoint readiness timed out binding={} endpoint={}:{} wait_ms={}",
                binding.binding_id,
                host,
                port,
                started.elapsed().as_millis()
            );
            return;
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
    if should_bypass_cloud_for_host(host) {
        return Ok(());
    }

    let saved = config::load_saved_config();
    if saved.dashboard_url.is_empty() || saved.cloud_device_id.is_empty() {
        return Ok(());
    }

    let key = cloud_binding_key(session_id, host, port);
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

    let token =
        cloud_auth::load_device_token(&saved.cloud_device_id).map_err(normalize_cloud_error)?;
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
        Err(error) => Err(normalize_cloud_error(error)),
    }
}

async fn resolve_connection_target_inner(
    app_state: &AppState,
    host: String,
    port: u16,
    reuse_cloud_binding: bool,
    session_id: Option<&str>,
) -> Result<ResolvedTarget, String> {
    if should_bypass_cloud_for_host(&host) {
        return Ok(direct_target(host, port, "lan_direct"));
    }

    let saved = config::load_saved_config();
    if !cloud_credentials_present(&saved) {
        return Ok(direct_target(host, port, "local_direct"));
    }
    let key = cloud_binding_key(session_id, &host, port);
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
                let token = cloud_auth::load_device_token(&saved.cloud_device_id)
                    .map_err(normalize_cloud_error)?;
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
                        return Ok(updated.resolved());
                    }
                    Err(error) => {
                        if binding_is_valid(&binding, now_ms()) {
                            log::warn!(
                                "[cloud] cached route renewal failed target={}:{} binding={} error={}; keeping current route until expiry",
                                host,
                                port,
                                binding.binding_id,
                                error
                            );
                            return Ok(binding.resolved());
                        } else {
                            log::warn!(
                                "[cloud] cached route renewal failed after expiry target={}:{} binding={} error={}; recalculating",
                                host,
                                port,
                                binding.binding_id,
                                error
                            );
                            app_state.cloud_active_bindings.lock().unwrap().remove(&key);
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

    let token =
        cloud_auth::load_device_token(&saved.cloud_device_id).map_err(normalize_cloud_error)?;
    let prepared = prepare_with_retry(
        &saved.dashboard_url,
        &saved.cloud_device_id,
        &token,
        &host,
        port,
        "auto",
        reuse_cloud_binding,
        session_id,
    )
    .await
    .map_err(normalize_cloud_error)?;

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
            let results =
                crate::cloud_probe::probe_candidates(&prepared.candidates, probe_timeout_ms).await;
            let winner = match crate::cloud_probe::select_winner(&results) {
                Some(result) => result,
                None => {
                    log::warn!(
                        "[cloud] all candidate probes failed target={}:{} prepare_id={} results={:?}",
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
                        &results,
                    )
                    .await;
                    return Err("cloud_all_candidates_failed".to_string());
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
                    &results,
                )
                .await
                .map_err(normalize_cloud_error)?,
                true,
            )
        }
    };

    if !endpoint_was_probed {
        wait_for_cloud_endpoint_ready(&ready).await;
    }

    let binding = ActiveCloudBinding::from_response(&host, port, &ready);
    app_state
        .cloud_active_bindings
        .lock()
        .unwrap()
        .insert(key, binding.clone());
    Ok(binding.resolved())
}

pub async fn resolve_connection_target(
    app_state: &AppState,
    host: String,
    port: u16,
    reuse_cloud_binding: bool,
    session_id: Option<String>,
) -> Result<ResolvedTarget, String> {
    let original_host = host.clone();
    let result = if should_bypass_cloud_for_host(&host) {
        resolve_connection_target_inner(
            app_state,
            host,
            port,
            reuse_cloud_binding,
            session_id.as_deref(),
        )
        .await
    } else {
        let key = cloud_binding_key(session_id.as_deref(), &host, port);
        run_cloud_resolve_singleflight(app_state, key, || {
            resolve_connection_target_inner(
                app_state,
                host,
                port,
                reuse_cloud_binding,
                session_id.as_deref(),
            )
        })
        .await
    };
    if result.as_ref().is_err_and(|error| cloud_auth_error(error)) {
        cloud_auth::invalidate_authorization();
        app_state.cloud_active_bindings.lock().unwrap().clear();
    }
    Ok(resolve_cloud_result(original_host, port, result))
}

pub fn clear_binding(app_state: &AppState, session_id: Option<&str>, host: &str, port: u16) {
    app_state
        .cloud_active_bindings
        .lock()
        .unwrap()
        .remove(&cloud_binding_key(session_id, host, port));
}

#[cfg(test)]
mod tests {
    use super::{
        binding_is_valid, binding_needs_renewal, can_reuse_cached_binding, cloud_binding_key,
        cloud_credentials_present, cloud_rate_limited, direct_target, normalize_cloud_error,
        resolve_cloud_result, resolve_connection_target, run_cloud_resolve_singleflight,
        ResolvedTarget,
    };
    use crate::config::SavedConfig;
    use crate::state::{ActiveCloudBinding, AppState};
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
        }
    }

    #[test]
    fn normalize_prepare_unsupported_stays_cloud_specific() {
        assert_eq!(
            normalize_cloud_error("cloud_prepare_unsupported".to_string()),
            "cloud_prepare_unsupported"
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
        let first = cloud_binding_key(Some("tab-a"), "203.0.113.10", 3389);
        let second = cloud_binding_key(Some("tab-b"), "203.0.113.10", 3389);
        let first_reconnect = cloud_binding_key(Some("tab-a"), "203.0.113.10", 3389);

        assert_ne!(first, second);
        assert_eq!(first, first_reconnect);
    }

    #[test]
    fn cached_binding_enters_renewal_window_before_expiry() {
        let now = 10_000;
        let binding = binding(now + 20_000);

        assert!(binding_is_valid(&binding, now));
        assert!(binding_needs_renewal(&binding, now));
    }

    #[test]
    fn cloud_rate_limit_errors_are_retryable() {
        assert!(cloud_rate_limited(
            "cloud prepare rejected: HTTP status client error (429 Too Many Requests)"
        ));
        assert!(!cloud_rate_limited("cloud prepare unsupported"));
    }

    #[test]
    fn direct_fallback_preserves_the_requested_public_target() {
        let resolved = direct_target("8.8.8.8".to_string(), 3389, "cloud_fallback");

        assert_eq!(resolved.host, "8.8.8.8");
        assert_eq!(resolved.port, 3389);
        assert_eq!(resolved.binding_id, None);
        assert_eq!(resolved.route_label, "cloud_fallback");
        assert!(resolved.force_direct);
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

use crate::cloud_gateway::{CloudPrepareCandidate, CloudRacePolicy};
use crate::connection_resolver::ServiceKind;
use futures_util::{FutureExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::time::timeout;

// Open at most two cloud routes. A trusted historical candidate starts
// immediately, while the backup is staggered by the Gateway policy. Direct is
// a virtual candidate and does not consume a cloud-validation slot.
const FINALIST_COUNT: usize = 2;
const VALIDATED_SAMPLE_COUNT: usize = 3;
const FIRST_SAMPLE_TIMEOUT_CAP_MS: u64 = 1_100;
const VALIDATION_SAMPLE_TIMEOUT_CAP_MS: u64 = 1_200;
const MIN_VALIDATION_SAMPLE_TIMEOUT_MS: u64 = 150;
const VALIDATION_SAMPLE_STAGGER_MS: u64 = 60;
const FAILED_SAMPLE_PENALTY_MS: u64 = 800;
const SSH_MAX_PRE_BANNER_LINES: usize = 50;
const SSH_MAX_BANNER_BYTES: usize = 8 * 1024;
pub const DIRECT_CANDIDATE_ID: &str = "__nextdesk_direct__";
const INTELLIGENT_CLOUD_ADVANTAGE_PERCENT: u64 = 20;
const INTELLIGENT_CLOUD_MIN_ADVANTAGE_MS: u64 = 15;
const DEFAULT_SECOND_CANDIDATE_DELAY_MS: u64 = 150;
const DEFAULT_HISTORY_FAST_PATH_BUDGET_MS: u64 = 500;
const DEFAULT_COLD_START_BUDGET_MS: u64 = 1_500;
const MAX_ACTIVE_CLOUD_VALIDATIONS: usize = 2;

const RDP_X224_CONNECTION_REQUEST: &[u8] = &[
    0x03, 0x00, 0x00, 0x13, 0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x08, 0x00, 0x03,
    0x00, 0x00, 0x00,
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CloudProbeResult {
    pub binding_id: String,
    pub service_kind: ServiceKind,
    pub validation_mode: String,
    pub ok: bool,
    pub tcp_connect_ms: Option<u64>,
    pub protocol_handshake_ms: Option<u64>,
    pub x224_ms: Option<u64>,
    pub tls_ms: Option<u64>,
    pub total_ms: u64,
    pub jitter_ms: u64,
    pub error: Option<String>,
    #[serde(skip)]
    pub score_ms: u64,
    #[serde(skip)]
    pub winner_eligible: bool,
}

#[derive(Debug, Clone, Copy)]
struct ProbeSample {
    tcp_connect_ms: u64,
    protocol_handshake_ms: u64,
    x224_ms: Option<u64>,
    tls_ms: Option<u64>,
    total_ms: u64,
}

#[derive(Clone)]
struct InitialProbe {
    candidate: CloudPrepareCandidate,
    sample: Result<ProbeSample, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct EffectiveRacePolicy {
    second_candidate_delay_ms: u64,
    history_fast_path_budget_ms: u64,
    cold_start_budget_ms: u64,
    max_active_cloud_validations: usize,
}

impl EffectiveRacePolicy {
    fn from_gateway(policy: Option<&CloudRacePolicy>) -> Self {
        let second_candidate_delay_ms = policy
            .map(|value| value.second_candidate_delay_ms)
            .filter(|value| *value <= 500)
            .unwrap_or(DEFAULT_SECOND_CANDIDATE_DELAY_MS);
        let history_fast_path_budget_ms = policy
            .map(|value| value.history_fast_path_budget_ms)
            .filter(|value| (250..=1_000).contains(value))
            .unwrap_or(DEFAULT_HISTORY_FAST_PATH_BUDGET_MS);
        let cold_start_budget_ms = policy
            .map(|value| value.cold_start_budget_ms)
            .filter(|value| (500..=3_000).contains(value))
            .unwrap_or(DEFAULT_COLD_START_BUDGET_MS)
            .max(history_fast_path_budget_ms);
        let max_active_cloud_validations = policy
            .map(|value| value.max_active_cloud_validations)
            .filter(|value| *value > 0)
            .unwrap_or(MAX_ACTIVE_CLOUD_VALIDATIONS)
            .min(MAX_ACTIVE_CLOUD_VALIDATIONS);
        Self {
            second_candidate_delay_ms,
            history_fast_path_budget_ms,
            cold_start_budget_ms,
            max_active_cloud_validations,
        }
    }
}

pub async fn probe_candidates(
    candidates: &[CloudPrepareCandidate],
    timeout_ms: u64,
) -> Vec<CloudProbeResult> {
    probe_candidates_for_service(candidates, timeout_ms, ServiceKind::Rdp).await
}

pub async fn probe_candidates_for_service(
    candidates: &[CloudPrepareCandidate],
    timeout_ms: u64,
    service_kind: ServiceKind,
) -> Vec<CloudProbeResult> {
    probe_candidates_for_service_with_policy(candidates, timeout_ms, service_kind, None).await
}

pub async fn probe_candidates_for_connection(
    candidates: &[CloudPrepareCandidate],
    timeout_ms: u64,
    service_kind: ServiceKind,
    race_policy: Option<&CloudRacePolicy>,
) -> Vec<CloudProbeResult> {
    let mut results =
        probe_candidates_for_service_with_policy(candidates, timeout_ms, service_kind, race_policy)
            .await;
    if select_winner(&results).is_some() {
        return results;
    }

    let retry_timeout_ms = timeout_ms.clamp(500, 3_000);
    log::warn!(
        "[cloud] fast {} validation found no usable route; retrying candidates with {}ms per probe",
        service_kind.as_str(),
        retry_timeout_ms
    );
    let recovered = futures_util::stream::iter(
        candidates
            .iter()
            .cloned()
            .enumerate()
            .filter(|(_, candidate)| candidate.binding_id != DIRECT_CANDIDATE_ID)
            .map(|(index, candidate)| async move {
                let mut samples = Vec::new();
                let mut failures = Vec::new();
                for _ in 0..VALIDATED_SAMPLE_COUNT {
                    match probe_sample(&candidate, retry_timeout_ms, service_kind).await {
                        Ok(sample) => samples.push(sample),
                        Err(error) => failures.push(error),
                    }
                    if samples.len() >= 2 {
                        break;
                    }
                }
                let mut result = if samples.is_empty() {
                    failed_result(
                        &candidate.binding_id,
                        retry_timeout_ms,
                        failures.pop().unwrap_or_else(|| "probe_failed".to_string()),
                        service_kind,
                    )
                } else {
                    summarize_samples(&candidate.binding_id, &samples, &failures, service_kind)
                };
                result.validation_mode = "recovery".to_string();
                (index, result)
            }),
    )
    .buffer_unordered(MAX_ACTIVE_CLOUD_VALIDATIONS)
    .collect::<Vec<_>>()
    .await;
    for (index, result) in recovered {
        results[index] = result;
    }
    results
}

pub async fn probe_candidates_for_service_with_policy(
    candidates: &[CloudPrepareCandidate],
    timeout_ms: u64,
    service_kind: ServiceKind,
    race_policy: Option<&CloudRacePolicy>,
) -> Vec<CloudProbeResult> {
    let policy = EffectiveRacePolicy::from_gateway(race_policy);
    let started = Instant::now();
    let cold_budget_ms = policy.cold_start_budget_ms.min(timeout_ms.max(500));
    let fast_budget_ms = policy.history_fast_path_budget_ms.min(cold_budget_ms);
    let first_sample_timeout_ms = cold_budget_ms.min(FIRST_SAMPLE_TIMEOUT_CAP_MS);
    let active_indices = select_active_indices(candidates, policy.max_active_cloud_validations);
    let trusted_index = active_indices
        .iter()
        .copied()
        .find(|index| candidate_has_trusted_history(&candidates[*index]));
    let direct_index = active_indices
        .iter()
        .copied()
        .find(|index| candidates[*index].binding_id == DIRECT_CANDIDATE_ID);

    let mut pending = futures_util::stream::FuturesUnordered::new();
    let mut cloud_order = 0usize;
    for index in active_indices.iter().copied() {
        let candidate = candidates[index].clone();
        let delay_ms = if candidate.binding_id == DIRECT_CANDIDATE_ID || cloud_order == 0 {
            0
        } else {
            policy.second_candidate_delay_ms
        };
        if candidate.binding_id != DIRECT_CANDIDATE_ID {
            cloud_order += 1;
        }
        pending.push(
            async move {
                if delay_ms > 0 {
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                }
                let sample = probe_sample(&candidate, first_sample_timeout_ms, service_kind).await;
                (index, InitialProbe { candidate, sample })
            }
            .boxed(),
        );
    }

    let mut initial = (0..candidates.len()).map(|_| None).collect::<Vec<_>>();
    let mut fast_window = trusted_index.is_some();
    let mut fast_path_ready = false;
    while !pending.is_empty() {
        let deadline_ms = if fast_window {
            fast_budget_ms
        } else {
            cold_budget_ms
        };
        let remaining_ms = deadline_ms.saturating_sub(started.elapsed().as_millis() as u64);
        if remaining_ms == 0 {
            if fast_window {
                fast_path_ready = trusted_probe_succeeded(&initial, trusted_index);
                if fast_path_ready {
                    break;
                }
                fast_window = false;
                continue;
            }
            break;
        }
        match timeout(Duration::from_millis(remaining_ms), pending.next()).await {
            Ok(Some((index, probe))) => {
                initial[index] = Some(probe);
                if fast_window {
                    if trusted_probe_failed(&initial, trusted_index) {
                        fast_window = false;
                    } else if trusted_probe_succeeded(&initial, trusted_index)
                        && direct_probe_completed(&initial, direct_index)
                    {
                        fast_path_ready = true;
                        break;
                    }
                }
            }
            Ok(None) => break,
            Err(_) if fast_window => {
                fast_path_ready = trusted_probe_succeeded(&initial, trusted_index);
                if fast_path_ready {
                    break;
                }
                fast_window = false;
            }
            Err(_) => break,
        }
    }
    drop(pending);

    let mut results = candidates
        .iter()
        .map(|candidate| {
            failed_result(
                &candidate.binding_id,
                cold_budget_ms,
                "probe_not_started_or_budget_exhausted".to_string(),
                service_kind,
            )
        })
        .collect::<Vec<_>>();
    for (index, probe) in initial.iter().enumerate() {
        if let Some(probe) = probe {
            results[index] = initial_result(probe, first_sample_timeout_ms, service_kind);
        }
    }

    if fast_path_ready {
        keep_only_live_fast_path_eligible(candidates, &mut results);
        for result in &mut results {
            result.validation_mode = "history_fast_path".to_string();
        }
        return results;
    }

    let completed = initial
        .into_iter()
        .enumerate()
        .filter_map(|(index, probe)| probe.map(|probe| (index, probe)))
        .collect::<Vec<_>>();
    let completed_probes = completed
        .iter()
        .map(|(_, probe)| InitialProbe {
            candidate: probe.candidate.clone(),
            sample: probe.sample.clone(),
        })
        .collect::<Vec<_>>();

    let finalist_indices = select_finalist_indices(&completed_probes)
        .into_iter()
        .map(|(completed_index, total_ms)| (completed[completed_index].0, total_ms))
        .collect::<Vec<_>>();
    if finalist_indices.is_empty() {
        return results;
    }

    let finalist_set = finalist_indices
        .iter()
        .map(|(index, _)| *index)
        .collect::<std::collections::HashSet<_>>();
    for (index, result) in results.iter_mut().enumerate() {
        if result.ok && !finalist_set.contains(&index) {
            result.winner_eligible = false;
        }
    }

    let elapsed_ms = started.elapsed().as_millis() as u64;
    let remaining_ms = cold_budget_ms.saturating_sub(elapsed_ms);
    if remaining_ms <= VALIDATION_SAMPLE_STAGGER_MS + MIN_VALIDATION_SAMPLE_TIMEOUT_MS {
        keep_only_live_history_or_direct_eligible(candidates, &mut results);
        return results;
    }
    let validation_timeout_ms = remaining_ms.saturating_sub(VALIDATION_SAMPLE_STAGGER_MS) / 2;
    let validation_timeout_ms = validation_timeout_ms.min(VALIDATION_SAMPLE_TIMEOUT_CAP_MS);
    if validation_timeout_ms < MIN_VALIDATION_SAMPLE_TIMEOUT_MS {
        keep_only_live_history_or_direct_eligible(candidates, &mut results);
        return results;
    }

    let validation_futures = finalist_indices.into_iter().map(|(index, _)| {
        let candidate = candidates[index].clone();
        let first_sample = *completed
            .iter()
            .find(|(original_index, _)| *original_index == index)
            .expect("finalist must have an initial probe")
            .1
            .sample
            .as_ref()
            .expect("finalists always have an initial sample");
        async move {
            (
                index,
                validate_finalist(candidate, first_sample, validation_timeout_ms, service_kind)
                    .await,
            )
        }
    });
    for (index, result) in futures_util::future::join_all(validation_futures).await {
        results[index] = result;
    }

    results
}

fn select_active_indices(
    candidates: &[CloudPrepareCandidate],
    max_active_cloud_validations: usize,
) -> Vec<usize> {
    let mut cloud_indices = candidates
        .iter()
        .enumerate()
        .filter(|(_, candidate)| candidate.binding_id != DIRECT_CANDIDATE_ID)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    cloud_indices.sort_by_key(|index| !candidate_has_trusted_history(&candidates[*index]));
    cloud_indices.truncate(max_active_cloud_validations.min(MAX_ACTIVE_CLOUD_VALIDATIONS));
    if let Some((direct_index, _)) = candidates
        .iter()
        .enumerate()
        .find(|(_, candidate)| candidate.binding_id == DIRECT_CANDIDATE_ID)
    {
        cloud_indices.push(direct_index);
    }
    cloud_indices
}

fn candidate_has_trusted_history(candidate: &CloudPrepareCandidate) -> bool {
    candidate
        .route_diagnostics
        .as_ref()
        .and_then(|diagnostics| diagnostics.fast_path.as_ref())
        .is_some_and(|history| history.eligible && history.consecutive_failures == 0)
}

fn trusted_probe_succeeded(initial: &[Option<InitialProbe>], trusted_index: Option<usize>) -> bool {
    trusted_index
        .and_then(|index| initial.get(index))
        .and_then(Option::as_ref)
        .is_some_and(|probe| probe.sample.is_ok())
}

fn trusted_probe_failed(initial: &[Option<InitialProbe>], trusted_index: Option<usize>) -> bool {
    trusted_index
        .and_then(|index| initial.get(index))
        .and_then(Option::as_ref)
        .is_some_and(|probe| probe.sample.is_err())
}

fn direct_probe_completed(initial: &[Option<InitialProbe>], direct_index: Option<usize>) -> bool {
    direct_index.is_none_or(|index| initial.get(index).is_some_and(Option::is_some))
}

fn keep_only_live_fast_path_eligible(
    candidates: &[CloudPrepareCandidate],
    results: &mut [CloudProbeResult],
) {
    for (candidate, result) in candidates.iter().zip(results.iter_mut()) {
        result.winner_eligible = result.ok
            && (candidate.binding_id == DIRECT_CANDIDATE_ID
                || candidate_has_trusted_history(candidate));
    }
}

fn select_finalist_indices(initial: &[InitialProbe]) -> Vec<(usize, u64)> {
    let mut successful = initial
        .iter()
        .enumerate()
        .filter_map(|(index, probe)| {
            probe
                .sample
                .as_ref()
                .ok()
                .map(|sample| (index, sample.total_ms))
        })
        .collect::<Vec<_>>();
    successful.sort_by_key(|(_, total_ms)| *total_ms);

    let direct = successful
        .iter()
        .copied()
        .find(|(index, _)| initial[*index].candidate.binding_id == DIRECT_CANDIDATE_ID);
    if let Some(direct) = direct {
        let best_cloud = successful
            .iter()
            .copied()
            .find(|(index, _)| initial[*index].candidate.binding_id != DIRECT_CANDIDATE_ID);
        return [Some(direct), best_cloud].into_iter().flatten().collect();
    }

    successful.truncate(FINALIST_COUNT);
    successful
}

fn keep_only_live_history_or_direct_eligible(
    candidates: &[CloudPrepareCandidate],
    results: &mut [CloudProbeResult],
) {
    for (candidate, result) in candidates.iter().zip(results.iter_mut()) {
        result.winner_eligible = result.ok
            && (result.binding_id == DIRECT_CANDIDATE_ID
                || candidate_has_trusted_history(candidate));
    }
}

pub fn select_winner(results: &[CloudProbeResult]) -> Option<&CloudProbeResult> {
    results
        .iter()
        .filter(|result| result.ok && result.winner_eligible)
        .min_by_key(|result| {
            if result.score_ms == 0 {
                result.total_ms
            } else {
                result.score_ms
            }
        })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IntelligentRouteChoice<'a> {
    Cloud(&'a CloudProbeResult),
    Direct(&'a CloudProbeResult),
    Unavailable,
}

/// Intelligent mode protects a healthy direct route from marginal wins. A
/// cloud route must be both stable and materially faster (20%, with a 15 ms
/// floor) before the extra hop is selected.
pub fn select_intelligent_route(results: &[CloudProbeResult]) -> IntelligentRouteChoice<'_> {
    let direct = results.iter().find(|result| {
        result.binding_id == DIRECT_CANDIDATE_ID && result.ok && result.winner_eligible
    });
    let cloud = results
        .iter()
        .filter(|result| {
            result.binding_id != DIRECT_CANDIDATE_ID && result.ok && result.winner_eligible
        })
        .min_by_key(|result| effective_score(result));

    match (direct, cloud) {
        (Some(direct), Some(cloud)) => {
            let direct_score = effective_score(direct);
            let required_advantage = INTELLIGENT_CLOUD_MIN_ADVANTAGE_MS
                .max(direct_score.saturating_mul(INTELLIGENT_CLOUD_ADVANTAGE_PERCENT) / 100);
            if effective_score(cloud).saturating_add(required_advantage) <= direct_score {
                IntelligentRouteChoice::Cloud(cloud)
            } else {
                IntelligentRouteChoice::Direct(direct)
            }
        }
        (Some(direct), None) => IntelligentRouteChoice::Direct(direct),
        (None, Some(cloud)) => IntelligentRouteChoice::Cloud(cloud),
        (None, None) => IntelligentRouteChoice::Unavailable,
    }
}

fn effective_score(result: &CloudProbeResult) -> u64 {
    if result.score_ms == 0 {
        result.total_ms
    } else {
        result.score_ms
    }
}

pub fn direct_candidate(host: &str, port: u16, service_kind: ServiceKind) -> CloudPrepareCandidate {
    CloudPrepareCandidate {
        binding_id: DIRECT_CANDIDATE_ID.to_string(),
        endpoint: crate::cloud_gateway::CloudEndpoint {
            host: host.to_string(),
            port,
            protocols: match service_kind {
                ServiceKind::Rdp => vec!["tcp".to_string(), "udp".to_string()],
                ServiceKind::Ssh => vec!["tcp".to_string()],
            },
        },
        expires_at: String::new(),
        route_diagnostics: None,
    }
}

fn initial_result(
    probe: &InitialProbe,
    timeout_ms: u64,
    service_kind: ServiceKind,
) -> CloudProbeResult {
    match &probe.sample {
        Ok(sample) => CloudProbeResult {
            binding_id: probe.candidate.binding_id.clone(),
            service_kind,
            validation_mode: "cold_start".to_string(),
            ok: true,
            tcp_connect_ms: Some(sample.tcp_connect_ms),
            protocol_handshake_ms: Some(sample.protocol_handshake_ms),
            x224_ms: sample.x224_ms,
            tls_ms: sample.tls_ms,
            total_ms: sample.total_ms,
            jitter_ms: 0,
            error: None,
            score_ms: sample.total_ms,
            winner_eligible: true,
        },
        Err(error) => failed_result(
            &probe.candidate.binding_id,
            timeout_ms,
            error.clone(),
            service_kind,
        ),
    }
}

fn failed_result(
    binding_id: &str,
    timeout_ms: u64,
    error: String,
    service_kind: ServiceKind,
) -> CloudProbeResult {
    CloudProbeResult {
        binding_id: binding_id.to_string(),
        service_kind,
        validation_mode: "cold_start".to_string(),
        ok: false,
        tcp_connect_ms: None,
        protocol_handshake_ms: None,
        x224_ms: None,
        tls_ms: None,
        total_ms: timeout_ms,
        jitter_ms: 0,
        error: Some(error),
        score_ms: timeout_ms,
        winner_eligible: false,
    }
}

async fn validate_finalist(
    candidate: CloudPrepareCandidate,
    first_sample: ProbeSample,
    timeout_ms: u64,
    service_kind: ServiceKind,
) -> CloudProbeResult {
    // Keep samples for one route sequential. With at most two finalist tasks,
    // this also caps physical protocol connections at two at any instant.
    let second = probe_sample(&candidate, timeout_ms, service_kind).await;
    tokio::time::sleep(Duration::from_millis(VALIDATION_SAMPLE_STAGGER_MS)).await;
    let third = probe_sample(&candidate, timeout_ms, service_kind).await;

    let mut samples = vec![first_sample];
    let mut failures = Vec::new();
    for sample in [second, third] {
        match sample {
            Ok(sample) => samples.push(sample),
            Err(error) => failures.push(error),
        }
    }

    summarize_samples(&candidate.binding_id, &samples, &failures, service_kind)
}

fn summarize_samples(
    binding_id: &str,
    samples: &[ProbeSample],
    failures: &[String],
    service_kind: ServiceKind,
) -> CloudProbeResult {
    let tcp_connect_ms = median(samples.iter().map(|sample| sample.tcp_connect_ms));
    let protocol_handshake_ms = median(samples.iter().map(|sample| sample.protocol_handshake_ms));
    let x224_ms = median_optional(samples.iter().filter_map(|sample| sample.x224_ms));
    let tls_ms = median_optional(samples.iter().filter_map(|sample| sample.tls_ms));
    let total_ms = median(samples.iter().map(|sample| sample.total_ms));
    let min_total_ms = samples
        .iter()
        .map(|sample| sample.total_ms)
        .min()
        .unwrap_or(total_ms);
    let max_total_ms = samples
        .iter()
        .map(|sample| sample.total_ms)
        .max()
        .unwrap_or(total_ms);
    let jitter_ms = max_total_ms.saturating_sub(min_total_ms);
    let score_ms = total_ms
        .saturating_add(jitter_ms.saturating_mul(2))
        .saturating_add((failures.len() as u64).saturating_mul(FAILED_SAMPLE_PENALTY_MS));
    let ok = samples.len() >= 2;

    CloudProbeResult {
        binding_id: binding_id.to_string(),
        service_kind,
        validation_mode: "cold_start".to_string(),
        ok,
        tcp_connect_ms: Some(tcp_connect_ms),
        protocol_handshake_ms: Some(protocol_handshake_ms),
        x224_ms,
        tls_ms,
        total_ms,
        jitter_ms,
        error: (!ok).then(|| {
            format!(
                "probe_unstable:{}/{}:{}",
                samples.len(),
                VALIDATED_SAMPLE_COUNT,
                failures
                    .last()
                    .map(String::as_str)
                    .unwrap_or("probe_failed")
            )
        }),
        score_ms,
        winner_eligible: ok,
    }
}

fn median(values: impl Iterator<Item = u64>) -> u64 {
    let mut values = values.collect::<Vec<_>>();
    values.sort_unstable();
    values[values.len() / 2]
}

fn median_optional(values: impl Iterator<Item = u64>) -> Option<u64> {
    let mut values = values.collect::<Vec<_>>();
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    Some(values[values.len() / 2])
}

async fn probe_sample(
    candidate: &CloudPrepareCandidate,
    timeout_ms: u64,
    service_kind: ServiceKind,
) -> Result<ProbeSample, String> {
    match timeout(
        Duration::from_millis(timeout_ms),
        probe_once(candidate, service_kind),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err("probe_timeout".to_string()),
    }
}

async fn probe_once(
    candidate: &CloudPrepareCandidate,
    service_kind: ServiceKind,
) -> Result<ProbeSample, String> {
    match service_kind {
        ServiceKind::Rdp => probe_rdp_once(candidate).await,
        ServiceKind::Ssh => probe_ssh_once(candidate).await,
    }
}

async fn connect_candidate(
    candidate: &CloudPrepareCandidate,
) -> Result<(TcpStream, u64, Instant), String> {
    let total_started = Instant::now();
    let addr = format!("{}:{}", candidate.endpoint.host, candidate.endpoint.port);
    let tcp_started = Instant::now();
    let tcp = TcpStream::connect(&addr)
        .await
        .map_err(|error| format!("tcp_connect_failed:{error}"))?;
    let tcp_connect_ms = tcp_started.elapsed().as_millis() as u64;
    Ok((tcp, tcp_connect_ms, total_started))
}

async fn probe_rdp_once(candidate: &CloudPrepareCandidate) -> Result<ProbeSample, String> {
    let (mut tcp, tcp_connect_ms, total_started) = connect_candidate(candidate).await?;

    let x224_started = Instant::now();
    tcp.write_all(RDP_X224_CONNECTION_REQUEST)
        .await
        .map_err(|error| format!("x224_write_failed:{error}"))?;
    tcp.flush()
        .await
        .map_err(|error| format!("x224_flush_failed:{error}"))?;
    let mut response = [0_u8; 128];
    let bytes = tcp
        .read(&mut response)
        .await
        .map_err(|error| format!("x224_read_failed:{error}"))?;
    if bytes == 0 {
        return Err("x224_empty_response".to_string());
    }
    let x224_ms = x224_started.elapsed().as_millis() as u64;

    let tls_started = Instant::now();
    let connector = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .build()
        .map_err(|error| format!("tls_connector_failed:{error}"))?;
    let connector = tokio_native_tls::TlsConnector::from(connector);
    let mut tls = connector
        .connect(&candidate.endpoint.host, tcp)
        .await
        .map_err(|error| format!("tls_handshake_failed:{error}"))?;
    let _ = tls.shutdown().await;
    let tls_ms = tls_started.elapsed().as_millis() as u64;

    Ok(ProbeSample {
        tcp_connect_ms,
        protocol_handshake_ms: x224_ms.saturating_add(tls_ms),
        x224_ms: Some(x224_ms),
        tls_ms: Some(tls_ms),
        total_ms: total_started.elapsed().as_millis() as u64,
    })
}

async fn probe_ssh_once(candidate: &CloudPrepareCandidate) -> Result<ProbeSample, String> {
    let (tcp, tcp_connect_ms, total_started) = connect_candidate(candidate).await?;
    let banner_started = Instant::now();
    read_ssh_identification(tcp).await?;
    let protocol_handshake_ms = banner_started.elapsed().as_millis() as u64;

    Ok(ProbeSample {
        tcp_connect_ms,
        protocol_handshake_ms,
        x224_ms: None,
        tls_ms: None,
        total_ms: total_started.elapsed().as_millis() as u64,
    })
}

async fn read_ssh_identification(tcp: TcpStream) -> Result<(), String> {
    let mut reader = BufReader::new(tcp);
    let mut total_bytes = 0usize;
    for _ in 0..SSH_MAX_PRE_BANNER_LINES {
        let mut line = Vec::new();
        let bytes = loop {
            let available = reader
                .fill_buf()
                .await
                .map_err(|error| format!("ssh_banner_read_failed:{error}"))?;
            if available.is_empty() {
                break line.len();
            }
            let newline = available.iter().position(|byte| *byte == b'\n');
            let chunk_len = newline.map_or(available.len(), |position| position + 1);
            let remaining = SSH_MAX_BANNER_BYTES.saturating_sub(total_bytes + line.len());
            if chunk_len > remaining {
                return Err("ssh_banner_too_large".to_string());
            }
            line.extend_from_slice(&available[..chunk_len]);
            reader.consume(chunk_len);
            if newline.is_some() {
                break line.len();
            }
        };
        if bytes == 0 {
            return Err("ssh_banner_empty_response".to_string());
        }
        total_bytes = total_bytes.saturating_add(bytes);
        if total_bytes > SSH_MAX_BANNER_BYTES {
            return Err("ssh_banner_too_large".to_string());
        }
        while matches!(line.last(), Some(b'\r' | b'\n')) {
            line.pop();
        }
        if line.starts_with(b"SSH-2.0-") {
            return Ok(());
        }
        if line.starts_with(b"SSH-") {
            return Err("ssh_banner_unsupported_version".to_string());
        }
    }
    Err("ssh_banner_missing_identification".to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        direct_candidate, probe_candidates_for_connection, probe_candidates_for_service,
        probe_candidates_for_service_with_policy, read_ssh_identification, select_active_indices,
        select_finalist_indices, select_intelligent_route, select_winner, summarize_samples,
        CloudProbeResult, EffectiveRacePolicy, InitialProbe, IntelligentRouteChoice, ProbeSample,
        DEFAULT_COLD_START_BUDGET_MS, DEFAULT_HISTORY_FAST_PATH_BUDGET_MS,
        DEFAULT_SECOND_CANDIDATE_DELAY_MS, DIRECT_CANDIDATE_ID, FINALIST_COUNT,
        MAX_ACTIVE_CLOUD_VALIDATIONS, SSH_MAX_BANNER_BYTES, VALIDATED_SAMPLE_COUNT,
    };
    use crate::cloud_gateway::{
        CloudEndpoint, CloudFastPathDiagnostics, CloudPrepareCandidate, CloudRacePolicy,
        CloudRouteDiagnostics,
    };
    use crate::connection_resolver::ServiceKind;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    use tokio::io::AsyncWriteExt;
    use tokio::net::{TcpListener, TcpStream};
    use tokio::time::timeout;

    fn result(
        binding_id: &str,
        ok: bool,
        total_ms: u64,
        score_ms: u64,
        winner_eligible: bool,
    ) -> CloudProbeResult {
        CloudProbeResult {
            binding_id: binding_id.to_string(),
            service_kind: ServiceKind::Rdp,
            validation_mode: "cold_start".to_string(),
            ok,
            tcp_connect_ms: Some(1),
            protocol_handshake_ms: Some(total_ms.saturating_sub(1)),
            x224_ms: Some(1),
            tls_ms: Some(total_ms.saturating_sub(2)),
            total_ms,
            jitter_ms: 0,
            error: (!ok).then(|| "probe_failed".to_string()),
            score_ms,
            winner_eligible,
        }
    }

    fn sample(total_ms: u64) -> ProbeSample {
        ProbeSample {
            tcp_connect_ms: total_ms / 4,
            protocol_handshake_ms: total_ms.saturating_mul(3) / 4,
            x224_ms: Some(total_ms / 4),
            tls_ms: Some(total_ms / 2),
            total_ms,
        }
    }

    fn initial_probe(binding_id: &str, total_ms: u64) -> InitialProbe {
        InitialProbe {
            candidate: CloudPrepareCandidate {
                binding_id: binding_id.to_string(),
                endpoint: CloudEndpoint {
                    host: "127.0.0.1".to_string(),
                    port: 22,
                    protocols: vec!["tcp".to_string()],
                },
                expires_at: String::new(),
                route_diagnostics: None,
            },
            sample: Ok(sample(total_ms)),
        }
    }

    fn trusted_candidate(binding_id: &str, port: u16) -> CloudPrepareCandidate {
        CloudPrepareCandidate {
            binding_id: binding_id.to_string(),
            endpoint: CloudEndpoint {
                host: "127.0.0.1".to_string(),
                port,
                protocols: vec!["tcp".to_string()],
            },
            expires_at: "2026-08-10T00:00:00Z".to_string(),
            route_diagnostics: Some(CloudRouteDiagnostics {
                fast_path: Some(CloudFastPathDiagnostics {
                    eligible: true,
                    reason: "trusted".to_string(),
                    confidence: 1.0,
                    sample_count: 8,
                    success_ewma: Some(0.98),
                    consecutive_failures: 0,
                    expires_at: Some("2026-08-10T00:05:00Z".to_string()),
                    scope: "network_exact".to_string(),
                    ..Default::default()
                }),
                ..Default::default()
            }),
        }
    }

    fn cold_candidate(binding_id: &str, port: u16) -> CloudPrepareCandidate {
        CloudPrepareCandidate {
            binding_id: binding_id.to_string(),
            endpoint: CloudEndpoint {
                host: "127.0.0.1".to_string(),
                port,
                protocols: vec!["tcp".to_string()],
            },
            expires_at: "2026-08-10T00:00:00Z".to_string(),
            route_diagnostics: None,
        }
    }

    fn race_policy(delay_ms: u64) -> CloudRacePolicy {
        CloudRacePolicy {
            schema_version: 1,
            second_candidate_delay_ms: delay_ms,
            history_fast_path_budget_ms: 500,
            cold_start_budget_ms: 1_500,
            max_active_cloud_validations: 2,
        }
    }

    #[test]
    fn malformed_remote_race_policy_cannot_expand_local_budgets_or_concurrency() {
        let policy = CloudRacePolicy {
            schema_version: 1,
            second_candidate_delay_ms: 50_000,
            history_fast_path_budget_ms: 50_000,
            cold_start_budget_ms: 50_000,
            max_active_cloud_validations: usize::MAX,
        };
        let effective = EffectiveRacePolicy::from_gateway(Some(&policy));

        assert_eq!(
            effective.second_candidate_delay_ms,
            DEFAULT_SECOND_CANDIDATE_DELAY_MS
        );
        assert_eq!(
            effective.history_fast_path_budget_ms,
            DEFAULT_HISTORY_FAST_PATH_BUDGET_MS
        );
        assert_eq!(effective.cold_start_budget_ms, DEFAULT_COLD_START_BUDGET_MS);
        assert_eq!(
            effective.max_active_cloud_validations,
            MAX_ACTIVE_CLOUD_VALIDATIONS
        );
    }

    #[test]
    fn select_winner_uses_lowest_stability_score() {
        let results = vec![
            result("bnd_stable", true, 180, 190, true),
            result("bnd_fail", false, 10, 10, false),
            result("bnd_unstable", true, 120, 920, true),
        ];
        assert_eq!(select_winner(&results).unwrap().binding_id, "bnd_stable");
    }

    #[test]
    fn select_winner_keeps_response_order_on_tie() {
        let results = vec![
            result("bnd_first", true, 200, 220, true),
            result("bnd_second", true, 190, 220, true),
        ];
        assert_eq!(select_winner(&results).unwrap().binding_id, "bnd_first");
    }

    #[test]
    fn select_winner_returns_none_when_all_failed() {
        let results = vec![
            result("bnd_a", false, 2500, 2500, false),
            result("bnd_b", false, 2500, 2500, false),
        ];
        assert!(select_winner(&results).is_none());
    }

    #[test]
    fn intelligent_mode_keeps_healthy_direct_when_cloud_win_is_marginal() {
        let results = vec![
            result(DIRECT_CANDIDATE_ID, true, 100, 100, true),
            result("bnd_cloud", true, 86, 86, true),
        ];
        assert!(matches!(
            select_intelligent_route(&results),
            IntelligentRouteChoice::Direct(_)
        ));
    }

    #[test]
    fn intelligent_mode_uses_cloud_only_for_a_material_advantage() {
        let results = vec![
            result(DIRECT_CANDIDATE_ID, true, 100, 100, true),
            result("bnd_cloud", true, 65, 65, true),
        ];
        assert!(matches!(
            select_intelligent_route(&results),
            IntelligentRouteChoice::Cloud(candidate) if candidate.binding_id == "bnd_cloud"
        ));
    }

    #[test]
    fn intelligent_mode_uses_the_only_healthy_candidate() {
        let cloud_failed = vec![
            result(DIRECT_CANDIDATE_ID, true, 120, 120, true),
            result("bnd_cloud", false, 50, 50, false),
        ];
        assert!(matches!(
            select_intelligent_route(&cloud_failed),
            IntelligentRouteChoice::Direct(_)
        ));

        let direct_failed = vec![
            result(DIRECT_CANDIDATE_ID, false, 120, 120, false),
            result("bnd_cloud", true, 80, 80, true),
        ];
        assert!(matches!(
            select_intelligent_route(&direct_failed),
            IntelligentRouteChoice::Cloud(_)
        ));
    }

    #[test]
    fn intelligent_validation_always_keeps_direct_and_the_fastest_cloud() {
        let probes = vec![
            initial_probe("bnd_cloud_fast", 80),
            initial_probe("bnd_cloud_second", 85),
            initial_probe(DIRECT_CANDIDATE_ID, 100),
        ];

        let finalist_ids = select_finalist_indices(&probes)
            .into_iter()
            .map(|(index, _)| probes[index].candidate.binding_id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(finalist_ids, vec![DIRECT_CANDIDATE_ID, "bnd_cloud_fast"]);
    }

    #[test]
    fn successful_non_finalist_stays_successful_but_cannot_win() {
        let results = vec![
            result("bnd_finalist", true, 180, 240, true),
            result("bnd_non_finalist", true, 120, 120, false),
        ];

        assert!(results[1].ok);
        assert_eq!(results[1].error, None);
        assert_eq!(select_winner(&results).unwrap().binding_id, "bnd_finalist");
    }

    #[test]
    fn finalist_accepts_two_successes_but_penalizes_one_failure() {
        let samples = vec![sample(125), sample(140)];
        let failures = vec!["probe_timeout".to_string()];
        let result = summarize_samples("bnd_unstable", &samples, &failures, ServiceKind::Rdp);

        assert!(result.ok);
        assert_eq!(result.total_ms, 140);
        assert_eq!(result.jitter_ms, 15);
        assert_eq!(result.score_ms, 970);
    }

    #[test]
    fn finalist_rejects_only_one_successful_sample() {
        let samples = vec![sample(125)];
        let failures = vec!["probe_timeout".to_string(), "probe_timeout".to_string()];
        let result = summarize_samples("bnd_bad", &samples, &failures, ServiceKind::Rdp);

        assert!(!result.ok);
        assert_eq!(result.score_ms, 1725);
        assert!(result.error.unwrap().starts_with("probe_unstable:1/3"));
    }

    #[test]
    fn connection_phase_validates_only_two_finalists_with_three_samples() {
        assert_eq!(FINALIST_COUNT, 2);
        assert_eq!(VALIDATED_SAMPLE_COUNT, 3);
    }

    #[test]
    fn active_race_prioritizes_trusted_history_and_limits_cloud_routes() {
        let candidates = vec![
            cold_candidate("cold-first", 1),
            trusted_candidate("trusted", 2),
            cold_candidate("cold-third", 3),
            direct_candidate("127.0.0.1", 4, ServiceKind::Ssh),
        ];

        let active = select_active_indices(&candidates, 2)
            .into_iter()
            .map(|index| candidates[index].binding_id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(active, vec!["trusted", "cold-first", DIRECT_CANDIDATE_ID]);
    }

    #[tokio::test]
    async fn trusted_history_is_live_checked_and_finishes_inside_fast_budget() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let trusted_port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            stream
                .write_all(b"SSH-2.0-HistoryFastPath\r\n")
                .await
                .unwrap();
        });
        let refused = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let direct_port = refused.local_addr().unwrap().port();
        drop(refused);
        let candidates = vec![
            trusted_candidate("trusted", trusted_port),
            direct_candidate("127.0.0.1", direct_port, ServiceKind::Ssh),
        ];
        let started = Instant::now();

        let results = probe_candidates_for_service_with_policy(
            &candidates,
            2_500,
            ServiceKind::Ssh,
            Some(&race_policy(150)),
        )
        .await;

        server.await.unwrap();
        assert!(started.elapsed() < Duration::from_millis(500));
        assert!(results[0].ok && results[0].winner_eligible);
        assert!(!results[1].ok);
        assert!(results
            .iter()
            .all(|result| result.validation_mode == "history_fast_path"));
    }

    #[tokio::test]
    async fn live_failure_vetoes_trusted_history_and_uses_healthy_backup() {
        let unreachable = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let unreachable_port = unreachable.local_addr().unwrap().port();
        drop(unreachable);
        let backup = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backup_port = backup.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            for _ in 0..VALIDATED_SAMPLE_COUNT {
                let (mut stream, _) = backup.accept().await.unwrap();
                stream
                    .write_all(b"SSH-2.0-HealthyBackup\r\n")
                    .await
                    .unwrap();
            }
        });
        let candidates = vec![
            trusted_candidate("trusted-unreachable", unreachable_port),
            cold_candidate("healthy-backup", backup_port),
        ];

        let results = probe_candidates_for_service_with_policy(
            &candidates,
            2_500,
            ServiceKind::Ssh,
            Some(&race_policy(150)),
        )
        .await;

        server.await.unwrap();
        assert!(!results[0].ok && !results[0].winner_eligible);
        assert!(results[1].ok && results[1].winner_eligible);
        assert_eq!(
            select_winner(&results).unwrap().binding_id,
            "healthy-backup"
        );
    }

    #[tokio::test]
    async fn second_cloud_candidate_is_staggered_and_third_is_not_opened() {
        let first = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let first_port = first.local_addr().unwrap().port();
        let second = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let second_port = second.local_addr().unwrap().port();
        let third = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let third_port = third.local_addr().unwrap().port();
        let accepted = Arc::new(Mutex::new(Vec::new()));
        let started = Instant::now();
        let first_times = accepted.clone();
        let first_server = tokio::spawn(async move {
            for _ in 0..VALIDATED_SAMPLE_COUNT {
                let (mut stream, _) = first.accept().await.unwrap();
                first_times
                    .lock()
                    .unwrap()
                    .push(("first", started.elapsed()));
                stream.write_all(b"SSH-2.0-First\r\n").await.unwrap();
            }
        });
        let second_times = accepted.clone();
        let second_server = tokio::spawn(async move {
            for _ in 0..VALIDATED_SAMPLE_COUNT {
                let (mut stream, _) = second.accept().await.unwrap();
                second_times
                    .lock()
                    .unwrap()
                    .push(("second", started.elapsed()));
                stream.write_all(b"SSH-2.0-Second\r\n").await.unwrap();
            }
        });
        let candidates = vec![
            cold_candidate("first", first_port),
            cold_candidate("second", second_port),
            cold_candidate("third", third_port),
        ];

        let results = probe_candidates_for_service_with_policy(
            &candidates,
            2_500,
            ServiceKind::Ssh,
            Some(&race_policy(150)),
        )
        .await;

        first_server.await.unwrap();
        second_server.await.unwrap();
        let times = accepted.lock().unwrap();
        let first_at = times.iter().find(|(name, _)| *name == "first").unwrap().1;
        let second_at = times.iter().find(|(name, _)| *name == "second").unwrap().1;
        assert!(second_at.saturating_sub(first_at) >= Duration::from_millis(120));
        assert_eq!(
            results[2].error.as_deref(),
            Some("probe_not_started_or_budget_exhausted")
        );
        assert!(timeout(Duration::from_millis(80), third.accept())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn cold_race_cancels_hanging_probes_at_the_policy_budget() {
        let first = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let first_port = first.local_addr().unwrap().port();
        let second = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let second_port = second.local_addr().unwrap().port();
        let first_server = tokio::spawn(async move {
            let (_stream, _) = first.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(2)).await;
        });
        let second_server = tokio::spawn(async move {
            let (_stream, _) = second.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(2)).await;
        });
        let candidates = vec![
            cold_candidate("hanging-first", first_port),
            cold_candidate("hanging-second", second_port),
        ];
        let mut policy = race_policy(100);
        policy.cold_start_budget_ms = 600;
        let started = Instant::now();

        let results = probe_candidates_for_service_with_policy(
            &candidates,
            2_500,
            ServiceKind::Ssh,
            Some(&policy),
        )
        .await;

        assert!(started.elapsed() < Duration::from_millis(750));
        assert!(select_winner(&results).is_none());
        first_server.abort();
        second_server.abort();
    }

    #[tokio::test]
    async fn connection_recovers_a_slow_but_healthy_candidate() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            for _ in 0..3 {
                let (mut stream, _) = listener.accept().await.unwrap();
                tokio::time::sleep(Duration::from_millis(1_200)).await;
                let _ = stream.write_all(b"SSH-2.0-SlowRelay\r\n").await;
            }
        });

        let results = probe_candidates_for_connection(
            &[cold_candidate("slow-relay", port)],
            2_500,
            ServiceKind::Ssh,
            Some(&race_policy(150)),
        )
        .await;

        server.abort();
        assert_eq!(
            select_winner(&results).map(|winner| winner.binding_id.as_str()),
            Some("slow-relay")
        );
    }

    #[tokio::test]
    async fn connection_recovery_checks_a_candidate_skipped_by_the_fast_race() {
        let unused = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let unavailable_port = unused.local_addr().unwrap().port();
        drop(unused);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let healthy_port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                stream.write_all(b"SSH-2.0-Backup\r\n").await.unwrap();
            }
        });

        let results = probe_candidates_for_connection(
            &[
                cold_candidate("unavailable-first", unavailable_port),
                cold_candidate("unavailable-second", unavailable_port),
                cold_candidate("healthy-third", healthy_port),
            ],
            2_500,
            ServiceKind::Ssh,
            Some(&race_policy(150)),
        )
        .await;

        server.await.unwrap();
        assert_eq!(
            select_winner(&results).map(|winner| winner.binding_id.as_str()),
            Some("healthy-third")
        );
    }

    #[tokio::test]
    async fn ssh_probe_accepts_banner_without_key_exchange() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            for _ in 0..VALIDATED_SAMPLE_COUNT {
                let (mut stream, _) = listener.accept().await.unwrap();
                stream
                    .write_all(b"Authorized access only\r\nSSH-2.0-NextDeskProbe\r\n")
                    .await
                    .unwrap();
            }
        });
        let candidate = CloudPrepareCandidate {
            binding_id: "bnd_ssh".to_string(),
            endpoint: CloudEndpoint {
                host: "127.0.0.1".to_string(),
                port,
                protocols: vec!["tcp".to_string()],
            },
            expires_at: "2026-08-01T00:00:00Z".to_string(),
            route_diagnostics: None,
        };

        let results = probe_candidates_for_service(&[candidate], 2_500, ServiceKind::Ssh).await;

        server.await.unwrap();
        assert_eq!(results.len(), 1);
        assert!(
            results[0].ok,
            "SSH banner should make the candidate eligible"
        );
        assert_eq!(results[0].service_kind, ServiceKind::Ssh);
        assert!(results[0].protocol_handshake_ms.is_some());
        assert_eq!(results[0].x224_ms, None);
        assert_eq!(results[0].tls_ms, None);
    }

    #[tokio::test]
    async fn ssh_identification_rejects_an_unbounded_pre_banner_line() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            stream
                .write_all(&vec![b'x'; SSH_MAX_BANNER_BYTES + 1])
                .await
                .unwrap();
        });
        let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();

        let result = read_ssh_identification(stream).await;

        server.await.unwrap();
        assert_eq!(result.unwrap_err(), "ssh_banner_too_large");
    }
}

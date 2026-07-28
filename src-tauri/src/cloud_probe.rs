use crate::cloud_gateway::CloudPrepareCandidate;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

// Probe every route once, then validate only the two fastest routes. The two
// validation samples are staggered but concurrent so route selection remains
// bounded by the Gateway-provided timeout.
const FINALIST_COUNT: usize = 2;
const VALIDATED_SAMPLE_COUNT: usize = 3;
const FIRST_SAMPLE_TIMEOUT_CAP_MS: u64 = 1_100;
const VALIDATION_SAMPLE_TIMEOUT_CAP_MS: u64 = 1_200;
const MIN_VALIDATION_SAMPLE_TIMEOUT_MS: u64 = 150;
const VALIDATION_SAMPLE_STAGGER_MS: u64 = 60;
const FAILED_SAMPLE_PENALTY_MS: u64 = 800;

const RDP_X224_CONNECTION_REQUEST: &[u8] = &[
    0x03, 0x00, 0x00, 0x13, 0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x08, 0x00, 0x03,
    0x00, 0x00, 0x00,
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CloudProbeResult {
    pub binding_id: String,
    pub ok: bool,
    pub tcp_connect_ms: Option<u64>,
    pub x224_ms: Option<u64>,
    pub tls_ms: Option<u64>,
    pub total_ms: u64,
    pub error: Option<String>,
    #[serde(skip)]
    pub score_ms: u64,
    #[serde(skip)]
    pub winner_eligible: bool,
}

#[derive(Debug, Clone, Copy)]
struct ProbeSample {
    tcp_connect_ms: u64,
    x224_ms: u64,
    tls_ms: u64,
    total_ms: u64,
}

struct InitialProbe {
    candidate: CloudPrepareCandidate,
    sample: Result<ProbeSample, String>,
}

pub async fn probe_candidates(
    candidates: &[CloudPrepareCandidate],
    timeout_ms: u64,
) -> Vec<CloudProbeResult> {
    let overall_timeout_ms = timeout_ms.max(500);
    let started = Instant::now();
    let first_sample_timeout_ms = overall_timeout_ms.min(FIRST_SAMPLE_TIMEOUT_CAP_MS);
    let futures = candidates.iter().cloned().map(|candidate| async move {
        let sample = probe_sample(&candidate, first_sample_timeout_ms).await;
        InitialProbe { candidate, sample }
    });
    let initial = futures_util::future::join_all(futures).await;
    let mut results = initial
        .iter()
        .map(|probe| initial_result(probe, first_sample_timeout_ms))
        .collect::<Vec<_>>();

    let mut finalist_indices = initial
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
    finalist_indices.sort_by_key(|(_, total_ms)| *total_ms);
    finalist_indices.truncate(FINALIST_COUNT);
    if finalist_indices.is_empty() {
        return results;
    }

    let elapsed_ms = started.elapsed().as_millis() as u64;
    let remaining_ms = overall_timeout_ms.saturating_sub(elapsed_ms);
    if remaining_ms <= VALIDATION_SAMPLE_STAGGER_MS + MIN_VALIDATION_SAMPLE_TIMEOUT_MS {
        return results;
    }
    let validation_timeout_ms = remaining_ms
        .saturating_sub(VALIDATION_SAMPLE_STAGGER_MS)
        .min(VALIDATION_SAMPLE_TIMEOUT_CAP_MS);
    if validation_timeout_ms < MIN_VALIDATION_SAMPLE_TIMEOUT_MS {
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

    let validation_futures = finalist_indices.into_iter().map(|(index, _)| {
        let candidate = initial[index].candidate.clone();
        let first_sample = *initial[index]
            .sample
            .as_ref()
            .expect("finalists always have an initial sample");
        async move {
            (
                index,
                validate_finalist(candidate, first_sample, validation_timeout_ms).await,
            )
        }
    });
    for (index, result) in futures_util::future::join_all(validation_futures).await {
        results[index] = result;
    }

    results
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

fn initial_result(probe: &InitialProbe, timeout_ms: u64) -> CloudProbeResult {
    match &probe.sample {
        Ok(sample) => CloudProbeResult {
            binding_id: probe.candidate.binding_id.clone(),
            ok: true,
            tcp_connect_ms: Some(sample.tcp_connect_ms),
            x224_ms: Some(sample.x224_ms),
            tls_ms: Some(sample.tls_ms),
            total_ms: sample.total_ms,
            error: None,
            score_ms: sample.total_ms,
            winner_eligible: true,
        },
        Err(error) => failed_result(&probe.candidate.binding_id, timeout_ms, error.clone()),
    }
}

fn failed_result(binding_id: &str, timeout_ms: u64, error: String) -> CloudProbeResult {
    CloudProbeResult {
        binding_id: binding_id.to_string(),
        ok: false,
        tcp_connect_ms: None,
        x224_ms: None,
        tls_ms: None,
        total_ms: timeout_ms,
        error: Some(error),
        score_ms: timeout_ms,
        winner_eligible: false,
    }
}

async fn validate_finalist(
    candidate: CloudPrepareCandidate,
    first_sample: ProbeSample,
    timeout_ms: u64,
) -> CloudProbeResult {
    let second = probe_sample(&candidate, timeout_ms);
    let third = async {
        tokio::time::sleep(Duration::from_millis(VALIDATION_SAMPLE_STAGGER_MS)).await;
        probe_sample(&candidate, timeout_ms).await
    };
    let (second, third) = tokio::join!(second, third);

    let mut samples = vec![first_sample];
    let mut failures = Vec::new();
    for sample in [second, third] {
        match sample {
            Ok(sample) => samples.push(sample),
            Err(error) => failures.push(error),
        }
    }

    summarize_samples(&candidate.binding_id, &samples, &failures)
}

fn summarize_samples(
    binding_id: &str,
    samples: &[ProbeSample],
    failures: &[String],
) -> CloudProbeResult {
    let tcp_connect_ms = median(samples.iter().map(|sample| sample.tcp_connect_ms));
    let x224_ms = median(samples.iter().map(|sample| sample.x224_ms));
    let tls_ms = median(samples.iter().map(|sample| sample.tls_ms));
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
        ok,
        tcp_connect_ms: Some(tcp_connect_ms),
        x224_ms: Some(x224_ms),
        tls_ms: Some(tls_ms),
        total_ms,
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

async fn probe_sample(
    candidate: &CloudPrepareCandidate,
    timeout_ms: u64,
) -> Result<ProbeSample, String> {
    match timeout(Duration::from_millis(timeout_ms), probe_once(candidate)).await {
        Ok(result) => result,
        Err(_) => Err("probe_timeout".to_string()),
    }
}

async fn probe_once(candidate: &CloudPrepareCandidate) -> Result<ProbeSample, String> {
    let total_started = Instant::now();
    let addr = format!("{}:{}", candidate.endpoint.host, candidate.endpoint.port);
    let tcp_started = Instant::now();
    let mut tcp = TcpStream::connect(&addr)
        .await
        .map_err(|error| format!("tcp_connect_failed:{error}"))?;
    let tcp_connect_ms = tcp_started.elapsed().as_millis() as u64;

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
        x224_ms,
        tls_ms,
        total_ms: total_started.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        select_winner, summarize_samples, CloudProbeResult, ProbeSample, FINALIST_COUNT,
        VALIDATED_SAMPLE_COUNT,
    };

    fn result(
        binding_id: &str,
        ok: bool,
        total_ms: u64,
        score_ms: u64,
        winner_eligible: bool,
    ) -> CloudProbeResult {
        CloudProbeResult {
            binding_id: binding_id.to_string(),
            ok,
            tcp_connect_ms: Some(1),
            x224_ms: Some(1),
            tls_ms: Some(total_ms.saturating_sub(2)),
            total_ms,
            error: (!ok).then(|| "probe_failed".to_string()),
            score_ms,
            winner_eligible,
        }
    }

    fn sample(total_ms: u64) -> ProbeSample {
        ProbeSample {
            tcp_connect_ms: total_ms / 4,
            x224_ms: total_ms / 4,
            tls_ms: total_ms / 2,
            total_ms,
        }
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
        let result = summarize_samples("bnd_unstable", &samples, &failures);

        assert!(result.ok);
        assert_eq!(result.total_ms, 140);
        assert_eq!(result.score_ms, 970);
    }

    #[test]
    fn finalist_rejects_only_one_successful_sample() {
        let samples = vec![sample(125)];
        let failures = vec!["probe_timeout".to_string(), "probe_timeout".to_string()];
        let result = summarize_samples("bnd_bad", &samples, &failures);

        assert!(!result.ok);
        assert_eq!(result.score_ms, 1725);
        assert!(result.error.unwrap().starts_with("probe_unstable:1/3"));
    }

    #[test]
    fn connection_phase_validates_only_two_finalists_with_three_samples() {
        assert_eq!(FINALIST_COUNT, 2);
        assert_eq!(VALIDATED_SAMPLE_COUNT, 3);
    }
}

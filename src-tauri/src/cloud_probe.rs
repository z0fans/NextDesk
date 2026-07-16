use crate::cloud_gateway::CloudPrepareCandidate;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

// Connection selection is latency-sensitive. One complete TCP + X.224 + TLS
// sample per candidate is enough to reject unusable routes without spending the
// entire Gateway-provided timeout budget on repeated serial handshakes.
const PROBE_SAMPLES: usize = 1;

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
}

pub async fn probe_candidates(
    candidates: &[CloudPrepareCandidate],
    timeout_ms: u64,
) -> Vec<CloudProbeResult> {
    let futures = candidates
        .iter()
        .cloned()
        .map(|candidate| probe_candidate(candidate, timeout_ms));
    futures_util::future::join_all(futures).await
}

pub fn select_winner(results: &[CloudProbeResult]) -> Option<&CloudProbeResult> {
    results
        .iter()
        .filter(|result| result.ok)
        .min_by_key(|result| result.total_ms)
}

async fn probe_candidate(candidate: CloudPrepareCandidate, timeout_ms: u64) -> CloudProbeResult {
    let deadline = Duration::from_millis(timeout_ms.max(500));
    match timeout(deadline, probe_candidate_inner(&candidate)).await {
        Ok(Ok((tcp_connect_ms, x224_ms, tls_ms, total_ms))) => CloudProbeResult {
            binding_id: candidate.binding_id,
            ok: true,
            tcp_connect_ms: Some(tcp_connect_ms),
            x224_ms: Some(x224_ms),
            tls_ms: Some(tls_ms),
            total_ms,
            error: None,
        },
        Ok(Err(error)) => CloudProbeResult {
            binding_id: candidate.binding_id,
            ok: false,
            tcp_connect_ms: None,
            x224_ms: None,
            tls_ms: None,
            total_ms: timeout_ms,
            error: Some(error),
        },
        Err(_) => CloudProbeResult {
            binding_id: candidate.binding_id,
            ok: false,
            tcp_connect_ms: None,
            x224_ms: None,
            tls_ms: None,
            total_ms: timeout_ms,
            error: Some("probe_timeout".to_string()),
        },
    }
}

async fn probe_candidate_inner(
    candidate: &CloudPrepareCandidate,
) -> Result<(u64, u64, u64, u64), String> {
    let mut samples = Vec::with_capacity(PROBE_SAMPLES);
    for index in 0..PROBE_SAMPLES {
        samples.push(probe_once(candidate).await?);
        if index + 1 < PROBE_SAMPLES {
            tokio::time::sleep(Duration::from_millis(60)).await;
        }
    }
    samples.sort_by_key(|sample| sample.3);
    samples
        .last()
        .copied()
        .ok_or_else(|| "probe_no_samples".to_string())
}

async fn probe_once(candidate: &CloudPrepareCandidate) -> Result<(u64, u64, u64, u64), String> {
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

    Ok((
        tcp_connect_ms,
        x224_ms,
        tls_ms,
        total_started.elapsed().as_millis() as u64,
    ))
}

#[cfg(test)]
mod tests {
    use super::{select_winner, CloudProbeResult, PROBE_SAMPLES};

    fn result(binding_id: &str, ok: bool, total_ms: u64) -> CloudProbeResult {
        CloudProbeResult {
            binding_id: binding_id.to_string(),
            ok,
            tcp_connect_ms: Some(1),
            x224_ms: Some(1),
            tls_ms: Some(total_ms.saturating_sub(2)),
            total_ms,
            error: (!ok).then(|| "probe_failed".to_string()),
        }
    }

    #[test]
    fn select_winner_uses_lowest_success_total() {
        let results = vec![
            result("bnd_slow", true, 300),
            result("bnd_fail", false, 10),
            result("bnd_fast", true, 120),
        ];
        assert_eq!(select_winner(&results).unwrap().binding_id, "bnd_fast");
    }

    #[test]
    fn select_winner_keeps_response_order_on_tie() {
        let results = vec![
            result("bnd_first", true, 200),
            result("bnd_second", true, 200),
        ];
        assert_eq!(select_winner(&results).unwrap().binding_id, "bnd_first");
    }

    #[test]
    fn select_winner_returns_none_when_all_failed() {
        let results = vec![result("bnd_a", false, 2500), result("bnd_b", false, 2500)];
        assert!(select_winner(&results).is_none());
    }

    #[test]
    fn connection_phase_uses_single_probe_sample() {
        assert_eq!(PROBE_SAMPLES, 1);
    }
}

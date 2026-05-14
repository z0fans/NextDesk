use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};

use crate::config;
use crate::state::{AppState, ProxyGroup, SyncState};
use crate::subscription;

const SYNC_INTERVAL_SECS: u64 = 24 * 60 * 60;
const RETRY_DELAY_SECS: u64 = 5 * 60;
const POLL_INTERVAL_SECS: u64 = 60;

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(scheduler_loop(app));
}

async fn scheduler_loop(app: AppHandle) {
    loop {
        tokio::time::sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;
        let state = app.state::<AppState>();
        if !should_sync(&state) {
            continue;
        }
        run_sync(&app, &state, true).await;
    }
}

fn should_sync(state: &AppState) -> bool {
    let enabled = *state.auto_update_enabled.lock().unwrap();
    if !enabled {
        return false;
    }
    let url = state.subscription_url.lock().unwrap().clone();
    if url.is_empty() {
        return false;
    }
    let last = *state.last_sync_ts.lock().unwrap();
    unix_now().saturating_sub(last) >= SYNC_INTERVAL_SECS
}

async fn run_sync(app: &AppHandle, state: &AppState, allow_retry: bool) {
    let url = state.subscription_url.lock().unwrap().clone();
    if url.is_empty() {
        return;
    }

    *state.sync_state.lock().unwrap() = SyncState::Syncing;
    emit_sync_state(app, state);

    match subscription::load_subscription(&url, None).await {
        Ok(parsed) => {
            let servers = subscription::transform_proxies_to_servers(&parsed.proxies);
            *state.servers.lock().unwrap() = servers.clone();

            let groups: Vec<ProxyGroup> = parsed
                .proxy_groups
                .iter()
                .filter_map(|g| {
                    let name = g.get("name")?.as_str()?.to_string();
                    let gtype = g.get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("select")
                        .to_string();
                    let proxies: Vec<String> = g
                        .get("proxies")
                        .and_then(|v| v.as_sequence())
                        .map(|seq| seq.iter().filter_map(|p| p.as_str().map(|s| s.to_string())).collect())
                        .unwrap_or_default();
                    Some(ProxyGroup { name, group_type: gtype, proxies, now: None })
                })
                .collect();
            *state.proxy_groups.lock().unwrap() = groups;

            if let Some(raw) = &parsed.raw_config {
                config::generate_clash_config_from_subscription(raw);
            } else {
                config::generate_clash_config(&parsed.proxies);
            }

            *state.last_sync_ts.lock().unwrap() = unix_now();
            *state.sync_state.lock().unwrap() = SyncState::Idle;
            persist_config(state);
            log::info!("[sub_scheduler] Auto-sync OK, {} servers", servers.len());
        }
        Err(err) => {
            log::warn!("[sub_scheduler] Auto-sync failed: {err}");
            *state.sync_state.lock().unwrap() = SyncState::Failed {
                error_category: classify_error(&err).to_string(),
                error_detail: err.clone(),
            };
            emit_sync_state(app, state);

            if allow_retry {
                log::info!("[sub_scheduler] Retry in {}s...", RETRY_DELAY_SECS);
                tokio::time::sleep(Duration::from_secs(RETRY_DELAY_SECS)).await;
                Box::pin(run_sync(app, state, false)).await;
                return;
            }
        }
    }
    emit_sync_state(app, state);
}

pub async fn trigger_sync(app: &AppHandle) {
    let state = app.state::<AppState>();
    run_sync(app, &state, true).await;
}

fn classify_error(err: &str) -> &'static str {
    let s = err.to_lowercase();
    if s.contains("timeout") || s.contains("connect") || s.contains("dns") || s.contains("resolve") {
        "network_error"
    } else if s.contains("401") || s.contains("403") || s.contains("unauthorized") {
        "subscription_invalid"
    } else {
        "unknown_error"
    }
}

fn emit_sync_state(app: &AppHandle, state: &AppState) {
    let sync_state = state.sync_state.lock().unwrap().clone();
    let last_sync_ts = *state.last_sync_ts.lock().unwrap();
    let enabled = *state.auto_update_enabled.lock().unwrap();
    let payload = serde_json::json!({
        "enabled": enabled,
        "last_sync_ts": last_sync_ts,
        "sync_state": sync_state,
    });
    let _ = app.emit("subscription_sync_state", payload);
}

fn persist_config(state: &AppState) {
    let saved = config::SavedConfig {
        subscription_url: state.subscription_url.lock().unwrap().clone(),
        servers: state.servers.lock().unwrap().clone(),
        proxy_groups: state.proxy_groups.lock().unwrap().clone(),
        tube_enabled: *state.tube_enabled.lock().unwrap(),
        cloud_mode: *state.cloud_mode.lock().unwrap(),
        dashboard_url: state.dashboard_url.lock().unwrap().clone(),
        relay_api_key: state.relay_api_key.lock().unwrap().clone(),
        auto_update_enabled: *state.auto_update_enabled.lock().unwrap(),
        last_sync_ts: *state.last_sync_ts.lock().unwrap(),
    };
    config::save_config(&saved);
}

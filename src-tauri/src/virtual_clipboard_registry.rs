use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::virtual_file_clipboard::VirtualClipboardFile;

#[derive(Debug, Clone)]
pub struct VirtualClipboardSnapshot {
    pub id: String,
    pub created_at_ms: u128,
    pub files: Vec<VirtualClipboardFile>,
}

fn registry() -> &'static Mutex<HashMap<String, VirtualClipboardSnapshot>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, VirtualClipboardSnapshot>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

pub fn store_virtual_clipboard_snapshot(
    files: &[VirtualClipboardFile],
) -> Result<VirtualClipboardSnapshot, String> {
    let created_at_ms = now_ms();
    let snapshot = VirtualClipboardSnapshot {
        id: format!("vc-{}", created_at_ms),
        created_at_ms,
        files: files.to_vec(),
    };

    let mut map = registry()
        .lock()
        .map_err(|_| "Virtual clipboard registry lock poisoned".to_string())?;
    prune_locked(&mut map, created_at_ms);
    map.insert(snapshot.id.clone(), snapshot.clone());
    Ok(snapshot)
}

pub fn get_virtual_clipboard_snapshot(
    id: &str,
) -> Result<Option<VirtualClipboardSnapshot>, String> {
    let map = registry()
        .lock()
        .map_err(|_| "Virtual clipboard registry lock poisoned".to_string())?;
    Ok(map.get(id).cloned())
}

fn prune_locked(
    map: &mut HashMap<String, VirtualClipboardSnapshot>,
    now: u128,
) {
    const MAX_AGE_MS: u128 = 30 * 60 * 1000;
    map.retain(|_, snapshot| now.saturating_sub(snapshot.created_at_ms) <= MAX_AGE_MS);
}

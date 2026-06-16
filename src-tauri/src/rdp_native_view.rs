use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeViewBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale_factor: f64,
    pub visible: bool,
}

pub type NativeViewBoundsStore = Arc<Mutex<HashMap<String, NativeViewBounds>>>;

#[derive(Debug, Clone, PartialEq)]
pub struct NativeViewHostState {
    pub bounds: NativeViewBounds,
    pub visible: bool,
    pub prepared: bool,
    pub generation: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeViewHostUpdate {
    pub created: bool,
    pub changed: bool,
    pub visible: bool,
    pub generation: u64,
}

pub type NativeViewHostStore = Arc<Mutex<HashMap<String, NativeViewHostState>>>;

impl NativeViewBounds {
    pub fn new(
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        scale_factor: f64,
        visible: bool,
    ) -> Result<Self, String> {
        let bounds = Self {
            x,
            y,
            width,
            height,
            scale_factor,
            visible,
        };
        bounds.validate()?;
        Ok(bounds)
    }

    fn validate(&self) -> Result<(), String> {
        for (name, value) in [
            ("x", self.x),
            ("y", self.y),
            ("width", self.width),
            ("height", self.height),
            ("scaleFactor", self.scale_factor),
        ] {
            if !value.is_finite() {
                return Err(format!("native view bound {name} must be finite"));
            }
        }
        if self.width < 0.0 || self.height < 0.0 {
            return Err("native view width/height must be non-negative".to_string());
        }
        if self.scale_factor <= 0.0 {
            return Err("native view scaleFactor must be positive".to_string());
        }
        Ok(())
    }
}

pub fn create_bounds_store() -> NativeViewBoundsStore {
    Arc::new(Mutex::new(HashMap::new()))
}

pub fn create_host_store() -> NativeViewHostStore {
    Arc::new(Mutex::new(HashMap::new()))
}

pub fn set_bounds(
    store: &NativeViewBoundsStore,
    tab_id: String,
    bounds: NativeViewBounds,
) -> Result<bool, String> {
    let mut store = store
        .lock()
        .map_err(|_| "native view bounds store mutex poisoned".to_string())?;
    let changed = store.get(&tab_id).copied() != Some(bounds);
    store.insert(tab_id, bounds);
    Ok(changed)
}

pub fn remove_bounds(store: &NativeViewBoundsStore, tab_id: &str) -> Result<(), String> {
    store
        .lock()
        .map_err(|_| "native view bounds store mutex poisoned".to_string())?
        .remove(tab_id);
    Ok(())
}

pub fn update_host_state(
    store: &NativeViewHostStore,
    tab_id: String,
    bounds: NativeViewBounds,
) -> Result<NativeViewHostUpdate, String> {
    let mut store = store
        .lock()
        .map_err(|_| "native view host store mutex poisoned".to_string())?;

    let mut created = false;
    let mut changed = false;
    let state = store.entry(tab_id).or_insert_with(|| {
        created = true;
        changed = true;
        NativeViewHostState {
            bounds,
            visible: bounds.visible,
            prepared: false,
            generation: 0,
        }
    });

    if state.bounds != bounds || state.visible != bounds.visible {
        changed = true;
        state.bounds = bounds;
        state.visible = bounds.visible;
        state.generation = state.generation.saturating_add(1);
    }

    Ok(NativeViewHostUpdate {
        created,
        changed,
        visible: state.visible,
        generation: state.generation,
    })
}

pub fn mark_host_prepared(store: &NativeViewHostStore, tab_id: &str) -> Result<(), String> {
    let mut store = store
        .lock()
        .map_err(|_| "native view host store mutex poisoned".to_string())?;
    if let Some(state) = store.get_mut(tab_id) {
        state.prepared = true;
    }
    Ok(())
}

pub fn remove_host(store: &NativeViewHostStore, tab_id: &str) -> Result<bool, String> {
    let removed = store
        .lock()
        .map_err(|_| "native view host store mutex poisoned".to_string())?
        .remove(tab_id)
        .is_some();
    Ok(removed)
}

#[cfg(target_os = "macos")]
pub fn prepare_native_host(app: &tauri::AppHandle, tab_id: &str) -> Result<(), String> {
    use tauri::Manager;

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main webview window not found".to_string())?;
    let tab_id = tab_id.to_string();
    window
        .with_webview(move |webview| {
            let ns_window = webview.ns_window();
            if ns_window.is_null() {
                log::warn!("[rdp-native-view] macOS NSWindow unavailable tab={tab_id}");
            } else {
                log::debug!(
                    "[rdp-native-view] macOS native host ready tab={} ns_window={:p}",
                    tab_id,
                    ns_window
                );
            }
        })
        .map_err(|err| format!("failed to schedule native host preparation: {err}"))
}

#[cfg(not(target_os = "macos"))]
pub fn prepare_native_host(_app: &tauri::AppHandle, tab_id: &str) -> Result<(), String> {
    log::debug!("[rdp-native-view] native host unsupported on this platform tab={tab_id}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_valid_bounds() {
        let bounds = NativeViewBounds::new(10.0, 20.0, 800.0, 600.0, 2.0, true).unwrap();

        assert_eq!(bounds.width, 800.0);
        assert!(bounds.visible);
    }

    #[test]
    fn rejects_invalid_bounds() {
        assert!(NativeViewBounds::new(0.0, 0.0, -1.0, 10.0, 1.0, true).is_err());
        assert!(NativeViewBounds::new(0.0, 0.0, 10.0, 10.0, 0.0, true).is_err());
        assert!(NativeViewBounds::new(f64::NAN, 0.0, 10.0, 10.0, 1.0, true).is_err());
    }

    #[test]
    fn set_bounds_reports_changes() {
        let store = create_bounds_store();
        let bounds = NativeViewBounds::new(0.0, 0.0, 100.0, 100.0, 1.0, true).unwrap();

        assert!(set_bounds(&store, "tab-1".to_string(), bounds).unwrap());
        assert!(!set_bounds(&store, "tab-1".to_string(), bounds).unwrap());
    }

    #[test]
    fn host_state_tracks_create_update_and_remove() {
        let store = create_host_store();
        let first = NativeViewBounds::new(0.0, 0.0, 100.0, 100.0, 1.0, true).unwrap();
        let second = NativeViewBounds::new(0.0, 0.0, 200.0, 100.0, 1.0, false).unwrap();

        let update = update_host_state(&store, "tab-1".to_string(), first).unwrap();
        assert!(update.created);
        assert!(update.changed);
        assert!(update.visible);
        assert_eq!(update.generation, 0);

        let update = update_host_state(&store, "tab-1".to_string(), first).unwrap();
        assert!(!update.created);
        assert!(!update.changed);
        assert_eq!(update.generation, 0);

        let update = update_host_state(&store, "tab-1".to_string(), second).unwrap();
        assert!(!update.created);
        assert!(update.changed);
        assert!(!update.visible);
        assert_eq!(update.generation, 1);

        mark_host_prepared(&store, "tab-1").unwrap();
        let state = store.lock().unwrap().get("tab-1").cloned().unwrap();
        assert!(state.prepared);

        assert!(remove_host(&store, "tab-1").unwrap());
        assert!(!remove_host(&store, "tab-1").unwrap());
    }
}

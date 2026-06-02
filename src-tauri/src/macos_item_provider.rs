use crate::virtual_file_clipboard::{VirtualClipboardFile, VirtualClipboardWriteResult};

#[cfg(target_os = "macos")]
use std::cell::RefCell;
#[cfg(target_os = "macos")]
use std::{env, fs, path::Path};

#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::{AnyThread, MainThreadMarker};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSItemProvider, NSString, NSURL};

#[cfg(target_os = "macos")]
thread_local! {
    static ACTIVE_ITEM_PROVIDERS: RefCell<Vec<Retained<NSItemProvider>>> = const { RefCell::new(Vec::new()) };
}

/// Create NSItemProvider instances backed by staged files.
///
/// NSItemProvider does NOT directly integrate with NSPasteboard's general
/// pasteboard for Cmd+V paste in Finder on macOS. The providers are stored
/// in a thread-local for drag-and-drop integration via `get_active_item_providers`.
///
/// This function always returns `Ok(None)` so the clipboard caller falls
/// back to the next strategy (pasteboard-promise, file-promise, etc.).
#[cfg(target_os = "macos")]
pub fn write_files_with_item_provider(
    files: &[VirtualClipboardFile],
) -> Result<Option<VirtualClipboardWriteResult>, String> {
    let _mtm = MainThreadMarker::new()
        .ok_or_else(|| "NSItemProvider must be created on the main thread".to_string())?;

    if files.is_empty() {
        return Ok(None);
    }

    log::info!(
        "[item-provider] creating NSItemProvider instances for {} file(s)",
        files.len()
    );

    let stage_root = item_provider_stage_root();
    fs::create_dir_all(&stage_root)
        .map_err(|e| format!("[item-provider] cannot create staging dir: {}", e))?;

    let mut providers = Vec::with_capacity(files.len());

    for file in files {
        let dest = unique_path_in_dir(&stage_root, &file.name);
        fs::write(&dest, &file.data)
            .map_err(|e| format!("[item-provider] stage write failed: {}", e))?;

        let path_str = dest.to_string_lossy().to_string();
        let ns_path = NSString::from_str(&path_str);
        let file_url = NSURL::fileURLWithPath(&ns_path);

        let provider = unsafe {
            NSItemProvider::initWithContentsOfURL(NSItemProvider::alloc(), Some(&file_url))
        };

        if let Some(provider) = provider {
            let file_name = NSString::from_str(&file.name);
            provider.setSuggestedName(Some(&file_name));

            let registered = provider.registeredTypeIdentifiers();
            log::info!(
                "[item-provider] created: file={} bytes={} utis={:?}",
                file.name,
                file.data.len(),
                registered.iter().map(|s| s.to_string()).collect::<Vec<_>>()
            );
            providers.push(provider);
        } else {
            log::warn!(
                "[item-provider] initWithContentsOfURL returned nil for {}",
                file.name
            );
        }
    }

    if providers.is_empty() {
        return Ok(None);
    }

    log::info!(
        "[item-provider] {} provider(s) stored for drag-and-drop; clipboard fallback to next strategy",
        providers.len()
    );

    ACTIVE_ITEM_PROVIDERS.with(|cell| {
        *cell.borrow_mut() = providers;
    });

    // Return None — NSItemProvider is not for general pasteboard clipboard paste.
    Ok(None)
}

#[cfg(target_os = "macos")]
fn item_provider_stage_root() -> std::path::PathBuf {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    env::temp_dir()
        .join("nextdesk-item-provider-stage")
        .join(format!("{}-{}", std::process::id(), millis))
}

#[cfg(target_os = "macos")]
fn unique_path_in_dir(dir: &Path, file_name: &str) -> std::path::PathBuf {
    let dest = dir.join(file_name);
    if !dest.exists() {
        return dest;
    }
    let stem = dest
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(file_name);
    let ext = dest
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_default();
    let mut counter = 1u32;
    loop {
        let candidate = dir.join(format!("{} ({}){}", stem, counter, ext));
        if !candidate.exists() {
            return candidate;
        }
        counter += 1;
    }
}

/// Returns the active NSItemProvider instances for drag-and-drop integration.
#[cfg(target_os = "macos")]
#[allow(dead_code)]
pub fn get_active_item_providers() -> Vec<Retained<NSItemProvider>> {
    ACTIVE_ITEM_PROVIDERS.with(|cell| cell.borrow().clone())
}

#[cfg(not(target_os = "macos"))]
pub fn write_files_with_item_provider(
    _files: &[VirtualClipboardFile],
) -> Result<Option<VirtualClipboardWriteResult>, String> {
    Ok(None)
}

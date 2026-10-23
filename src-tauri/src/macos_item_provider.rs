use crate::virtual_file_clipboard::{VirtualClipboardFile, VirtualClipboardWriteResult};

#[cfg(target_os = "macos")]
use crate::virtual_file_clipboard::{
    session_stage_root, validate_clipboard_files, write_unique_file_in_dir,
};
#[cfg(target_os = "macos")]
use std::cell::RefCell;
#[cfg(target_os = "macos")]
use std::fs;

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
    validate_clipboard_files(files)?;
    let _mtm = MainThreadMarker::new()
        .ok_or_else(|| "NSItemProvider must be created on the main thread".to_string())?;

    if files.is_empty() {
        return Ok(None);
    }

    log::info!(
        "[item-provider] creating NSItemProvider instances for {} file(s)",
        files.len()
    );

    let stage_root = session_stage_root(Some("native-item-provider"));
    fs::create_dir_all(&stage_root)
        .map_err(|e| format!("[item-provider] cannot create staging dir: {}", e))?;

    let mut providers = Vec::with_capacity(files.len());

    for file in files {
        let dest = write_unique_file_in_dir(&stage_root, &file.name, &file.data)?;

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

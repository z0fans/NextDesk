//! macOS: prevent the system from hiding the cursor while the user types.
//!
//! macOS automatically calls `[NSCursor setHiddenUntilMouseMoves:YES]` on
//! every keyDown event. For an RDP client this is unwanted — the remote
//! desktop cursor should stay visible at all times.
//!
//! We use Objective-C method swizzling to replace the implementation of
//! `+[NSCursor setHiddenUntilMouseMoves:]` with a no-op. This intercepts
//! the call BEFORE macOS can hide the cursor, which is more reliable than
//! a post-hoc NSEvent monitor (which fires after the cursor is already hidden).

#[cfg(target_os = "macos")]
mod imp {
    use objc2::runtime::{AnyClass, Bool, Sel};

    /// Replacement implementation for `+[NSCursor setHiddenUntilMouseMoves:]`.
    /// Does nothing — prevents macOS from hiding the cursor on typing.
    unsafe extern "C-unwind" fn noop_set_hidden(_cls: &AnyClass, _sel: Sel, _flag: Bool) {
        // Intentionally empty — cursor stays visible during keyboard input
    }

    pub fn install() {
        unsafe {
            let cls_name = c"NSCursor";
            let cls = AnyClass::get(cls_name).expect("[macos-cursor] NSCursor class not found");
            let sel = objc2::sel!(setHiddenUntilMouseMoves:);

            match cls.class_method(sel) {
                Some(method) => {
                    let new_imp: objc2::runtime::Imp =
                        std::mem::transmute(noop_set_hidden as *const ());
                    method.set_implementation(new_imp);
                    eprintln!(
                        "[macos] Cursor-hide swizzle installed (setHiddenUntilMouseMoves: → no-op)"
                    );
                }
                None => {
                    eprintln!(
                        "[macos] Warning: +[NSCursor setHiddenUntilMouseMoves:] method not found"
                    );
                }
            }
        }
    }
}

/// Swizzle `+[NSCursor setHiddenUntilMouseMoves:]` to a no-op.
/// Call once during `tauri::Builder::setup`.
#[cfg(target_os = "macos")]
pub fn install_cursor_unhide() {
    imp::install();
}

/// No-op on non-macOS platforms.
#[cfg(not(target_os = "macos"))]
pub fn install_cursor_unhide() {}

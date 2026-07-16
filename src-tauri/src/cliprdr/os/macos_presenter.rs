//! macOS NSFilePresenter for lazy clipboard paste.
//!
//! ## Why this exists
//!
//! When a user copies files from a remote desktop session, transferring all
//! file data upfront can be slow and wasteful (the user may never paste, or
//! may only paste a subset). NSFilePresenter lets us register a placeholder
//! file URL on NSPasteboard and intercept Finder's read coordination call so
//! we can fetch the real bytes on demand at paste time.
//!
//! ## Pattern (lemonmojo/RemoteFilesVsPasteboard)
//!
//! 1. Touch a zero-byte placeholder at a known path
//! 2. Register an `NSFilePresenter` whose `presentedItemURL` is that path
//! 3. Place the URL on `NSPasteboard` as `public.file-url` (caller's job)
//! 4. When the user pastes in Finder, `NSFileCoordinator` calls our
//!    `relinquishPresentedItemToReader:` before letting Finder read the file
//! 5. We synchronously run the fetch callback (writes real bytes to the path)
//! 6. We invoke the `reader` block — Finder then reads the now-populated file
//!
//! ## Apple's contract
//!
//! The reader block **must** be invoked, otherwise Finder/coordination hangs
//! forever waiting for us to relinquish. Even on fetch error we call the
//! reader (Finder will see whatever bytes are at the path — usually empty).
//!
//! ## Threading
//!
//! `[NSFileCoordinator addFilePresenter:]` does not strictly require the main
//! thread, but registration is part of a setup flow that typically runs on
//! the main thread (alongside pasteboard writes). We require a
//! `MainThreadMarker` for symmetry with the rest of the cliprdr backend.
//!
//! `relinquishPresentedItemToReader:` is dispatched onto our custom
//! `NSOperationQueue` — never the main thread — so blocking on the sync
//! fetch closure is safe and won't deadlock the UI.

#[cfg(target_os = "macos")]
mod imp {
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex, OnceLock};

    use block2::{DynBlock, RcBlock};
    use objc2::{
        define_class, msg_send,
        rc::Retained,
        runtime::{NSObject, NSObjectProtocol, ProtocolObject},
        AnyThread, DefinedClass,
    };
    use objc2_foundation::{NSFileCoordinator, NSFilePresenter, NSOperationQueue, NSString, NSURL};

    /// Sync fetch callback: given the local placeholder path, populate it with
    /// real bytes and return Ok. Errors are logged; reader is still invoked.
    pub type Fetcher = Arc<dyn Fn(&Path) -> Result<(), String> + Send + Sync>;

    fn active_fetchers() -> &'static Mutex<HashMap<PathBuf, Fetcher>> {
        static ACTIVE_FETCHERS: OnceLock<Mutex<HashMap<PathBuf, Fetcher>>> = OnceLock::new();
        ACTIVE_FETCHERS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn active_registration() -> &'static Mutex<Option<ActiveRegistration>> {
        static ACTIVE_REGISTRATION: OnceLock<Mutex<Option<ActiveRegistration>>> = OnceLock::new();
        ACTIVE_REGISTRATION.get_or_init(|| Mutex::new(None))
    }

    struct ActiveRegistration {
        owner: String,
        presenters: Vec<Retained<LazyPastePresenter>>,
    }

    struct LazyPastePresenterIvars {
        url: Retained<NSURL>,
        queue: Retained<NSOperationQueue>,
        local_path: PathBuf,
        fetcher: Fetcher,
    }

    define_class!(
        #[unsafe(super = NSObject)]
        #[name = "NextDeskLazyPastePresenter"]
        #[ivars = LazyPastePresenterIvars]
        struct LazyPastePresenter;

        unsafe impl NSObjectProtocol for LazyPastePresenter {}

        #[allow(non_snake_case)]
        unsafe impl NSFilePresenter for LazyPastePresenter {
            #[unsafe(method_id(presentedItemURL))]
            fn presentedItemURL(&self) -> Option<Retained<NSURL>> {
                Some(self.ivars().url.clone())
            }

            #[unsafe(method_id(presentedItemOperationQueue))]
            fn presentedItemOperationQueue(&self) -> Retained<NSOperationQueue> {
                self.ivars().queue.clone()
            }

            /// Finder/coordination is asking us to "let go" of the file so it
            /// can read it. This is our cue to lazily populate the bytes.
            ///
            /// Block signature in ObjC:
            ///   void (^reader)(void (^reacquirer)(void))
            ///
            /// We must always invoke `reader`, passing it a (possibly no-op)
            /// reacquirer block. Skipping that call hangs Finder.
            #[unsafe(method(relinquishPresentedItemToReader:))]
            fn relinquishPresentedItemToReader(
                &self,
                reader: &DynBlock<dyn Fn(*mut DynBlock<dyn Fn()>)>,
            ) {
                let path = &self.ivars().local_path;
                log::info!(
                    "[lazy-paste] relinquish requested for {} — fetching",
                    path.display()
                );

                // Synchronous fetch: this runs on our custom NSOperationQueue
                // thread, never the main thread, so blocking is fine.
                match (self.ivars().fetcher)(path) {
                    Ok(()) => log::info!("[lazy-paste] fetch ok for {}", path.display()),
                    Err(e) => log::warn!(
                        "[lazy-paste] fetch failed for {}: {} (calling reader anyway)",
                        path.display(),
                        e
                    ),
                }

                // Empty reacquirer — we don't need to do anything when Finder
                // is done reading. The file stays on disk; cliprdr backend
                // is responsible for cleanup at unregister time.
                let reacquirer: RcBlock<dyn Fn()> = RcBlock::new(|| {});
                let raw_reacq: *mut DynBlock<dyn Fn()> =
                    (&*reacquirer) as *const DynBlock<dyn Fn()> as *mut DynBlock<dyn Fn()>;

                // Always invoke reader, even if fetch failed — see module docs.
                reader.call((raw_reacq,));
            }
        }
    );

    impl LazyPastePresenter {
        fn new(url: Retained<NSURL>, local_path: PathBuf, fetcher: Fetcher) -> Retained<Self> {
            // Custom (non-main) operation queue: relinquish callbacks land
            // here, where blocking on sync I/O is safe.
            let queue = NSOperationQueue::new();

            let this = Self::alloc().set_ivars(LazyPastePresenterIvars {
                url,
                queue,
                local_path,
                fetcher,
            });
            unsafe { msg_send![super(this), init] }
        }
    }

    fn remove_presenters(presenters: &[Retained<LazyPastePresenter>]) {
        for presenter in presenters {
            let proto: &ProtocolObject<dyn NSFilePresenter> =
                ProtocolObject::from_ref(&**presenter);
            unsafe { NSFileCoordinator::removeFilePresenter(proto) };
        }
    }

    fn clear_fetchers() {
        if let Ok(mut fetchers) = active_fetchers().lock() {
            fetchers.clear();
        }
    }

    /// Register an NSFilePresenter for each path. The fetcher is invoked
    /// (synchronously, on a background queue) when Finder paste reads the file.
    ///
    /// Each path is touched as a zero-byte placeholder if it doesn't exist —
    /// `NSFileCoordinator` only routes reads through us when the URL points
    /// to a file that's actually on disk.
    pub fn register_lazy_paste(
        owner: &str,
        paths: &[PathBuf],
        fetcher: Fetcher,
    ) -> Result<(), String> {
        // NOTE: `[NSFileCoordinator addFilePresenter:]` is thread-safe per
        // Apple's documentation — it's safe to call from any thread, including
        // a tokio worker. (Earlier versions of this code required a
        // MainThreadMarker; that was over-cautious and broke registration
        // because IronRDP backend trait methods always run on a worker
        // thread, never the main thread.)

        if paths.is_empty() {
            return Ok(());
        }

        let mut registration = active_registration()
            .lock()
            .map_err(|_| "lazy presenter registry lock poisoned".to_string())?;
        if let Some(previous) = registration.take() {
            remove_presenters(&previous.presenters);
            clear_fetchers();
        }

        let mut new_presenters: Vec<Retained<LazyPastePresenter>> = Vec::with_capacity(paths.len());

        for path in paths {
            // Ensure placeholder exists. If parent is missing, create it.
            if !path.exists() {
                if let Some(parent) = path.parent() {
                    if let Err(e) = std::fs::create_dir_all(parent) {
                        return Err(format!(
                            "failed to create parent dir for {}: {}",
                            path.display(),
                            e
                        ));
                    }
                }
                if let Err(e) = std::fs::write(path, b"") {
                    return Err(format!(
                        "failed to create placeholder {}: {}",
                        path.display(),
                        e
                    ));
                }
            }

            let path_str = path.to_string_lossy().to_string();
            let ns_path = NSString::from_str(&path_str);
            // fileURLWithPath produces canonical file:// URL with proper
            // percent-encoding — what NSFileCoordinator expects.
            let url = unsafe { NSURL::fileURLWithPath(&ns_path) };

            let presenter = LazyPastePresenter::new(url, path.clone(), Arc::clone(&fetcher));

            new_presenters.push(presenter);
        }

        {
            let mut fetchers = active_fetchers()
                .lock()
                .map_err(|_| "lazy fetcher registry lock poisoned".to_string())?;
            fetchers.clear();
            for path in paths {
                fetchers.insert(path.clone(), Arc::clone(&fetcher));
            }
        }

        for (path, presenter) in paths.iter().zip(&new_presenters) {
            let proto: &ProtocolObject<dyn NSFilePresenter> =
                ProtocolObject::from_ref(&**presenter);
            unsafe { NSFileCoordinator::addFilePresenter(proto) };
            log::info!(
                "[lazy-paste] owner={} registered presenter for {}",
                owner,
                path.display()
            );
        }

        *registration = Some(ActiveRegistration {
            owner: owner.to_string(),
            presenters: new_presenters,
        });

        Ok(())
    }

    /// Remove the registration only when it is still owned by this RDP session.
    /// A stale session teardown must not unregister a newer session's presenters.
    pub fn unregister_lazy_paste_for(owner: &str) -> bool {
        let previous = {
            let Ok(mut registration) = active_registration().lock() else {
                return false;
            };
            if registration.as_ref().map(|entry| entry.owner.as_str()) != Some(owner) {
                return false;
            }
            registration.take()
        };

        if let Some(previous) = previous {
            let count = previous.presenters.len();
            remove_presenters(&previous.presenters);
            clear_fetchers();
            log::info!(
                "[lazy-paste] owner={} unregistered {} presenter(s)",
                owner,
                count
            );
            true
        } else {
            false
        }
    }

    /// Trigger the lazy file download for a registered placeholder path.
    ///
    /// Finder normally reaches the fetcher through NSFileCoordinator. RDP-to-RDP
    /// clipboard forwarding reads the path directly, so it has to call this
    /// hook before metadata/data reads or it will see the 0-byte placeholder.
    pub fn fetch_registered_path(path: &Path) -> Result<bool, String> {
        let fetcher = active_fetchers()
            .lock()
            .map_err(|_| "lazy fetcher registry lock poisoned".to_string())?
            .get(path)
            .cloned();

        let Some(fetcher) = fetcher else {
            return Ok(false);
        };

        log::info!(
            "[lazy-paste] explicit fetch requested for {}",
            path.display()
        );
        fetcher(path)?;
        Ok(true)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::atomic::{AtomicUsize, Ordering};

        #[test]
        fn stale_owner_cannot_unregister_newer_presenters() {
            let root = std::env::temp_dir().join(format!(
                "nextdesk-lazy-presenter-test-{}",
                std::process::id()
            ));
            let path_a = root.join("a.txt");
            let path_b = root.join("b.txt");
            let calls_a = Arc::new(AtomicUsize::new(0));
            let calls_b = Arc::new(AtomicUsize::new(0));

            let fetch_a: Fetcher = {
                let calls = Arc::clone(&calls_a);
                Arc::new(move |_| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
            };
            let fetch_b: Fetcher = {
                let calls = Arc::clone(&calls_b);
                Arc::new(move |_| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
            };

            register_lazy_paste("session-a", std::slice::from_ref(&path_a), fetch_a).unwrap();
            assert!(fetch_registered_path(&path_a).unwrap());
            assert_eq!(calls_a.load(Ordering::SeqCst), 1);

            register_lazy_paste("session-b", std::slice::from_ref(&path_b), fetch_b).unwrap();
            assert!(!unregister_lazy_paste_for("session-a"));
            assert!(fetch_registered_path(&path_b).unwrap());
            assert_eq!(calls_b.load(Ordering::SeqCst), 1);

            assert!(unregister_lazy_paste_for("session-b"));
            assert!(!fetch_registered_path(&path_b).unwrap());
            let _ = std::fs::remove_dir_all(root);
        }
    }
}

#[cfg(target_os = "macos")]
pub use imp::{fetch_registered_path, register_lazy_paste, unregister_lazy_paste_for, Fetcher};

// ── Stubs for non-macOS targets ───────────────────────────────────────────

#[cfg(not(target_os = "macos"))]
pub type Fetcher = std::sync::Arc<dyn Fn(&std::path::Path) -> Result<(), String> + Send + Sync>;

#[cfg(not(target_os = "macos"))]
pub fn register_lazy_paste(
    _owner: &str,
    _paths: &[std::path::PathBuf],
    _fetcher: Fetcher,
) -> Result<(), String> {
    Err("not supported on this platform".to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn unregister_lazy_paste_for(_owner: &str) -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
pub fn fetch_registered_path(_path: &std::path::Path) -> Result<bool, String> {
    Ok(false)
}

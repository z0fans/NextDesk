use crate::virtual_file_clipboard::{VirtualClipboardFile, VirtualClipboardWriteResult};

#[cfg(target_os = "macos")]
use std::{cell::RefCell, fs, path::PathBuf, ptr};

#[cfg(target_os = "macos")]
use block2::DynBlock;
#[cfg(target_os = "macos")]
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{NSObject, NSObjectProtocol, ProtocolObject},
    DefinedClass, MainThreadMarker, MainThreadOnly,
};
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSFilePromiseProvider, NSFilePromiseProviderDelegate, NSPasteboard};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSArray, NSError, NSString, NSURL};

#[cfg(target_os = "macos")]
thread_local! {
    static ACTIVE_PROMISE_DELEGATES: RefCell<Vec<Retained<NextDeskFilePromiseDelegate>>> = const { RefCell::new(Vec::new()) };
    static ACTIVE_PROMISE_PROVIDERS: RefCell<Vec<Retained<NSFilePromiseProvider>>> = const { RefCell::new(Vec::new()) };
}

#[cfg(target_os = "macos")]
#[derive(Debug)]
struct NextDeskFilePromiseDelegateIvars {
    file_name: Retained<NSString>,
    file_data: Vec<u8>,
}

#[cfg(target_os = "macos")]
define_class!(
    #[unsafe(super = NSObject)]
    #[name = "NextDeskFilePromiseDelegate"]
    #[thread_kind = MainThreadOnly]
    #[ivars = NextDeskFilePromiseDelegateIvars]
    struct NextDeskFilePromiseDelegate;

    unsafe impl NSObjectProtocol for NextDeskFilePromiseDelegate {}

    #[allow(non_snake_case)]
    unsafe impl NSFilePromiseProviderDelegate for NextDeskFilePromiseDelegate {
        #[unsafe(method_id(filePromiseProvider:fileNameForType:))]
        fn filePromiseProvider_fileNameForType(
            &self,
            _file_promise_provider: &NSFilePromiseProvider,
            _file_type: &NSString,
        ) -> Retained<NSString> {
            log::info!(
                "[file-promise] Requested promised file name: {}",
                self.ivars().file_name
            );
            self.ivars().file_name.clone()
        }

        #[unsafe(method(filePromiseProvider:writePromiseToURL:completionHandler:))]
        fn filePromiseProvider_writePromiseToURL_completionHandler(
            &self,
            _file_promise_provider: &NSFilePromiseProvider,
            url: &NSURL,
            completion_handler: &DynBlock<dyn Fn(*mut NSError)>,
        ) {
            log::info!(
                "[file-promise] writePromiseToURL invoked for {}",
                self.ivars().file_name
            );
            let result = url
                .path()
                .map(|path| PathBuf::from(path.to_string()))
                .ok_or_else(|| "Missing destination path for file promise".to_string())
                .and_then(|path| {
                    log::info!(
                        "[file-promise] Fulfilling {} to {} ({} bytes)",
                        self.ivars().file_name,
                        path.display(),
                        self.ivars().file_data.len()
                    );
                    fs::write(&path, &self.ivars().file_data)
                        .map_err(|e| format!("Failed to fulfill file promise: {}", e))
                });

            if let Err(err) = result {
                log::error!("[file-promise] {}", err);
            }

            completion_handler.call((ptr::null_mut(),));
        }
    }
);

#[cfg(target_os = "macos")]
impl NextDeskFilePromiseDelegate {
    fn new(file: &VirtualClipboardFile, mtm: MainThreadMarker) -> Retained<Self> {
        let delegate = mtm
            .alloc::<Self>()
            .set_ivars(NextDeskFilePromiseDelegateIvars {
                file_name: NSString::from_str(&file.name),
                file_data: file.data.clone(),
            });

        unsafe { msg_send![super(delegate), init] }
    }
}

#[cfg(target_os = "macos")]
pub fn write_files_with_native_file_promise(
    files: &[VirtualClipboardFile],
) -> Result<Option<VirtualClipboardWriteResult>, String> {
    let mtm = MainThreadMarker::new()
        .ok_or_else(|| "NSFilePromiseProvider must be created on the main thread".to_string())?;

    let mut delegates = Vec::with_capacity(files.len());
    let mut providers = Vec::with_capacity(files.len());
    let mut pasteboard_objects = Vec::with_capacity(files.len());

    for file in files {
        let delegate = NextDeskFilePromiseDelegate::new(file, mtm);
        let delegate_proto: &ProtocolObject<dyn NSFilePromiseProviderDelegate> =
            ProtocolObject::from_ref(&*delegate);
        let file_type = NSString::from_str("public.data");
        let provider = NSFilePromiseProvider::initWithFileType_delegate(
            mtm.alloc::<NSFilePromiseProvider>(),
            &file_type,
            delegate_proto,
        );

        pasteboard_objects.push(ProtocolObject::from_retained(provider.clone()));
        delegates.push(delegate);
        providers.push(provider);
    }

    let objects = NSArray::from_retained_slice(&pasteboard_objects);
    let pasteboard = NSPasteboard::generalPasteboard();
    let _ = pasteboard.clearContents();
    let success = pasteboard.writeObjects(&objects);

    if !success {
        return Ok(None);
    }

    ACTIVE_PROMISE_DELEGATES.with(|cell| {
        *cell.borrow_mut() = delegates;
    });
    ACTIVE_PROMISE_PROVIDERS.with(|cell| {
        *cell.borrow_mut() = providers;
    });

    Ok(Some(VirtualClipboardWriteResult {
        strategy: "macos-native-file-promise".to_string(),
        staged_paths: Vec::new(),
    }))
}

#[cfg(not(target_os = "macos"))]
pub fn write_files_with_native_file_promise(
    _files: &[VirtualClipboardFile],
) -> Result<Option<VirtualClipboardWriteResult>, String> {
    Ok(None)
}

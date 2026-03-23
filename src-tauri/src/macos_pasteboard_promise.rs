use crate::virtual_file_clipboard::{
    VirtualClipboardFile,
    VirtualClipboardWriteResult,
};

#[cfg(target_os = "macos")]
use std::{
    cell::RefCell,
    env,
    fs,
    path::Path,
    path::PathBuf,
    time::SystemTime,
};

#[cfg(target_os = "macos")]
use objc2::{
    define_class,
    msg_send,
    rc::Retained,
    runtime::{NSObject, NSObjectProtocol, ProtocolObject},
    DefinedClass,
    MainThreadMarker,
    MainThreadOnly,
};
#[cfg(target_os = "macos")]
#[allow(deprecated)]
use objc2_app_kit::{
    NSCreateFilenamePboardType,
    NSCreateFileContentsPboardType,
    NSFileContentsPboardType,
    NSFilesPromisePboardType,
    NSPasteboard,
    NSPasteboardItem,
    NSPasteboardItemDataProvider,
    NSPasteboardType,
    NSPasteboardTypeFileURL,
};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSArray, NSData, NSString, NSURL};

#[cfg(target_os = "macos")]
thread_local! {
    static ACTIVE_PASTEBOARD_PROMISE_PROVIDERS: RefCell<Vec<Retained<NextDeskPasteboardPromiseProvider>>> = const { RefCell::new(Vec::new()) };
    static ACTIVE_PASTEBOARD_PROMISE_ITEMS: RefCell<Vec<Retained<NSPasteboardItem>>> = const { RefCell::new(Vec::new()) };
}

#[cfg(target_os = "macos")]
#[derive(Debug)]
struct NextDeskPasteboardPromiseProviderIvars {
    file_name: Retained<NSString>,
    file_data: Vec<u8>,
    promised_extension: Retained<NSString>,
    promised_filename_type: Option<Retained<NSPasteboardType>>,
    promised_file_url_type: Option<Retained<NSPasteboardType>>,
    file_url_payload: Option<Retained<NSString>>,
    file_url_source_path: Option<String>,
    file_url_source_is_staged: bool,
    specific_file_contents_type: Option<Retained<NSPasteboardType>>,
    declared_type_names: Vec<String>,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PromiseProviderRequestedType {
    FilesPromiseList,
    PromiseFilename,
    GenericFileContents,
    SpecificFileContents,
    FileUrlProbe,
    Unknown,
}

#[cfg(target_os = "macos")]
impl PromiseProviderRequestedType {
    fn as_str(self) -> &'static str {
        match self {
            Self::FilesPromiseList => "files-promise-list",
            Self::PromiseFilename => "promise-filename",
            Self::GenericFileContents => "generic-file-contents",
            Self::SpecificFileContents => "specific-file-contents",
            Self::FileUrlProbe => "file-url-probe",
            Self::Unknown => "unknown",
        }
    }
}

#[cfg(target_os = "macos")]
define_class!(
    #[unsafe(super = NSObject)]
    #[name = "NextDeskPasteboardPromiseProvider"]
    #[thread_kind = MainThreadOnly]
    #[ivars = NextDeskPasteboardPromiseProviderIvars]
    struct NextDeskPasteboardPromiseProvider;

    unsafe impl NSObjectProtocol for NextDeskPasteboardPromiseProvider {}

    #[allow(non_snake_case)]
    unsafe impl NSPasteboardItemDataProvider for NextDeskPasteboardPromiseProvider {
        #[unsafe(method(pasteboard:item:provideDataForType:))]
        fn pasteboard_item_provideDataForType(
            &self,
            pasteboard: Option<&NSPasteboard>,
            item: &NSPasteboardItem,
            r#type: &NSPasteboardType,
        ) {
            let requested_type_name = r#type.to_string();
            let request_kind = classify_requested_type(
                r#type,
                self.ivars().promised_filename_type.as_deref(),
                self.ivars().promised_file_url_type.as_deref(),
                self.ivars().specific_file_contents_type.as_deref(),
            );
            let item_types = item.types();
            let item_registered_types = pasteboard_type_names(item_types.as_ref());
            log::info!(
                "[pasteboard-promise] provider hit: file={} requestKind={} requestedType={} bytes={} hasFileUrlPayload={} fileUrlSourcePath={} fileUrlSourceStaged={} declaredTypes={:?} itemRegisteredTypes={:?}",
                self.ivars().file_name,
                request_kind.as_str(),
                requested_type_name,
                self.ivars().file_data.len(),
                self.ivars().file_url_payload.is_some(),
                self.ivars()
                    .file_url_source_path
                    .as_deref()
                    .unwrap_or("<none>"),
                self.ivars().file_url_source_is_staged,
                self.ivars().declared_type_names,
                item_registered_types
            );

            match request_kind {
                PromiseProviderRequestedType::FilesPromiseList => {
                    let promised_extensions =
                        NSArray::from_slice(&[&*self.ivars().promised_extension]);
                    let success: bool = unsafe {
                        msg_send![
                            item,
                            setPropertyList: &*promised_extensions,
                            forType: r#type
                        ]
                    };
                    log::info!(
                        "[pasteboard-promise] provided NSFilesPromisePboardType ext={} success={}",
                        self.ivars().promised_extension,
                        success
                    );
                }
                PromiseProviderRequestedType::GenericFileContents
                | PromiseProviderRequestedType::SpecificFileContents => {
                    if self.ivars().file_data.is_empty() {
                        log::warn!(
                            "[pasteboard-promise] file contents requested but source bytes are empty: file={}",
                            self.ivars().file_name
                        );
                    }

                    let data: Retained<NSData> = NSData::with_bytes(&self.ivars().file_data);
                    let success = item.setData_forType(&data, r#type);
                    log::info!(
                        "[pasteboard-promise] provided NSFileContents data for {} success={}",
                        self.ivars().file_name,
                        success
                    );
                }
                PromiseProviderRequestedType::PromiseFilename => {
                    let success = item.setString_forType(&self.ivars().file_name, r#type);
                    log::info!(
                        "[pasteboard-promise] provided promise filename for {} success={} requestedType={}",
                        self.ivars().file_name,
                        success,
                        requested_type_name
                    );
                }
                PromiseProviderRequestedType::FileUrlProbe => {
                    if let Some(file_url_payload) = self.ivars().file_url_payload.as_deref() {
                        let success = item.setString_forType(file_url_payload, r#type);
                        let source_path = self.ivars()
                            .file_url_source_path
                            .as_deref()
                            .unwrap_or("<unavailable>");
                        let source_exists = self.ivars()
                            .file_url_source_path
                            .as_deref()
                            .map(|path| Path::new(path).exists())
                            .unwrap_or(false);
                        log::info!(
                            "[pasteboard-promise] provided file-url semantics for {} success={} requestedType={} payload={} sourcePath={} sourceExists={} staged={}",
                            self.ivars().file_name,
                            success,
                            requested_type_name,
                            file_url_payload,
                            source_path,
                            source_exists,
                            self.ivars().file_url_source_is_staged
                        );
                        if !success {
                            log::warn!(
                                "[pasteboard-promise] blocker: setString_forType failed for file-url semantics file={} requestedType={}",
                                self.ivars().file_name,
                                requested_type_name
                            );
                        }
                        if !self.ivars().file_url_source_is_staged {
                            log::warn!(
                                "[pasteboard-promise] blocker: file-url payload still fell back to synthetic probe path; Finder Cmd+V reliability may degrade"
                            );
                        } else if !source_exists {
                            log::warn!(
                                "[pasteboard-promise] blocker: staged file-url source path disappeared before consumer read: {}",
                                source_path
                            );
                        }
                    } else {
                        log::warn!(
                            "[pasteboard-promise] Finder requested file-url semantics for {} (type={}), but provider could not synthesize fileURL payload",
                            self.ivars().file_name,
                            requested_type_name
                        );
                        log::warn!(
                            "[pasteboard-promise] blocker: without synthetic payload or staged path, current route can only expose promise metadata + byte stream"
                        );
                    }
                }
                PromiseProviderRequestedType::Unknown => {
                    if !self.ivars().file_data.is_empty() {
                        let data: Retained<NSData> = NSData::with_bytes(&self.ivars().file_data);
                        let success = item.setData_forType(&data, r#type);
                        log::info!(
                            "[pasteboard-promise] best-effort data for unknown type {} file={} success={} bytes={}",
                            requested_type_name,
                            self.ivars().file_name,
                            success,
                            self.ivars().file_data.len()
                        );
                    } else {
                        log::warn!(
                            "[pasteboard-promise] unknown type {} for {} with empty data, skipping",
                            requested_type_name,
                            self.ivars().file_name,
                        );
                    }
                    log::warn!(
                        "[pasteboard-promise] type {} outside declared contract {:?}",
                        requested_type_name,
                        self.ivars().declared_type_names
                    );
                }
            }

            if let Some(pb) = pasteboard {
                log::info!(
                    "[pasteboard-promise] provider context pasteboard={} changeCount={} requestKind={}",
                    pb.name(),
                    pb.changeCount(),
                    request_kind.as_str()
                );
            }
        }

        #[unsafe(method(pasteboardFinishedWithDataProvider:))]
        fn pasteboardFinishedWithDataProvider(&self, pasteboard: &NSPasteboard) {
            log::info!(
                "[pasteboard-promise] provider finished for file={} pasteboard={} changeCount={}",
                self.ivars().file_name,
                pasteboard.name(),
                pasteboard.changeCount()
            );
        }
    }
);

#[cfg(target_os = "macos")]
impl NextDeskPasteboardPromiseProvider {
    fn new(
        file: &VirtualClipboardFile,
        promised_file_name: &str,
        promised_extension: &str,
        promised_filename_type: Option<Retained<NSPasteboardType>>,
        promised_file_url_type: Option<Retained<NSPasteboardType>>,
        file_url_payload: Option<Retained<NSString>>,
        file_url_source_path: Option<String>,
        file_url_source_is_staged: bool,
        specific_file_contents_type: Option<Retained<NSPasteboardType>>,
        declared_type_names: Vec<String>,
        mtm: MainThreadMarker,
    ) -> Retained<Self> {
        let provider = mtm
            .alloc::<Self>()
            .set_ivars(NextDeskPasteboardPromiseProviderIvars {
                file_name: NSString::from_str(promised_file_name),
                file_data: file.data.clone(),
                promised_extension: NSString::from_str(promised_extension),
                promised_filename_type,
                promised_file_url_type,
                file_url_payload,
                file_url_source_path,
                file_url_source_is_staged,
                specific_file_contents_type,
                declared_type_names,
            });

        unsafe { msg_send![super(provider), init] }
    }
}

#[cfg(target_os = "macos")]
fn type_eq(
    lhs: &NSPasteboardType,
    rhs: &NSPasteboardType,
) -> bool {
    if std::ptr::eq(lhs, rhs) {
        return true;
    }
    lhs.to_string() == rhs.to_string()
}

#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn classify_requested_type(
    requested_type: &NSPasteboardType,
    promised_filename_type: Option<&NSPasteboardType>,
    promised_file_url_type: Option<&NSPasteboardType>,
    specific_file_contents_type: Option<&NSPasteboardType>,
) -> PromiseProviderRequestedType {
    if type_eq(requested_type, unsafe { NSFilesPromisePboardType }) {
        return PromiseProviderRequestedType::FilesPromiseList;
    }
    if promised_filename_type
        .map(|filename_type| type_eq(requested_type, filename_type))
        .unwrap_or(false)
    {
        return PromiseProviderRequestedType::PromiseFilename;
    }
    if type_eq(requested_type, unsafe { NSFileContentsPboardType }) {
        return PromiseProviderRequestedType::GenericFileContents;
    }
    if specific_file_contents_type
        .map(|specific| type_eq(requested_type, specific))
        .unwrap_or(false)
    {
        return PromiseProviderRequestedType::SpecificFileContents;
    }
    if type_eq(requested_type, unsafe { NSPasteboardTypeFileURL }) {
        return PromiseProviderRequestedType::FileUrlProbe;
    }
    if promised_file_url_type
        .map(|file_url_type| type_eq(requested_type, file_url_type))
        .unwrap_or(false)
    {
        return PromiseProviderRequestedType::FileUrlProbe;
    }

    PromiseProviderRequestedType::Unknown
}

#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn declared_type_names(
    promised_filename_type: Option<&NSPasteboardType>,
    promised_file_url_type: Option<&NSPasteboardType>,
    specific_file_contents_type: Option<&NSPasteboardType>,
    include_file_url_probe_type: bool,
) -> Vec<String> {
    let mut type_names = vec![unsafe { NSFilesPromisePboardType }.to_string()];
    if let Some(filename_type) = promised_filename_type {
        type_names.push(filename_type.to_string());
    }
    type_names.push(unsafe { NSFileContentsPboardType }.to_string());
    if let Some(specific) = specific_file_contents_type {
        type_names.push(specific.to_string());
    }
    if include_file_url_probe_type {
        type_names.push(unsafe { NSPasteboardTypeFileURL }.to_string());
    }
    if let Some(file_url_type) = promised_file_url_type {
        type_names.push(file_url_type.to_string());
    }
    type_names
}

#[cfg(target_os = "macos")]
fn pasteboard_type_names(
    types: &NSArray<NSPasteboardType>,
) -> Vec<String> {
    types.iter().map(|ty| ty.to_string()).collect()
}

#[cfg(target_os = "macos")]
fn promised_extension_from_name(
    file_name: &str,
) -> String {
    Path::new(file_name)
        .extension()
        .and_then(|ext| ext.to_str())
        .filter(|ext| !ext.is_empty())
        .map(|ext| ext.to_string())
        .unwrap_or_else(|| "data".to_string())
}

#[cfg(target_os = "macos")]
fn promised_file_name_from_source(
    source_name: &str,
) -> String {
    Path::new(source_name)
        .file_name()
        .and_then(|part| part.to_str())
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| part.to_string())
        .unwrap_or_else(|| "clipboard-item.data".to_string())
}

#[cfg(target_os = "macos")]
fn promise_stage_root() -> PathBuf {
    let millis = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    env::temp_dir()
        .join("nextdesk-pasteboard-promise-stage")
        .join(format!("{}-{}", std::process::id(), millis))
}

#[cfg(target_os = "macos")]
fn unique_path_in_dir(
    dir: &Path,
    file_name: &str,
) -> PathBuf {
    let dest = dir.join(file_name);
    if !dest.exists() {
        return dest;
    }

    let stem = dest.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(file_name);
    let ext = dest.extension()
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

#[cfg(target_os = "macos")]
fn stage_virtual_file_for_file_url_payload(
    stage_root: &Path,
    promised_file_name: &str,
    file_data: &[u8],
) -> Result<String, String> {
    let dest = unique_path_in_dir(stage_root, promised_file_name);
    fs::write(&dest, file_data)
        .map_err(|e| format!("Failed to stage promise source file '{}': {}", dest.display(), e))?;
    Ok(dest.to_string_lossy().to_string())
}

#[cfg(target_os = "macos")]
fn promised_file_url_type() -> Retained<NSPasteboardType> {
    // Finder 在某些版本/上下文会探测这个 promised-file-url 语义字符串。
    NSString::from_str("com.apple.pasteboard.promised-file-url")
}

#[cfg(target_os = "macos")]
fn file_url_probe_path_from_name(
    file_name: &str,
) -> String {
    let leaf_name = Path::new(file_name)
        .file_name()
        .and_then(|part| part.to_str())
        .filter(|part| !part.is_empty())
        .unwrap_or("clipboard-item.data");
    env::temp_dir()
        .join("nextdesk-pasteboard-promise-probe")
        .join(leaf_name)
        .to_string_lossy()
        .to_string()
}

#[cfg(target_os = "macos")]
fn promised_file_url_payload_from_path(
    path: &str,
) -> Option<Retained<NSString>> {
    let ns_path = NSString::from_str(path);
    let file_url = NSURL::fileURLWithPath(&ns_path);
    file_url.absoluteString()
}

#[cfg(target_os = "macos")]
#[allow(deprecated)]
pub fn write_files_with_pasteboard_item_provider(
    files: &[VirtualClipboardFile],
) -> Result<Option<VirtualClipboardWriteResult>, String> {
    let mtm = MainThreadMarker::new()
        .ok_or_else(|| "NSPasteboardItemDataProvider must be created on the main thread".to_string())?;

    if files.is_empty() {
        return Ok(None);
    }

    log::info!(
        "[pasteboard-promise] building NSPasteboardItemDataProvider path for {} file(s)",
        files.len()
    );

    let stage_root = promise_stage_root();
    let stage_root_ready = match fs::create_dir_all(&stage_root) {
        Ok(()) => {
            log::info!(
                "[pasteboard-promise] staging root ready for real fileURL payloads: {}",
                stage_root.display()
            );
            Some(stage_root)
        }
        Err(e) => {
            log::warn!(
                "[pasteboard-promise] blocker: failed to create staging root {} ({}), fallback to synthetic fileURL probe path",
                stage_root.display(),
                e
            );
            None
        }
    };

    let mut providers = Vec::with_capacity(files.len());
    let mut items = Vec::with_capacity(files.len());
    let mut objects = Vec::with_capacity(files.len());
    let mut staged_paths = Vec::with_capacity(files.len());

    for file in files {
        let promised_file_name = promised_file_name_from_source(&file.name);
        let promised_extension = promised_extension_from_name(&promised_file_name);
        let promised_filename_type = NSCreateFilenamePboardType(&NSString::from_str(&promised_extension));
        let promised_file_url_type = Some(promised_file_url_type());
        let specific_file_contents_type = NSCreateFileContentsPboardType(&NSString::from_str(&promised_extension));
        let (file_url_source_path, file_url_source_is_staged) = if let Some(root) = stage_root_ready.as_deref() {
            match stage_virtual_file_for_file_url_payload(root, &promised_file_name, &file.data) {
                Ok(path) => {
                    staged_paths.push(path.clone());
                    (Some(path), true)
                }
                Err(err) => {
                    log::warn!(
                        "[pasteboard-promise] blocker: {} ; fallback to synthetic fileURL probe payload for {}",
                        err,
                        promised_file_name
                    );
                    (
                        Some(file_url_probe_path_from_name(&promised_file_name)),
                        false,
                    )
                }
            }
        } else {
            (
                Some(file_url_probe_path_from_name(&promised_file_name)),
                false,
            )
        };
        let file_url_payload = file_url_source_path
            .as_deref()
            .and_then(promised_file_url_payload_from_path);
        let provided_type_names = declared_type_names(
            promised_filename_type.as_deref(),
            promised_file_url_type.as_deref(),
            specific_file_contents_type.as_deref(),
            true,
        );

        let provider = NextDeskPasteboardPromiseProvider::new(
            file,
            &promised_file_name,
            &promised_extension,
            promised_filename_type.clone(),
            promised_file_url_type.clone(),
            file_url_payload.clone(),
            file_url_source_path.clone(),
            file_url_source_is_staged,
            specific_file_contents_type.clone(),
            provided_type_names.clone(),
            mtm,
        );
        let provider_proto: &ProtocolObject<dyn NSPasteboardItemDataProvider> =
            ProtocolObject::from_ref(&*provider);

        // 先保持最小类型集合，避免在未实现真实落盘/URL promise 语义前扩大行为面。
        // 若 Finder Cmd+V 不消费，优先从 provider 日志里确认它实际请求的 type。
        let mut provided_types: Vec<&NSPasteboardType> = vec![
            unsafe { NSFilesPromisePboardType },
        ];
        if let Some(filename_type) = promised_filename_type.as_deref() {
            provided_types.push(filename_type);
        }
        provided_types.push(unsafe { NSFileContentsPboardType });
        if let Some(specific) = specific_file_contents_type.as_deref() {
            provided_types.push(specific);
        }
        provided_types.push(unsafe { NSPasteboardTypeFileURL });
        if let Some(file_url_type) = promised_file_url_type.as_deref() {
            provided_types.push(file_url_type);
        }

        let provided_types_array = NSArray::from_slice(&provided_types);

        let item = NSPasteboardItem::new();
        let set_provider_ok = item.setDataProvider_forTypes(provider_proto, &provided_types_array);
        let promised_file_name_ns = NSString::from_str(&promised_file_name);
        let eager_filename_seed = promised_filename_type
            .as_deref()
            .map(|filename_type| item.setString_forType(&promised_file_name_ns, filename_type));
        let eager_file_url_seed = file_url_payload
            .as_deref()
            .map(|payload| item.setString_forType(payload, unsafe { NSPasteboardTypeFileURL }));
        let eager_promised_file_url_seed = file_url_payload
            .as_deref()
            .zip(promised_file_url_type.as_deref())
            .map(|(payload, file_url_type)| item.setString_forType(payload, file_url_type));
        let eager_contents_seed = if file.data.is_empty() {
            None
        } else {
            let data: Retained<NSData> = NSData::with_bytes(&file.data);
            Some(item.setData_forType(&data, unsafe { NSFileContentsPboardType }))
        };
        let eager_specific_contents_seed = if file.data.is_empty() {
            None
        } else {
            specific_file_contents_type.as_deref().map(|specific| {
                let data: Retained<NSData> = NSData::with_bytes(&file.data);
                item.setData_forType(&data, specific)
            })
        };
        log::info!(
            "[pasteboard-promise] registered provider for sourceFile={} promisedFileName={} ext={} filenameTypePresent={} promisedFileUrlTypePresent={} fileUrlPayloadPresent={} fileUrlSourcePath={} fileUrlSourceStaged={} specificTypePresent={} fileUrlProbeType=true setDataProvider={} eagerFilenameSeed={:?} eagerFileUrlSeed={:?} eagerPromisedFileUrlSeed={:?} eagerContentsSeed={:?} eagerSpecificContentsSeed={:?} declaredTypes={:?} bytes={}",
            file.name,
            promised_file_name,
            promised_extension,
            promised_filename_type.is_some(),
            promised_file_url_type.is_some(),
            file_url_payload.is_some(),
            file_url_source_path
                .as_deref()
                .unwrap_or("<unavailable>"),
            file_url_source_is_staged,
            specific_file_contents_type.is_some(),
            set_provider_ok,
            eager_filename_seed,
            eager_file_url_seed,
            eager_promised_file_url_seed,
            eager_contents_seed,
            eager_specific_contents_seed,
            provided_type_names,
            file.data.len()
        );

        items.push(item.clone());
        objects.push(ProtocolObject::from_retained(item));
        providers.push(provider);
    }

    let object_array = NSArray::from_retained_slice(&objects);
    let pasteboard = NSPasteboard::generalPasteboard();
    let before = pasteboard.changeCount();
    let _ = pasteboard.clearContents();
    let success = pasteboard.writeObjects(&object_array);
    let after = pasteboard.changeCount();

    log::info!(
        "[pasteboard-promise] writeObjects finished success={} changeCount {} -> {}",
        success,
        before,
        after
    );
    let pasteboard_types = pasteboard
        .types()
        .as_deref()
        .map(pasteboard_type_names)
        .unwrap_or_default();
    log::info!(
        "[pasteboard-promise] general pasteboard advertised types after write: {:?}",
        pasteboard_types
    );

    if !success {
        return Ok(None);
    }

    ACTIVE_PASTEBOARD_PROMISE_PROVIDERS.with(|cell| {
        *cell.borrow_mut() = providers;
    });
    ACTIVE_PASTEBOARD_PROMISE_ITEMS.with(|cell| {
        *cell.borrow_mut() = items;
    });

    Ok(Some(VirtualClipboardWriteResult {
        strategy: "macos-pasteboard-item-provider-promise".to_string(),
        staged_paths,
    }))
}

#[cfg(not(target_os = "macos"))]
pub fn write_files_with_pasteboard_item_provider(
    _files: &[VirtualClipboardFile],
) -> Result<Option<VirtualClipboardWriteResult>, String> {
    Ok(None)
}

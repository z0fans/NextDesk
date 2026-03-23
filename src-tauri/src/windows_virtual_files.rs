use crate::virtual_file_clipboard::{VirtualClipboardFile, VirtualClipboardWriteResult};

#[cfg(target_os = "windows")]
use std::ffi::{c_void, OsStr};
#[cfg(target_os = "windows")]
use std::mem::{size_of, zeroed};
#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;
#[cfg(target_os = "windows")]
use std::ptr::{copy_nonoverlapping, null_mut};
#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicU32, Ordering};
#[cfg(target_os = "windows")]
use std::sync::{Arc, Mutex};
#[cfg(target_os = "windows")]
use windows::core::{Interface, GUID, HRESULT, PWSTR};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{
    DATA_S_SAMEFORMATETC, DV_E_CLIPFORMAT, DV_E_DVASPECT, DV_E_FORMATETC, DV_E_LINDEX, DV_E_TYMED,
    E_INVALIDARG, E_NOINTERFACE, E_NOTIMPL, E_OUTOFMEMORY, E_POINTER, OLE_E_ADVISENOTSUPPORTED,
    RPC_E_CHANGED_MODE, STG_E_ACCESSDENIED, STG_E_INVALIDFUNCTION, S_FALSE, S_OK,
};
#[cfg(target_os = "windows")]
use windows::Win32::System::Com::{
    IDataObject, DATADIR_GET, DVASPECT_CONTENT, FORMATETC, STATSTG, STGM_READ, STGTY_STREAM,
    STREAM_SEEK_CUR, STREAM_SEEK_END, STREAM_SEEK_SET, TYMED_HGLOBAL, TYMED_ISTREAM,
};
#[cfg(target_os = "windows")]
use windows::Win32::System::Ole::{OleInitialize, OleSetClipboard, OleUninitialize};
#[cfg(target_os = "windows")]
use windows::Win32::UI::Shell::{
    CFSTR_FILECONTENTS, CFSTR_FILEDESCRIPTORW, FD_ATTRIBUTES, FD_FILESIZE,
};

#[cfg(target_os = "windows")]
const GMEM_MOVEABLE: u32 = 0x0002;
#[cfg(target_os = "windows")]
const MAX_PATH_WIDE: usize = 260;
#[cfg(target_os = "windows")]
const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
#[cfg(target_os = "windows")]
const FILECONTENTS_MEDIUM_ISTREAM: u32 = TYMED_ISTREAM.0 as u32;
#[cfg(target_os = "windows")]
const FILECONTENTS_MEDIUM_HGLOBAL: u32 = TYMED_HGLOBAL.0 as u32;
#[cfg(target_os = "windows")]
const FILECONTENTS_SUPPORTED_TYMED: u32 = FILECONTENTS_MEDIUM_ISTREAM | FILECONTENTS_MEDIUM_HGLOBAL;

#[cfg(target_os = "windows")]
const IID_IUNKNOWN: GUID = GUID::from_u128(0x00000000_0000_0000_C000_000000000046);
#[cfg(target_os = "windows")]
const IID_ISEQUENTIAL_STREAM: GUID = GUID::from_u128(0x0000000b_0000_0000_C000_000000000046);
#[cfg(target_os = "windows")]
const IID_ISTREAM: GUID = GUID::from_u128(0x0000000c_0000_0000_C000_000000000046);
#[cfg(target_os = "windows")]
const IID_IENUMFORMATETC: GUID = GUID::from_u128(0x00000103_0000_0000_C000_000000000046);
#[cfg(target_os = "windows")]
const IID_IDATAOBJECT: GUID = GUID::from_u128(0x0000010e_0000_0000_C000_000000000046);

#[cfg(target_os = "windows")]
#[repr(C)]
union RawStgMediumData {
    hglobal: *mut c_void,
    pstm: *mut c_void,
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct RawStgMedium {
    tymed: u32,
    data: RawStgMediumData,
    punk_for_release: *mut c_void,
}

#[cfg(target_os = "windows")]
#[repr(C)]
#[derive(Clone, Copy)]
struct RawFileTime {
    dw_low_date_time: u32,
    dw_high_date_time: u32,
}

#[cfg(target_os = "windows")]
#[repr(C)]
#[derive(Clone, Copy)]
struct RawSizeL {
    cx: i32,
    cy: i32,
}

#[cfg(target_os = "windows")]
#[repr(C)]
#[derive(Clone, Copy)]
struct RawPointL {
    x: i32,
    y: i32,
}

#[cfg(target_os = "windows")]
#[repr(C)]
#[derive(Clone, Copy)]
struct RawFileDescriptorW {
    dw_flags: u32,
    clsid: GUID,
    sizel: RawSizeL,
    pointl: RawPointL,
    dw_file_attributes: u32,
    ft_creation_time: RawFileTime,
    ft_last_access_time: RawFileTime,
    ft_last_write_time: RawFileTime,
    n_file_size_high: u32,
    n_file_size_low: u32,
    c_file_name: [u16; MAX_PATH_WIDE],
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct DataObjectVTable {
    query_interface:
        unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> HRESULT,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    get_data:
        unsafe extern "system" fn(*mut c_void, *const FORMATETC, *mut RawStgMedium) -> HRESULT,
    get_data_here:
        unsafe extern "system" fn(*mut c_void, *const FORMATETC, *mut RawStgMedium) -> HRESULT,
    query_get_data: unsafe extern "system" fn(*mut c_void, *const FORMATETC) -> HRESULT,
    get_canonical_format_etc:
        unsafe extern "system" fn(*mut c_void, *const FORMATETC, *mut FORMATETC) -> HRESULT,
    set_data: unsafe extern "system" fn(
        *mut c_void,
        *const FORMATETC,
        *const RawStgMedium,
        i32,
    ) -> HRESULT,
    enum_format_etc: unsafe extern "system" fn(*mut c_void, u32, *mut *mut c_void) -> HRESULT,
    dadvise: unsafe extern "system" fn(
        *mut c_void,
        *const FORMATETC,
        u32,
        *mut c_void,
        *mut u32,
    ) -> HRESULT,
    dunadvise: unsafe extern "system" fn(*mut c_void, u32) -> HRESULT,
    enum_dadvise: unsafe extern "system" fn(*mut c_void, *mut *mut c_void) -> HRESULT,
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct EnumFormatEtcVTable {
    query_interface:
        unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> HRESULT,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    next: unsafe extern "system" fn(*mut c_void, u32, *mut FORMATETC, *mut u32) -> HRESULT,
    skip: unsafe extern "system" fn(*mut c_void, u32) -> HRESULT,
    reset: unsafe extern "system" fn(*mut c_void) -> HRESULT,
    clone_enum: unsafe extern "system" fn(*mut c_void, *mut *mut c_void) -> HRESULT,
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct StreamVTable {
    query_interface:
        unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> HRESULT,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    read: unsafe extern "system" fn(*mut c_void, *mut c_void, u32, *mut u32) -> HRESULT,
    write: unsafe extern "system" fn(*mut c_void, *const c_void, u32, *mut u32) -> HRESULT,
    seek: unsafe extern "system" fn(*mut c_void, i64, u32, *mut u64) -> HRESULT,
    set_size: unsafe extern "system" fn(*mut c_void, u64) -> HRESULT,
    copy_to:
        unsafe extern "system" fn(*mut c_void, *mut c_void, u64, *mut u64, *mut u64) -> HRESULT,
    commit: unsafe extern "system" fn(*mut c_void, u32) -> HRESULT,
    revert: unsafe extern "system" fn(*mut c_void) -> HRESULT,
    lock_region: unsafe extern "system" fn(*mut c_void, u64, u64, u32) -> HRESULT,
    unlock_region: unsafe extern "system" fn(*mut c_void, u64, u64, u32) -> HRESULT,
    stat: unsafe extern "system" fn(*mut c_void, *mut STATSTG, u32) -> HRESULT,
    clone_stream: unsafe extern "system" fn(*mut c_void, *mut *mut c_void) -> HRESULT,
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct DataObject {
    vtable: *const DataObjectVTable,
    ref_count: AtomicU32,
    files: Vec<PreparedVirtualFile>,
    file_descriptor_cf: u16,
    file_contents_cf: u16,
}

#[cfg(target_os = "windows")]
#[derive(Clone)]
struct PreparedVirtualFile {
    name: String,
    data: Arc<[u8]>,
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct EnumFormatEtcObject {
    vtable: *const EnumFormatEtcVTable,
    ref_count: AtomicU32,
    items: Vec<FORMATETC>,
    cursor: Mutex<usize>,
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct StreamObject {
    vtable: *const StreamVTable,
    ref_count: AtomicU32,
    data: Arc<[u8]>,
    cursor: Mutex<usize>,
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct RawStreamInterface {
    vtable: *const StreamVTable,
}

#[cfg(target_os = "windows")]
#[link(name = "user32")]
unsafe extern "system" {
    fn RegisterClipboardFormatW(lpszformat: *const u16) -> u32;
}

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GlobalAlloc(uflags: u32, dwbytes: usize) -> *mut c_void;
    fn GlobalLock(hmem: *mut c_void) -> *mut c_void;
    fn GlobalUnlock(hmem: *mut c_void) -> i32;
    fn GlobalFree(hmem: *mut c_void) -> *mut c_void;
}

#[cfg(target_os = "windows")]
static DATA_OBJECT_VTABLE: DataObjectVTable = DataObjectVTable {
    query_interface: data_object_query_interface,
    add_ref: data_object_add_ref,
    release: data_object_release,
    get_data: data_object_get_data,
    get_data_here: data_object_get_data_here,
    query_get_data: data_object_query_get_data,
    get_canonical_format_etc: data_object_get_canonical_format_etc,
    set_data: data_object_set_data,
    enum_format_etc: data_object_enum_format_etc,
    dadvise: data_object_dadvise,
    dunadvise: data_object_dunadvise,
    enum_dadvise: data_object_enum_dadvise,
};

#[cfg(target_os = "windows")]
static ENUM_FORMAT_ETC_VTABLE: EnumFormatEtcVTable = EnumFormatEtcVTable {
    query_interface: enum_query_interface,
    add_ref: enum_add_ref,
    release: enum_release,
    next: enum_next,
    skip: enum_skip,
    reset: enum_reset,
    clone_enum: enum_clone,
};

#[cfg(target_os = "windows")]
static STREAM_VTABLE: StreamVTable = StreamVTable {
    query_interface: stream_query_interface,
    add_ref: stream_add_ref,
    release: stream_release,
    read: stream_read,
    write: stream_write,
    seek: stream_seek,
    set_size: stream_set_size,
    copy_to: stream_copy_to,
    commit: stream_commit,
    revert: stream_revert,
    lock_region: stream_lock_region,
    unlock_region: stream_unlock_region,
    stat: stream_stat,
    clone_stream: stream_clone,
};

#[cfg(target_os = "windows")]
struct OleInitGuard {
    active: bool,
}

#[cfg(target_os = "windows")]
impl Drop for OleInitGuard {
    fn drop(&mut self) {
        if self.active {
            unsafe {
                OleUninitialize();
            }
        }
    }
}

#[cfg(target_os = "windows")]
pub fn write_files_with_native_virtual_data_object(
    files: &[VirtualClipboardFile],
) -> Result<Option<VirtualClipboardWriteResult>, String> {
    if files.is_empty() {
        return Ok(None);
    }

    let prepared_files = files
        .iter()
        .map(|file| PreparedVirtualFile {
            name: sanitize_filename(&file.name),
            data: Arc::<[u8]>::from(file.data.clone().into_boxed_slice()),
        })
        .collect::<Vec<_>>();

    let file_descriptor_cf = register_clipboard_format(CFSTR_FILEDESCRIPTORW.0)?;
    let file_contents_cf = register_clipboard_format(CFSTR_FILECONTENTS.0)?;

    let ole_guard = init_ole_for_clipboard()?;

    let object_ptr = Box::into_raw(Box::new(DataObject {
        vtable: &DATA_OBJECT_VTABLE,
        ref_count: AtomicU32::new(1),
        files: prepared_files,
        file_descriptor_cf,
        file_contents_cf,
    }));

    let data_object = unsafe { IDataObject::from_raw(object_ptr.cast()) };
    unsafe {
        OleSetClipboard(&data_object)
            .map_err(|e| format!("OleSetClipboard failed: {:#x}", e.code().0 as u32))?;
    }
    drop(data_object);
    drop(ole_guard);

    Ok(Some(VirtualClipboardWriteResult {
        strategy: "windows-native-virtual-data-object-v1".to_string(),
        staged_paths: Vec::new(),
    }))
}

#[cfg(target_os = "windows")]
fn sanitize_filename(input: &str) -> String {
    let mut normalized = input.replace('\\', "_").replace('/', "_");
    if normalized.trim().is_empty() {
        normalized = "clipboard.bin".to_string();
    }
    normalized
}

#[cfg(target_os = "windows")]
fn init_ole_for_clipboard() -> Result<OleInitGuard, String> {
    match unsafe { OleInitialize(None) } {
        Ok(()) => Ok(OleInitGuard { active: true }),
        Err(err) if err.code() == RPC_E_CHANGED_MODE => Ok(OleInitGuard { active: false }),
        Err(err) => Err(format!("OleInitialize failed: {:#x}", err.code().0 as u32)),
    }
}

#[cfg(target_os = "windows")]
fn register_clipboard_format(name: *const u16) -> Result<u16, String> {
    let value = unsafe { RegisterClipboardFormatW(name) };
    if value == 0 || value > u16::MAX as u32 {
        return Err("RegisterClipboardFormatW failed".to_string());
    }
    Ok(value as u16)
}

#[cfg(target_os = "windows")]
fn describe_format_etc(format: &FORMATETC) -> String {
    format!(
        "cf={} aspect={} lindex={} tymed={:#x} ptd={:p}",
        format.cfFormat, format.dwAspect, format.lindex, format.tymed, format.ptd
    )
}

#[cfg(target_os = "windows")]
fn resolve_file_contents_index(lindex: i32, file_count: usize) -> Result<usize, HRESULT> {
    if file_count == 0 {
        return Err(DV_E_LINDEX);
    }

    if lindex == -1 {
        if file_count == 1 {
            return Ok(0);
        }
        return Err(DV_E_LINDEX);
    }

    if lindex < 0 {
        return Err(DV_E_LINDEX);
    }

    let index = lindex as usize;
    if index >= file_count {
        return Err(DV_E_LINDEX);
    }

    Ok(index)
}

#[cfg(target_os = "windows")]
fn choose_file_contents_medium(requested_tymed: u32) -> Option<u32> {
    if requested_tymed == 0 {
        return Some(FILECONTENTS_MEDIUM_ISTREAM);
    }
    if (requested_tymed & FILECONTENTS_MEDIUM_ISTREAM) != 0 {
        return Some(FILECONTENTS_MEDIUM_ISTREAM);
    }
    if (requested_tymed & FILECONTENTS_MEDIUM_HGLOBAL) != 0 {
        return Some(FILECONTENTS_MEDIUM_HGLOBAL);
    }
    None
}

#[cfg(target_os = "windows")]
fn tymed_matches(requested_tymed: u32, supported_mask: u32) -> bool {
    requested_tymed == 0 || (requested_tymed & supported_mask) != 0
}

#[cfg(target_os = "windows")]
fn build_file_group_descriptor_blob(files: &[PreparedVirtualFile]) -> Vec<u8> {
    let mut blob = Vec::with_capacity(4 + files.len() * size_of::<RawFileDescriptorW>());
    blob.extend_from_slice(&(files.len() as u32).to_le_bytes());

    for file in files {
        let mut descriptor = RawFileDescriptorW {
            dw_flags: (FD_FILESIZE.0 as u32) | (FD_ATTRIBUTES.0 as u32),
            clsid: GUID::zeroed(),
            sizel: RawSizeL { cx: 0, cy: 0 },
            pointl: RawPointL { x: 0, y: 0 },
            dw_file_attributes: FILE_ATTRIBUTE_NORMAL,
            ft_creation_time: RawFileTime {
                dw_low_date_time: 0,
                dw_high_date_time: 0,
            },
            ft_last_access_time: RawFileTime {
                dw_low_date_time: 0,
                dw_high_date_time: 0,
            },
            ft_last_write_time: RawFileTime {
                dw_low_date_time: 0,
                dw_high_date_time: 0,
            },
            n_file_size_high: ((file.data.len() as u64) >> 32) as u32,
            n_file_size_low: (file.data.len() as u64 & 0xffff_ffff) as u32,
            c_file_name: [0u16; MAX_PATH_WIDE],
        };

        let wide_name = OsStr::new(&file.name).encode_wide().collect::<Vec<_>>();
        let copy_len = wide_name.len().min(MAX_PATH_WIDE - 1);
        descriptor.c_file_name[..copy_len].copy_from_slice(&wide_name[..copy_len]);

        let bytes = unsafe {
            std::slice::from_raw_parts(
                (&descriptor as *const RawFileDescriptorW).cast::<u8>(),
                size_of::<RawFileDescriptorW>(),
            )
        };
        blob.extend_from_slice(bytes);
    }

    blob
}

#[cfg(target_os = "windows")]
fn alloc_hglobal_from_bytes(bytes: &[u8]) -> Result<*mut c_void, HRESULT> {
    let hglobal = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1)) };
    if hglobal.is_null() {
        return Err(E_OUTOFMEMORY);
    }

    let locked = unsafe { GlobalLock(hglobal) };
    if locked.is_null() {
        unsafe {
            let _ = GlobalFree(hglobal);
        }
        return Err(E_OUTOFMEMORY);
    }

    if !bytes.is_empty() {
        unsafe {
            copy_nonoverlapping(bytes.as_ptr(), locked.cast::<u8>(), bytes.len());
        }
    }

    unsafe {
        let _ = GlobalUnlock(hglobal);
    }

    Ok(hglobal)
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn data_object_query_interface(
    this: *mut c_void,
    riid: *const GUID,
    ppv: *mut *mut c_void,
) -> HRESULT {
    if riid.is_null() || ppv.is_null() {
        return E_POINTER;
    }

    let iid = unsafe { *riid };
    if iid == IID_IUNKNOWN || iid == IID_IDATAOBJECT {
        unsafe {
            *ppv = this;
        }
        let _ = unsafe { data_object_add_ref(this) };
        return S_OK;
    }

    unsafe {
        *ppv = null_mut();
    }
    E_NOINTERFACE
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn data_object_add_ref(this: *mut c_void) -> u32 {
    let object = unsafe { &*(this as *mut DataObject) };
    object.ref_count.fetch_add(1, Ordering::AcqRel) + 1
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn data_object_release(this: *mut c_void) -> u32 {
    let object = unsafe { &*(this as *mut DataObject) };
    let next = object.ref_count.fetch_sub(1, Ordering::AcqRel) - 1;
    if next == 0 {
        unsafe {
            drop(Box::from_raw(this as *mut DataObject));
        }
    }
    next
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn data_object_get_data(
    this: *mut c_void,
    pformatetc: *const FORMATETC,
    pmedium: *mut RawStgMedium,
) -> HRESULT {
    if pformatetc.is_null() || pmedium.is_null() {
        return E_POINTER;
    }

    let object = unsafe { &*(this as *mut DataObject) };
    let format = unsafe { &*pformatetc };
    unsafe {
        *pmedium = RawStgMedium {
            tymed: 0,
            data: RawStgMediumData {
                hglobal: null_mut(),
            },
            punk_for_release: null_mut(),
        };
    }

    let query_hr = unsafe { data_object_query_get_data(this, pformatetc) };
    if query_hr != S_OK {
        log::debug!(
            "[clipboard-win] IDataObject::GetData rejected by QueryGetData cf={} lindex={} tymed={:#x} hr={:#x}",
            format.cfFormat,
            format.lindex,
            format.tymed,
            query_hr.0 as u32
        );
        return query_hr;
    }

    if format.cfFormat == object.file_descriptor_cf {
        let descriptor_blob = build_file_group_descriptor_blob(&object.files);
        let hglobal = match alloc_hglobal_from_bytes(&descriptor_blob) {
            Ok(value) => value,
            Err(hr) => return hr,
        };

        unsafe {
            *pmedium = RawStgMedium {
                tymed: TYMED_HGLOBAL.0 as u32,
                data: RawStgMediumData { hglobal },
                punk_for_release: null_mut(),
            };
        }
        log::debug!(
            "[clipboard-win] IDataObject::GetData FILEDESCRIPTORW files={} bytes={}",
            object.files.len(),
            descriptor_blob.len()
        );
        return S_OK;
    }

    if format.cfFormat == object.file_contents_cf {
        let index = match resolve_file_contents_index(format.lindex, object.files.len()) {
            Ok(value) => value,
            Err(hr) => {
                log::debug!(
                    "[clipboard-win] IDataObject::GetData invalid FILECONTENTS lindex={} files={} hr={:#x}",
                    format.lindex,
                    object.files.len(),
                    hr.0 as u32
                );
                return hr;
            }
        };
        if let Some(file) = object.files.get(index) {
            let selected_tymed = match choose_file_contents_medium(format.tymed) {
                Some(value) => value,
                None => {
                    log::debug!(
                        "[clipboard-win] IDataObject::GetData FILECONTENTS no supported tymed format={} requested_tymed={:#x}",
                        describe_format_etc(format),
                        format.tymed
                    );
                    return DV_E_TYMED;
                }
            };

            if selected_tymed == FILECONTENTS_MEDIUM_ISTREAM {
                let stream_ptr = Box::into_raw(Box::new(StreamObject {
                    vtable: &STREAM_VTABLE,
                    ref_count: AtomicU32::new(1),
                    data: Arc::clone(&file.data),
                    cursor: Mutex::new(0),
                })) as *mut c_void;

                unsafe {
                    *pmedium = RawStgMedium {
                        tymed: FILECONTENTS_MEDIUM_ISTREAM,
                        data: RawStgMediumData { pstm: stream_ptr },
                        punk_for_release: null_mut(),
                    };
                }
                log::debug!(
                    "[clipboard-win] IDataObject::GetData FILECONTENTS index={} medium=ISTREAM bytes={} name={}",
                    index,
                    file.data.len(),
                    file.name
                );
                return S_OK;
            }

            let hglobal = match alloc_hglobal_from_bytes(file.data.as_ref()) {
                Ok(value) => value,
                Err(hr) => {
                    log::debug!(
                        "[clipboard-win] IDataObject::GetData FILECONTENTS HGLOBAL alloc failed index={} bytes={} hr={:#x}",
                        index,
                        file.data.len(),
                        hr.0 as u32
                    );
                    return hr;
                }
            };
            unsafe {
                *pmedium = RawStgMedium {
                    tymed: FILECONTENTS_MEDIUM_HGLOBAL,
                    data: RawStgMediumData { hglobal },
                    punk_for_release: null_mut(),
                };
            }
            log::debug!(
                "[clipboard-win] IDataObject::GetData FILECONTENTS index={} medium=HGLOBAL bytes={} name={}",
                index,
                file.data.len(),
                file.name
            );
            return S_OK;
        }
    }

    log::debug!(
        "[clipboard-win] IDataObject::GetData unsupported format {}",
        describe_format_etc(format)
    );
    DV_E_FORMATETC
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn data_object_get_data_here(
    this: *mut c_void,
    pformatetc: *const FORMATETC,
    pmedium: *mut RawStgMedium,
) -> HRESULT {
    if pformatetc.is_null() || pmedium.is_null() {
        return E_POINTER;
    }

    let object = unsafe { &*(this as *mut DataObject) };
    let format = unsafe { &*pformatetc };
    let medium = unsafe { &*pmedium };

    if medium.tymed != TYMED_HGLOBAL.0 as u32 {
        log::debug!(
            "[clipboard-win] IDataObject::GetDataHere unsupported tymed={:#x}",
            medium.tymed
        );
        return E_NOTIMPL;
    }

    let hglobal = unsafe { medium.data.hglobal };
    if hglobal.is_null() {
        return E_INVALIDARG;
    }

    if format.cfFormat == object.file_descriptor_cf {
        let blob = build_file_group_descriptor_blob(&object.files);
        let locked = unsafe { GlobalLock(hglobal) };
        if locked.is_null() {
            return E_OUTOFMEMORY;
        }
        unsafe {
            copy_nonoverlapping(blob.as_ptr(), locked.cast::<u8>(), blob.len());
            let _ = GlobalUnlock(hglobal);
        }
        log::debug!(
            "[clipboard-win] IDataObject::GetDataHere FILEDESCRIPTORW bytes={}",
            blob.len()
        );
        return S_OK;
    }

    if format.cfFormat == object.file_contents_cf {
        let index = match resolve_file_contents_index(format.lindex, object.files.len()) {
            Ok(v) => v,
            Err(hr) => return hr,
        };
        if let Some(file) = object.files.get(index) {
            let locked = unsafe { GlobalLock(hglobal) };
            if locked.is_null() {
                return E_OUTOFMEMORY;
            }
            unsafe {
                copy_nonoverlapping(
                    file.data.as_ptr(),
                    locked.cast::<u8>(),
                    file.data.len(),
                );
                let _ = GlobalUnlock(hglobal);
            }
            log::debug!(
                "[clipboard-win] IDataObject::GetDataHere FILECONTENTS index={} bytes={}",
                index,
                file.data.len()
            );
            return S_OK;
        }
    }

    log::debug!(
        "[clipboard-win] IDataObject::GetDataHere unsupported format {}",
        describe_format_etc(format)
    );
    DV_E_FORMATETC
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn data_object_query_get_data(
    this: *mut c_void,
    pformatetc: *const FORMATETC,
) -> HRESULT {
    if pformatetc.is_null() {
        log::debug!("[clipboard-win] IDataObject::QueryGetData null FORMATETC");
        return E_INVALIDARG;
    }

    let object = unsafe { &*(this as *mut DataObject) };
    let format = unsafe { &*pformatetc };
    let format_desc = describe_format_etc(format);

    if !format.ptd.is_null() {
        log::debug!(
            "[clipboard-win] IDataObject::QueryGetData reject ptd {}",
            format_desc
        );
        return DV_E_FORMATETC;
    }

    if format.dwAspect != DVASPECT_CONTENT.0 {
        log::debug!(
            "[clipboard-win] IDataObject::QueryGetData reject aspect {}",
            format_desc
        );
        return DV_E_DVASPECT;
    }

    if format.cfFormat == object.file_descriptor_cf {
        if format.lindex != -1 && !(object.files.len() == 1 && format.lindex == 0) {
            log::debug!(
                "[clipboard-win] IDataObject::QueryGetData reject FILEDESCRIPTOR lindex {}",
                format_desc
            );
            return DV_E_LINDEX;
        }
        if format.lindex == 0 && object.files.len() == 1 {
            log::trace!(
                "[clipboard-win] IDataObject::QueryGetData tolerate FILEDESCRIPTOR single-file lindex=0 {}",
                format_desc
            );
        }
        if !tymed_matches(format.tymed, TYMED_HGLOBAL.0 as u32) {
            log::debug!(
                "[clipboard-win] IDataObject::QueryGetData reject FILEDESCRIPTOR tymed {}",
                format_desc
            );
            return DV_E_TYMED;
        }
        log::debug!(
            "[clipboard-win] IDataObject::QueryGetData accept FILEDESCRIPTOR {}",
            format_desc
        );
        return S_OK;
    }

    if format.cfFormat == object.file_contents_cf {
        if let Err(hr) = resolve_file_contents_index(format.lindex, object.files.len()) {
            log::debug!(
                "[clipboard-win] IDataObject::QueryGetData reject FILECONTENTS index {} files={} hr={:#x}",
                format_desc,
                object.files.len(),
                hr.0 as u32
            );
            return hr;
        }
        if !tymed_matches(format.tymed, FILECONTENTS_SUPPORTED_TYMED) {
            log::debug!(
                "[clipboard-win] IDataObject::QueryGetData reject FILECONTENTS tymed {} expected_mask={:#x}",
                format_desc,
                FILECONTENTS_SUPPORTED_TYMED
            );
            return DV_E_TYMED;
        }
        log::debug!(
            "[clipboard-win] IDataObject::QueryGetData accept FILECONTENTS {} files={}",
            format_desc,
            object.files.len()
        );
        return S_OK;
    }

    log::debug!(
        "[clipboard-win] IDataObject::QueryGetData reject clipformat {} expected descriptor={} contents={}",
        format_desc,
        object.file_descriptor_cf,
        object.file_contents_cf
    );
    DV_E_CLIPFORMAT
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn data_object_get_canonical_format_etc(
    _this: *mut c_void,
    _pformatetc_in: *const FORMATETC,
    pformatetc_out: *mut FORMATETC,
) -> HRESULT {
    if !pformatetc_out.is_null() {
        unsafe {
            (*pformatetc_out).ptd = null_mut();
        }
    }
    DATA_S_SAMEFORMATETC
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn data_object_set_data(
    _this: *mut c_void,
    pformatetc: *const FORMATETC,
    pmedium: *const RawStgMedium,
    _frelease: i32,
) -> HRESULT {
    if pformatetc.is_null() || pmedium.is_null() {
        return E_POINTER;
    }
    let format = unsafe { &*pformatetc };
    let medium = unsafe { &*pmedium };

    // Accept and log the data for debugging; common callers set
    // CFSTR_PERFORMEDDROPEFFECT or similar after consuming files.
    log::debug!(
        "[clipboard-win] IDataObject::SetData accepted cf={} tymed={:#x} fRelease={}",
        format.cfFormat,
        medium.tymed,
        _frelease
    );
    S_OK
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn data_object_enum_format_etc(
    this: *mut c_void,
    dwdirection: u32,
    ppenum: *mut *mut c_void,
) -> HRESULT {
    if ppenum.is_null() {
        return E_POINTER;
    }

    if dwdirection != DATADIR_GET.0 as u32 {
        unsafe {
            *ppenum = null_mut();
        }
        log::debug!(
            "[clipboard-win] IDataObject::EnumFormatEtc unsupported direction={}",
            dwdirection
        );
        return E_NOTIMPL;
    }

    let object = unsafe { &*(this as *mut DataObject) };
    let single_file_mode = object.files.len() == 1;
    let mut items =
        Vec::with_capacity(1 + object.files.len() + if single_file_mode { 2 } else { 0 });
    items.push(FORMATETC {
        cfFormat: object.file_descriptor_cf,
        ptd: null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    });
    if single_file_mode {
        items.push(FORMATETC {
            cfFormat: object.file_descriptor_cf,
            ptd: null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: 0,
            tymed: TYMED_HGLOBAL.0 as u32,
        });
        items.push(FORMATETC {
            cfFormat: object.file_contents_cf,
            ptd: null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: FILECONTENTS_SUPPORTED_TYMED,
        });
        items.push(FORMATETC {
            cfFormat: object.file_contents_cf,
            ptd: null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: 0,
            tymed: FILECONTENTS_SUPPORTED_TYMED,
        });
    } else {
        for index in 0..object.files.len() {
            items.push(FORMATETC {
                cfFormat: object.file_contents_cf,
                ptd: null_mut(),
                dwAspect: DVASPECT_CONTENT.0,
                lindex: index as i32,
                tymed: FILECONTENTS_SUPPORTED_TYMED,
            });
        }
    }
    log::debug!(
        "[clipboard-win] IDataObject::EnumFormatEtc DATADIR_GET files={} single_file_mode={} entries={}",
        object.files.len(),
        single_file_mode,
        items.len()
    );
    for item in &items {
        log::trace!(
            "[clipboard-win] IDataObject::EnumFormatEtc entry {}",
            describe_format_etc(item)
        );
    }

    let enumerator = Box::new(EnumFormatEtcObject {
        vtable: &ENUM_FORMAT_ETC_VTABLE,
        ref_count: AtomicU32::new(1),
        items,
        cursor: Mutex::new(0),
    });

    unsafe {
        *ppenum = Box::into_raw(enumerator) as *mut c_void;
    }
    S_OK
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn data_object_dadvise(
    _this: *mut c_void,
    _pformatetc: *const FORMATETC,
    _advf: u32,
    _padvsink: *mut c_void,
    _pdwconnection: *mut u32,
) -> HRESULT {
    OLE_E_ADVISENOTSUPPORTED
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn data_object_dunadvise(_this: *mut c_void, _dwconnection: u32) -> HRESULT {
    OLE_E_ADVISENOTSUPPORTED
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn data_object_enum_dadvise(
    _this: *mut c_void,
    _ppenum: *mut *mut c_void,
) -> HRESULT {
    OLE_E_ADVISENOTSUPPORTED
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_query_interface(
    this: *mut c_void,
    riid: *const GUID,
    ppv: *mut *mut c_void,
) -> HRESULT {
    if riid.is_null() || ppv.is_null() {
        return E_POINTER;
    }

    let iid = unsafe { *riid };
    if iid == IID_IUNKNOWN || iid == IID_IENUMFORMATETC {
        unsafe {
            *ppv = this;
        }
        let _ = unsafe { enum_add_ref(this) };
        return S_OK;
    }

    unsafe {
        *ppv = null_mut();
    }
    E_NOINTERFACE
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_add_ref(this: *mut c_void) -> u32 {
    let object = unsafe { &*(this as *mut EnumFormatEtcObject) };
    object.ref_count.fetch_add(1, Ordering::AcqRel) + 1
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_release(this: *mut c_void) -> u32 {
    let object = unsafe { &*(this as *mut EnumFormatEtcObject) };
    let next = object.ref_count.fetch_sub(1, Ordering::AcqRel) - 1;
    if next == 0 {
        unsafe {
            drop(Box::from_raw(this as *mut EnumFormatEtcObject));
        }
    }
    next
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_next(
    this: *mut c_void,
    celt: u32,
    rgelt: *mut FORMATETC,
    pcelt_fetched: *mut u32,
) -> HRESULT {
    if celt > 1 && pcelt_fetched.is_null() {
        return E_POINTER;
    }
    if rgelt.is_null() {
        return E_POINTER;
    }

    let object = unsafe { &*(this as *mut EnumFormatEtcObject) };
    let mut cursor = object.cursor.lock().unwrap_or_else(|e| e.into_inner());
    let mut fetched = 0u32;

    while fetched < celt && *cursor < object.items.len() {
        unsafe {
            *rgelt.add(fetched as usize) = object.items[*cursor];
        }
        log::trace!(
            "[clipboard-win] IEnumFORMATETC::Next fetch index={} format={}",
            *cursor,
            describe_format_etc(&object.items[*cursor])
        );
        fetched += 1;
        *cursor += 1;
    }

    if !pcelt_fetched.is_null() {
        unsafe {
            *pcelt_fetched = fetched;
        }
    }

    if fetched == celt {
        S_OK
    } else {
        S_FALSE
    }
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_skip(this: *mut c_void, celt: u32) -> HRESULT {
    let object = unsafe { &*(this as *mut EnumFormatEtcObject) };
    let mut cursor = object.cursor.lock().unwrap_or_else(|e| e.into_inner());
    let remaining = object.items.len().saturating_sub(*cursor);
    if celt as usize > remaining {
        *cursor = object.items.len();
        log::trace!(
            "[clipboard-win] IEnumFORMATETC::Skip celt={} remaining={} -> S_FALSE",
            celt,
            remaining
        );
        return S_FALSE;
    }
    *cursor += celt as usize;
    log::trace!(
        "[clipboard-win] IEnumFORMATETC::Skip celt={} remaining={} -> cursor={}",
        celt,
        remaining,
        *cursor
    );
    S_OK
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_reset(this: *mut c_void) -> HRESULT {
    let object = unsafe { &*(this as *mut EnumFormatEtcObject) };
    let mut cursor = object.cursor.lock().unwrap_or_else(|e| e.into_inner());
    *cursor = 0;
    log::trace!("[clipboard-win] IEnumFORMATETC::Reset");
    S_OK
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_clone(this: *mut c_void, ppenum: *mut *mut c_void) -> HRESULT {
    if ppenum.is_null() {
        return E_POINTER;
    }
    let object = unsafe { &*(this as *mut EnumFormatEtcObject) };
    let cursor = *object.cursor.lock().unwrap_or_else(|e| e.into_inner());
    let cloned = Box::new(EnumFormatEtcObject {
        vtable: &ENUM_FORMAT_ETC_VTABLE,
        ref_count: AtomicU32::new(1),
        items: object.items.clone(),
        cursor: Mutex::new(cursor),
    });
    unsafe {
        *ppenum = Box::into_raw(cloned) as *mut c_void;
    }
    log::trace!(
        "[clipboard-win] IEnumFORMATETC::Clone cursor={} entries={}",
        cursor,
        object.items.len()
    );
    S_OK
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn stream_query_interface(
    this: *mut c_void,
    riid: *const GUID,
    ppv: *mut *mut c_void,
) -> HRESULT {
    if riid.is_null() || ppv.is_null() {
        return E_POINTER;
    }

    let iid = unsafe { *riid };
    if iid == IID_IUNKNOWN || iid == IID_ISEQUENTIAL_STREAM || iid == IID_ISTREAM {
        unsafe {
            *ppv = this;
        }
        let _ = unsafe { stream_add_ref(this) };
        return S_OK;
    }

    unsafe {
        *ppv = null_mut();
    }
    E_NOINTERFACE
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn stream_add_ref(this: *mut c_void) -> u32 {
    let object = unsafe { &*(this as *mut StreamObject) };
    object.ref_count.fetch_add(1, Ordering::AcqRel) + 1
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn stream_release(this: *mut c_void) -> u32 {
    let object = unsafe { &*(this as *mut StreamObject) };
    let next = object.ref_count.fetch_sub(1, Ordering::AcqRel) - 1;
    if next == 0 {
        unsafe {
            drop(Box::from_raw(this as *mut StreamObject));
        }
    }
    next
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn stream_read(
    this: *mut c_void,
    pv: *mut c_void,
    cb: u32,
    pcb_read: *mut u32,
) -> HRESULT {
    if cb > 0 && pv.is_null() {
        return E_POINTER;
    }

    let object = unsafe { &*(this as *mut StreamObject) };
    let mut cursor = object.cursor.lock().unwrap_or_else(|e| e.into_inner());
    let before = *cursor;
    let remaining = object.data.len().saturating_sub(*cursor);
    let to_copy = remaining.min(cb as usize);

    if to_copy > 0 {
        unsafe {
            copy_nonoverlapping(object.data.as_ptr().add(*cursor), pv.cast::<u8>(), to_copy);
        }
        *cursor += to_copy;
    }

    if !pcb_read.is_null() {
        unsafe {
            *pcb_read = to_copy as u32;
        }
    }
    log::trace!(
        "[clipboard-win] IStream::Read requested={} read={} cursor={}->{} size={}",
        cb,
        to_copy,
        before,
        *cursor,
        object.data.len()
    );

    if to_copy == cb as usize {
        S_OK
    } else {
        S_FALSE
    }
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn stream_write(
    _this: *mut c_void,
    _pv: *const c_void,
    _cb: u32,
    pcb_written: *mut u32,
) -> HRESULT {
    if !pcb_written.is_null() {
        unsafe {
            *pcb_written = 0;
        }
    }
    log::trace!("[clipboard-win] IStream::Write denied on read-only stream");
    STG_E_ACCESSDENIED
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn stream_seek(
    this: *mut c_void,
    dlib_move: i64,
    dw_origin: u32,
    plib_new_position: *mut u64,
) -> HRESULT {
    let object = unsafe { &*(this as *mut StreamObject) };
    let mut cursor = object.cursor.lock().unwrap_or_else(|e| e.into_inner());
    let before = *cursor;
    let base = match dw_origin {
        x if x == STREAM_SEEK_SET.0 => 0i128,
        x if x == STREAM_SEEK_CUR.0 => *cursor as i128,
        x if x == STREAM_SEEK_END.0 => object.data.len() as i128,
        _ => {
            log::debug!(
                "[clipboard-win] IStream::Seek invalid origin={} move={}",
                dw_origin,
                dlib_move
            );
            return E_INVALIDARG;
        }
    };

    let next = base + (dlib_move as i128);
    if next < 0 || next > usize::MAX as i128 {
        log::debug!(
            "[clipboard-win] IStream::Seek out of range origin={} move={} base={} size={}",
            dw_origin,
            dlib_move,
            base,
            object.data.len()
        );
        return E_INVALIDARG;
    }

    *cursor = next as usize;
    if !plib_new_position.is_null() {
        unsafe {
            *plib_new_position = *cursor as u64;
        }
    }
    log::trace!(
        "[clipboard-win] IStream::Seek origin={} move={} cursor={}->{} size={} eof_or_beyond={}",
        dw_origin,
        dlib_move,
        before,
        *cursor,
        object.data.len(),
        *cursor >= object.data.len()
    );
    S_OK
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn stream_set_size(_this: *mut c_void, _lib_new_size: u64) -> HRESULT {
    log::trace!("[clipboard-win] IStream::SetSize denied on read-only stream");
    STG_E_ACCESSDENIED
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn stream_copy_to(
    this: *mut c_void,
    pstm: *mut c_void,
    cb: u64,
    pcb_read: *mut u64,
    pcb_written: *mut u64,
) -> HRESULT {
    if pstm.is_null() {
        return E_POINTER;
    }

    let object = unsafe { &*(this as *mut StreamObject) };
    let target = pstm as *mut RawStreamInterface;
    if unsafe { (*target).vtable.is_null() } {
        return E_POINTER;
    }
    let start_cursor = *object.cursor.lock().unwrap_or_else(|e| e.into_inner());
    log::trace!(
        "[clipboard-win] IStream::CopyTo requested={} start_cursor={} size={}",
        cb,
        start_cursor,
        object.data.len()
    );

    let write_fn = unsafe { (*(*target).vtable).write };
    let mut total_read = 0u64;
    let mut total_written = 0u64;
    let mut remaining = cb;

    while remaining > 0 {
        let (start, chunk_len_u32) = {
            let cursor = object.cursor.lock().unwrap_or_else(|e| e.into_inner());
            if *cursor >= object.data.len() {
                break;
            }
            let available = (object.data.len() - *cursor) as u64;
            let chunk_len = remaining.min(available).min(u32::MAX as u64);
            if chunk_len == 0 {
                break;
            }
            (*cursor, chunk_len as u32)
        };

        let src_ptr = unsafe { object.data.as_ptr().add(start) }.cast::<c_void>();
        let mut written_now = 0u32;
        let hr = unsafe { write_fn(pstm, src_ptr, chunk_len_u32, &mut written_now as *mut u32) };
        if hr != S_OK && hr != S_FALSE {
            if !pcb_read.is_null() {
                unsafe {
                    *pcb_read = total_read;
                }
            }
            if !pcb_written.is_null() {
                unsafe {
                    *pcb_written = total_written;
                }
            }
            log::debug!(
                "[clipboard-win] IStream::CopyTo target write failed hr={:#x} requested={} read={} written={}",
                hr.0 as u32,
                cb,
                total_read,
                total_written
            );
            return hr;
        }

        let advanced = written_now.min(chunk_len_u32) as usize;
        {
            let mut cursor = object.cursor.lock().unwrap_or_else(|e| e.into_inner());
            let safe_advanced = advanced.min(object.data.len().saturating_sub(*cursor));
            *cursor += safe_advanced;
        }

        total_read += advanced as u64;
        total_written += advanced as u64;
        remaining = remaining.saturating_sub(advanced as u64);

        if hr == S_FALSE || advanced == 0 || written_now < chunk_len_u32 {
            break;
        }
    }

    if !pcb_read.is_null() {
        unsafe {
            *pcb_read = total_read;
        }
    }
    if !pcb_written.is_null() {
        unsafe {
            *pcb_written = total_written;
        }
    }
    log::trace!(
        "[clipboard-win] IStream::CopyTo done read={} written={} remaining={}",
        total_read,
        total_written,
        remaining
    );

    if remaining == 0 {
        S_OK
    } else {
        S_FALSE
    }
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn stream_commit(_this: *mut c_void, _grf_commit_flags: u32) -> HRESULT {
    log::trace!("[clipboard-win] IStream::Commit no-op on in-memory stream");
    S_OK
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn stream_revert(_this: *mut c_void) -> HRESULT {
    log::trace!("[clipboard-win] IStream::Revert not supported");
    STG_E_INVALIDFUNCTION
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn stream_lock_region(
    _this: *mut c_void,
    _lib_offset: u64,
    _cb: u64,
    _dw_lock_type: u32,
) -> HRESULT {
    log::trace!("[clipboard-win] IStream::LockRegion not supported");
    STG_E_INVALIDFUNCTION
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn stream_unlock_region(
    _this: *mut c_void,
    _lib_offset: u64,
    _cb: u64,
    _dw_lock_type: u32,
) -> HRESULT {
    log::trace!("[clipboard-win] IStream::UnlockRegion not supported");
    STG_E_INVALIDFUNCTION
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn stream_stat(
    this: *mut c_void,
    pstatstg: *mut STATSTG,
    _grf_stat_flag: u32,
) -> HRESULT {
    if pstatstg.is_null() {
        return E_POINTER;
    }
    let object = unsafe { &*(this as *mut StreamObject) };
    let mut stat: STATSTG = unsafe { zeroed() };
    stat.r#type = STGTY_STREAM.0 as u32;
    stat.cbSize = object.data.len() as u64;
    stat.grfMode = STGM_READ;
    stat.pwcsName = PWSTR::null();
    unsafe {
        *pstatstg = stat;
    }
    log::trace!(
        "[clipboard-win] IStream::Stat size={} grfMode={:#x}",
        object.data.len(),
        stat.grfMode.0
    );
    S_OK
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn stream_clone(this: *mut c_void, ppstm: *mut *mut c_void) -> HRESULT {
    if ppstm.is_null() {
        return E_POINTER;
    }
    let object = unsafe { &*(this as *mut StreamObject) };
    let cursor = *object.cursor.lock().unwrap_or_else(|e| e.into_inner());
    let cloned = Box::new(StreamObject {
        vtable: &STREAM_VTABLE,
        ref_count: AtomicU32::new(1),
        data: Arc::clone(&object.data),
        cursor: Mutex::new(cursor),
    });
    unsafe {
        *ppstm = Box::into_raw(cloned) as *mut c_void;
    }
    log::trace!(
        "[clipboard-win] IStream::Clone cursor={} size={}",
        cursor,
        object.data.len()
    );
    S_OK
}

#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
pub fn write_files_with_native_virtual_data_object(
    _files: &[VirtualClipboardFile],
) -> Result<Option<VirtualClipboardWriteResult>, String> {
    Ok(None)
}

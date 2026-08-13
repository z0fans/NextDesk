#[cfg(target_os = "windows")]
mod platform {
    use super::super::focus_policy::should_focus_rdp_control;
    use std::{
        collections::HashMap,
        ffi::c_void,
        mem::ManuallyDrop,
        sync::{mpsc, Arc, Mutex, MutexGuard, OnceLock},
        time::{Duration, Instant},
    };

    use serde::{Deserialize, Serialize};
    use serde_json::json;
    use tauri::{AppHandle, Manager};

    use crate::logging::rdp_debug;
    use windows::{
        core::{IUnknown_Vtbl, Interface, BSTR, GUID, PCSTR, PCWSTR},
        Win32::{
            Foundation::{
                GetLastError, HANDLE, HGLOBAL, HWND, LPARAM, POINT, RECT, VARIANT_BOOL,
                VARIANT_FALSE, VARIANT_TRUE, WPARAM,
            },
            Graphics::Gdi::{
                ClientToScreen, CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_DIFF,
                RGN_ERROR,
            },
            System::{
                Com::{
                    IDispatch, DISPATCH_METHOD, DISPATCH_PROPERTYGET, DISPATCH_PROPERTYPUT,
                    DISPPARAMS,
                },
                DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData},
                LibraryLoader::{GetProcAddress, LoadLibraryW},
                Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
                Ole::{OleInitialize, CF_UNICODETEXT, DISPID_PROPERTYPUT},
                Variant::{
                    VariantClear, VARIANT, VT_BOOL, VT_BSTR, VT_DISPATCH, VT_I2, VT_I4, VT_UI4,
                },
            },
            UI::{
                Input::KeyboardAndMouse::{
                    GetActiveWindow, GetFocus, MapVirtualKeyW, SendInput, SetActiveWindow,
                    SetFocus, VkKeyScanW, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
                    KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, MAPVK_VK_TO_VSC,
                    MAPVK_VK_TO_VSC_EX, MAPVK_VSC_TO_VK_EX, VIRTUAL_KEY,
                },
                WindowsAndMessaging::{
                    CreateWindowExW, DestroyWindow, GetForegroundWindow, GetWindowRect, IsChild,
                    IsWindowVisible, PostMessageW, SendMessageW, SetWindowPos, ShowWindow, HMENU,
                    SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, SW_SHOWNOACTIVATE, WINDOW_EX_STYLE,
                    WINDOW_STYLE, WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_EX_NOACTIVATE,
                    WS_EX_TOOLWINDOW, WS_POPUP, WS_VISIBLE,
                },
            },
        },
    };

    const HOST_WINDOW_LABEL: &str = "main";
    const RDP_HOST_WINDOW_MODE: &str = "owned-popup";
    const HIDDEN_RDP_POSITION: i32 = -32_000;
    const LOCALE_USER_DEFAULT: u32 = 0x0400;
    const RDP_MIN_DESKTOP_WIDTH: i32 = 640;
    const RDP_MIN_DESKTOP_HEIGHT: i32 = 480;
    const RDP_UNKNOWN_PHYSICAL_SIZE_MM: i32 = 0;
    const RDP_DISPLAY_ORIENTATION_LANDSCAPE: i32 = 0;
    const RDP_DISPLAY_SCALE_FACTOR_PERCENT: i32 = 100;
    const RDP_CONNECTED_STATE: i32 = 1;
    const RDP_ESTABLISHING_STATE: i32 = 2;
    const RDP_STANDARD_SAS_SEQUENCE: i32 = 0xaa03;
    const VK_CONTROL_KEY: usize = 0x11;
    const VK_ALT_KEY: usize = 0x12;
    const VK_END_KEY: usize = 0x23;
    const VK_RETURN_KEY: usize = 0x0D;
    const VK_ESCAPE_KEY: usize = 0x1B;
    const VK_BACKSPACE_KEY: usize = 0x08;
    const VK_DELETE_KEY: usize = 0x2E;
    const VK_TAB_KEY: usize = 0x09;
    const VK_SHIFT_KEY: usize = 0x10;
    const VK_V_KEY: usize = 0x56;
    const VK_SPACE_KEY: usize = 0x20;
    const VK_HOME_KEY: usize = 0x24;
    const VK_LEFT_KEY: usize = 0x25;
    const VK_UP_KEY: usize = 0x26;
    const VK_RIGHT_KEY: usize = 0x27;
    const VK_DOWN_KEY: usize = 0x28;
    const VK_PAGE_UP_KEY: usize = 0x21;
    const VK_PAGE_DOWN_KEY: usize = 0x22;
    const WM_LBUTTONDOWN_MSG: u32 = 0x0201;
    const WM_LBUTTONUP_MSG: u32 = 0x0202;
    const WM_RBUTTONDOWN_MSG: u32 = 0x0204;
    const WM_RBUTTONUP_MSG: u32 = 0x0205;
    const WM_MBUTTONDOWN_MSG: u32 = 0x0207;
    const WM_MBUTTONUP_MSG: u32 = 0x0208;
    const WM_KEYDOWN_MSG: u32 = 0x0100;
    const WM_KEYUP_MSG: u32 = 0x0101;
    const MK_LBUTTON_WPARAM: usize = 0x0001;
    const MK_RBUTTON_WPARAM: usize = 0x0002;
    const MK_MBUTTON_WPARAM: usize = 0x0010;
    const RDP_TEXT_MODE_CLIPBOARD: &str = "clipboard";
    const RDP_TEXT_MODE_SEND_KEYS: &str = "sendKeys";
    const RDP_TEXT_LIMIT: usize = 64 * 1024;
    const RDP_SEND_KEYS_LIMIT: usize = 20;
    const RDP_MAIN_THREAD_WARN_AFTER: Duration = Duration::from_secs(2);
    const RDP_MAIN_THREAD_TIMEOUT: Duration = Duration::from_secs(15);
    const RDP_PROGIDS: &[&str] = &[
        "MsTscAx.MsTscAx.13",
        "MsTscAx.MsTscAx.12",
        "MsTscAx.MsTscAx.11",
        "MsTscAx.MsTscAx.10",
        "MsTscAx.MsTscAx.9",
        "MsTscAx.MsTscAx.8",
        "MsTscAx.MsTscAx.7",
        "MsTscAx.MsTscAx.6",
        "MsTscAx.MsTscAx.5",
        "MsTscAx.MsTscAx.4",
        "MsTscAx.MsTscAx.3",
        "MsTscAx.MsTscAx.2",
        "MsTscAx.MsTscAx.1",
        "MsTscAx.MsTscAx",
    ];
    const ADVANCED_SETTINGS_PROPERTIES: &[&str] = &[
        "AdvancedSettings12",
        "AdvancedSettings11",
        "AdvancedSettings10",
        "AdvancedSettings9",
        "AdvancedSettings8",
        "AdvancedSettings7",
        "AdvancedSettings6",
        "AdvancedSettings5",
        "AdvancedSettings4",
        "AdvancedSettings3",
        "AdvancedSettings2",
        "AdvancedSettings",
    ];
    const EXTENDED_SETTINGS_PROPERTIES: &[&str] = &["ExtendedSettings"];
    const SECURED_SETTINGS_PROPERTIES: &[&str] = &["SecuredSettings", "SecuredSettings2"];

    #[repr(transparent)]
    #[derive(Clone)]
    struct IMsRdpClientNonScriptable(windows::core::IUnknown);

    unsafe impl Interface for IMsRdpClientNonScriptable {
        type Vtable = IMsRdpClientNonScriptableVtbl;
        const IID: GUID = GUID::from_u128(0x2f079c4c_87b2_4afd_97ab_20cdb43038ae);
    }

    #[repr(C)]
    struct IMsRdpClientNonScriptableVtbl {
        base__: IUnknown_Vtbl,
        put_clear_text_password:
            unsafe extern "system" fn(*mut c_void, BSTR) -> windows::core::HRESULT,
        put_portable_password:
            unsafe extern "system" fn(*mut c_void, BSTR) -> windows::core::HRESULT,
        get_portable_password:
            unsafe extern "system" fn(*mut c_void, *mut BSTR) -> windows::core::HRESULT,
        put_portable_salt: unsafe extern "system" fn(*mut c_void, BSTR) -> windows::core::HRESULT,
        get_portable_salt:
            unsafe extern "system" fn(*mut c_void, *mut BSTR) -> windows::core::HRESULT,
        put_binary_password: unsafe extern "system" fn(*mut c_void, BSTR) -> windows::core::HRESULT,
        get_binary_password:
            unsafe extern "system" fn(*mut c_void, *mut BSTR) -> windows::core::HRESULT,
        put_binary_salt: unsafe extern "system" fn(*mut c_void, BSTR) -> windows::core::HRESULT,
        get_binary_salt:
            unsafe extern "system" fn(*mut c_void, *mut BSTR) -> windows::core::HRESULT,
        reset_password: unsafe extern "system" fn(*mut c_void) -> windows::core::HRESULT,
        notify_redirect_device_change:
            unsafe extern "system" fn(*mut c_void, WPARAM, LPARAM) -> windows::core::HRESULT,
        send_keys: unsafe extern "system" fn(
            *mut c_void,
            i32,
            *mut VARIANT_BOOL,
            *mut i32,
        ) -> windows::core::HRESULT,
    }

    #[repr(transparent)]
    #[derive(Clone)]
    struct IMsRdpClientNonScriptable3(windows::core::IUnknown);

    unsafe impl Interface for IMsRdpClientNonScriptable3 {
        type Vtable = IMsRdpClientNonScriptable3Vtbl;
        const IID: GUID = GUID::from_u128(0xb3378d90_0728_45c7_8ed7_b6159fb92219);
    }

    #[repr(C)]
    struct IMsRdpClientNonScriptable3Vtbl {
        base__: IUnknown_Vtbl,
        reserved_before_dynamic_drives: [usize; 22],
        put_redirect_dynamic_drives:
            unsafe extern "system" fn(*mut c_void, VARIANT_BOOL) -> windows::core::HRESULT,
        get_redirect_dynamic_drives:
            unsafe extern "system" fn(*mut c_void, *mut VARIANT_BOOL) -> windows::core::HRESULT,
        put_redirect_dynamic_devices:
            unsafe extern "system" fn(*mut c_void, VARIANT_BOOL) -> windows::core::HRESULT,
    }

    #[repr(transparent)]
    #[derive(Clone)]
    struct IMsRdpClientNonScriptable5(windows::core::IUnknown);

    unsafe impl Interface for IMsRdpClientNonScriptable5 {
        type Vtable = IMsRdpClientNonScriptable5Vtbl;
        const IID: GUID = GUID::from_u128(0x4f6996d5_d7b1_412c_b0ff_063718566907);
    }

    #[repr(C)]
    struct IMsRdpClientNonScriptable5Vtbl {
        base__: IUnknown_Vtbl,
        reserved_before_use_multimon: [usize; 50],
        put_use_multimon:
            unsafe extern "system" fn(*mut c_void, VARIANT_BOOL) -> windows::core::HRESULT,
        get_use_multimon:
            unsafe extern "system" fn(*mut c_void, *mut VARIANT_BOOL) -> windows::core::HRESULT,
    }

    type AtlAxWinInit = unsafe extern "system" fn() -> i32;
    type AtlAxGetControl =
        unsafe extern "system" fn(HWND, *mut *mut c_void) -> windows::core::HRESULT;

    struct AtlFunctions {
        ax_win_init: AtlAxWinInit,
        ax_get_control: AtlAxGetControl,
    }

    #[derive(Clone)]
    pub struct RdpSessionManager {
        sessions: Arc<Mutex<HashMap<String, RdpSession>>>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct StartRdpSessionRequest {
        session_id: String,
        host: String,
        user: String,
        port: Option<u16>,
        secret_owner_id: Option<String>,
        password: Option<String>,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        scale_factor: Option<f64>,
        options: Option<RdpSessionOptions>,
    }

    #[derive(Clone, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RdpSessionOptions {
        #[serde(default = "default_color_depth")]
        color_depth: u16,
        #[serde(default = "default_true")]
        redirect_clipboard: bool,
        #[serde(default)]
        redirect_drives: bool,
        #[serde(default)]
        use_multimon: bool,
        #[serde(default = "default_true")]
        bitmap_cache: bool,
        #[serde(default = "default_performance_profile")]
        performance_profile: String,
        #[serde(default = "default_remote_resolution")]
        remote_resolution: String,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum RemoteResolutionMode {
        Automatic,
        SmartSizing,
        DpiZoom,
        Fixed { width: i32, height: i32 },
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct RdpDisplaySettings {
        desktop_width: i32,
        desktop_height: i32,
        physical_width: i32,
        physical_height: i32,
        desktop_scale_factor: i32,
        device_scale_factor: i32,
    }

    impl RemoteResolutionMode {
        pub fn parse(value: &str) -> Self {
            match value.trim() {
                "automatic" | "" => Self::Automatic,
                "smartSizing" => Self::SmartSizing,
                "dpiZoom" => Self::DpiZoom,
                other => other
                    .split_once('x')
                    .and_then(|(w, h)| {
                        let width: i32 = w.parse().ok()?;
                        let height: i32 = h.parse().ok()?;
                        if width > 0 && height > 0 {
                            Some(Self::Fixed { width, height })
                        } else {
                            None
                        }
                    })
                    .unwrap_or(Self::Automatic),
            }
        }

        pub fn smart_sizing(&self) -> bool {
            matches!(self, Self::SmartSizing | Self::Fixed { .. })
        }

        pub fn tracks_pane_size(&self) -> bool {
            matches!(self, Self::Automatic | Self::DpiZoom)
        }

        fn applies_host_dpi(&self) -> bool {
            matches!(self, Self::Automatic | Self::DpiZoom)
        }

        pub fn desktop_size(
            &self,
            _logical_w: f64,
            _logical_h: f64,
            physical_w: i32,
            physical_h: i32,
        ) -> (i32, i32) {
            match self {
                // Automatic and DpiZoom render at the pane's physical pixel
                // resolution so the bitmap is 1:1 with the host surface. They
                // additionally pass the host scale factor so the remote
                // re-renders UI at the host's DPI instead of relying on local
                // SmartSizing, which makes high-DPI desktops look tiny and can
                // skew pointer transforms on FreeRDP servers such as GNOME
                // Remote Desktop. The explicit SmartSizing mode seeds the same
                // initial desktop size but then scales the bitmap locally.
                Self::Automatic | Self::SmartSizing | Self::DpiZoom => (
                    desktop_width_for(physical_w),
                    desktop_height_for(physical_h),
                ),
                Self::Fixed { width, height } => {
                    (desktop_width_for(*width), desktop_height_for(*height))
                }
            }
        }

        fn display_settings(
            &self,
            logical_w: f64,
            logical_h: f64,
            physical_w: i32,
            physical_h: i32,
            scale_factor: f64,
        ) -> RdpDisplaySettings {
            let (desktop_width, desktop_height) =
                self.desktop_size(logical_w, logical_h, physical_w, physical_h);
            let (display_physical_width, display_physical_height) =
                self.display_physical_size(desktop_width, desktop_height, physical_w, physical_h);
            RdpDisplaySettings {
                desktop_width,
                desktop_height,
                physical_width: display_physical_width,
                physical_height: display_physical_height,
                desktop_scale_factor: self.desktop_scale_factor(scale_factor),
                device_scale_factor: self.device_scale_factor(scale_factor),
            }
        }

        fn display_physical_size(
            &self,
            _desktop_width: i32,
            _desktop_height: i32,
            _physical_w: i32,
            _physical_h: i32,
        ) -> (i32, i32) {
            // MS-RDPEDISP defines physical size as millimeters, not pixels.
            // The pane only gives us logical/native pixel bounds, so send an
            // invalid small value and let the server ignore the physical-size
            // hint instead of deriving scale/input transforms from bogus mm.
            (RDP_UNKNOWN_PHYSICAL_SIZE_MM, RDP_UNKNOWN_PHYSICAL_SIZE_MM)
        }

        fn desktop_scale_factor(&self, scale_factor: f64) -> i32 {
            if !self.applies_host_dpi() {
                return RDP_DISPLAY_SCALE_FACTOR_PERCENT;
            }
            let raw = (scale_factor * 100.0).round() as i32;
            raw.clamp(100, 500)
        }

        fn device_scale_factor(&self, scale_factor: f64) -> i32 {
            if !self.applies_host_dpi() {
                return RDP_DISPLAY_SCALE_FACTOR_PERCENT;
            }
            let raw = (scale_factor * 100.0).round() as i32;
            if raw >= 160 {
                180
            } else if raw >= 120 {
                140
            } else {
                100
            }
        }
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RdpSessionStarted {
        session_id: String,
        host: String,
        port: u16,
        control: String,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RdpSessionStatus {
        session_id: String,
        connection_state: i32,
        connected: bool,
        surface_visible: bool,
        surface_onscreen: bool,
        surface_ready: bool,
        host_window_mode: &'static str,
        extended_disconnect_reason: Option<i32>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct UpdateRdpBoundsRequest {
        session_id: String,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        scale_factor: Option<f64>,
        // When set, re-issue the remote desktop resize even if the cached
        // desktop size/scale already matches. Used by the post-connect settle
        // passes: the ActiveX control often ignores the first resize, so we
        // re-apply it (while keeping the control on-screen) once the session
        // is interactive, instead of relying on a manual pane nudge.
        #[serde(default)]
        force: bool,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct SetRdpVisibilityRequest {
        session_id: String,
        visible: bool,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        scale_factor: Option<f64>,
        #[serde(default)]
        clip_rects: Vec<crate::kkterm_rdp::types::KktermRdpClipRect>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct SyncRdpDisplaySizeRequest {
        session_id: String,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        scale_factor: Option<f64>,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RdpDisplaySizeSync {
        session_id: String,
        connection_state: i32,
        connected: bool,
        extended_disconnect_reason: Option<i32>,
        display_synced: bool,
        surface_visible: bool,
        surface_onscreen: bool,
        surface_ready: bool,
        host_window_mode: &'static str,
        desktop_width: i32,
        desktop_height: i32,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RdpSimpleRequest {
        session_id: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct SendRdpTextRequest {
        session_id: String,
        text: String,
        mode: Option<String>,
        press_enter: Option<bool>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct SendRdpKeyPressRequest {
        session_id: String,
        scancode: u16,
        down: bool,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct SendRdpMouseClickRequest {
        session_id: String,
        x: u16,
        y: u16,
        button: String,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RdpTextSent {
        session_id: String,
        mode: String,
        fell_back: bool,
        char_count: u32,
    }

    struct RdpSession {
        hwnd: HWND,
        owner: HWND,
        dispatch: IDispatch,
        desktop_width: i32,
        desktop_height: i32,
        desktop_scale_factor: i32,
        device_scale_factor: i32,
        dynamic_resize_failures: u32,
        resolution_mode: RemoteResolutionMode,
        viewport_bounds: RdpViewportBounds,
        visible: bool,
    }

    #[derive(Clone, Copy)]
    struct RdpViewportBounds {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        scale_factor: f64,
    }

    #[derive(Clone, Copy)]
    struct RdpSurfaceState {
        visible: bool,
        onscreen: bool,
        ready: bool,
        rect: Option<(i32, i32, i32, i32)>,
    }

    // These values are always created, used, and destroyed through closures
    // dispatched onto Tauri's main thread. The marker lets the session map live
    // behind app state while preserving that thread-affinity by convention.
    unsafe impl Send for RdpSession {}

    struct VariantArg(VARIANT);

    fn rdp_request_scale_factor(requested: Option<f64>, host_scale_factor: f64) -> f64 {
        requested
            .filter(|scale| scale.is_finite() && *scale >= 0.25 && *scale <= 8.0)
            .unwrap_or(host_scale_factor)
    }

    fn update_viewport_bounds(
        session: &mut RdpSession,
        scale_factor: f64,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) {
        session.viewport_bounds = RdpViewportBounds {
            x,
            y,
            width,
            height,
            scale_factor,
        };
    }

    impl RdpSessionManager {
        pub fn new() -> Self {
            Self {
                sessions: Arc::new(Mutex::new(HashMap::new())),
            }
        }

        pub fn start_session(
            &self,
            app: AppHandle,
            request: StartRdpSessionRequest,
        ) -> Result<RdpSessionStarted, String> {
            let sessions = Arc::clone(&self.sessions);
            run_on_main_thread("start_rdp_session", app, move |app| {
                start_session_on_main_thread(sessions, &app, request)
            })
        }

        pub fn update_bounds(
            &self,
            app: AppHandle,
            request: UpdateRdpBoundsRequest,
        ) -> Result<(), String> {
            let sessions = Arc::clone(&self.sessions);
            run_on_main_thread("update_rdp_bounds", app, move |app| {
                let host_window = app
                    .get_webview_window(HOST_WINDOW_LABEL)
                    .ok_or_else(|| format!("host window '{HOST_WINDOW_LABEL}' is not available"))?;
                let host_scale_factor = host_window
                    .scale_factor()
                    .map_err(|error| format!("failed to read host window scale factor: {error}"))?;
                let scale_factor =
                    rdp_request_scale_factor(request.scale_factor, host_scale_factor);
                let mut sessions = lock_sessions(&sessions)?;
                let session = sessions
                    .get_mut(&request.session_id)
                    .ok_or_else(|| format!("RDP session '{}' was not found", request.session_id))?;
                update_viewport_bounds(
                    session,
                    scale_factor,
                    request.x,
                    request.y,
                    request.width,
                    request.height,
                );
                show_and_resize_rdp(
                    session,
                    scale_factor,
                    request.x,
                    request.y,
                    request.width,
                    request.height,
                    request.force,
                )
            })
        }

        pub fn set_visibility(
            &self,
            app: AppHandle,
            request: SetRdpVisibilityRequest,
        ) -> Result<(), String> {
            let sessions = Arc::clone(&self.sessions);
            run_on_main_thread("set_rdp_visibility", app, move |app| {
                let host_window = app
                    .get_webview_window(HOST_WINDOW_LABEL)
                    .ok_or_else(|| format!("host window '{HOST_WINDOW_LABEL}' is not available"))?;
                let host_scale_factor = host_window
                    .scale_factor()
                    .map_err(|error| format!("failed to read host window scale factor: {error}"))?;
                let scale_factor =
                    rdp_request_scale_factor(request.scale_factor, host_scale_factor);
                let mut sessions = lock_sessions(&sessions)?;
                if request.visible {
                    let mut parked_other_sessions = 0;
                    for (other_session_id, other_session) in sessions.iter_mut() {
                        if other_session_id != &request.session_id {
                            park_rdp_at_current_size(other_session.hwnd)?;
                            other_session.visible = false;
                            parked_other_sessions += 1;
                        }
                    }
                    let session = sessions.get_mut(&request.session_id).ok_or_else(|| {
                        format!("RDP session '{}' was not found", request.session_id)
                    })?;
                    update_viewport_bounds(
                        session,
                        scale_factor,
                        request.x,
                        request.y,
                        request.width,
                        request.height,
                    );
                    let connection_state =
                        get_property_i32(&session.dispatch, "Connected").unwrap_or(-1);
                    let rect = show_rdp_for_session(
                        session,
                        scale_factor,
                        request.x,
                        request.y,
                        request.width,
                        request.height,
                    )?;
                    apply_rdp_clip_region(
                        session.hwnd,
                        session.owner,
                        rect,
                        request.x,
                        request.y,
                        request.width,
                        request.height,
                        &request.clip_rects,
                        scale_factor,
                    )?;
                    session.visible = true;
                    let surface = rdp_surface_state(session);
                    rdp_debug(
                        "visibility.set",
                        &json!({
                            "sessionId": &request.session_id,
                            "visible": true,
                            "connectionState": connection_state,
                            "connectionStateLabel": rdp_connection_state_label(connection_state),
                            "scaleFactor": scale_factor,
                            "hostScaleFactor": host_scale_factor,
                            "requestBounds": {
                                "x": request.x,
                                "y": request.y,
                                "width": request.width,
                                "height": request.height,
                            },
                            "nativeRect": {
                                "x": rect.0,
                                "y": rect.1,
                                "width": rect.2,
                                "height": rect.3,
                            },
                                "clipRects": request.clip_rects.iter().map(|rect| json!({
                                    "x": rect.x,
                                    "y": rect.y,
                                    "width": rect.width,
                                    "height": rect.height,
                                })).collect::<Vec<_>>(),
                            "parkedOtherSessions": parked_other_sessions,
                            "hostWindowMode": RDP_HOST_WINDOW_MODE,
                            "surfaceVisible": surface.visible,
                            "surfaceOnscreen": surface.onscreen,
                            "surfaceReady": surface.ready,
                            "surfaceRect": surface.rect.map(|rect| json!({
                                "x": rect.0,
                                "y": rect.1,
                                "width": rect.2,
                                "height": rect.3,
                            })),
                        }),
                    );
                    Ok(())
                } else {
                    let session = sessions.get_mut(&request.session_id).ok_or_else(|| {
                        format!("RDP session '{}' was not found", request.session_id)
                    })?;
                    update_viewport_bounds(
                        session,
                        scale_factor,
                        request.x,
                        request.y,
                        request.width,
                        request.height,
                    );
                    let connection_state =
                        get_property_i32(&session.dispatch, "Connected").unwrap_or(-1);
                    let rect = stage_rdp(
                        session.hwnd,
                        scale_factor,
                        request.x,
                        request.y,
                        request.width,
                        request.height,
                    )?;
                    reset_rdp_clip_region(session.hwnd)?;
                    session.visible = false;
                    rdp_debug(
                        "visibility.set",
                        &json!({
                            "sessionId": &request.session_id,
                            "visible": false,
                            "connectionState": connection_state,
                            "connectionStateLabel": rdp_connection_state_label(connection_state),
                            "scaleFactor": scale_factor,
                            "requestBounds": {
                                "x": request.x,
                                "y": request.y,
                                "width": request.width,
                                "height": request.height,
                            },
                            "nativeRect": {
                                "x": rect.0,
                                "y": rect.1,
                                "width": rect.2,
                                "height": rect.3,
                            },
                        }),
                    );
                    Ok(())
                }
            })
        }

        pub fn follow_host_window(&self, app: AppHandle) -> Result<(), String> {
            let sessions = Arc::clone(&self.sessions);
            run_on_main_thread_quiet("follow_rdp_host_window", app, move |_app| {
                let sessions = lock_sessions(&sessions)?;
                for session in sessions.values().filter(|session| session.visible) {
                    follow_rdp_host_window(session)?;
                }
                Ok(())
            })
        }

        pub fn sync_display_size(
            &self,
            app: AppHandle,
            request: SyncRdpDisplaySizeRequest,
        ) -> Result<RdpDisplaySizeSync, String> {
            let sessions = Arc::clone(&self.sessions);
            run_on_main_thread("sync_rdp_display_size", app, move |app| {
                let host_window = app
                    .get_webview_window(HOST_WINDOW_LABEL)
                    .ok_or_else(|| format!("host window '{HOST_WINDOW_LABEL}' is not available"))?;
                let host_scale_factor = host_window
                    .scale_factor()
                    .map_err(|error| format!("failed to read host window scale factor: {error}"))?;
                let scale_factor =
                    rdp_request_scale_factor(request.scale_factor, host_scale_factor);
                let mut sessions = lock_sessions(&sessions)?;
                let session = sessions
                    .get_mut(&request.session_id)
                    .ok_or_else(|| format!("RDP session '{}' was not found", request.session_id))?;
                let tracks_pane_size = session.resolution_mode.tracks_pane_size();
                // Display-size synchronization must not move the native window.
                // Bounds updates run continuously while the user drags the host
                // window; coupling them to UpdateSessionDisplaySettings caused
                // repeated remote resizes and visible frame stalls. The caller
                // positions/clips the ActiveX HWND separately, while this command
                // issues at most one debounced display update for the final size.
                let rect = scaled_rect(
                    request.x,
                    request.y,
                    request.width,
                    request.height,
                    scale_factor,
                );
                let geometry_source = "computed-without-window-move";
                let display_settings = session.resolution_mode.display_settings(
                    request.width,
                    request.height,
                    rect.2,
                    rect.3,
                    scale_factor,
                );
                let connection_state = get_property_i32(&session.dispatch, "Connected")?;
                let connected = is_rdp_connected_state(connection_state);
                let extended_disconnect_reason = (connection_state == 0)
                    .then(|| get_property_i32(&session.dispatch, "ExtendedDisconnectReason").ok())
                    .flatten();
                let displayable = is_rdp_displayable_state(connection_state);
                let display_sync_attempted = tracks_pane_size && displayable;
                let display_sync_completed = display_sync_attempted
                    && sync_remote_desktop_size(session, display_settings, false);
                let display_synced =
                    rdp_display_ready_after_sync(connection_state, display_sync_completed);
                let surface = rdp_surface_state(session);
                rdp_debug(
                    "display.sync.state",
                    &json!({
                        "sessionId": &request.session_id,
                        "connectionState": connection_state,
                        "connectionStateLabel": rdp_connection_state_label(connection_state),
                        "active": displayable,
                        "connected": connected,
                        "displayable": displayable,
                        "tracksPaneSize": tracks_pane_size,
                        "geometrySource": geometry_source,
                        "displaySyncAttempted": display_sync_attempted,
                        "displaySyncCompleted": display_sync_completed,
                        "displaySynced": display_synced,
                        "hostWindowMode": RDP_HOST_WINDOW_MODE,
                        "surfaceVisible": surface.visible,
                        "surfaceOnscreen": surface.onscreen,
                        "surfaceReady": surface.ready,
                        "surfaceRect": surface.rect.map(|rect| json!({
                            "x": rect.0,
                            "y": rect.1,
                            "width": rect.2,
                            "height": rect.3,
                        })),
                        "scaleFactor": scale_factor,
                        "hostScaleFactor": host_scale_factor,
                        "requestBounds": {
                            "x": request.x,
                            "y": request.y,
                            "width": request.width,
                            "height": request.height,
                        },
                        "nativeRect": {
                            "x": rect.0,
                            "y": rect.1,
                            "width": rect.2,
                            "height": rect.3,
                        },
                        "displaySettings": {
                            "desktopWidth": display_settings.desktop_width,
                            "desktopHeight": display_settings.desktop_height,
                            "physicalWidth": display_settings.physical_width,
                            "physicalHeight": display_settings.physical_height,
                            "desktopScaleFactor": display_settings.desktop_scale_factor,
                            "deviceScaleFactor": display_settings.device_scale_factor,
                        },
                        "storedDesktop": {
                            "width": session.desktop_width,
                            "height": session.desktop_height,
                            "desktopScaleFactor": session.desktop_scale_factor,
                            "deviceScaleFactor": session.device_scale_factor,
                        },
                    }),
                );
                Ok(RdpDisplaySizeSync {
                    session_id: request.session_id,
                    connection_state,
                    connected,
                    extended_disconnect_reason,
                    display_synced,
                    surface_visible: surface.visible,
                    surface_onscreen: surface.onscreen,
                    surface_ready: connected && surface.ready,
                    host_window_mode: RDP_HOST_WINDOW_MODE,
                    desktop_width: session.desktop_width,
                    desktop_height: session.desktop_height,
                })
            })
        }

        pub fn close_session(
            &self,
            app: AppHandle,
            request: RdpSimpleRequest,
        ) -> Result<(), String> {
            let sessions = Arc::clone(&self.sessions);
            run_on_main_thread("close_rdp_session", app, move |_app| {
                let mut sessions = lock_sessions(&sessions)?;
                if let Some(session) = sessions.remove(&request.session_id) {
                    let _ = invoke_method(&session.dispatch, "Disconnect");
                    unsafe {
                        DestroyWindow(session.hwnd).map_err(|error| {
                            format!("failed to destroy RDP host window: {error}")
                        })?;
                    }
                }
                Ok(())
            })
        }

        pub fn session_status(
            &self,
            app: AppHandle,
            request: RdpSimpleRequest,
        ) -> Result<RdpSessionStatus, String> {
            let sessions = Arc::clone(&self.sessions);
            run_on_main_thread("get_rdp_session_status", app, move |_app| {
                let sessions = lock_sessions(&sessions)?;
                let session = sessions
                    .get(&request.session_id)
                    .ok_or_else(|| format!("RDP session '{}' was not found", request.session_id))?;
                let connection_state = get_property_i32(&session.dispatch, "Connected")?;
                let extended_disconnect_reason = (connection_state == 0)
                    .then(|| get_property_i32(&session.dispatch, "ExtendedDisconnectReason").ok())
                    .flatten();
                let connected = is_rdp_connected_state(connection_state);
                let surface = rdp_surface_state(session);
                Ok(RdpSessionStatus {
                    session_id: request.session_id,
                    connection_state,
                    connected,
                    surface_visible: surface.visible,
                    surface_onscreen: surface.onscreen,
                    surface_ready: connected && surface.ready,
                    host_window_mode: RDP_HOST_WINDOW_MODE,
                    extended_disconnect_reason,
                })
            })
        }

        pub fn send_ctrl_alt_delete(
            &self,
            app: AppHandle,
            request: RdpSimpleRequest,
        ) -> Result<(), String> {
            let sessions = Arc::clone(&self.sessions);
            run_on_main_thread("send_rdp_ctrl_alt_delete", app, move |_app| {
                let sessions = lock_sessions(&sessions)?;
                let session = sessions
                    .get(&request.session_id)
                    .ok_or_else(|| format!("RDP session '{}' was not found", request.session_id))?;
                let connection_state =
                    get_property_i32(&session.dispatch, "Connected").unwrap_or(0);
                if !is_rdp_connected_state(connection_state) {
                    return Err(
                        "RDP session is not connected; cannot send Ctrl+Alt+Delete to remote desktop"
                            .to_string(),
                    );
                }
                if !session.visible {
                    return Err(
                        "RDP session is not visible; refusing to send Ctrl+Alt+Delete to a background tab"
                            .to_string(),
                    );
                }
                let focus = focus_rdp_control(session.owner, session.hwnd);
                if !focus.targets_rdp() {
                    return Err(format!(
                        "refusing to send Ctrl+Alt+Delete while NextDesk is not foreground: {}",
                        focus.as_json()
                    ));
                }
                send_ctrl_alt_end_via_windows_input(session.owner, session.hwnd)
                    .or_else(|_| send_ctrl_alt_end_to_rdp(&session.dispatch))
                    .or_else(|_| invoke_method(&session.dispatch, "SendCtrlAltDel"))
            })
        }

        pub fn send_text(
            &self,
            app: AppHandle,
            request: SendRdpTextRequest,
        ) -> Result<RdpTextSent, String> {
            let sessions = Arc::clone(&self.sessions);
            run_on_main_thread("send_rdp_text", app, move |_app| {
                if request.text.len() > RDP_TEXT_LIMIT {
                    return Err(format!(
                        "RDP text payload is {} bytes which exceeds the {RDP_TEXT_LIMIT}-byte limit",
                        request.text.len()
                    ));
                }
                let press_enter = request.press_enter.unwrap_or(false);
                let requested_mode = request
                    .mode
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or(RDP_TEXT_MODE_CLIPBOARD)
                    .to_string();
                let sessions = lock_sessions(&sessions)?;
                let session = sessions
                    .get(&request.session_id)
                    .ok_or_else(|| format!("RDP session '{}' was not found", request.session_id))?;
                let connection_state =
                    get_property_i32(&session.dispatch, "Connected").unwrap_or(0);
                if !is_rdp_connected_state(connection_state) {
                    return Err(
                        "RDP session is not connected; cannot send text to remote desktop"
                            .to_string(),
                    );
                }
                if !session.visible {
                    return Err(
                        "RDP session is not visible; refusing to send text to a background tab"
                            .to_string(),
                    );
                }
                let char_count = request.text.chars().count() as u32;
                if char_count == 0 && !press_enter {
                    return Ok(RdpTextSent {
                        session_id: request.session_id,
                        mode: requested_mode,
                        fell_back: false,
                        char_count: 0,
                    });
                }
                let focus = focus_rdp_control(session.owner, session.hwnd);
                if !focus.targets_rdp() {
                    return Err(format!(
                        "refusing to send text while NextDesk is not foreground: {}",
                        focus.as_json()
                    ));
                }
                match requested_mode.as_str() {
                    RDP_TEXT_MODE_SEND_KEYS => {
                        send_text_via_keys(&session.dispatch, &request.text, press_enter)?;
                        Ok(RdpTextSent {
                            session_id: request.session_id,
                            mode: RDP_TEXT_MODE_SEND_KEYS.to_string(),
                            fell_back: false,
                            char_count,
                        })
                    }
                    _ => match send_text_via_clipboard(
                        &session.dispatch,
                        session.hwnd,
                        &request.text,
                        press_enter,
                    ) {
                        Ok(()) => Ok(RdpTextSent {
                            session_id: request.session_id,
                            mode: RDP_TEXT_MODE_CLIPBOARD.to_string(),
                            fell_back: false,
                            char_count,
                        }),
                        Err(_) => {
                            send_text_via_keys(&session.dispatch, &request.text, press_enter)?;
                            Ok(RdpTextSent {
                                session_id: request.session_id,
                                mode: RDP_TEXT_MODE_SEND_KEYS.to_string(),
                                fell_back: true,
                                char_count,
                            })
                        }
                    },
                }
            })
        }

        pub fn send_key_press(
            &self,
            app: AppHandle,
            request: SendRdpKeyPressRequest,
        ) -> Result<(), String> {
            let sessions = Arc::clone(&self.sessions);
            run_on_main_thread("send_rdp_key_press", app, move |_app| {
                let sessions = lock_sessions(&sessions)?;
                let session = sessions
                    .get(&request.session_id)
                    .ok_or_else(|| format!("RDP session '{}' was not found", request.session_id))?;
                let connection_state =
                    get_property_i32(&session.dispatch, "Connected").unwrap_or(0);
                if !is_rdp_connected_state(connection_state) {
                    return Err(
                        "RDP session is not connected; cannot send key press to remote desktop"
                            .to_string(),
                    );
                }
                if !session.visible {
                    return Err(
                        "RDP session is not visible; refusing to inject a key into a background tab"
                            .to_string(),
                    );
                }
                let focus = focus_rdp_control(session.owner, session.hwnd);
                if request.down && !focus.targets_rdp() {
                    return Err(format!(
                        "refusing to send a key-down event while NextDesk is not foreground: {}",
                        focus.as_json()
                    ));
                }
                match send_scancode_event(&session.dispatch, request.scancode, request.down) {
                    Ok(()) => Ok(()),
                    Err(send_keys_error) => {
                        rdp_debug(
                            "input.send_keys.fallback",
                            &json!({
                                "sessionId": &request.session_id,
                                "scancode": request.scancode,
                                "down": request.down,
                                "sendKeysError": &send_keys_error,
                                "focus": focus.as_json(),
                            }),
                        );
                        send_scancode_to_focused_rdp_window(
                            session.owner,
                            session.hwnd,
                            request.scancode,
                            request.down,
                        )
                        .map_err(|fallback_error| {
                            format!(
                                "{send_keys_error}; targeted RDP window fallback also failed: {fallback_error}"
                            )
                        })?;
                        rdp_debug(
                            "input.send_keys.fallback.ok",
                            &json!({
                                "sessionId": &request.session_id,
                                "scancode": request.scancode,
                                "down": request.down,
                            }),
                        );
                        Ok(())
                    }
                }
            })
        }

        pub fn send_mouse_click(
            &self,
            app: AppHandle,
            request: SendRdpMouseClickRequest,
        ) -> Result<(), String> {
            let sessions = Arc::clone(&self.sessions);
            run_on_main_thread("send_rdp_mouse_click", app, move |_app| {
                let sessions = lock_sessions(&sessions)?;
                let session = sessions
                    .get(&request.session_id)
                    .ok_or_else(|| format!("RDP session '{}' was not found", request.session_id))?;
                let connection_state =
                    get_property_i32(&session.dispatch, "Connected").unwrap_or(0);
                if !is_rdp_connected_state(connection_state) {
                    return Err(
                        "RDP session is not connected; cannot send mouse click to remote desktop"
                            .to_string(),
                    );
                }
                if !session.visible {
                    return Err(
                        "RDP session is not visible; refusing to inject a mouse click into a background tab"
                            .to_string(),
                    );
                }
                let (down_message, up_message, button_mask) =
                    rdp_mouse_messages_for_button(&request.button)?;
                let focus = focus_rdp_control(session.owner, session.hwnd);
                if !focus.targets_rdp() {
                    return Err(format!(
                        "refusing to send a mouse click while NextDesk is not foreground: {}",
                        focus.as_json()
                    ));
                }
                send_rdp_mouse_click_messages(
                    session.hwnd,
                    request.x,
                    request.y,
                    down_message,
                    up_message,
                    button_mask,
                );
                Ok(())
            })
        }
    }

    impl StartRdpSessionRequest {
        pub fn from_kkterm_start(request: crate::kkterm_rdp::types::KktermRdpStartRequest) -> Self {
            let user = format_windows_user(&request.username, request.domain.as_deref());
            Self {
                session_id: request.tab_id,
                host: request.host,
                user,
                port: Some(request.port),
                secret_owner_id: None,
                password: Some(request.password),
                x: request.x.unwrap_or(0.0),
                y: request.y.unwrap_or(0.0),
                width: request
                    .width
                    .or_else(|| request.desktop_width.map(f64::from))
                    .unwrap_or(1280.0),
                height: request
                    .height
                    .or_else(|| request.desktop_height.map(f64::from))
                    .unwrap_or(800.0),
                scale_factor: request.scale_factor,
                options: Some(RdpSessionOptions {
                    remote_resolution: request
                        .remote_resolution
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(ToOwned::to_owned)
                        .unwrap_or_else(default_remote_resolution),
                    redirect_drives: request.redirect_drives,
                    use_multimon: request.use_multimon,
                    ..RdpSessionOptions::default()
                }),
            }
        }

        pub(crate) fn secret_owner_id(&self) -> Option<&str> {
            self.secret_owner_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
        }

        pub(crate) fn password(&self) -> Option<&str> {
            self.password.as_deref().filter(|value| !value.is_empty())
        }

        pub(crate) fn set_password(&mut self, password: Option<String>) {
            self.password = password;
        }
    }

    impl UpdateRdpBoundsRequest {
        pub fn from_kkterm_bounds(
            request: crate::kkterm_rdp::types::KktermRdpBoundsRequest,
            force: bool,
        ) -> Self {
            Self {
                session_id: request.tab_id,
                x: request.x,
                y: request.y,
                width: request.width,
                height: request.height,
                scale_factor: Some(request.scale_factor),
                force,
            }
        }
    }

    impl SetRdpVisibilityRequest {
        pub fn from_kkterm_bounds(
            request: crate::kkterm_rdp::types::KktermRdpBoundsRequest,
        ) -> Self {
            let crate::kkterm_rdp::types::KktermRdpBoundsRequest {
                tab_id,
                x,
                y,
                width,
                height,
                scale_factor,
                visible,
                clip_rect,
                mut clip_rects,
                ..
            } = request;
            if clip_rects.is_empty() {
                if let Some(rect) = clip_rect {
                    clip_rects.push(rect);
                }
            }
            Self {
                session_id: tab_id,
                visible,
                x,
                y,
                width,
                height,
                scale_factor: Some(scale_factor),
                clip_rects,
            }
        }
    }

    impl SyncRdpDisplaySizeRequest {
        pub fn from_kkterm_bounds(
            request: crate::kkterm_rdp::types::KktermRdpBoundsRequest,
        ) -> Self {
            Self {
                session_id: request.tab_id,
                x: request.x,
                y: request.y,
                width: request.width,
                height: request.height,
                scale_factor: Some(request.scale_factor),
            }
        }
    }

    impl RdpSimpleRequest {
        pub fn from_kkterm_simple(
            request: crate::kkterm_rdp::types::KktermRdpSimpleRequest,
        ) -> Self {
            Self {
                session_id: request.tab_id,
            }
        }

        pub fn from_tab_id(tab_id: String) -> Self {
            Self { session_id: tab_id }
        }
    }

    impl SendRdpTextRequest {
        pub fn from_kkterm_text(request: crate::kkterm_rdp::types::KktermRdpTextRequest) -> Self {
            Self {
                session_id: request.tab_id,
                text: request.text,
                mode: None,
                press_enter: None,
            }
        }
    }

    impl SendRdpKeyPressRequest {
        pub fn from_kkterm_key(request: crate::kkterm_rdp::types::KktermRdpKeyRequest) -> Self {
            Self {
                session_id: request.tab_id,
                scancode: request.scancode,
                down: request.down,
            }
        }
    }

    impl SendRdpMouseClickRequest {
        pub fn from_kkterm_pointer(
            request: crate::kkterm_rdp::types::KktermRdpPointerRequest,
        ) -> Option<Self> {
            let button = if request.button_mask & 0b001 != 0 {
                "left"
            } else if request.button_mask & 0b100 != 0 {
                "right"
            } else if request.button_mask & 0b010 != 0 {
                "middle"
            } else {
                return None;
            };
            Some(Self {
                session_id: request.tab_id,
                x: request.x,
                y: request.y,
                button: button.to_string(),
            })
        }
    }

    fn format_windows_user(username: &str, domain: Option<&str>) -> String {
        let username = username.trim();
        let domain = domain.map(str::trim).filter(|value| !value.is_empty());
        if username.is_empty() || username.contains('\\') || username.contains('@') {
            return username.to_string();
        }
        match domain {
            Some(domain) => format!("{domain}\\{username}"),
            None => username.to_string(),
        }
    }

    fn start_session_on_main_thread(
        sessions: Arc<Mutex<HashMap<String, RdpSession>>>,
        app: &AppHandle,
        request: StartRdpSessionRequest,
    ) -> Result<RdpSessionStarted, String> {
        let password_supplied = request.password().is_some();
        let secret_owner_id_present = request.secret_owner_id().is_some();
        let session_id = required_id(request.session_id)?;
        let host = required_field("RDP host", request.host)?;
        let user = request.user.trim().to_string();
        let port = request.port.unwrap_or(3389);
        if port == 0 {
            return Err("RDP port must be between 1 and 65535".to_string());
        }
        let connect_host = host.as_str();
        let connect_port = port;
        let requested_bounds = json!({
            "x": request.x,
            "y": request.y,
            "width": request.width,
            "height": request.height,
        });

        {
            let sessions = lock_sessions(&sessions)?;
            if sessions.contains_key(&session_id) {
                return Err(format!("RDP session '{session_id}' is already running"));
            }
        }

        rdp_debug(
            "session.start.request",
            &json!({
                "sessionId": &session_id,
                "host": &host,
                "user": &user,
                "port": port,
                "connectHost": connect_host,
                "connectPort": connect_port,
                "route": "direct",
                "keychainOwnerPresent": secret_owner_id_present,
                "passwordSupplied": password_supplied,
                "bounds": requested_bounds,
                "options": &request.options,
            }),
        );

        let atl = atl_functions()?;
        unsafe {
            OleInitialize(None)
                .map_err(|error| format!("failed to initialize OLE for RDP hosting: {error}"))?;
            if (atl.ax_win_init)() == 0 {
                return Err("failed to initialize ATL ActiveX hosting".to_string());
            }
        }

        let host_window = app
            .get_webview_window(HOST_WINDOW_LABEL)
            .ok_or_else(|| format!("host window '{HOST_WINDOW_LABEL}' is not available"))?;
        let parent_hwnd = host_window
            .hwnd()
            .map_err(|error| format!("failed to get host window handle: {error}"))?;

        let parent_hwnd = HWND(parent_hwnd.0);
        let host_scale_factor = host_window
            .scale_factor()
            .map_err(|error| format!("failed to read host window scale factor: {error}"))?;
        let scale_factor = rdp_request_scale_factor(request.scale_factor, host_scale_factor);
        let size = scaled_rect(
            request.x,
            request.y,
            request.width,
            request.height,
            scale_factor,
        );
        let initial_rect = staged_rect(size.2, size.3);
        rdp_debug(
            "session.start.geometry",
            &json!({
                "sessionId": &session_id,
                "scaleFactor": scale_factor,
                "hostScaleFactor": host_scale_factor,
                "scaledRect": {
                    "x": size.0,
                    "y": size.1,
                    "width": size.2,
                    "height": size.3,
                },
                "initialStagedRect": {
                    "x": initial_rect.0,
                    "y": initial_rect.1,
                    "width": initial_rect.2,
                    "height": initial_rect.3,
                },
            }),
        );
        let (hwnd, dispatch, control) = create_rdp_control(parent_hwnd, initial_rect)?;

        let options = request.options.unwrap_or_default();
        let resolution_mode = RemoteResolutionMode::parse(&options.remote_resolution);
        let display_settings = resolution_mode.display_settings(
            request.width,
            request.height,
            size.2,
            size.3,
            scale_factor,
        );
        rdp_debug(
            "session.start.display_settings",
            &json!({
                "sessionId": &session_id,
                "control": &control,
                "resolutionMode": resolution_mode_name(resolution_mode),
                "desktopWidth": display_settings.desktop_width,
                "desktopHeight": display_settings.desktop_height,
                "physicalWidth": display_settings.physical_width,
                "physicalHeight": display_settings.physical_height,
                "desktopScaleFactor": display_settings.desktop_scale_factor,
                "deviceScaleFactor": display_settings.device_scale_factor,
            }),
        );

        configure_rdp_control(
            &dispatch,
            connect_host,
            &user,
            connect_port,
            request.password.as_deref(),
            display_settings,
            resolution_mode,
            &options,
        )?;
        rdp_debug(
            "session.start.configured",
            &json!({
                "sessionId": &session_id,
                "control": &control,
                "host": &host,
                "user": &user,
                "port": port,
                "connectHost": connect_host,
                "connectPort": connect_port,
                "route": "direct",
                "passwordSupplied": password_supplied,
                "options": &options,
            }),
        );
        invoke_method(&dispatch, "Connect")?;
        rdp_debug(
            "session.start.connect_invoked",
            &json!({
                "sessionId": &session_id,
                "control": &control,
            }),
        );

        let mut sessions = lock_sessions(&sessions)?;
        sessions.insert(
            session_id.clone(),
            RdpSession {
                hwnd,
                owner: parent_hwnd,
                dispatch,
                // DesktopWidth/DesktopHeight seed the initial connection, but the
                // ActiveX control may not apply dynamic sizing until after Connect
                // has progressed. Keep the initial values as the best known
                // remote desktop aspect if the server later rejects display
                // control updates.
                desktop_width: display_settings.desktop_width,
                desktop_height: display_settings.desktop_height,
                desktop_scale_factor: display_settings.desktop_scale_factor,
                device_scale_factor: display_settings.device_scale_factor,
                dynamic_resize_failures: 0,
                resolution_mode,
                viewport_bounds: RdpViewportBounds {
                    x: request.x,
                    y: request.y,
                    width: request.width,
                    height: request.height,
                    scale_factor,
                },
                visible: false,
            },
        );

        rdp_debug(
            "session.start.ok",
            &json!({
                "sessionId": &session_id,
                "host": &host,
                "port": port,
                "control": &control,
            }),
        );

        Ok(RdpSessionStarted {
            session_id,
            host,
            port,
            control,
        })
    }

    fn create_rdp_control(
        owner_hwnd: HWND,
        rect: (i32, i32, i32, i32),
    ) -> Result<(HWND, IDispatch, String), String> {
        let mut last_error = String::new();
        let (extended_style, style) = rdp_host_window_styles();
        for progid in RDP_PROGIDS {
            rdp_debug(
                "control.create.try",
                &json!({
                    "progid": progid,
                    "rect": {
                        "x": rect.0,
                        "y": rect.1,
                        "width": rect.2,
                        "height": rect.3,
                    },
                }),
            );
            let class_name = wide_null("AtlAxWin");
            let control_name = wide_null(progid);
            let hwnd = unsafe {
                CreateWindowExW(
                    extended_style,
                    PCWSTR(class_name.as_ptr()),
                    PCWSTR(control_name.as_ptr()),
                    style,
                    rect.0,
                    rect.1,
                    rect.2,
                    rect.3,
                    Some(owner_hwnd),
                    Option::<HMENU>::None,
                    None,
                    None,
                )
            };

            let hwnd = match hwnd {
                Ok(hwnd) => hwnd,
                Err(error) => {
                    last_error = format!("{progid}: {error}");
                    rdp_debug(
                        "control.create.window_error",
                        &json!({
                            "progid": progid,
                            "error": error.to_string(),
                        }),
                    );
                    continue;
                }
            };

            match control_dispatch(hwnd).and_then(|dispatch| {
                get_dispid(&dispatch, "Server")?;
                Ok(dispatch)
            }) {
                Ok(dispatch) => {
                    rdp_debug("control.create.ok", &json!({ "progid": progid }));
                    return Ok((hwnd, dispatch, (*progid).to_string()));
                }
                Err(error) => {
                    last_error = format!("{progid}: {error}");
                    rdp_debug(
                        "control.create.dispatch_error",
                        &json!({
                            "progid": progid,
                            "error": &error,
                        }),
                    );
                    unsafe {
                        let _ = DestroyWindow(hwnd);
                    }
                }
            }
        }

        Err(format!(
            "failed to create Microsoft RDP ActiveX control from mstscax.dll ({last_error})"
        ))
    }

    fn rdp_host_window_styles() -> (WINDOW_EX_STYLE, WINDOW_STYLE) {
        (
            WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            WS_POPUP | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
        )
    }

    fn control_dispatch(hwnd: HWND) -> Result<IDispatch, String> {
        let mut unknown = std::ptr::null_mut();
        let atl = atl_functions()?;
        unsafe {
            (atl.ax_get_control)(hwnd, &mut unknown)
                .ok()
                .map_err(|error| format!("failed to get RDP ActiveX control: {error}"))?;
            let unknown = windows::core::IUnknown::from_raw(unknown);
            unknown
                .cast::<IDispatch>()
                .map_err(|error| format!("RDP ActiveX control does not expose IDispatch: {error}"))
        }
    }

    fn configure_rdp_control(
        dispatch: &IDispatch,
        host: &str,
        user: &str,
        port: u16,
        password: Option<&str>,
        display_settings: RdpDisplaySettings,
        resolution_mode: RemoteResolutionMode,
        options: &RdpSessionOptions,
    ) -> Result<(), String> {
        let (domain, username) = split_windows_user(user);
        set_property_string(dispatch, "Server", host)?;
        if !username.is_empty() {
            set_property_string(dispatch, "UserName", &username)?;
        }
        if let Some(domain) = domain.as_deref() {
            set_property_string(dispatch, "Domain", domain)?;
        }
        set_property_i32(dispatch, "ColorDepth", i32::from(options.color_depth))?;
        set_property_i32(dispatch, "DesktopWidth", display_settings.desktop_width)?;
        set_property_i32(dispatch, "DesktopHeight", display_settings.desktop_height)?;
        set_optional_property_bool(dispatch, "PromptForCredentials", password.is_none())?;
        set_optional_property_string(dispatch, "ConnectingText", "Connecting to remote desktop")?;
        set_optional_property_string(dispatch, "DisconnectedText", "Remote desktop disconnected")?;
        if let Some(password) = password.filter(|value| !value.is_empty()) {
            set_clear_text_password(dispatch, password);
        }

        if let Some(advanced) = get_advanced_settings(dispatch) {
            let _ = set_property_bool(&advanced, "AllowPromptingForCredentials", true);
            let _ = set_property_i32(&advanced, "RDPPort", i32::from(port));
            let _ = set_property_bool(&advanced, "EnableCredSspSupport", true);
            // The embedded MsRdpClient ActiveX has no UI to show the server-auth
            // certificate-trust warning that mstsc.exe displays on first contact.
            // With the default AuthenticationLevel of 2 ("Warn"), the control stalls
            // silently at a blank pre-login screen until mstsc has been used once to
            // persist the cert hash under HKCU\...\Terminal Server Client\Servers.
            // 0 = connect even if server authentication fails, matching the posture
            // used by embedded RDP hosts (RDWeb, FreeRDP).
            let _ = set_property_i32(&advanced, "AuthenticationLevel", 0);
            let _ = set_property_bool(&advanced, "NegotiateSecurityLayer", true);
            // Match mstsc's Local Resources defaults closely enough for embedded sessions:
            // Windows shortcut replacements (including Ctrl+Alt+End for SAS) must be routed to
            // the remote host, while higher-risk device redirects stay disabled until KKTerm
            // exposes durable Connection settings for them.
            set_property_bool(&advanced, "RedirectClipboard", options.redirect_clipboard)?;
            set_property_bool(&advanced, "RedirectDrives", options.redirect_drives)?;
            // Newer mstscax builds expose dynamic device redirection separately.
            // Enabling it alongside RedirectDrives keeps shell clipboard FileContents
            // available when Explorer uses delayed rendering for copied files.
            let dynamic_redirection =
                configure_dynamic_redirection(dispatch, options.redirect_drives);
            rdp_debug(
                "clipboard.redirection.configured",
                &json!({
                    "redirectClipboardRequested": options.redirect_clipboard,
                    "redirectClipboardReadback": get_property_i32(&advanced, "RedirectClipboard").ok(),
                    "redirectDrivesRequested": options.redirect_drives,
                    "redirectDrivesReadback": get_property_i32(&advanced, "RedirectDrives").ok(),
                    "redirectDynamicDrivesReadback": dynamic_redirection.as_ref().ok().map(|value| value.0),
                    "redirectDynamicDevicesConfigured": dynamic_redirection.as_ref().ok().map(|value| value.1),
                    "dynamicRedirectionError": dynamic_redirection.as_ref().err(),
                }),
            );
            let _ = set_property_bool(&advanced, "RedirectPorts", false);
            let _ = set_property_bool(&advanced, "RedirectPrinters", false);
            let _ = set_property_bool(&advanced, "RedirectSmartCards", false);
            let _ = set_property_i32(&advanced, "SasSequence", RDP_STANDARD_SAS_SEQUENCE);
            let _ = set_property_i32(&advanced, "HotKeyCtrlAltDel", VK_END_KEY as i32);
            let _ = set_property_bool(&advanced, "SmartSizing", resolution_mode.smart_sizing());
            let _ = set_property_bool(&advanced, "BitmapPersistence", options.bitmap_cache);
            let _ = set_property_bool(&advanced, "CachePersistenceActive", options.bitmap_cache);
            let _ = set_property_i32(
                &advanced,
                "PerformanceFlags",
                performance_flags_for(&options.performance_profile),
            );
        }
        let multimon_result = configure_multimon(dispatch, options.use_multimon);
        rdp_debug(
            "display.multimon.configured",
            &json!({
                "requested": options.use_multimon,
                "configured": multimon_result.is_ok(),
                "readback": multimon_result.as_ref().ok(),
                "error": multimon_result.as_ref().err(),
            }),
        );
        if display_settings.desktop_scale_factor != RDP_DISPLAY_SCALE_FACTOR_PERCENT {
            if let Some(extended) = get_extended_settings(dispatch) {
                let _ = set_extended_setting_u32(
                    &extended,
                    "DesktopScaleFactor",
                    display_settings.desktop_scale_factor as u32,
                );
                let _ = set_extended_setting_u32(
                    &extended,
                    "DeviceScaleFactor",
                    display_settings.device_scale_factor as u32,
                );
            }
        }
        if let Some(secured) = get_secured_settings(dispatch) {
            let _ = set_property_i32(&secured, "KeyboardHookMode", 1);
        }

        Ok(())
    }

    fn configure_dynamic_redirection(
        dispatch: &IDispatch,
        enabled: bool,
    ) -> Result<(bool, bool), String> {
        let settings = dispatch
            .cast::<IMsRdpClientNonScriptable3>()
            .map_err(|error| format!("IMsRdpClientNonScriptable3 unavailable: {error}"))?;
        let value = if enabled { VARIANT_TRUE } else { VARIANT_FALSE };
        unsafe {
            (settings.vtable().put_redirect_dynamic_drives)(settings.as_raw(), value)
                .ok()
                .map_err(|error| format!("RedirectDynamicDrives failed: {error}"))?;
            (settings.vtable().put_redirect_dynamic_devices)(settings.as_raw(), value)
                .ok()
                .map_err(|error| format!("RedirectDynamicDevices failed: {error}"))?;
            let mut readback = VARIANT_FALSE;
            (settings.vtable().get_redirect_dynamic_drives)(settings.as_raw(), &mut readback)
                .ok()
                .map_err(|error| format!("RedirectDynamicDrives readback failed: {error}"))?;
            Ok((readback != VARIANT_FALSE, true))
        }
    }

    fn configure_multimon(dispatch: &IDispatch, enabled: bool) -> Result<bool, String> {
        let settings = dispatch
            .cast::<IMsRdpClientNonScriptable5>()
            .map_err(|error| format!("IMsRdpClientNonScriptable5 unavailable: {error}"))?;
        let value = if enabled { VARIANT_TRUE } else { VARIANT_FALSE };
        unsafe {
            (settings.vtable().put_use_multimon)(settings.as_raw(), value)
                .ok()
                .map_err(|error| format!("UseMultimon failed: {error}"))?;
            let mut readback = VARIANT_FALSE;
            (settings.vtable().get_use_multimon)(settings.as_raw(), &mut readback)
                .ok()
                .map_err(|error| format!("UseMultimon readback failed: {error}"))?;
            Ok(readback != VARIANT_FALSE)
        }
    }

    impl Default for RdpSessionOptions {
        fn default() -> Self {
            Self {
                color_depth: default_color_depth(),
                redirect_clipboard: true,
                redirect_drives: false,
                use_multimon: false,
                bitmap_cache: true,
                performance_profile: default_performance_profile(),
                remote_resolution: default_remote_resolution(),
            }
        }
    }

    fn default_remote_resolution() -> String {
        "automatic".to_string()
    }

    fn default_color_depth() -> u16 {
        32
    }

    fn default_true() -> bool {
        true
    }

    fn default_performance_profile() -> String {
        "balanced".to_string()
    }

    fn performance_flags_for(profile: &str) -> i32 {
        match profile {
            "quality" => 0,
            "speed" => 0x0000_0001 | 0x0000_0002 | 0x0000_0004 | 0x0000_0008 | 0x0000_0020,
            _ => 0x0000_0001 | 0x0000_0004 | 0x0000_0008,
        }
    }

    fn resolution_mode_name(mode: RemoteResolutionMode) -> &'static str {
        match mode {
            RemoteResolutionMode::Automatic => "automatic",
            RemoteResolutionMode::SmartSizing => "smartSizing",
            RemoteResolutionMode::DpiZoom => "dpiZoom",
            RemoteResolutionMode::Fixed { .. } => "fixed",
        }
    }

    fn split_windows_user(user: &str) -> (Option<String>, String) {
        let trimmed = user.trim();
        if let Some((domain, username)) = trimmed.split_once('\\') {
            let domain = domain.trim();
            let username = username.trim();
            if !domain.is_empty() && !username.is_empty() {
                return (Some(domain.to_string()), username.to_string());
            }
        }
        (None, trimmed.to_string())
    }

    fn get_dispid(dispatch: &IDispatch, name: &str) -> Result<i32, String> {
        let wide = wide_null(name);
        let mut name_ptr = PCWSTR(wide.as_ptr());
        let mut dispid = 0;
        unsafe {
            dispatch
                .GetIDsOfNames(
                    &windows::core::GUID::zeroed(),
                    &mut name_ptr,
                    1,
                    LOCALE_USER_DEFAULT,
                    &mut dispid,
                )
                .map_err(|error| format!("RDP ActiveX member '{name}' was not found: {error}"))?;
        }
        Ok(dispid)
    }

    fn set_property_string(dispatch: &IDispatch, name: &str, value: &str) -> Result<(), String> {
        invoke_property_put(dispatch, name, VariantArg::bstr(value))
    }

    fn set_optional_property_string(
        dispatch: &IDispatch,
        name: &str,
        value: &str,
    ) -> Result<(), String> {
        match set_property_string(dispatch, name, value) {
            Ok(()) => Ok(()),
            Err(_) => Ok(()),
        }
    }

    fn set_property_i32(dispatch: &IDispatch, name: &str, value: i32) -> Result<(), String> {
        invoke_property_put(dispatch, name, VariantArg::i4(value))
    }

    fn set_property_bool(dispatch: &IDispatch, name: &str, value: bool) -> Result<(), String> {
        invoke_property_put(dispatch, name, VariantArg::bool(value))
    }

    fn set_optional_property_bool(
        dispatch: &IDispatch,
        name: &str,
        value: bool,
    ) -> Result<(), String> {
        match set_property_bool(dispatch, name, value) {
            Ok(()) => Ok(()),
            Err(_) => Ok(()),
        }
    }

    fn set_clear_text_password(dispatch: &IDispatch, password: &str) {
        if set_property_string(dispatch, "ClearTextPassword", password).is_ok() {
            return;
        }
        if let Some(advanced) = get_advanced_settings(dispatch) {
            let _ = set_property_string(&advanced, "ClearTextPassword", password);
        }
    }

    fn get_advanced_settings(dispatch: &IDispatch) -> Option<IDispatch> {
        ADVANCED_SETTINGS_PROPERTIES
            .iter()
            .find_map(|name| get_dispatch_property(dispatch, name).ok())
    }

    fn get_extended_settings(dispatch: &IDispatch) -> Option<IDispatch> {
        EXTENDED_SETTINGS_PROPERTIES
            .iter()
            .find_map(|name| get_dispatch_property(dispatch, name).ok())
    }

    fn get_secured_settings(dispatch: &IDispatch) -> Option<IDispatch> {
        SECURED_SETTINGS_PROPERTIES
            .iter()
            .find_map(|name| get_dispatch_property(dispatch, name).ok())
    }

    fn set_extended_setting_u32(
        dispatch: &IDispatch,
        name: &str,
        value: u32,
    ) -> Result<(), String> {
        let dispid = get_dispid(dispatch, "Property")?;
        let mut args = [variant_u4(value), variant_bstr(name)];
        let mut named_arg = DISPID_PROPERTYPUT;
        let mut params = DISPPARAMS {
            rgvarg: args.as_mut_ptr(),
            rgdispidNamedArgs: &mut named_arg,
            cArgs: args.len() as u32,
            cNamedArgs: 1,
        };
        unsafe {
            let result = dispatch.Invoke(
                dispid,
                &windows::core::GUID::zeroed(),
                LOCALE_USER_DEFAULT,
                DISPATCH_PROPERTYPUT,
                &mut params,
                None,
                None,
                None,
            );
            for arg in args.iter_mut() {
                let _ = VariantClear(arg);
            }
            result.map_err(|error| {
                format!("failed to set RDP ActiveX extended property '{name}': {error}")
            })
        }
    }

    fn invoke_property_put(
        dispatch: &IDispatch,
        name: &str,
        mut arg: VariantArg,
    ) -> Result<(), String> {
        let dispid = get_dispid(dispatch, name)?;
        let mut named_arg = DISPID_PROPERTYPUT;
        let mut params = DISPPARAMS {
            rgvarg: &mut arg.0,
            rgdispidNamedArgs: &mut named_arg,
            cArgs: 1,
            cNamedArgs: 1,
        };
        unsafe {
            dispatch
                .Invoke(
                    dispid,
                    &windows::core::GUID::zeroed(),
                    LOCALE_USER_DEFAULT,
                    DISPATCH_PROPERTYPUT,
                    &mut params,
                    None,
                    None,
                    None,
                )
                .map_err(|error| format!("failed to set RDP ActiveX property '{name}': {error}"))
        }
    }

    fn get_dispatch_property(dispatch: &IDispatch, name: &str) -> Result<IDispatch, String> {
        let dispid = get_dispid(dispatch, name)?;
        let mut result = VARIANT::default();
        let params = DISPPARAMS::default();
        unsafe {
            dispatch
                .Invoke(
                    dispid,
                    &windows::core::GUID::zeroed(),
                    LOCALE_USER_DEFAULT,
                    DISPATCH_PROPERTYGET,
                    &params,
                    Some(&mut result),
                    None,
                    None,
                )
                .map_err(|error| {
                    format!("failed to read RDP ActiveX property '{name}': {error}")
                })?;
            let variant_data = &*result.Anonymous.Anonymous;
            if variant_data.vt != VT_DISPATCH {
                return Err(format!(
                    "RDP ActiveX property '{name}' did not return IDispatch"
                ));
            }
            let dispatch = (*variant_data.Anonymous.pdispVal)
                .clone()
                .ok_or_else(|| format!("RDP ActiveX property '{name}' did not return IDispatch"))?;
            Ok(dispatch)
        }
    }

    fn get_property_i32(dispatch: &IDispatch, name: &str) -> Result<i32, String> {
        let dispid = get_dispid(dispatch, name)?;
        let mut result = VARIANT::default();
        let params = DISPPARAMS::default();
        unsafe {
            dispatch
                .Invoke(
                    dispid,
                    &windows::core::GUID::zeroed(),
                    LOCALE_USER_DEFAULT,
                    DISPATCH_PROPERTYGET,
                    &params,
                    Some(&mut result),
                    None,
                    None,
                )
                .map_err(|error| {
                    format!("failed to read RDP ActiveX property '{name}': {error}")
                })?;
            let variant_data = &*result.Anonymous.Anonymous;
            let value = match variant_data.vt {
                VT_I2 => i32::from(variant_data.Anonymous.iVal),
                VT_I4 => variant_data.Anonymous.lVal,
                VT_BOOL => {
                    if variant_data.Anonymous.boolVal.as_bool() {
                        1
                    } else {
                        0
                    }
                }
                _ => {
                    let _ = VariantClear(&mut result);
                    return Err(format!(
                        "RDP ActiveX property '{name}' did not return an integer state"
                    ));
                }
            };
            let _ = VariantClear(&mut result);
            Ok(value)
        }
    }

    fn invoke_method(dispatch: &IDispatch, name: &str) -> Result<(), String> {
        invoke_method_with_i32_args(dispatch, name, &[])
    }

    fn send_text_via_clipboard(
        dispatch: &IDispatch,
        hwnd: HWND,
        text: &str,
        press_enter: bool,
    ) -> Result<(), String> {
        if !text.is_empty() {
            write_unicode_clipboard(hwnd, text)?;
            send_key_chord(
                dispatch,
                &[
                    KeyEvent::down(VK_CONTROL_KEY),
                    KeyEvent::press(VK_V_KEY),
                    KeyEvent::up(VK_CONTROL_KEY),
                ],
            )?;
        }
        if press_enter {
            send_key_chord(dispatch, &[KeyEvent::press(VK_RETURN_KEY)])?;
        }
        Ok(())
    }

    fn write_unicode_clipboard(hwnd: HWND, text: &str) -> Result<(), String> {
        let mut wide: Vec<u16> = text.encode_utf16().collect();
        wide.push(0);
        let bytes = wide.len() * std::mem::size_of::<u16>();
        unsafe {
            OpenClipboard(Some(hwnd))
                .map_err(|error| format!("failed to open clipboard for RDP paste: {error}"))?;
            let result = (|| -> Result<(), String> {
                EmptyClipboard()
                    .map_err(|error| format!("failed to empty clipboard for RDP paste: {error}"))?;
                let hmem: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE, bytes).map_err(|error| {
                    format!("failed to allocate clipboard memory for RDP paste: {error}")
                })?;
                let dst = GlobalLock(hmem) as *mut u16;
                if dst.is_null() {
                    return Err("failed to lock clipboard memory for RDP paste".to_string());
                }
                std::ptr::copy_nonoverlapping(wide.as_ptr(), dst, wide.len());
                let _ = GlobalUnlock(hmem);
                let handle = HANDLE(hmem.0);
                if SetClipboardData(CF_UNICODETEXT.0 as u32, Some(handle)).is_err() {
                    return Err("failed to set clipboard data for RDP paste".to_string());
                }
                Ok(())
            })();

            let _ = CloseClipboard();
            result
        }
    }

    fn send_text_via_keys(
        dispatch: &IDispatch,
        text: &str,
        press_enter: bool,
    ) -> Result<(), String> {
        let mut events = Vec::new();
        for ch in text.chars() {
            match ch {
                '\r' => {}
                '\n' => push_key_press(&mut events, VK_RETURN_KEY),
                '\t' => push_key_press(&mut events, VK_TAB_KEY),
                _ => append_unicode_char_key_events(&mut events, ch)?,
            }
        }
        if press_enter {
            push_key_press(&mut events, VK_RETURN_KEY);
        }
        send_key_events(dispatch, &events)
    }

    fn append_unicode_char_key_events(events: &mut Vec<KeyEvent>, ch: char) -> Result<(), String> {
        let code = ch as u32;
        if code > u16::MAX as u32 {
            return Err(format!(
                "character U+{code:04X} cannot be typed via SendKeys: only BMP characters are supported"
            ));
        }
        let scan = unsafe { VkKeyScanW(code as u16) };
        if scan == -1 {
            return Err(format!(
                "character '{ch}' cannot be typed via SendKeys on the active keyboard layout; switch to clipboard mode"
            ));
        }
        let vk = (scan & 0xff) as usize;
        let modifiers = (scan >> 8) & 0xff;
        let need_shift = modifiers & 0x01 != 0;
        let need_ctrl = modifiers & 0x02 != 0;
        let need_alt = modifiers & 0x04 != 0;
        if need_shift {
            events.push(KeyEvent::down(VK_SHIFT_KEY));
        }
        if need_ctrl {
            events.push(KeyEvent::down(VK_CONTROL_KEY));
        }
        if need_alt {
            events.push(KeyEvent::down(VK_ALT_KEY));
        }
        push_key_press(events, vk);
        if need_alt {
            events.push(KeyEvent::up(VK_ALT_KEY));
        }
        if need_ctrl {
            events.push(KeyEvent::up(VK_CONTROL_KEY));
        }
        if need_shift {
            events.push(KeyEvent::up(VK_SHIFT_KEY));
        }
        Ok(())
    }

    fn push_key_press(events: &mut Vec<KeyEvent>, vk: usize) {
        events.push(KeyEvent::down(vk));
        events.push(KeyEvent::up(vk));
    }

    #[derive(Clone, Copy)]
    struct RdpInputFocusState {
        owner: HWND,
        hwnd: HWND,
        foreground: HWND,
        active: HWND,
        focus: HWND,
        activation_allowed: bool,
    }

    impl RdpInputFocusState {
        fn has_rdp_focus(&self) -> bool {
            let active_matches = self.active == self.hwnd || self.active == self.owner;
            let focus_matches =
                self.focus == self.hwnd || unsafe { IsChild(self.hwnd, self.focus).as_bool() };
            active_matches && focus_matches
        }

        fn targets_rdp(&self) -> bool {
            let foreground_matches = self.foreground == self.hwnd || self.foreground == self.owner;
            foreground_matches && self.has_rdp_focus()
        }

        fn as_json(&self) -> serde_json::Value {
            json!({
                "owner": hwnd_value(self.owner),
                "hwnd": hwnd_value(self.hwnd),
                "foreground": hwnd_value(self.foreground),
                "active": hwnd_value(self.active),
                "focus": hwnd_value(self.focus),
                "activationAllowed": self.activation_allowed,
                "hasRdpFocus": self.has_rdp_focus(),
                "targetsRdp": self.targets_rdp(),
            })
        }
    }

    fn hwnd_value(hwnd: HWND) -> usize {
        hwnd.0 as usize
    }

    fn focus_rdp_control(owner: HWND, hwnd: HWND) -> RdpInputFocusState {
        focus_rdp_window(owner, hwnd, hwnd)
    }

    fn focus_rdp_window(owner: HWND, hwnd: HWND, focus: HWND) -> RdpInputFocusState {
        // Never promote NextDesk from a background application while flushing a
        // delayed or blur-triggered input event. The non-activating owned popup
        // only needs thread-local active/focus state once the owner is already
        // foreground.
        let state = unsafe {
            let foreground = GetForegroundWindow();
            let activation_allowed = should_focus_rdp_control(foreground == owner);
            if activation_allowed {
                let _ = SetActiveWindow(owner);
                let _ = SetFocus(Some(focus));
            }
            RdpInputFocusState {
                owner,
                hwnd,
                foreground,
                active: GetActiveWindow(),
                focus: GetFocus(),
                activation_allowed,
            }
        };
        rdp_debug("input.focus", &state.as_json());
        state
    }

    fn send_ctrl_alt_end_via_windows_input(owner: HWND, hwnd: HWND) -> Result<(), String> {
        let focus = focus_rdp_control(owner, hwnd);
        if !focus.targets_rdp() {
            return Err(format!(
                "refusing to send Ctrl+Alt+End because the RDP control is not focused: {}",
                focus.as_json()
            ));
        }
        let mut inputs = [
            keyboard_input(VK_CONTROL_KEY, false),
            keyboard_input(VK_ALT_KEY, false),
            keyboard_input(VK_END_KEY, false),
            keyboard_input(VK_END_KEY, true),
            keyboard_input(VK_ALT_KEY, true),
            keyboard_input(VK_CONTROL_KEY, true),
        ];
        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent == inputs.len() as u32 {
            Ok(())
        } else {
            let last_error = unsafe { GetLastError().0 };
            // Release the modifiers if Windows accepted only a partial sequence.
            inputs = [
                keyboard_input(VK_END_KEY, true),
                keyboard_input(VK_ALT_KEY, true),
                keyboard_input(VK_CONTROL_KEY, true),
                keyboard_input(VK_END_KEY, true),
                keyboard_input(VK_ALT_KEY, true),
                keyboard_input(VK_CONTROL_KEY, true),
            ];
            let _ = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
            Err(format!(
                "failed to send Ctrl+Alt+End to RDP control: Windows accepted {sent} of {} inputs (GetLastError={last_error})",
                inputs.len(),
            ))
        }
    }

    fn keyboard_input(vk: usize, up: bool) -> INPUT {
        let mut flags = KEYBD_EVENT_FLAGS(0);
        if is_extended_key(vk) {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        if up {
            flags |= KEYEVENTF_KEYUP;
        }
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk as u16),
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    #[derive(Clone, Copy)]
    struct KeyEvent {
        vk: usize,
        up: bool,
    }

    impl KeyEvent {
        fn down(vk: usize) -> Self {
            Self { vk, up: false }
        }

        fn up(vk: usize) -> Self {
            Self { vk, up: true }
        }

        fn press(vk: usize) -> Self {
            Self::down(vk)
        }
    }

    fn send_ctrl_alt_end_to_rdp(dispatch: &IDispatch) -> Result<(), String> {
        send_key_chord(
            dispatch,
            &[
                KeyEvent::down(VK_CONTROL_KEY),
                KeyEvent::down(VK_ALT_KEY),
                KeyEvent::press(VK_END_KEY),
                KeyEvent::up(VK_ALT_KEY),
                KeyEvent::up(VK_CONTROL_KEY),
            ],
        )
    }

    fn normalize_remote_key_name(value: &str) -> String {
        value
            .chars()
            .filter(|ch| ch.is_ascii_alphanumeric())
            .flat_map(|ch| ch.to_lowercase())
            .collect()
    }

    fn rdp_mouse_messages_for_button(value: &str) -> Result<(u32, u32, usize), String> {
        match normalize_remote_key_name(value).as_str() {
            "left" => Ok((WM_LBUTTONDOWN_MSG, WM_LBUTTONUP_MSG, MK_LBUTTON_WPARAM)),
            "right" => Ok((WM_RBUTTONDOWN_MSG, WM_RBUTTONUP_MSG, MK_RBUTTON_WPARAM)),
            "middle" => Ok((WM_MBUTTONDOWN_MSG, WM_MBUTTONUP_MSG, MK_MBUTTON_WPARAM)),
            _ => Err(format!("unsupported RDP mouse button: {value}")),
        }
    }

    fn send_rdp_mouse_click_messages(
        hwnd: HWND,
        x: u16,
        y: u16,
        down_message: u32,
        up_message: u32,
        button_mask: usize,
    ) {
        let lparam = LPARAM((((y as u32) << 16) | x as u32) as isize);
        unsafe {
            let _ = SendMessageW(hwnd, down_message, Some(WPARAM(button_mask)), Some(lparam));
            let _ = SendMessageW(hwnd, up_message, Some(WPARAM(0)), Some(lparam));
        }
    }

    fn send_key_chord(dispatch: &IDispatch, key_events: &[KeyEvent]) -> Result<(), String> {
        let expanded = expand_key_chord_events(key_events);
        send_key_events(dispatch, &expanded)
    }

    fn expand_key_chord_events(key_events: &[KeyEvent]) -> Vec<KeyEvent> {
        let mut expanded = Vec::with_capacity(key_events.len() * 2);
        for event in key_events {
            if event.up {
                expanded.push(*event);
            } else if matches!(event.vk, VK_CONTROL_KEY | VK_ALT_KEY | VK_SHIFT_KEY) {
                expanded.push(*event);
            } else {
                expanded.push(KeyEvent::down(event.vk));
                expanded.push(KeyEvent::up(event.vk));
            }
        }
        expanded
    }

    fn send_scancode_to_focused_rdp_window(
        owner: HWND,
        hwnd: HWND,
        scancode: u16,
        down: bool,
    ) -> Result<(), String> {
        let focus = focus_rdp_control(owner, hwnd);
        if !focus.has_rdp_focus() {
            return Err(format!(
                "refusing to post keyboard input because the RDP control is not focused: {}",
                focus.as_json()
            ));
        }

        let (scan_code, extended) = split_set1_scancode(scancode)?;
        let map_code = if extended {
            0xe000 | scan_code as u32
        } else {
            scan_code as u32
        };
        let virtual_key = unsafe { MapVirtualKeyW(map_code, MAPVK_VSC_TO_VK_EX) };
        if virtual_key == 0 {
            return Err(format!(
                "Windows could not map Set-1 scancode 0x{scancode:04x} to a virtual key"
            ));
        }
        let target = focus.focus;
        let message = if down { WM_KEYDOWN_MSG } else { WM_KEYUP_MSG };
        let key_data = rdp_scancode_lparam(scancode, !down)?;
        unsafe {
            PostMessageW(
                Some(target),
                message,
                WPARAM(virtual_key as usize),
                LPARAM(key_data as isize),
            )
            .map_err(|error| {
                format!(
                    "failed to post scancode 0x{scancode:04x} to the focused RDP input window: {error}"
                )
            })?;
        }
        rdp_debug(
            "input.window_message.posted",
            &json!({
                "hwnd": hwnd_value(hwnd),
                "target": hwnd_value(target),
                "scancode": scancode,
                "down": down,
                "virtualKey": virtual_key,
            }),
        );
        Ok(())
    }

    fn send_scancode_event(dispatch: &IDispatch, scancode: u16, down: bool) -> Result<(), String> {
        let mut key_up = [if down { VARIANT_FALSE } else { VARIANT_TRUE }];
        let mut key_data = [rdp_scancode_lparam(scancode, !down)?];
        let nonscriptable = dispatch
            .cast::<IMsRdpClientNonScriptable>()
            .map_err(|error| format!("RDP ActiveX control does not expose SendKeys: {error}"))?;
        unsafe {
            (nonscriptable.vtable().send_keys)(
                Interface::as_raw(&nonscriptable),
                1,
                key_up.as_mut_ptr(),
                key_data.as_mut_ptr(),
            )
            .ok()
            .map_err(|error| format!("failed to send scancode to RDP ActiveX control: {error}"))?;
        }
        Ok(())
    }

    fn split_set1_scancode(scancode: u16) -> Result<(u16, bool), String> {
        let prefix = scancode & 0xff00;
        let scan_code = scancode & 0x00ff;
        if scan_code == 0 || (prefix != 0 && prefix != 0xe000) {
            return Err(format!("unsupported Set-1 RDP scancode: 0x{scancode:04x}"));
        }
        Ok((scan_code, prefix == 0xe000))
    }

    fn rdp_scancode_lparam(scancode: u16, up: bool) -> Result<i32, String> {
        let (scan_code, extended) = split_set1_scancode(scancode)?;
        let mut value = 1 | ((scan_code as i32) << 16);
        if extended {
            value |= 1 << 24;
        }
        if up {
            value |= 1 << 30;
            value |= 1u32.wrapping_shl(31) as i32;
        }
        Ok(value)
    }

    fn send_key_events(dispatch: &IDispatch, key_events: &[KeyEvent]) -> Result<(), String> {
        if key_events.is_empty() {
            return Ok(());
        }
        let nonscriptable = dispatch
            .cast::<IMsRdpClientNonScriptable>()
            .map_err(|error| format!("RDP ActiveX control does not expose SendKeys: {error}"))?;
        for chunk in key_events.chunks(RDP_SEND_KEYS_LIMIT) {
            let mut key_up: Vec<VARIANT_BOOL> = chunk
                .iter()
                .map(|event| {
                    if event.up {
                        VARIANT_TRUE
                    } else {
                        VARIANT_FALSE
                    }
                })
                .collect();
            let mut key_data: Vec<i32> = chunk
                .iter()
                .map(|event| rdp_key_lparam(event.vk, event.up))
                .collect();
            unsafe {
                (nonscriptable.vtable().send_keys)(
                    Interface::as_raw(&nonscriptable),
                    chunk.len() as i32,
                    key_up.as_mut_ptr(),
                    key_data.as_mut_ptr(),
                )
                .ok()
                .map_err(|error| {
                    format!("failed to send keystrokes to RDP ActiveX control: {error}")
                })?;
            }
        }
        Ok(())
    }

    fn rdp_key_lparam(vk: usize, up: bool) -> i32 {
        let map_type = if is_extended_key(vk) {
            MAPVK_VK_TO_VSC_EX
        } else {
            MAPVK_VK_TO_VSC
        };
        let scan_code = unsafe { MapVirtualKeyW(vk as u32, map_type) };
        let scan_code = if scan_code == 0 { 0 } else { scan_code & 0xff };
        let mut value = 1 | ((scan_code as i32) << 16);
        if is_extended_key(vk) {
            value |= 1 << 24;
        }
        if up {
            value |= 1 << 30;
            value |= 1u32.wrapping_shl(31) as i32;
        }
        value
    }

    fn is_extended_key(vk: usize) -> bool {
        matches!(
            vk,
            VK_END_KEY
                | VK_DELETE_KEY
                | VK_HOME_KEY
                | VK_LEFT_KEY
                | VK_UP_KEY
                | VK_RIGHT_KEY
                | VK_DOWN_KEY
                | VK_PAGE_UP_KEY
                | VK_PAGE_DOWN_KEY
        )
    }

    fn invoke_method_with_i32_args(
        dispatch: &IDispatch,
        name: &str,
        args: &[i32],
    ) -> Result<(), String> {
        let dispid = get_dispid(dispatch, name)?;
        let mut variants: Vec<VARIANT> =
            args.iter().rev().map(|value| variant_i4(*value)).collect();
        let mut params = DISPPARAMS {
            rgvarg: if variants.is_empty() {
                std::ptr::null_mut()
            } else {
                variants.as_mut_ptr()
            },
            rgdispidNamedArgs: std::ptr::null_mut(),
            cArgs: variants.len() as u32,
            cNamedArgs: 0,
        };
        let mut result = VARIANT::default();
        unsafe {
            let invoke_result = dispatch
                .Invoke(
                    dispid,
                    &windows::core::GUID::zeroed(),
                    LOCALE_USER_DEFAULT,
                    DISPATCH_METHOD,
                    &mut params,
                    Some(&mut result),
                    None,
                    None,
                )
                .map_err(|error| format!("failed to invoke RDP ActiveX method '{name}': {error}"));
            for variant in variants.iter_mut() {
                let _ = VariantClear(variant);
            }
            let _ = VariantClear(&mut result);
            invoke_result
        }
    }

    fn variant_i4(value: i32) -> VARIANT {
        let mut variant = VARIANT::default();
        unsafe {
            let variant_data = &mut *variant.Anonymous.Anonymous;
            variant_data.vt = VT_I4;
            variant_data.Anonymous.lVal = value;
        }
        variant
    }

    fn show_and_resize_rdp(
        session: &mut RdpSession,
        scale_factor: f64,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        force: bool,
    ) -> Result<(), String> {
        let rect = show_rdp_for_session(session, scale_factor, x, y, width, height)?;
        if !session.resolution_mode.tracks_pane_size() {
            return Ok(());
        }
        let display_settings =
            session
                .resolution_mode
                .display_settings(width, height, rect.2, rect.3, scale_factor);
        let display_sync_completed = sync_remote_desktop_size(session, display_settings, force);
        if !display_sync_completed && force {
            return Err(
                "failed to update RDP remote display size; the remote desktop may already be past the dynamic resize window"
                    .to_string(),
            );
        }
        Ok(())
    }

    fn sync_remote_desktop_size(
        session: &mut RdpSession,
        display_settings: RdpDisplaySettings,
        force: bool,
    ) -> bool {
        let connection_state = get_property_i32(&session.dispatch, "Connected").unwrap_or(-1);
        if !force
            && !should_resize_remote_desktop(
                session.desktop_width,
                session.desktop_height,
                session.desktop_scale_factor,
                session.device_scale_factor,
                display_settings.desktop_width,
                display_settings.desktop_height,
                display_settings.desktop_scale_factor,
                display_settings.device_scale_factor,
            )
        {
            rdp_debug(
                "display.resize.skipped",
                &json!({
                    "reason": "unchanged",
                    "force": force,
                    "connectionState": connection_state,
                    "connectionStateLabel": rdp_connection_state_label(connection_state),
                    "desktopWidth": display_settings.desktop_width,
                    "desktopHeight": display_settings.desktop_height,
                    "physicalWidth": display_settings.physical_width,
                    "physicalHeight": display_settings.physical_height,
                    "desktopScaleFactor": display_settings.desktop_scale_factor,
                    "deviceScaleFactor": display_settings.device_scale_factor,
                }),
            );
            return true;
        }
        let resize_method = match resize_remote_desktop(&session.dispatch, display_settings) {
            Ok(method) => method,
            Err(error) => {
                session.dynamic_resize_failures = session.dynamic_resize_failures.saturating_add(1);
                rdp_debug(
                    "display.resize.error",
                    &json!({
                        "error": error,
                        "force": force,
                        "failures": session.dynamic_resize_failures,
                        "connectionState": connection_state,
                        "connectionStateLabel": rdp_connection_state_label(connection_state),
                        "desktopWidth": display_settings.desktop_width,
                        "desktopHeight": display_settings.desktop_height,
                        "physicalWidth": display_settings.physical_width,
                        "physicalHeight": display_settings.physical_height,
                        "desktopScaleFactor": display_settings.desktop_scale_factor,
                        "deviceScaleFactor": display_settings.device_scale_factor,
                    }),
                );
                return false;
            }
        };
        if session.dynamic_resize_failures > 0 {
            rdp_debug(
                "display.resize.recovered",
                &json!({
                    "previousFailures": session.dynamic_resize_failures,
                    "connectionState": connection_state,
                    "connectionStateLabel": rdp_connection_state_label(connection_state),
                    "desktopWidth": display_settings.desktop_width,
                    "desktopHeight": display_settings.desktop_height,
                    "physicalWidth": display_settings.physical_width,
                    "physicalHeight": display_settings.physical_height,
                    "desktopScaleFactor": display_settings.desktop_scale_factor,
                    "deviceScaleFactor": display_settings.device_scale_factor,
                }),
            );
        }
        session.dynamic_resize_failures = 0;
        session.desktop_width = display_settings.desktop_width;
        session.desktop_height = display_settings.desktop_height;
        session.desktop_scale_factor = display_settings.desktop_scale_factor;
        session.device_scale_factor = display_settings.device_scale_factor;
        rdp_debug(
            "display.resize.ok",
            &json!({
                "method": resize_method,
                "force": force,
                "connectionState": connection_state,
                "connectionStateLabel": rdp_connection_state_label(connection_state),
                "desktopWidth": display_settings.desktop_width,
                "desktopHeight": display_settings.desktop_height,
                "physicalWidth": display_settings.physical_width,
                "physicalHeight": display_settings.physical_height,
                "desktopScaleFactor": display_settings.desktop_scale_factor,
                "deviceScaleFactor": display_settings.device_scale_factor,
            }),
        );
        true
    }

    #[allow(clippy::too_many_arguments)]
    fn should_resize_remote_desktop(
        current_width: i32,
        current_height: i32,
        current_desktop_scale_factor: i32,
        current_device_scale_factor: i32,
        desktop_width: i32,
        desktop_height: i32,
        desktop_scale_factor: i32,
        device_scale_factor: i32,
    ) -> bool {
        // Compare the DPI scale factors alongside the pixel dimensions: the RDP
        // ActiveX control can land at the right resolution but the wrong scale
        // (the first UpdateSessionDisplaySettings after Connect is frequently
        // ignored), and a scale-only correction must still re-issue the resize.
        current_width != desktop_width
            || current_height != desktop_height
            || current_desktop_scale_factor != desktop_scale_factor
            || current_device_scale_factor != device_scale_factor
    }

    fn resize_remote_desktop(
        dispatch: &IDispatch,
        display_settings: RdpDisplaySettings,
    ) -> Result<&'static str, String> {
        invoke_method_with_i32_args(
            dispatch,
            "UpdateSessionDisplaySettings",
            &[
                display_settings.desktop_width,
                display_settings.desktop_height,
                display_settings.physical_width,
                display_settings.physical_height,
                RDP_DISPLAY_ORIENTATION_LANDSCAPE,
                display_settings.desktop_scale_factor,
                display_settings.device_scale_factor,
            ],
        )
        .map(|()| "UpdateSessionDisplaySettings")
    }

    fn show_rdp_for_session(
        session: &RdpSession,
        scale_factor: f64,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Result<(i32, i32, i32, i32), String> {
        apply_smart_sizing(&session.dispatch, session.resolution_mode.smart_sizing());
        let rect = show_rdp(
            session.hwnd,
            session.owner,
            scale_factor,
            x,
            y,
            width,
            height,
        )?;
        Ok(rect)
    }

    fn apply_smart_sizing(dispatch: &IDispatch, enabled: bool) {
        let Some(advanced) = get_advanced_settings(dispatch) else {
            rdp_debug(
                "display.smart_sizing.unavailable",
                &json!({ "enabled": enabled }),
            );
            return;
        };
        if let Err(error) = set_property_bool(&advanced, "SmartSizing", enabled) {
            rdp_debug(
                "display.smart_sizing.error",
                &json!({
                    "enabled": enabled,
                    "error": error,
                }),
            );
        }
    }

    fn show_rdp(
        hwnd: HWND,
        owner: HWND,
        scale_factor: f64,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Result<(i32, i32, i32, i32), String> {
        let rect = screen_rect(owner, scale_factor, x, y, width, height)?;
        position_rdp(hwnd, rect)?;
        Ok(rect)
    }

    fn position_rdp(hwnd: HWND, rect: (i32, i32, i32, i32)) -> Result<(), String> {
        unsafe {
            SetWindowPos(
                hwnd,
                None,
                rect.0,
                rect.1,
                rect.2,
                rect.3,
                SWP_NOACTIVATE | SWP_NOZORDER,
            )
            .map_err(|error| format!("failed to position RDP control: {error}"))?;
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
        Ok(())
    }

    fn apply_rdp_clip_region(
        hwnd: HWND,
        owner: HWND,
        native_rect: (i32, i32, i32, i32),
        viewport_x: f64,
        viewport_y: f64,
        viewport_width: f64,
        viewport_height: f64,
        clip_rects: &[crate::kkterm_rdp::types::KktermRdpClipRect],
        scale_factor: f64,
    ) -> Result<(), String> {
        let viewport_rect = screen_rect(
            owner,
            scale_factor,
            viewport_x,
            viewport_y,
            viewport_width,
            viewport_height,
        )?;
        let Some((base_left, base_top, base_right, base_bottom)) = intersect_rect_with_bounds(
            viewport_rect.0 - native_rect.0,
            viewport_rect.1 - native_rect.1,
            viewport_rect.2,
            viewport_rect.3,
            native_rect.2,
            native_rect.3,
        ) else {
            reset_rdp_clip_region(hwnd)?;
            return Ok(());
        };
        let needs_viewport_region = base_left != 0
            || base_top != 0
            || base_right != native_rect.2
            || base_bottom != native_rect.3;
        if clip_rects.is_empty() && !needs_viewport_region {
            reset_rdp_clip_region(hwnd)?;
            return Ok(());
        }

        unsafe {
            let visible_region = CreateRectRgn(base_left, base_top, base_right, base_bottom);
            if visible_region.is_invalid() {
                return Err("failed to create RDP visible clip region".to_string());
            }

            let mut applied = 0usize;
            for clip_rect in clip_rects {
                if clip_rect.width <= 0.0 || clip_rect.height <= 0.0 {
                    continue;
                }
                let clip = scaled_rect(
                    clip_rect.x,
                    clip_rect.y,
                    clip_rect.width,
                    clip_rect.height,
                    scale_factor,
                );
                let clip_origin = match client_to_screen_point(owner, clip.0, clip.1) {
                    Ok(origin) => origin,
                    Err(error) => {
                        let _ = DeleteObject(visible_region.into());
                        return Err(error);
                    }
                };
                let raw_left = clip_origin.0 - native_rect.0;
                let raw_top = clip_origin.1 - native_rect.1;
                let Some((left, top, right, bottom)) = intersect_rect_with_bounds(
                    raw_left,
                    raw_top,
                    clip.2,
                    clip.3,
                    native_rect.2,
                    native_rect.3,
                ) else {
                    continue;
                };
                let menu_region = CreateRectRgn(left, top, right, bottom);
                if menu_region.is_invalid() {
                    let _ = DeleteObject(visible_region.into());
                    return Err("failed to create RDP menu clip region".to_string());
                }
                let combined = CombineRgn(
                    Some(visible_region),
                    Some(visible_region),
                    Some(menu_region),
                    RGN_DIFF,
                );
                let _ = DeleteObject(menu_region.into());
                if combined == RGN_ERROR {
                    let _ = DeleteObject(visible_region.into());
                    return Err("failed to combine RDP clip region".to_string());
                }
                applied += 1;
            }

            if applied == 0 && !needs_viewport_region {
                let _ = DeleteObject(visible_region.into());
                reset_rdp_clip_region(hwnd)?;
                return Ok(());
            }

            if SetWindowRgn(hwnd, Some(visible_region), true) == 0 {
                let _ = DeleteObject(visible_region.into());
                return Err("failed to apply RDP clip region".to_string());
            }
        }
        Ok(())
    }

    fn reset_rdp_clip_region(hwnd: HWND) -> Result<(), String> {
        unsafe {
            if SetWindowRgn(hwnd, None, true) == 0 {
                return Err("failed to reset RDP clip region".to_string());
            }
        }
        Ok(())
    }

    fn follow_rdp_host_window(session: &RdpSession) -> Result<(), String> {
        let bounds = session.viewport_bounds;
        let rect = scaled_rect(
            bounds.x,
            bounds.y,
            bounds.width,
            bounds.height,
            bounds.scale_factor,
        );
        let origin = client_to_screen_point(session.owner, rect.0, rect.1)?;
        unsafe {
            SetWindowPos(
                session.hwnd,
                None,
                origin.0,
                origin.1,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOSIZE | SWP_NOZORDER,
            )
            .map_err(|error| format!("failed to follow RDP host window: {error}"))?;
        }
        Ok(())
    }

    fn stage_rdp(
        hwnd: HWND,
        scale_factor: f64,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Result<(i32, i32, i32, i32), String> {
        let rect = scaled_rect(x, y, width, height, scale_factor);
        let staged = staged_rect(rect.2, rect.3);
        unsafe {
            SetWindowPos(
                hwnd,
                None,
                staged.0,
                staged.1,
                staged.2,
                staged.3,
                SWP_NOACTIVATE | SWP_NOZORDER,
            )
            .map_err(|error| format!("failed to stage RDP control: {error}"))?;
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
        Ok(staged)
    }

    fn staged_rect(width: i32, height: i32) -> (i32, i32, i32, i32) {
        (
            HIDDEN_RDP_POSITION,
            HIDDEN_RDP_POSITION,
            width.max(1),
            height.max(1),
        )
    }

    fn screen_rect(
        owner: HWND,
        scale_factor: f64,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Result<(i32, i32, i32, i32), String> {
        let rect = scaled_rect(x, y, width, height, scale_factor);
        let origin = client_to_screen_point(owner, rect.0, rect.1)?;
        Ok((origin.0, origin.1, rect.2, rect.3))
    }

    fn client_to_screen_point(owner: HWND, x: i32, y: i32) -> Result<(i32, i32), String> {
        let mut point = POINT { x, y };
        let ok = unsafe { ClientToScreen(owner, &mut point) };
        if !ok.as_bool() {
            return Err("failed to translate RDP host coordinates to screen space".to_string());
        }
        Ok((point.x, point.y))
    }

    fn rdp_surface_state(session: &RdpSession) -> RdpSurfaceState {
        let mut rect = RECT::default();
        let rect = unsafe { GetWindowRect(session.hwnd, &mut rect) }
            .ok()
            .map(|()| {
                (
                    rect.left,
                    rect.top,
                    (rect.right - rect.left).max(0),
                    (rect.bottom - rect.top).max(0),
                )
            });
        let visible = session.visible && unsafe { IsWindowVisible(session.hwnd).as_bool() };
        let onscreen = visible
            && rect.is_some_and(|rect| {
                rect.2 > 1
                    && rect.3 > 1
                    && rect.0 != HIDDEN_RDP_POSITION
                    && rect.1 != HIDDEN_RDP_POSITION
            });
        RdpSurfaceState {
            visible,
            onscreen,
            ready: visible && onscreen,
            rect,
        }
    }

    fn park_rdp_at_current_size(hwnd: HWND) -> Result<(), String> {
        let mut rect = RECT::default();
        unsafe {
            GetWindowRect(hwnd, &mut rect)
                .map_err(|error| format!("failed to read RDP control bounds: {error}"))?;
        }
        let width = (rect.right - rect.left).max(1);
        let height = (rect.bottom - rect.top).max(1);
        unsafe {
            SetWindowPos(
                hwnd,
                None,
                HIDDEN_RDP_POSITION,
                HIDDEN_RDP_POSITION,
                width,
                height,
                SWP_NOACTIVATE | SWP_NOZORDER,
            )
            .map_err(|error| format!("failed to park RDP control: {error}"))?;
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
        Ok(())
    }

    fn scaled_rect(
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        scale_factor: f64,
    ) -> (i32, i32, i32, i32) {
        let scale_factor = if scale_factor.is_finite() && scale_factor > 0.0 {
            scale_factor
        } else {
            1.0
        };
        (
            (x.max(0.0) * scale_factor).round() as i32,
            (y.max(0.0) * scale_factor).round() as i32,
            (width.max(1.0) * scale_factor).round() as i32,
            (height.max(1.0) * scale_factor).round() as i32,
        )
    }

    fn intersect_rect_with_bounds(
        raw_left: i32,
        raw_top: i32,
        width: i32,
        height: i32,
        bounds_width: i32,
        bounds_height: i32,
    ) -> Option<(i32, i32, i32, i32)> {
        let raw_right = raw_left.saturating_add(width.max(0));
        let raw_bottom = raw_top.saturating_add(height.max(0));
        let bounds_width = bounds_width.max(0);
        let bounds_height = bounds_height.max(0);
        let left = raw_left.clamp(0, bounds_width);
        let top = raw_top.clamp(0, bounds_height);
        let right = raw_right.clamp(0, bounds_width);
        let bottom = raw_bottom.clamp(0, bounds_height);

        if right <= left || bottom <= top {
            None
        } else {
            Some((left, top, right, bottom))
        }
    }

    fn desktop_width_for(width: i32) -> i32 {
        width.max(RDP_MIN_DESKTOP_WIDTH)
    }

    fn desktop_height_for(height: i32) -> i32 {
        height.max(RDP_MIN_DESKTOP_HEIGHT)
    }

    fn is_rdp_connected_state(connection_state: i32) -> bool {
        connection_state == RDP_CONNECTED_STATE
    }

    fn is_rdp_displayable_state(connection_state: i32) -> bool {
        connection_state == RDP_CONNECTED_STATE || connection_state == RDP_ESTABLISHING_STATE
    }

    fn rdp_connection_state_label(connection_state: i32) -> &'static str {
        match connection_state {
            0 => "notConnected",
            RDP_CONNECTED_STATE => "connected",
            RDP_ESTABLISHING_STATE => "establishing",
            _ => "unknown",
        }
    }

    fn rdp_display_ready_after_sync(connection_state: i32, _display_sync_completed: bool) -> bool {
        // Display synchronization is not proof that the ActiveX session has
        // finished connecting. Treat state 2 as establishing so the frontend
        // cannot expose the app background as a successful black RDP surface.
        is_rdp_connected_state(connection_state)
    }

    fn is_rdp_active_state(connection_state: i32) -> bool {
        connection_state == RDP_CONNECTED_STATE || connection_state == RDP_ESTABLISHING_STATE
    }

    fn run_on_main_thread<F, T>(operation: &'static str, app: AppHandle, f: F) -> Result<T, String>
    where
        F: FnOnce(AppHandle) -> Result<T, String> + Send + 'static,
        T: Send + 'static,
    {
        run_on_main_thread_with_trace(operation, app, true, f)
    }

    fn run_on_main_thread_quiet<F, T>(
        operation: &'static str,
        app: AppHandle,
        f: F,
    ) -> Result<T, String>
    where
        F: FnOnce(AppHandle) -> Result<T, String> + Send + 'static,
        T: Send + 'static,
    {
        run_on_main_thread_with_trace(operation, app, false, f)
    }

    fn run_on_main_thread_with_trace<F, T>(
        operation: &'static str,
        app: AppHandle,
        trace_success: bool,
        f: F,
    ) -> Result<T, String>
    where
        F: FnOnce(AppHandle) -> Result<T, String> + Send + 'static,
        T: Send + 'static,
    {
        let app_for_closure = app.clone();
        let (sender, receiver) = mpsc::channel();
        app.run_on_main_thread(move || {
            let started = Instant::now();
            let result = f(app_for_closure);
            let elapsed = started.elapsed();
            match &result {
                Ok(_) if trace_success => rdp_debug(
                    "main_thread.operation.ok",
                    &json!({
                        "operation": operation,
                        "elapsedMs": elapsed.as_millis(),
                    }),
                ),
                Err(error) => rdp_debug(
                    "main_thread.operation.error",
                    &json!({
                        "operation": operation,
                        "elapsedMs": elapsed.as_millis(),
                        "error": error,
                    }),
                ),
                Ok(_) => {}
            }
            if elapsed >= RDP_MAIN_THREAD_WARN_AFTER {
                eprintln!(
                    "RDP main-thread operation '{operation}' took {} ms; nested RDP, WebView2, or ActiveX stalls may be blocking the UI thread",
                    elapsed.as_millis()
                );
            }
            let _ = sender.send(result);
        })
        .map_err(|error| format!("failed to dispatch RDP work to main thread: {error}"))?;
        receiver
            .recv_timeout(RDP_MAIN_THREAD_TIMEOUT)
            .map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => format!(
                    "RDP main-thread operation '{operation}' did not complete within {} seconds; the Microsoft RDP ActiveX control may be stalled",
                    RDP_MAIN_THREAD_TIMEOUT.as_secs()
                ),
                mpsc::RecvTimeoutError::Disconnected => {
                    "RDP main-thread task did not return".to_string()
                }
            })?
    }

    fn atl_functions() -> Result<&'static AtlFunctions, String> {
        static ATL_FUNCTIONS: OnceLock<Result<AtlFunctions, String>> = OnceLock::new();
        ATL_FUNCTIONS
            .get_or_init(load_atl_functions)
            .as_ref()
            .map_err(Clone::clone)
    }

    fn load_atl_functions() -> Result<AtlFunctions, String> {
        let module = unsafe { LoadLibraryW(PCWSTR(wide_null("atl.dll").as_ptr())) }
            .map_err(|error| format!("failed to load atl.dll for ActiveX hosting: {error}"))?;
        let ax_win_init = unsafe { GetProcAddress(module, PCSTR(b"AtlAxWinInit\0".as_ptr())) }
            .ok_or_else(|| "atl.dll does not export AtlAxWinInit".to_string())?;
        let ax_get_control =
            unsafe { GetProcAddress(module, PCSTR(b"AtlAxGetControl\0".as_ptr())) }
                .ok_or_else(|| "atl.dll does not export AtlAxGetControl".to_string())?;
        Ok(AtlFunctions {
            ax_win_init: unsafe { std::mem::transmute::<_, AtlAxWinInit>(ax_win_init) },
            ax_get_control: unsafe { std::mem::transmute::<_, AtlAxGetControl>(ax_get_control) },
        })
    }

    fn lock_sessions(
        sessions: &Arc<Mutex<HashMap<String, RdpSession>>>,
    ) -> Result<MutexGuard<'_, HashMap<String, RdpSession>>, String> {
        sessions
            .lock()
            .map_err(|_| "RDP session lock is poisoned".to_string())
    }

    fn required_id(value: String) -> Result<String, String> {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return Err("RDP session id is required".to_string());
        }
        if trimmed.len() > 96 {
            return Err("RDP session id must be 96 characters or fewer".to_string());
        }
        if !trimmed
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        {
            return Err("RDP session id may only contain letters, digits, '-' or '_'".to_string());
        }
        Ok(trimmed.to_string())
    }

    fn required_field(label: &str, value: String) -> Result<String, String> {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return Err(format!("{label} is required"));
        }
        Ok(trimmed.to_string())
    }

    fn wide_null(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    impl VariantArg {
        fn bstr(value: &str) -> Self {
            Self(variant_bstr(value))
        }

        fn i4(value: i32) -> Self {
            let mut variant = VARIANT::default();
            unsafe {
                let variant_data = &mut *variant.Anonymous.Anonymous;
                variant_data.vt = VT_I4;
                variant_data.Anonymous.lVal = value;
            }
            Self(variant)
        }

        fn bool(value: bool) -> Self {
            let mut variant = VARIANT::default();
            unsafe {
                let variant_data = &mut *variant.Anonymous.Anonymous;
                variant_data.vt = VT_BOOL;
                variant_data.Anonymous.boolVal = if value { VARIANT_TRUE } else { VARIANT_FALSE };
            }
            Self(variant)
        }
    }

    fn variant_bstr(value: &str) -> VARIANT {
        let mut variant = VARIANT::default();
        unsafe {
            let variant_data = &mut *variant.Anonymous.Anonymous;
            variant_data.vt = VT_BSTR;
            variant_data.Anonymous.bstrVal = ManuallyDrop::new(BSTR::from(value));
        }
        variant
    }

    fn variant_u4(value: u32) -> VARIANT {
        let mut variant = VARIANT::default();
        unsafe {
            let variant_data = &mut *variant.Anonymous.Anonymous;
            variant_data.vt = VT_UI4;
            variant_data.Anonymous.ulVal = value;
        }
        variant
    }

    impl Drop for VariantArg {
        fn drop(&mut self) {
            unsafe {
                let _ = VariantClear(&mut self.0);
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn mstscax_nonscriptable_vtable_offsets_match_the_windows_type_library() {
            assert_eq!(
                std::mem::offset_of!(IMsRdpClientNonScriptable3Vtbl, put_redirect_dynamic_drives),
                200
            );
            assert_eq!(
                std::mem::offset_of!(IMsRdpClientNonScriptable5Vtbl, put_use_multimon),
                424
            );
        }

        #[test]
        fn prefers_valid_webview_scale_and_falls_back_to_host_scale() {
            assert_eq!(rdp_request_scale_factor(Some(1.5), 1.0), 1.5);
            assert_eq!(rdp_request_scale_factor(Some(f64::NAN), 1.25), 1.25);
            assert_eq!(rdp_request_scale_factor(Some(0.1), 2.0), 2.0);
            assert_eq!(rdp_request_scale_factor(None, 1.75), 1.75);
        }

        #[test]
        fn splits_domain_qualified_windows_users() {
            assert_eq!(
                split_windows_user("DOMAIN\\admin"),
                (Some("DOMAIN".to_string()), "admin".to_string())
            );
            assert_eq!(
                split_windows_user("admin@example.com"),
                (None, "admin@example.com".to_string())
            );
        }

        #[test]
        fn uses_registered_mstscax_progids_for_activex_creation() {
            assert_eq!(RDP_PROGIDS.first().copied(), Some("MsTscAx.MsTscAx.13"));
            assert!(RDP_PROGIDS.contains(&"MsTscAx.MsTscAx.12"));
            assert!(RDP_PROGIDS.contains(&"MsTscAx.MsTscAx"));
            assert!(
                RDP_PROGIDS
                    .iter()
                    .all(|progid| !progid.starts_with("MsRdpClient")),
                "RDP creation must use registered ProgIDs, not Microsoft Learn class names"
            );
        }

        #[test]
        fn tries_newest_advanced_settings_dispatch_before_fallback_names() {
            let names = ADVANCED_SETTINGS_PROPERTIES;
            assert_eq!(names.first().copied(), Some("AdvancedSettings12"));
            assert!(names.contains(&"AdvancedSettings2"));
            assert_eq!(names.last().copied(), Some("AdvancedSettings"));
        }

        #[test]
        fn validates_session_ids_for_native_window_labels() {
            assert_eq!(
                required_id("rdp-session_1".to_string()).as_deref(),
                Ok("rdp-session_1")
            );
            assert!(required_id("bad/session".to_string()).is_err());
        }

        #[test]
        fn ctrl_alt_end_windows_inputs_match_hardware_order() {
            let inputs = [
                keyboard_input(VK_CONTROL_KEY, false),
                keyboard_input(VK_ALT_KEY, false),
                keyboard_input(VK_END_KEY, false),
                keyboard_input(VK_END_KEY, true),
                keyboard_input(VK_ALT_KEY, true),
                keyboard_input(VK_CONTROL_KEY, true),
            ];

            let observed: Vec<(u16, bool)> = inputs
                .iter()
                .map(|input| {
                    let key = unsafe { input.Anonymous.ki };
                    (
                        key.wVk.0,
                        (key.dwFlags.0 & KEYEVENTF_KEYUP.0) == KEYEVENTF_KEYUP.0,
                    )
                })
                .collect();

            assert_eq!(
                observed,
                vec![
                    (VK_CONTROL_KEY as u16, false),
                    (VK_ALT_KEY as u16, false),
                    (VK_END_KEY as u16, false),
                    (VK_END_KEY as u16, true),
                    (VK_ALT_KEY as u16, true),
                    (VK_CONTROL_KEY as u16, true),
                ]
            );
        }

        #[test]
        fn scales_logical_bounds_to_physical_pixels() {
            assert_eq!(
                scaled_rect(10.0, 20.0, 800.0, 600.0, 1.5),
                (15, 30, 1200, 900)
            );
            assert_eq!(scaled_rect(-10.0, -20.0, 0.0, 0.0, 1.25), (0, 0, 1, 1));
            assert_eq!(
                scaled_rect(10.0, 20.0, 800.0, 600.0, 0.0),
                (10, 20, 800, 600)
            );
        }

        #[test]
        fn clip_intersection_trims_portion_above_native_window() {
            assert_eq!(
                intersect_rect_with_bounds(0, -25, 140, 66, 300, 200),
                Some((0, 0, 140, 41))
            );
        }

        #[test]
        fn clip_intersection_trims_portion_left_of_native_window() {
            assert_eq!(
                intersect_rect_with_bounds(-12, 10, 140, 66, 300, 200),
                Some((0, 10, 128, 76))
            );
        }

        #[test]
        fn clip_intersection_ignores_rects_outside_native_window() {
            assert_eq!(intersect_rect_with_bounds(0, -70, 140, 66, 300, 200), None);
            assert_eq!(intersect_rect_with_bounds(305, 10, 140, 66, 300, 200), None);
        }

        #[test]
        fn enforces_rdp_desktop_minimum_size() {
            assert_eq!(desktop_width_for(320), RDP_MIN_DESKTOP_WIDTH);
            assert_eq!(desktop_height_for(240), RDP_MIN_DESKTOP_HEIGHT);
            assert_eq!(desktop_width_for(1200), 1200);
            assert_eq!(desktop_height_for(900), 900);
        }

        #[test]
        fn preserves_raw_kkterm_scancode_and_key_direction() {
            let down = SendRdpKeyPressRequest::from_kkterm_key(
                crate::kkterm_rdp::types::KktermRdpKeyRequest {
                    tab_id: "tab-1".to_string(),
                    scancode: 0xe05b,
                    down: true,
                },
            );
            let up = SendRdpKeyPressRequest::from_kkterm_key(
                crate::kkterm_rdp::types::KktermRdpKeyRequest {
                    tab_id: "tab-1".to_string(),
                    scancode: 0xe05b,
                    down: false,
                },
            );

            assert_eq!(down.scancode, 0xe05b);
            assert!(down.down);
            assert_eq!(up.scancode, 0xe05b);
            assert!(!up.down);
        }

        #[test]
        fn builds_active_x_lparams_from_set1_scancodes() {
            assert_eq!(
                rdp_scancode_lparam(0x003b, false).unwrap() as u32,
                0x003b0001
            );
            assert_eq!(
                rdp_scancode_lparam(0x003b, true).unwrap() as u32,
                0xc03b0001
            );
            assert_eq!(
                rdp_scancode_lparam(0xe053, false).unwrap() as u32,
                0x01530001
            );
            assert_eq!(
                rdp_scancode_lparam(0xe053, true).unwrap() as u32,
                0xc1530001
            );
            assert_eq!(
                rdp_scancode_lparam(0xe05b, false).unwrap() as u32,
                0x015b0001
            );
            assert_eq!(
                rdp_scancode_lparam(0x001c, false).unwrap() as u32,
                0x001c0001
            );
            assert_eq!(
                rdp_scancode_lparam(0xe01c, false).unwrap() as u32,
                0x011c0001
            );
        }

        #[test]
        fn rejects_zero_and_unknown_set1_scancode_prefixes() {
            assert!(split_set1_scancode(0).is_err());
            assert!(split_set1_scancode(0xe11d).is_err());
        }

        #[test]
        fn automatic_resolution_tracks_physical_desktop_without_smart_sizing() {
            assert_eq!(
                RemoteResolutionMode::Automatic.desktop_size(1200.0, 800.0, 1800, 1200),
                (1800, 1200)
            );
            assert!(!RemoteResolutionMode::Automatic.smart_sizing());
            assert!(RemoteResolutionMode::Automatic.tracks_pane_size());
            assert!(RemoteResolutionMode::DpiZoom.tracks_pane_size());
        }

        #[test]
        fn automatic_display_settings_apply_host_dpi_with_unknown_physical_size() {
            let settings =
                RemoteResolutionMode::Automatic.display_settings(1200.0, 800.0, 1800, 1200, 1.5);

            assert_eq!(settings.desktop_width, 1800);
            assert_eq!(settings.desktop_height, 1200);
            assert_eq!(settings.physical_width, RDP_UNKNOWN_PHYSICAL_SIZE_MM);
            assert_eq!(settings.physical_height, RDP_UNKNOWN_PHYSICAL_SIZE_MM);
            assert_eq!(settings.desktop_scale_factor, 150);
            assert_eq!(settings.device_scale_factor, 140);
        }

        #[test]
        fn automatic_display_settings_pass_through_native_dpi() {
            let settings =
                RemoteResolutionMode::Automatic.display_settings(1920.0, 1080.0, 1920, 1080, 1.0);

            assert_eq!(settings.desktop_width, 1920);
            assert_eq!(settings.desktop_height, 1080);
            assert_eq!(settings.desktop_scale_factor, 100);
            assert_eq!(settings.device_scale_factor, 100);
        }

        #[test]
        fn fixed_display_settings_stretch_selected_resolution_with_smart_sizing() {
            let settings = RemoteResolutionMode::Fixed {
                width: 1440,
                height: 900,
            }
            .display_settings(1200.0, 800.0, 1800, 1200, 1.5);

            assert_eq!(settings.desktop_width, 1440);
            assert_eq!(settings.desktop_height, 900);
            assert_eq!(settings.physical_width, RDP_UNKNOWN_PHYSICAL_SIZE_MM);
            assert_eq!(settings.physical_height, RDP_UNKNOWN_PHYSICAL_SIZE_MM);
            assert_eq!(settings.desktop_scale_factor, 100);
        }

        #[test]
        fn dpi_zoom_display_settings_apply_local_scale_factor() {
            let settings =
                RemoteResolutionMode::DpiZoom.display_settings(1200.0, 800.0, 1800, 1200, 1.5);

            assert_eq!(settings.desktop_width, 1800);
            assert_eq!(settings.desktop_height, 1200);
            assert_eq!(settings.physical_width, RDP_UNKNOWN_PHYSICAL_SIZE_MM);
            assert_eq!(settings.physical_height, RDP_UNKNOWN_PHYSICAL_SIZE_MM);
            assert_eq!(settings.desktop_scale_factor, 150);
            assert_eq!(settings.device_scale_factor, 140);
        }

        #[test]
        fn treats_unknown_desktop_size_as_needing_resize() {
            // (current_w, current_h, current_desktop_scale, current_device_scale,
            //  target_w, target_h, target_desktop_scale, target_device_scale)
            assert!(should_resize_remote_desktop(
                0, 0, 0, 0, 1920, 1080, 100, 100
            ));
            assert!(should_resize_remote_desktop(
                1920, 1080, 100, 100, 2048, 1080, 100, 100
            ));
            assert!(!should_resize_remote_desktop(
                1920, 1080, 100, 100, 1920, 1080, 100, 100
            ));
        }

        #[test]
        fn treats_scale_factor_change_as_needing_resize() {
            // Same pixel dimensions, but a corrected DPI scale still re-applies:
            // the early post-Connect display sync often lands at 100% before the
            // session is interactive enough to honor the host scale factor.
            assert!(should_resize_remote_desktop(
                1920, 1080, 100, 100, 1920, 1080, 150, 140
            ));
            assert!(should_resize_remote_desktop(
                1920, 1080, 150, 100, 1920, 1080, 150, 140
            ));
            assert!(!should_resize_remote_desktop(
                1920, 1080, 150, 140, 1920, 1080, 150, 140
            ));
        }

        #[test]
        fn stages_rdp_control_offscreen_at_requested_size() {
            assert_eq!(
                staged_rect(1920, 1080),
                (HIDDEN_RDP_POSITION, HIDDEN_RDP_POSITION, 1920, 1080)
            );
            assert_eq!(
                staged_rect(0, -10),
                (HIDDEN_RDP_POSITION, HIDDEN_RDP_POSITION, 1, 1)
            );
        }

        #[test]
        fn treats_only_connected_rdp_state_as_connected() {
            assert!(!is_rdp_connected_state(0));
            assert!(is_rdp_connected_state(1));
            assert!(!is_rdp_connected_state(2));
        }

        #[test]
        fn treats_active_rdp_states_as_displayable() {
            assert!(!is_rdp_displayable_state(0));
            assert!(is_rdp_displayable_state(1));
            assert!(is_rdp_displayable_state(2));
        }

        #[test]
        fn labels_rdp_connection_states_for_debug_logs() {
            assert_eq!(rdp_connection_state_label(0), "notConnected");
            assert_eq!(rdp_connection_state_label(1), "connected");
            assert_eq!(rdp_connection_state_label(2), "establishing");
            assert_eq!(rdp_connection_state_label(99), "unknown");
        }

        #[test]
        fn treats_only_connected_rdp_as_display_ready_when_dynamic_sync_fails() {
            assert!(rdp_display_ready_after_sync(1, true));
            assert!(rdp_display_ready_after_sync(1, false));
            assert!(!rdp_display_ready_after_sync(2, true));
            assert!(!rdp_display_ready_after_sync(2, false));
            assert!(!rdp_display_ready_after_sync(0, true));
        }

        #[test]
        fn hosts_activex_in_a_nonactivating_owned_popup() {
            let (extended_style, style) = rdp_host_window_styles();

            assert_ne!(extended_style.0 & WS_EX_NOACTIVATE.0, 0);
            assert_ne!(extended_style.0 & WS_EX_TOOLWINDOW.0, 0);
            assert_ne!(style.0 & WS_POPUP.0, 0);
            assert_eq!(RDP_HOST_WINDOW_MODE, "owned-popup");
        }

        #[test]
        fn treats_establishing_rdp_state_as_active_not_disconnected() {
            assert!(!is_rdp_active_state(0));
            assert!(is_rdp_active_state(1));
            assert!(is_rdp_active_state(2));
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use serde::{Deserialize, Serialize};
    use tauri::AppHandle;

    #[derive(Clone)]
    pub struct RdpSessionManager;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct StartRdpSessionRequest {
        pub session_id: String,
        pub host: String,
        pub user: String,
        pub port: Option<u16>,
        pub secret_owner_id: Option<String>,
        pub password: Option<String>,
        pub x: f64,
        pub y: f64,
        pub width: f64,
        pub height: f64,
        pub scale_factor: Option<f64>,
        pub options: Option<RdpSessionOptions>,
    }

    #[derive(Clone, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RdpSessionOptions {
        pub color_depth: u16,
        pub redirect_clipboard: bool,
        pub redirect_drives: bool,
        pub use_multimon: bool,
        pub bitmap_cache: bool,
        pub performance_profile: String,
        #[serde(default)]
        pub remote_resolution: String,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RdpSessionStarted {
        session_id: String,
        host: String,
        port: u16,
        control: String,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RdpSessionStatus {
        session_id: String,
        connection_state: i32,
        connected: bool,
        surface_visible: bool,
        surface_onscreen: bool,
        surface_ready: bool,
        host_window_mode: &'static str,
        extended_disconnect_reason: Option<i32>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct UpdateRdpBoundsRequest {
        pub session_id: String,
        pub x: f64,
        pub y: f64,
        pub width: f64,
        pub height: f64,
        pub scale_factor: Option<f64>,
        #[serde(default)]
        pub force: bool,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct SetRdpVisibilityRequest {
        pub session_id: String,
        pub visible: bool,
        pub x: f64,
        pub y: f64,
        pub width: f64,
        pub height: f64,
        pub scale_factor: Option<f64>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct SyncRdpDisplaySizeRequest {
        pub session_id: String,
        pub x: f64,
        pub y: f64,
        pub width: f64,
        pub height: f64,
        pub scale_factor: Option<f64>,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RdpDisplaySizeSync {
        session_id: String,
        connection_state: i32,
        connected: bool,
        extended_disconnect_reason: Option<i32>,
        display_synced: bool,
        surface_visible: bool,
        surface_onscreen: bool,
        surface_ready: bool,
        host_window_mode: &'static str,
        desktop_width: i32,
        desktop_height: i32,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RdpSimpleRequest {
        pub session_id: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct SendRdpTextRequest {
        pub session_id: String,
        pub text: String,
        pub mode: Option<String>,
        pub press_enter: Option<bool>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct SendRdpKeyPressRequest {
        pub session_id: String,
        pub key: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct SendRdpMouseClickRequest {
        pub session_id: String,
        pub x: u16,
        pub y: u16,
        pub button: String,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RdpTextSent {
        session_id: String,
        mode: String,
        fell_back: bool,
        char_count: u32,
    }

    impl RdpSessionManager {
        pub fn new() -> Self {
            Self
        }

        pub fn start_session(
            &self,
            _app: AppHandle,
            _request: StartRdpSessionRequest,
        ) -> Result<RdpSessionStarted, String> {
            Err("RDP sessions require Windows and the Microsoft RDP ActiveX control".to_string())
        }

        pub fn update_bounds(
            &self,
            _app: AppHandle,
            _request: UpdateRdpBoundsRequest,
        ) -> Result<(), String> {
            Ok(())
        }

        pub fn set_visibility(
            &self,
            _app: AppHandle,
            _request: SetRdpVisibilityRequest,
        ) -> Result<(), String> {
            Ok(())
        }

        pub fn follow_host_window(&self, _app: AppHandle) -> Result<(), String> {
            Ok(())
        }

        pub fn sync_display_size(
            &self,
            _app: AppHandle,
            request: SyncRdpDisplaySizeRequest,
        ) -> Result<RdpDisplaySizeSync, String> {
            Ok(RdpDisplaySizeSync {
                session_id: request.session_id,
                connection_state: 0,
                connected: false,
                extended_disconnect_reason: None,
                display_synced: false,
                surface_visible: false,
                surface_onscreen: false,
                surface_ready: false,
                host_window_mode: "unsupported",
                desktop_width: 0,
                desktop_height: 0,
            })
        }

        pub fn close_session(
            &self,
            _app: AppHandle,
            _request: RdpSimpleRequest,
        ) -> Result<(), String> {
            Ok(())
        }

        pub fn session_status(
            &self,
            _app: AppHandle,
            request: RdpSimpleRequest,
        ) -> Result<RdpSessionStatus, String> {
            Ok(RdpSessionStatus {
                session_id: request.session_id,
                connection_state: 0,
                connected: is_rdp_connected_state(0),
                surface_visible: false,
                surface_onscreen: false,
                surface_ready: false,
                host_window_mode: "unsupported",
                extended_disconnect_reason: None,
            })
        }

        pub fn send_ctrl_alt_delete(
            &self,
            _app: AppHandle,
            _request: RdpSimpleRequest,
        ) -> Result<(), String> {
            Err(
                "RDP Ctrl+Alt+Delete requires Windows and the Microsoft RDP ActiveX control"
                    .to_string(),
            )
        }

        pub fn send_text(
            &self,
            _app: AppHandle,
            _request: SendRdpTextRequest,
        ) -> Result<RdpTextSent, String> {
            Err(
                "RDP text injection requires Windows and the Microsoft RDP ActiveX control"
                    .to_string(),
            )
        }

        pub fn send_key_press(
            &self,
            _app: AppHandle,
            _request: SendRdpKeyPressRequest,
        ) -> Result<(), String> {
            Err(
                "RDP key injection requires Windows and the Microsoft RDP ActiveX control"
                    .to_string(),
            )
        }

        pub fn send_mouse_click(
            &self,
            _app: AppHandle,
            _request: SendRdpMouseClickRequest,
        ) -> Result<(), String> {
            Err(
                "RDP mouse injection requires Windows and the Microsoft RDP ActiveX control"
                    .to_string(),
            )
        }
    }

    fn is_rdp_connected_state(connection_state: i32) -> bool {
        connection_state == 1
    }

    fn is_rdp_displayable_state(connection_state: i32) -> bool {
        connection_state == 1 || connection_state == 2
    }

    impl StartRdpSessionRequest {
        pub(crate) fn secret_owner_id(&self) -> Option<&str> {
            self.secret_owner_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
        }

        pub(crate) fn password(&self) -> Option<&str> {
            self.password.as_deref().filter(|value| !value.is_empty())
        }

        pub(crate) fn set_password(&mut self, password: Option<String>) {
            self.password = password;
        }
    }
}

pub use platform::*;

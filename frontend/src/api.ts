import { invoke } from '@tauri-apps/api/core';
import type { DiagnosticLogEntry } from '@/lib/diagnostic-logs';

export interface CloudAccountStatus {
  enabled: boolean;
  authorized: boolean;
  account_available: boolean;
  account_available_until?: string | null;
  device_expires_at?: string | null;
  display?: string | null;
  reason?: string | null;
}

export interface CloudAuthorizationStart {
  authorize_url: string;
  state: string;
}

export interface UpdateInfo {
  has_update: boolean;
  current_version: string;
  latest_version: string | null;
  download_url?: string;
  error?: string;
}

export type ConnectionRoute = 'cloud' | 'lan_direct' | 'local_direct' | 'cloud_fallback';

export interface NativeRdpConnectResponse {
  wsPort: number;
  routeLabel: ConnectionRoute;
}

export const api = {
  checkForUpdate: () =>
    invoke<UpdateInfo>('check_for_update'),

  getCurrentVersion: () =>
    invoke<string>('get_current_version'),

  getSystemLanguage: () =>
    invoke<string>('get_system_language'),

  getRdpProxyPort: () =>
    invoke<number>('get_rdp_proxy_port'),

  cloudStartAuthorization: () =>
    invoke<CloudAuthorizationStart>('cloud_start_authorization'),

  cloudHandleCallback: (callbackUrl: string) =>
    invoke<CloudAccountStatus>('cloud_handle_callback', { callbackUrl }),

  cloudGetStatus: () =>
    invoke<CloudAccountStatus>('cloud_get_status'),

  cloudRefreshStatus: () =>
    invoke<CloudAccountStatus>('cloud_refresh_status'),

  cloudDisable: () =>
    invoke<boolean>('cloud_disable'),

  cloudKeepBindingAlive: (tabId: string, host: string, port: number) =>
    invoke<void>('cloud_keep_binding_alive', { sessionId: tabId, host, port }),

  // ── Native RDP Session ──────────────────────────────
  rdpNativeConnect: (params: {
    tabId: string;
    host: string;
    port: number;
    username: string;
    password: string;
    domain?: string;
    width: number;
    height: number;
    renderProfile?: string;
    reuseCloudBinding?: boolean;
  }) => invoke<NativeRdpConnectResponse>('rdp_native_connect', params),

  rdpNativeSetViewBounds: (tabId: string, bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
    scaleFactor: number;
    visible: boolean;
  }) => invoke<void>('rdp_native_set_view_bounds', { tabId, ...bounds }),

  rdpNativeInput: (tabId: string, scancode: number, isPressed: boolean) =>
    invoke<void>('rdp_native_input', { tabId, scancode, isPressed }),

  rdpNativeForceClipboardCheck: (tabId: string) =>
    invoke<void>('rdp_native_force_clipboard_check', { tabId }),

  rdpNativeSetActiveClipboardSession: (tabId: string | null) =>
    invoke<void>('rdp_native_set_active_clipboard_session', { tabId }),

  rdpNativeMouse: (tabId: string, x: number, y: number, button: number, isDown: boolean) =>
    invoke<void>('rdp_native_mouse', { tabId, x, y, button, isDown }),

  rdpNativeWheel: (tabId: string, x: number, y: number, delta: number, isHorizontal: boolean) =>
    invoke<void>('rdp_native_wheel', { tabId, x, y, delta, isHorizontal }),

  rdpNativeDisconnect: (tabId: string) =>
    invoke<void>('rdp_native_disconnect', { tabId }),

  rdpNativeResize: (tabId: string, width: number, height: number) =>
    invoke<void>('rdp_native_resize', { tabId, width, height }),

  // ── Diagnostic Logs ──────────────────────────────────
  logShowInFinder: () => invoke<void>('log_show_in_finder'),
  logCopyToDesktop: () => invoke<string>('log_copy_to_desktop'),
  logCopyDiagnosticBundleToDesktop: () => invoke<string>('log_copy_diagnostic_bundle_to_desktop'),
  logClear: () => invoke<void>('log_clear'),
  logFilePath: () => invoke<string>('log_file_path_str'),
  logFileSize: () => invoke<number>('log_file_size'),
  rdpLogClear: () => invoke<void>('rdp_log_clear'),
  rdpLogFilePath: () => invoke<string>('rdp_log_file_path_str'),
  rdpLogFileSize: () => invoke<number>('rdp_log_file_size'),
  diagnosticLogRead: (limit = 1000) =>
    invoke<DiagnosticLogEntry[]>('diagnostic_log_read', { limit }),
};

// ── Tauri Event Types (small, via emit) ─────────────

export interface RdpStatusEvent {
  tab_id: string;
  status: 'connected' | 'disconnected' | 'error';
  message?: string;
}

export interface RdpPointerEvent {
  tab_id: string;
  kind: 'default' | 'hidden' | 'position' | 'bitmap';
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  hotspot_x?: number;
  hotspot_y?: number;
  /** RGBA bitmap data for custom cursor */
  bitmap?: number[];
}

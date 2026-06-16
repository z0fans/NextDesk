import { invoke } from '@tauri-apps/api/core';

export interface RunMode {
  reuse_mode: boolean;
  clash_api: string;
  proxy_port: number;
  cloud_mode: boolean;
  dashboard_url: string;
}

export interface RelayEndpoint {
  id: number;
  name: string;
  host: string;
  port: number;
  protocol: string;
  server_name: string;
}

export interface EngineStatus {
  clash: boolean;
  rdp_proxy_port: number;
  rdp_proxy_error?: string | null;
}

export interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  sharedFolder?: string;
  latency?: number;
  status: 'online' | 'offline' | 'unknown';
}

export interface ProxyGroup {
  name: string;
  type: string;
  proxies: string[];
  now?: string;
}

export interface ProxyDelayAttempt {
  url: string;
  status: string;
  delay?: number | null;
  error?: string | null;
}

export interface ProxyDelayDetail {
  name: string;
  delay: number;
  url?: string | null;
  status: 'ok' | 'failed' | string;
  error?: string | null;
  attempts: ProxyDelayAttempt[];
}

export interface ProxyPlaneDiagnostics {
  apiBase: string;
  apiReady: boolean;
  proxyCount: number;
  realProxyCount: number;
  delayUrls: string[];
  details: ProxyDelayDetail[];
}

export interface SubscriptionResult {
  success: boolean;
  error: string | null;
  server_count: number;
  proxy_groups?: ProxyGroup[];
}

export interface UpdateInfo {
  has_update: boolean;
  current_version: string;
  latest_version: string | null;
  download_url?: string;
  error?: string;
}

export interface SyncState {
  type: 'Idle' | 'Syncing' | 'Failed';
  error_category?: string;
  error_detail?: string;
}

export interface AutoUpdateStatus {
  enabled: boolean;
  last_sync_ts: number;
  sync_state: SyncState;
}



export interface Connection {
  id: string;
  metadata: {
    network: string;
    type: string;
    sourceIP: string;
    destinationIP: string;
    sourcePort: string;
    destinationPort: string;
    host: string;
    dnsMode: string;
    processPath: string;
  };
  upload: number;
  download: number;
  start: string;
  chains: string[];
  rule: string;
  rulePayload: string;
}

export interface ConnectionsData {
  connections: Connection[];
  downloadTotal: number;
  uploadTotal: number;
}

export const api = {
  startEngine: (forceInternal?: boolean) =>
    invoke<boolean>('start_engine', { forceInternal: forceInternal ?? null }),

  stopEngine: () =>
    invoke<boolean>('stop_engine'),

  getStatus: () =>
    invoke<EngineStatus>('get_status'),

  saveConfig: (_config: Record<string, unknown>) =>
    invoke<boolean>('save_config'),

  loadSubscription: (url: string) =>
    invoke<SubscriptionResult>('load_subscription', {
      url,
    }),

  getServers: () =>
    invoke<Server[]>('get_servers'),

  getProxyGroups: () =>
    invoke<ProxyGroup[]>('get_proxy_groups'),

  getSubscriptionUrl: () =>
    invoke<string>('get_subscription_url'),

  testServersConnectivity: () =>
    invoke<Server[]>('test_servers_connectivity'),

  testGroupDelays: (groupName: string) =>
    invoke<Record<string, number>>(
      'test_group_delays',
      { groupName },
    ),

  getProxyPlaneDiagnostics: (groupName: string) =>
    invoke<ProxyPlaneDiagnostics>(
      'get_proxy_plane_diagnostics',
      { groupName },
    ),

  checkForUpdate: () =>
    invoke<UpdateInfo>('check_for_update'),

  getCurrentVersion: () =>
    invoke<string>('get_current_version'),

  getConnections: () =>
    invoke<ConnectionsData>('get_connections'),

  switchProxy: (
    groupName: string,
    proxyName: string,
  ) =>
    invoke<boolean>('switch_proxy', {
      groupName,
      proxyName,
    }),

  getRunMode: () =>
    invoke<RunMode>('get_run_mode'),

  getSystemLanguage: () =>
    invoke<string>('get_system_language'),

  getRdpProxyPort: () =>
    invoke<number>('get_rdp_proxy_port'),

  getTubeEnabled: () =>
    invoke<boolean>('get_tube_enabled'),

  setTubeEnabled: (enabled: boolean) =>
    invoke<boolean>('set_tube_enabled', { enabled }),

  // ── Cloud Mode ──────────────────────────────────────
  setCloudMode: (enabled: boolean, dashboardUrl: string, apiKey: string) =>
    invoke<boolean>('set_cloud_mode', { enabled, dashboardUrl, apiKey }),

  refreshRelayEndpoints: () =>
    invoke<RelayEndpoint[]>('refresh_relay_endpoints'),

  getRelayEndpoints: () =>
    invoke<RelayEndpoint[]>('get_relay_endpoints'),

  // ── Subscription Auto-Update ────────────────────────
  getAutoUpdateStatus: () =>
    invoke<AutoUpdateStatus>('get_auto_update_status'),

  setAutoUpdateEnabled: (enabled: boolean) =>
    invoke<void>('set_auto_update_enabled', { enabled }),

  triggerSyncNow: () =>
    invoke<void>('trigger_sync_now'),

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
  }) => invoke<number>('rdp_native_connect', params),

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

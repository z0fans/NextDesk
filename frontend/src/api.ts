import { invoke } from '@tauri-apps/api/core';

export interface RunMode {
  reuse_mode: boolean;
  clash_api: string;
  proxy_port: number;
}

export interface EngineStatus {
  clash: boolean;
  rdp_proxy_port: number;
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

export interface DownloadStatus {
  status: 'idle' | 'downloading' | 'ready' | string;
  progress: number;
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

  checkForUpdate: () =>
    invoke<UpdateInfo>('check_for_update'),

  getDownloadStatus: () =>
    invoke<DownloadStatus>('get_download_status'),

  startDownloadUpdate: () =>
    invoke<boolean>('start_download_update'),

  installUpdate: () =>
    invoke<boolean>('install_update'),

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
};

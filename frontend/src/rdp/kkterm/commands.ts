import { invoke } from '@tauri-apps/api/core';
import type { ConnectionRoute } from '@/api';

export type KktermRdpStartRequest = {
  tabId: string;
  host: string;
  port: number;
  username: string;
  password: string;
  domain?: string;
  desktopWidth?: number;
  desktopHeight?: number;
  remoteResolution?: string;
  redirectDrives?: boolean;
  useMultimon?: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  scaleFactor?: number;
  reuseCloudBinding?: boolean;
};

export type KktermRdpStartResponse = {
  tabId: string;
  sessionId?: string;
  routeLabel: ConnectionRoute;
};

export type KktermRdpClipRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type KktermRdpBoundsRequest = {
  tabId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
  visible: boolean;
  clipRect?: KktermRdpClipRect;
  clipRects?: KktermRdpClipRect[];
};

export type KktermRdpPointerRequest = {
  tabId: string;
  x: number;
  y: number;
  buttonMask: number;
};

export type KktermRdpKeyRequest = {
  tabId: string;
  scancode: number;
  down: boolean;
};

export type KktermRdpTextRequest = {
  tabId: string;
  text: string;
};

export type KktermRdpSimpleRequest = {
  tabId: string;
};

export type CloudBindingKeepaliveRequest = {
  sessionId: string;
  host: string;
  port: number;
};

export type KktermRdpStatusResponse = {
  sessionId: string;
  connectionState: number;
  connected: boolean;
};

export type KktermRdpDisplaySyncResponse = {
  sessionId: string;
  connectionState: number;
  connected: boolean;
  displaySynced: boolean;
  desktopWidth: number;
  desktopHeight: number;
};

export function kktermRdpStart(request: KktermRdpStartRequest) {
  return invoke<KktermRdpStartResponse>('kkterm_rdp_start', { request });
}

export function kktermRdpSetBounds(request: KktermRdpBoundsRequest) {
  return invoke<void>('kkterm_rdp_set_bounds', { request });
}

export function kktermRdpStatus(request: KktermRdpSimpleRequest) {
  return invoke<KktermRdpStatusResponse>('kkterm_rdp_status', { request });
}

export function kktermRdpSyncDisplaySize(request: KktermRdpBoundsRequest) {
  return invoke<KktermRdpDisplaySyncResponse>('kkterm_rdp_sync_display_size', { request });
}

export function kktermRdpPointer(request: KktermRdpPointerRequest) {
  return invoke<void>('kkterm_rdp_pointer', { request });
}

export function kktermRdpKey(request: KktermRdpKeyRequest) {
  return invoke<void>('kkterm_rdp_key', { request });
}

export function kktermRdpText(request: KktermRdpTextRequest) {
  return invoke<void>('kkterm_rdp_text', { request });
}

export function kktermRdpCtrlAltDelete(request: KktermRdpSimpleRequest) {
  return invoke<void>('kkterm_rdp_ctrl_alt_delete', { request });
}

export function kktermRdpSetActiveClipboardSession(tabId: string | null) {
  return invoke<void>('kkterm_rdp_set_active_clipboard_session', { tabId });
}

export function kktermRdpForceClipboardCheck(request: KktermRdpSimpleRequest) {
  return invoke<void>('kkterm_rdp_force_clipboard_check', { request });
}

export function kktermRdpDisconnect(request: KktermRdpSimpleRequest) {
  return invoke<void>('kkterm_rdp_disconnect', { request });
}

export function cloudKeepBindingAlive(request: CloudBindingKeepaliveRequest) {
  return invoke<void>('cloud_keep_binding_alive', request);
}

import { useState, useCallback, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { readText as tauriReadClipboard, writeText as tauriWriteClipboard } from '@tauri-apps/plugin-clipboard-manager';
import { RdpSidebar } from './RdpSidebar';
import { RdpTabBar } from './RdpTabBar';
import { RdpGridView } from './RdpGridView';
import { NewConnectionDialog } from './NewConnectionDialog';
import { RdpConnectionOverlay } from './RdpConnectionOverlay';
import { RdpEmptyState } from './RdpEmptyState';
import { KktermRdpSurface } from '@/rdp/kkterm/KktermRdpSurface';
import {
  kktermRdpCtrlAltDelete,
  kktermRdpDisconnect,
  kktermRdpForceClipboardCheck,
  kktermRdpFollowHostWindow,
  kktermRdpKey,
  kktermRdpSetBounds,
  kktermRdpSetActiveClipboardSession,
  kktermRdpStart,
  kktermRdpStatus,
  kktermRdpSyncDisplaySize,
  kktermRdpText,
  type KktermRdpBoundsRequest,
} from '@/rdp/kkterm/commands';
import { createKktermHostMoveFollower } from '@/rdp/kkterm/hostMoveFollower';
import {
  isKktermWindowsDisplayReady,
  shouldRevealKktermWindowsSurface,
} from '@/rdp/kkterm/windows-display-readiness';
import type { SessionStore } from '@/lib/useSessionStore';
import { Monitor } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { canRecoverKktermWindowsResize } from '@/rdp/kkterm/resize-recovery';
import { recoverGoneCloudBinding } from '@/rdp/cloud-binding-recovery';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n/useTranslation';
import { codeToScancode } from '@/lib/scancodeMap';
import { NativePressedKeyTracker } from '@/lib/native-key-state';

import DecodeWorkerUrl from '@/lib/decode-worker.ts?worker&url';
import { rdpLog } from '@/lib/rdp-logger';
import { api } from '@/api';
import { useNativeRdp, connectFrameWebSocket, type NativeBitmapFrameInfo, type NativeGfxH264Frame } from '@/hooks/useNativeRdp';
import { drawDecodedH264FrameToOverlay } from '@/lib/h264-overlay';
import {
  activeXExtendedDisconnectError,
  friendlyRdpError,
  isNonRecoverableRdpError,
  reconnectingRdpError,
  reconnectFailedRdpError,
} from '@/lib/rdp-errors';
import { captureConnectedTabThumbnails } from '@/lib/rdp-thumbnails';
import type { ViewMode } from '@/lib/rdp-types';
import {
  RDP_FILE_MIME,
  addClipboardFiles,
  buildClipboardDataFromSnapshot,
  cloneAdvertisedClipboardSnapshot,
  cloneClipboardFilePayloads,
  type AdvertisedClipboardSnapshot,
  type ClipboardFilePayload,
} from '@/lib/rdp-clipboard-snapshot';
import {
  isNativeRdpMode,
  isNativeDriftRdpMode,
  isOfficialIronRdpWebMode,
  isKktermCopyRdpMode,
  parseRdpBooleanFlag,
  resolveOfficialWebFeatureFlags,
  resolveRdpEngineMode,
  resolveRdpWasmLogLevel,
  RDP_WASM_LOG_LEVEL_STORAGE_KEY,
} from '@/rdp/engine-flags';
import { GfxSurfaceCompositor } from '@/rdp/gfx-compositor';
import { describeOfficialWebGfxFallback, type OfficialWebGfxFallbackInput } from '@/rdp/gfx-fallback';
import {
  planKktermLocalScaling,
  supportsKktermLocalScaling,
} from '@/rdp/resolution-modes';
import {
  MAX_RECONNECT_ATTEMPTS,
  canRetryReconnect,
  reconnectDelayMs,
} from '@/rdp/reconnect-policy';
import {
  applyIronRdpCliprdrFileCallbacks,
  applyIronRdpDisplayControlExtension,
  applyIronRdpGfxH264Callback,
  applyIronRdpRdpsndAudioCallback,
  applyIronRdpRdpdrDriveSharingExtensions,
  applyIronRdpTextClipboardCallbacks,
} from '@/rdp/ironrdp-web-engine';

/**
 * RDP engine mode.
 * Defaults to native-drift canvas; DevTools/localStorage can switch back to official-web.
 */
const RDP_ENGINE_MODE = resolveRdpEngineMode();
const USE_NATIVE_RDP = isNativeRdpMode(RDP_ENGINE_MODE);
const USE_NATIVE_DRIFT_RDP = isNativeDriftRdpMode(RDP_ENGINE_MODE);
if (USE_NATIVE_RDP) {
  rdpLog.warn(
    'rdp',
    USE_NATIVE_DRIFT_RDP
      ? 'Native RDP engine is running in native-drift canvas mode'
      : 'Native RDP engine is running in experimental mode',
  );
}
const USE_OFFICIAL_IRONRDP_WEB = isOfficialIronRdpWebMode(RDP_ENGINE_MODE);
const USE_KKTERM_COPY_RDP = isKktermCopyRdpMode(RDP_ENGINE_MODE);
const USE_NATIVE_GFX_H264 = USE_NATIVE_RDP;
const OFFICIAL_WEB_FEATURES = resolveOfficialWebFeatureFlags((storageKey, envKey) => {
  if (storageKey) return readRdpRuntimeStorageFlag(storageKey);
  return readRdpRuntimeEnvFlag(envKey);
});
const ADAPTIVE_RESIZE_DEBOUNCE_MS = 800;
const KKTERM_MACOS_ADAPTIVE_RESIZE_DEBOUNCE_MS = 1_800;
const KKTERM_WINDOWS_BOUNDS_THROTTLE_MS = 33;
const ADAPTIVE_RESIZE_THRESHOLD_PX = 20;
const NATIVE_CONNECT_RESIZE_COOLDOWN_MS = 2500;
const PUBLIC_NATIVE_ADAPTIVE_SETTLE_MS = 20_000;
const PUBLIC_NATIVE_ADAPTIVE_RECONNECT_MIN_INTERVAL_MS = 20_000;
const CANVAS_SIZE_DEBUG_LOG_MS = 5000;
const PUBLIC_NATIVE_MAX_DESKTOP_WIDTH = 1920;
const PUBLIC_NATIVE_MAX_DESKTOP_HEIGHT = 1080;
const CLIPBOARD_POLL_INPUT_IDLE_MS = 2000;
const CLOUD_BINDING_KEEPALIVE_INTERVAL_MS = 25_000;
const ENABLE_RDP_FRAME_DIAGNOSTICS = parseRdpBooleanFlag(
  readRdpRuntimeStorageFlag('nextdesk_rdp_frame_diagnostics') ??
  readRdpRuntimeEnvFlag('VITE_NEXTDESK_RDP_FRAME_DIAGNOSTICS'),
  false,
);
const KKTERM_WINDOWS_REDIRECT_DRIVES = parseRdpBooleanFlag(
  readRdpRuntimeStorageFlag('nextdesk_kkterm_redirect_drives') ??
  readRdpRuntimeEnvFlag('VITE_NEXTDESK_KKTERM_REDIRECT_DRIVES'),
  false,
);
const KKTERM_WINDOWS_USE_MULTIMON = parseRdpBooleanFlag(
  readRdpRuntimeStorageFlag('nextdesk_kkterm_use_multimon') ??
  readRdpRuntimeEnvFlag('VITE_NEXTDESK_KKTERM_USE_MULTIMON'),
  false,
);
const ENABLE_KKTERM_WINDOWS_FKEY_QA = import.meta.env.DEV && parseRdpBooleanFlag(
  readRdpRuntimeEnvFlag('VITE_NEXTDESK_KKTERM_QA_FKEYS'),
  false,
);
const KKTERM_WINDOWS_FKEY_SCANCODES = [
  0x003b, 0x003c, 0x003d, 0x003e, 0x003f, 0x0040,
  0x0041, 0x0042, 0x0043, 0x0044, 0x0057, 0x0058,
] as const;

function detectKktermCopyPlatform(): 'windows' | 'macos' | 'other' {
  if (typeof navigator === 'undefined') return 'other';
  const platform = navigator.platform || '';
  const userAgent = navigator.userAgent || '';
  if (/Win/i.test(platform) || /Windows/i.test(userAgent)) return 'windows';
  if (/Mac/i.test(platform) || /Mac OS/i.test(userAgent)) return 'macos';
  return 'other';
}

const KKTERM_COPY_PLATFORM = detectKktermCopyPlatform();
const USE_KKTERM_COPY_MACOS = USE_KKTERM_COPY_RDP && KKTERM_COPY_PLATFORM === 'macos';
const USE_KKTERM_COPY_WINDOWS = USE_KKTERM_COPY_RDP && KKTERM_COPY_PLATFORM === 'windows';

type NativeResizeSize = { w: number; h: number };
type NativeResizePending = NativeResizeSize & { sentAt: number };
type KktermRdpDesktopSize = { width: number; height: number };
type KktermRdpTextSignal = { sequence: number; text: string };
type KktermRdpClipRect = { x: number; y: number; width: number; height: number };
type KktermRdpLayoutBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  rightGap: number;
  bottomGap: number;
};

function waitMs(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForKktermWindowsDisplay(
  attemptId: string,
  tabId: string,
  bounds: KktermRdpBoundsRequest,
  fallbackWidth: number,
  fallbackHeight: number,
) {
  let lastError = '';
  const visibleBounds = { ...bounds, visible: true };
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      const display = await kktermRdpSyncDisplaySize(bounds);
      rdpLog.info('rdp', 'kkterm-rdp ActiveX display sync poll', {
        attemptId,
        tabId,
        attempt,
        connectionState: display.connectionState,
        connected: display.connected,
        extendedDisconnectReason: display.extendedDisconnectReason,
        displaySynced: display.displaySynced,
        surfaceVisible: display.surfaceVisible,
        surfaceOnscreen: display.surfaceOnscreen,
        surfaceReady: display.surfaceReady,
        hostWindowMode: display.hostWindowMode,
        desktopWidth: display.desktopWidth,
        desktopHeight: display.desktopHeight,
      });
      if (shouldRevealKktermWindowsSurface(display)) {
        if (!display.surfaceReady) {
          await kktermRdpSetBounds(visibleBounds);
        }
        const status = display.surfaceReady
          ? display
          : await kktermRdpStatus({ tabId });
        if (isKktermWindowsDisplayReady(status)) {
          return {
            width: display.desktopWidth || fallbackWidth,
            height: display.desktopHeight || fallbackHeight,
          };
        }
        lastError = 'RDP connected, but the Windows native surface is not visible on screen';
      }
      const disconnectError = activeXExtendedDisconnectError(display.extendedDisconnectReason);
      if (display.connectionState === 0 && disconnectError) {
        throw new Error(disconnectError);
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      try {
        const status = await kktermRdpStatus({ tabId });
        rdpLog.info('rdp', 'kkterm-rdp ActiveX status poll', {
          attemptId,
          tabId,
          attempt,
          connectionState: status.connectionState,
          connected: status.connected,
          extendedDisconnectReason: status.extendedDisconnectReason,
          surfaceVisible: status.surfaceVisible,
          surfaceOnscreen: status.surfaceOnscreen,
          surfaceReady: status.surfaceReady,
          hostWindowMode: status.hostWindowMode,
        });
        if (shouldRevealKktermWindowsSurface(status) && !status.surfaceReady) {
          await kktermRdpSetBounds(visibleBounds);
          const revealedStatus = await kktermRdpStatus({ tabId });
          if (isKktermWindowsDisplayReady(revealedStatus)) {
            return { width: fallbackWidth, height: fallbackHeight };
          }
          lastError = 'RDP connected, but the Windows native surface is not visible on screen';
        } else if (isKktermWindowsDisplayReady(status)) {
          return { width: fallbackWidth, height: fallbackHeight };
        }
        const disconnectError = activeXExtendedDisconnectError(status.extendedDisconnectReason);
        if (status.connectionState === 0 && disconnectError) {
          throw new Error(disconnectError);
        }
      } catch (statusError) {
        lastError = statusError instanceof Error ? statusError.message : String(statusError);
      }
      if (isNonRecoverableRdpError(lastError)) {
        throw new Error(lastError);
      }
    }
    await waitMs(500);
  }
  throw new Error(
    lastError
      ? `KKTerm ActiveX display did not become ready: ${lastError}`
      : 'KKTerm ActiveX display did not become ready',
  );
}

function createAttemptId(tabId: string): string {
  const shortTab = tabId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'tab';
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `rdp-${ts}-${shortTab}-${rand}`;
}

function readRdpRuntimeEnvFlag(envKey: string): string | null {
  try {
    return ((import.meta.env as Record<string, string | undefined>)?.[envKey]) ?? null;
  } catch {
    return null;
  }
}

function readRdpRuntimeStorageFlag(storageKey: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

function normalizeNativeDesktopSize(w: number, h: number): { w: number; h: number } {
  const width = Math.max(320, Math.floor(w));
  const height = Math.max(240, Math.floor(h));
  // DisplayControl rejects odd monitor widths and silently rounds down.
  return { w: width % 2 === 0 ? width : width - 1, h: height };
}

function isPrivateOrReservedRdpHost(host?: string): boolean {
  const parts = host?.trim().split('.').map(Number);
  if (!parts || parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function normalizeNativeDesktopSizeForHost(
  w: number,
  h: number,
  host?: string,
): { w: number; h: number; capped: boolean } {
  const normalized = normalizeNativeDesktopSize(w, h);
  if (isPrivateOrReservedRdpHost(host)) {
    return { ...normalized, capped: false };
  }

  const scale = Math.min(
    1,
    PUBLIC_NATIVE_MAX_DESKTOP_WIDTH / normalized.w,
    PUBLIC_NATIVE_MAX_DESKTOP_HEIGHT / normalized.h,
  );
  if (scale >= 1) {
    return { ...normalized, capped: false };
  }

  const capped = normalizeNativeDesktopSize(
    Math.floor(normalized.w * scale),
    Math.floor(normalized.h * scale),
  );
  return { ...capped, capped: true };
}

function canUseNativeDynamicResizeForHost(host?: string): boolean {
  return isPrivateOrReservedRdpHost(host);
}

function resolveOfficialWebVisualQualityForHost(host?: string): 'rich' | 'balanced' {
  // Users expect the remote desktop to match what Windows shows locally.
  // `balanced` disables wallpaper/theming and makes the desktop look black.
  void host;
  return 'rich';
}

function isCanvasActuallyVisible(canvas: HTMLCanvasElement | null | undefined): boolean {
  if (!canvas?.isConnected) return false;
  const style = window.getComputedStyle(canvas);
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
    return false;
  }
  const opacity = Number(style.opacity);
  if (!Number.isNaN(opacity) && opacity <= 0) return false;
  if (canvas.getClientRects().length === 0) return false;
  const rect = canvas.getBoundingClientRect();
  return rect.width >= 1 && rect.height >= 1;
}

// Clipboard debug helper — delegates to rdpLog
function cblog(...args: any[]) {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  rdpLog.info('clipboard', msg);
}

function installRdpConsoleBridge() {
  const key = '__nextdesk_console_bridge_installed__';
  const globalScope = globalThis as typeof globalThis & Record<string, any>;
  if (globalScope[key]) return;
  globalScope[key] = true;

  const noisyPatterns = [
    'FileContentsRequest DATA (async)',
    'Requesting file DATA',
    '[rdpdr-wasm] async read complete',
    'FileContentsRequest: stream_id=',
    'FileContentsRequest DATA response (sync)',
    'FileContentsRequest SIZE response',
    '[cliprdr] active transfers:',
    '[cliprdr] async read done',
    'async read complete:',
    'DATA chunk: file_index=',
  ];

  const shouldForward = (msg: string) => {
    if (noisyPatterns.some(pattern => msg.includes(pattern))) {
      return false;
    }
    return msg.includes('ironrdp_web::')
      || msg.includes('ironrdp_cliprdr')
      || msg.includes('CLIPRDR(')
      || msg.includes('RDPDR')
      || msg.includes('[rdpdr-wasm]');
  };

  // Re-entrancy guard: prevent bridge → rdpLog → console → bridge recursion
  let bridgeActive = false;

  const bridge = (level: 'debug' | 'info' | 'warn' | 'error') => {
    const original = console[level].bind(console);
    console[level] = (...args: any[]) => {
      original(...args);
      if (bridgeActive) return; // skip re-entrant calls from rdpLog
      const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
      if (shouldForward(msg)) {
        bridgeActive = true;
        try {
          rdpLog[level]('rdp', msg);
        } finally {
          bridgeActive = false;
        }
      }
    };
  };

  bridge('debug');
  bridge('info');
  bridge('warn');
  bridge('error');
}

type NormalizedTransferredFile = {
  name: string;
  size: number;
  data: Uint8Array;
};

function readUnknownField(value: any, key: string): any {
  if (!value) return undefined;
  if (value instanceof Map) return value.get(key);
  if (typeof value === 'object' && key in value) return value[key];
  return undefined;
}

function toUint8Array(value: any): Uint8Array | null {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value) && value.every(v => typeof v === 'number')) {
    return new Uint8Array(value);
  }
  return null;
}

function debugPayload(value: any, depth = 0): any {
  if (depth > 2) return '[max-depth]';
  if (value instanceof Uint8Array) return { type: 'Uint8Array', length: value.length };
  if (value instanceof ArrayBuffer) return { type: 'ArrayBuffer', byteLength: value.byteLength };
  if (ArrayBuffer.isView(value)) {
    return {
      type: value.constructor?.name ?? 'TypedArray',
      byteLength: value.byteLength,
    };
  }
  if (value instanceof Map) {
    return {
      type: 'Map',
      entries: Array.from(value.entries()).map(([k, v]) => [k, debugPayload(v, depth + 1)]),
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 5).map(item => debugPayload(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).slice(0, 10).map(([k, v]) => [k, debugPayload(v, depth + 1)]),
    );
  }
  return value;
}

function normalizeTransferredFiles(value: any): NormalizedTransferredFile[] {
  const items = Array.isArray(value) ? value : [];
  const files: NormalizedTransferredFile[] = [];

  for (const item of items) {
    const tuple = Array.isArray(item) ? item : null;
    const rawName = readUnknownField(item, 'name') ?? tuple?.[0];
    const rawSize = readUnknownField(item, 'size') ?? tuple?.[1];
    const rawData = readUnknownField(item, 'data') ?? tuple?.[2];
    const data = toUint8Array(rawData);
    const name = typeof rawName === 'string' && rawName.trim() ? rawName : '';
    const size = typeof rawSize === 'number' && Number.isFinite(rawSize)
      ? rawSize
      : (data?.length ?? 0);

    if (!name || !data) {
      continue;
    }

    files.push({ name, size, data });
  }

  return files;
}

function normalizeFileContentsRequest(value: any) {
  return {
    streamId: readUnknownField(value, 'stream_id') ?? readUnknownField(value, 'streamId'),
    index: readUnknownField(value, 'index'),
    flags: readUnknownField(value, 'flags'),
    position: readUnknownField(value, 'position'),
    requestedSize: readUnknownField(value, 'requested_size') ?? readUnknownField(value, 'requestedSize'),
    dataId: readUnknownField(value, 'data_id') ?? readUnknownField(value, 'dataId'),
  };
}

// ── WASM types ──
interface IronRdpWasm {
  default: (input?: any) => Promise<any>;
  setup: (logLevel: string) => void;
  SessionBuilder: new () => SessionBuilder;
  Extension: new (ident: string, value: any) => any;
  DesktopSize: new (w: number, h: number) => any;
  ClipboardData: new () => WasmClipboardData;
  DeviceEvent: {
    keyPressed: (sc: number) => any;
    keyReleased: (sc: number) => any;
    mouseButtonPressed: (b: number) => any;
    mouseButtonReleased: (b: number) => any;
    mouseMove: (x: number, y: number) => any;
    unicodePressed: (ch: string) => any;
    unicodeReleased: (ch: string) => any;
    wheelRotations: (vertical: boolean, amount: number, unit: number) => any;
  };
  InputTransaction: new () => { addEvent: (e: any) => void };
}
interface WasmClipboardData {
  addText(mimeType: string, text: string): void;
  addBinary(mimeType: string, data: Uint8Array): void;
  isEmpty(): boolean;
  items(): { mimeType(): string; value(): any }[];
  free(): void;
}
interface SessionBuilder {
  proxyAddress(a: string): SessionBuilder;
  authToken(t: string): SessionBuilder;
  renderCanvas(c: HTMLCanvasElement): SessionBuilder;
  username(u: string): SessionBuilder;
  password(p: string): SessionBuilder;
  destination(d: string): SessionBuilder;
  serverDomain(d: string): SessionBuilder;
  desktopSize(s: any): SessionBuilder;
  extension(ext: any): SessionBuilder;
  setCursorStyleCallback(cb: Function): SessionBuilder;
  setCursorStyleCallbackContext(ctx: any): SessionBuilder;
  canvasResizedCallback(cb: Function): SessionBuilder;
  remoteClipboardChangedCallback(cb: Function): SessionBuilder;
  forceClipboardUpdateCallback(cb: Function): SessionBuilder;
  fileContentsRequestCallback(cb: Function): SessionBuilder;
  fileContentsResponseCallback(cb: Function): SessionBuilder;
  fileChunkCallback(cb: Function): SessionBuilder;
  connect(): Promise<WasmSession>;
}
interface WasmSession {
  run(): Promise<any>;
  applyInputs(t: any): void;
  desktopSize(): { width: number; height: number };
  invokeExtension(ext: any): any;
  resize(w: number, h: number, scale_factor?: number | null, physical_width?: number | null, physical_height?: number | null): void;
  onClipboardPaste(content: WasmClipboardData): Promise<void>;
  shutdown(): void;
  releaseAllInputs(): void;
  supportsUnicodeKeyboardShortcuts(): boolean;
  synchronizeLockKeys(scroll_lock: boolean, num_lock: boolean, caps_lock: boolean, kana_lock: boolean): void;
}

let wasmModule: IronRdpWasm | null = null;
let wasmReady = false;
async function loadWasm(): Promise<IronRdpWasm> {
  if (wasmModule && wasmReady) return wasmModule;
  const mod = await import('../wasm/ironrdp_web.js');
  const url = new URL('../wasm/ironrdp_web_bg.wasm', import.meta.url).href;
  await mod.default(url);
  mod.setup(resolveRdpWasmLogLevel({
    isDev: import.meta.env.DEV,
    storageValue: readRdpRuntimeStorageFlag(RDP_WASM_LOG_LEVEL_STORAGE_KEY),
    envValue: readRdpRuntimeEnvFlag('VITE_NEXTDESK_RDP_WASM_LOG_LEVEL'),
  }));
  wasmModule = mod as unknown as IronRdpWasm;
  wasmReady = true;
  return wasmModule;
}

export function RdpManager({
  onMainSidebarCollapse,
  isRdpViewVisible = true,
  store,
}: {
  onMainSidebarCollapse?: () => void;
  isRdpViewVisible?: boolean;
  store: SessionStore;
}) {
  const { t } = useTranslation();
  const [rdpStats, setRdpStats] = useState({ resolution: '', fps: 0, status: 'idle' as string });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [driveRedirectionEnabled, setDriveRedirectionEnabled] = useState(KKTERM_WINDOWS_REDIRECT_DRIVES);
  const [multiMonitorEnabled, setMultiMonitorEnabled] = useState(KKTERM_WINDOWS_USE_MULTIMON);
  const [kktermRdpCadSignalByTab, setKktermRdpCadSignalByTab] = useState<Record<string, number>>({});
  const [kktermRdpTextSignalByTab, setKktermRdpTextSignalByTab] = useState<Record<string, KktermRdpTextSignal>>({});
  const [kktermRdpWinSignalByTab, setKktermRdpWinSignalByTab] = useState<Record<string, number>>({});
  const [kktermRdpLaunch, setKktermRdpLaunch] = useState<Record<string, {
    nonce: number;
    desktopSize: KktermRdpDesktopSize;
    reuseCloudBinding: boolean;
  }>>({});
  const [kktermOverlayBackdropRects, setKktermOverlayBackdropRects] = useState<Record<string, KktermRdpClipRect>>({});
  const [hasClipboardFolder, setHasClipboardFolder] = useState(false);
  const [macClipboardStrategy, setMacClipboardStrategy] = useState<'session-file-url' | 'pasteboard-promise'>('session-file-url');
  const fpsCountRef = useRef(0);
  const fpsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fpsTabIdRef = useRef<string | null>(null);
  const nativeResolutionByTabRef = useRef<Map<string, string>>(new Map());
  const nativeActualSizeByTabRef = useRef<Map<string, NativeResizeSize>>(new Map());
  const nativeResizePendingByTabRef = useRef<Map<string, NativeResizePending>>(new Map());
  const nativeConnectedAtByTabRef = useRef<Map<string, number>>(new Map());
  const nativePublicAdaptiveReconnectAtRef = useRef<Map<string, number>>(new Map());
  const canvasSizeLogRef = useRef({ w: 0, h: 0, loggedAt: 0 });
  // Resolution mode: 'adaptive' or '1920x1080' etc.
  const RESOLUTION_PRESETS = [
    { label: t('rdpAuto'), value: 'adaptive' },
    ...(USE_KKTERM_COPY_RDP && supportsKktermLocalScaling(KKTERM_COPY_PLATFORM)
      ? [{ label: t('rdpLocalScaling'), value: 'smartSizing' }]
      : []),
    { label: '1920×1080', value: '1920x1080' },
    { label: '1600×900', value: '1600x900' },
    { label: '1440×900', value: '1440x900' },
    { label: '1366×768', value: '1366x768' },
    { label: '1280×720', value: '1280x720' },
  ] as const;
  const [resMode, setResMode] = useState('adaptive');
  const resModeRef = useRef('adaptive');
  resModeRef.current = resMode;
  const [showNewConn, setShowNewConn] = useState(false);
  const [editServerId, setEditServerId] = useState<string | null>(null);
  const [proxyPort, setProxyPort] = useState(0);

  useEffect(() => {
    const handleNewConnectionRequest = () => {
      setEditServerId(null);
      setShowNewConn(true);
    };

    window.addEventListener('nextdesk-new-connection', handleNewConnectionRequest);
    return () => window.removeEventListener('nextdesk-new-connection', handleNewConnectionRequest);
  }, []);




  const canvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const sessionRefs = useRef<Map<string, WasmSession>>(new Map());

  // H.264 GFX path: Worker-based VideoDecoder + per-tab overlay canvas.
  // The overlay canvas uses a 2D context (separate from the WASM WebGL2 canvas)
  // to display decoded VideoFrames without context-type conflicts.
  const decodeWorkerRef = useRef<Worker | null>(null);
  const h264OverlayRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const gfxCompositorRefs = useRef<Map<string, GfxSurfaceCompositor>>(new Map());
  const officialWebGfxDisabledByFallbackRef = useRef<Set<string>>(new Set());
  const officialWebGfxFallbackInFlightRef = useRef<Set<string>>(new Set());
  const officialWebH264FrameCountRef = useRef<Map<string, number>>(new Map());
  const officialWebClearCodecPatchCountRef = useRef<Map<string, number>>(new Map());

  const cleanupH264Worker = useCallback((tabId?: string) => {
    if (decodeWorkerRef.current) {
      decodeWorkerRef.current.postMessage({ type: 'close' });
      decodeWorkerRef.current.terminate();
      decodeWorkerRef.current = null;
    }
    if (tabId) {
      const overlay = h264OverlayRefs.current.get(tabId);
      if (overlay) overlay.style.opacity = '0';
      gfxCompositorRefs.current.delete(tabId);
    }
  }, []);

  const ensureH264Worker = useCallback((tabId: string): Worker | null => {
    if (typeof VideoDecoder === 'undefined') {
      rdpLog.warn('display', 'WebCodecs not available, native GFX H.264 disabled');
      return null;
    }
    if (decodeWorkerRef.current) return decodeWorkerRef.current;

    try {
      const worker = new Worker(DecodeWorkerUrl, { type: 'module' });
      decodeWorkerRef.current = worker;
      worker.postMessage({ type: 'configure', codec: 'avc1.64001f' });

      worker.onmessage = (e: MessageEvent) => {
        const msg = e.data;
        if (msg.type === 'frame') {
          const frame = msg.frame as VideoFrame;
          const compositor = gfxCompositorRefs.current.get(tabId);
          if (compositor && msg.rect) {
            compositor.drawVideoFrame(Number(msg.surfaceId ?? 0), frame, msg.rect);
          } else {
            const overlay = h264OverlayRefs.current.get(tabId);
            if (overlay) {
              drawDecodedH264FrameToOverlay(overlay, frame, msg.rect);
            }
          }
          frame.close();
        } else if (msg.type === 'error') {
          rdpLog.warn('display', 'h264 worker error', { message: msg.message });
        }
      };

      return worker;
    } catch (e) {
      rdpLog.warn('display', 'Worker creation failed, native GFX H.264 disabled', { error: String(e) });
      decodeWorkerRef.current = null;
      return null;
    }
  }, []);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const nativeViewBoundsRafRef = useRef<number | null>(null);
  const nativeViewLastBoundsRef = useRef<string>('');
  const kktermViewBoundsRafRef = useRef<number | null>(null);
  const kktermViewBoundsThrottleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const kktermScaleDisplaySyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const kktermViewBoundsPendingReasonRef = useRef('state');
  const kktermViewBoundsLastSyncAtRef = useRef(0);
  const kktermViewLastBoundsByTabRef = useRef<Map<string, string>>(new Map());
  const kktermOverlayClipRectsRef = useRef<Map<string, KktermRdpClipRect>>(new Map());
  const kktermPostConnectSettleTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>[]>>(new Map());
  const kktermResizeRecoveryAtRef = useRef<Map<string, number>>(new Map());
  const isRdpViewVisibleRef = useRef(isRdpViewVisible);
  const activeTabIdRef = useRef<string | null>(null);
  const tabsRef = useRef(store.tabs);
  const lastSizeRef = useRef({ w: 0, h: 0 });
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const performAdaptiveResizeRef = useRef<(reason: string) => void>(() => undefined);
  const resizeCooldownRef = useRef(false); // suppress adaptive resize after connect
  const driveRedirectionEnabledRef = useRef(KKTERM_WINDOWS_REDIRECT_DRIVES);
  const multiMonitorEnabledRef = useRef(KKTERM_WINDOWS_USE_MULTIMON);
  // When user picks a fixed resolution, store it here for reconnect
  const desiredSizeRef = useRef<{ w: number; h: number } | null>(null);
  const connectSessionRef = useRef<(tabId: string) => void>(null);
  // Auto-reconnect state
  const reconnectCountRef = useRef<Map<string, number>>(new Map());
  const reconnectTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const userDisconnectedRef = useRef<Set<string>>(new Set());
  const connectingTabsRef = useRef<Set<string>>(new Set());
  const advertisedClipboardRef = useRef<Map<string, AdvertisedClipboardSnapshot>>(new Map());
  const forceClipboardReadInFlightRef = useRef<Set<string>>(new Set());
  const rdpdrEnabledRef = useRef<Set<string>>(new Set());
  const pasteShortcutInFlightRef = useRef<Set<string>>(new Set());
  const keepCursorVisibleUntilRef = useRef<Map<string, number>>(new Map());

  const fileTransferInProgressRef = useRef<Set<string>>(new Set());
  const clipboardPollInFlightRef = useRef<Set<string>>(new Set());
  const lastRdpInputAtRef = useRef<Map<string, number>>(new Map());
  const lastNativeClipboardForceAtRef = useRef<Map<string, number>>(new Map());
  // Track file keys received from remote to prevent feedback loop:
  // remote download → write to clipboard → Poll/Focus detects → sends FormatList back
  const remoteClipboardFileKeyRef = useRef<Map<string, string>>(new Map());
  const sendWinKeyRef = useRef<(() => void) | null>(null);
  const sendCtrlAltDelRef = useRef<(() => void) | null>(null);
  const sendClipboardTextRef = useRef<(() => void) | null>(null);
  const prevSidebarOpenRef = useRef(store.sidebarOpen);
  isRdpViewVisibleRef.current = isRdpViewVisible;
  activeTabIdRef.current = store.activeTabId;
  tabsRef.current = store.tabs;

  // Ref to track which tabs are connected via native backend
  const nativeTabsRef = useRef<Set<string>>(new Set());
  const nativeRouteLeaseIdsRef = useRef<Map<string, number>>(new Map());
  const cloudKeepaliveTimersRef = useRef<Map<string, ReturnType<typeof window.setInterval>>>(new Map());
  const cloudKeepaliveGenerationRef = useRef<Map<string, number>>(new Map());
  const cloudBindingRecoveryTabsRef = useRef<Set<string>>(new Set());
  const cloudBindingRecoveryRef = useRef<(tabId: string) => void>(() => undefined);

  const stopCloudKeepalive = useCallback((tabId: string) => {
    cloudKeepaliveGenerationRef.current.set(
      tabId,
      (cloudKeepaliveGenerationRef.current.get(tabId) ?? 0) + 1,
    );
    const timer = cloudKeepaliveTimersRef.current.get(tabId);
    if (timer !== undefined) {
      window.clearInterval(timer);
      cloudKeepaliveTimersRef.current.delete(tabId);
    }
  }, []);

  const startCloudKeepalive = useCallback((tabId: string, host: string, port: number) => {
    stopCloudKeepalive(tabId);
    cloudBindingRecoveryTabsRef.current.delete(tabId);
    const generation = (cloudKeepaliveGenerationRef.current.get(tabId) ?? 0) + 1;
    cloudKeepaliveGenerationRef.current.set(tabId, generation);
    const renew = () => {
      void api.cloudKeepBindingAlive(tabId, host, port).catch(error => {
        if (cloudKeepaliveGenerationRef.current.get(tabId) !== generation) return;
        rdpLog.warn('cloud', 'binding keepalive failed', {
          tabId,
          host,
          port,
          error: error instanceof Error ? error.message : String(error),
        });
        if (cloudBindingRecoveryTabsRef.current.has(tabId)) return;
        recoverGoneCloudBinding(error, {
          stopKeepalive: () => stopCloudKeepalive(tabId),
          replaceRoute: () => {
            if (userDisconnectedRef.current.has(tabId)) return;
            cloudBindingRecoveryTabsRef.current.add(tabId);
            rdpLog.warn('cloud', 'binding invalidated; replacing cloud route', { tabId, host, port });
            cloudBindingRecoveryRef.current(tabId);
          },
        });
      });
    };
    renew();
    cloudKeepaliveTimersRef.current.set(
      tabId,
      window.setInterval(renew, CLOUD_BINDING_KEEPALIVE_INTERVAL_MS),
    );
  }, [stopCloudKeepalive]);

  useEffect(() => () => {
    for (const timer of cloudKeepaliveTimersRef.current.values()) {
      window.clearInterval(timer);
    }
    cloudKeepaliveTimersRef.current.clear();
    cloudKeepaliveGenerationRef.current.clear();
  }, []);
  const kktermTabsRef = useRef<Set<string>>(new Set());
  const kktermRouteLeaseIdsRef = useRef<Map<string, number>>(new Map());
  const attemptIdsRef = useRef<Map<string, string>>(new Map());
  const nativeFrameCleanupByTabRef = useRef<Map<string, () => void>>(new Map());

  const isNativeTabRenderable = useCallback((tabId: string, canvas?: HTMLCanvasElement | null) => {
    if (!isRdpViewVisibleRef.current) return false;
    return isCanvasActuallyVisible(canvas ?? canvasRefs.current.get(tabId));
  }, []);

  const stopFpsCounter = useCallback((tabId?: string) => {
    if (tabId && fpsTabIdRef.current && fpsTabIdRef.current !== tabId) return;
    if (fpsIntervalRef.current) {
      clearInterval(fpsIntervalRef.current);
      fpsIntervalRef.current = null;
    }
    fpsTabIdRef.current = null;
    fpsCountRef.current = 0;
  }, []);

  const cleanupNativeFrameStream = useCallback((tabId: string) => {
    const cleanup = nativeFrameCleanupByTabRef.current.get(tabId);
    if (!cleanup) return;
    nativeFrameCleanupByTabRef.current.delete(tabId);
    try {
      cleanup();
    } catch (error) {
      rdpLog.warn('display', 'native frame websocket cleanup failed', {
        tabId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const startNativeFpsCounter = useCallback((tabId: string) => {
    if (!ENABLE_RDP_FRAME_DIAGNOSTICS) return;
    stopFpsCounter();
    fpsTabIdRef.current = tabId;
    fpsCountRef.current = 0;
    fpsIntervalRef.current = setInterval(() => {
      const fps = fpsCountRef.current;
      fpsCountRef.current = 0;
      if (fpsTabIdRef.current !== tabId) return;
      if (!nativeTabsRef.current.has(tabId)) return;
      if (!isNativeTabRenderable(tabId)) return;
      setRdpStats(prev => (prev.fps === fps ? prev : { ...prev, fps }));
    }, 1000);
  }, [isNativeTabRenderable, stopFpsCounter]);

  const startOfficialWebFpsCounter = useCallback((tabId: string, canvas: HTMLCanvasElement) => {
    if (!ENABLE_RDP_FRAME_DIAGNOSTICS) return;

    stopFpsCounter();
    const gl = canvas.getContext('webgl2');
    if (gl && !(gl as any).__nextdesk_patched) {
      const origTexSubImage2D = gl.texSubImage2D.bind(gl);
      gl.texSubImage2D = function (...args: any[]) {
        (globalThis as any).__nextdesk_fps_count = ((globalThis as any).__nextdesk_fps_count || 0) + 1;
        return (origTexSubImage2D as any)(...args);
      } as any;
      (gl as any).__nextdesk_patched = true;
    }

    (globalThis as any).__nextdesk_fps_count = 0;
    fpsTabIdRef.current = tabId;
    fpsIntervalRef.current = setInterval(() => {
      const fps = (globalThis as any).__nextdesk_fps_count || 0;
      (globalThis as any).__nextdesk_fps_count = 0;
      if (fpsTabIdRef.current !== tabId) return;
      setRdpStats(prev => (prev.fps === fps ? prev : { ...prev, fps }));
    }, 1000);
  }, [stopFpsCounter]);

  const forgetNativeResizeState = useCallback((tabId: string) => {
    nativeResolutionByTabRef.current.delete(tabId);
    nativeActualSizeByTabRef.current.delete(tabId);
    nativeResizePendingByTabRef.current.delete(tabId);
    nativeConnectedAtByTabRef.current.delete(tabId);
    nativePublicAdaptiveReconnectAtRef.current.delete(tabId);
    lastNativeClipboardForceAtRef.current.delete(tabId);
  }, []);

  const updateNativeResolution = useCallback((tabId: string, w: number, h: number, source: string) => {
    if (w <= 0 || h <= 0) return;
    nativeActualSizeByTabRef.current.set(tabId, { w, h });
    const resolution = `${w}×${h}`;
    if (nativeResolutionByTabRef.current.get(tabId) === resolution) return;
    nativeResolutionByTabRef.current.set(tabId, resolution);
    if (!isNativeTabRenderable(tabId)) return;
    rdpLog.info('display', `native resolution updated (${source}): ${w} x ${h}`);
    setRdpStats(prev => (prev.resolution === resolution ? prev : { ...prev, resolution }));
  }, [isNativeTabRenderable]);

  const markNativeTabConnected = useCallback((tabId: string, source: string) => {
    const current = tabsRef.current.find(t => t.id === tabId);
    if (current?.status !== 'connected' || !nativeTabsRef.current.has(tabId)) {
      rdpLog.info('rdp', 'mark native tab connected', { tabId, source });
    }
    store.updateTabStatus(tabId, 'connected');
    reconnectCountRef.current.delete(tabId);
    setRdpStats(prev => ({ ...prev, status: 'connected' }));
    nativeTabsRef.current.add(tabId);
    nativeConnectedAtByTabRef.current.set(tabId, Date.now());
    resizeCooldownRef.current = true;
    setTimeout(() => {
      if (activeTabIdRef.current === tabId) {
        const wrap = canvasWrapRef.current;
        if (wrap) {
          const rect = wrap.getBoundingClientRect();
          const w = Math.floor(rect.width || wrap.clientWidth);
          const h = Math.floor(rect.height || wrap.clientHeight);
          const tab = tabsRef.current.find(t => t.id === tabId);
          const server = tab ? store.getServerById(tab.serverId) : null;
          if (w > 0 && h > 0) lastSizeRef.current = normalizeNativeDesktopSizeForHost(w, h, server?.host);
        }
      }
      resizeCooldownRef.current = false;
    }, NATIVE_CONNECT_RESIZE_COOLDOWN_MS);
  }, [store]);

  const scheduleReconnect = useCallback((tabId: string, reason: string) => {
    if (userDisconnectedRef.current.has(tabId)) {
      return;
    }
    if (reconnectTimerRef.current.has(tabId)) {
      return;
    }
    const count = (reconnectCountRef.current.get(tabId) || 0) + 1;
    if (!canRetryReconnect(count)) {
      reconnectCountRef.current.delete(tabId);
      rdpLog.warn('rdp', `reconnect: gave up after ${MAX_RECONNECT_ATTEMPTS} attempts`, {
        tabId,
        reason,
      });
      store.updateTabStatus(
        tabId,
        'error',
        reconnectFailedRdpError(reason, MAX_RECONNECT_ATTEMPTS, t),
      );
      return;
    }
    reconnectCountRef.current.set(tabId, count);
    const delay = reconnectDelayMs(count);
    rdpLog.info('rdp', `reconnect #${count}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`, {
      tabId,
      reason,
    });
    store.updateTabStatus(
      tabId,
      'reconnecting',
      reconnectingRdpError(reason, count, MAX_RECONNECT_ATTEMPTS, t),
    );

    const timer = setTimeout(() => {
      reconnectTimerRef.current.delete(tabId);
      const tab = tabsRef.current.find(item => item.id === tabId);
      if (!tab || userDisconnectedRef.current.has(tabId)) {
        reconnectCountRef.current.delete(tabId);
        return;
      }
      connectSessionRef.current?.(tabId);
    }, delay);
    reconnectTimerRef.current.set(tabId, timer);
  }, [store, t]);

  const markKktermTabConnected = useCallback((tabId: string, width?: number, height?: number) => {
    kktermTabsRef.current.add(tabId);
    connectingTabsRef.current.delete(tabId);
    const reconnectTimer = reconnectTimerRef.current.get(tabId);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimerRef.current.delete(tabId);
    }
    reconnectCountRef.current.delete(tabId);
    rdpLog.info('rdp', 'kkterm-rdp connected', { tabId, width, height });
    store.updateTabStatus(tabId, 'connected');
    setRdpStats(prev => ({
      ...prev,
      resolution: width && height ? `${width}×${height}` : prev.resolution,
      status: 'connected',
    }));
    if (width && height) {
      lastSizeRef.current = { w: width, h: height };
    }
  }, [store]);

  const handleKktermDisconnected = useCallback((tabId: string) => {
    const userDisconnected = userDisconnectedRef.current.has(tabId);
    rdpLog.warn('rdp', 'kkterm-rdp disconnected', { tabId, userDisconnected });
    connectingTabsRef.current.delete(tabId);
    kktermTabsRef.current.delete(tabId);
    kktermViewLastBoundsByTabRef.current.delete(tabId);
    stopFpsCounter(tabId);
    if (userDisconnected) {
      store.updateTabStatus(tabId, 'disconnected');
      return;
    }
    scheduleReconnect(tabId, 'disconnected');
  }, [scheduleReconnect, store, stopFpsCounter]);

  const handleKktermError = useCallback((tabId: string, message: string) => {
    rdpLog.error('rdp', 'kkterm-rdp error', { tabId, message });
    connectingTabsRef.current.delete(tabId);
    kktermTabsRef.current.delete(tabId);
    kktermViewLastBoundsByTabRef.current.delete(tabId);
    stopFpsCounter(tabId);
    if (!userDisconnectedRef.current.has(tabId) && !isNonRecoverableRdpError(message)) {
      scheduleReconnect(tabId, message);
      return;
    }
    store.updateTabStatus(tabId, 'error', friendlyRdpError(message, t));
    setRdpStats(prev => ({ ...prev, status: 'error' }));
  }, [scheduleReconnect, store, stopFpsCounter, t]);

  const handleKktermCanvasRef = useCallback((tabId: string, canvas: HTMLCanvasElement | null) => {
    if (canvas) {
      canvasRefs.current.set(tabId, canvas);
    } else {
      canvasRefs.current.delete(tabId);
    }
  }, []);

  const waitForCanvas = useCallback(async (tabId: string): Promise<HTMLCanvasElement | null> => {
    for (let frame = 0; frame < 12; frame += 1) {
      const canvas = canvasRefs.current.get(tabId);
      if (canvas) return canvas;
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
    return canvasRefs.current.get(tabId) ?? null;
  }, []);

  // ── Native RDP event rendering hook ──
  // Only active when USE_NATIVE_RDP is enabled
  const activeCanvas = store.activeTabId
    ? canvasRefs.current.get(store.activeTabId) ?? null
    : null;

  const handleNativeStatus = useCallback((tabId: string, status: string, message?: string) => {
    rdpLog.info('rdp', `status event: ${status}`, { tabId, message });
    if (status === 'connected') {
      markNativeTabConnected(tabId, 'status-event');
    } else if (status === 'disconnected') {
      nativeTabsRef.current.delete(tabId);
      cleanupNativeFrameStream(tabId);
      forgetNativeResizeState(tabId);
      stopFpsCounter(tabId);
      cleanupH264Worker(tabId);
      if (userDisconnectedRef.current.has(tabId)) {
        store.updateTabStatus(tabId, 'disconnected');
      } else {
        if (isNonRecoverableRdpError(message ?? '')) {
          reconnectCountRef.current.delete(tabId);
          rdpLog.warn('rdp', 'non-recoverable disconnect; auto-reconnect suppressed', {
            tabId,
            message,
          });
          store.updateTabStatus(tabId, 'error', friendlyRdpError(message ?? '', t));
          return;
        }

        scheduleReconnect(tabId, message ?? 'disconnected');
      }
    } else if (status === 'error') {
      nativeTabsRef.current.delete(tabId);
      cleanupNativeFrameStream(tabId);
      forgetNativeResizeState(tabId);
      stopFpsCounter(tabId);
      cleanupH264Worker(tabId);
      rdpLog.error('rdp', `session error: ${message}`, { tabId });
      if (userDisconnectedRef.current.has(tabId)) {
        store.updateTabStatus(tabId, 'disconnected');
      } else if (isNonRecoverableRdpError(message ?? '')) {
        reconnectCountRef.current.delete(tabId);
        store.updateTabStatus(tabId, 'error', friendlyRdpError(message ?? '', t));
      } else {
        scheduleReconnect(tabId, message ?? 'native session error');
      }
    }
  }, [store, cleanupH264Worker, cleanupNativeFrameStream, forgetNativeResizeState, markNativeTabConnected, scheduleReconnect, stopFpsCounter, t]);

  useNativeRdp({
    tabId: USE_NATIVE_RDP ? store.activeTabId : null,
    canvas: USE_NATIVE_RDP ? activeCanvas : null,
    onStatus: handleNativeStatus,
  });

  useEffect(() => {
    installRdpConsoleBridge();
    if (USE_KKTERM_COPY_RDP) {
      setProxyPort(0);
    } else {
      invoke<number>('get_rdp_proxy_port')
        .then(port => {
          setProxyPort(port > 0 ? port : 0);
        })
        .catch(error => {
          setProxyPort(0);
          rdpLog.error('rdp', 'rdp proxy port unavailable', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      loadWasm().catch(() => { });
    }
    invoke<'session-file-url' | 'pasteboard-promise'>('get_mac_clipboard_strategy')
      .then(setMacClipboardStrategy)
      .catch(() => {});
  }, []);

  useEffect(() => {
    return () => {
      for (const [tabId, cleanup] of nativeFrameCleanupByTabRef.current.entries()) {
        try {
          cleanup();
        } catch (error) {
          rdpLog.warn('display', 'native frame websocket cleanup failed during unmount', {
            tabId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      nativeFrameCleanupByTabRef.current.clear();
      for (const tabId of kktermTabsRef.current) {
        kktermRdpDisconnect({
          tabId,
          routeLeaseId: kktermRouteLeaseIdsRef.current.get(tabId),
        }).catch(() => {});
      }
      kktermTabsRef.current.clear();
      kktermRouteLeaseIdsRef.current.clear();
      kktermViewLastBoundsByTabRef.current.clear();
      kktermOverlayClipRectsRef.current.clear();
      kktermPostConnectSettleTimersRef.current.forEach(timers => {
        timers.forEach(timer => clearTimeout(timer));
      });
      kktermPostConnectSettleTimersRef.current.clear();
    };
  }, []);

  // ── Network change detection: trigger reconnect when browser comes back online ──
  useEffect(() => {
    const handleOnline = () => {
      rdpLog.info('network', 'online — checking for disconnected tabs');
      for (const tab of store.tabs) {
        if ((tab.status === 'reconnecting' || tab.status === 'disconnected') && !userDisconnectedRef.current.has(tab.id)) {
          // Cancel existing timer and try immediately
          const existing = reconnectTimerRef.current.get(tab.id);
          if (existing) { clearTimeout(existing); reconnectTimerRef.current.delete(tab.id); }
          reconnectCountRef.current.set(tab.id, 0); // Reset count
          rdpLog.info('network', 'restored, reconnecting tab', { tabId: tab.id });
          if (connectSessionRef.current) connectSessionRef.current(tab.id);
        }
      }
    };
    const handleOffline = () => {
      rdpLog.warn('network', 'offline');
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [store.tabs]);

  useEffect(() => {
    const tabId = store.activeTabId;
    if (!tabId) {
      setHasClipboardFolder(false);
      return;
    }

    invoke<{ staged_paths: string[] } | null>('get_session_clipboard_state', { sessionId: tabId })
      .then(state => {
        setHasClipboardFolder(Boolean(state?.staged_paths?.length));
      })
      .catch(() => {
        setHasClipboardFolder(false);
      });
  }, [store.activeTabId, store.tabs.length]);

  // ── Helper: get canvas dimensions from wrapper div ──
  const getCanvasSize = useCallback(() => {
    const wrap = canvasWrapRef.current;
    if (!wrap) return { w: 1280, h: 720 };
    const rect = wrap.getBoundingClientRect();
    const w = Math.floor(rect.width || wrap.clientWidth);
    const h = Math.floor(rect.height || wrap.clientHeight);
    const now = performance.now();
    const last = canvasSizeLogRef.current;
    if (w !== last.w || h !== last.h || now - last.loggedAt >= CANVAS_SIZE_DEBUG_LOG_MS) {
      canvasSizeLogRef.current = { w, h, loggedAt: now };
      rdpLog.debug('display', `getCanvasSize: ${w} x ${h}`);
    }
    if ((w <= 0 || h <= 0) && lastSizeRef.current.w > 0 && lastSizeRef.current.h > 0) {
      rdpLog.warn('display', 'getCanvasSize returned empty layout; using last known size', {
        raw: { w, h },
        fallback: lastSizeRef.current,
      });
      return { ...lastSizeRef.current };
    }
    return { w: Math.max(w, 320), h: Math.max(h, 240) };
  }, []);

  const readKktermRdpLayoutBounds = useCallback((): KktermRdpLayoutBounds | null => {
    const wrap = canvasWrapRef.current;
    if (!wrap) return null;
    const rect = wrap.getBoundingClientRect();
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      rightGap: Math.abs(viewportWidth - rect.right),
      bottomGap: Math.abs(viewportHeight - rect.bottom),
    };
  }, []);

  const waitForKktermWindowsLayoutReady = useCallback(async (
    attemptId: string,
    tabId: string,
  ): Promise<KktermRdpLayoutBounds | null> => {
    const startedAt = performance.now();
    let lastKey = '';
    let stableSince = startedAt;
    let latest: KktermRdpLayoutBounds | null = null;

    for (let frame = 0; frame < 90; frame += 1) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const bounds = readKktermRdpLayoutBounds();
      if (!bounds) continue;

      latest = bounds;
      const key = `${Math.round(bounds.x)}:${Math.round(bounds.y)}:${Math.round(bounds.width)}:${Math.round(bounds.height)}:${Math.round(bounds.rightGap)}:${Math.round(bounds.bottomGap)}`;
      const now = performance.now();
      if (key !== lastKey) {
        lastKey = key;
        stableSince = now;
        rdpLog.debug('rdp', 'kkterm.rdp.layout.observed', {
          attemptId,
          tabId,
          frame,
          x: Math.round(bounds.x),
          y: Math.round(bounds.y),
          width: Math.round(bounds.width),
          height: Math.round(bounds.height),
          rightGap: Math.round(bounds.rightGap),
          bottomGap: Math.round(bounds.bottomGap),
        });
      }

      const sizeReady = bounds.width >= 320 && bounds.height >= 240;
      const fillsRightEdge = bounds.rightGap <= 2;
      const stableForMs = now - stableSince;
      if (sizeReady && fillsRightEdge && stableForMs >= 48) {
        rdpLog.info('rdp', 'kkterm.rdp.layout.ready', {
          attemptId,
          tabId,
          frame,
          waitMs: Math.round(now - startedAt),
          width: Math.round(bounds.width),
          height: Math.round(bounds.height),
          rightGap: Math.round(bounds.rightGap),
          bottomGap: Math.round(bounds.bottomGap),
        });
        return bounds;
      }
    }

    if (latest) {
      rdpLog.warn('rdp', 'kkterm.rdp.layout.ready timeout; using latest bounds', {
        attemptId,
        tabId,
        waitMs: Math.round(performance.now() - startedAt),
        width: Math.round(latest.width),
        height: Math.round(latest.height),
        rightGap: Math.round(latest.rightGap),
        bottomGap: Math.round(latest.bottomGap),
      });
    }
    return latest;
  }, [readKktermRdpLayoutBounds]);

  const selectKktermRdpDesktopSize = useCallback((attemptId: string, tabId: string): KktermRdpDesktopSize => {
    const selected = desiredSizeRef.current
      ? { source: 'desired', w: desiredSizeRef.current.w, h: desiredSizeRef.current.h }
      : { source: 'wrapper', ...getCanvasSize() };
    const width = Math.max(320, Math.round(selected.w));
    const height = Math.max(240, Math.round(selected.h));
    rdpLog.info('rdp', 'kkterm.rdp.size.selected', {
      attemptId,
      tabId,
      source: selected.source,
      width,
      height,
    });
    return { width, height };
  }, [getCanvasSize]);

  const syncNativeViewBounds = useCallback((reason: string) => {
    if (!USE_NATIVE_DRIFT_RDP) return;
    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    const tab = tabsRef.current.find(t => t.id === tabId);
    const wrap = canvasWrapRef.current;
    const visible = Boolean(
      wrap &&
      isRdpViewVisibleRef.current &&
      store.viewMode === 'tab' &&
      tab?.status === 'connected' &&
      nativeTabsRef.current.has(tabId)
    );
    const rect = wrap?.getBoundingClientRect();
    const bounds = {
      x: rect ? Math.max(0, rect.left) : 0,
      y: rect ? Math.max(0, rect.top) : 0,
      width: rect ? Math.max(0, rect.width) : 0,
      height: rect ? Math.max(0, rect.height) : 0,
      scaleFactor: window.devicePixelRatio || 1,
      visible,
    };
    const key = `${tabId}:${bounds.x.toFixed(1)}:${bounds.y.toFixed(1)}:${bounds.width.toFixed(1)}:${bounds.height.toFixed(1)}:${bounds.scaleFactor.toFixed(2)}:${bounds.visible}`;
    if (nativeViewLastBoundsRef.current === key) return;
    nativeViewLastBoundsRef.current = key;

    api.rdpNativeSetViewBounds(tabId, bounds).catch(error => {
      rdpLog.warn('rdp', 'native view bounds sync failed', {
        tabId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, [store.viewMode]);

  const scheduleNativeViewBoundsSync = useCallback((reason: string) => {
    if (!USE_NATIVE_DRIFT_RDP) return;
    if (nativeViewBoundsRafRef.current !== null) {
      cancelAnimationFrame(nativeViewBoundsRafRef.current);
    }
    nativeViewBoundsRafRef.current = requestAnimationFrame(() => {
      nativeViewBoundsRafRef.current = null;
      syncNativeViewBounds(reason);
    });
  }, [syncNativeViewBounds]);

  const buildKktermVisibleBounds = useCallback((tabId: string): KktermRdpBoundsRequest | null => {
    const wrap = canvasWrapRef.current;
    const rect = wrap?.getBoundingClientRect();
    if (!wrap || !rect) return null;

    const clipRects = Array.from(kktermOverlayClipRectsRef.current.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, overlayRect]) => overlayRect);

    return {
      tabId,
      x: Math.max(0, rect.left),
      y: Math.max(0, rect.top),
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
      scaleFactor: window.devicePixelRatio || 1,
      visible: true,
      ...(clipRects.length > 0 ? { clipRect: clipRects[0], clipRects } : {}),
    };
  }, []);

  const syncKktermViewBounds = useCallback((reason: string) => {
    if (!USE_KKTERM_COPY_WINDOWS) return;
    const activeTabId = activeTabIdRef.current;
    const scaleFactor = window.devicePixelRatio || 1;
    const connectedTabs = Array.from(kktermTabsRef.current);
    if (connectedTabs.length === 0) return;

    for (const tabId of connectedTabs) {
      const tab = tabsRef.current.find(t => t.id === tabId);
      const visible = Boolean(
        tabId === activeTabId &&
        isRdpViewVisibleRef.current &&
        store.viewMode === 'tab' &&
        tab?.status === 'connected'
      );
      const clipRects = visible
        ? Array.from(kktermOverlayClipRectsRef.current.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, overlayRect]) => overlayRect)
        : [];
      const visibleBounds = visible ? buildKktermVisibleBounds(tabId) : null;
      const bounds = visibleBounds
        ? visibleBounds
        : {
            tabId,
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            scaleFactor,
            visible: false,
          };
      const clipKey = clipRects.length > 0
        ? clipRects
            .map(overlayRect => `${overlayRect.x.toFixed(1)}:${overlayRect.y.toFixed(1)}:${overlayRect.width.toFixed(1)}:${overlayRect.height.toFixed(1)}`)
            .join('|')
        : 'none';
      const key = `${tabId}:${bounds.x.toFixed(1)}:${bounds.y.toFixed(1)}:${bounds.width.toFixed(1)}:${bounds.height.toFixed(1)}:${bounds.scaleFactor.toFixed(2)}:${bounds.visible}:${clipKey}`;
      if (kktermViewLastBoundsByTabRef.current.get(tabId) === key) continue;
      kktermViewLastBoundsByTabRef.current.set(tabId, key);

      kktermRdpSetBounds(bounds).catch(error => {
        rdpLog.warn('rdp', 'kkterm-rdp ActiveX bounds sync failed', {
          tabId,
          reason,
          visible: bounds.visible,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }, [buildKktermVisibleBounds, store.viewMode]);

  const scheduleKktermViewBoundsSync = useCallback((reason: string) => {
    if (!USE_KKTERM_COPY_WINDOWS) return;
    kktermViewBoundsPendingReasonRef.current = reason;

    const queueAnimationFrame = () => {
      if (kktermViewBoundsRafRef.current !== null) return;
      kktermViewBoundsRafRef.current = requestAnimationFrame(() => {
        kktermViewBoundsRafRef.current = null;
        kktermViewBoundsLastSyncAtRef.current = performance.now();
        syncKktermViewBounds(kktermViewBoundsPendingReasonRef.current);
      });
    };

    const continuousLayoutChange =
      reason === 'observer'
      || reason === 'window resize'
      || reason === 'tauri window resized';
    if (!continuousLayoutChange) {
      if (kktermViewBoundsThrottleTimerRef.current) {
        clearTimeout(kktermViewBoundsThrottleTimerRef.current);
        kktermViewBoundsThrottleTimerRef.current = null;
      }
      queueAnimationFrame();
      return;
    }

    const elapsed = performance.now() - kktermViewBoundsLastSyncAtRef.current;
    const remaining = KKTERM_WINDOWS_BOUNDS_THROTTLE_MS - elapsed;
    if (remaining <= 0) {
      queueAnimationFrame();
      return;
    }
    if (kktermViewBoundsThrottleTimerRef.current) return;
    kktermViewBoundsThrottleTimerRef.current = setTimeout(() => {
      kktermViewBoundsThrottleTimerRef.current = null;
      queueAnimationFrame();
    }, remaining);
  }, [syncKktermViewBounds]);

  const handleKktermOverlayClipRectChange = useCallback((id: string, open: boolean, rect?: KktermRdpClipRect) => {
    const existing = kktermOverlayClipRectsRef.current.get(id);
    if (open && rect) {
      const clippedRect = {
        x: Math.max(0, rect.x),
        y: Math.max(0, rect.y),
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height),
      };
      if (
        existing
        && existing.x === clippedRect.x
        && existing.y === clippedRect.y
        && existing.width === clippedRect.width
        && existing.height === clippedRect.height
      ) {
        return;
      }
      kktermOverlayClipRectsRef.current.set(id, clippedRect);
      setKktermOverlayBackdropRects(prev => ({ ...prev, [id]: clippedRect }));
      rdpLog.info('rdp', 'kkterm-rdp ActiveX overlay clip open', {
        id,
        ...clippedRect,
      });
    } else {
      if (!existing) return;
      kktermOverlayClipRectsRef.current.delete(id);
      setKktermOverlayBackdropRects(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      rdpLog.info('rdp', 'kkterm-rdp ActiveX overlay clip close', { id });
    }
    if (!USE_KKTERM_COPY_WINDOWS) return;
    kktermViewLastBoundsByTabRef.current.clear();
    scheduleKktermViewBoundsSync(open ? `overlay ${id} open` : `overlay ${id} close`);
  }, [scheduleKktermViewBoundsSync]);

  const forceKktermWindowsVisibleBoundsSync = useCallback(async (tabId: string, reason: string) => {
    if (!USE_KKTERM_COPY_WINDOWS) return;
    if (!kktermTabsRef.current.has(tabId)) return;
    if (activeTabIdRef.current !== tabId) return;
    if (!isRdpViewVisibleRef.current || store.viewMode !== 'tab') return;

    const bounds = buildKktermVisibleBounds(tabId);
    if (!bounds) return;

    kktermViewLastBoundsByTabRef.current.delete(tabId);
    rdpLog.info('rdp', 'kkterm-rdp ActiveX forced bounds settle', {
      tabId,
      reason,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      scaleFactor: bounds.scaleFactor,
    });

    try {
      await kktermRdpSetBounds(bounds);
    } catch (error) {
      rdpLog.warn('rdp', 'kkterm-rdp ActiveX forced bounds settle failed', {
        tabId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [buildKktermVisibleBounds, store.viewMode]);

  const scheduleKktermWindowsPostConnectSettle = useCallback((tabId: string, attemptId: string) => {
    if (!USE_KKTERM_COPY_WINDOWS) return;

    const existing = kktermPostConnectSettleTimersRef.current.get(tabId);
    existing?.forEach(timer => clearTimeout(timer));

    const timers: ReturnType<typeof setTimeout>[] = [];
    // The regular connected-state sync reveals the control immediately. One
    // late correction is enough after the connected poll succeeds. The
    // previous five forced SetWindowPos/clip passes kept repainting the native
    // surface for 1.6 seconds and made the resolution page appear to stutter.
    [500].forEach(delay => {
      timers.push(setTimeout(() => {
        void forceKktermWindowsVisibleBoundsSync(tabId, `post-connect settle ${delay}ms ${attemptId}`);
      }, delay));
    });
    timers.push(setTimeout(() => {
      if (kktermPostConnectSettleTimersRef.current.get(tabId) === timers) {
        kktermPostConnectSettleTimersRef.current.delete(tabId);
      }
    }, 700));

    kktermPostConnectSettleTimersRef.current.set(tabId, timers);
  }, [forceKktermWindowsVisibleBoundsSync]);

  const forceNativeClipboardCheck = useCallback((reason: string) => {
    if (!USE_NATIVE_RDP) return;
    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (tab?.status !== 'connected') return;
    if (!nativeTabsRef.current.has(tabId)) return;
    if (!isRdpViewVisibleRef.current || store.viewMode !== 'tab') return;

    const now = Date.now();
    const last = lastNativeClipboardForceAtRef.current.get(tabId) ?? 0;
    if (now - last < 1000) return;
    lastNativeClipboardForceAtRef.current.set(tabId, now);

    api.rdpNativeForceClipboardCheck(tabId).catch(error => {
      rdpLog.debug('clipboard', 'native force clipboard check failed', {
        tabId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, [store.viewMode]);

  useEffect(() => {
    scheduleNativeViewBoundsSync('state');
  }, [store.activeTabId, store.viewMode, store.activeTab?.status, isRdpViewVisible, scheduleNativeViewBoundsSync]);

  useEffect(() => {
    scheduleKktermViewBoundsSync('state');
  }, [store.activeTabId, store.viewMode, store.activeTab?.status, isRdpViewVisible, scheduleKktermViewBoundsSync]);

  // Hide the Windows ActiveX control's own white disconnect page and let the
  // NextDesk overlay explain that the remote session was replaced/disconnected.
  useEffect(() => {
    if (!USE_KKTERM_COPY_WINDOWS) return;
    const timer = window.setInterval(() => {
      const tabId = activeTabIdRef.current;
      const tab = tabsRef.current.find(item => item.id === tabId);
      if (!tabId || tab?.status !== 'connected' || !kktermTabsRef.current.has(tabId)) return;

      void kktermRdpStatus({ tabId }).then(async status => {
        if (status.connectionState !== 0 || userDisconnectedRef.current.has(tabId)) return;

        const disconnectError = activeXExtendedDisconnectError(status.extendedDisconnectReason);

        userDisconnectedRef.current.add(tabId);
        kktermViewLastBoundsByTabRef.current.delete(tabId);
        try {
          await kktermRdpSetBounds({
            tabId,
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            scaleFactor: window.devicePixelRatio || 1,
            visible: false,
          });
        } catch (error) {
          rdpLog.warn('rdp', 'kkterm-rdp disconnected surface hide failed', {
            tabId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        await kktermRdpDisconnect({
          tabId,
          routeLeaseId: kktermRouteLeaseIdsRef.current.get(tabId),
        }).catch(() => undefined);
        kktermTabsRef.current.delete(tabId);
        kktermRouteLeaseIdsRef.current.delete(tabId);
        kktermViewLastBoundsByTabRef.current.delete(tabId);
        stopFpsCounter(tabId);
        store.updateTabStatus(
          tabId,
          'error',
          disconnectError
            ? friendlyRdpError(disconnectError, t)
            : t('rdpErrWsClosed'),
        );
        setRdpStats(prev => ({ ...prev, status: 'error' }));
        rdpLog.warn('rdp', 'kkterm-rdp native session ended without auto-reconnect', {
          tabId,
          connectionState: status.connectionState,
          extendedDisconnectReason: status.extendedDisconnectReason,
          reason: disconnectError ?? 'remote_session_disconnected_without_reason',
        });
      }).catch(error => {
        rdpLog.debug('rdp', 'kkterm-rdp status poll skipped', {
          tabId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, 1500);

    return () => window.clearInterval(timer);
  }, [store, stopFpsCounter, t]);

  useEffect(() => {
    if (!USE_NATIVE_RDP) return;
    const tabId = isRdpViewVisible && store.viewMode === 'tab' ? store.activeTabId : null;
    api.rdpNativeSetActiveClipboardSession(tabId)
      .then(() => {
        if (tabId) forceNativeClipboardCheck('active clipboard session');
      })
      .catch(error => {
        rdpLog.debug('clipboard', 'native active clipboard session update failed', {
          tabId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, [store.activeTabId, store.viewMode, isRdpViewVisible, forceNativeClipboardCheck]);

  useEffect(() => {
    if (!USE_KKTERM_COPY_MACOS) return;
    const tabId = store.activeTabId;
    kktermRdpSetActiveClipboardSession(tabId)
      .then(() => {
        if (
          tabId
          && isRdpViewVisible
          && store.viewMode === 'tab'
          && store.activeTab?.status === 'connected'
        ) {
          return kktermRdpForceClipboardCheck({ tabId });
        }
        return undefined;
      })
      .catch(error => {
        rdpLog.debug('clipboard', 'KKTerm active clipboard session update failed', {
          tabId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, [store.activeTabId, store.activeTab?.status, store.viewMode, isRdpViewVisible]);

  useEffect(() => {
    forceNativeClipboardCheck('active tab');
  }, [store.activeTabId, store.viewMode, store.activeTab?.status, isRdpViewVisible, forceNativeClipboardCheck]);

  useEffect(() => {
    if (!USE_KKTERM_COPY_RDP) return;
    sendWinKeyRef.current = USE_KKTERM_COPY_MACOS
      ? () => {
          const tabId = activeTabIdRef.current;
          if (!tabId || !kktermTabsRef.current.has(tabId)) return;
          setKktermRdpWinSignalByTab(prev => ({
            ...prev,
            [tabId]: (prev[tabId] ?? 0) + 1,
          }));
        }
      : () => {
          const tabId = activeTabIdRef.current;
          if (!tabId || !kktermTabsRef.current.has(tabId)) {
            rdpLog.warn('rdp', 'kkterm-copy virtual Win key skipped; no active Windows session', { tabId });
            return;
          }
          rdpLog.info('rdp', 'kkterm-copy virtual Win key requested', { tabId });
          kktermRdpKey({ tabId, scancode: 0xe05b, down: true })
            .then(() => kktermRdpKey({ tabId, scancode: 0xe05b, down: false }))
            .then(() => {
              rdpLog.info('rdp', 'kkterm-copy virtual Win key sent', { tabId });
            })
            .catch(error => {
              rdpLog.warn('rdp', 'kkterm-copy virtual Win key failed', {
                tabId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
        };
    sendCtrlAltDelRef.current = USE_KKTERM_COPY_MACOS
      ? () => {
          const tabId = activeTabIdRef.current;
          if (!tabId || !kktermTabsRef.current.has(tabId)) return;
          setKktermRdpCadSignalByTab(prev => ({
            ...prev,
            [tabId]: (prev[tabId] ?? 0) + 1,
          }));
        }
      : () => {
          const tabId = activeTabIdRef.current;
          if (!tabId || !kktermTabsRef.current.has(tabId)) {
            rdpLog.warn('rdp', 'kkterm-copy Ctrl+Alt+Del skipped; no active Windows session', { tabId });
            return;
          }
          rdpLog.info('rdp', 'kkterm-copy Ctrl+Alt+Del requested', { tabId });
          kktermRdpCtrlAltDelete({ tabId })
            .then(() => {
              rdpLog.info('rdp', 'kkterm-copy Ctrl+Alt+Del sent', { tabId });
            })
            .catch(error => {
              rdpLog.warn('rdp', 'kkterm-copy Ctrl+Alt+Del failed', {
                tabId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
        };
    sendClipboardTextRef.current = async () => {
      const tabId = activeTabIdRef.current;
      if (!tabId || !kktermTabsRef.current.has(tabId)) return;
      const text = await tauriReadClipboard().catch(() => '');
      if (!text) return;
      if (USE_KKTERM_COPY_MACOS) {
        setKktermRdpTextSignalByTab(prev => ({
          ...prev,
          [tabId]: {
            sequence: (prev[tabId]?.sequence ?? 0) + 1,
            text,
          },
        }));
        return;
      }
      kktermRdpText({ tabId, text }).catch(error => {
        rdpLog.warn('clipboard', 'kkterm-copy text injection failed', {
          tabId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };
    return () => {
      sendWinKeyRef.current = null;
      sendCtrlAltDelRef.current = null;
      sendClipboardTextRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!USE_NATIVE_RDP) return;
    const onFocus = () => forceNativeClipboardCheck('window focus');
    const onVisibilityChange = () => {
      if (!document.hidden) forceNativeClipboardCheck('visibility');
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [forceNativeClipboardCheck]);

  useEffect(() => {
    if (!USE_NATIVE_DRIFT_RDP) return;
    const wrap = canvasWrapRef.current;
    const container = containerRef.current;
    const obs = new ResizeObserver(() => scheduleNativeViewBoundsSync('observer'));
    if (wrap) obs.observe(wrap);
    if (container) obs.observe(container);

    const onResize = () => scheduleNativeViewBoundsSync('window resize');
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    scheduleNativeViewBoundsSync('mount');

    return () => {
      obs.disconnect();
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      if (nativeViewBoundsRafRef.current !== null) {
        cancelAnimationFrame(nativeViewBoundsRafRef.current);
        nativeViewBoundsRafRef.current = null;
      }
    };
  }, [store.activeTabId, scheduleNativeViewBoundsSync]);

  useEffect(() => {
    if (!USE_KKTERM_COPY_WINDOWS) return;
    const wrap = canvasWrapRef.current;
    const container = containerRef.current;
    const obs = new ResizeObserver(() => scheduleKktermViewBoundsSync('observer'));
    if (wrap) obs.observe(wrap);
    if (container) obs.observe(container);

    const forceBoundsSync = (reason: string) => {
      kktermViewLastBoundsByTabRef.current.clear();
      scheduleKktermViewBoundsSync(reason);
    };
    const onResize = () => forceBoundsSync('window resize');
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    forceBoundsSync('mount');

    let active = true;
    const tauriUnlisteners: Array<() => void> = [];
    const registerWindowListener = (promise: Promise<() => void>) => {
      promise
        .then(unlisten => {
          if (active) {
            tauriUnlisteners.push(unlisten);
          } else {
            unlisten();
          }
        })
        .catch(error => {
          rdpLog.debug('rdp', 'kkterm-rdp ActiveX window listener registration failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    };
    const appWindow = getCurrentWindow();
    const hostMoveFollower = createKktermHostMoveFollower(
      kktermRdpFollowHostWindow,
      error => {
        rdpLog.debug('rdp', 'kkterm-rdp ActiveX host move follow failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
    registerWindowListener(appWindow.onMoved(hostMoveFollower.request));
    registerWindowListener(appWindow.onResized(() => forceBoundsSync('tauri window resized')));
    registerWindowListener(appWindow.onScaleChanged(() => {
      forceBoundsSync('window scale changed');
      if (kktermScaleDisplaySyncTimerRef.current) {
        clearTimeout(kktermScaleDisplaySyncTimerRef.current);
      }
      kktermScaleDisplaySyncTimerRef.current = setTimeout(() => {
        kktermScaleDisplaySyncTimerRef.current = null;
        if (resModeRef.current !== 'adaptive') return;
        const tabId = activeTabIdRef.current;
        const tab = tabsRef.current.find(item => item.id === tabId);
        if (!tabId || tab?.status !== 'connected' || !kktermTabsRef.current.has(tabId)) return;
        const bounds = buildKktermVisibleBounds(tabId);
        if (!bounds) return;
        const startedAt = performance.now();
        kktermRdpSyncDisplaySize(bounds).then(display => {
          rdpLog.info('display', 'window scale change display synchronized', {
            tabId,
            scaleFactor: bounds.scaleFactor,
            desktopWidth: display.desktopWidth,
            desktopHeight: display.desktopHeight,
            displaySynced: display.displaySynced,
            elapsedMs: Math.round(performance.now() - startedAt),
          });
        }).catch(error => {
          rdpLog.warn('display', 'window scale change display synchronization failed', {
            tabId,
            scaleFactor: bounds.scaleFactor,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, 250);
    }));

    return () => {
      active = false;
      hostMoveFollower.dispose();
      tauriUnlisteners.forEach(unlisten => unlisten());
      obs.disconnect();
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      if (kktermViewBoundsRafRef.current !== null) {
        cancelAnimationFrame(kktermViewBoundsRafRef.current);
        kktermViewBoundsRafRef.current = null;
      }
      if (kktermViewBoundsThrottleTimerRef.current) {
        clearTimeout(kktermViewBoundsThrottleTimerRef.current);
        kktermViewBoundsThrottleTimerRef.current = null;
      }
      if (kktermScaleDisplaySyncTimerRef.current) {
        clearTimeout(kktermScaleDisplaySyncTimerRef.current);
        kktermScaleDisplaySyncTimerRef.current = null;
      }
    };
  }, [buildKktermVisibleBounds, store.activeTabId, scheduleKktermViewBoundsSync]);

  // ── Suppress adaptive resize when sidebar collapses/expands ──
  useEffect(() => {
    // Skip on initial mount
    if (prevSidebarOpenRef.current === store.sidebarOpen) return;
    prevSidebarOpenRef.current = store.sidebarOpen;

    // Ignore intermediate animation frames, then issue one final Windows
    // display sync after the sidebar transition settles.
    resizeCooldownRef.current = true;

    // After the transition animation completes (~300ms), synchronize the
    // automatic ActiveX desktop once. Other engines keep their historical
    // suppression behavior to avoid an unnecessary reconnect.
    const timer = setTimeout(() => {
      resizeCooldownRef.current = false;
      if (USE_KKTERM_COPY_WINDOWS && resModeRef.current === 'adaptive') {
        performAdaptiveResizeRef.current('sidebar transition');
        return;
      }
      const cur = getCanvasSize();
      if (cur.w > 0 && cur.h > 0) lastSizeRef.current = { w: cur.w, h: cur.h };
    }, 500);

    return () => clearTimeout(timer);
  }, [store.sidebarOpen, getCanvasSize]);

  // ── Suppress adaptive resize when RDP view transitions hidden → visible ──
  // (e.g. user switches to Dashboard tab then back to RDP tab)
  useEffect(() => {
    const wrap = containerRef.current;
    if (!wrap) return;
    let wasHidden = wrap.offsetParent === null;

    const obs = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const isVisible = entry.isIntersecting;
        if (isVisible && wasHidden) {
          // Transitioning hidden → visible: ignore intermediate layout frames,
          // then synchronize a Windows automatic desktop once if its viewport
          // changed while hidden.
          resizeCooldownRef.current = true;
          setTimeout(() => {
            resizeCooldownRef.current = false;
            if (USE_KKTERM_COPY_WINDOWS && resModeRef.current === 'adaptive') {
              performAdaptiveResizeRef.current('view restored');
              return;
            }
            const cur = getCanvasSize();
            if (cur.w > 0 && cur.h > 0) lastSizeRef.current = { w: cur.w, h: cur.h };
          }, 500);
        }
        wasHidden = !isVisible;
      }
    }, { threshold: 0.01 });

    obs.observe(wrap);
    return () => obs.disconnect();
  }, [getCanvasSize]);

  // ── Connect to server ──
  const connectSession = useCallback(async (tabId: string) => {
    if (connectingTabsRef.current.has(tabId)) {
      rdpLog.warn('rdp', 'connectSession skipped: local connect lock active', { tabId });
      return;
    }
    const tab = store.tabs.find(t => t.id === tabId);
    if (!tab) return;
    // Guard: prevent double-connection
    if (tab.status === 'connecting' || tab.status === 'connected') {
      rdpLog.warn('rdp', `connectSession skipped: already ${tab.status}`, { tabId });
      return;
    }
    if (sessionRefs.current.has(tabId)) {
      rdpLog.warn('rdp', 'connectSession skipped: session already exists', { tabId });
      return;
    }
    const server = store.getServerById(tab.serverId);
    if (!server) return;
    connectingTabsRef.current.add(tabId);
    store.updateTabRoute(tabId, undefined);
    const attemptId = createAttemptId(tabId);
    const reuseCloudBinding = false;
    attemptIdsRef.current.set(tabId, attemptId);
    rdpLog.info('rdp', 'connect.start', {
      attemptId,
      tabId,
      host: server.host,
      port: server.port,
      renderer: RDP_ENGINE_MODE,
      status: tab.status,
      reuseCloudBinding,
    });

    if (USE_KKTERM_COPY_MACOS) {
      await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      const desktopSize = selectKktermRdpDesktopSize(attemptId, tabId);
      rdpLog.warn('rdp', 'Using opt-in KKTerm RDP path', {
        attemptId,
        tabId,
        platform: KKTERM_COPY_PLATFORM,
        desktopWidth: desktopSize.width,
        desktopHeight: desktopSize.height,
      });
      kktermTabsRef.current.add(tabId);
      setKktermRdpLaunch(prev => ({
        ...prev,
        [tabId]: {
          nonce: (prev[tabId]?.nonce ?? 0) + 1,
          desktopSize,
          reuseCloudBinding,
        },
      }));
      store.updateTabStatus(tabId, 'connecting');
      setRdpStats(prev => ({ ...prev, status: 'connecting' }));
      return;
    }

    // Keep 'reconnecting' UI during auto-reconnect instead of flashing back to 'Connecting to...'
    if (tab.status !== 'reconnecting') {
      store.updateTabStatus(tabId, 'connecting');
    }
    try {
      // Wait for 2 animation frames to ensure the wrapper div is in the DOM and laid out
      await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));

      const canvas = await waitForCanvas(tabId);
      if (!canvas) throw new Error('Canvas not ready');
      const kktermStableLayoutBounds = USE_KKTERM_COPY_WINDOWS
        ? await waitForKktermWindowsLayoutReady(attemptId, tabId)
        : null;

      // Use desired size if set (from resolution switching), otherwise wrapper size
      let w: number, h: number;
      const desiredDesktopSize = desiredSizeRef.current;
      if (desiredDesktopSize) {
        w = desiredDesktopSize.w;
        h = desiredDesktopSize.h;
        rdpLog.info('rdp', 'layout.size.selected', {
          attemptId,
          tabId,
          source: 'desired',
          width: w,
          height: h,
        });
      } else if (kktermStableLayoutBounds) {
        w = Math.floor(kktermStableLayoutBounds.width);
        h = Math.floor(kktermStableLayoutBounds.height);
        rdpLog.info('rdp', 'layout.size.selected', {
          attemptId,
          tabId,
          source: 'stable-wrapper',
          width: w,
          height: h,
        });
      } else {
        const cs = getCanvasSize();
        w = cs.w; h = cs.h;
        rdpLog.info('rdp', 'layout.size.selected', {
          attemptId,
          tabId,
          source: 'wrapper',
          width: w,
          height: h,
        });
      }
      if (USE_NATIVE_RDP) {
        const normalized = normalizeNativeDesktopSizeForHost(w, h, server.host);
        if (normalized.w !== w || normalized.h !== h) {
          rdpLog.info('display', 'native connect size normalized', {
            requested: { w, h },
            normalized: { w: normalized.w, h: normalized.h },
            host: server.host,
            cappedPublicRoute: normalized.capped,
          });
        }
        w = normalized.w;
        h = normalized.h;
      }
      canvas.width = w;
      canvas.height = h;
      lastSizeRef.current = { w, h };
      // Suppress adaptive resize for 1s after connect to let toolbar layout settle
      resizeCooldownRef.current = true;
      setTimeout(() => {
        const cur = getCanvasSize();
        if (cur.w > 0 && cur.h > 0) {
          lastSizeRef.current = USE_NATIVE_RDP
            ? normalizeNativeDesktopSizeForHost(cur.w, cur.h, server.host)
            : { w: cur.w, h: cur.h };
        }
        resizeCooldownRef.current = false;
      }, 1000);

      // ── KKTerm copy mode: Windows ActiveX or macOS simple canvas backend ──
      if (USE_KKTERM_COPY_RDP) {
        if (!USE_KKTERM_COPY_MACOS && !USE_KKTERM_COPY_WINDOWS) {
          throw new Error(`kkterm-copy RDP engine is unsupported on this platform: ${KKTERM_COPY_PLATFORM}`);
        }

        rdpLog.warn('rdp', 'Using opt-in KKTerm copy RDP path', {
          attemptId,
          tabId,
          platform: KKTERM_COPY_PLATFORM,
        });

        const domWrapRect = canvasWrapRef.current?.getBoundingClientRect();
        const wrapX = kktermStableLayoutBounds?.x ?? domWrapRect?.left ?? 0;
        const wrapY = kktermStableLayoutBounds?.y ?? domWrapRect?.top ?? 0;
        const wrapWidth = kktermStableLayoutBounds?.width ?? domWrapRect?.width ?? w;
        const wrapHeight = kktermStableLayoutBounds?.height ?? domWrapRect?.height ?? h;
        const scaleFactor = window.devicePixelRatio || 1;
        const kktermRemoteResolution = resModeRef.current === 'adaptive'
          ? 'automatic'
          : resModeRef.current;
        const startResponse = await kktermRdpStart({
          tabId,
          host: server.host,
          port: server.port,
          username: server.username,
          password: server.password,
          domain: server.domain || undefined,
          x: wrapX,
          y: wrapY,
          width: wrapWidth,
          height: wrapHeight,
          scaleFactor,
          desktopWidth: w,
          desktopHeight: h,
          remoteResolution: kktermRemoteResolution,
          redirectDrives: USE_KKTERM_COPY_WINDOWS && driveRedirectionEnabledRef.current,
          useMultimon: USE_KKTERM_COPY_WINDOWS && multiMonitorEnabledRef.current,
          reuseCloudBinding,
        });
        kktermRouteLeaseIdsRef.current.set(tabId, startResponse.routeLeaseId);
        store.updateTabRoute(tabId, startResponse.routeLabel);
        rdpLog.info('route', 'route.selected', { tabId, routeLabel: startResponse.routeLabel });

        kktermTabsRef.current.add(tabId);
        if (USE_KKTERM_COPY_WINDOWS) {
          const activeXBounds = {
            tabId,
            x: wrapX,
            y: wrapY,
            width: wrapWidth,
            height: wrapHeight,
            scaleFactor,
            visible: false,
          };
          await kktermRdpSetBounds(activeXBounds).catch(error => {
            rdpLog.warn('rdp', 'kkterm-rdp ActiveX staging after connect failed', { tabId, error: String(error) });
          });
          const connectedSize = await waitForKktermWindowsDisplay(
            attemptId,
            tabId,
            activeXBounds,
            w,
            h,
          );
          markKktermTabConnected(tabId, connectedSize.width, connectedSize.height);
          if (ENABLE_KKTERM_WINDOWS_FKEY_QA) {
            setTimeout(() => {
              void (async () => {
                rdpLog.info('input', 'kkterm-windows QA F1-F12 sequence started', { tabId });
                for (const scancode of KKTERM_WINDOWS_FKEY_SCANCODES) {
                  await kktermRdpKey({ tabId, scancode, down: true });
                  await kktermRdpKey({ tabId, scancode, down: false });
                  await new Promise(resolve => setTimeout(resolve, 150));
                }
                rdpLog.info('input', 'kkterm-windows QA F1-F12 sequence completed', { tabId });
              })().catch(error => {
                rdpLog.warn('input', 'kkterm-windows QA F1-F12 sequence failed', {
                  tabId,
                  error: error instanceof Error ? error.message : String(error),
                });
              });
            }, 3000);
          }
          kktermViewLastBoundsByTabRef.current.delete(tabId);
          scheduleKktermViewBoundsSync('connected');
          scheduleKktermWindowsPostConnectSettle(tabId, attemptId);
        }

        startOfficialWebFpsCounter(tabId, canvas);
        startCloudKeepalive(tabId, server.host, server.port);
        connectingTabsRef.current.delete(tabId);
        return;
      }

      // ── Native RDP mode: connect via Rust backend ──
      if (USE_NATIVE_RDP) {
        rdpLog.warn(
          'rdp',
          USE_NATIVE_DRIFT_RDP
            ? 'Using native-drift canvas RDP path'
            : 'Using experimental native RDP path instead of IronRDP official-web',
        );
        cleanupNativeFrameStream(tabId);
        rdpLog.info('rdp', 'native.connect.request', {
          attemptId,
          tabId,
          host: server.host,
          port: server.port,
          width: w,
          height: h,
          mode: RDP_ENGINE_MODE,
          transport: USE_NATIVE_DRIFT_RDP ? 'dirty-rect' : 'raw-bitmap',
          renderer: 'canvas',
        });
        const nativeGfxWorker = USE_NATIVE_GFX_H264 ? ensureH264Worker(tabId) : null;
        const handleNativeGfxFrame = USE_NATIVE_GFX_H264
          ? (frame: NativeGfxH264Frame) => {
              nativeGfxWorker?.postMessage(
                {
                  type: 'decode',
                  data: frame.data,
                  timestamp: performance.now() * 1000,
                  surfaceId: 0,
                  rect: {
                    left: frame.left,
                    top: frame.top,
                    right: frame.right,
                    bottom: frame.bottom,
                  },
                },
                [frame.data],
              );
            }
          : undefined;

        // Connect via Rust backend — returns WS port for frame streaming
        const connectResponse = await api.rdpNativeConnect({
          tabId,
          host: server.host,
          port: server.port,
          username: server.username,
          password: server.password,
          domain: server.domain || undefined,
          width: w,
          height: h,
          renderProfile: RDP_ENGINE_MODE,
          reuseCloudBinding,
        });
        const { wsPort, routeLabel, routeLeaseId } = connectResponse;
        nativeRouteLeaseIdsRef.current.set(tabId, routeLeaseId);
        startCloudKeepalive(tabId, server.host, server.port);
        store.updateTabRoute(tabId, routeLabel);
        rdpLog.info('rdp', 'native.connect.ok', { attemptId, tabId, wsPort, routeLabel });
        nativeTabsRef.current.add(tabId);
        updateNativeResolution(tabId, w, h, 'connect-request');

        // Connect WebSocket for zero-overhead frame streaming
        let cleanupWs: (() => void) | null = null;
        cleanupWs = connectFrameWebSocket(
          wsPort,
          canvas,
          (frame?: NativeBitmapFrameInfo) => {
            const current = tabsRef.current.find(t => t.id === tabId);
            if (current?.status === 'connecting' || current?.status === 'reconnecting') {
              markNativeTabConnected(tabId, 'frame-stream');
            }
            if (!isNativeTabRenderable(tabId, canvas)) return;
            fpsCountRef.current++;
            if (frame) {
              lastSizeRef.current = { w: frame.desktopW, h: frame.desktopH };
              const pending = nativeResizePendingByTabRef.current.get(tabId);
              if (pending && pending.w === frame.desktopW && pending.h === frame.desktopH) {
                nativeResizePendingByTabRef.current.delete(tabId);
              }
              updateNativeResolution(tabId, frame.desktopW, frame.desktopH, 'bitmap-frame');
            }
          },
          handleNativeGfxFrame,
          (event) => {
            const current = tabsRef.current.find(t => t.id === tabId);
            if (
              current &&
              (current.status === 'connecting' || current.status === 'connected') &&
              !userDisconnectedRef.current.has(tabId)
            ) {
              if (cleanupWs && nativeFrameCleanupByTabRef.current.get(tabId) === cleanupWs) {
                nativeFrameCleanupByTabRef.current.delete(tabId);
              }
              rdpLog.warn('display', 'native frame websocket closed unexpectedly', {
                tabId,
                wsPort,
                code: event.code,
                reason: event.reason,
                wasClean: event.wasClean,
              });
              nativeTabsRef.current.delete(tabId);
              forgetNativeResizeState(tabId);
              stopFpsCounter(tabId);
              cleanupH264Worker(tabId);
              setRdpStats(prev => ({ ...prev, status: 'disconnected' }));
              if (!userDisconnectedRef.current.has(tabId)) {
                scheduleReconnect(tabId, event.reason || t('rdpFrameStreamDisconnected'));
              }
            }
          },
          {
            tabId,
            host: server.host,
            shouldRenderFrame: () => {
              const current = tabsRef.current.find(t => t.id === tabId);
              if (current?.status === 'connecting' || current?.status === 'reconnecting') {
                markNativeTabConnected(tabId, 'frame-received');
              }
              return isNativeTabRenderable(tabId, canvas);
            },
          },
        );
        nativeFrameCleanupByTabRef.current.set(tabId, cleanupWs);

        // Suppress adaptive resize after connect
        resizeCooldownRef.current = true;
        setTimeout(() => {
          const cur = getCanvasSize();
          if (cur.w > 0 && cur.h > 0) lastSizeRef.current = { w: cur.w, h: cur.h };
          resizeCooldownRef.current = false;
        }, 1500);

        startNativeFpsCounter(tabId);

        connectingTabsRef.current.delete(tabId);
        return; // Skip WASM path below
      }

      // ── Official IronRDP Web mode: use ironrdp-web WASM + NextDesk WebSocket proxy ──
      if (!USE_OFFICIAL_IRONRDP_WEB) {
        throw new Error(`Unsupported RDP engine mode: ${RDP_ENGINE_MODE}`);
      }

      let currentProxyPort = proxyPort;
      try {
        const latestProxyPort = await invoke<number>('get_rdp_proxy_port');
        currentProxyPort = latestProxyPort > 0 ? latestProxyPort : 0;
        if (currentProxyPort !== proxyPort) {
          setProxyPort(currentProxyPort);
        }
      } catch (error) {
        currentProxyPort = 0;
        setProxyPort(0);
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`RDP local proxy is unavailable: ${detail}`);
      }

      if (currentProxyPort <= 0) {
        throw new Error('RDP local proxy is unavailable: 127.0.0.1:18765 is not bound');
      }

      const officialWebGfxDisabledByFallback = officialWebGfxDisabledByFallbackRef.current.has(tabId);
      const officialWebGfxEnabled = OFFICIAL_WEB_FEATURES.gfx && !officialWebGfxDisabledByFallback;

      rdpLog.info('rdp', 'official ironrdp web connect request', {
        attemptId,
        tabId,
        host: server.host,
        port: server.port,
        proxyPort: currentProxyPort,
        width: w,
        height: h,
        visualQuality: resolveOfficialWebVisualQualityForHost(server.host),
        officialWebFeatures: {
          audio: OFFICIAL_WEB_FEATURES.audio,
          gfx: officialWebGfxEnabled,
          gfxRequested: OFFICIAL_WEB_FEATURES.gfxRequested,
          gfxForce: OFFICIAL_WEB_FEATURES.gfxForce,
          gfxDisabledByFallback: officialWebGfxDisabledByFallback,
          fileTransfer: OFFICIAL_WEB_FEATURES.fileTransfer,
          displayControl: OFFICIAL_WEB_FEATURES.displayControl,
        },
      });

      const wasm = await loadWasm();
      const visualQuality = resolveOfficialWebVisualQualityForHost(server.host);

      const size = new wasm.DesktopSize(w, h);
      const builder = new wasm.SessionBuilder()
        .proxyAddress(`ws://127.0.0.1:${currentProxyPort}`)
        .authToken(`nextdesk-local:${tabId}`)
        .destination(`${server.host}:${server.port}`)
        .username(server.username)
        .password(server.password)
        .desktopSize(size)
        .extension(new wasm.Extension('visual_quality', visualQuality))
        .renderCanvas(canvas)
        .setCursorStyleCallback(
          (kind: string, data?: string, hx?: number, hy?: number) => {
            if (kind === 'url' && data) {
              canvas.style.cursor = `url(${data}) ${hx ?? 0} ${hy ?? 0}, auto`;
            } else if (kind === 'hidden') {
              // Intentionally ignore — Windows sends PointerHidden before
              // switching to a new cursor bitmap. Keeping the old cursor
              // until the next PointerBitmap arrives prevents flickering.
            } else {
              canvas.style.cursor = 'default';
            }
          },
        )
        .setCursorStyleCallbackContext(null)
        .canvasResizedCallback(() => {
          // WASM renderer sets canvas.width/height internally when server responds
          const cw = canvas.width, ch = canvas.height;
          rdpLog.info('display', `canvasResizedCallback → canvas: ${cw} x ${ch}`);
          if (cw > 0 && ch > 0) {
            lastSizeRef.current = { w: cw, h: ch };
            fpsCountRef.current++;
            setRdpStats(prev => ({ ...prev, resolution: `${cw}×${ch}` }));
          }
        });

      applyIronRdpTextClipboardCallbacks(builder, {
        remoteClipboardChanged: (data: WasmClipboardData) => {
          cblog('[clipboard] ▶ remoteClipboardChangedCallback FIRED');
          advertisedClipboardRef.current.delete(tabId);
          forceClipboardReadInFlightRef.current.delete(tabId);
          // Remote → Local: when user copies in RDP, sync to local clipboard
          try {
            const items = data.items();
            cblog('[clipboard] Remote items count:', items.length);
            let textHandled = false;
            for (const item of items) {
              const mime = item.mimeType();
              cblog('[clipboard] Remote item MIME:', mime);
              if (mime.startsWith('text/') && !textHandled) {
                const text = item.value() as string;
                // Skip empty text — some servers send empty text/plain before real data
                if (!text) {
                  cblog('[clipboard] Remote text is empty, skipping write');
                  continue;
                }
                // Remote sent text, not files — clear file key ref
                remoteClipboardFileKeyRef.current.delete(tabId);
                tauriWriteClipboard(text).then(() => {
                  cblog('[clipboard] Remote → Local text:', text.slice(0, 50));
                  // Mark as already-advertised so paste-shortcut won't re-send
                  advertisedClipboardRef.current.set(tabId, { kind: 'text', text });
                }).catch(e => cblog('[clipboard] Write text failed:', e));
                textHandled = true;
              } else if (mime === RDP_FILE_MIME) {
                // Remote file copy: decode file descriptor list from JSON
                try {
                  const value = item.value();
                  const raw = value instanceof Uint8Array ? value
                    : (value instanceof ArrayBuffer ? new Uint8Array(value) : null);
                  if (raw && raw.length > 0) {
                    const json = new TextDecoder().decode(raw);
                    const fileInfos: {name: string; size: number}[] = JSON.parse(json);
                    cblog('[file-transfer] Remote file list:', fileInfos.length, 'files');
                    for (const fi of fileInfos) {
                      cblog('[file-transfer]  -', fi.name, fi.size, 'bytes');
                    }
                    cblog('[file-transfer] Remote descriptors ready; wasm backend will request SIZE/DATA and emit FileContentsResponse');
                  }
                } catch (e) { cblog('[file-transfer] Parse file list error:', e); }
              } else if (!mime.startsWith('text/')) {
                // Other non-text data (e.g., images)
                try {
                  const value = item.value();
                  const raw = value instanceof Uint8Array ? value
                    : (value instanceof ArrayBuffer ? new Uint8Array(value) : null);
                  if (raw && raw.length > 0) {
                    const ext = mime.includes('/') ? mime.split('/').pop()?.replace('x-', '') || 'bin' : 'bin';
                    const fileName = `rdp_paste_${Date.now()}.${ext}`;
                    cblog('[clipboard] Remote file:', fileName, raw.length, 'bytes, MIME:', mime);
                    invoke('clipboard_write_file', { fileName, data: Array.from(raw) })
                      .then(path => cblog('[clipboard] ✅ Remote → Local file saved:', path))
                      .catch(e => cblog('[clipboard] File write error:', e));
                  }
                } catch (fileErr) {
                  cblog('[clipboard] File extraction error:', fileErr);
                }
              }
            }
          } catch (e) { cblog('[clipboard] Read remote data error:', e); }
        },
        forceClipboardUpdate: () => {
          cblog('[clipboard] ▶ forceClipboardUpdateCallback FIRED (server requests data)');
          const sess = sessionRefs.current.get(tabId);
          if (!sess || !wasm) { cblog('[clipboard] forceUpdate: no session/wasm!'); return; }
          if (rdpdrEnabledRef.current.has(tabId)) {
            cblog('[clipboard] forceUpdate: RDPDR active');
            // Check cached snapshot first — paste-shortcut may have already prepared file data
            const rdpdrCachedSnapshot = advertisedClipboardRef.current.get(tabId);
            if (rdpdrCachedSnapshot) {
              cblog(
                '[clipboard] forceUpdate: replay cached snapshot (RDPDR mode)',
                rdpdrCachedSnapshot.kind === 'files'
                  ? `${rdpdrCachedSnapshot.files.length} file(s)`
                  : `"${rdpdrCachedSnapshot.text.slice(0, 60)}"`,
              );
              const clipboardData = buildClipboardDataFromSnapshot(wasm, rdpdrCachedSnapshot);
              void sess.onClipboardPaste(clipboardData)
                .then(() => cblog('[clipboard] ✅ forceUpdate replayed cached snapshot (RDPDR)'))
                .catch(e => cblog('[clipboard] forceUpdate replay error (RDPDR):', e));
              return;
            }
            // No cache — fall back to text-only sync (skip file detection when RDPDR handles files)
            void invoke<string[]>('clipboard_read_file_paths')
              .catch(() => [] as string[])
              .then(filePaths => {
                if (filePaths.length > 0) {
                  cblog('[clipboard] forceUpdate: local clipboard currently holds file paths, skip text sync');
                  return null;
                }
                return tauriReadClipboard();
              })
              .then(text => {
                if (!text) return;
                const snapshot: AdvertisedClipboardSnapshot = {
                  kind: 'text',
                  text,
                };
                const clipboardData = buildClipboardDataFromSnapshot(wasm, snapshot);
                return sess.onClipboardPaste(clipboardData).then(() => {
                  advertisedClipboardRef.current.set(
                    tabId,
                    cloneAdvertisedClipboardSnapshot(snapshot),
                  );
                  cblog('[clipboard] ✅ forceUpdate Local→Remote text delivered while RDPDR active');
                });
              })
              .catch(e => cblog('[clipboard] forceUpdate text-only error:', e));
            return;
          }
          const cachedSnapshot = advertisedClipboardRef.current.get(tabId);
          if (cachedSnapshot) {
            cblog(
              '[clipboard] forceUpdate: replay cached snapshot',
              cachedSnapshot.kind === 'files'
                ? `${cachedSnapshot.files.length} file(s)`
                : `"${cachedSnapshot.text.slice(0, 60)}"`,
            );
            const clipboardData = buildClipboardDataFromSnapshot(wasm, cachedSnapshot);
            void sess.onClipboardPaste(clipboardData)
              .then(() => {
                cblog('[clipboard] ✅ forceUpdate replayed cached clipboard snapshot');
              })
              .catch(e => cblog('[clipboard] forceUpdate replay error:', e));
            return;
          }
          if (forceClipboardReadInFlightRef.current.has(tabId)) {
            cblog('[clipboard] forceUpdate: clipboard read already in flight, skip duplicate request');
            return;
          }
          forceClipboardReadInFlightRef.current.add(tabId);
          // Try reading files from clipboard first, then fall back to text
          invoke<{name: string, path: string, size: number, data: number[]}[]>('clipboard_read_files_data')
            .then(files => {
              if (files && files.length > 0) {
                cblog('[clipboard] forceUpdate: found', files.length, 'file(s) in clipboard');
                const payloads: ClipboardFilePayload[] = files.map(f => ({
                  name: f.name,
                  size: f.size,
                  data: new Uint8Array(f.data),
                  path: f.path,
                }));
                for (const f of payloads) {
                  cblog('[clipboard] Adding file:', f.name, f.size, 'bytes', f.data.length === 0 ? '(lazy)' : '(in-memory)');
                }
                const snapshot: AdvertisedClipboardSnapshot = {
                  kind: 'files',
                  fileKey: payloads.map(f => f.path || f.name).join('|'),
                  files: cloneClipboardFilePayloads(payloads),
                };
                const clipboardData = buildClipboardDataFromSnapshot(wasm, snapshot);
                return sess.onClipboardPaste(clipboardData).then(() => {
                  advertisedClipboardRef.current.set(
                    tabId,
                    cloneAdvertisedClipboardSnapshot(snapshot),
                  );
                  cblog('[clipboard] ✅ forceUpdate Local→Remote files delivered');
                });
              }
              // No files → fall back to text
              return tauriReadClipboard().then(text => {
                cblog('[clipboard] forceUpdate read text:', text ? `"${text.slice(0, 60)}"` : '(null)');
                if (!text) return;
                const snapshot: AdvertisedClipboardSnapshot = {
                  kind: 'text',
                  text,
                };
                const clipboardData = buildClipboardDataFromSnapshot(wasm, snapshot);
                return sess.onClipboardPaste(clipboardData).then(() => {
                  advertisedClipboardRef.current.set(
                    tabId,
                    cloneAdvertisedClipboardSnapshot(snapshot),
                  );
                  cblog('[clipboard] ✅ forceUpdate Local→Remote text delivered');
                });
              });
            })
            .catch(e => cblog('[clipboard] forceUpdate error:', e))
            .finally(() => {
              forceClipboardReadInFlightRef.current.delete(tabId);
            });
        },
      });

      applyIronRdpCliprdrFileCallbacks(builder, {
        fileContentsRequest: (request: any) => {
          // The Rust clipboard backend responds to the server request itself.
          const normalized = normalizeFileContentsRequest(request);
          if (normalized.flags === 1 || normalized.position === 0) {
            cblog('[file-transfer] ▶ FileContentsRequest:', normalized);
          }
          // Lock: suppress clipboard polling during active file transfer (local→remote).
          // Use a timeout-based auto-release: each new request resets the timer.
          // When no new requests arrive for 5s, the transfer is considered complete.
          fileTransferInProgressRef.current.add(tabId);
          const timerKey = `__ft_release_timer_${tabId}`;
          const g = globalThis as any;
          if (g[timerKey]) clearTimeout(g[timerKey]);
          g[timerKey] = setTimeout(() => {
            fileTransferInProgressRef.current.delete(tabId);
            delete g[timerKey];
            cblog('[file-transfer] Local→Remote transfer lock auto-released (no requests for 5s)');
          }, 5000);
        },
        fileContentsResponse: (filesData: any) => {
          try {
            cblog('[file-transfer] ▶ FileContentsResponse raw:', debugPayload(filesData));
            const files = normalizeTransferredFiles(filesData);
            if (files.length === 0) {
              cblog('[file-transfer] ▶ FileContentsResponse: no data or invalid format');
              return;
            }
            cblog('[file-transfer] ▶ FileContentsResponse received:', files.length, 'file(s)');
            // Pre-set remote file basename marker BEFORE invoke to close the timing window.
            const remoteBasenames = files.map(f => f.name.toLowerCase()).sort().join('|');
            remoteClipboardFileKeyRef.current.set(tabId, remoteBasenames);

            const CHUNK_THRESHOLD = 10 * 1024 * 1024; // 10MB
            const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB per invoke
            const totalSize = files.reduce((acc: number, f: any) => acc + (f.data?.length ?? 0), 0);

            const releaseLock = () => {
              setTimeout(() => {
                fileTransferInProgressRef.current.delete(tabId);
                cblog('[file-transfer] Transfer lock released for', tabId);
              }, 2000);
            };

            if (totalSize > CHUNK_THRESHOLD) {
              // ── Chunked transfer for large files ──
              cblog(`[file-transfer] Large file detected (${(totalSize / 1024 / 1024).toFixed(1)}MB), using chunked transfer`);
              (async () => {
                try {
                  const stagedPaths: string[] = [];
                  for (const file of files) {
                    const path = await invoke<string>('clipboard_stage_begin', {
                      sessionId: tabId, fileName: file.name,
                    });
                    const totalChunks = Math.ceil(file.data.length / CHUNK_SIZE);
                    for (let i = 0; i < file.data.length; i += CHUNK_SIZE) {
                      const end = Math.min(i + CHUNK_SIZE, file.data.length);
                      const chunk = file.data.subarray(i, end);
                      await invoke('clipboard_stage_chunk', {
                        path, data: Array.from(chunk),
                      });
                      const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;
                      if (chunkNum % 10 === 0 || chunkNum === totalChunks) {
                        cblog(`[file-transfer] Chunk ${chunkNum}/${totalChunks} for ${file.name}`);
                      }
                    }
                    stagedPaths.push(path);
                  }
                  const result = await invoke<{ strategy: string; staged_paths: string[] }>(
                    'clipboard_stage_commit', { sessionId: tabId, stagedPaths }
                  );
                  cblog('[file-transfer] ✅ Large file staged:', result.strategy, result.staged_paths);
                  setHasClipboardFolder(true);
                } catch (e: any) {
                  cblog('[file-transfer] ❌ Chunked staging failed:', e);
                } finally {
                  releaseLock();
                }
              })();
            } else {
              // ── Small file: existing path ──
              const payloads = files.map((file: any) => ({
                name: file.name,
                data: Array.from(file.data),
              }));
              invoke<{ strategy: string; staged_paths: string[] }>('stage_downloaded_files_for_paste', {
                sessionId: tabId, files: payloads,
              })
                .then(result => {
                  cblog('[file-transfer] ✅ Local clipboard strategy:', result.strategy);
                  cblog('[file-transfer] ✅ Prepared local paste paths:', result.staged_paths);
                  setHasClipboardFolder(Boolean(result.staged_paths.length));
                })
                .catch((e: any) => {
                  cblog('[file-transfer] ❌ Stage for local paste failed:', e);
                })
                .finally(releaseLock);
            }
          } catch (outerErr: any) {
            cblog('[file-transfer] ❌ FileContentsResponse callback crashed:', outerErr);
            // Release lock even on crash to avoid permanent clipboard lockout
            setTimeout(() => {
              fileTransferInProgressRef.current.delete(tabId);
            }, 500);
          }
        },
        fileChunk: (chunkInfo: any) => {
          try {
            const { file_index, file_name, total_size, offset, data, is_last, is_last_file } = chunkInfo;
            const chunkData = data instanceof Uint8Array ? data : new Uint8Array(data);
            // Use a Promise chain per file to guarantee sequential writes
            // (clipboard_stage_begin is async, but WASM chunks arrive synchronously)
            const chainKey = `__chain_${tabId}_${file_index}`;
            const pathKey = `__staged_${tabId}_${file_index}`;

            const prevChain: Promise<void> = (globalThis as any)[chainKey] || Promise.resolve();

            const nextChain = prevChain.then(async () => {
              if (offset === 0) {
                // First chunk → begin staging + write first chunk
                cblog(`[file-transfer] ▶ Chunked download started: ${file_name} (${(total_size / 1024 / 1024).toFixed(1)}MB)`);
                fileTransferInProgressRef.current.add(tabId);
                const path = await invoke<string>('clipboard_stage_begin', {
                  sessionId: tabId, fileName: file_name,
                });
                (globalThis as any)[pathKey] = path;
                await invoke('clipboard_stage_chunk', { path, data: Array.from(chunkData) });
              } else {
                // Subsequent chunks → append
                const path = (globalThis as any)[pathKey];
                if (path) {
                  await invoke('clipboard_stage_chunk', { path, data: Array.from(chunkData) });
                } else {
                  cblog(`[file-transfer] ⚠ No path for chunk at offset=${offset}, skipping`);
                }
              }

              // Log progress
              const chunkNum = Math.floor(offset / (2 * 1024 * 1024)) + 1;
              const totalChunks = Math.ceil(total_size / (2 * 1024 * 1024));
              if (chunkNum % 10 === 0 || is_last) {
                cblog(`[file-transfer] Chunk ${chunkNum}/${totalChunks} for ${file_name}`);
              }

              // All files done → commit
              if (is_last_file && is_last) {
                cblog('[file-transfer] All chunked downloads complete, committing to clipboard');
                const stagedPaths: string[] = [];
                for (let i = 0; i <= file_index; i++) {
                  const k = `__staged_${tabId}_${i}`;
                  const ck = `__chain_${tabId}_${i}`;
                  const p = (globalThis as any)[k];
                  if (p) {
                    stagedPaths.push(p);
                    delete (globalThis as any)[k];
                  }
                  delete (globalThis as any)[ck];
                }
                if (stagedPaths.length > 0) {
                  const remoteBasenames = stagedPaths.map(p => {
                    const parts = p.split('/');
                    return (parts[parts.length - 1] || '').toLowerCase();
                  }).sort().join('|');
                  remoteClipboardFileKeyRef.current.set(tabId, remoteBasenames);

                  const result = await invoke<{ strategy: string; staged_paths: string[] }>(
                    'clipboard_stage_commit', { sessionId: tabId, stagedPaths }
                  );
                  cblog('[file-transfer] ✅ Chunked transfer committed:', result.strategy, result.staged_paths);
                  setHasClipboardFolder(true);
                }
                setTimeout(() => {
                  fileTransferInProgressRef.current.delete(tabId);
                  cblog('[file-transfer] Transfer lock released');
                }, 2000);
              }
            }).catch((e: any) => {
              cblog('[file-transfer] ❌ chunk pipeline error:', e);
            });

            (globalThis as any)[chainKey] = nextChain;
          } catch (err: any) {
            cblog('[file-transfer] ❌ fileChunkCallback crashed:', err);
            fileTransferInProgressRef.current.delete(tabId);
          }
        },
      });

      stopFpsCounter();

      if (server.domain) builder.serverDomain(server.domain);

      // ── RDPDR Drive Redirection (Jump-style shared folder route) ──
      if (store.folderSharingEnabled) {
      const RDPDR_PREFETCH_WINDOW = 1024 * 1024;
      const RDPDR_MAX_CACHED_WINDOWS = 8;
      const rdpdrWindowCache = new Map<string, Uint8Array>();
      const rdpdrWindowOrder: string[] = [];
      const rdpdrInFlightReads = new Map<string, Promise<Uint8Array>>();
      let rdpdrSharedFolder = '';
      try {
        let homeDir = '';
        try {
          const pathModule = await import('@tauri-apps/api/path');
          homeDir = await pathModule.homeDir();
          if (homeDir.endsWith('/') || homeDir.endsWith('\\')) {
            homeDir = homeDir.slice(0, -1);
          }
        } catch {
          homeDir = '/tmp';
        }
        const configuredSharedFolder = server.sharedFolder?.trim();
        rdpdrSharedFolder = configuredSharedFolder || `${homeDir}/Downloads`;
        cblog('[rdpdr] Shared folder:', rdpdrSharedFolder);

        let driveEntries: any[] = [];
        try {
          driveEntries = await invoke<any[]>('rdpdr_scan_folder_metadata', {
            folderPath: rdpdrSharedFolder,
          });
          cblog('[rdpdr] Scanned entries:', driveEntries.length, 'from', rdpdrSharedFolder);
        } catch (e) {
          cblog('[rdpdr] Folder scan failed:', e);
        }

        const capturedFolder = rdpdrSharedFolder;
        const rdpdrReadCallback = (path: string, offset: number, length: number): Promise<Uint8Array> => {
          const windowStart = Math.floor(offset / RDPDR_PREFETCH_WINDOW) * RDPDR_PREFETCH_WINDOW;
          const windowKey = `${path}:${windowStart}`;
          const sliceWindow = (windowData: Uint8Array) => {
            const sliceStart = offset - windowStart;
            const sliceEnd = Math.min(sliceStart + length, windowData.length);
            return new Uint8Array(windowData.slice(sliceStart, sliceEnd));
          };
          const cachedWindow = rdpdrWindowCache.get(windowKey);
          if (cachedWindow) {
            return Promise.resolve(sliceWindow(cachedWindow));
          }
          const inFlight = rdpdrInFlightReads.get(windowKey);
          if (inFlight) {
            return inFlight.then(windowData => sliceWindow(windowData));
          }
          const readLength = Math.max(length, RDPDR_PREFETCH_WINDOW);
          const readPromise = invoke<ArrayBuffer>('rdpdr_read_file_chunk', {
            baseFolder: capturedFolder,
            relativePath: path,
            offset: windowStart,
            length: readLength,
          }).then(data => {
            const arr = new Uint8Array(data);
            if (arr.length > 0) {
              rdpdrWindowCache.set(windowKey, arr);
              rdpdrWindowOrder.push(windowKey);
              while (rdpdrWindowOrder.length > RDPDR_MAX_CACHED_WINDOWS) {
                const oldest = rdpdrWindowOrder.shift();
                if (oldest) {
                  rdpdrWindowCache.delete(oldest);
                }
              }
            }
            return arr;
          }).finally(() => {
            rdpdrInFlightReads.delete(windowKey);
          });
          rdpdrInFlightReads.set(windowKey, readPromise);
          return readPromise.then(windowData => sliceWindow(windowData));
        };
        applyIronRdpRdpdrDriveSharingExtensions(wasm, builder, {
          shareName: 'NextDesk',
          driveEntries,
          readCallback: rdpdrReadCallback,
        });
        cblog('[rdpdr] drive_share_name extension configured:', 'NextDesk');
        if (driveEntries.length > 0) {
          cblog('[rdpdr] drive_entries extension configured:', driveEntries.length);
        } else {
          cblog('[rdpdr] Shared folder is empty or metadata scan returned no entries');
        }
        rdpdrEnabledRef.current.add(tabId);
        cblog('[rdpdr] RDPDR drive sharing enabled:', `NextDesk -> ${rdpdrSharedFolder}`);
      } catch (rdpdrError) {
        rdpdrEnabledRef.current.delete(tabId);
        cblog('[rdpdr] RDPDR initialization failed:', rdpdrError);
        try {
          applyIronRdpRdpdrDriveSharingExtensions(wasm, builder, { shareName: 'NextDesk' });
          cblog('[rdpdr] drive_share_name fallback configured:', 'NextDesk');
        } catch {
          // The fallback extension is best-effort; the session can continue without RDPDR.
        }
      }
      } else {
        rdpdrEnabledRef.current.delete(tabId);
        cblog('[rdpdr] Folder sharing disabled in settings, skipping RDPDR');
      }
      // 6. Register CLIPRDR file read callback for lazy loading of large clipboard files
      // Uses absolute paths (unlike RDPDR which uses baseFolder + relativePath)
      // Prefetch window: read 2MB at a time and cache to reduce IPC calls (~8x fewer trips)
      const CLIPRDR_PREFETCH_WINDOW = 2 * 1024 * 1024; // 2MB
      const CLIPRDR_MAX_CACHED_WINDOWS = 4;
      const cliprdrWindowCache = new Map<string, Uint8Array>();
      const cliprdrWindowOrder: string[] = [];
      const cliprdrInFlightReads = new Map<string, Promise<Uint8Array>>();
      let cliprdrLastLoggedMB = -1;
      const cliprdrReadCallback = (path: string, offset: number, length: number): Promise<Uint8Array> => {
        // Log progress every 10MB instead of every chunk
        const currentMB = Math.floor(offset / (10 * 1024 * 1024));
        if (currentMB !== cliprdrLastLoggedMB) {
          cliprdrLastLoggedMB = currentMB;
          rdpLog.debug('file', `Transfer progress: ${path.split('/').pop()} offset=${(offset / 1024 / 1024).toFixed(1)}MB`);
        }
        const windowStart = Math.floor(offset / CLIPRDR_PREFETCH_WINDOW) * CLIPRDR_PREFETCH_WINDOW;
        const windowKey = `${path}:${windowStart}`;
        const sliceWindow = (windowData: Uint8Array) => {
          const sliceStart = offset - windowStart;
          const sliceEnd = Math.min(sliceStart + length, windowData.length);
          return new Uint8Array(windowData.slice(sliceStart, sliceEnd));
        };
        const cachedWindow = cliprdrWindowCache.get(windowKey);
        if (cachedWindow) {
          return Promise.resolve(sliceWindow(cachedWindow));
        }
        const inFlight = cliprdrInFlightReads.get(windowKey);
        if (inFlight) {
          return inFlight.then(windowData => sliceWindow(windowData));
        }
        const readLength = Math.max(length, CLIPRDR_PREFETCH_WINDOW);
        const readPromise = invoke<ArrayBuffer>('rdpdr_read_file_chunk', {
          baseFolder: '',
          relativePath: path,
          offset: windowStart,
          length: readLength,
        }).then(data => {
          const arr = new Uint8Array(data);
          if (arr.length > 0) {
            cliprdrWindowCache.set(windowKey, arr);
            cliprdrWindowOrder.push(windowKey);
            while (cliprdrWindowOrder.length > CLIPRDR_MAX_CACHED_WINDOWS) {
              const oldest = cliprdrWindowOrder.shift();
              if (oldest) cliprdrWindowCache.delete(oldest);
            }
          }
          return arr;
        }).finally(() => {
          cliprdrInFlightReads.delete(windowKey);
        });
        cliprdrInFlightReads.set(windowKey, readPromise);
        return readPromise.then(windowData => sliceWindow(windowData));
      };
      builder.extension(new wasm.Extension('cliprdr_read_callback', cliprdrReadCallback));

      if (OFFICIAL_WEB_FEATURES.audio) {
        // Enable audio redirection via RDPSND → native cpal backend
        const audioCallback = (type: string, data: any) => {
          switch (type) {
            case 'format':
              rdpLog.info('audio', `RDPSND format: ${data.channels}ch ${data.sampleRate}Hz ${data.bitsPerSample}bit ${data.formatTag}`);
              invoke('rdp_audio_set_format', {
                tabId,
                channels: data.channels,
                sampleRate: data.sampleRate,
                bitsPerSample: data.bitsPerSample,
                formatTag: data.formatTag,
              }).catch(e => rdpLog.error('audio', 'set_format failed', e));
              break;
            case 'wave':
              // Send PCM as raw binary via InvokeBody::Raw (6× less IPC overhead)
              invoke('rdp_audio_push_raw', data as Uint8Array, {
                headers: { 'X-Tab-Id': tabId },
              }).catch(() => {}); // fire-and-forget for low latency
              break;
            case 'volume':
              rdpLog.debug('audio', `RDPSND volume: L=${data.left} R=${data.right}`);
              break;
            case 'close':
              invoke('rdp_audio_close', { tabId }).catch(() => {});
              break;
          }
        };
        applyIronRdpRdpsndAudioCallback(wasm, builder, { audio: audioCallback });
        rdpLog.info('audio', 'RDPSND audio redirection enabled (native cpal backend)');
      } else {
        rdpLog.info('audio', 'official-web audio extensions disabled');
      }

      const triggerOfficialWebGfxFallback = (input: OfficialWebGfxFallbackInput) => {
        const decision = describeOfficialWebGfxFallback(input);
        if (!decision.shouldFallback) return;
        if (
          officialWebGfxDisabledByFallbackRef.current.has(tabId) ||
          officialWebGfxFallbackInFlightRef.current.has(tabId)
        ) {
          rdpLog.warn('display', 'official-web GFX fallback already active', {
            tabId,
            reason: decision.reason,
            bitmapHexPrefix: input.bitmapHexPrefix,
            payloadHexPrefix: input.payloadHexPrefix,
          });
          return;
        }

        officialWebGfxDisabledByFallbackRef.current.add(tabId);
        officialWebGfxFallbackInFlightRef.current.add(tabId);
        rdpLog.warn('display', 'official-web GFX fallback: reconnecting without GFX', {
          tabId,
          reason: decision.reason,
          codec: input.codec,
          detail: input.detail,
          bitmapHexPrefix: input.bitmapHexPrefix,
          payloadHexPrefix: input.payloadHexPrefix,
        });

        userDisconnectedRef.current.add(tabId);
        cleanupH264Worker(tabId);
        const session = sessionRefs.current.get(tabId);
        if (session) {
          try { session.shutdown(); } catch { /* ignore fallback shutdown errors */ }
        }
        connectingTabsRef.current.delete(tabId);
        sessionRefs.current.delete(tabId);
        store.updateTabStatus(tabId, 'connecting');

        setTimeout(() => {
          officialWebGfxFallbackInFlightRef.current.delete(tabId);
          userDisconnectedRef.current.delete(tabId);
          connectSessionRef.current?.(tabId);
        }, 500);
      };

      if (officialWebGfxEnabled && typeof VideoDecoder !== 'undefined') {
        const existingOverlay = h264OverlayRefs.current.get(tabId);
        if (existingOverlay) {
          gfxCompositorRefs.current.set(tabId, new GfxSurfaceCompositor(existingOverlay));
        }

        try {
          const worker = new Worker(DecodeWorkerUrl, { type: 'module' });
          decodeWorkerRef.current = worker;
          worker.postMessage({ type: 'configure', codec: 'avc1.64001f' });

          worker.onmessage = (e: MessageEvent) => {
            const msg = e.data;
            if (msg.type === 'frame') {
              const frame = msg.frame as VideoFrame;
              const compositor = gfxCompositorRefs.current.get(tabId);
              if (compositor && msg.rect) {
                compositor.drawVideoFrame(Number(msg.surfaceId ?? 0), frame, msg.rect);
              } else {
                const overlay = h264OverlayRefs.current.get(tabId);
                if (overlay) {
                  drawDecodedH264FrameToOverlay(overlay, frame, msg.rect);
                }
              }
              frame.close();
            } else if (msg.type === 'error') {
              const detail = msg.message || 'unknown';
              rdpLog.warn('display', 'h264 worker error', { message: detail });
              triggerOfficialWebGfxFallback({ type: 'decode_error', detail });
            }
          };
        } catch (e) {
          rdpLog.warn('display', 'Worker creation failed, official-web GFX disabled for this attempt', {
            error: String(e),
          });
          decodeWorkerRef.current = null;
        }

        const gfxCallback = (type: string, data: any) => {
          const codec = typeof data?.codec === 'string' ? data.codec : undefined;
          const getCompositor = () => {
            const existing = gfxCompositorRefs.current.get(tabId);
            if (existing) return existing;
            const overlay = h264OverlayRefs.current.get(tabId);
            if (!overlay) return null;
            const compositor = new GfxSurfaceCompositor(overlay);
            gfxCompositorRefs.current.set(tabId, compositor);
            return compositor;
          };
          const compositor = getCompositor();

          if (type === 'reset_graphics' && compositor) {
            compositor.resetGraphics(Number(data?.width || 1), Number(data?.height || 1));
            return;
          }

          if (type === 'create_surface' && compositor) {
            compositor.createSurface(Number(data?.surfaceId), Number(data?.width || 1), Number(data?.height || 1));
            return;
          }

          if (type === 'delete_surface' && compositor) {
            const surfaceId = typeof data === 'number' ? data : data?.surfaceId;
            compositor.deleteSurface(Number(surfaceId));
            return;
          }

          if (type === 'map_surface' && compositor) {
            compositor.mapSurface(Number(data?.surfaceId), Number(data?.x || 0), Number(data?.y || 0));
            return;
          }

          if (type === 'end_frame' && compositor) {
            compositor.endFrame(Number(typeof data === 'number' ? data : data?.frameId || 0));
            return;
          }

          if (type === 'solid_fill' && compositor) {
            compositor.solidFill(Number(data.surfaceId), {
              left: Number(data.left ?? 0),
              top: Number(data.top ?? 0),
              right: Number(data.right ?? 0),
              bottom: Number(data.bottom ?? 0),
            }, Number(data.color ?? 0xffffffff));
            return;
          }

          if (type === 'surface_to_surface' && compositor) {
            compositor.surfaceToSurface(
              Number(data.srcSurfaceId),
              Number(data.dstSurfaceId),
              {
                left: Number(data.srcLeft ?? 0),
                top: Number(data.srcTop ?? 0),
                right: Number(data.srcRight ?? 0),
                bottom: Number(data.srcBottom ?? 0),
              },
              { x: Number(data.dstX ?? 0), y: Number(data.dstY ?? 0) },
            );
            return;
          }

          if (type === 'surface_to_cache' && compositor) {
            compositor.surfaceToCache(Number(data.surfaceId), Number(data.cacheSlot), {
              left: Number(data.left ?? 0),
              top: Number(data.top ?? 0),
              right: Number(data.right ?? 0),
              bottom: Number(data.bottom ?? 0),
            });
            return;
          }

          if (type === 'cache_to_surface' && compositor) {
            compositor.cacheToSurface(Number(data.surfaceId), Number(data.cacheSlot), {
              x: Number(data.dstX ?? 0),
              y: Number(data.dstY ?? 0),
            });
            return;
          }

          if (type === 'evict_cache' && compositor) {
            compositor.evictCache(Number(data.cacheSlot));
            return;
          }

          if (type === 'gfx_codec') {
            rdpLog.info('display', 'official-web GFX codec', {
              codec,
              h264: Boolean(data?.h264),
              surfaceId: data?.surfaceId,
              dataLen: data?.dataLen,
              rect: {
                left: data?.left,
                top: data?.top,
                right: data?.right,
                bottom: data?.bottom,
              },
            });
            return;
          }

          if (type === 'clearcodec_frame') {
            rdpLog.info('display', 'official-web ClearCodec frame', {
              codec,
              surfaceId: data?.surfaceId,
              width: data?.width,
              height: data?.height,
              flags: data?.flags,
              residual: Boolean(data?.residual),
              banding: Boolean(data?.banding),
              subcodec: Boolean(data?.subcodec),
              sequenceNumber: data?.sequenceNumber,
              payloadLen: data?.payloadLen,
              residualByteCount: data?.residualByteCount,
              bandsByteCount: data?.bandsByteCount,
              subcodecByteCount: data?.subcodecByteCount,
              patchCount: data?.patchCount,
              bitmapHexPrefix: data?.bitmapHexPrefix || data?.hexPrefix,
              payloadHexPrefix: data?.payloadHexPrefix,
              rect: {
                left: data?.left,
                top: data?.top,
                right: data?.right,
                bottom: data?.bottom,
              },
            });
            return;
          }

          if (type === 'clearcodec_rgba_patch') {
            if (compositor && data?.data && data?.width > 0 && data?.height > 0) {
              compositor.drawRgbaPatch({
                surfaceId: Number(data.surfaceId),
                rect: {
                  left: Number(data.left ?? 0),
                  top: Number(data.top ?? 0),
                  right: Number(data.right ?? data.width ?? 0),
                  bottom: Number(data.bottom ?? data.height ?? 0),
                },
                width: Number(data.width),
                height: Number(data.height),
                data: data.data,
              });
            }

            const patchCount = (officialWebClearCodecPatchCountRef.current.get(tabId) ?? 0) + 1;
            officialWebClearCodecPatchCountRef.current.set(tabId, patchCount);
            if (patchCount <= 3 || patchCount % 60 === 0) {
              rdpLog.info('display', 'official-web ClearCodec RGBA patch', {
                tabId,
                patchCount,
                codec,
                surfaceId: data?.surfaceId,
                width: data?.width,
                height: data?.height,
                bytes: data?.data?.byteLength,
                rect: {
                  left: data?.left,
                  top: data?.top,
                  right: data?.right,
                  bottom: data?.bottom,
                },
              });
            }
            return;
          }

          const fallbackDecision = describeOfficialWebGfxFallback({
            type,
            codec,
            detail: data?.message || data?.detail || codec,
            bitmapHexPrefix: data?.bitmapHexPrefix || data?.hexPrefix,
            payloadHexPrefix: data?.payloadHexPrefix,
          });
          if (fallbackDecision.shouldFallback) {
            triggerOfficialWebGfxFallback({
              type,
              codec,
              detail: data?.message || data?.detail || codec,
              bitmapHexPrefix: data?.bitmapHexPrefix || data?.hexPrefix,
              payloadHexPrefix: data?.payloadHexPrefix,
            });
            return;
          }

          if (type === 'h264_frame' && decodeWorkerRef.current) {
            const frameCount = (officialWebH264FrameCountRef.current.get(tabId) ?? 0) + 1;
            officialWebH264FrameCountRef.current.set(tabId, frameCount);
            if (frameCount <= 3 || frameCount % 60 === 0) {
              rdpLog.info('display', 'official-web H.264 frame', {
                tabId,
                frameCount,
                codec,
                surfaceId: data?.surfaceId,
                bytes: data?.data?.byteLength,
              });
            }
            const buf = data.data.buffer.slice(0);
            decodeWorkerRef.current.postMessage(
              {
                type: 'decode',
                data: buf,
                timestamp: performance.now() * 1000,
                surfaceId: Number(data.surfaceId ?? 0),
                rect: {
                  left: data.left ?? 0,
                  top: data.top ?? 0,
                  right: data.right ?? data.width ?? 0,
                  bottom: data.bottom ?? data.height ?? 0,
                },
              },
              [buf],
            );
          } else if (type === 'h264_frame') {
            triggerOfficialWebGfxFallback({
              type: 'decode_error',
              codec,
              detail: 'worker-unavailable',
            });
          }
        };
        applyIronRdpGfxH264Callback(wasm, builder, { gfx: gfxCallback });
        rdpLog.info('display', 'GFX H.264 pipeline enabled (WebCodecs Worker)');
      } else {
        rdpLog.info('display', officialWebGfxEnabled
          ? 'WebCodecs not available, official-web GFX disabled'
          : officialWebGfxDisabledByFallback
            ? 'official-web GFX disabled by fallback for this tab'
          : OFFICIAL_WEB_FEATURES.gfxRequested
            ? 'official-web GFX requested but disabled'
          : 'official-web GFX extension disabled');
      }

      // Enable DisplayControl DVC for dynamic resolution updates (no reconnect needed)
      if (OFFICIAL_WEB_FEATURES.displayControl) {
        applyIronRdpDisplayControlExtension(wasm, builder, true);
        rdpLog.info('display', 'DisplayControl DVC enabled for dynamic resolution');
      } else {
        rdpLog.info('display', 'DisplayControl DVC disabled');
      }

      if (OFFICIAL_WEB_FEATURES.fileTransfer) {
        // Enable file transfer WS bypass for large CLIPRDR files (≥2MB)
        const ftPort = await invoke<number>('get_file_transfer_ws_port').catch(() => 0);
        if (ftPort > 0) {
          builder.extension(new wasm.Extension('file_transfer_port', ftPort));
          rdpLog.info('file', `File transfer WS port: ${ftPort} (large file bypass enabled)`);
        }
      } else {
        rdpLog.info('file', 'official-web file transfer WS disabled');
      }

      const session = await builder.connect();
      rdpLog.info('rdp', 'official ironrdp web connected', {
        attemptId,
        tabId,
        host: server.host,
        port: server.port,
      });
      sessionRefs.current.set(tabId, session);
      store.updateTabStatus(tabId, 'connected');
      reconnectCountRef.current.delete(tabId);

      // Re-activate resize cooldown AFTER connect succeeds.
      // Even though the status bar is now an auto-hide overlay,
      // status transitions can cause layout shifts. This prevents spurious adaptive resize.
      resizeCooldownRef.current = true;
      setTimeout(() => {
        const cur = getCanvasSize();
        if (cur.w > 0 && cur.h > 0) lastSizeRef.current = { w: cur.w, h: cur.h };
        resizeCooldownRef.current = false;
      }, 1500);

      // Check what resolution the server actually gave us
      const negotiated = session.desktopSize();
      rdpLog.info('rdp', `negotiated resolution: ${negotiated.width} x ${negotiated.height} (requested ${w} x ${h})`);
      setRdpStats(prev => ({ ...prev, resolution: `${negotiated.width}×${negotiated.height}`, status: 'connected' }));

      startOfficialWebFpsCounter(tabId, canvas);
      startCloudKeepalive(tabId, server.host, server.port);

      // Try dynamic resize first (may not work if DVC not ready)
      setTimeout(() => {
        if (!sessionRefs.current.has(tabId)) return;
        const currentTab = store.tabs.find(t => t.id === tabId);
        if (!currentTab || currentTab.status !== 'connected') return;
        const { w: curW, h: curH } = getCanvasSize();
        const cur = session.desktopSize();
        const dpr = window.devicePixelRatio || 1;
        if (curW > 0 && curH > 0 && (cur.width !== curW || cur.height !== curH)) {
          rdpLog.warn('display', `delayed resize attempt: ${curW} x ${curH} DPR: ${dpr}`);
          try { session.resize(curW, curH); } catch (e) { rdpLog.warn('display', 'resize failed', { error: e }); }
        }
      }, 2000);

      const info = await session.run();
      const reason = info?.reason?.() || 'unknown';
      rdpLog.info('rdp', 'session.ended', { attemptId, tabId, reason });
      connectingTabsRef.current.delete(tabId);
      attemptIdsRef.current.delete(tabId);
      sessionRefs.current.delete(tabId);
      advertisedClipboardRef.current.delete(tabId);
      forceClipboardReadInFlightRef.current.delete(tabId);
      rdpdrEnabledRef.current.delete(tabId);
      pasteShortcutInFlightRef.current.delete(tabId);
      keepCursorVisibleUntilRef.current.delete(tabId);
      fileTransferInProgressRef.current.delete(tabId);
      clipboardPollInFlightRef.current.delete(tabId);
      stopFpsCounter(tabId);
      // Cleanup H.264 worker
      if (decodeWorkerRef.current) { decodeWorkerRef.current.postMessage({ type: 'close' }); decodeWorkerRef.current.terminate(); decodeWorkerRef.current = null; }
      // Hide H.264 overlay for this tab
      const overlay = h264OverlayRefs.current.get(tabId);
      if (overlay) overlay.style.opacity = '0';
      officialWebH264FrameCountRef.current.delete(tabId);
      officialWebClearCodecPatchCountRef.current.delete(tabId);
      delete (globalThis as any).__nextdesk_fps_count;
      setRdpStats({ resolution: '', fps: 0, status: 'disconnected' });

      // Auto-reconnect: skip if user explicitly closed
      if (userDisconnectedRef.current.has(tabId)) {
        userDisconnectedRef.current.delete(tabId);
        store.updateTabStatus(tabId, 'disconnected');
      } else {
        // Check if the disconnect reason is non-recoverable
        if (isNonRecoverableRdpError(reason)) {
          rdpLog.warn('rdp', 'non-recoverable disconnect', { reason });
          store.updateTabStatus(tabId, 'error', friendlyRdpError(reason, t));
        } else {
          scheduleReconnect(tabId, reason);
        }
      }
    } catch (err: any) {
      rdpLog.error('rdp', 'connect.failed', {
        attemptId,
        tabId,
        host: server.host,
        port: server.port,
        error: err?.backtrace?.() || err?.message || String(err),
      });
      const raw = err?.backtrace?.() || err?.message || String(err);
      connectingTabsRef.current.delete(tabId);
      cleanupNativeFrameStream(tabId);
      attemptIdsRef.current.delete(tabId);
      sessionRefs.current.delete(tabId);
      advertisedClipboardRef.current.delete(tabId);
      forceClipboardReadInFlightRef.current.delete(tabId);
      rdpdrEnabledRef.current.delete(tabId);
      pasteShortcutInFlightRef.current.delete(tabId);
      keepCursorVisibleUntilRef.current.delete(tabId);
      fileTransferInProgressRef.current.delete(tabId);
      clipboardPollInFlightRef.current.delete(tabId);

      // Non-recoverable errors: don't reconnect
      const lower = raw.toLowerCase();
      if (isNonRecoverableRdpError(raw) || lower.includes('wrong') || lower.includes('password')) {
        store.updateTabStatus(tabId, 'error', friendlyRdpError(raw, t));
      } else if (!userDisconnectedRef.current.has(tabId)) {
        scheduleReconnect(tabId, raw);
      } else {
        userDisconnectedRef.current.delete(tabId);
        store.updateTabStatus(tabId, 'error', friendlyRdpError(raw, t));
      }
    }
  }, [store, proxyPort, getCanvasSize, selectKktermRdpDesktopSize, waitForCanvas, waitForKktermWindowsLayoutReady, ensureH264Worker, cleanupNativeFrameStream, forgetNativeResizeState, markNativeTabConnected, scheduleKktermWindowsPostConnectSettle, scheduleReconnect, startCloudKeepalive, startNativeFpsCounter, startOfficialWebFpsCounter, stopFpsCounter, updateNativeResolution]);
  connectSessionRef.current = connectSession;

  // Reset reconnect counter on successful connection
  useEffect(() => {
    const activeTab = store.activeTab;
    if (activeTab?.status === 'connected' && activeTab.id) {
      reconnectCountRef.current.delete(activeTab.id);
    }
  }, [store.activeTab?.status]);

  const handleConnectServer = useCallback((serverId: string) => {
    const server = store.getServerById(serverId);
    if (!server) return;
    store.setSidebarOpen(false);
    onMainSidebarCollapse?.();
    const tabId = store.openSession(server);
    // Only skip if already connected/connecting/reconnecting.
    // For idle, error, disconnected, or newly created (not yet in state) → connect.
    const existingTab = store.tabs.find(t => t.id === tabId);
    const skipStatuses = ['connected', 'connecting', 'reconnecting'];
    if (!existingTab || !skipStatuses.includes(existingTab.status)) {
      // Use ref to get the LATEST connectSession (avoids stale closure where
      // store.tabs doesn't include the newly created tab yet)
      setTimeout(() => connectSessionRef.current?.(tabId), 150);
    }
  }, [store, onMainSidebarCollapse]);

  // Single-click: just highlight the server in sidebar, no tab/RDP page opened
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const handleSelectServer = useCallback((serverId: string) => {
    setSelectedServerId(prev => prev === serverId ? null : serverId);
  }, []);

  const handleCloseTab = useCallback((tabId: string) => {
    // Mark as user-initiated to prevent auto-reconnect
    userDisconnectedRef.current.add(tabId);
    // Cancel any pending reconnect timer
    const timer = reconnectTimerRef.current.get(tabId);
    if (timer) { clearTimeout(timer); reconnectTimerRef.current.delete(tabId); }
    reconnectCountRef.current.delete(tabId);
    stopCloudKeepalive(tabId);
    // Disconnect native session if any
    if (nativeTabsRef.current.has(tabId)) {
      api.rdpNativeDisconnect(tabId, nativeRouteLeaseIdsRef.current.get(tabId)).catch(() => {});
      nativeTabsRef.current.delete(tabId);
      nativeRouteLeaseIdsRef.current.delete(tabId);
    }
    if (kktermTabsRef.current.has(tabId)) {
      kktermRdpDisconnect({
        tabId,
        routeLeaseId: kktermRouteLeaseIdsRef.current.get(tabId),
      }).catch(() => {});
      kktermTabsRef.current.delete(tabId);
      kktermRouteLeaseIdsRef.current.delete(tabId);
      kktermViewLastBoundsByTabRef.current.delete(tabId);
    }
    setKktermRdpLaunch(prev => {
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    setKktermRdpWinSignalByTab(prev => {
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    setKktermRdpCadSignalByTab(prev => {
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    setKktermRdpTextSignalByTab(prev => {
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    cleanupNativeFrameStream(tabId);
    forgetNativeResizeState(tabId);
    stopFpsCounter(tabId);
    cleanupH264Worker(tabId);
    officialWebGfxDisabledByFallbackRef.current.delete(tabId);
    officialWebGfxFallbackInFlightRef.current.delete(tabId);
    officialWebH264FrameCountRef.current.delete(tabId);
    officialWebClearCodecPatchCountRef.current.delete(tabId);
    attemptIdsRef.current.delete(tabId);
    // Shutdown WASM session if any
    const session = sessionRefs.current.get(tabId);
    if (session) {
      try {
        session.shutdown();
      } catch {
        // The session may already be closed by the transport error path.
      }
      sessionRefs.current.delete(tabId);
    }
    connectingTabsRef.current.delete(tabId);
    advertisedClipboardRef.current.delete(tabId);
    forceClipboardReadInFlightRef.current.delete(tabId);
    rdpdrEnabledRef.current.delete(tabId);
    pasteShortcutInFlightRef.current.delete(tabId);
    keepCursorVisibleUntilRef.current.delete(tabId);
    // Cleanup native audio player
    invoke('rdp_audio_close', { tabId }).catch(() => {});
    store.closeTab(tabId);
    // Auto-open sidebar when closing the last tab
    if (store.tabs.length <= 1) {
      store.setSidebarOpen(true);
    }
  }, [store, cleanupH264Worker, cleanupNativeFrameStream, forgetNativeResizeState, stopCloudKeepalive, stopFpsCounter]);

  const handleNewSaved = useCallback((serverId: string, connect: boolean) => {
    setShowNewConn(false);
    if (connect) handleConnectServer(serverId);
  }, [handleConnectServer]);

  // ── Reconnect helper (shared by resolution switch and adaptive resize) ──
  const reconnectWithSize = useCallback((tabId: string, w?: number, h?: number) => {
    if (w && h) {
      desiredSizeRef.current = { w, h };
    } else {
      desiredSizeRef.current = null; // adaptive = use wrapper size
    }
    let nextKktermDesktopSize: { width: number; height: number } | undefined;
    if (USE_KKTERM_COPY_MACOS) {
      const size = w && h
        ? { width: Math.round(w), height: Math.round(h) }
        : (() => {
            const current = getCanvasSize();
            return { width: Math.round(current.w), height: Math.round(current.h) };
          })();
      nextKktermDesktopSize = {
        width: Math.max(320, size.width),
        height: Math.max(240, size.height),
      };
    }
    // Mark as user-initiated so session end handler won't trigger yellow reconnect UI
    userDisconnectedRef.current.add(tabId);
    stopCloudKeepalive(tabId);
    const disconnects: Promise<unknown>[] = [];
    // Finish the old engine before a replacement can claim the same tab route.
    if (nativeTabsRef.current.has(tabId)) {
      disconnects.push(api.rdpNativeDisconnect(
        tabId,
        nativeRouteLeaseIdsRef.current.get(tabId),
      ));
      nativeTabsRef.current.delete(tabId);
      nativeRouteLeaseIdsRef.current.delete(tabId);
    }
    if (kktermTabsRef.current.has(tabId)) {
      disconnects.push(kktermRdpDisconnect({
        tabId,
        routeLeaseId: kktermRouteLeaseIdsRef.current.get(tabId),
      }));
      kktermTabsRef.current.delete(tabId);
      kktermRouteLeaseIdsRef.current.delete(tabId);
      kktermViewLastBoundsByTabRef.current.delete(tabId);
    }
    cleanupNativeFrameStream(tabId);
    forgetNativeResizeState(tabId);
    stopFpsCounter(tabId);
    cleanupH264Worker(tabId);
    officialWebH264FrameCountRef.current.delete(tabId);
    officialWebClearCodecPatchCountRef.current.delete(tabId);
    attemptIdsRef.current.delete(tabId);
    const session = sessionRefs.current.get(tabId);
    if (session) {
      try { session.shutdown(); } catch { /* ignore */ }
    }
    connectingTabsRef.current.delete(tabId);
    sessionRefs.current.delete(tabId);
    advertisedClipboardRef.current.delete(tabId);
    forceClipboardReadInFlightRef.current.delete(tabId);
    rdpdrEnabledRef.current.delete(tabId);
    pasteShortcutInFlightRef.current.delete(tabId);
    keepCursorVisibleUntilRef.current.delete(tabId);
    // Use reconnecting so connectSession can pass its duplicate-connection guard.
    store.updateTabStatus(tabId, 'reconnecting');
    void Promise.allSettled(disconnects).then(() => {
      if (nextKktermDesktopSize) {
        setKktermRdpLaunch(prev => ({
          ...prev,
          [tabId]: {
            nonce: (prev[tabId]?.nonce ?? 0) + 1,
            desktopSize: nextKktermDesktopSize,
            reuseCloudBinding: false,
          },
        }));
      }
      window.setTimeout(() => {
        userDisconnectedRef.current.delete(tabId);
        connectSessionRef.current?.(tabId);
      }, 500);
    });
  }, [store, cleanupH264Worker, cleanupNativeFrameStream, forgetNativeResizeState, getCanvasSize, stopCloudKeepalive, stopFpsCounter]);

  cloudBindingRecoveryRef.current = (tabId: string) => {
    const desiredSize = desiredSizeRef.current;
    reconnectWithSize(tabId, desiredSize?.w, desiredSize?.h);
  };

  const performAdaptiveResize = useCallback((reason: string) => {
    if (resModeRef.current !== 'adaptive') return;
    if (resizeCooldownRef.current) return;

    const wrap = canvasWrapRef.current;
    if (!wrap || !wrap.offsetParent) return;

    const tabId = activeTabIdRef.current;
    if (!tabId) return;

    const tab = tabsRef.current.find(t => t.id === tabId);
    if (tab?.status !== 'connected') return;
    const server = store.getServerById(tab.serverId);

    if (fileTransferInProgressRef.current.has(tabId)) return;

    let { w, h } = getCanvasSize();
    if (w <= 0 || h <= 0) return;

    const isNativeTab = USE_NATIVE_RDP && nativeTabsRef.current.has(tabId);
    const isKktermMacTab = USE_KKTERM_COPY_MACOS && kktermTabsRef.current.has(tabId);
    const isKktermWindowsTab = USE_KKTERM_COPY_WINDOWS && kktermTabsRef.current.has(tabId);
    let nativeCappedResizeLog: {
      requested: NativeResizeSize;
      capped: NativeResizeSize;
    } | null = null;
    if (isNativeTab) {
      const normalized = normalizeNativeDesktopSizeForHost(w, h, server?.host);
      if (normalized.capped && (normalized.w !== w || normalized.h !== h)) {
        nativeCappedResizeLog = {
          requested: { w, h },
          capped: { w: normalized.w, h: normalized.h },
        };
      }
      w = normalized.w;
      h = normalized.h;
    }

    const currentSize = isNativeTab
      ? nativeActualSizeByTabRef.current.get(tabId)
      : lastSizeRef.current;
    if (currentSize) {
      const dw = Math.abs(w - currentSize.w);
      const dh = Math.abs(h - currentSize.h);
      if (dw < ADAPTIVE_RESIZE_THRESHOLD_PX && dh < ADAPTIVE_RESIZE_THRESHOLD_PX) {
        if (isNativeTab) nativeResizePendingByTabRef.current.delete(tabId);
        return;
      }
    }

    if (isKktermMacTab) {
      lastSizeRef.current = { w, h };
      rdpLog.info('display', `adaptive resize (${reason}, kkterm-macos) → reconnect: ${w} x ${h}`, {
        tabId,
        width: w,
        height: h,
      });
      reconnectWithSize(tabId);
      return;
    }

    if (isKktermWindowsTab) {
      desiredSizeRef.current = null;
      const bounds = buildKktermVisibleBounds(tabId);
      if (!bounds) return;
      const recoverWithFinalSize = (failure: 'not-synchronized' | 'error', detail?: unknown) => {
        const now = Date.now();
        const lastRecoveryAt = kktermResizeRecoveryAtRef.current.get(tabId);
        if (!canRecoverKktermWindowsResize(now, lastRecoveryAt)) {
          rdpLog.warn('display', `adaptive resize (${reason}, kkterm-windows) recovery throttled`, {
            tabId,
            width: w,
            height: h,
            failure,
          });
          return;
        }
        const currentTab = tabsRef.current.find(item => item.id === tabId);
        if (currentTab?.status !== 'connected' || !kktermTabsRef.current.has(tabId)) return;
        kktermResizeRecoveryAtRef.current.set(tabId, now);
        rdpLog.warn('display', `adaptive resize (${reason}, kkterm-windows) → reconnect fallback`, {
          tabId,
          width: w,
          height: h,
          failure,
          detail,
        });
        reconnectWithSize(tabId, w, h);
      };
      scheduleKktermViewBoundsSync(`adaptive resize ${reason}`);
      const startedAt = performance.now();
      rdpLog.info('display', `adaptive resize (${reason}, kkterm-windows) → debounced display sync: ${w} x ${h}`, {
        tabId,
        width: w,
        height: h,
      });
      kktermRdpSyncDisplaySize(bounds).then(display => {
        const elapsedMs = Math.round(performance.now() - startedAt);
        if (!display.displaySynced) {
          rdpLog.warn('display', `adaptive resize (${reason}, kkterm-windows) did not synchronize`, {
            tabId,
            width: w,
            height: h,
            elapsedMs,
            connectionState: display.connectionState,
          });
          recoverWithFinalSize('not-synchronized', {
            connectionState: display.connectionState,
          });
          return;
        }
        kktermResizeRecoveryAtRef.current.delete(tabId);
        lastSizeRef.current = {
          w: display.desktopWidth || w,
          h: display.desktopHeight || h,
        };
        rdpLog.info('display', `adaptive resize (${reason}, kkterm-windows) synchronized`, {
          tabId,
          requestedWidth: w,
          requestedHeight: h,
          desktopWidth: display.desktopWidth,
          desktopHeight: display.desktopHeight,
          elapsedMs,
        });
      }).catch(error => {
        rdpLog.warn('display', `adaptive resize (${reason}, kkterm-windows) failed`, {
          tabId,
          width: w,
          height: h,
          elapsedMs: Math.round(performance.now() - startedAt),
          error: error instanceof Error ? error.message : String(error),
        });
        recoverWithFinalSize(
          'error',
          error instanceof Error ? error.message : String(error),
        );
      });
      return;
    }

    if (isNativeTab) {
      if (!canUseNativeDynamicResizeForHost(server?.host)) {
        nativeResizePendingByTabRef.current.delete(tabId);
        const now = Date.now();
        const connectedAt = nativeConnectedAtByTabRef.current.get(tabId);
        if (connectedAt && now - connectedAt < PUBLIC_NATIVE_ADAPTIVE_SETTLE_MS) {
          rdpLog.info('display', `adaptive resize (${reason}, native) suppressed during public-route settle`, {
            tabId,
            host: server?.host,
            width: w,
            height: h,
            ageMs: now - connectedAt,
            settleMs: PUBLIC_NATIVE_ADAPTIVE_SETTLE_MS,
          });
          return;
        }

        const lastPublicAdaptiveReconnect = nativePublicAdaptiveReconnectAtRef.current.get(tabId);
        if (
          lastPublicAdaptiveReconnect &&
          now - lastPublicAdaptiveReconnect < PUBLIC_NATIVE_ADAPTIVE_RECONNECT_MIN_INTERVAL_MS
        ) {
          rdpLog.info('display', `adaptive resize (${reason}, native) suppressed by public-route reconnect throttle`, {
            tabId,
            host: server?.host,
            width: w,
            height: h,
            ageMs: now - lastPublicAdaptiveReconnect,
            minIntervalMs: PUBLIC_NATIVE_ADAPTIVE_RECONNECT_MIN_INTERVAL_MS,
          });
          return;
        }

        lastSizeRef.current = { w, h };
        nativePublicAdaptiveReconnectAtRef.current.set(tabId, now);
        rdpLog.info('display', `adaptive resize (${reason}, native) → reconnect for public route`, {
          tabId,
          host: server?.host,
          width: w,
          height: h,
        });
        reconnectWithSize(tabId);
        return;
      }

      const pending = nativeResizePendingByTabRef.current.get(tabId);
      if (pending && pending.w === w && pending.h === h) return;

      if (nativeCappedResizeLog) {
        rdpLog.info('display', 'native adaptive size capped for public route', {
          tabId,
          host: server?.host,
          ...nativeCappedResizeLog,
        });
      }
      nativeResizePendingByTabRef.current.set(tabId, { w, h, sentAt: Date.now() });
      rdpLog.info('display', `adaptive resize (${reason}, native) → enqueue DVC: ${w} x ${h}`);
      api.rdpNativeResize(tabId, w, h)
        .then(() => {
          rdpLog.info('display', `adaptive resize (${reason}, native) → DVC enqueued: ${w} x ${h}`);
        })
        .catch(() => {
          const currentPending = nativeResizePendingByTabRef.current.get(tabId);
          if (currentPending?.w === w && currentPending.h === h) {
            nativeResizePendingByTabRef.current.delete(tabId);
            rdpLog.warn('display', `adaptive resize (${reason}, native) → DVC failed, reconnecting`);
            reconnectWithSize(tabId);
            return;
          }
          rdpLog.warn('display', `adaptive resize (${reason}, native) → stale DVC failure ignored`);
        });
      return;
    }

    lastSizeRef.current = { w, h };

    const session = sessionRefs.current.get(tabId);
    if (!session) return;
    try {
      session.resize(w, h);
      rdpLog.info('display', `adaptive resize (${reason}, official-web) → dynamic PDU sent: ${w} x ${h}`);
      return;
    } catch (e) {
      rdpLog.warn('display', `adaptive resize (${reason}, official-web) → dynamic resize failed`, { error: e });
    }

    rdpLog.info('display', `adaptive resize (${reason}, official-web) → reconnect fallback: ${w} x ${h}`);
    reconnectWithSize(tabId);
  }, [buildKktermVisibleBounds, getCanvasSize, reconnectWithSize, scheduleKktermViewBoundsSync, store]);
  performAdaptiveResizeRef.current = performAdaptiveResize;

  const toggleFullscreen = useCallback(async () => {
    const appWindow = getCurrentWindow();
    try {
      const next = !(await appWindow.isFullscreen());
      await appWindow.setFullscreen(next);
      setIsFullscreen(next);
      rdpLog.info('display', `native fullscreen ${next ? 'entered' : 'exited'}`);
    } catch (error) {
      rdpLog.error('display', 'native fullscreen toggle failed', { error: String(error) });
    }
  }, []);

  const toggleDriveRedirection = useCallback((enabled: boolean) => {
    driveRedirectionEnabledRef.current = enabled;
    setDriveRedirectionEnabled(enabled);
    try {
      window.localStorage.setItem('nextdesk_kkterm_redirect_drives', enabled ? 'true' : 'false');
    } catch {
      // The in-memory choice still applies to the reconnect.
    }
    const tabId = activeTabIdRef.current;
    rdpLog.info('clipboard', 'Windows drive redirection changed', { tabId, enabled });
    if (tabId && kktermTabsRef.current.has(tabId)) {
      reconnectWithSize(tabId);
    }
  }, [reconnectWithSize]);

  const toggleMultiMonitor = useCallback((enabled: boolean) => {
    multiMonitorEnabledRef.current = enabled;
    setMultiMonitorEnabled(enabled);
    try {
      window.localStorage.setItem('nextdesk_kkterm_use_multimon', enabled ? 'true' : 'false');
    } catch {
      // The in-memory choice still applies to the reconnect.
    }
    const tabId = activeTabIdRef.current;
    rdpLog.info('display', 'Windows multi-monitor changed', { tabId, enabled });
    if (tabId && kktermTabsRef.current.has(tabId)) {
      reconnectWithSize(tabId);
    }
  }, [reconnectWithSize]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const refresh = () => {
      void appWindow.isFullscreen().then(value => {
        if (!disposed) setIsFullscreen(value);
      }).catch(() => undefined);
    };
    refresh();
    void appWindow.onResized(refresh).then(value => {
      if (disposed) value();
      else unlisten = value;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const activeConnected = store.activeTab?.status === 'connected';
    if (!isFullscreen || (isRdpViewVisible && activeConnected)) return;
    const appWindow = getCurrentWindow();
    void appWindow.setFullscreen(false).then(() => {
      setIsFullscreen(false);
      rdpLog.info('display', 'native fullscreen exited because the active RDP session is unavailable');
    }).catch(error => {
      rdpLog.warn('display', 'failed to exit native fullscreen after RDP session state changed', {
        error: String(error),
      });
    });
  }, [isFullscreen, isRdpViewVisible, store.activeTab?.status]);

  // ── Switch resolution mode ──
  const applyResolution = useCallback((requestedMode: string) => {
    const mode = requestedMode;
    rdpLog.info('display', `applyResolution called: ${mode}`);
    if (mode === resModeRef.current) {
      rdpLog.info('display', `applyResolution skipped: ${mode} is already active`);
      return;
    }
    setResMode(mode);
    resModeRef.current = mode;
    const tabId = store.activeTabId;
    if (!tabId) return;
    const tab = tabsRef.current.find(t => t.id === tabId);
    const server = tab ? store.getServerById(tab.serverId) : null;

    if (mode === 'smartSizing') {
      const plan = kktermTabsRef.current.has(tabId)
        ? planKktermLocalScaling(KKTERM_COPY_PLATFORM, lastSizeRef.current, getCanvasSize())
        : null;
      if (!plan) {
        setResMode('adaptive');
        resModeRef.current = 'adaptive';
        return;
      }
      const size = plan.desktopSize;
      desiredSizeRef.current = size;
      lastSizeRef.current = size;
      kktermViewLastBoundsByTabRef.current.delete(tabId);
      rdpLog.info('display', `switching to local scaling: ${size.w} x ${size.h}`, {
        tabId,
        platform: KKTERM_COPY_PLATFORM,
        reconnect: plan.reconnect,
      });
      if (plan.reconnect) {
        reconnectWithSize(tabId, size.w, size.h);
      }
      return;
    }

    if (mode === 'adaptive') {
      let { w, h } = getCanvasSize();
      rdpLog.info('display', `switching to adaptive: ${w} x ${h}`);
      if (USE_KKTERM_COPY_WINDOWS && kktermTabsRef.current.has(tabId)) {
        desiredSizeRef.current = null;
        lastSizeRef.current = { w, h };
        kktermViewLastBoundsByTabRef.current.delete(tabId);
        // ActiveX keeps the resolution mode that was configured at startup.
        // Reconnect when leaving a fixed mode so the new session uses
        // `automatic`; a bounds sync alone would keep SmartSizing at the old
        // fixed desktop size while the UI incorrectly reported Adaptive.
        rdpLog.info('display', 'kkterm-windows adaptive resolution → reconnect with ActiveX automatic mode', {
          tabId,
          width: w,
          height: h,
        });
        reconnectWithSize(tabId);
        return;
      }
      // Try native resize first
      if (USE_NATIVE_RDP && nativeTabsRef.current.has(tabId)) {
        const normalized = normalizeNativeDesktopSizeForHost(w, h, server?.host);
        if (normalized.capped && (normalized.w !== w || normalized.h !== h)) {
          rdpLog.info('display', 'native adaptive size capped for public route', {
            tabId,
            host: server?.host,
            requested: { w, h },
            capped: { w: normalized.w, h: normalized.h },
          });
        }
        w = normalized.w;
        h = normalized.h;
        const actual = nativeActualSizeByTabRef.current.get(tabId);
        if (actual?.w === w && actual.h === h) {
          desiredSizeRef.current = null;
          nativeResizePendingByTabRef.current.delete(tabId);
          rdpLog.info('display', 'native resize skipped (adaptive already current)', { width: w, height: h });
          return;
        }
        if (!canUseNativeDynamicResizeForHost(server?.host)) {
          desiredSizeRef.current = null;
          nativeResizePendingByTabRef.current.delete(tabId);
          lastSizeRef.current = { w, h };
          rdpLog.info('display', 'native resize reconnect (adaptive public route)', {
            tabId,
            host: server?.host,
            width: w,
            height: h,
          });
          reconnectWithSize(tabId);
          return;
        }
        const pending = nativeResizePendingByTabRef.current.get(tabId);
        if (pending?.w === w && pending.h === h) {
          desiredSizeRef.current = null;
          rdpLog.info('display', 'native resize skipped (adaptive already pending)', { width: w, height: h });
          return;
        }
        nativeResizePendingByTabRef.current.set(tabId, { w, h, sentAt: Date.now() });
        api.rdpNativeResize(tabId, w, h).then(() => {
          desiredSizeRef.current = null;
          rdpLog.info('display', 'native resize enqueued (adaptive)', { width: w, height: h });
        }).catch(() => {
          const currentPending = nativeResizePendingByTabRef.current.get(tabId);
          if (currentPending?.w === w && currentPending.h === h) {
            nativeResizePendingByTabRef.current.delete(tabId);
            rdpLog.warn('display', 'native resize failed, falling back to reconnect');
            reconnectWithSize(tabId);
            return;
          }
          rdpLog.warn('display', 'stale native resize failure ignored');
        });
        return;
      }
      const session = sessionRefs.current.get(tabId);
      if (session) {
        try {
          session.resize(w, h);
          desiredSizeRef.current = null;
          lastSizeRef.current = { w, h };
          rdpLog.info('display', 'official-web dynamic resize PDU sent (adaptive)');
          return;
        } catch (e) {
          rdpLog.warn('display', 'dynamic resize failed, falling back to reconnect', { error: e });
        }
      }
      reconnectWithSize(tabId);
    } else {
      const [ws, hs] = mode.split('x').map(Number);
      if (!ws || !hs) return;
      rdpLog.info('display', `switching to fixed resolution: ${ws} x ${hs}`);
      if (USE_KKTERM_COPY_WINDOWS && kktermTabsRef.current.has(tabId)) {
        desiredSizeRef.current = { w: ws, h: hs };
        lastSizeRef.current = { w: ws, h: hs };
        kktermViewLastBoundsByTabRef.current.delete(tabId);
        rdpLog.info('display', 'kkterm-windows fixed resolution → reconnect with ActiveX remoteResolution', {
          tabId,
          width: ws,
          height: hs,
          remoteResolution: mode,
        });
        reconnectWithSize(tabId, ws, hs);
        return;
      }
      // Try native resize first
      if (USE_NATIVE_RDP && nativeTabsRef.current.has(tabId)) {
        const normalized = normalizeNativeDesktopSizeForHost(ws, hs, server?.host);
        const targetW = normalized.w;
        const targetH = normalized.h;
        if (normalized.capped && (targetW !== ws || targetH !== hs)) {
          rdpLog.info('display', 'native fixed size capped for public route', {
            tabId,
            host: server?.host,
            requested: { w: ws, h: hs },
            capped: { w: targetW, h: targetH },
          });
        }
        const actual = nativeActualSizeByTabRef.current.get(tabId);
        if (actual?.w === targetW && actual.h === targetH) {
          desiredSizeRef.current = { w: targetW, h: targetH };
          nativeResizePendingByTabRef.current.delete(tabId);
          rdpLog.info('display', 'native resize skipped (fixed already current)', { width: targetW, height: targetH });
          return;
        }
        if (!canUseNativeDynamicResizeForHost(server?.host)) {
          desiredSizeRef.current = { w: targetW, h: targetH };
          nativeResizePendingByTabRef.current.delete(tabId);
          lastSizeRef.current = { w: targetW, h: targetH };
          rdpLog.info('display', 'native resize reconnect (fixed public route)', {
            tabId,
            host: server?.host,
            width: targetW,
            height: targetH,
          });
          reconnectWithSize(tabId, targetW, targetH);
          return;
        }
        const pending = nativeResizePendingByTabRef.current.get(tabId);
        if (pending?.w === targetW && pending.h === targetH) {
          desiredSizeRef.current = { w: targetW, h: targetH };
          rdpLog.info('display', 'native resize skipped (fixed already pending)', { width: targetW, height: targetH });
          return;
        }
        nativeResizePendingByTabRef.current.set(tabId, { w: targetW, h: targetH, sentAt: Date.now() });
        api.rdpNativeResize(tabId, targetW, targetH).then(() => {
          desiredSizeRef.current = { w: targetW, h: targetH };
          rdpLog.info('display', 'native resize enqueued (fixed)', { width: targetW, height: targetH });
        }).catch(() => {
          const currentPending = nativeResizePendingByTabRef.current.get(tabId);
          if (currentPending?.w === targetW && currentPending.h === targetH) {
            nativeResizePendingByTabRef.current.delete(tabId);
            rdpLog.warn('display', 'native resize failed, falling back to reconnect');
            reconnectWithSize(tabId, targetW, targetH);
            return;
          }
          rdpLog.warn('display', 'stale native resize failure ignored');
        });
        return;
      }
      const session = sessionRefs.current.get(tabId);
      if (session) {
        const canvas = canvasRefs.current.get(tabId);
        if (canvas?.width === ws && canvas.height === hs) {
          desiredSizeRef.current = { w: ws, h: hs };
          lastSizeRef.current = { w: ws, h: hs };
          rdpLog.info('display', 'official-web resize skipped (fixed already current)', { width: ws, height: hs });
          return;
        }
        try {
          session.resize(ws, hs);
          desiredSizeRef.current = { w: ws, h: hs };
          lastSizeRef.current = { w: ws, h: hs };
          rdpLog.info('display', 'official-web dynamic resize PDU sent (fixed)');
          return;
        } catch (e) {
          rdpLog.warn('display', 'dynamic resize failed, falling back to reconnect', { error: e });
        }
      }
      reconnectWithSize(tabId, ws, hs);
    }
  }, [store.activeTabId, getCanvasSize, reconnectWithSize, scheduleKktermViewBoundsSync]);

  // ── Input forwarding with retry for reliability ──
  useEffect(() => {
    const tabId = store.activeTabId;
    const tabStatus = store.activeTab?.status;
    if (USE_KKTERM_COPY_RDP) return;
    if (!tabId || tabStatus !== 'connected') return;

    let cancelled = false;
    let cleanupFn: (() => void) | null = null;

    const attachEvents = () => {
      if (cancelled) return;
      const canvas = canvasRefs.current.get(tabId);
      if (!canvas) {
        // Canvas ref not ready yet — retry in 100ms
        setTimeout(attachEvents, 100);
        return;
      }

      const isMac = navigator.userAgent.includes('Mac');
      const isNative = USE_NATIVE_RDP && nativeTabsRef.current.has(tabId);

      // ── Input dispatch: WASM vs Native ──
      const sendInput = (event: any) => {
        if (isNative) return; // Native mode uses specific send* functions below
        const session = sessionRefs.current.get(tabId);
        if (!session || !wasmModule) return;
        const tx = new wasmModule.InputTransaction();
        tx.addEvent(event);
        session.applyInputs(tx);
      };

      const sendInputBatch = (events: any[]) => {
        if (isNative) return; // Native mode uses specific send* functions below
        const session = sessionRefs.current.get(tabId);
        if (!session || !wasmModule) return;
        const tx = new wasmModule.InputTransaction();
        for (const event of events) {
          tx.addEvent(event);
        }
        session.applyInputs(tx);
      };

      // Native mode: send key scancode directly to Rust backend
      const nativePressedKeys = new NativePressedKeyTracker();
      const nativeSendKey = (scancode: number, isPressed: boolean) => {
        if (!isNative) return;
        if (isPressed) {
          nativePressedKeys.press(scancode);
        } else {
          nativePressedKeys.release(scancode);
        }
        api.rdpNativeInput(tabId, scancode, isPressed).catch(() => {});
      };

      // Native mode: send key batch (press+release pairs)
      const nativeSendKeyBatch = (scancodes: { sc: number; pressed: boolean }[]) => {
        if (!isNative) return;
        for (const { sc, pressed } of scancodes) {
          nativeSendKey(sc, pressed);
        }
      };

      // Send Win key tap (LWin press + release)
      const sendWinKey = () => {
        if (isNative) {
          nativeSendKeyBatch([
            { sc: 0xE05B, pressed: true },
            { sc: 0xE05B, pressed: false },
          ]);
          return;
        }
        const wm = wasmModule;
        if (!wm) return;
        sendInputBatch([
          wm.DeviceEvent.keyPressed(0xE05B),
          wm.DeviceEvent.keyReleased(0xE05B),
        ]);
      };

      // Send Ctrl+Alt+Delete sequence
      const sendCtrlAltDel = () => {
        if (isNative) {
          nativeSendKeyBatch([
            { sc: 0x1D, pressed: true },
            { sc: 0x38, pressed: true },
            { sc: 0xE053, pressed: true },
            { sc: 0xE053, pressed: false },
            { sc: 0x38, pressed: false },
            { sc: 0x1D, pressed: false },
          ]);
          return;
        }
        const wm = wasmModule;
        if (!wm) return;
        sendInputBatch([
          wm.DeviceEvent.keyPressed(0x1D),
          wm.DeviceEvent.keyPressed(0x38),
          wm.DeviceEvent.keyPressed(0xE053),
          wm.DeviceEvent.keyReleased(0xE053),
          wm.DeviceEvent.keyReleased(0x38),
          wm.DeviceEvent.keyReleased(0x1D),
        ]);
      };

      // Expose virtual key functions via refs for toolbar buttons
      sendWinKeyRef.current = sendWinKey;
      sendCtrlAltDelRef.current = sendCtrlAltDel;

      const sendCtrlShortcut = (keyScancode: number) => {
        if (isNative) {
          nativeSendKeyBatch([
            { sc: 0x1D, pressed: true },
            { sc: keyScancode, pressed: true },
            { sc: keyScancode, pressed: false },
            { sc: 0x1D, pressed: false },
          ]);
          return;
        }
        const wm = wasmModule;
        if (!wm) return;
        sendInputBatch([
          wm.DeviceEvent.keyPressed(0x1D),
          wm.DeviceEvent.keyPressed(keyScancode),
          wm.DeviceEvent.keyReleased(keyScancode),
          wm.DeviceEvent.keyReleased(0x1D),
        ]);
      };

      // Send Win+key combo (e.g. Win+R → Run dialog)
      const sendWinShortcut = (keyScancode: number) => {
        if (isNative) {
          nativeSendKeyBatch([
            { sc: 0xE05B, pressed: true },
            { sc: keyScancode, pressed: true },
            { sc: keyScancode, pressed: false },
            { sc: 0xE05B, pressed: false },
          ]);
          return;
        }
        const wm = wasmModule;
        if (!wm) return;
        sendInputBatch([
          wm.DeviceEvent.keyPressed(0xE05B),
          wm.DeviceEvent.keyPressed(keyScancode),
          wm.DeviceEvent.keyReleased(keyScancode),
          wm.DeviceEvent.keyReleased(0xE05B),   // LWin up
        ]);
      };

      const syncLocalClipboardForPasteShortcut = async () => {
        const sess = sessionRefs.current.get(tabId);
        const wm = wasmModule;
        if (!sess || !wm) return;
        pasteShortcutInFlightRef.current.add(tabId);

        try {
          // Always fetch fresh clipboard data to ensure correctness.
          // Pre-cache is used to update advertisedClipboard on focus, but
          // paste must always read the CURRENT clipboard state.
          // However, per MS-RDPECLIP, FormatList must only be sent on
          // clipboard CHANGE — sending it redundantly makes the server
          // discard its own clipboard and breaks RDP-internal copy/paste.
          const cached = advertisedClipboardRef.current.get(tabId);
          const files = await invoke<{name: string, path: string, size: number, data: number[]}[]>('clipboard_read_files_data')
            .catch(() => [] as {name: string, path: string, size: number, data: number[]}[]);
          cblog('[clipboard] paste-shortcut: read', files.length, 'file(s) from current clipboard');
          if (files.length > 0) {
            // Check if clipboard was recently populated by a remote download.
            // Don't compare filenames — there's a race condition where clipboard
            // may still hold the PREVIOUS file if staging hasn't completed yet.
            const remoteKey = remoteClipboardFileKeyRef.current.get(tabId);
            if (remoteKey) {
              cblog('[clipboard] paste-shortcut: skipping remote-originated file (feedback loop prevention)');
              return;
            }
            const payloads: ClipboardFilePayload[] = files.map(f => ({
              name: f.name,
              size: f.size,
              data: new Uint8Array(f.data),
              path: f.path,
            }));
            const newFileKey = payloads.map(f => f.path || f.name).join('|');
            // Skip FormatList if clipboard hasn't changed (avoids breaking RDP-internal paste)
            if (cached && cached.kind === 'files' && cached.fileKey === newFileKey) {
              cblog('[clipboard] paste-shortcut: files unchanged, skip FormatList');
              return;
            }
            const snapshot: AdvertisedClipboardSnapshot = {
              kind: 'files',
              fileKey: newFileKey,
              files: cloneClipboardFilePayloads(payloads),
            };
            const clipboardData = buildClipboardDataFromSnapshot(wm, snapshot);
            await sess.onClipboardPaste(clipboardData);
            advertisedClipboardRef.current.set(
              tabId,
              cloneAdvertisedClipboardSnapshot(snapshot),
            );
            cblog('[clipboard] ✅ paste-shortcut local files injected before remote paste');
            return;
          }

          const text = await tauriReadClipboard().catch(() => null);
          if (!text) return;
          // Clipboard now has text, not files — clear remote file ref
          remoteClipboardFileKeyRef.current.delete(tabId);
          // Skip FormatList if text unchanged
          if (cached && cached.kind === 'text' && cached.text === text) {
            cblog('[clipboard] paste-shortcut: text unchanged, skip FormatList');
            return;
          }
          const snapshot: AdvertisedClipboardSnapshot = {
            kind: 'text',
            text,
          };
          const clipboardData = buildClipboardDataFromSnapshot(wm, snapshot);
          await sess.onClipboardPaste(clipboardData);
          advertisedClipboardRef.current.set(
            tabId,
            cloneAdvertisedClipboardSnapshot(snapshot),
          );
          cblog('[clipboard] ✅ paste-shortcut local text injected before remote paste');
        } finally {
          pasteShortcutInFlightRef.current.delete(tabId);
        }
      };

      const suppressedShortcutKeyups = new Set<string>();


      // Track whether Cmd was pressed without a combo, for deferred Win tap
      let cmdPendingWinTap = false;

      const onKeyDown = (e: KeyboardEvent) => {
        lastRdpInputAtRef.current.set(tabId, Date.now());
        // Let host shortcuts (Cmd+W close tab, Cmd+Q quit) pass through without interception
        if (isMac && e.metaKey && (e.code === 'KeyW' || e.code === 'KeyQ')) {
          return;
        }
        e.preventDefault();
        if (!isNative && !wasmModule) return;

        // ── macOS: Cmd key handling (Jump Desktop compatible) ──
        // Cmd → Win key (deferred), editing shortcuts → Ctrl
        if (isMac && e.metaKey) {
          // Cmd key itself pressed — defer Win key, don't send yet
          if (e.code === 'MetaLeft' || e.code === 'MetaRight') {
            cmdPendingWinTap = true;
            return;
          }

          // A combo key was pressed → Cmd was used in a shortcut
          cmdPendingWinTap = false;

          // Editing shortcuts: Cmd+C/V/X/A/Z → Ctrl+C/V/X/A/Z
          if (e.code === 'KeyV') {
            if (pasteShortcutInFlightRef.current.has(tabId)) {
              cblog('[clipboard] paste-shortcut already in flight, skip');
              return;
            }
            suppressedShortcutKeyups.add('KeyV');
            suppressedShortcutKeyups.add('MetaLeft');
            suppressedShortcutKeyups.add('MetaRight');
            void syncLocalClipboardForPasteShortcut()
              .catch(err => cblog('[clipboard] paste-shortcut injection error:', err))
              .finally(() => sendCtrlShortcut(0x2F));
            return;
          }
          if (e.code === 'KeyC') {
            suppressedShortcutKeyups.add('KeyC');
            suppressedShortcutKeyups.add('MetaLeft');
            suppressedShortcutKeyups.add('MetaRight');
            sendCtrlShortcut(0x2E);
            return;
          }
          if (e.code === 'KeyX') {
            suppressedShortcutKeyups.add('KeyX');
            suppressedShortcutKeyups.add('MetaLeft');
            suppressedShortcutKeyups.add('MetaRight');
            sendCtrlShortcut(0x2D);
            return;
          }
          if (e.code === 'KeyA') {
            suppressedShortcutKeyups.add('KeyA');
            suppressedShortcutKeyups.add('MetaLeft');
            suppressedShortcutKeyups.add('MetaRight');
            sendCtrlShortcut(0x1E);
            return;
          }
          if (e.code === 'KeyZ') {
            suppressedShortcutKeyups.add('KeyZ');
            suppressedShortcutKeyups.add('MetaLeft');
            suppressedShortcutKeyups.add('MetaRight');
            sendCtrlShortcut(0x2C);
            return;
          }

          // Host shortcuts: let Cmd+W (close tab) and Cmd+Q (quit) pass through to Tauri
          if (e.code === 'KeyW' || e.code === 'KeyQ') {
            return; // Don't preventDefault, don't send to remote
          }

          // All other Cmd+key → Win+key (system shortcuts)
          const sc = codeToScancode(e.code);
          if (sc !== undefined) {
            suppressedShortcutKeyups.add(e.code);
            suppressedShortcutKeyups.add('MetaLeft');
            suppressedShortcutKeyups.add('MetaRight');
            sendWinShortcut(sc);
          }
          return;
        }

        // ── Generic path: send scancode directly ──
        const sc = codeToScancode(e.code);
        if (sc !== undefined) {
          if (isNative) {
            nativeSendKey(sc, true);
          } else {
            sendInput(wasmModule!.DeviceEvent.keyPressed(sc));
          }
        } else if (e.key.length === 1 && !isNative) {
          sendInput(wasmModule!.DeviceEvent.unicodePressed(e.key));
        }
      };
      const onKeyUp = (e: KeyboardEvent) => {
        lastRdpInputAtRef.current.set(tabId, Date.now());
        e.preventDefault();
        if (!isNative && !wasmModule) return;
        if (suppressedShortcutKeyups.has(e.code)) {
          suppressedShortcutKeyups.delete(e.code);
          return;
        }
        // Mac: Cmd release
        if (isMac && (e.code === 'MetaLeft' || e.code === 'MetaRight')) {
          if (cmdPendingWinTap) {
            cmdPendingWinTap = false;
            sendWinKey();
          }
          return;
        }
        const sc = codeToScancode(e.code);
        if (sc !== undefined) {
          if (isNative) {
            nativeSendKey(sc, false);
          } else {
            sendInput(wasmModule!.DeviceEvent.keyReleased(sc));
          }
        } else if (e.key.length === 1 && !isNative) {
          sendInput(wasmModule!.DeviceEvent.unicodeReleased(e.key));
        }
      };
      const canvasPointToRemote = (e: MouseEvent) => {
        const r = canvas.getBoundingClientRect();
        const sx = canvas.width / r.width;
        const sy = canvas.height / r.height;
        return {
          x: (e.clientX - r.left) * sx,
          y: (e.clientY - r.top) * sy,
        };
      };

      let pendingMouseMove: { x: number; y: number } | null = null;
      let mouseMoveAnimationFrame: number | null = null;

      const sendMouseMoveNow = (mx: number, my: number) => {
        if (isNative) {
          api.rdpNativeMouse(tabId, mx, my, -1, false).catch(() => {});
        } else {
          if (!wasmModule) return;
          sendInput(wasmModule.DeviceEvent.mouseMove(mx, my));
        }
      };

      const flushPendingMouseMove = () => {
        if (mouseMoveAnimationFrame !== null) {
          cancelAnimationFrame(mouseMoveAnimationFrame);
          mouseMoveAnimationFrame = null;
        }
        const move = pendingMouseMove;
        pendingMouseMove = null;
        if (move) sendMouseMoveNow(move.x, move.y);
      };

      const discardPendingMouseMove = () => {
        if (mouseMoveAnimationFrame !== null) {
          cancelAnimationFrame(mouseMoveAnimationFrame);
          mouseMoveAnimationFrame = null;
        }
        pendingMouseMove = null;
      };

      const onMouseMove = (e: MouseEvent) => {
        lastRdpInputAtRef.current.set(tabId, Date.now());
        const { x: mx, y: my } = canvasPointToRemote(e);
        pendingMouseMove = { x: mx, y: my };
        if (mouseMoveAnimationFrame !== null) return;
        mouseMoveAnimationFrame = requestAnimationFrame(() => {
          mouseMoveAnimationFrame = null;
          const move = pendingMouseMove;
          pendingMouseMove = null;
          if (move) sendMouseMoveNow(move.x, move.y);
        });
      };
      const pressedButtons = new Set<number>();
      const onMouseDown = (e: MouseEvent) => {
        lastRdpInputAtRef.current.set(tabId, Date.now());
        e.preventDefault();
        pressedButtons.add(e.button);
        const { x: mx, y: my } = canvasPointToRemote(e);
        pendingMouseMove = { x: mx, y: my };
        flushPendingMouseMove();
        rdpLog.info('input', `mouse DOWN btn=${e.button}`, {
          x: Math.round(mx),
          y: Math.round(my),
          pressed: [...pressedButtons],
          target: (e.target as HTMLElement)?.tagName,
        });
        if (isNative) {
          api.rdpNativeMouse(tabId, mx, my, e.button, true)
            .catch(error => rdpLog.warn('input', 'native mouse down send failed', { error: String(error) }));
        } else {
          if (!wasmModule) return;
          sendInput(wasmModule.DeviceEvent.mouseButtonPressed(e.button));
        }
        if (document.activeElement !== canvas) {
          canvas.focus();
        }
      };
      const onMouseUp = (e: MouseEvent) => {
        lastRdpInputAtRef.current.set(tabId, Date.now());
        if (!pressedButtons.has(e.button)) {
          rdpLog.debug('input', `mouse UP btn=${e.button} SKIPPED (not in pressed)`, { pressed: [...pressedButtons] });
          return;
        }
        pressedButtons.delete(e.button);
        const { x: mx, y: my } = canvasPointToRemote(e);
        pendingMouseMove = { x: mx, y: my };
        flushPendingMouseMove();
        rdpLog.info('input', `mouse UP btn=${e.button} SENT`, {
          x: Math.round(mx),
          y: Math.round(my),
          remaining: [...pressedButtons],
        });
        if (isNative) {
          api.rdpNativeMouse(tabId, mx, my, e.button, false)
            .catch(error => rdpLog.warn('input', 'native mouse up send failed', { error: String(error) }));
        } else {
          if (!wasmModule) return;
          sendInput(wasmModule.DeviceEvent.mouseButtonReleased(e.button));
        }
      };
      const onCtxMenu = (e: Event) => e.preventDefault();
      const onWheel = (e: WheelEvent) => {
        lastRdpInputAtRef.current.set(tabId, Date.now());
        e.preventDefault();
        const vertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX);
        const delta = vertical ? e.deltaY : e.deltaX;
        if (delta === 0) return;
        const amount = Math.round(Math.max(-32767, Math.min(32767, -delta)));
        if (amount === 0) return;
        if (isNative) {
          const { x, y } = canvasPointToRemote(e);
          api.rdpNativeWheel(tabId, x, y, amount, !vertical).catch(() => {});
        } else {
          if (!wasmModule) return;
          const unit = e.deltaMode;
          sendInput(wasmModule.DeviceEvent.wheelRotations(vertical, amount, unit));
        }
      };

      // ── Release all keys/buttons when focus is lost ──
      // Without this, modifier keys (Ctrl, Shift) get "stuck" in pressed
      // state on the RDP server when the user switches away (Cmd+Tab,
      // clicks outside canvas, etc.), because the browser never fires
      // keyUp events for keys held when focus leaves.
      const releaseAllKeys = () => {
        rdpLog.debug('input', 'releaseAllKeys called', { pressedButtons: [...pressedButtons] });
        if (isNative) {
          nativePressedKeys.releaseAll(scancode => {
            api.rdpNativeInput(tabId, scancode, false).catch(error => {
              rdpLog.debug('input', 'native release key failed', {
                tabId,
                scancode,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          });
        }
        const session = sessionRefs.current.get(tabId);
        if (session) {
          try { session.releaseAllInputs(); } catch { /* ignore */ }
        }
        pressedButtons.clear();
        suppressedShortcutKeyups.clear();
        cmdPendingWinTap = false;
      };
      const onCanvasBlur = () => {
        // Skip release if mouse buttons are still pressed (user is dragging).
        // Releasing during drag sends unexpected mouse-up to the RDP server,
        // which breaks slider/scrollbar drag operations (stutter on re-drag).
        if (pressedButtons.size > 0) {
          rdpLog.debug('input', 'blur during drag, deferring release', { pressedButtons: [...pressedButtons] });
          return;
        }
        releaseAllKeys();
      };
      const onWindowBlur = () => releaseAllKeys();

      canvas.addEventListener('keydown', onKeyDown);
      canvas.addEventListener('keyup', onKeyUp);
      canvas.addEventListener('mousemove', onMouseMove);
      canvas.addEventListener('mousedown', onMouseDown);
      window.addEventListener('mouseup', onMouseUp);
      canvas.addEventListener('contextmenu', onCtxMenu);
      canvas.addEventListener('wheel', onWheel, { passive: false });
      canvas.addEventListener('blur', onCanvasBlur);
      window.addEventListener('blur', onWindowBlur);
      canvas.focus();

      // ── Clipboard sync (MS-RDPECLIP compliant) ──
      // We still sync on focus, but also run a light polling loop so local file copy
      // does not depend on a perfect focus transition to reach the remote session.
      let lastSyncedText: string | null = null;
      let lastSyncedFileKey: string | null = null;
      let clipboardPollTimer: ReturnType<typeof setInterval> | null = null;
      // Throttle FormatList sends: minimum 5s between sends to prevent server rejection.
      // Some Windows RDP servers reject rapid FormatList PDUs, causing CLIPRDR to enter
      // permanent "Failed" state (ironrdp_cliprdr state machine never recovers).
      let lastFormatListSentAt = 0;
      const FORMAT_LIST_MIN_INTERVAL_MS = 5000;
      // Cooldown after connection: don't send FormatList for 10s after CLIPRDR init
      const cliprdrConnectedAt = Date.now();
      const CLIPRDR_INIT_COOLDOWN_MS = 10000;
      const syncClipboard = async (reason: 'Focus' | 'Poll') => {
        if (reason === 'Focus') {
          cblog('[clipboard] ▶ Focus event fired');
        }
        // Cooldown: skip all FormatList sends for 10s after connection
        if (Date.now() - cliprdrConnectedAt < CLIPRDR_INIT_COOLDOWN_MS) {
          if (reason === 'Focus') cblog('[clipboard] Focus: skipped — init cooldown');
          return;
        }
        // Throttle: minimum 5s between FormatList sends
        if (Date.now() - lastFormatListSentAt < FORMAT_LIST_MIN_INTERVAL_MS) {
          if (reason === 'Focus') cblog('[clipboard] Focus: skipped — throttle (last sent <5s ago)');
          return;
        }
        // Skip poll if file transfer is in progress (CLIPRDR state machine busy)
        if (fileTransferInProgressRef.current.has(tabId)) {
          if (reason === 'Focus') cblog('[clipboard] Focus: skipped — file transfer in progress');
          return;
        }
        if (reason === 'Poll') {
          const lastInputAt = lastRdpInputAtRef.current.get(tabId) ?? 0;
          if (Date.now() - lastInputAt < CLIPBOARD_POLL_INPUT_IDLE_MS) return;
        }
        // Prevent overlapping polls (previous poll still running)
        if (reason === 'Poll') {
          if (clipboardPollInFlightRef.current.has(tabId)) return;
          clipboardPollInFlightRef.current.add(tabId);
        }
        const sess = sessionRefs.current.get(tabId);
        if (!sess || !wasmModule) {
          if (reason === 'Focus') cblog('[clipboard] Focus: no session/wasm');
          if (reason === 'Poll') clipboardPollInFlightRef.current.delete(tabId);
          return;
        }
        try {
          if (rdpdrEnabledRef.current.has(tabId)) {
            const filePaths = await invoke<string[]>('clipboard_read_file_paths')
              .catch(() => [] as string[]);
            if (filePaths.length > 0) {
              if (reason === 'Focus') {
                cblog('[clipboard] Focus: RDPDR active, file paths detected, skip text sync');
              }
              lastSyncedFileKey = filePaths.join('|');
              return;
            }
            const text = await tauriReadClipboard().catch(() => null);
            if (reason === 'Focus') {
              cblog('[clipboard] Focus text-only mode because RDPDR is active:', text ? `"${text.slice(0, 60)}"` : '(null)');
            }
            if (text && text !== lastSyncedText) {
              lastSyncedText = text;
              lastSyncedFileKey = null;
              const cd = new wasmModule.ClipboardData();
              cd.addText('text/plain', text);
              await sess.onClipboardPaste(cd);
              lastFormatListSentAt = Date.now();
              advertisedClipboardRef.current.set(tabId, {
                kind: 'text',
                text,
              });
              cblog('[clipboard] ✅ ' + (reason === 'Focus' ? 'Focus' : 'Poll') + ' text sync while RDPDR active');
            } else if (reason === 'Focus') {
              cblog('[clipboard] Focus text-only mode: no text change');
            }
            return;
          }
          // 1. Check for file paths first. Only hydrate file bytes when the selection changed.
          const filePaths = await invoke<string[]>('clipboard_read_file_paths').catch(() => [] as string[]);
          if (filePaths.length > 0) {
            const fileKey = filePaths.join('|');
            if (fileKey !== lastSyncedFileKey) {
              // Check if this file key came from a remote download (feedback loop prevention)
              // remoteClipboardFileKeyRef stores sorted basenames (set before async staging)
              const remoteKey = remoteClipboardFileKeyRef.current.get(tabId);
              if (remoteKey) {
                const detectedBasenames = filePaths.map(p => p.split('/').pop()?.toLowerCase() || '').sort().join('|');
                if (detectedBasenames === remoteKey) {
                  cblog('[clipboard] ' + (reason === 'Focus' ? 'Focus' : 'Poll') + ': skipping remote-originated file (feedback loop prevention)');
                  lastSyncedFileKey = fileKey;
                  lastSyncedText = null;
                  return;
                }
                // File names don't match remote download — user copied a local file.
                // Clear the remote ref so paste-shortcut won't block local→RDP injection.
                remoteClipboardFileKeyRef.current.delete(tabId);
                cblog('[clipboard] ' + (reason === 'Focus' ? 'Focus' : 'Poll') + ': new local file detected, clearing remote file ref');
              }
              const files = await invoke<{name: string, path: string, size: number, data: number[]}[]>('clipboard_read_files_data').catch(() => [] as any[]);
              if (!files || files.length === 0) {
                if (reason === 'Focus') {
                  cblog('[clipboard] Focus: file paths found but file data unavailable yet');
                }
                return;
              }
              cblog('[clipboard] ' + (reason === 'Focus' ? 'Focus' : 'Poll') + ': found', files.length, 'file(s):', fileKey);
              lastSyncedFileKey = fileKey;
              lastSyncedText = null; // reset text tracker
              const cd = new wasmModule.ClipboardData();
              const payloads: ClipboardFilePayload[] = files.map(f => ({
                name: f.name,
                size: f.size,
                data: new Uint8Array(f.data),
                path: f.path,
              }));
              for (const f of payloads) {
                cblog('[clipboard] ' + (reason === 'Focus' ? 'Focus' : 'Poll') + ' adding file:', f.name, f.size, 'bytes', f.data.length === 0 ? '(lazy)' : '(in-memory)');
              }
              addClipboardFiles(cd, payloads);
              await sess.onClipboardPaste(cd);
              lastFormatListSentAt = Date.now();
              advertisedClipboardRef.current.set(tabId, {
                kind: 'files',
                fileKey,
                files: cloneClipboardFilePayloads(payloads),
              });
              cblog('[clipboard] ✅ ' + (reason === 'Focus' ? 'Focus' : 'Poll') + ' sync → FormatList sent for files');
            } else if (reason === 'Focus') {
              cblog('[clipboard] Focus: same files, skip');
            }
            return;
          }
          // 2. No files → fall back to text
          const text = await tauriReadClipboard().catch(() => null);
          if (reason === 'Focus') {
            cblog('[clipboard] Focus read text:', text ? `"${text.slice(0, 60)}"` : '(null)', 'prev:', lastSyncedText ? `"${lastSyncedText.slice(0, 30)}"` : '(null)');
          }
          if (text && text !== lastSyncedText) {
            lastSyncedText = text;
            lastSyncedFileKey = null; // reset file tracker
            const cd = new wasmModule.ClipboardData();
            cd.addText('text/plain', text);
            await sess.onClipboardPaste(cd);
            lastFormatListSentAt = Date.now();
            advertisedClipboardRef.current.set(tabId, {
              kind: 'text',
              text,
            });
            cblog('[clipboard] ✅ ' + (reason === 'Focus' ? 'Focus' : 'Poll') + ' sync → FormatList sent for:', text.slice(0, 50));
          } else if (reason === 'Focus') {
            cblog('[clipboard] Focus sync: no change, skip');
          }
        } catch (e) {
          cblog('[clipboard] ' + (reason === 'Focus' ? 'Focus' : 'Poll') + ' sync error:', e);
        } finally {
          if (reason === 'Poll') clipboardPollInFlightRef.current.delete(tabId);
        }
      };
      const onFocusSync = () => { void syncClipboard('Focus'); };
      canvas.addEventListener('focus', onFocusSync);
      window.addEventListener('focus', onFocusSync);
      clipboardPollTimer = setInterval(() => {
        void syncClipboard('Poll');
      }, 6000);

      cleanupFn = () => {
        releaseAllKeys();
        canvas.removeEventListener('keydown', onKeyDown);
        canvas.removeEventListener('keyup', onKeyUp);
        canvas.removeEventListener('mousemove', onMouseMove);
        canvas.removeEventListener('mousedown', onMouseDown);
        window.removeEventListener('mouseup', onMouseUp);
        canvas.removeEventListener('contextmenu', onCtxMenu);
        canvas.removeEventListener('wheel', onWheel);
        canvas.removeEventListener('blur', onCanvasBlur);
        window.removeEventListener('blur', onWindowBlur);
        canvas.removeEventListener('focus', onFocusSync);
        window.removeEventListener('focus', onFocusSync);
        if (clipboardPollTimer) clearInterval(clipboardPollTimer);
        discardPendingMouseMove();
      };
    };

    // Delay first attach to ensure DOM is settled
    const timer = setTimeout(attachEvents, 50);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      cleanupFn?.();
    };
  }, [store.activeTabId, store.activeTab?.status]);

  // ── Adaptive resize after connect: only when the app window itself resizes ──
  useEffect(() => {
    const scheduleResize = (reason: string) => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      const debounceMs = USE_KKTERM_COPY_MACOS
        ? KKTERM_MACOS_ADAPTIVE_RESIZE_DEBOUNCE_MS
        : ADAPTIVE_RESIZE_DEBOUNCE_MS;
      resizeTimerRef.current = setTimeout(
        () => performAdaptiveResizeRef.current(reason),
        debounceMs,
      );
    };

    // Initial adaptive sizing is handled during connect. After the session is
    // connected, only user-driven NextDesk window resizes may change the remote
    // desktop size; wrapper/focus/poll layout stabilization must not reconnect.
    const onWindowResize = () => scheduleResize('window resize');
    const onVisualViewportResize = () => scheduleResize('visual viewport');
    window.addEventListener('resize', onWindowResize);
    window.visualViewport?.addEventListener('resize', onVisualViewportResize);

    return () => {
      window.removeEventListener('resize', onWindowResize);
      window.visualViewport?.removeEventListener('resize', onVisualViewportResize);
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    };
  }, [store.activeTabId]);

  const activeTab = store.activeTab;
  const hasActiveTabs = store.tabs.length > 0;

  const openClipboardFolder = useCallback(() => {
    const tabId = store.activeTabId;
    if (!tabId) return;
    invoke<boolean>('open_session_clipboard_folder', { sessionId: tabId })
      .then(opened => {
        if (!opened) {
          cblog('[file-transfer] No session clipboard folder available to open');
        }
      })
      .catch(e => cblog('[file-transfer] Failed to open session clipboard folder:', e));
  }, [store.activeTabId]);

  const toggleMacClipboardStrategy = useCallback(() => {
    const next = macClipboardStrategy === 'session-file-url'
      ? 'pasteboard-promise'
      : 'session-file-url';
    invoke<'session-file-url' | 'pasteboard-promise'>('set_mac_clipboard_strategy', { strategy: next })
      .then(strategy => {
        setMacClipboardStrategy(strategy);
        cblog('[file-transfer] macOS clipboard strategy switched to:', strategy);
      })
      .catch(e => cblog('[file-transfer] Failed to switch macOS clipboard strategy:', e));
  }, [macClipboardStrategy]);

  // ── On-demand canvas snapshots for grid thumbnails ──
  const refreshGridThumbnails = useCallback(() => {
    const captured = captureConnectedTabThumbnails({
      tabs: tabsRef.current,
      canvasRefs: canvasRefs.current,
      overlayCanvasRefs: h264OverlayRefs.current,
      updateTabThumbnail: store.updateTabThumbnail,
      requestSessionThumbnail: (tabId, updateThumbnail) => {
        const session = sessionRefs.current.get(tabId);
        const wasm = wasmModule;
        if (!session || !wasm) return false;

        try {
          session.invokeExtension(new wasm.Extension('snapshot_thumbnail', (thumbnailUrl: string) => {
            if (!thumbnailUrl.startsWith('data:image/')) return;
            updateThumbnail(thumbnailUrl);
          }));
          return true;
        } catch (error) {
          rdpLog.warn('display', 'session thumbnail snapshot request failed; falling back to canvas capture', {
            tabId,
            error: error instanceof Error ? error.message : String(error),
          });
          return false;
        }
      },
    });
    if (captured > 0) {
      rdpLog.debug('display', `captured ${captured} tab thumbnail(s) for grid view`);
    }
  }, [store.updateTabThumbnail]);

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    if (mode === 'grid') {
      refreshGridThumbnails();
    }
    store.setViewMode(mode);
  }, [refreshGridThumbnails, store.setViewMode]);

  return (
    <div className="flex h-full overflow-hidden">
      <RdpSidebar
        store={store}
        selectedServerId={selectedServerId}
        onConnectServer={handleConnectServer}
        onSelectServer={handleSelectServer}
        onNewServer={() => { setEditServerId(null); setShowNewConn(true); }}
        onEditServer={(id) => { setEditServerId(id); setShowNewConn(true); }}
        onDeleteServer={(id) => { store.removeServer(id); }}
      />

      <div ref={containerRef} className="flex-1 flex flex-col min-w-0 relative transition-all duration-300">
        {USE_KKTERM_COPY_WINDOWS && Object.entries(kktermOverlayBackdropRects).map(([id, rect]) => (
          <div
            key={id}
            className="fixed z-[98] pointer-events-none bg-popover"
            style={{
              left: Math.max(0, rect.x - 1),
              top: Math.max(0, rect.y - 1),
              width: Math.max(1, rect.width + 2),
              height: Math.max(1, rect.height + 1),
            }}
          />
        ))}

        {/* TabBar — data-bar for height calculation */}
        <div data-bar>
          <RdpTabBar
            tabs={store.tabs}
            activeTabId={store.activeTabId}
            viewMode={store.viewMode}
            sidebarOpen={store.sidebarOpen}
            onToggleSidebar={() => store.setSidebarOpen(!store.sidebarOpen)}
            onSelectTab={store.setActiveTabId}
            onCloseTab={handleCloseTab}
            onViewModeChange={handleViewModeChange}
            onReorderTabs={store.reorderTabs}
            onReconnectTab={(tabId) => reconnectWithSize(tabId)}
            activeXSafeMenus={USE_KKTERM_COPY_WINDOWS}
            onOverlayClipRectChange={handleKktermOverlayClipRectChange}
            sessionControls={activeTab?.status === 'connected' ? {
              resMode,
              resolution: rdpStats.resolution,
              fps: ENABLE_RDP_FRAME_DIAGNOSTICS ? rdpStats.fps : null,
              presets: RESOLUTION_PRESETS,
              macClipboardStrategy,
              hasClipboardFolder,
              showClipboardManagement: !USE_KKTERM_COPY_RDP,
              showDriveRedirection: USE_KKTERM_COPY_WINDOWS,
              driveRedirectionEnabled,
              showMultiMonitor: USE_KKTERM_COPY_WINDOWS,
              multiMonitorEnabled,
              showWinKey: !USE_KKTERM_COPY_WINDOWS,
              ctrlAltDelMode: USE_KKTERM_COPY_WINDOWS ? 'hint' : 'send',
              fullscreen: isFullscreen,
              onApplyResolution: applyResolution,
              onToggleFullscreen: () => { void toggleFullscreen(); },
              onToggleDriveRedirection: toggleDriveRedirection,
              onToggleMultiMonitor: toggleMultiMonitor,
              onToggleClipboardStrategy: toggleMacClipboardStrategy,
              onOpenClipboardFolder: openClipboardFolder,
              onSendClipboardText: USE_KKTERM_COPY_RDP ? () => sendClipboardTextRef.current?.() : undefined,
              onSendWinKey: () => sendWinKeyRef.current?.(),
              onSendCtrlAltDel: () => sendCtrlAltDelRef.current?.(),
              onDisconnect: () => handleCloseTab(activeTab.id),
            } : null}
          />
        </div>

        {!hasActiveTabs && (
          <RdpEmptyState onNewServer={() => setShowNewConn(true)} />
        )}

        {hasActiveTabs && store.viewMode === 'grid' && (
          <RdpGridView
            tabs={store.tabs}
            activeTabId={store.activeTabId}
            onSelectTab={(id) => {
              store.setActiveTabId(id);
              store.setViewMode('tab');
            }}
          />
        )}

        {hasActiveTabs && (
          <div className={store.viewMode !== 'tab' ? 'hidden' : 'contents'}>
            {/* Canvas wrapper — fills remaining flex space */}
            <div ref={canvasWrapRef} className="flex-1 relative min-h-0 min-w-0 rdp-stage-background overflow-hidden">
              {/* Canvas layers: one per tab, absolutely positioned */}
              {USE_KKTERM_COPY_MACOS
                ? store.tabs.map(tab => {
                    const server = store.getServerById(tab.serverId);
                    if (!server) return null;
                    const launch = kktermRdpLaunch[tab.id];
                    if (!launch) return null;
                    return (
                      <KktermRdpSurface
                        key={`${tab.id}:${launch.nonce}`}
                        tabId={tab.id}
                        server={server}
                        active={tab.id === activeTab?.id}
                        cadSignal={kktermRdpCadSignalByTab[tab.id] ?? 0}
                        textSignal={kktermRdpTextSignalByTab[tab.id] ?? null}
                        winSignal={kktermRdpWinSignalByTab[tab.id] ?? 0}
                        desktopSize={launch.desktopSize}
                        reuseCloudBinding={launch.reuseCloudBinding}
                        onConnected={markKktermTabConnected}
                        onDisconnected={handleKktermDisconnected}
                        onError={handleKktermError}
                        onRouteSelected={(tabId, routeLabel, routeLeaseId) => {
                          kktermRouteLeaseIdsRef.current.set(tabId, routeLeaseId);
                          store.updateTabRoute(tabId, routeLabel);
                        }}
                        onCanvasRef={handleKktermCanvasRef}
                      />
                    );
                  })
                : store.tabs.map(tab => (
                    <canvas
                      key={tab.id}
                      ref={el => {
                        if (el) canvasRefs.current.set(tab.id, el);
                        else canvasRefs.current.delete(tab.id);
                      }}
                      className={cn(
                        "cursor-default outline-none",
                        tab.id === activeTab?.id && tab.status === 'connected' && "absolute inset-0 w-full h-full",
                        tab.id === activeTab?.id && tab.status === 'connecting' && "absolute inset-0 opacity-0 pointer-events-none",
                        (tab.id !== activeTab?.id || (tab.status !== 'connected' && tab.status !== 'connecting')) && "hidden"
                      )}
                      tabIndex={0}
                    />
                  ))}
              {/* H.264 overlay canvases — separate 2D context per tab, layered on top.
                  pointer-events-none so clicks pass through to the WASM canvas below. */}
              {!USE_KKTERM_COPY_RDP && store.tabs.map(tab => (
                <canvas
                  key={`h264-${tab.id}`}
                  ref={el => {
                    if (el) h264OverlayRefs.current.set(tab.id, el);
                    else h264OverlayRefs.current.delete(tab.id);
                  }}
                  className={cn(
                    "pointer-events-none",
                    tab.id === activeTab?.id && tab.status === 'connected' && "absolute inset-0 w-full h-full",
                    (tab.id !== activeTab?.id || tab.status !== 'connected') && "hidden"
                  )}
                  style={{ opacity: 0, transition: 'opacity 0.1s' }}
                />
              ))}


              {/* Overlays for non-connected states */}
              {activeTab?.status === 'connecting' && (
                <RdpConnectionOverlay name={activeTab.name} routeLabel={activeTab.routeLabel} />
              )}

              {activeTab?.status === 'error' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-8">
                  <div className="max-w-md rounded-lg border border-destructive/25 bg-destructive/10 px-4 py-3 text-center shadow-sm">
                    <p className="text-sm font-semibold text-destructive">{t('rdpStatusError')}</p>
                    <p className="mt-1 text-sm text-destructive/90 whitespace-pre-wrap">
                      {activeTab.errorMsg || t('rdpErrUnknown')}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => {
                      userDisconnectedRef.current.delete(activeTab.id);
                      connectSession(activeTab.id);
                    }}>{t('rdpRetry')}</Button>
                    <Button variant="outline" size="sm" onClick={() => { setEditServerId(activeTab.serverId); setShowNewConn(true); }}>{t('rdpEdit')}</Button>
                  </div>
                </div>
              )}

              {activeTab?.status === 'reconnecting' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
                  <div className="h-12 w-12 rounded-full border-4 border-cyan-500/30 border-t-cyan-500 animate-spin" />
                  <div className="min-h-[90px] flex flex-col items-center justify-start gap-3">
                    <p className="text-sm text-muted-foreground whitespace-pre-line text-center">{activeTab.errorMsg || t('rdpReconnectingMsg')}</p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        userDisconnectedRef.current.add(activeTab.id);
                        const timer = reconnectTimerRef.current.get(activeTab.id);
                        if (timer) { clearTimeout(timer); reconnectTimerRef.current.delete(activeTab.id); }
                        reconnectCountRef.current.delete(activeTab.id);
                        store.updateTabStatus(activeTab.id, 'disconnected');
                      }}
                    >{t('rdpCancelReconnect')}</Button>
                  </div>
                </div>
              )}

              {activeTab?.status === 'idle' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
                  <Monitor className="h-16 w-16 text-slate-700" />
                  <p className="text-sm text-muted-foreground">{t('rdpClickToConnect', { name: activeTab.name })}</p>
                  <Button
                    className="bg-gradient-to-r from-cyan-600 to-blue-600 text-white"
                    onClick={() => connectSession(activeTab.id)}
                  >{t('rdpConnect')}</Button>
                </div>
              )}
            </div>

          </div>
        )}


      </div>

      {showNewConn && (
        <NewConnectionDialog
          key={editServerId ?? 'new-connection'}
          store={store}
          open
          onClose={() => { setShowNewConn(false); setEditServerId(null); }}
          onSaved={(id, connect) => { setEditServerId(null); handleNewSaved(id, connect); }}
          editServer={editServerId ? store.getServerById(editServerId) : null}
        />
      )}
    </div>
  );
}

import { useState, useCallback, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { readText as tauriReadClipboard, writeText as tauriWriteClipboard } from '@tauri-apps/plugin-clipboard-manager';
import { RdpSidebar } from './RdpSidebar';
import { RdpTabBar } from './RdpTabBar';
import { RdpGridView } from './RdpGridView';
import { NewConnectionDialog } from './NewConnectionDialog';
import { useSessionStore } from '@/lib/useSessionStore';
import { Monitor } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n/useTranslation';
import type { TranslationKey } from '@/i18n/translations';
import { codeToScancode } from '@/lib/scancodeMap';

import DecodeWorkerUrl from '@/lib/decode-worker.ts?worker&url';
import { rdpLog } from '@/lib/rdp-logger';
import { api } from '@/api';
import { useNativeRdp, connectFrameWebSocket, type NativeGfxH264Frame } from '@/hooks/useNativeRdp';

/**
 * Native RDP mode flag.
 * When true, uses the Rust backend for RDP sessions (direct TCP/TLS).
 * When false, uses the WASM-based IronRDP via WebSocket proxy (legacy).
 */
const USE_NATIVE_RDP = true;
const USE_NATIVE_GFX_H264 = true;
const ADAPTIVE_RESIZE_DEBOUNCE_MS = 800;
const ADAPTIVE_RESIZE_THRESHOLD_PX = 20;
const THUMBNAIL_CAPTURE_INTERVAL_MS = 10000;

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
          rdpLog[level]('wasm', msg);
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

const RDP_FILE_MIME = 'application/x-rdp-file';

type NormalizedTransferredFile = {
  name: string;
  size: number;
  data: Uint8Array;
};

type ClipboardFilePayload = {
  name: string;
  size: number;
  data: Uint8Array;
  path?: string;
};

type AdvertisedClipboardSnapshot =
  | {
    kind: 'files';
    fileKey: string;
    files: ClipboardFilePayload[];
  }
  | {
    kind: 'text';
    text: string;
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

function addClipboardFiles(
  clipboardData: WasmClipboardData,
  files: Array<{ name: string; size: number; data: Uint8Array; path?: string }>,
) {
  const descriptors = files.map(file => ({
    name: file.name,
    size: file.size,
  }));

  clipboardData.addBinary(
    RDP_FILE_MIME,
    new TextEncoder().encode(JSON.stringify(descriptors)),
  );

  for (const file of files) {
    if (file.data.length > 0) {
      // In-memory file: add binary data directly
      clipboardData.addBinary(file.name, file.data);
    } else if (file.path) {
      // Lazy file: add path as MIME key with empty data
      // WASM will store the path in local_file_paths for async reading
      clipboardData.addBinary(file.path, new Uint8Array(0));
    }
  }
}

function cloneClipboardFilePayloads(files: ClipboardFilePayload[]): ClipboardFilePayload[] {
  return files.map(file => ({
    name: file.name,
    size: file.size,
    data: new Uint8Array(file.data),
    path: file.path,
  }));
}

function cloneAdvertisedClipboardSnapshot(
  snapshot: AdvertisedClipboardSnapshot,
): AdvertisedClipboardSnapshot {
  if (snapshot.kind === 'files') {
    return {
      kind: 'files',
      fileKey: snapshot.fileKey,
      files: cloneClipboardFilePayloads(snapshot.files),
    };
  }

  return {
    kind: 'text',
    text: snapshot.text,
  };
}

function buildClipboardDataFromSnapshot(
  wasm: IronRdpWasm,
  snapshot: AdvertisedClipboardSnapshot,
): WasmClipboardData {
  const clipboardData = new wasm.ClipboardData();

  if (snapshot.kind === 'files') {
    addClipboardFiles(clipboardData, cloneClipboardFilePayloads(snapshot.files));
  } else {
    clipboardData.addText('text/plain', snapshot.text);
  }

  return clipboardData;
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
  resize(w: number, h: number, scale_factor?: number | null, physical_width?: number | null, physical_height?: number | null): void;
  onClipboardPaste(content: WasmClipboardData): Promise<void>;
  shutdown(): void;
  releaseAllInputs(): void;
  supportsUnicodeKeyboardShortcuts(): boolean;
  synchronizeLockKeys(scroll_lock: boolean, num_lock: boolean, caps_lock: boolean, kana_lock: boolean): void;
}

/** Map raw RDP/WASM errors to user-friendly messages */
function friendlyRdpError(raw: string, t: (key: TranslationKey) => string): string {
  const r = raw.toLowerCase();
  if (r.includes('status_logon_failure') || r.includes('0xc000006d'))
    return t('rdpErrLoginFailed');
  if (r.includes('status_account_disabled') || r.includes('0xc0000072'))
    return t('rdpErrAccountDisabled');
  if (r.includes('status_account_locked') || r.includes('0xc0000234'))
    return t('rdpErrAccountLocked');
  if (r.includes('status_password_expired') || r.includes('0xc0000071'))
    return t('rdpErrPasswordExpired');
  if (r.includes('status_account_expired') || r.includes('0xc0000193'))
    return t('rdpErrAccountExpired');
  if (r.includes('status_password_must_change') || r.includes('0xc0000224'))
    return t('rdpErrPasswordMustChange');
  if (r.includes('credssp'))
    return t('rdpErrCredSsp');
  if (r.includes('tls') || r.includes('ssl') || r.includes('certificate'))
    return t('rdpErrTls');
  if (r.includes('dns') || r.includes('resolve'))
    return t('rdpErrDns');
  if (r.includes('refused') || r.includes('reset'))
    return t('rdpErrRefused');
  if (r.includes('timeout') || r.includes('timed out'))
    return t('rdpErrTimeout');
  if (r.includes('rdcleanpath'))
    return t('rdpErrWsClosed');
  if (r.includes('websocket') || r.includes('ws://'))
    return t('rdpErrWsClosed');
  if (r.includes('canvas'))
    return t('rdpErrCanvas');
  if (r.includes('another user connected') || r.includes('forcing the disconnection'))
    return t('rdpErrAnotherUser');
  if (r.includes('administratively'))
    return t('rdpErrAdmin');
  if (r.includes('idle timeout'))
    return t('rdpErrIdleTimeout');
  // fallback: return the original but truncated
  return raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
}

let wasmModule: IronRdpWasm | null = null;
let wasmReady = false;
async function loadWasm(): Promise<IronRdpWasm> {
  if (wasmModule && wasmReady) return wasmModule;
  // @ts-ignore
  const mod = await import('../wasm/ironrdp_web.js');
  // @ts-ignore
  const url = new URL('../wasm/ironrdp_web_bg.wasm', import.meta.url).href;
  await mod.default(url);
  // Diagnostic mode: keep WASM tracing at debug so RDPSND/DRDYNVC
  // initialization details are visible while investigating audio redirection.
  mod.setup('debug');
  wasmModule = mod as unknown as IronRdpWasm;
  wasmReady = true;
  return wasmModule;
}

export function RdpManager({ onMainSidebarCollapse }: { onMainSidebarCollapse?: () => void } = {}) {
  const { t } = useTranslation();
  const store = useSessionStore();
  const [rdpStats, setRdpStats] = useState({ resolution: '', fps: 0, status: 'idle' as string });
  const [hasClipboardFolder, setHasClipboardFolder] = useState(false);
  const [macClipboardStrategy, setMacClipboardStrategy] = useState<'session-file-url' | 'pasteboard-promise'>('session-file-url');
  const fpsCountRef = useRef(0);
  const fpsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Resolution mode: 'adaptive' or '1920x1080' etc.
  const RESOLUTION_PRESETS = [
    { label: '自适应', value: 'adaptive' },
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
  const [proxyPort, setProxyPort] = useState(18765);




  const canvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const sessionRefs = useRef<Map<string, WasmSession>>(new Map());

  // H.264 GFX path: Worker-based VideoDecoder + per-tab overlay canvas.
  // The overlay canvas uses a 2D context (separate from the WASM WebGL2 canvas)
  // to display decoded VideoFrames without context-type conflicts.
  const decodeWorkerRef = useRef<Worker | null>(null);
  const h264OverlayRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());

  const cleanupH264Worker = useCallback((tabId?: string) => {
    if (decodeWorkerRef.current) {
      decodeWorkerRef.current.postMessage({ type: 'close' });
      decodeWorkerRef.current.terminate();
      decodeWorkerRef.current = null;
    }
    if (tabId) {
      const overlay = h264OverlayRefs.current.get(tabId);
      if (overlay) overlay.style.opacity = '0';
    }
  }, []);

  const ensureH264Worker = useCallback((tabId: string): Worker | null => {
    if (typeof VideoDecoder === 'undefined') {
      rdpLog.warn('render', 'WebCodecs not available, native GFX H.264 disabled');
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
          const overlay = h264OverlayRefs.current.get(tabId);
          if (overlay) {
            if (overlay.width !== frame.displayWidth || overlay.height !== frame.displayHeight) {
              overlay.width = frame.displayWidth;
              overlay.height = frame.displayHeight;
            }
            const ctx2d = overlay.getContext('2d');
            if (ctx2d) ctx2d.drawImage(frame, 0, 0, overlay.width, overlay.height);
            overlay.style.opacity = '1';
          }
          frame.close();
        } else if (msg.type === 'error') {
          rdpLog.warn('render', 'h264 worker error', { message: msg.message });
        }
      };

      return worker;
    } catch (e) {
      rdpLog.warn('render', 'Worker creation failed, native GFX H.264 disabled', { error: String(e) });
      decodeWorkerRef.current = null;
      return null;
    }
  }, []);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const activeTabIdRef = useRef<string | null>(null);
  const tabsRef = useRef(store.tabs);
  const lastSizeRef = useRef({ w: 0, h: 0 });
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeCooldownRef = useRef(false); // suppress adaptive resize after connect
  // When user picks a fixed resolution, store it here for reconnect
  const desiredSizeRef = useRef<{ w: number; h: number } | null>(null);
  const connectSessionRef = useRef<(tabId: string) => void>(null);
  // Auto-reconnect state
  const reconnectCountRef = useRef<Map<string, number>>(new Map());
  const reconnectTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const MAX_RECONNECT_ATTEMPTS = 5;
  const userDisconnectedRef = useRef<Set<string>>(new Set());
  const connectingTabsRef = useRef<Set<string>>(new Set());
  const advertisedClipboardRef = useRef<Map<string, AdvertisedClipboardSnapshot>>(new Map());
  const forceClipboardReadInFlightRef = useRef<Set<string>>(new Set());
  const rdpdrEnabledRef = useRef<Set<string>>(new Set());
  const pasteShortcutInFlightRef = useRef<Set<string>>(new Set());
  const keepCursorVisibleUntilRef = useRef<Map<string, number>>(new Map());

  const fileTransferInProgressRef = useRef<Set<string>>(new Set());
  const clipboardPollInFlightRef = useRef<Set<string>>(new Set());
  // Track file keys received from remote to prevent feedback loop:
  // remote download → write to clipboard → Poll/Focus detects → sends FormatList back
  const remoteClipboardFileKeyRef = useRef<Map<string, string>>(new Map());
  const sendWinKeyRef = useRef<(() => void) | null>(null);
  const sendCtrlAltDelRef = useRef<(() => void) | null>(null);
  const prevSidebarOpenRef = useRef(store.sidebarOpen);
  activeTabIdRef.current = store.activeTabId;
  tabsRef.current = store.tabs;

  // Ref to track which tabs are connected via native backend
  const nativeTabsRef = useRef<Set<string>>(new Set());

  // ── Native RDP event rendering hook ──
  // Only active when USE_NATIVE_RDP is enabled
  const activeCanvas = store.activeTabId
    ? canvasRefs.current.get(store.activeTabId) ?? null
    : null;

  const handleNativeStatus = useCallback((tabId: string, status: string, message?: string) => {
    rdpLog.info('native', `status event: ${status}`, { tabId, message });
    if (status === 'connected') {
      store.updateTabStatus(tabId, 'connected');
      setRdpStats(prev => ({ ...prev, status: 'connected' }));
      nativeTabsRef.current.add(tabId);
    } else if (status === 'disconnected') {
      nativeTabsRef.current.delete(tabId);
      cleanupH264Worker(tabId);
      if (userDisconnectedRef.current.has(tabId)) {
        store.updateTabStatus(tabId, 'disconnected');
      } else {
        // Auto-reconnect
        store.updateTabStatus(tabId, 'reconnecting');
        const count = reconnectCountRef.current.get(tabId) ?? 0;
        if (count < MAX_RECONNECT_ATTEMPTS) {
          reconnectCountRef.current.set(tabId, count + 1);
          const delay = Math.min(1000 * (count + 1), 5000);
          const timer = setTimeout(() => {
            reconnectTimerRef.current.delete(tabId);
            connectSessionRef.current?.(tabId);
          }, delay);
          reconnectTimerRef.current.set(tabId, timer);
        }
      }
    } else if (status === 'error') {
      nativeTabsRef.current.delete(tabId);
      cleanupH264Worker(tabId);
      store.updateTabStatus(tabId, 'error');
      rdpLog.error('native', `session error: ${message}`, { tabId });
    }
  }, [store, cleanupH264Worker]);

  useNativeRdp({
    tabId: USE_NATIVE_RDP ? store.activeTabId : null,
    canvas: USE_NATIVE_RDP ? activeCanvas : null,
    onStatus: handleNativeStatus,
  });
  useEffect(() => {
    installRdpConsoleBridge();
    invoke<number>('get_rdp_proxy_port').then(setProxyPort).catch(() => { });
    invoke<'session-file-url' | 'pasteboard-promise'>('get_mac_clipboard_strategy')
      .then(setMacClipboardStrategy)
      .catch(() => {});
    loadWasm().catch(() => { });
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
    const w = Math.floor(wrap.clientWidth);
    const h = Math.floor(wrap.clientHeight);
    rdpLog.debug('render', `getCanvasSize: ${w} x ${h}`);
    return { w: Math.max(w, 320), h: Math.max(h, 240) };
  }, []);

  // ── Suppress adaptive resize when sidebar collapses/expands ──
  useEffect(() => {
    // Skip on initial mount
    if (prevSidebarOpenRef.current === store.sidebarOpen) return;
    prevSidebarOpenRef.current = store.sidebarOpen;

    // Activate resize cooldown to prevent ResizeObserver from triggering reconnect
    resizeCooldownRef.current = true;

    // After sidebar transition animation completes (~300ms), update lastSizeRef
    // to the new canvas size so future genuine resizes are measured correctly
    const timer = setTimeout(() => {
      const cur = getCanvasSize();
      if (cur.w > 0 && cur.h > 0) {
        lastSizeRef.current = { w: cur.w, h: cur.h };
      }
      resizeCooldownRef.current = false;
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
          // Transitioning hidden → visible: suppress resize-triggered reconnect
          resizeCooldownRef.current = true;
          setTimeout(() => {
            const cur = getCanvasSize();
            if (cur.w > 0 && cur.h > 0) {
              lastSizeRef.current = { w: cur.w, h: cur.h };
            }
            resizeCooldownRef.current = false;
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
      rdpLog.warn('connection', 'connectSession skipped: local connect lock active', { tabId });
      return;
    }
    const tab = store.tabs.find(t => t.id === tabId);
    if (!tab) return;
    // Guard: prevent double-connection
    if (tab.status === 'connecting' || tab.status === 'connected') {
      rdpLog.warn('connection', `connectSession skipped: already ${tab.status}`, { tabId });
      return;
    }
    if (sessionRefs.current.has(tabId)) {
      rdpLog.warn('connection', 'connectSession skipped: session already exists', { tabId });
      return;
    }
    const server = store.getServerById(tab.serverId);
    if (!server) return;

    connectingTabsRef.current.add(tabId);
    // Keep 'reconnecting' UI during auto-reconnect instead of flashing back to 'Connecting to...'
    if (tab.status !== 'reconnecting') {
      store.updateTabStatus(tabId, 'connecting');
    }
    try {
      // Wait for 2 animation frames to ensure the wrapper div is in the DOM and laid out
      await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));

      const canvas = canvasRefs.current.get(tabId);
      if (!canvas) throw new Error('Canvas not ready');

      // Use desired size if set (from resolution switching), otherwise wrapper size
      let w: number, h: number;
      if (desiredSizeRef.current) {
        w = desiredSizeRef.current.w;
        h = desiredSizeRef.current.h;
        rdpLog.info('connection', `using desired size: ${w} x ${h}`);
      } else {
        const cs = getCanvasSize();
        w = cs.w; h = cs.h;
        rdpLog.info('connection', `using wrapper size: ${w} x ${h}`);
      }
      canvas.width = w;
      canvas.height = h;
      lastSizeRef.current = { w, h };
      // Suppress adaptive resize for 1s after connect to let toolbar layout settle
      resizeCooldownRef.current = true;
      setTimeout(() => {
        const cur = getCanvasSize();
        if (cur.w > 0 && cur.h > 0) lastSizeRef.current = { w: cur.w, h: cur.h };
        resizeCooldownRef.current = false;
      }, 1000);

      // ── Native RDP mode: connect via Rust backend ──
      if (USE_NATIVE_RDP) {
        rdpLog.info('native', `connecting natively: ${server.host}:${server.port} @ ${w}x${h}`);
        const nativeGfxWorker = USE_NATIVE_GFX_H264 ? ensureH264Worker(tabId) : null;
        const handleNativeGfxFrame = USE_NATIVE_GFX_H264
          ? (frame: NativeGfxH264Frame) => {
              nativeGfxWorker?.postMessage(
                { type: 'decode', data: frame.data, timestamp: performance.now() * 1000 },
                [frame.data],
              );
            }
          : undefined;

        // Connect via Rust backend — returns WS port for frame streaming
        const wsPort = await api.rdpNativeConnect({
          tabId,
          host: server.host,
          port: server.port,
          username: server.username,
          password: server.password,
          domain: server.domain || undefined,
          width: w,
          height: h,
        });
        rdpLog.info('native', `rdp_native_connect returned ws_port=${wsPort}`);

        // Connect WebSocket for zero-overhead frame streaming
        const cleanupWs = connectFrameWebSocket(
          wsPort,
          canvas,
          () => {
            fpsCountRef.current++;
          },
          handleNativeGfxFrame,
        );
        // Store cleanup for later disconnection
        (window as any).__rdp_ws_cleanup__ = cleanupWs;

        // Suppress adaptive resize after connect
        resizeCooldownRef.current = true;
        setTimeout(() => {
          const cur = getCanvasSize();
          if (cur.w > 0 && cur.h > 0) lastSizeRef.current = { w: cur.w, h: cur.h };
          resizeCooldownRef.current = false;
        }, 1500);

        // Set up FPS counter
        fpsIntervalRef.current = setInterval(() => {
          setRdpStats(prev => ({ ...prev, fps: fpsCountRef.current }));
          fpsCountRef.current = 0;
        }, 1000);

        connectingTabsRef.current.delete(tabId);
        return; // Skip WASM path below
      }

      // ── WASM mode: connect via WebSocket proxy (legacy) ──
      const wasm = await loadWasm();

      const size = new wasm.DesktopSize(w, h);
      const builder = new wasm.SessionBuilder()
        .proxyAddress(`ws://127.0.0.1:${proxyPort}`)
        .authToken('nextdesk-local')
        .destination(`${server.host}:${server.port}`)
        .username(server.username)
        .password(server.password)
        .desktopSize(size)
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
          rdpLog.info('render', `canvasResizedCallback → canvas: ${cw} x ${ch}`);
          if (cw > 0 && ch > 0) {
            lastSizeRef.current = { w: cw, h: ch };
            fpsCountRef.current++;
            setRdpStats(prev => ({ ...prev, resolution: `${cw}×${ch}` }));
          }
        })
        .remoteClipboardChangedCallback((data: WasmClipboardData) => {
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
        })
        .forceClipboardUpdateCallback(() => {
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
        })
        .fileContentsRequestCallback((request: any) => {
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
        })
        .fileContentsResponseCallback((filesData: any) => {
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
        })
        .fileChunkCallback((chunkInfo: any) => {
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
        });

      // FPS counter: init counter (monkey-patch applied after connect when WebGL2 ctx exists)
      (globalThis as any).__nextdesk_fps_count = 0;
      if (fpsIntervalRef.current) clearInterval(fpsIntervalRef.current);

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

        builder.extension(new wasm.Extension('drive_share_name', 'NextDesk'));
        cblog('[rdpdr] drive_share_name extension configured:', 'NextDesk');

        if (driveEntries.length > 0) {
          builder.extension(new wasm.Extension('drive_entries', JSON.stringify(driveEntries)));
          cblog('[rdpdr] drive_entries extension configured:', driveEntries.length);
        } else {
          cblog('[rdpdr] Shared folder is empty or metadata scan returned no entries');
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
        builder.extension(new wasm.Extension('rdpdr_read_callback', rdpdrReadCallback));
        rdpdrEnabledRef.current.add(tabId);
        cblog('[rdpdr] RDPDR drive sharing enabled:', `NextDesk -> ${rdpdrSharedFolder}`);
      } catch (rdpdrError) {
        rdpdrEnabledRef.current.delete(tabId);
        cblog('[rdpdr] RDPDR initialization failed:', rdpdrError);
        try {
          builder.extension(new wasm.Extension('drive_share_name', 'NextDesk'));
          cblog('[rdpdr] drive_share_name fallback configured:', 'NextDesk');
        } catch {}
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
      builder.extension(new wasm.Extension('audio_callback', audioCallback));
      rdpLog.info('audio', 'RDPSND audio redirection enabled (native cpal backend)');

      // Enable GFX pipeline (H.264 hardware decoding)
      if (typeof VideoDecoder !== 'undefined') {
        // Phase 4: create decode worker for H.264 offloading
        try {
          const worker = new Worker(DecodeWorkerUrl, { type: 'module' });
          decodeWorkerRef.current = worker;
          worker.postMessage({ type: 'configure', codec: 'avc1.64001f' });

          worker.onmessage = (e: MessageEvent) => {
            const msg = e.data;
            if (msg.type === 'frame') {
              const frame = msg.frame as VideoFrame;
              // Draw decoded VideoFrame onto the H.264 overlay canvas (2D context).
              // The WASM canvas is locked to WebGL2 — using getContext('2d') on it
              // returns null. The overlay canvas is a separate element with its own 2D ctx.
              const overlay = h264OverlayRefs.current.get(tabId);
              if (overlay) {
                // Resize overlay to match frame if needed
                if (overlay.width !== frame.displayWidth || overlay.height !== frame.displayHeight) {
                  overlay.width = frame.displayWidth;
                  overlay.height = frame.displayHeight;
                }
                const ctx2d = overlay.getContext('2d');
                if (ctx2d) {
                  ctx2d.drawImage(frame, 0, 0, overlay.width, overlay.height);
                }
                // Make overlay visible on first H.264 frame
                overlay.style.opacity = '1';
              }
              frame.close();
            } else if (msg.type === 'error') {
              rdpLog.warn('render', 'h264 worker error', { message: msg.message });
            }
          };
        } catch (e) {
          rdpLog.warn('render', 'Worker creation failed, using main-thread fallback');
        }

        // Phase 4: H.264 GFX callback — forward NAL to worker only.
        // No main-thread fallback: if worker is unavailable, H.264 frames are dropped
        // (server will still send bitmap fallback via FastPath).
        const gfxCallback = (type: string, data: any) => {
          if (type === 'h264_frame' && decodeWorkerRef.current) {
            const buf = data.data.buffer.slice(0);
            decodeWorkerRef.current.postMessage(
              { type: 'decode', data: buf, timestamp: performance.now() * 1000 },
              [buf],
            );
          }
          // Other GFX events (create_surface, reset_graphics, etc.) are informational
          // and don't need rendering action in the current architecture.
        };
        builder.extension(new wasm.Extension('gfx_callback', gfxCallback));
        rdpLog.info('render', 'GFX H.264 pipeline enabled (WebCodecs Worker)');
      } else {
        rdpLog.warn('render', 'WebCodecs not available, GFX H.264 disabled');
      }

      // Enable DisplayControl DVC for dynamic resolution updates (no reconnect needed)
      builder.extension(new wasm.Extension('display_control', true));
      rdpLog.info('render', 'DisplayControl DVC enabled for dynamic resolution');

      // Enable file transfer WS bypass for large CLIPRDR files (≥2MB)
      const ftPort = await invoke<number>('get_file_transfer_ws_port').catch(() => 0);
      if (ftPort > 0) {
        builder.extension(new wasm.Extension('file_transfer_port', ftPort));
        rdpLog.info('file', `File transfer WS port: ${ftPort} (large file bypass enabled)`);
      }

      const session = await builder.connect();
      sessionRefs.current.set(tabId, session);
      store.updateTabStatus(tabId, 'connected');

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
      rdpLog.info('connection', `negotiated resolution: ${negotiated.width} x ${negotiated.height} (requested ${w} x ${h})`);
      setRdpStats(prev => ({ ...prev, resolution: `${negotiated.width}×${negotiated.height}`, status: 'connected' }));

      // FPS counter: monkey-patch WebGL2 texSubImage2D to count frame uploads.
      // Must happen AFTER connect() since WASM creates the WebGL2 context during connect.
      const fpsCanvas2 = canvasRefs.current.get(tabId);
      if (fpsCanvas2) {
        const gl = fpsCanvas2.getContext('webgl2');
        if (gl && !(gl as any).__nextdesk_patched) {
          const origTexSubImage2D = gl.texSubImage2D.bind(gl);
          gl.texSubImage2D = function (...args: any[]) {
            (globalThis as any).__nextdesk_fps_count = ((globalThis as any).__nextdesk_fps_count || 0) + 1;
            return (origTexSubImage2D as any)(...args);
          } as any;
          (gl as any).__nextdesk_patched = true;
        }
      }

      fpsIntervalRef.current = setInterval(() => {
        const fps = (globalThis as any).__nextdesk_fps_count || 0;
        (globalThis as any).__nextdesk_fps_count = 0;
        setRdpStats(prev => ({ ...prev, fps }));
      }, 1000);

      // Try dynamic resize first (may not work if DVC not ready)
      setTimeout(() => {
        if (!sessionRefs.current.has(tabId)) return;
        const currentTab = store.tabs.find(t => t.id === tabId);
        if (!currentTab || currentTab.status !== 'connected') return;
        const { w: curW, h: curH } = getCanvasSize();
        const cur = session.desktopSize();
        const dpr = window.devicePixelRatio || 1;
        if (curW > 0 && curH > 0 && (cur.width !== curW || cur.height !== curH)) {
          rdpLog.info('render', `delayed resize attempt: ${curW} x ${curH} DPR: ${dpr}`);
          try { session.resize(curW, curH); } catch (e) { rdpLog.warn('render', 'resize failed', { error: e }); }
        }
      }, 2000);

      const info = await session.run();
      const reason = info?.reason?.() || 'unknown';
      rdpLog.info('connection', `session ended: ${tabId}`, { reason });
      connectingTabsRef.current.delete(tabId);
      sessionRefs.current.delete(tabId);
      advertisedClipboardRef.current.delete(tabId);
      forceClipboardReadInFlightRef.current.delete(tabId);
      rdpdrEnabledRef.current.delete(tabId);
      pasteShortcutInFlightRef.current.delete(tabId);
      keepCursorVisibleUntilRef.current.delete(tabId);
      fileTransferInProgressRef.current.delete(tabId);
      clipboardPollInFlightRef.current.delete(tabId);
      if (fpsIntervalRef.current) { clearInterval(fpsIntervalRef.current); fpsIntervalRef.current = null; }
      // Cleanup H.264 worker
      if (decodeWorkerRef.current) { decodeWorkerRef.current.postMessage({ type: 'close' }); decodeWorkerRef.current.terminate(); decodeWorkerRef.current = null; }
      // Hide H.264 overlay for this tab
      const overlay = h264OverlayRefs.current.get(tabId);
      if (overlay) overlay.style.opacity = '0';
      delete (globalThis as any).__nextdesk_fps_count;
      setRdpStats({ resolution: '', fps: 0, status: 'disconnected' });

      // Auto-reconnect: skip if user explicitly closed
      if (userDisconnectedRef.current.has(tabId)) {
        userDisconnectedRef.current.delete(tabId);
        store.updateTabStatus(tabId, 'disconnected');
      } else {
        // Check if the disconnect reason is non-recoverable
        const nonRecoverableReasons = [
          'another user connected', 'forcing the disconnection',
          'logon_failure', 'account_disabled', 'account_locked',
          'account_expired', 'password_expired', 'access_denied',
          'administratively', 'license', 'idle timeout',
        ];
        const lowerReason = reason.toLowerCase();
        if (nonRecoverableReasons.some(kw => lowerReason.includes(kw))) {
          rdpLog.warn('connection', 'non-recoverable disconnect', { reason });
          store.updateTabStatus(tabId, 'error', friendlyRdpError(reason, t));
        } else {
          scheduleReconnect(tabId, reason);
        }
      }
    } catch (err: any) {
      rdpLog.error('connection', 'error', { error: err?.backtrace?.() || err?.message || String(err) });
      const raw = err?.backtrace?.() || err?.message || String(err);
      connectingTabsRef.current.delete(tabId);
      sessionRefs.current.delete(tabId);
      advertisedClipboardRef.current.delete(tabId);
      forceClipboardReadInFlightRef.current.delete(tabId);
      rdpdrEnabledRef.current.delete(tabId);
      pasteShortcutInFlightRef.current.delete(tabId);
      keepCursorVisibleUntilRef.current.delete(tabId);
      fileTransferInProgressRef.current.delete(tabId);
      clipboardPollInFlightRef.current.delete(tabId);

      // Non-recoverable errors: don't reconnect
      const nonRecoverable = [
        'logon_failure', 'wrong', 'password', 'account_disabled',
        'account_locked', 'account_expired', 'password_expired',
        'access_denied', 'credssp', 'certificate',
        'another user connected', 'forcing the disconnection',
        'administratively', 'license',
      ];
      const lower = raw.toLowerCase();
      if (nonRecoverable.some(kw => lower.includes(kw))) {
        store.updateTabStatus(tabId, 'error', friendlyRdpError(raw, t));
      } else if (!userDisconnectedRef.current.has(tabId)) {
        scheduleReconnect(tabId, raw);
      } else {
        userDisconnectedRef.current.delete(tabId);
        store.updateTabStatus(tabId, 'error', friendlyRdpError(raw, t));
      }
    }
  }, [store, proxyPort, getCanvasSize, ensureH264Worker]);
  connectSessionRef.current = connectSession;

  // ── Auto-reconnect with exponential backoff ──
  const scheduleReconnect = useCallback((tabId: string, _reason: string) => {
    const count = (reconnectCountRef.current.get(tabId) || 0) + 1;
    if (count > MAX_RECONNECT_ATTEMPTS) {
      rdpLog.warn('connection', `reconnect: gave up after ${MAX_RECONNECT_ATTEMPTS} attempts`, { tabId });
      reconnectCountRef.current.delete(tabId);
      store.updateTabStatus(tabId, 'error', t('rdpReconnectFailed', { max: String(MAX_RECONNECT_ATTEMPTS) }));
      return;
    }
    reconnectCountRef.current.set(tabId, count);
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s
    const delay = Math.min(1000 * Math.pow(2, count - 1), 16000);
    rdpLog.info('connection', `reconnect #${count}/${MAX_RECONNECT_ATTEMPTS} for ${tabId} in ${delay}ms`);
    store.updateTabStatus(tabId, 'reconnecting', t('rdpReconnectingCount', { count: String(count), max: String(MAX_RECONNECT_ATTEMPTS) }));

    const timer = setTimeout(() => {
      reconnectTimerRef.current.delete(tabId);
      // Check tab still exists and hasn't been manually closed
      const tab = store.tabs.find(t => t.id === tabId);
      if (!tab || userDisconnectedRef.current.has(tabId)) {
        reconnectCountRef.current.delete(tabId);
        return;
      }
      connectSessionRef.current?.(tabId);
    }, delay);
    reconnectTimerRef.current.set(tabId, timer);
  }, [store, cleanupH264Worker]);

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
    // Disconnect native session if any
    if (nativeTabsRef.current.has(tabId)) {
      api.rdpNativeDisconnect(tabId).catch(() => {});
      nativeTabsRef.current.delete(tabId);
    }
    cleanupH264Worker(tabId);
    // Shutdown WASM session if any
    const session = sessionRefs.current.get(tabId);
    if (session) {
      try { session.shutdown(); } catch { }
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
  }, [store, cleanupH264Worker]);

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
    // Mark as user-initiated so session end handler won't trigger yellow reconnect UI
    userDisconnectedRef.current.add(tabId);
    // Disconnect native session if any
    if (nativeTabsRef.current.has(tabId)) {
      api.rdpNativeDisconnect(tabId).catch(() => {});
      nativeTabsRef.current.delete(tabId);
    }
    cleanupH264Worker(tabId);
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
    if (fpsIntervalRef.current) { clearInterval(fpsIntervalRef.current); fpsIntervalRef.current = null; }
    // Use 'connecting' instead of 'idle' to show blue spinner, not yellow
    store.updateTabStatus(tabId, 'connecting');
    setTimeout(() => {
      userDisconnectedRef.current.delete(tabId);
      connectSessionRef.current?.(tabId);
    }, 500);
  }, [store]);

  // ── Switch resolution mode ──
  const applyResolution = useCallback((mode: string) => {
    rdpLog.info('render', `applyResolution called: ${mode}`);
    setResMode(mode);
    const tabId = store.activeTabId;
    if (!tabId) return;

    if (mode === 'adaptive') {
      const { w, h } = getCanvasSize();
      rdpLog.info('render', `switching to adaptive: ${w} x ${h}`);
      // Try native resize first
      if (USE_NATIVE_RDP && nativeTabsRef.current.has(tabId)) {
        api.rdpNativeResize(tabId, w, h).then(() => {
          desiredSizeRef.current = null;
          lastSizeRef.current = { w, h };
          rdpLog.info('render', 'native resize sent (adaptive)');
        }).catch(() => {
          rdpLog.warn('render', 'native resize failed, falling back to reconnect');
          reconnectWithSize(tabId);
        });
        return;
      }
      const session = sessionRefs.current.get(tabId);
      if (session) {
        try {
          session.resize(w, h);
          desiredSizeRef.current = null;
          lastSizeRef.current = { w, h };
          rdpLog.info('render', 'dynamic resize PDU sent (adaptive)');
          return;
        } catch (e) {
          rdpLog.warn('render', 'dynamic resize failed, falling back to reconnect', { error: e });
        }
      }
      reconnectWithSize(tabId);
    } else {
      const [ws, hs] = mode.split('x').map(Number);
      if (!ws || !hs) return;
      rdpLog.info('render', `switching to fixed resolution: ${ws} x ${hs}`);
      // Try native resize first
      if (USE_NATIVE_RDP && nativeTabsRef.current.has(tabId)) {
        api.rdpNativeResize(tabId, ws, hs).then(() => {
          desiredSizeRef.current = { w: ws, h: hs };
          lastSizeRef.current = { w: ws, h: hs };
          rdpLog.info('render', 'native resize sent (fixed)');
        }).catch(() => {
          rdpLog.warn('render', 'native resize failed, falling back to reconnect');
          reconnectWithSize(tabId, ws, hs);
        });
        return;
      }
      const session = sessionRefs.current.get(tabId);
      if (session) {
        try {
          session.resize(ws, hs);
          desiredSizeRef.current = { w: ws, h: hs };
          lastSizeRef.current = { w: ws, h: hs };
          rdpLog.info('render', 'dynamic resize PDU sent (fixed)');
          return;
        } catch (e) {
          rdpLog.warn('render', 'dynamic resize failed, falling back to reconnect', { error: e });
        }
      }
      reconnectWithSize(tabId, ws, hs);
    }
  }, [store.activeTabId, getCanvasSize, reconnectWithSize]);

  // ── Input forwarding with retry for reliability ──
  useEffect(() => {
    const tabId = store.activeTabId;
    const tabStatus = store.activeTab?.status;
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
      const nativeSendKey = (scancode: number, isPressed: boolean) => {
        if (!isNative) return;
        api.rdpNativeInput(tabId, scancode, isPressed).catch(() => {});
      };

      // Native mode: send key batch (press+release pairs)
      const nativeSendKeyBatch = (scancodes: { sc: number; pressed: boolean }[]) => {
        if (!isNative) return;
        for (const { sc, pressed } of scancodes) {
          api.rdpNativeInput(tabId, sc, pressed).catch(() => {});
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

      const onMouseMove = (e: MouseEvent) => {
        const { x: mx, y: my } = canvasPointToRemote(e);
        if (isNative) {
          api.rdpNativeMouse(tabId, mx, my, -1, false).catch(() => {});
        } else {
          if (!wasmModule) return;
          sendInput(wasmModule.DeviceEvent.mouseMove(mx, my));
        }
      };
      const pressedButtons = new Set<number>();
      const onMouseDown = (e: MouseEvent) => {
        e.preventDefault();
        pressedButtons.add(e.button);
        const { x: mx, y: my } = canvasPointToRemote(e);
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
        if (!pressedButtons.has(e.button)) {
          rdpLog.debug('input', `mouse UP btn=${e.button} SKIPPED (not in pressed)`, { pressed: [...pressedButtons] });
          return;
        }
        pressedButtons.delete(e.button);
        const { x: mx, y: my } = canvasPointToRemote(e);
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
        const session = sessionRefs.current.get(tabId);
        if (session) {
          try { session.releaseAllInputs(); } catch { /* ignore */ }
        }
        pressedButtons.clear();
        suppressedShortcutKeyups.clear();
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

  // ── Debounced adaptive resize (Jump Desktop style) ──
  useEffect(() => {
    const wrap = canvasWrapRef.current;
    if (!wrap) return;

    const doResize = () => {
      // Skip auto-resize in fixed mode
      if (resModeRef.current !== 'adaptive') return;
      if (resizeCooldownRef.current) return; // skip during post-connect cooldown
      // Skip when RDP view is hidden (e.g. user switched to Dashboard tab)
      // display:none elements have offsetParent === null
      if (!wrap.offsetParent) return;
      const tabId = activeTabIdRef.current;
      if (!tabId) return;
      // Skip resize during active file transfer — reconnect would kill the transfer
      if (fileTransferInProgressRef.current.has(tabId)) return;

      const { w, h } = getCanvasSize();
      if (w <= 0 || h <= 0) return;
      // Skip if size change is too small. Window drags generate many layout
      // changes; only resize the RDP desktop once the user has made a real move.
      const dw = Math.abs(w - lastSizeRef.current.w);
      const dh = Math.abs(h - lastSizeRef.current.h);
      if (dw < ADAPTIVE_RESIZE_THRESHOLD_PX && dh < ADAPTIVE_RESIZE_THRESHOLD_PX) return;

      lastSizeRef.current = { w, h };

      // ── Native mode: use Rust backend DVC resize with reconnect fallback ──
      if (USE_NATIVE_RDP && nativeTabsRef.current.has(tabId)) {
        rdpLog.info('render', `adaptive resize (native) → trying DVC: ${w} x ${h}`);
        api.rdpNativeResize(tabId, w, h)
          .then(() => {
            rdpLog.info('render', `adaptive resize (native) → DVC success: ${w} x ${h}`);
          })
          .catch(() => {
            rdpLog.warn('render', 'adaptive resize (native) → DVC failed, reconnecting');
            reconnectWithSize(tabId);
          });
        return;
      }

      // ── WASM mode: try DisplayControl DVC first, then reconnect ──
      const session = sessionRefs.current.get(tabId);
      if (!session) return;
      try {
        session.resize(w, h);
        rdpLog.info('render', `adaptive resize → dynamic PDU sent: ${w} x ${h}`);
        return;
      } catch (e) {
        rdpLog.warn('render', 'dynamic resize failed, falling back to reconnect', { error: e });
      }
      rdpLog.info('render', `adaptive resize → reconnect fallback: ${w} x ${h}`);
      reconnectWithSize(tabId);
    };

    const scheduleResize = () => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(doResize, ADAPTIVE_RESIZE_DEBOUNCE_MS);
    };

    // ResizeObserver for wrapper layout changes
    const obs = new ResizeObserver(scheduleResize);
    obs.observe(wrap);

    // Also listen for window resize (Tauri window drag/resize)
    window.addEventListener('resize', scheduleResize);

    return () => {
      obs.disconnect();
      window.removeEventListener('resize', scheduleResize);
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    };
  }, [store.activeTabId, getCanvasSize, reconnectWithSize]);

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

  // ── Periodic canvas snapshots for sidebar & grid thumbnails ──
  useEffect(() => {
    const iv = setInterval(() => {
      const activeTabId = activeTabIdRef.current;
      for (const tab of tabsRef.current) {
        if (tab.id === activeTabId) continue;
        if (tab.status === 'connected') {
          const canvas = canvasRefs.current.get(tab.id);
          if (canvas && canvas.width > 0 && canvas.height > 0) {
            try {
              const url = canvas.toDataURL('image/jpeg', 0.5);
              store.updateTabThumbnail(tab.id, url);
            } catch { /* ignore */ }
          }
        }
      }
    }, THUMBNAIL_CAPTURE_INTERVAL_MS);
    return () => clearInterval(iv);
  }, [store.updateTabThumbnail]);

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
            onViewModeChange={store.setViewMode}
            onReorderTabs={store.reorderTabs}
            onReconnectTab={(tabId) => reconnectWithSize(tabId)}
            sessionControls={activeTab?.status === 'connected' ? {
              resMode,
              resolution: rdpStats.resolution,
              fps: rdpStats.fps,
              presets: RESOLUTION_PRESETS,
              macClipboardStrategy,
              hasClipboardFolder,
              onApplyResolution: applyResolution,
              onToggleClipboardStrategy: toggleMacClipboardStrategy,
              onOpenClipboardFolder: openClipboardFolder,
              onSendWinKey: () => sendWinKeyRef.current?.(),
              onSendCtrlAltDel: () => sendCtrlAltDelRef.current?.(),
              onDisconnect: () => handleCloseTab(activeTab.id),
            } : null}
          />
        </div>

        {!hasActiveTabs && (
          <EmptyState onNewServer={() => setShowNewConn(true)} />
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
            <div ref={canvasWrapRef} className="flex-1 relative min-h-0 min-w-0 bg-zinc-100 dark:bg-[#0a0e1a] overflow-hidden">
              {/* Canvas layers: one per tab, absolutely positioned */}
              {store.tabs.map(tab => (
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
              {store.tabs.map(tab => (
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
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
                  <div className="h-12 w-12 rounded-full border-4 border-cyan-500/30 border-t-cyan-500 animate-spin" />
                  <div className="min-h-[90px] flex flex-col items-center justify-start gap-3">
                    <p className="text-sm text-muted-foreground">{t('rdpConnectingTo', { name: activeTab.name })}</p>
                  </div>
                </div>
              )}

              {activeTab?.status === 'error' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-8">
                  <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-sm text-destructive max-w-md whitespace-pre-wrap text-center">
                    {activeTab.errorMsg}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => connectSession(activeTab.id)}>{t('rdpRetry')}</Button>
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

      <NewConnectionDialog
        store={store}
        open={showNewConn}
        onClose={() => { setShowNewConn(false); setEditServerId(null); }}
        onSaved={(id, connect) => { setEditServerId(null); handleNewSaved(id, connect); }}
        editServer={editServerId ? store.getServerById(editServerId) : null}
      />
    </div>
  );
}

function EmptyState({ onNewServer }: { onNewServer: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center p-8">
      <div className="h-20 w-20 rounded-2xl bg-gradient-to-br from-cyan-500/10 to-blue-600/10 flex items-center justify-center">
        <Monitor className="h-10 w-10 text-cyan-500/50" />
      </div>
      <div>
        <h3 className="text-lg font-semibold mb-1">{t('rdpNoActiveSessions')}</h3>
        <p className="text-sm text-muted-foreground">{t('rdpAddServerToStart')}</p>
      </div>
      <Button
        className="bg-gradient-to-r from-cyan-600 to-blue-600 text-white"
        onClick={onNewServer}
      >{t('rdpNewConnection')}</Button>
    </div>
  );
}

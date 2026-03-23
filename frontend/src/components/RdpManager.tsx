import { useState, useCallback, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { readText as tauriReadClipboard, writeText as tauriWriteClipboard } from '@tauri-apps/plugin-clipboard-manager';
import { RdpSidebar } from './RdpSidebar';
import { RdpTabBar } from './RdpTabBar';
import { RdpGridView } from './RdpGridView';
import { NewConnectionDialog } from './NewConnectionDialog';
import { useSessionStore } from '@/lib/useSessionStore';
import { Monitor, X, ChevronDown, FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { codeToScancode, macRemapCode } from '@/lib/scancodeMap';
import { RdpAudioPlayer } from '@/lib/rdp-audio';
import { H264Decoder } from '@/lib/h264-decoder';
import DecodeWorkerUrl from '@/lib/decode-worker.ts?worker&url';

// Debug logger: writes clipboard logs to /tmp/nextdesk_clipboard.log
function cblog(...args: any[]) {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  console.log(msg);
  invoke('frontend_log', { msg }).catch(() => {});
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

  const bridge = (level: 'info' | 'warn' | 'error') => {
    const original = console[level].bind(console);
    console[level] = (...args: any[]) => {
      original(...args);
      const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
      if (shouldForward(msg)) {
        invoke('frontend_log', { msg: `[console.${level}] ${msg}` }).catch(() => {});
      }
    };
  };

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
function friendlyRdpError(raw: string): string {
  const r = raw.toLowerCase();
  if (r.includes('status_logon_failure') || r.includes('0xc000006d'))
    return 'Login failed — incorrect username or password.';
  if (r.includes('status_account_disabled') || r.includes('0xc0000072'))
    return 'Login failed — this account is disabled.';
  if (r.includes('status_account_locked') || r.includes('0xc0000234'))
    return 'Login failed — account locked due to too many attempts.';
  if (r.includes('status_password_expired') || r.includes('0xc0000071'))
    return 'Login failed — password has expired.';
  if (r.includes('status_account_expired') || r.includes('0xc0000193'))
    return 'Login failed — account has expired.';
  if (r.includes('status_password_must_change') || r.includes('0xc0000224'))
    return 'Login failed — password must be changed before first login.';
  if (r.includes('credssp'))
    return 'Authentication failed — check your username and password.';
  if (r.includes('tls') || r.includes('ssl') || r.includes('certificate'))
    return 'TLS/SSL error — could not establish a secure connection.';
  if (r.includes('dns') || r.includes('resolve'))
    return 'Connection failed — hostname could not be resolved.';
  if (r.includes('refused') || r.includes('reset'))
    return 'Connection refused — RDP service may not be running on the target.';
  if (r.includes('timeout') || r.includes('timed out'))
    return 'Connection timed out — host is unreachable or too slow.';
  if (r.includes('rdcleanpath'))
    return 'Connection interrupted — WebSocket channel closed.';
  if (r.includes('websocket') || r.includes('ws://'))
    return 'Connection interrupted — WebSocket channel closed.';
  if (r.includes('canvas'))
    return 'Display error — canvas element not ready. Try again.';
  if (r.includes('another user connected') || r.includes('forcing the disconnection'))
    return 'Disconnected — another user logged in to the remote computer.';
  if (r.includes('administratively'))
    return 'Disconnected — the session was ended by an administrator.';
  if (r.includes('idle timeout'))
    return 'Disconnected — session timed out due to inactivity.';
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
  mod.setup('info');
  wasmModule = mod as unknown as IronRdpWasm;
  wasmReady = true;
  return wasmModule;
}

export function RdpManager({ onMainSidebarCollapse }: { onMainSidebarCollapse?: () => void } = {}) {
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
  const [showResMenu, setShowResMenu] = useState(false);
  const resModeRef = useRef('adaptive');
  resModeRef.current = resMode;
  const [showNewConn, setShowNewConn] = useState(false);
  const [editServerId, setEditServerId] = useState<string | null>(null);
  const [proxyPort, setProxyPort] = useState(18765);




  const canvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const sessionRefs = useRef<Map<string, WasmSession>>(new Map());
  const audioPlayersRef = useRef<Map<string, RdpAudioPlayer>>(new Map());
  const h264DecoderRef = useRef<H264Decoder | null>(null);
  const decodeWorkerRef = useRef<Worker | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const activeTabIdRef = useRef<string | null>(null);
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
  const pasteProgressTabsRef = useRef<Set<string>>(new Set());
  const fileTransferInProgressRef = useRef<Set<string>>(new Set());
  const clipboardPollInFlightRef = useRef<Set<string>>(new Set());
  const prevSidebarOpenRef = useRef(store.sidebarOpen);
  activeTabIdRef.current = store.activeTabId;


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
      console.log('[rdp] network: online — checking for disconnected tabs');
      for (const tab of store.tabs) {
        if ((tab.status === 'reconnecting' || tab.status === 'disconnected') && !userDisconnectedRef.current.has(tab.id)) {
          // Cancel existing timer and try immediately
          const existing = reconnectTimerRef.current.get(tab.id);
          if (existing) { clearTimeout(existing); reconnectTimerRef.current.delete(tab.id); }
          reconnectCountRef.current.set(tab.id, 0); // Reset count
          console.log('[rdp] network restored, reconnecting tab:', tab.id);
          if (connectSessionRef.current) connectSessionRef.current(tab.id);
        }
      }
    };
    const handleOffline = () => {
      console.log('[rdp] network: offline');
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
    console.log('[rdp] getCanvasSize:', w, 'x', h);
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
      console.log('[rdp] connectSession skipped: local connect lock active for', tabId);
      return;
    }
    const tab = store.tabs.find(t => t.id === tabId);
    if (!tab) return;
    // Guard: prevent double-connection
    if (tab.status === 'connecting' || tab.status === 'connected') {
      console.log('[rdp] connectSession skipped: already', tab.status, tabId);
      return;
    }
    if (sessionRefs.current.has(tabId)) {
      console.log('[rdp] connectSession skipped: session already exists for', tabId);
      return;
    }
    const server = store.getServerById(tab.serverId);
    if (!server) return;

    connectingTabsRef.current.add(tabId);
    store.updateTabStatus(tabId, 'connecting');
    try {
      const wasm = await loadWasm();

      // Wait for 2 animation frames to ensure the wrapper div is in the DOM and laid out
      await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));

      const canvas = canvasRefs.current.get(tabId);
      if (!canvas) throw new Error('Canvas not ready');

      // Use desired size if set (from resolution switching), otherwise wrapper size
      let w: number, h: number;
      if (desiredSizeRef.current) {
        w = desiredSizeRef.current.w;
        h = desiredSizeRef.current.h;
        console.log('[rdp] using desired size:', w, 'x', h);
      } else {
        const cs = getCanvasSize();
        w = cs.w; h = cs.h;
        console.log('[rdp] using wrapper size:', w, 'x', h);
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
            // During paste, block ALL server cursor events to prevent flicker.
            // Root cause: server sends PointerBitmap with transparent images
            // that make cursor appear to disappear.
            if (pasteProgressTabsRef.current.has(tabId)) {
              canvas.style.cursor = 'progress';
              return;
            }
            if (kind === 'url' && data) {
              canvas.style.cursor = `url(${data}) ${hx ?? 0} ${hy ?? 0}, auto`;
            } else if (kind === 'hidden') {
              const keepVisibleUntil =
                keepCursorVisibleUntilRef.current.get(tabId) ?? 0;
              if (Date.now() < keepVisibleUntil) {
                canvas.style.cursor = 'default';
              } else {
                canvas.style.cursor = 'none';
              }
            } else {
              canvas.style.cursor = 'default';
            }
          },
        )
        .setCursorStyleCallbackContext(null)
        .canvasResizedCallback(() => {
          // WASM renderer sets canvas.width/height internally when server responds
          const cw = canvas.width, ch = canvas.height;
          console.log('[rdp] canvasResizedCallback → canvas:', cw, 'x', ch);
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
                tauriWriteClipboard(text).then(() => {
                  cblog('[clipboard] Remote → Local text:', text.slice(0, 50));
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
            cblog('[clipboard] forceUpdate: RDPDR active, skip file clipboard sync and only consider text');
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
          // Lock: suppress clipboard polling during active file transfer
          fileTransferInProgressRef.current.add(tabId);
        })
        .fileContentsResponseCallback((filesData: any) => {
          cblog('[file-transfer] ▶ FileContentsResponse raw:', debugPayload(filesData));
          const files = normalizeTransferredFiles(filesData);
          if (files.length === 0) {
            cblog('[file-transfer] ▶ FileContentsResponse: no data or invalid format');
            return;
          }
          cblog('[file-transfer] ▶ FileContentsResponse received:', files.length, 'file(s)');
          const payloads = files.map(file => ({
            name: file.name,
            data: Array.from(file.data),
          }));
          invoke<{ strategy: string; staged_paths: string[] }>('stage_downloaded_files_for_paste', {
            sessionId: tabId,
            files: payloads,
          })
            .then(result => {
              cblog('[file-transfer] ✅ Local clipboard strategy:', result.strategy);
              cblog('[file-transfer] ✅ Prepared local paste paths:', result.staged_paths);
              setHasClipboardFolder(Boolean(result.staged_paths.length));
            })
            .catch((e: any) => {
              cblog('[file-transfer] ❌ Stage for local paste failed:', e);
            })
            .finally(() => {
              // Unlock after a delay to let CLIPRDR state machine settle
              setTimeout(() => {
                fileTransferInProgressRef.current.delete(tabId);
                cblog('[file-transfer] Transfer lock released for', tabId);
              }, 2000);
            });
        });

      // Use global counter injected in WASM bindings (__wbg_putImageData)
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
          const readPromise = invoke<number[]>('rdpdr_read_file_chunk', {
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
          console.log(`[cliprdr] Transfer progress: ${path.split('/').pop()} offset=${(offset / 1024 / 1024).toFixed(1)}MB`);
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
        const readPromise = invoke<number[]>('rdpdr_read_file_chunk', {
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

      // Enable audio redirection via RDPSND
      const audioPlayer = new RdpAudioPlayer();
      audioPlayersRef.current.set(tabId, audioPlayer);
      builder.extension(new wasm.Extension('audio_callback', audioPlayer.createCallback()));
      console.log('[rdp] RDPSND audio redirection enabled');

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
              // Draw decoded VideoFrame onto canvas via 2D fallback
              const c = canvasRefs.current.get(tabId);
              if (c) {
                const ctx2d = c.getContext('2d');
                if (ctx2d) {
                  ctx2d.drawImage(frame, 0, 0, c.width, c.height);
                }
              }
              frame.close();
            } else if (msg.type === 'error') {
              console.warn('[h264-worker] error:', msg.message);
            }
          };
        } catch (e) {
          console.warn('[h264] Worker creation failed, using main-thread fallback');
        }

        // Phase 3: create main-thread decoder as fallback
        const decoder = new H264Decoder(canvas);
        h264DecoderRef.current = decoder;

        const gfxCallback = (type: string, data: any) => {
          if (type === 'h264_frame' && decodeWorkerRef.current) {
            // Phase 4: offload to worker
            const buf = data.data.buffer.slice(0);
            decodeWorkerRef.current.postMessage(
              { type: 'decode', data: buf, timestamp: performance.now() * 1000 },
              [buf],
            );
          } else {
            // Phase 3 fallback: decode on main thread
            decoder.handleGfxEvent(type, data);
          }
        };
        builder.extension(new wasm.Extension('gfx_callback', gfxCallback));
        console.log('[rdp] GFX H.264 pipeline enabled (WebCodecs + Worker)');
      } else {
        console.log('[rdp] WebCodecs not available, GFX H.264 disabled');
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
      console.log('[rdp] negotiated resolution:', negotiated.width, 'x', negotiated.height, '(requested', w, 'x', h, ')');
      setRdpStats(prev => ({ ...prev, resolution: `${negotiated.width}×${negotiated.height}`, status: 'connected' }));
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
          console.log('[rdp] delayed resize attempt:', curW, 'x', curH, 'DPR:', dpr);
          try { session.resize(curW, curH, dpr > 1 ? dpr : null); } catch (e) { console.warn('[rdp] resize failed:', e); }
        }
      }, 2000);

      const info = await session.run();
      const reason = info?.reason?.() || 'unknown';
      console.log('[rdp] session ended:', tabId, reason);
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
      // Cleanup H.264 decoder and worker
      if (h264DecoderRef.current) { h264DecoderRef.current.close(); h264DecoderRef.current = null; }
      if (decodeWorkerRef.current) { decodeWorkerRef.current.postMessage({ type: 'close' }); decodeWorkerRef.current.terminate(); decodeWorkerRef.current = null; }
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
          console.log('[rdp] non-recoverable disconnect:', reason);
          store.updateTabStatus(tabId, 'error', friendlyRdpError(reason));
        } else {
          scheduleReconnect(tabId, reason);
        }
      }
    } catch (err: any) {
      console.error('[rdp] error:', err);
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
        store.updateTabStatus(tabId, 'error', friendlyRdpError(raw));
      } else if (!userDisconnectedRef.current.has(tabId)) {
        scheduleReconnect(tabId, raw);
      } else {
        userDisconnectedRef.current.delete(tabId);
        store.updateTabStatus(tabId, 'error', friendlyRdpError(raw));
      }
    }
  }, [store, proxyPort, getCanvasSize]);
  connectSessionRef.current = connectSession;

  // ── Auto-reconnect with exponential backoff ──
  const scheduleReconnect = useCallback((tabId: string, reason: string) => {
    const count = (reconnectCountRef.current.get(tabId) || 0) + 1;
    if (count > MAX_RECONNECT_ATTEMPTS) {
      console.log(`[rdp] reconnect: gave up after ${MAX_RECONNECT_ATTEMPTS} attempts for`, tabId);
      reconnectCountRef.current.delete(tabId);
      store.updateTabStatus(tabId, 'error', `${friendlyRdpError(reason)}\n(Auto-reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts)`);
      return;
    }
    reconnectCountRef.current.set(tabId, count);
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s
    const delay = Math.min(1000 * Math.pow(2, count - 1), 16000);
    console.log(`[rdp] reconnect #${count}/${MAX_RECONNECT_ATTEMPTS} for ${tabId} in ${delay}ms`);
    store.updateTabStatus(tabId, 'reconnecting', `Reconnecting (${count}/${MAX_RECONNECT_ATTEMPTS})...\n${friendlyRdpError(reason)}`);

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
  }, [store]);

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
    const tab = store.tabs.find(t => t.id === tabId);
    if (tab && tab.status === 'idle') {
      setTimeout(() => connectSession(tabId), 150);
    }
  }, [store, connectSession, onMainSidebarCollapse]);

  // Single-click: just select/open the tab without hiding sidebar or auto-connecting
  const handleSelectServer = useCallback((serverId: string) => {
    const server = store.getServerById(serverId);
    if (!server) return;
    store.openSession(server);
  }, [store]);

  const handleCloseTab = useCallback((tabId: string) => {
    // Mark as user-initiated to prevent auto-reconnect
    userDisconnectedRef.current.add(tabId);
    // Cancel any pending reconnect timer
    const timer = reconnectTimerRef.current.get(tabId);
    if (timer) { clearTimeout(timer); reconnectTimerRef.current.delete(tabId); }
    reconnectCountRef.current.delete(tabId);
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
    // Cleanup audio player
    const audioPlayer = audioPlayersRef.current.get(tabId);
    if (audioPlayer) {
      audioPlayer.destroy();
      audioPlayersRef.current.delete(tabId);
    }
    store.closeTab(tabId);
  }, [store]);

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
    console.log('[rdp] applyResolution called:', mode);
    setResMode(mode);
    setShowResMenu(false);
    const tabId = store.activeTabId;
    if (!tabId) return;

    if (mode === 'adaptive') {
      // Reconnect using wrapper size
      const { w, h } = getCanvasSize();
      console.log('[rdp] switching to adaptive, reconnect with wrapper:', w, 'x', h);
      reconnectWithSize(tabId); // null desired → uses wrapper
    } else {
      const [ws, hs] = mode.split('x').map(Number);
      if (!ws || !hs) return;
      console.log('[rdp] reconnecting with fixed resolution:', ws, 'x', hs);
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

      const sendInput = (event: any) => {
        const session = sessionRefs.current.get(tabId);
        if (!session || !wasmModule) return;
        const tx = new wasmModule.InputTransaction();
        tx.addEvent(event);
        session.applyInputs(tx);
      };

      const sendInputBatch = (events: any[]) => {
        const session = sessionRefs.current.get(tabId);
        if (!session || !wasmModule) return;
        const tx = new wasmModule.InputTransaction();
        for (const event of events) {
          tx.addEvent(event);
        }
        session.applyInputs(tx);
      };

      const sendCtrlShortcut = (keyScancode: number) => {
        const wm = wasmModule;
        if (!wm) return;
        sendInputBatch([
          wm.DeviceEvent.keyPressed(0x1D),
          wm.DeviceEvent.keyPressed(keyScancode),
          wm.DeviceEvent.keyReleased(keyScancode),
          wm.DeviceEvent.keyReleased(0x1D),
        ]);
      };

      const syncLocalClipboardForPasteShortcut = async () => {
        const sess = sessionRefs.current.get(tabId);
        const wm = wasmModule;
        if (!sess || !wm) return;
        pasteShortcutInFlightRef.current.add(tabId);
        // Show progress cursor (arrow + spinning) during paste preparation,
        // like Jump Desktop does. Keep it visible for up to 10s (large files).
        pasteProgressTabsRef.current.add(tabId);
        keepCursorVisibleUntilRef.current.set(tabId, Date.now() + 10000);
        const canvas = canvasRefs.current.get(tabId);
        if (canvas) canvas.style.cursor = 'progress';

        try {
          // Always fetch fresh clipboard data to ensure correctness.
          // Pre-cache is used to update advertisedClipboard on focus, but
          // paste must always read the CURRENT clipboard state.
          const files = await invoke<{name: string, path: string, size: number, data: number[]}[]>('clipboard_read_files_data')
            .catch(() => [] as {name: string, path: string, size: number, data: number[]}[]);
          cblog('[clipboard] paste-shortcut: read', files.length, 'file(s) from current clipboard');
          if (files.length > 0) {
            const payloads: ClipboardFilePayload[] = files.map(f => ({
              name: f.name,
              size: f.size,
              data: new Uint8Array(f.data),
              path: f.path,
            }));
            const snapshot: AdvertisedClipboardSnapshot = {
              kind: 'files',
              fileKey: payloads.map(f => f.path || f.name).join('|'),
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
          // Keep progress cursor for a short period after injection,
          // so it stays visible until Windows shows its copy dialog.
          setTimeout(() => {
            pasteProgressTabsRef.current.delete(tabId);
            const c = canvasRefs.current.get(tabId);
            if (c && c.style.cursor === 'progress') {
              c.style.cursor = 'default';
            }
          }, 3000);
        }
      };

      const suppressedShortcutKeyups = new Set<string>();


      const onKeyDown = (e: KeyboardEvent) => {
        e.preventDefault();
        if (!wasmModule) return;

        // Detect Ctrl (or Cmd on macOS) modifier
        const isCtrl = isMac ? e.metaKey : e.ctrlKey;

        if (isMac && (e.code === 'MetaLeft' || e.code === 'MetaRight')) {
          return;
        }

        // Ctrl+V / Cmd+V → ONLY send scancodes.
        // Per MS-RDPECLIP protocol, FormatList must be sent on clipboard CHANGE,
        // NOT on paste. Calling onClipboardPaste here would send a FormatList PDU,
        // telling the server "client has new data", causing it to discard its own
        // clipboard (breaking RDP-internal copy/paste).
        // Cross-machine clipboard sync is handled by focus-based detection below.
        if (isCtrl && e.code === 'KeyV') {
          if (pasteShortcutInFlightRef.current.has(tabId)) {
            cblog('[clipboard] paste-shortcut already in flight, skip repeated shortcut');
            return;
          }
          suppressedShortcutKeyups.add('KeyV');
          if (isMac) {
            suppressedShortcutKeyups.add('MetaLeft');
            suppressedShortcutKeyups.add('MetaRight');
          }
          if (rdpdrEnabledRef.current.has(tabId)) {
            void syncLocalClipboardForPasteShortcut()
              .catch(err => cblog('[clipboard] paste-shortcut injection error:', err))
              .finally(() => sendCtrlShortcut(0x2F));
            return;
          }
          sendCtrlShortcut(0x2F);
          return;
        }

        // Ctrl+C / Cmd+C → just send scancodes (same principle)
        if (isCtrl && e.code === 'KeyC') {
          suppressedShortcutKeyups.add('KeyC');
          if (isMac) {
            suppressedShortcutKeyups.add('MetaLeft');
            suppressedShortcutKeyups.add('MetaRight');
          }
          sendCtrlShortcut(0x2E);
          return;
        }

        const code = isMac ? macRemapCode(e.code) : e.code;
        const sc = codeToScancode(code);
        if (sc !== undefined) {
          sendInput(wasmModule.DeviceEvent.keyPressed(sc));
        } else if (e.key.length === 1) {
          sendInput(wasmModule.DeviceEvent.unicodePressed(e.key));
        }
      };
      const onKeyUp = (e: KeyboardEvent) => {
        e.preventDefault();
        if (!wasmModule) return;
        if (suppressedShortcutKeyups.has(e.code)) {
          suppressedShortcutKeyups.delete(e.code);
          return;
        }
        if (isMac && (e.code === 'MetaLeft' || e.code === 'MetaRight')) {
          return;
        }
        const code = isMac ? macRemapCode(e.code) : e.code;
        const sc = codeToScancode(code);
        if (sc !== undefined) {
          sendInput(wasmModule.DeviceEvent.keyReleased(sc));
        } else if (e.key.length === 1) {
          sendInput(wasmModule.DeviceEvent.unicodeReleased(e.key));
        }
      };
      const onMouseMove = (e: MouseEvent) => {
        if (!wasmModule) return;
        const r = canvas.getBoundingClientRect();
        const sx = canvas.width / r.width;
        const sy = canvas.height / r.height;
        sendInput(wasmModule.DeviceEvent.mouseMove(
          (e.clientX - r.left) * sx,
          (e.clientY - r.top) * sy,
        ));
      };
      const pressedButtons = new Set<number>();
      const onMouseDown = (e: MouseEvent) => {
        e.preventDefault();
        if (!wasmModule) return;
        canvas.focus();
        pressedButtons.add(e.button);
        sendInput(wasmModule.DeviceEvent.mouseButtonPressed(e.button));
      };
      const onMouseUp = (e: MouseEvent) => {
        if (!wasmModule) return;
        if (!pressedButtons.has(e.button)) return; // only release if pressed on canvas
        pressedButtons.delete(e.button);
        sendInput(wasmModule.DeviceEvent.mouseButtonReleased(e.button));
      };
      const onCtxMenu = (e: Event) => e.preventDefault();
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        if (!wasmModule) return;
        const vertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX);
        const delta = vertical ? e.deltaY : e.deltaX;
        if (delta === 0) return;
        // DOM deltaY > 0 = scroll down, RDP positive = scroll up → invert
        // deltaMode: 0=pixels, 1=lines, 2=pages → maps to RotationUnit enum
        const unit = e.deltaMode; // 0=Pixel, 1=Line, 2=Page
        // Clamp to i16 range and invert direction
        const amount = Math.round(Math.max(-32767, Math.min(32767, -delta)));
        if (amount === 0) return;
        sendInput(wasmModule.DeviceEvent.wheelRotations(vertical, amount, unit));
      };

      canvas.addEventListener('keydown', onKeyDown);
      canvas.addEventListener('keyup', onKeyUp);
      canvas.addEventListener('mousemove', onMouseMove);
      canvas.addEventListener('mousedown', onMouseDown);
      window.addEventListener('mouseup', onMouseUp);
      canvas.addEventListener('contextmenu', onCtxMenu);
      canvas.addEventListener('wheel', onWheel, { passive: false });
      canvas.focus();

      // ── Clipboard sync (MS-RDPECLIP compliant) ──
      // We still sync on focus, but also run a light polling loop so local file copy
      // does not depend on a perfect focus transition to reach the remote session.
      let lastSyncedText: string | null = null;
      let lastSyncedFileKey: string | null = null;
      let clipboardPollTimer: ReturnType<typeof setInterval> | null = null;
      const syncClipboard = async (reason: 'Focus' | 'Poll') => {
        if (reason === 'Focus') {
          cblog('[clipboard] ▶ Focus event fired');
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
      }, 3000);

      cleanupFn = () => {
        canvas.removeEventListener('keydown', onKeyDown);
        canvas.removeEventListener('keyup', onKeyUp);
        canvas.removeEventListener('mousemove', onMouseMove);
        canvas.removeEventListener('mousedown', onMouseDown);
        window.removeEventListener('mouseup', onMouseUp);
        canvas.removeEventListener('contextmenu', onCtxMenu);
        canvas.removeEventListener('wheel', onWheel);
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
      if (!sessionRefs.current.has(tabId)) return;
      // Skip resize during active file transfer — reconnect would kill the transfer
      if (fileTransferInProgressRef.current.has(tabId)) return;

      const { w, h } = getCanvasSize();
      if (w <= 0 || h <= 0) return;
      // Skip if size change is too small (< 20px in either dimension)
      const dw = Math.abs(w - lastSizeRef.current.w);
      const dh = Math.abs(h - lastSizeRef.current.h);
      if (dw < 20 && dh < 20) return;

      console.log('[rdp] adaptive resize → reconnect:', w, 'x', h);
      lastSizeRef.current = { w, h };
      reconnectWithSize(tabId); // null desired → uses wrapper
    };

    const scheduleResize = () => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(doResize, 200);
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
      for (const tab of store.tabs) {
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
    }, 3000);
    return () => clearInterval(iv);
  }, [store.tabs]);

  return (
    <div className="flex h-full overflow-hidden">
      <RdpSidebar
        store={store}
        onConnectServer={handleConnectServer}
        onSelectServer={handleSelectServer}
        onNewServer={() => { setEditServerId(null); setShowNewConn(true); }}
        onEditServer={(id) => { setEditServerId(id); setShowNewConn(true); }}
        onDeleteServer={(id) => { store.removeServer(id); }}
      />

      <div ref={containerRef} className="flex-1 flex flex-col min-w-0 relative">
        {/* TabBar — data-bar for height calculation */}
        <div data-bar>
          <RdpTabBar
            tabs={store.tabs}
            activeTabId={store.activeTabId}
            viewMode={store.viewMode}
            onSelectTab={store.setActiveTabId}
            onCloseTab={handleCloseTab}
            onViewModeChange={store.setViewMode}
            onReorderTabs={store.reorderTabs}
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
            <div ref={canvasWrapRef} className="flex-1 relative min-h-0 min-w-0 bg-[#0a0e1a] overflow-hidden">
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


              {/* Overlays for non-connected states */}
              {activeTab?.status === 'connecting' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
                  <div className="h-12 w-12 rounded-full border-4 border-cyan-500/30 border-t-cyan-500 animate-spin" />
                  <p className="text-sm text-muted-foreground">Connecting to {activeTab.name}...</p>
                </div>
              )}

              {activeTab?.status === 'error' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-8">
                  <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-sm text-destructive max-w-md whitespace-pre-wrap">
                    {activeTab.errorMsg}
                  </div>
                  <Button variant="outline" size="sm" onClick={() => connectSession(activeTab.id)}>Retry</Button>
                </div>
              )}

              {activeTab?.status === 'reconnecting' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
                  <div className="h-12 w-12 rounded-full border-4 border-cyan-500/30 border-t-cyan-500 animate-spin" />
                  <p className="text-sm text-muted-foreground whitespace-pre-line text-center">{activeTab.errorMsg || 'Reconnecting...'}</p>
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
                  >Cancel Reconnect</Button>
                </div>
              )}

              {activeTab?.status === 'idle' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
                  <Monitor className="h-16 w-16 text-slate-700" />
                  <p className="text-sm text-muted-foreground">Click to connect to {activeTab.name}</p>
                  <Button
                    className="bg-gradient-to-r from-cyan-600 to-blue-600 text-white"
                    onClick={() => connectSession(activeTab.id)}
                  >Connect</Button>
                </div>
              )}
            </div>

          </div>
        )}

        {/* Bottom status bar — auto-hide overlay */}
        {activeTab?.status === 'connected' && (
          <div
            className="group/bar absolute bottom-0 left-0 right-0 z-20"
            style={{ height: '52px' }}
          >
            {/* Invisible hover trigger zone */}
            <div className="absolute inset-0" />
            {/* Actual bar — hidden by default, slides up on hover */}
            <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between px-3 h-[36px] bg-card/90 backdrop-blur-sm border-t border-border/40 translate-y-full opacity-0 group-hover/bar:translate-y-0 group-hover/bar:opacity-100 transition-all duration-200 ease-out">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <button
                    className="flex items-center gap-1 text-[10px] text-cyan-400/80 font-mono hover:text-cyan-300 transition-colors cursor-pointer"
                    onClick={() => setShowResMenu(v => !v)}
                  >
                    {resMode === 'adaptive' ? 'Auto' : (rdpStats.resolution || '—')}
                    <ChevronDown className={cn("h-2.5 w-2.5 transition-transform", showResMenu && "rotate-180")} />
                  </button>
                  {showResMenu && (
                    <>
                      <div className="fixed inset-0 z-30" onClick={() => setShowResMenu(false)} />
                      <div className="absolute bottom-full left-0 mb-1 z-40 bg-card/95 backdrop-blur-md border border-border/60 rounded-md shadow-xl py-1 min-w-[130px]">
                        {RESOLUTION_PRESETS.map(p => (
                          <button
                            key={p.value}
                            className={cn(
                              "w-full text-left px-3 py-1 text-[11px] font-mono hover:bg-white/5 transition-colors cursor-pointer",
                              resMode === p.value ? "text-cyan-400" : "text-muted-foreground"
                            )}
                            onClick={() => { applyResolution(p.value); setShowResMenu(false); }}
                          >
                            {p.label}
                            {resMode === p.value && <span className="ml-1 text-[9px]">✓</span>}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
                <span className="text-[10px] text-emerald-400/80 font-mono">{rdpStats.fps} fps</span>
              </div>
              <div className="flex items-center gap-0.5">
                <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px] gap-1" onClick={toggleMacClipboardStrategy}>
                  {macClipboardStrategy === 'session-file-url' ? 'Std' : 'Exp'}
                </Button>
                <Button variant="ghost" size="sm" className={cn("h-6 px-2 text-[10px] gap-1", !hasClipboardFolder && "opacity-50")} onClick={openClipboardFolder} disabled={!hasClipboardFolder}>
                  <FolderOpen className="h-3 w-3" /> Files
                </Button>
                <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-destructive" onClick={() => handleCloseTab(activeTab.id)}>
                  <X className="h-3 w-3" />
                </Button>
              </div>
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
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center p-8">
      <div className="h-20 w-20 rounded-2xl bg-gradient-to-br from-cyan-500/10 to-blue-600/10 flex items-center justify-center">
        <Monitor className="h-10 w-10 text-cyan-500/50" />
      </div>
      <div>
        <h3 className="text-lg font-semibold mb-1">No Active Sessions</h3>
        <p className="text-sm text-muted-foreground">Add a server to get started</p>
      </div>
      <Button
        className="bg-gradient-to-r from-cyan-600 to-blue-600 text-white"
        onClick={onNewServer}
      >New Connection</Button>
    </div>
  );
}

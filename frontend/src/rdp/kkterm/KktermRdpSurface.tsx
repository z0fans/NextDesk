import { listen } from '@tauri-apps/api/event';
import { readText as readClipboardText } from '@tauri-apps/plugin-clipboard-manager';
import { useEffect, useRef } from 'react';
import type { ServerEntry } from '@/lib/rdp-types';
import type { ConnectionRoute } from '@/api';
import { cn } from '@/lib/utils';
import { rdpLog } from '@/lib/rdp-logger';
import {
  cloudKeepBindingAlive,
  kktermRdpCtrlAltDelete,
  kktermRdpDisconnect,
  kktermRdpKey,
  kktermRdpPointer,
  kktermRdpStart,
  kktermRdpText,
} from './commands';
import { createRdpSessionId } from './kktermSession';
import { isCharacterCode, scancodeForCode, scancodeForPrintableKey } from './rdpScancodes';
import './styles.css';

const LEFT_WINDOWS_SCANCODE = 0xe05b;
const LEFT_CONTROL_SCANCODE = 0x1d;
const KKTERM_KEYBOARD_MODE_STORAGE_KEY = 'nextdesk_kkterm_keyboard_mode';
// The native command already has bounded TCP, negotiation, TLS, and login
// finalization timeouts. Keep this outer watchdog long enough for the native
// layer to return its more specific authentication or transport reason first.
const KKTERM_CONNECT_FEEDBACK_TIMEOUT_MS = 90_000;
const KKTERM_START_RETRY_DELAYS_MS = [800, 1_600, 2_800, 5_000] as const;
const CLOUD_BINDING_KEEPALIVE_INTERVAL_MS = 25_000;

const MAC_EDITING_SHORTCUT_SCANCODES: Readonly<Record<string, number>> = {
  KeyA: 0x1e,
  KeyC: 0x2e,
  KeyX: 0x2d,
  KeyZ: 0x2c,
};

const isMetaCode = (code: string) => code === 'MetaLeft' || code === 'MetaRight';

export type KktermTextSignal = {
  sequence: number;
  text: string;
};

type KktermKeyboardMode = 'kkterm-text' | 'remote-scancode';

type KktermCanvasEvent =
  | { kind: 'connected'; sessionId: string; name: string }
  | { kind: 'resolution'; sessionId: string; width: number; height: number }
  | {
      kind: 'rawImage';
      sessionId: string;
      x: number;
      y: number;
      width: number;
      height: number;
      rgba: string;
    }
  | {
      kind: 'setCursor';
      sessionId: string;
      width: number;
      height: number;
      hotX: number;
      hotY: number;
      rgba: string;
    }
  | { kind: 'error'; sessionId: string; message: string }
  | { kind: 'disconnected'; sessionId: string };

type KktermRdpSurfaceProps = {
  tabId: string;
  server: ServerEntry;
  active: boolean;
  cadSignal: number;
  winSignal?: number;
  textSignal?: KktermTextSignal | null;
  desktopSize?: { width: number; height: number } | null;
  reuseCloudBinding?: boolean;
  onConnected: (tabId: string, width?: number, height?: number) => void;
  onDisconnected: (tabId: string) => void;
  onError: (tabId: string, message: string) => void;
  onRouteSelected?: (tabId: string, routeLabel: ConnectionRoute, routeLeaseId: number) => void;
  onCanvasRef?: (tabId: string, canvas: HTMLCanvasElement | null) => void;
};

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function isTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => {
    window.setTimeout(resolve, ms);
  });
}

function isRetryableKktermStartupError(message: string): boolean {
  const lower = message.toLowerCase();
  if (
    lower.includes('credential_check_timeout')
    || lower.includes('connect_finalize')
    || lower.includes('status_logon_failure')
    || lower.includes('logon_failure')
    || lower.includes('account_disabled')
    || lower.includes('account_locked')
    || lower.includes('account_expired')
    || lower.includes('password_expired')
    || lower.includes('access_denied')
  ) {
    return false;
  }
  return (
    lower.includes('429')
    || lower.includes('too many requests')
    || lower.includes('cloud prepare')
    || lower.includes('cloud_route_not_ready')
  );
}

function parseKeyboardMode(value: unknown): KktermKeyboardMode | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'remote-scancode' || normalized === 'remote' || normalized === 'scancode') {
    return 'remote-scancode';
  }
  if (normalized === 'kkterm-text' || normalized === 'kkterm' || normalized === 'text') {
    return 'kkterm-text';
  }
  return null;
}

function readKktermKeyboardMode(): KktermKeyboardMode {
  const envMode = parseKeyboardMode(import.meta.env.VITE_NEXTDESK_KKTERM_KEYBOARD_MODE);
  if (envMode) {
    return envMode;
  }
  if (typeof window !== 'undefined') {
    try {
      const storageMode = parseKeyboardMode(window.localStorage.getItem(KKTERM_KEYBOARD_MODE_STORAGE_KEY));
      if (storageMode) return storageMode;
    } catch {
      // Ignore blocked storage and fall back to env/default.
    }
  }
  return 'remote-scancode';
}

function cursorUrlFromRgba(event: Extract<KktermCanvasEvent, { kind: 'setCursor' }>): string | null {
  if (event.width === 0 || event.height === 0) {
    return 'auto';
  }
  const bytes = base64ToBytes(event.rgba);
  const expected = event.width * event.height * 4;
  if (bytes.length < expected) {
    return null;
  }
  const cursorCanvas = document.createElement('canvas');
  cursorCanvas.width = event.width;
  cursorCanvas.height = event.height;
  const ctx = cursorCanvas.getContext('2d');
  if (!ctx) {
    return null;
  }
  const clamped = new Uint8ClampedArray(expected);
  clamped.set(bytes.subarray(0, expected));
  ctx.putImageData(new ImageData(clamped, event.width, event.height), 0, 0);
  return `url(${cursorCanvas.toDataURL('image/png')}) ${event.hotX} ${event.hotY}, auto`;
}

export function KktermRdpSurface({
  tabId,
  server,
  active,
  cadSignal,
  winSignal = 0,
  textSignal = null,
  desktopSize,
  reuseCloudBinding = false,
  onConnected,
  onDisconnected,
  onError,
  onRouteSelected,
  onCanvasRef,
}: KktermRdpSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const keyboardMode = readKktermKeyboardMode();
  const keyboardModeRef = useRef<KktermKeyboardMode>(keyboardMode);
  const sessionIdRef = useRef<string | null>(null);
  const buttonMaskRef = useRef(0);
  const composingRef = useRef(false);
  const callbacksRef = useRef({ onConnected, onDisconnected, onError, onRouteSelected });
  const lastCadSignalRef = useRef(cadSignal);
  const lastWinSignalRef = useRef(winSignal);
  const lastTextSignalSequenceRef = useRef(textSignal?.sequence ?? 0);
  const suppressedShortcutKeyupsRef = useRef(new Set<string>());
  const pressedRemoteScancodesRef = useRef(new Map<string, number>());
  const keySendQueueRef = useRef<Promise<void>>(Promise.resolve());
  const activeRef = useRef(active);

  const focusKeyboardTarget = () => {
    // The hidden input is also the keyboard target in scancode mode. This keeps
    // physical-key forwarding intact while allowing macOS IME composition.
    inputRef.current?.focus({ preventScroll: true });
  };

  const resetImeComposition = () => {
    composingRef.current = false;
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  };

  const focusKeyboardTargetSoon = () => {
    if (typeof window === 'undefined') return;
    window.setTimeout(() => {
      if (!activeRef.current) return;
      focusKeyboardTarget();
    }, 0);
  };

  const recoverKeyboardTargetSoon = () => {
    // WebKit does not always emit `compositionend` when an IME session is
    // interrupted by blur, tab switching, or a native RDP reconnect. Clear the
    // stale composition flag before returning keyboard focus to the RDP input.
    resetImeComposition();
    focusKeyboardTargetSoon();
  };

  useEffect(() => {
    callbacksRef.current = { onConnected, onDisconnected, onError, onRouteSelected };
  }, [onConnected, onDisconnected, onError, onRouteSelected]);

  useEffect(() => {
    keyboardModeRef.current = keyboardMode;
  }, [keyboardMode]);

  useEffect(() => {
    activeRef.current = active;
    resetImeComposition();
    if (active) {
      focusKeyboardTargetSoon();
    }
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const refocus = () => recoverKeyboardTargetSoon();
    const refocusWhenVisible = () => {
      if (!document.hidden) {
        recoverKeyboardTargetSoon();
      }
    };
    window.addEventListener('focus', refocus);
    document.addEventListener('visibilitychange', refocusWhenVisible);
    return () => {
      window.removeEventListener('focus', refocus);
      document.removeEventListener('visibilitychange', refocusWhenVisible);
    };
  }, [active]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let disposed = false;
    let connectFinished = false;
    let timedOut = false;
    let terminalErrorReported = false;
    let unlisten: (() => void) | undefined;
    const sessionId = createRdpSessionId(tabId);
    const desktopWidth = desktopSize?.width && desktopSize.width > 0
      ? Math.round(desktopSize.width)
      : undefined;
    const desktopHeight = desktopSize?.height && desktopSize.height > 0
      ? Math.round(desktopSize.height)
      : undefined;

    sessionIdRef.current = sessionId;
    let routeLeaseId: number | undefined;

    const clearConnectTimeout = () => {
      window.clearTimeout(connectTimeout);
    };
    const failIfStillConnecting = () => {
      if (disposed || connectFinished || timedOut) {
        return;
      }
      timedOut = true;
      callbacksRef.current.onError(
        tabId,
        'RDP connection timed out before the native client returned a diagnostic result',
      );
      void kktermRdpDisconnect({ tabId, routeLeaseId }).catch(() => undefined);
    };
    const connectTimeout = window.setTimeout(
      failIfStillConnecting,
      KKTERM_CONNECT_FEEDBACK_TIMEOUT_MS,
    );
    let hasConnected = false;
    let keepaliveTimer: ReturnType<typeof window.setInterval> | undefined;
    let startupRetryIndex = 0;
    let startupRetrying = false;

    const runCloudKeepalive = () => {
      if (disposed) return;
      void cloudKeepBindingAlive({ sessionId: tabId, host: server.host, port: server.port }).catch(error => {
        rdpLog.warn('cloud', 'binding keepalive failed', {
          tabId,
          host: server.host,
          port: server.port,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };

    const startCloudKeepalive = () => {
      if (keepaliveTimer !== undefined) return;
      runCloudKeepalive();
      keepaliveTimer = window.setInterval(runCloudKeepalive, CLOUD_BINDING_KEEPALIVE_INTERVAL_MS);
    };

    const nextStartupRetryDelay = () => {
      const delay = KKTERM_START_RETRY_DELAYS_MS[startupRetryIndex];
      if (delay === undefined) return null;
      startupRetryIndex += 1;
      return delay;
    };

    const failWithMessage = (message: string) => {
      if (disposed || connectFinished || timedOut) return;
      connectFinished = true;
      terminalErrorReported = true;
      clearConnectTimeout();
      callbacksRef.current.onError(tabId, message);
    };

    const startSession = async () => {
      while (!disposed && !connectFinished && !timedOut) {
        try {
          const response = await kktermRdpStart({
            tabId,
            host: server.host,
            port: server.port,
            username: server.username,
            password: server.password,
            ...(server.domain ? { domain: server.domain } : {}),
            ...(desktopWidth ? { desktopWidth } : {}),
            ...(desktopHeight ? { desktopHeight } : {}),
            scaleFactor: window.devicePixelRatio || 1,
            reuseCloudBinding,
          });
          routeLeaseId = response.routeLeaseId;
          if (disposed) {
            await kktermRdpDisconnect({ tabId, routeLeaseId }).catch(() => undefined);
            return;
          }
          if (response?.routeLabel) {
            callbacksRef.current.onRouteSelected?.(tabId, response.routeLabel, routeLeaseId);
          }
          startCloudKeepalive();
          recoverKeyboardTargetSoon();
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const delay = nextStartupRetryDelay();
          if (delay === null || !isRetryableKktermStartupError(message)) {
            failWithMessage(message);
            return;
          }
          await kktermRdpDisconnect({ tabId, routeLeaseId }).catch(() => undefined);
          await sleepMs(delay);
        }
      }
    };

    const retryEarlyStartupEvent = (message: string) => {
      if (disposed || connectFinished || timedOut || hasConnected || startupRetrying) {
        return false;
      }
      const delay = nextStartupRetryDelay();
      if (delay === null || !isRetryableKktermStartupError(message)) {
        return false;
      }
      startupRetrying = true;
      void (async () => {
        await kktermRdpDisconnect({ tabId, routeLeaseId }).catch(() => undefined);
        await sleepMs(delay);
        startupRetrying = false;
        if (!disposed && !connectFinished && !timedOut) {
          void startSession();
        }
      })();
      return true;
    };

    const draw = (event: KktermCanvasEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (event.kind === 'resolution') {
        canvas.width = event.width;
        canvas.height = event.height;
        callbacksRef.current.onConnected(tabId, event.width, event.height);
        return;
      }
      if (event.kind === 'setCursor') {
        const cursor = cursorUrlFromRgba(event);
        if (cursor) {
          canvas.style.cursor = cursor;
        }
        return;
      }
      if (event.kind !== 'rawImage' || event.width === 0 || event.height === 0) {
        return;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const bytes = base64ToBytes(event.rgba);
      const expected = event.width * event.height * 4;
      if (bytes.length < expected) return;
      const clamped = new Uint8ClampedArray(expected);
      clamped.set(bytes.subarray(0, expected));
      ctx.putImageData(new ImageData(clamped, event.width, event.height), event.x, event.y);
    };

    void listen<KktermCanvasEvent>('kkterm-rdp-canvas-event', event => {
      if (disposed || timedOut || event.payload.sessionId !== sessionIdRef.current) {
        return;
      }
      const payload = event.payload;
      switch (payload.kind) {
        case 'connected':
          hasConnected = true;
          connectFinished = true;
          clearConnectTimeout();
          startCloudKeepalive();
          recoverKeyboardTargetSoon();
          callbacksRef.current.onConnected(tabId);
          break;
        case 'error':
          if (retryEarlyStartupEvent(payload.message)) {
            break;
          }
          connectFinished = true;
          terminalErrorReported = true;
          clearConnectTimeout();
          callbacksRef.current.onError(tabId, payload.message);
          break;
        case 'disconnected':
          // The native loop emits a final lifecycle `disconnected` event after
          // an `error`. Preserve the actionable error instead of replacing it
          // with a generic disconnect/reconnect status in the parent chrome.
          if (terminalErrorReported) {
            break;
          }
          if (retryEarlyStartupEvent('RDP disconnected before the remote desktop became ready')) {
            break;
          }
          connectFinished = true;
          clearConnectTimeout();
          callbacksRef.current.onDisconnected(tabId);
          break;
        default:
          if (payload.kind === 'resolution') {
            hasConnected = true;
            connectFinished = true;
            clearConnectTimeout();
            startCloudKeepalive();
            recoverKeyboardTargetSoon();
          }
          draw(payload);
      }
    }).then(dispose => {
      if (disposed) {
        dispose();
        return;
      }
      unlisten = dispose;
      // Register the native event listener before starting the session. Besides
      // avoiding missed early errors, this prevents React StrictMode's probe
      // mount from launching an orphaned duplicate native connection.
      void startSession();
    }).catch(error => {
      failWithMessage(error instanceof Error ? error.message : String(error));
    });

    return () => {
      disposed = true;
      clearConnectTimeout();
      if (keepaliveTimer !== undefined) {
        window.clearInterval(keepaliveTimer);
      }
      unlisten?.();
      void kktermRdpDisconnect({ tabId, routeLeaseId }).catch(() => undefined);
      sessionIdRef.current = null;
    };
  }, [
    desktopSize?.height,
    desktopSize?.width,
    server.domain,
    server.host,
    server.password,
    server.port,
    server.username,
    tabId,
    reuseCloudBinding,
  ]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      onCanvasRef?.(tabId, canvasRef.current);
    });
    return () => {
      cancelAnimationFrame(raf);
      onCanvasRef?.(tabId, null);
    };
  }, [onCanvasRef, tabId]);

  const remotePoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = Math.max(0, Math.min(canvas.width - 1, Math.round(((clientX - rect.left) / rect.width) * canvas.width)));
    const y = Math.max(0, Math.min(canvas.height - 1, Math.round(((clientY - rect.top) / rect.height) * canvas.height)));
    return { x, y };
  };

  const positionImeTarget = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const input = inputRef.current;
    if (!canvas || !input) return;
    const rect = canvas.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.width - 8, clientX - rect.left));
    const top = Math.max(8, Math.min(rect.height - 8, clientY - rect.top));
    input.style.left = `${Math.round(left)}px`;
    input.style.top = `${Math.round(top)}px`;
  };

  const sendPointer = (clientX: number, clientY: number, buttonMask: number) => {
    const point = remotePoint(clientX, clientY);
    if (!point) return;
    void kktermRdpPointer({ tabId, x: point.x, y: point.y, buttonMask }).catch(() => undefined);
  };

  const sendScancode = (scancode: number, down: boolean) => {
    keySendQueueRef.current = keySendQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        try {
          await kktermRdpKey({ tabId, scancode, down });
        } catch {
          // Keep later key releases moving even if one IPC call fails.
        }
      });
  };

  const sendText = (text: string) => {
    if (text.length === 0) return;
    void kktermRdpText({ tabId, text }).catch(() => undefined);
  };

  const scancodeForRemoteKeyboardEvent = (
    e: React.KeyboardEvent<HTMLInputElement | HTMLCanvasElement>,
  ): number | undefined => {
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      const printableScancode = scancodeForPrintableKey(e.key);
      if (printableScancode !== undefined) {
        return printableScancode;
      }
    }
    return scancodeForCode(e.code);
  };

  const isImeKeyboardEvent = (
    e: React.KeyboardEvent<HTMLInputElement | HTMLCanvasElement>,
  ) => (
    composingRef.current
    || e.nativeEvent.isComposing
    || e.nativeEvent.keyCode === 229
    || e.key === 'Process'
    || e.key === 'Dead'
  );

  const sendCtrlShortcut = (scancode: number) => {
    sendScancode(LEFT_CONTROL_SCANCODE, true);
    sendScancode(scancode, true);
    sendScancode(scancode, false);
    sendScancode(LEFT_CONTROL_SCANCODE, false);
    focusKeyboardTarget();
  };

  const suppressShortcutKeyups = (...codes: string[]) => {
    const suppressed = suppressedShortcutKeyupsRef.current;
    for (const code of codes) {
      suppressed.add(code);
    }
  };

  const releasePressedRemoteKeys = (...codes: string[]) => {
    const releasedCodes: string[] = [];
    for (const code of codes) {
      const scancode = pressedRemoteScancodesRef.current.get(code);
      if (scancode === undefined) {
        continue;
      }
      pressedRemoteScancodesRef.current.delete(code);
      sendScancode(scancode, false);
      releasedCodes.push(code);
    }
    return releasedCodes;
  };

  const handleMacShortcut = (e: React.KeyboardEvent<HTMLInputElement | HTMLCanvasElement>) => {
    if (!e.metaKey || e.altKey || e.ctrlKey) {
      return false;
    }
    if (e.code === 'KeyW' || e.code === 'KeyQ') {
      return false;
    }
    if (e.code === 'KeyV') {
      e.preventDefault();
      const releasedMetaCodes = releasePressedRemoteKeys('MetaLeft', 'MetaRight');
      suppressShortcutKeyups('KeyV', ...releasedMetaCodes);
      if (keyboardModeRef.current === 'remote-scancode' && !e.shiftKey) {
        sendCtrlShortcut(0x2f);
        return true;
      }
      void readClipboardText()
        .then(text => {
          if (text) {
            sendText(text);
          } else {
            sendCtrlShortcut(0x2f);
          }
        })
        .catch(() => sendCtrlShortcut(0x2f));
      return true;
    }
    const scancode = MAC_EDITING_SHORTCUT_SCANCODES[e.code];
    if (scancode !== undefined) {
      e.preventDefault();
      const releasedMetaCodes = releasePressedRemoteKeys('MetaLeft', 'MetaRight');
      suppressShortcutKeyups(e.code, ...releasedMetaCodes);
      sendCtrlShortcut(scancode);
      return true;
    }
    return false;
  };

  const handleCtrlAltEnd = (e: React.KeyboardEvent<HTMLInputElement | HTMLCanvasElement>) => {
    if (!e.ctrlKey || !e.altKey || e.metaKey || e.code !== 'End') {
      return false;
    }
    e.preventDefault();
    const releasedModifierCodes = releasePressedRemoteKeys(
      'ControlLeft',
      'ControlRight',
      'AltLeft',
      'AltRight',
    );
    suppressShortcutKeyups('End', ...releasedModifierCodes);
    sendCtrlAltDelete();
    return true;
  };

  const suppressLocalMetaKey = (e: React.KeyboardEvent<HTMLInputElement | HTMLCanvasElement>) => {
    if (!isMetaCode(e.code) || !e.metaKey || e.ctrlKey || e.altKey) {
      return false;
    }
    e.preventDefault();
    suppressShortcutKeyups(e.code);
    return true;
  };

  const rememberRemoteKeyDown = (code: string, scancode: number) => {
    pressedRemoteScancodesRef.current.set(code, scancode);
  };

  const takeRemoteKeyUpScancode = (code: string): number | undefined => {
    const scancode = pressedRemoteScancodesRef.current.get(code);
    pressedRemoteScancodesRef.current.delete(code);
    return scancode;
  };

  const releaseAllRemoteKeys = () => {
    for (const scancode of pressedRemoteScancodesRef.current.values()) {
      sendScancode(scancode, false);
    }
    pressedRemoteScancodesRef.current.clear();
    suppressedShortcutKeyupsRef.current.clear();
  };

  const onKeyboardBlur = () => {
    resetImeComposition();
    releaseAllRemoteKeys();
  };

  const setCanvasRef = (node: HTMLCanvasElement | null) => {
    canvasRef.current = node;
    if (node && activeRef.current) {
      focusKeyboardTargetSoon();
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    sendPointer(e.clientX, e.clientY, buttonMaskRef.current);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    positionImeTarget(e.clientX, e.clientY);
    focusKeyboardTarget();
    const bit = e.button === 1 ? 1 : e.button === 2 ? 2 : e.button === 0 ? 0 : -1;
    if (bit >= 0) {
      buttonMaskRef.current |= 1 << bit;
    }
    sendPointer(e.clientX, e.clientY, buttonMaskRef.current);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const bit = e.button === 1 ? 1 : e.button === 2 ? 2 : e.button === 0 ? 0 : -1;
    if (bit >= 0) {
      buttonMaskRef.current &= ~(1 << bit);
    }
    sendPointer(e.clientX, e.clientY, buttonMaskRef.current);
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const wheelBit = e.deltaY < 0 ? 1 << 3 : 1 << 4;
    sendPointer(e.clientX, e.clientY, buttonMaskRef.current | wheelBit);
  };

  const sendCtrlAltDelete = () => {
    keySendQueueRef.current = keySendQueueRef.current
      .catch(() => undefined)
      .then(() => kktermRdpCtrlAltDelete({ tabId }))
      .catch(() => undefined);
    focusKeyboardTarget();
  };

  const sendWinKey = () => {
    sendScancode(LEFT_WINDOWS_SCANCODE, true);
    sendScancode(LEFT_WINDOWS_SCANCODE, false);
    focusKeyboardTarget();
  };

  useEffect(() => {
    if (winSignal === lastWinSignalRef.current) return;
    lastWinSignalRef.current = winSignal;
    if (active && winSignal !== 0) {
      sendWinKey();
    }
  });

  useEffect(() => {
    if (cadSignal === lastCadSignalRef.current) return;
    lastCadSignalRef.current = cadSignal;
    if (active && cadSignal !== 0) {
      sendCtrlAltDelete();
    }
  });

  useEffect(() => {
    const sequence = textSignal?.sequence ?? 0;
    if (sequence === lastTextSignalSequenceRef.current) return;
    lastTextSignalSequenceRef.current = sequence;
    if (active && textSignal && textSignal.text.length > 0) {
      sendText(textSignal.text);
      focusKeyboardTarget();
    }
  });

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (handleCtrlAltEnd(e)) {
      return;
    }
    if (suppressLocalMetaKey(e)) {
      return;
    }
    if (handleMacShortcut(e)) {
      return;
    }
    if (isImeKeyboardEvent(e)) {
      return;
    }
    if (keyboardMode === 'remote-scancode') {
      const scancode = scancodeForRemoteKeyboardEvent(e);
      if (scancode !== undefined) {
        e.preventDefault();
        if (inputRef.current) inputRef.current.value = '';
        rememberRemoteKeyDown(e.code, scancode);
        sendScancode(scancode, true);
      }
      return;
    }
    const shortcut = e.ctrlKey || e.altKey || e.metaKey;
    const isText = isCharacterCode(e.code);
    if (isText && !shortcut) {
      return;
    }
    const scancode = scancodeForRemoteKeyboardEvent(e);
    if (scancode !== undefined) {
      e.preventDefault();
      composingRef.current = false;
      if (inputRef.current) {
        inputRef.current.value = '';
      }
      rememberRemoteKeyDown(e.code, scancode);
      sendScancode(scancode, true);
    }
  };

  const onKeyUp = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (suppressedShortcutKeyupsRef.current.delete(e.code)) {
      e.preventDefault();
      return;
    }
    if (isImeKeyboardEvent(e)) {
      return;
    }
    if (keyboardMode === 'remote-scancode') {
      const scancode = takeRemoteKeyUpScancode(e.code) ?? scancodeForRemoteKeyboardEvent(e);
      if (scancode !== undefined) {
        e.preventDefault();
        sendScancode(scancode, false);
      }
      return;
    }
    const shortcut = e.ctrlKey || e.altKey || e.metaKey;
    const isText = isCharacterCode(e.code);
    if (isText && !shortcut) {
      return;
    }
    const scancode = takeRemoteKeyUpScancode(e.code) ?? scancodeForRemoteKeyboardEvent(e);
    if (scancode !== undefined) {
      e.preventDefault();
      composingRef.current = false;
      sendScancode(scancode, false);
    }
  };

  const onCompositionStart = () => {
    composingRef.current = true;
  };

  const onCompositionEnd = (e: React.CompositionEvent<HTMLInputElement>) => {
    composingRef.current = false;
    if (e.data) {
      sendText(e.data);
    }
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  };

  const onInput = (e: React.FormEvent<HTMLInputElement>) => {
    if (composingRef.current) {
      return;
    }
    const native = e.nativeEvent as InputEvent;
    if (keyboardMode === 'kkterm-text' && native.inputType === 'insertText' && native.data) {
      sendText(native.data);
    }
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  };

  const onCanvasKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (keyboardMode !== 'remote-scancode') {
      return;
    }
    if (handleCtrlAltEnd(e)) {
      return;
    }
    if (suppressLocalMetaKey(e)) {
      return;
    }
    if (handleMacShortcut(e)) {
      return;
    }
    if (isImeKeyboardEvent(e)) {
      return;
    }
    const scancode = scancodeForRemoteKeyboardEvent(e);
    if (scancode !== undefined) {
      e.preventDefault();
      rememberRemoteKeyDown(e.code, scancode);
      sendScancode(scancode, true);
    }
  };

  const onCanvasKeyUp = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (keyboardMode !== 'remote-scancode') {
      return;
    }
    if (suppressedShortcutKeyupsRef.current.delete(e.code)) {
      e.preventDefault();
      return;
    }
    if (isImeKeyboardEvent(e)) {
      return;
    }
    const scancode = takeRemoteKeyUpScancode(e.code) ?? scancodeForRemoteKeyboardEvent(e);
    if (scancode !== undefined) {
      e.preventDefault();
      sendScancode(scancode, false);
    }
  };

  return (
    <div className={cn(active ? 'absolute inset-0' : 'hidden')}>
      <div className="rdp-canvas-view" onPointerDown={focusKeyboardTarget}>
        <canvas
          ref={setCanvasRef}
          className="rdp-canvas-surface"
          tabIndex={-1}
          onPointerMove={onPointerMove}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onWheel={onWheel}
          onKeyDown={onCanvasKeyDown}
          onKeyUp={onCanvasKeyUp}
          onBlur={onKeyboardBlur}
          onContextMenu={event => event.preventDefault()}
        />
        <input
          ref={inputRef}
          className="rdp-canvas-ime-input"
          aria-label="RDP display"
          title="RDP display"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          inputMode="text"
          tabIndex={0}
          spellCheck={false}
          style={{ left: 8, top: 8 }}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onInput={onInput}
          onCompositionStart={onCompositionStart}
          onCompositionUpdate={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          onBlur={onKeyboardBlur}
        />
      </div>
    </div>
  );
}

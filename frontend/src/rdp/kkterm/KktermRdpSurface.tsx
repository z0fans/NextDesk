import { listen } from '@tauri-apps/api/event';
import { readText as readClipboardText } from '@tauri-apps/plugin-clipboard-manager';
import { useEffect, useRef, useState } from 'react';
import type { ServerEntry } from '@/lib/rdp-types';
import { cn } from '@/lib/utils';
import {
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
  onConnected: (tabId: string, width?: number, height?: number) => void;
  onDisconnected: (tabId: string) => void;
  onError: (tabId: string, message: string) => void;
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
  onConnected,
  onDisconnected,
  onError,
  onCanvasRef,
}: KktermRdpSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const keyboardMode = readKktermKeyboardMode();
  const keyboardModeRef = useRef<KktermKeyboardMode>(keyboardMode);
  const sessionIdRef = useRef<string | null>(null);
  const buttonMaskRef = useRef(0);
  const composingRef = useRef(false);
  const callbacksRef = useRef({ onConnected, onDisconnected, onError });
  const lastCadSignalRef = useRef(cadSignal);
  const lastWinSignalRef = useRef(winSignal);
  const lastTextSignalSequenceRef = useRef(textSignal?.sequence ?? 0);
  const suppressedShortcutKeyupsRef = useRef(new Set<string>());
  const pressedRemoteScancodesRef = useRef(new Map<string, number>());
  const keySendQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [errorMessage, setErrorMessage] = useState('');

  callbacksRef.current = { onConnected, onDisconnected, onError };
  keyboardModeRef.current = keyboardMode;

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;
    const sessionId = createRdpSessionId(tabId);
    const desktopWidth = desktopSize?.width && desktopSize.width > 0
      ? Math.round(desktopSize.width)
      : undefined;
    const desktopHeight = desktopSize?.height && desktopSize.height > 0
      ? Math.round(desktopSize.height)
      : undefined;

    sessionIdRef.current = sessionId;
    setStatus('connecting');
    setErrorMessage('');

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
      if (disposed || event.payload.sessionId !== sessionIdRef.current) {
        return;
      }
      const payload = event.payload;
      switch (payload.kind) {
        case 'connected':
          setStatus('connected');
          callbacksRef.current.onConnected(tabId);
          break;
        case 'error':
          setErrorMessage(payload.message);
          setStatus('disconnected');
          callbacksRef.current.onError(tabId, payload.message);
          break;
        case 'disconnected':
          setStatus('disconnected');
          callbacksRef.current.onDisconnected(tabId);
          break;
        default:
          draw(payload);
      }
    }).then(dispose => {
      if (disposed) {
        dispose();
        return;
      }
      unlisten = dispose;
    });

    void kktermRdpStart({
      tabId,
      host: server.host,
      port: server.port,
      username: server.username,
      password: server.password,
      ...(server.domain ? { domain: server.domain } : {}),
      ...(desktopWidth ? { desktopWidth } : {}),
      ...(desktopHeight ? { desktopHeight } : {}),
    })
      .then(() => {
        if (!disposed) {
          setStatus('connected');
        }
      })
      .catch(error => {
        if (!disposed) {
          const message = error instanceof Error ? error.message : String(error);
          setErrorMessage(message);
          setStatus('disconnected');
          callbacksRef.current.onError(tabId, message);
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
      void kktermRdpDisconnect({ tabId }).catch(() => undefined);
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

  const focusKeyboardTarget = () => {
    if (keyboardModeRef.current === 'remote-scancode') {
      canvasRef.current?.focus({ preventScroll: true });
      return;
    }
    inputRef.current?.focus({ preventScroll: true });
  };

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
  };

  const setCanvasRef = (node: HTMLCanvasElement | null) => {
    canvasRef.current = node;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    sendPointer(e.clientX, e.clientY, buttonMaskRef.current);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
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
    void kktermRdpCtrlAltDelete({ tabId }).catch(() => undefined);
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
    if (keyboardMode !== 'kkterm-text') {
      e.preventDefault();
      if (inputRef.current) {
        inputRef.current.value = '';
      }
      focusKeyboardTarget();
      return;
    }
    if (suppressLocalMetaKey(e)) {
      return;
    }
    if (handleMacShortcut(e)) {
      return;
    }
    if (composingRef.current || e.key === 'Process' || e.key === 'Dead') {
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
    if (keyboardMode !== 'kkterm-text') {
      e.preventDefault();
      focusKeyboardTarget();
      return;
    }
    if (suppressedShortcutKeyupsRef.current.delete(e.code)) {
      e.preventDefault();
      return;
    }
    if (composingRef.current || e.key === 'Process' || e.key === 'Dead') {
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
    if (keyboardMode !== 'kkterm-text') {
      return;
    }
    composingRef.current = true;
  };

  const onCompositionEnd = (e: React.CompositionEvent<HTMLInputElement>) => {
    if (keyboardMode !== 'kkterm-text') {
      if (inputRef.current) {
        inputRef.current.value = '';
      }
      return;
    }
    composingRef.current = false;
    if (e.data) {
      sendText(e.data);
    }
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  };

  const onInput = (e: React.FormEvent<HTMLInputElement>) => {
    if (keyboardMode !== 'kkterm-text') {
      if (inputRef.current) {
        inputRef.current.value = '';
      }
      return;
    }
    if (composingRef.current) {
      return;
    }
    const native = e.nativeEvent as InputEvent;
    if (native.inputType === 'insertText' && native.data) {
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
    if (suppressLocalMetaKey(e)) {
      return;
    }
    if (handleMacShortcut(e)) {
      return;
    }
    if (e.key === 'Dead') {
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
    const scancode = takeRemoteKeyUpScancode(e.code) ?? scancodeForRemoteKeyboardEvent(e);
    if (scancode !== undefined) {
      e.preventDefault();
      sendScancode(scancode, false);
    }
  };

  const statusText =
    status === 'connecting'
      ? `正在连接 ${server.host}...`
      : status === 'disconnected'
        ? '已断开连接'
        : '';

  return (
    <div className={cn(active ? 'absolute inset-0' : 'hidden')}>
      <div className="rdp-canvas-view" onPointerDown={focusKeyboardTarget}>
        <canvas
          ref={setCanvasRef}
          className="rdp-canvas-surface"
          tabIndex={keyboardMode === 'remote-scancode' ? 0 : -1}
          onPointerMove={onPointerMove}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onWheel={onWheel}
          onKeyDown={onCanvasKeyDown}
          onKeyUp={onCanvasKeyUp}
          onBlur={releaseAllRemoteKeys}
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
          inputMode="none"
          tabIndex={keyboardMode === 'kkterm-text' ? 0 : -1}
          spellCheck={false}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onInput={onInput}
          onCompositionStart={onCompositionStart}
          onCompositionUpdate={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
        />
        {(statusText || errorMessage) && (
          <div className="rdp-canvas-status rdp-canvas-status-blackout">
            {errorMessage || statusText}
          </div>
        )}
      </div>
    </div>
  );
}

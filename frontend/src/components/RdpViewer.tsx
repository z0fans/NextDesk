import { useRef, useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { RdpConnectDialog, type RdpConfig } from './RdpConnectDialog';
import { Monitor, X, Maximize2, Minimize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n/useTranslation';

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error';

// IronRDP WASM types
interface IronRdpWasm {
  default: (input?: any) => Promise<any>;
  setup: (logLevel: string) => void;
  SessionBuilder: new () => SessionBuilder;
  DesktopSize: new (w: number, h: number) => any;
  DeviceEvent: {
    keyPressed: (scancode: number) => any;
    keyReleased: (scancode: number) => any;
    mouseButtonPressed: (button: number) => any;
    mouseButtonReleased: (button: number) => any;
    mouseMove: (x: number, y: number) => any;
  };
  InputTransaction: new () => { addEvent: (e: any) => void };
}

interface SessionBuilder {
  proxyAddress: (addr: string) => SessionBuilder;
  authToken: (token: string) => SessionBuilder;
  renderCanvas: (canvas: HTMLCanvasElement) => SessionBuilder;
  username: (u: string) => SessionBuilder;
  password: (p: string) => SessionBuilder;
  destination: (d: string) => SessionBuilder;
  serverDomain: (d: string) => SessionBuilder;
  desktopSize: (s: any) => SessionBuilder;
  setCursorStyleCallback: (cb: Function) => SessionBuilder;
  setCursorStyleCallbackContext: (ctx: any) => SessionBuilder;
  canvasResizedCallback: (cb: Function) => SessionBuilder;
  connect: () => Promise<Session>;
}

interface Session {
  run: () => Promise<any>;
  applyInputs: (t: any) => void;
  desktopSize: () => { width: number; height: number };
  resize: (w: number, h: number) => void;
  shutdown: () => void;
}

let wasmModule: IronRdpWasm | null = null;
let wasmInitialized = false;

async function loadWasm(): Promise<IronRdpWasm> {
  if (wasmModule && wasmInitialized) return wasmModule;
  // @ts-ignore - dynamic WASM module import
  const mod = await import('../wasm/ironrdp_web.js');
  // @ts-ignore
  const wasmUrl = new URL('../wasm/ironrdp_web_bg.wasm', import.meta.url).href;
  await mod.default(wasmUrl);
  mod.setup('info');
  wasmModule = mod as unknown as IronRdpWasm;
  wasmInitialized = true;
  return wasmModule;
}

export function RdpViewer() {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<Session | null>(null);
  const [connState, setConnState] = useState<ConnectionState>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const [proxyPort, setProxyPort] = useState(8765);

  useEffect(() => {
    invoke<number>('get_rdp_proxy_port').then(setProxyPort).catch(() => {});
    loadWasm().catch(() => {});
  }, []);

  const handleConnect = useCallback(async (config: RdpConfig) => {
    setConnState('connecting');
    setErrorMsg('');

    try {
      const wasm = await loadWasm();

      // Wait a tick for React to re-render and show the canvas
      await new Promise(r => setTimeout(r, 50));

      const canvas = canvasRef.current;
      if (!canvas) throw new Error('Canvas not ready');

      const container = containerRef.current;
      if (container) {
        canvas.width = container.clientWidth;
        canvas.height = container.clientHeight - 48;
      } else {
        canvas.width = 1280;
        canvas.height = 720;
      }

      const size = new wasm.DesktopSize(canvas.width, canvas.height);
      const wsUrl = `ws://127.0.0.1:${proxyPort}`;

      const builder = new wasm.SessionBuilder()
        .proxyAddress(wsUrl)
        .authToken('nextdesk-local')
        .destination(`${config.host}:${config.port}`)
        .username(config.username)
        .password(config.password)
        .desktopSize(size)
        .renderCanvas(canvas)
        .setCursorStyleCallback(
          (kind: string, data?: string, hx?: number, hy?: number) => {
            if (!canvas) return;
            if (kind === 'url' && data) {
              canvas.style.cursor = `url(${data}) ${hx ?? 0} ${hy ?? 0}, auto`;
            } else if (kind === 'hidden') {
              canvas.style.cursor = 'none';
            } else {
              canvas.style.cursor = 'default';
            }
          },
        )
        .setCursorStyleCallbackContext(null)
        .canvasResizedCallback(() => {});

      if (config.domain) {
        builder.serverDomain(config.domain);
      }

      const session = await builder.connect();
      sessionRef.current = session;
      setConnState('connected');

      const info = await session.run();
      console.log('[rdp] Session ended:', info?.reason?.());
      sessionRef.current = null;
      setConnState('idle');
    } catch (err: any) {
      console.error('[rdp] Connection error:', err);
      const msg = err?.backtrace?.() || err?.message || String(err);
      setConnState('error');
      setErrorMsg(msg);
      sessionRef.current = null;
    }
  }, [proxyPort]);

  const handleDisconnect = useCallback(() => {
    try { sessionRef.current?.shutdown(); } catch {}
    sessionRef.current = null;
    setConnState('idle');
    setErrorMsg('');
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!fullscreen) el.requestFullscreen?.();
    else document.exitFullscreen?.();
    setFullscreen(!fullscreen);
  }, [fullscreen]);

  // Keyboard/mouse → IronRDP
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || connState !== 'connected') return;

    const sendInput = (event: any) => {
      if (!sessionRef.current || !wasmModule) return;
      const tx = new wasmModule.InputTransaction();
      tx.addEvent(event);
      sessionRef.current.applyInputs(tx);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      if (!wasmModule) return;
      sendInput(wasmModule.DeviceEvent.keyPressed(e.which || e.keyCode));
    };
    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      if (!wasmModule) return;
      sendInput(wasmModule.DeviceEvent.keyReleased(e.which || e.keyCode));
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!wasmModule) return;
      const r = canvas.getBoundingClientRect();
      sendInput(wasmModule.DeviceEvent.mouseMove(e.clientX - r.left, e.clientY - r.top));
    };
    const onMouseDown = (e: MouseEvent) => {
      if (!wasmModule) return;
      canvas.focus();
      sendInput(wasmModule.DeviceEvent.mouseButtonPressed(e.button));
    };
    const onMouseUp = (e: MouseEvent) => {
      if (!wasmModule) return;
      sendInput(wasmModule.DeviceEvent.mouseButtonReleased(e.button));
    };

    canvas.addEventListener('keydown', onKeyDown);
    canvas.addEventListener('keyup', onKeyUp);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.focus();

    return () => {
      canvas.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mouseup', onMouseUp);
    };
  }, [connState]);

  // Resize canvas
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const resize = () => {
      if (connState === 'idle') return;
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight - 48;
      if (sessionRef.current) {
        sessionRef.current.resize(canvas.width, canvas.height);
      }
    };
    const obs = new ResizeObserver(resize);
    obs.observe(container);
    return () => obs.disconnect();
  }, [connState]);



  return (
    <div ref={containerRef} className="relative flex flex-col h-full">
      {/* Toolbar — only when connected */}
      {connState === 'connected' && (
        <div className="flex items-center justify-between px-3 py-1.5 bg-card border-b border-border z-10">
          <div className="flex items-center gap-2">
            <Monitor className="h-4 w-4 text-cyan-500" />
            <span className="text-xs font-medium">{t('rdpSession')}</span>
            <span className={cn("h-1.5 w-1.5 rounded-full", "bg-emerald-500 animate-pulse")} />
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={toggleFullscreen}>
              {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive" onClick={handleDisconnect}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* Canvas — always in DOM; absolute+invisible during connecting for sizing */}
      <canvas
        ref={canvasRef}
        className={cn(
          "bg-[#0f172a] cursor-default outline-none",
          connState === 'connected' && "flex-1",
          connState === 'connecting' && "absolute inset-0 opacity-0 pointer-events-none",
          connState !== 'connected' && connState !== 'connecting' && "hidden"
        )}
        tabIndex={0}
      />

      {/* Connecting state — full container spinner */}
      {connState === 'connecting' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <div className="h-12 w-12 rounded-full border-4 border-cyan-500/30 border-t-cyan-500 animate-spin" />
          <p className="text-sm text-muted-foreground">{t('rdpConnectRemoteDesktop')}</p>
        </div>
      )}

      {/* Idle / Error — connect form */}
      {(connState === 'idle' || connState === 'error') && (
        <div className="flex flex-col items-center justify-center flex-1 py-16">
          <RdpConnectDialog onConnect={handleConnect} connecting={false} />
          {connState === 'error' && (
            <div className="mt-4 p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-sm text-destructive max-w-md whitespace-pre-wrap">
              {errorMsg}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

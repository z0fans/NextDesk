import { invoke } from '@tauri-apps/api/core';
import { rdpLog } from '@/lib/rdp-logger';
import type {
  RdpConnectionParams,
  RdpEngine,
  RdpEngineCallbacks,
  RdpEngineSession,
  RdpKeyboardEvent,
  RdpMouseButtonEvent,
  RdpResizeParams,
  RdpWheelEvent,
} from './engine-types';

type IronRdpWasm = typeof import('@/wasm/ironrdp_web.js');
type IronRdpExtensionModule = {
  Extension: new (name: string, value: unknown) => unknown;
};
type IronRdpExtensionBuilder = {
  extension(extension: unknown): unknown;
};
type IronRdpTextClipboardBuilder = {
  remoteClipboardChangedCallback(callback: Function): IronRdpTextClipboardBuilder;
  forceClipboardUpdateCallback(callback: Function): IronRdpTextClipboardBuilder;
};
type IronRdpTextClipboardCallbacks = {
  remoteClipboardChanged: Function;
  forceClipboardUpdate: Function;
};
type IronRdpCliprdrFileBuilder = {
  fileContentsRequestCallback(callback: Function): IronRdpCliprdrFileBuilder;
  fileContentsResponseCallback(callback: Function): IronRdpCliprdrFileBuilder;
  fileChunkCallback(callback: Function): IronRdpCliprdrFileBuilder;
};
type IronRdpCliprdrFileCallbacks = {
  fileContentsRequest: Function;
  fileContentsResponse: Function;
  fileChunk: Function;
};
type IronRdpRdpdrDriveSharingOptions = {
  shareName: string;
  driveEntries?: unknown[];
  readCallback?: Function;
};
type IronRdpRdpsndAudioCallbacks = {
  audio: Function;
};
type IronRdpGfxH264Callbacks = {
  gfx: Function;
};

let wasmModule: IronRdpWasm | null = null;
let wasmReady = false;

export async function loadIronRdpWebWasm(): Promise<IronRdpWasm> {
  if (wasmModule && wasmReady) return wasmModule;
  const mod = await import('../wasm/ironrdp_web.js');
  const url = new URL('../wasm/ironrdp_web_bg.wasm', import.meta.url).href;
  await mod.default(url);
  mod.setup('debug');
  wasmModule = mod;
  wasmReady = true;
  return mod;
}

type IronRdpWebEngineOptions = {
  getProxyPort(): Promise<number>;
  visualQualityForHost(host: string): string;
  enableDisplayControl: boolean;
};

export function applyIronRdpDisplayControlExtension(
  wasm: IronRdpExtensionModule,
  builder: IronRdpExtensionBuilder,
  enabled: boolean,
): void {
  if (!enabled) return;
  builder.extension(new wasm.Extension('display_control', true));
}

export function applyIronRdpTextClipboardCallbacks(
  builder: IronRdpTextClipboardBuilder,
  callbacks: IronRdpTextClipboardCallbacks,
): void {
  builder
    .remoteClipboardChangedCallback(callbacks.remoteClipboardChanged)
    .forceClipboardUpdateCallback(callbacks.forceClipboardUpdate);
}

export function applyIronRdpCliprdrFileCallbacks(
  builder: IronRdpCliprdrFileBuilder,
  callbacks: IronRdpCliprdrFileCallbacks,
): void {
  builder
    .fileContentsRequestCallback(callbacks.fileContentsRequest)
    .fileContentsResponseCallback(callbacks.fileContentsResponse)
    .fileChunkCallback(callbacks.fileChunk);
}

export function applyIronRdpRdpdrDriveSharingExtensions(
  wasm: IronRdpExtensionModule,
  builder: IronRdpExtensionBuilder,
  options: IronRdpRdpdrDriveSharingOptions,
): void {
  builder.extension(new wasm.Extension('drive_share_name', options.shareName));
  if (options.driveEntries && options.driveEntries.length > 0) {
    builder.extension(new wasm.Extension('drive_entries', JSON.stringify(options.driveEntries)));
  }
  if (options.readCallback) {
    builder.extension(new wasm.Extension('rdpdr_read_callback', options.readCallback));
  }
}

export function applyIronRdpRdpsndAudioCallback(
  wasm: IronRdpExtensionModule,
  builder: IronRdpExtensionBuilder,
  callbacks: IronRdpRdpsndAudioCallbacks,
): void {
  builder.extension(new wasm.Extension('audio_callback', callbacks.audio));
}

export function applyIronRdpGfxH264Callback(
  wasm: IronRdpExtensionModule,
  builder: IronRdpExtensionBuilder,
  callbacks: IronRdpGfxH264Callbacks,
): void {
  builder.extension(new wasm.Extension('gfx_callback', callbacks.gfx));
}

export function createIronRdpWebEngine(options: IronRdpWebEngineOptions): RdpEngine {
  return {
    name: 'ironrdp-web',
    async connect(params: RdpConnectionParams, callbacks: RdpEngineCallbacks): Promise<RdpEngineSession> {
      callbacks.onStatus({ tabId: params.tabId, status: 'connecting' });

      const proxyPort = await options.getProxyPort();
      if (proxyPort <= 0) {
        throw new Error('RDP local proxy is unavailable');
      }

      const wasm = await loadIronRdpWebWasm();
      const size = new wasm.DesktopSize(params.width, params.height);
      const builder = new wasm.SessionBuilder()
        .proxyAddress(`ws://127.0.0.1:${proxyPort}`)
        .authToken('nextdesk-local')
        .destination(`${params.host}:${params.port}`)
        .username(params.username)
        .password(params.password)
        .desktopSize(size)
        .extension(new wasm.Extension('visual_quality', options.visualQualityForHost(params.host)))
        .renderCanvas(params.canvas)
        .setCursorStyleCallback((kind: string, data?: string, hx?: number, hy?: number) => {
          if (kind === 'url' && data) {
            params.canvas.style.cursor = `url(${data}) ${hx ?? 0} ${hy ?? 0}, auto`;
          } else if (kind !== 'hidden') {
            params.canvas.style.cursor = 'default';
          }
        })
        .setCursorStyleCallbackContext(null)
        .canvasResizedCallback(() => {
          callbacks.onFrame?.({
            tabId: params.tabId,
            desktopWidth: params.canvas.width,
            desktopHeight: params.canvas.height,
          });
        });

      if (params.domain) builder.serverDomain(params.domain);
      applyIronRdpDisplayControlExtension(wasm, builder, options.enableDisplayControl);

      const session = await builder.connect();
      callbacks.onStatus({ tabId: params.tabId, status: 'connected' });

      void session.run()
        .then((info: { reason?: () => string } | undefined) => {
          callbacks.onStatus({
            tabId: params.tabId,
            status: 'disconnected',
            message: info?.reason?.() ?? 'session ended',
          });
        })
        .catch((error: unknown) => {
          callbacks.onStatus({
            tabId: params.tabId,
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        });

      const sendKey = (event: RdpKeyboardEvent) => {
        const wm = wasmModule;
        if (!wm) return;
        const tx = new wm.InputTransaction();
        tx.addEvent(event.isPressed
          ? wm.DeviceEvent.keyPressed(event.scancode)
          : wm.DeviceEvent.keyReleased(event.scancode));
        session.applyInputs(tx);
      };

      return {
        tabId: params.tabId,
        async disconnect() {
          session.shutdown();
        },
        async resize(resizeParams: RdpResizeParams) {
          session.resize(resizeParams.width, resizeParams.height);
        },
        sendKey,
        sendMouseButton(_event: RdpMouseButtonEvent) {
          rdpLog.warn('input', 'mouse button facade is not wired yet');
        },
        sendWheel(_event: RdpWheelEvent) {
          rdpLog.warn('input', 'wheel facade is not wired yet');
        },
      };
    },
  };
}

export async function getDefaultRdpProxyPort(): Promise<number> {
  return invoke<number>('get_rdp_proxy_port').catch(() => 0);
}

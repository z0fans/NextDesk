# IronRDP-First Kernel Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 NextDesk 的 RDP 生产主路径收敛为 IronRDP official-web / ironrdp-web WASM 内核，并把 NextDesk 自研 native frame 渲染链路降级为实验备用路径。

**Architecture:** `RdpManager` 逐步从直接管理 native / official-web 分支，收敛为调用统一 RDP engine 边界。生产默认只走 `IronRdpWebEngine`，通过 IronRDP `SessionBuilder.renderCanvas(canvas)`、`session.run()`、`session.resize()` 和官方 extension 接入渲染、输入、resize、clipboard、rdpdr、rdpsnd。`NativeRdpEngine` 只保留在显式 experimental flag 后，不能影响生产稳定性。

**Tech Stack:** Tauri 2, React 19, TypeScript, Vite 7, Vitest, IronRDP local path crates, ironrdp-web WASM.

---

## Current Boundaries

Production target:

```text
RdpManager
  -> RdpEngine facade
      -> IronRdpWebEngine
          -> frontend/src/wasm/ironrdp_web.js
          -> SessionBuilder.renderCanvas(canvas)
          -> rdp_proxy.rs for RDCleanPath websocket to TCP
```

Experimental only:

```text
RdpEngine facade
  -> NativeRdpEngine
      -> rdp_native_connect
      -> frame_ws.rs
      -> useNativeRdp.ts
      -> custom WebGL2/LZ4/H264 overlay renderer
```

Hard constraints:

- Do not delete native code in the first pass.
- Do not upgrade upstream IronRDP during this alignment.
- Do not change Clash / Tube / Relay behavior while changing the RDP kernel boundary.
- Do not claim stability until the verification matrix in Task 9 has real evidence.
- Git commit is optional and requires user approval in this workspace.

## File Structure

Create:

- `docs/rdp/ironrdp-kernel-baseline.md` - manual baseline checklist and stable feature flag profile.
- `docs/ironrdp-nextdesk-patches.md` - inventory of local IronRDP patches and why each one exists.
- `frontend/src/rdp/engine-types.ts` - stable engine interface and shared types.
- `frontend/src/rdp/engine-flags.ts` - engine and extension flag resolution.
- `frontend/src/rdp/ironrdp-web-engine.ts` - production IronRDP Web engine wrapper.
- `frontend/src/rdp/native-engine.ts` - experimental native engine wrapper around current native path.
- `frontend/src/rdp/index.ts` - public exports for RDP engine modules.
- `frontend/src/test/rdp-engine-flags.test.ts` - flag behavior tests.

Modify:

- `frontend/src/lib/rdp-engine.ts` - shrink to compatibility exports or move logic into `frontend/src/rdp/engine-flags.ts`.
- `frontend/src/test/rdp-engine.test.ts` - update for experimental native gating.
- `frontend/src/components/RdpManager.tsx` - progressively replace inline engine branching with the new facade.
- `frontend/src/api.ts` - keep native commands, but expose them only through `NativeRdpEngine`.
- `src-tauri/src/lib.rs` - no functional change in early tasks; later only add logs or guardrails if needed.
- `src-tauri/src/rdp_session.rs` - no functional change unless verification proves native experimental path needs isolation.

Verification commands:

```bash
cd frontend && npm run test -- src/test/rdp-engine.test.ts src/test/rdp-engine-flags.test.ts
cd frontend && npm run build
cd src-tauri && cargo test rdp_session::tests
cd src-tauri && cargo check
```

---

### Task 1: Record Stable IronRDP Baseline

**Files:**

- Create: `docs/rdp/ironrdp-kernel-baseline.md`

- [ ] **Step 1: Create the baseline document**

Create `docs/rdp/ironrdp-kernel-baseline.md` with:

````markdown
# IronRDP Kernel Baseline

## Purpose

This document defines the smallest RDP runtime profile that must be stable before NextDesk extension features are enabled. It is the reference baseline for the IronRDP-first migration.

## Stable Profile

Use this profile when testing RDP instability:

```text
RDP engine: official-web
Native engine: disabled unless explicitly experimental
Official-web GFX: off
Official-web audio: off
Official-web file transfer websocket bypass: off
DisplayControl: on
Clash / Tube / Relay: unchanged
```

## Runtime Flags

```text
nextdesk_rdp_engine=official-web
VITE_NEXTDESK_RDP_ENGINE=official-web
nextdesk_experimental_native_rdp=0
VITE_NEXTDESK_EXPERIMENTAL_NATIVE_RDP=0
nextdesk_official_web_gfx=0
VITE_NEXTDESK_OFFICIAL_WEB_GFX=0
nextdesk_official_web_gfx_force=0
VITE_NEXTDESK_OFFICIAL_WEB_GFX_FORCE=0
nextdesk_official_web_audio=0
VITE_NEXTDESK_OFFICIAL_WEB_AUDIO=0
nextdesk_official_web_file_transfer=0
VITE_NEXTDESK_OFFICIAL_WEB_FILE_TRANSFER=0
nextdesk_official_web_display_control=1
VITE_NEXTDESK_OFFICIAL_WEB_DISPLAY_CONTROL=1
```

## Manual Verification Matrix

Run against the same Windows RDP target before and after each migration task.

| Case | Expected Result | Evidence Required |
| --- | --- | --- |
| Connect 10 times | 10 successful desktop renders | attempt IDs, timestamps, target host, final status |
| 30 minute idle session | No disconnect, no black canvas | start time, end time, RDP status logs |
| Keyboard input | Letters and shortcuts reach remote host | tested keys and target application |
| Mouse input | Move, click, drag, wheel work | tested actions and target application |
| Adaptive resize | Remote desktop resizes or reconnect fallback is explicit | requested size, final canvas size, resize log |
| Text clipboard local to remote | Text pastes into remote Notepad | source text hash or short sample, paste target |
| Text clipboard remote to local | Remote copied text appears locally | source text hash or short sample, local paste target |
| Tab close | Session shuts down without reconnect loop | close timestamp and absence of reconnect log |
```
````

- [ ] **Step 2: Check the file**

Run:

```bash
sed -n '1,220p' docs/rdp/ironrdp-kernel-baseline.md
```

Expected: the document contains no empty requirement markers and includes the stable profile flags above.

---

### Task 2: Add Experimental Native Gate to Engine Flags

**Files:**

- Create: `frontend/src/rdp/engine-flags.ts`
- Create: `frontend/src/test/rdp-engine-flags.test.ts`
- Modify: `frontend/src/lib/rdp-engine.ts`
- Modify: `frontend/src/test/rdp-engine.test.ts`

- [ ] **Step 1: Write failing tests for experimental native gating**

Create `frontend/src/test/rdp-engine-flags.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  RDP_ENGINE_STORAGE_KEY,
  parseRdpEngineMode,
  resolveRdpEngineMode,
  resolveRdpRuntimeBooleanFlag,
} from '@/rdp/engine-flags';

function createStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
  };
}

describe('IronRDP-first engine flags', () => {
  it('keeps the existing storage key for compatibility', () => {
    expect(RDP_ENGINE_STORAGE_KEY).toBe('nextdesk_rdp_engine');
  });

  it('parses official-web aliases', () => {
    expect(parseRdpEngineMode('official-web')).toBe('official-web');
    expect(parseRdpEngineMode('web')).toBe('official-web');
    expect(parseRdpEngineMode('wasm')).toBe('official-web');
    expect(parseRdpEngineMode('ironrdp-web')).toBe('official-web');
  });

  it('parses native aliases but does not enable native without the experimental flag', () => {
    expect(parseRdpEngineMode('native')).toBe('native');
    expect(resolveRdpEngineMode({
      envValue: 'native',
      storage: createStorage(),
      globalValue: null,
      experimentalNativeValue: '0',
    })).toBe('official-web');
  });

  it('allows native only when experimental native is enabled', () => {
    expect(resolveRdpEngineMode({
      envValue: 'native',
      storage: createStorage(),
      globalValue: null,
      experimentalNativeValue: '1',
    })).toBe('native');
  });

  it('lets localStorage request native only when experimental native is enabled', () => {
    const storage = createStorage({ [RDP_ENGINE_STORAGE_KEY]: 'native' });
    expect(resolveRdpEngineMode({
      envValue: 'official-web',
      storage,
      globalValue: null,
      experimentalNativeValue: '0',
    })).toBe('official-web');
    expect(resolveRdpEngineMode({
      envValue: 'official-web',
      storage,
      globalValue: null,
      experimentalNativeValue: 'yes',
    })).toBe('native');
  });

  it('parses runtime boolean flags', () => {
    expect(resolveRdpRuntimeBooleanFlag({
      storageValue: null,
      envValue: null,
      defaultValue: true,
    })).toBe(true);
    expect(resolveRdpRuntimeBooleanFlag({
      storageValue: '0',
      envValue: '1',
      defaultValue: true,
    })).toBe(false);
    expect(resolveRdpRuntimeBooleanFlag({
      storageValue: null,
      envValue: 'enabled',
      defaultValue: false,
    })).toBe(true);
  });
});
```

- [ ] **Step 2: Run the new test and confirm it fails**

Run:

```bash
cd frontend && npm run test -- src/test/rdp-engine-flags.test.ts
```

Expected: FAIL because `@/rdp/engine-flags` does not exist.

- [ ] **Step 3: Implement `engine-flags.ts`**

Create `frontend/src/rdp/engine-flags.ts`:

```ts
export type RdpEngineMode = 'native' | 'official-web';

export const RDP_ENGINE_STORAGE_KEY = 'nextdesk_rdp_engine';
export const RDP_EXPERIMENTAL_NATIVE_STORAGE_KEY = 'nextdesk_experimental_native_rdp';

type RuntimeGlobal = typeof globalThis & {
  __NEXTDESK_RDP_ENGINE__?: unknown;
  __NEXTDESK_EXPERIMENTAL_NATIVE_RDP__?: unknown;
};

type ResolveRdpEngineModeOptions = {
  envValue?: string | null;
  storage?: Storage | null;
  globalValue?: unknown;
  experimentalNativeValue?: string | null;
};

type ResolveRdpRuntimeBooleanFlagOptions = {
  storageValue?: string | null;
  envValue?: string | null;
  defaultValue: boolean;
};

function readGlobalValue(key: keyof RuntimeGlobal): unknown {
  try {
    return (globalThis as RuntimeGlobal)[key];
  } catch {
    return null;
  }
}

function readDefaultStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readStorageItem(storage: Storage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function readEnvValue(key: string): string | null {
  try {
    return (import.meta.env as Record<string, string | undefined>)?.[key] ?? null;
  } catch {
    return null;
  }
}

export function parseRdpEngineMode(value: string | null | undefined): RdpEngineMode | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'native' || normalized === 'ironrdp-native') return 'native';
  if (
    normalized === 'official-web' ||
    normalized === 'web' ||
    normalized === 'wasm' ||
    normalized === 'ironrdp-web'
  ) {
    return 'official-web';
  }
  return null;
}

export function parseRdpBooleanFlag(value: string | null | undefined, defaultValue = false): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (
    normalized === '1' ||
    normalized === 'true' ||
    normalized === 'yes' ||
    normalized === 'on' ||
    normalized === 'enabled'
  ) {
    return true;
  }
  if (
    normalized === '0' ||
    normalized === 'false' ||
    normalized === 'no' ||
    normalized === 'off' ||
    normalized === 'disabled'
  ) {
    return false;
  }
  return defaultValue;
}

export function resolveRdpRuntimeBooleanFlag(options: ResolveRdpRuntimeBooleanFlagOptions): boolean {
  if (options.storageValue !== null && options.storageValue !== undefined) {
    return parseRdpBooleanFlag(options.storageValue, options.defaultValue);
  }
  return parseRdpBooleanFlag(options.envValue, options.defaultValue);
}

function resolveExperimentalNativeFlag(
  options: ResolveRdpEngineModeOptions,
  storage: Storage | null,
): boolean {
  const fromGlobal = readGlobalValue('__NEXTDESK_EXPERIMENTAL_NATIVE_RDP__');
  if (typeof fromGlobal === 'string') return parseRdpBooleanFlag(fromGlobal, false);
  if (typeof fromGlobal === 'boolean') return fromGlobal;
  if (options.experimentalNativeValue !== undefined) {
    return parseRdpBooleanFlag(options.experimentalNativeValue, false);
  }
  const fromStorage = readStorageItem(storage, RDP_EXPERIMENTAL_NATIVE_STORAGE_KEY);
  if (fromStorage !== null) return parseRdpBooleanFlag(fromStorage, false);
  return parseRdpBooleanFlag(readEnvValue('VITE_NEXTDESK_EXPERIMENTAL_NATIVE_RDP'), false);
}

export function resolveRdpEngineMode(options: ResolveRdpEngineModeOptions = {}): RdpEngineMode {
  const storage = options.storage === undefined ? readDefaultStorage() : options.storage ?? null;
  const experimentalNative = resolveExperimentalNativeFlag(options, storage);
  const globalValue = options.globalValue === undefined
    ? readGlobalValue('__NEXTDESK_RDP_ENGINE__')
    : options.globalValue;

  const candidates = [
    typeof globalValue === 'string' ? globalValue : null,
    readStorageItem(storage, RDP_ENGINE_STORAGE_KEY),
    options.envValue === undefined ? readEnvValue('VITE_NEXTDESK_RDP_ENGINE') : options.envValue,
  ];

  for (const candidate of candidates) {
    const mode = parseRdpEngineMode(candidate);
    if (mode === 'official-web') return 'official-web';
    if (mode === 'native' && experimentalNative) return 'native';
  }

  return 'official-web';
}

export function isNativeRdpMode(mode: RdpEngineMode): boolean {
  return mode === 'native';
}

export function isOfficialIronRdpWebMode(mode: RdpEngineMode): boolean {
  return mode === 'official-web';
}
```

- [ ] **Step 4: Make `frontend/src/lib/rdp-engine.ts` a compatibility shim**

Replace the file with:

```ts
export {
  RDP_ENGINE_STORAGE_KEY,
  RDP_EXPERIMENTAL_NATIVE_STORAGE_KEY,
  isNativeRdpMode,
  isOfficialIronRdpWebMode,
  parseRdpBooleanFlag,
  parseRdpEngineMode,
  resolveRdpEngineMode,
  resolveRdpRuntimeBooleanFlag,
  type RdpEngineMode,
} from '@/rdp/engine-flags';
```

- [ ] **Step 5: Update existing tests for the new native gate**

In `frontend/src/test/rdp-engine.test.ts`, update native expectations so native only resolves when `experimentalNativeValue` is enabled. For the current `uses localStorage before env` test, keep official-web storage. For tests that expect native, pass `experimentalNativeValue: '1'`.

Example update:

```ts
it('uses env when no debug override exists and native is experimental', () => {
  expect(resolveRdpEngineMode({
    envValue: 'native',
    storage: createStorage(),
    globalValue: null,
    experimentalNativeValue: '1',
  })).toBe('native');
});
```

- [ ] **Step 6: Verify tests pass**

Run:

```bash
cd frontend && npm run test -- src/test/rdp-engine.test.ts src/test/rdp-engine-flags.test.ts
```

Expected: PASS.

---

### Task 3: Define the RDP Engine Interface

**Files:**

- Create: `frontend/src/rdp/engine-types.ts`
- Create: `frontend/src/rdp/index.ts`

- [ ] **Step 1: Create engine types**

Create `frontend/src/rdp/engine-types.ts`:

```ts
export type RdpTabId = string;

export type RdpConnectionParams = {
  tabId: RdpTabId;
  host: string;
  port: number;
  username: string;
  password: string;
  domain?: string;
  width: number;
  height: number;
  canvas: HTMLCanvasElement;
};

export type RdpResizeParams = {
  tabId: RdpTabId;
  width: number;
  height: number;
};

export type RdpKeyboardEvent = {
  tabId: RdpTabId;
  scancode: number;
  isPressed: boolean;
};

export type RdpMouseButtonEvent = {
  tabId: RdpTabId;
  x: number;
  y: number;
  button: number;
  isDown: boolean;
};

export type RdpWheelEvent = {
  tabId: RdpTabId;
  x: number;
  y: number;
  delta: number;
  isHorizontal: boolean;
};

export type RdpStatusKind =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'error';

export type RdpStatusUpdate = {
  tabId: RdpTabId;
  status: RdpStatusKind;
  message?: string;
};

export type RdpFrameUpdate = {
  tabId: RdpTabId;
  desktopWidth?: number;
  desktopHeight?: number;
};

export type RdpEngineCallbacks = {
  onStatus(update: RdpStatusUpdate): void;
  onFrame?(update: RdpFrameUpdate): void;
};

export type RdpEngineSession = {
  tabId: RdpTabId;
  disconnect(): Promise<void>;
  resize(params: RdpResizeParams): Promise<void>;
  sendKey(event: RdpKeyboardEvent): void;
  sendMouseButton(event: RdpMouseButtonEvent): void;
  sendWheel(event: RdpWheelEvent): void;
};

export type RdpEngine = {
  readonly name: 'ironrdp-web' | 'native-experimental';
  connect(params: RdpConnectionParams, callbacks: RdpEngineCallbacks): Promise<RdpEngineSession>;
};
```

- [ ] **Step 2: Create public exports**

Create `frontend/src/rdp/index.ts`:

```ts
export * from './engine-flags';
export * from './engine-types';
```

- [ ] **Step 3: Run TypeScript build**

Run:

```bash
cd frontend && npm run build
```

Expected: PASS or fail only on pre-existing unrelated errors. If there is a failure, record the first error and do not modify unrelated files.

---

### Task 4: Extract the Official IronRDP Web Engine Wrapper

**Files:**

- Create: `frontend/src/rdp/ironrdp-web-engine.ts`

- [ ] **Step 1: Create the wrapper with the official-web connection skeleton**

Create `frontend/src/rdp/ironrdp-web-engine.ts`:

```ts
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
      if (options.enableDisplayControl) {
        builder.extension(new wasm.Extension('display_control', true));
      }

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
```

- [ ] **Step 2: Build the self-contained wrapper**

Run:

```bash
cd frontend && npm run build
```

Expected: PASS if the wrapper is self-contained. The facade is not wired into `RdpManager` yet.

- [ ] **Step 3: Do not replace all input handling yet**

Keep mouse, wheel, clipboard and file transfer in `RdpManager` for now. This task only creates an official-web engine wrapper and proves it compiles.

---

### Task 5: Move Engine Selection Out of `RdpManager`

**Files:**

- Create: `frontend/src/rdp/native-engine.ts`
- Modify: `frontend/src/components/RdpManager.tsx`

- [ ] **Step 1: Create native experimental engine stub**

Create `frontend/src/rdp/native-engine.ts`:

```ts
import type { RdpConnectionParams, RdpEngine, RdpEngineCallbacks } from './engine-types';

export function createNativeExperimentalEngine(): RdpEngine {
  return {
    name: 'native-experimental',
    async connect(_params: RdpConnectionParams, callbacks: RdpEngineCallbacks) {
      callbacks.onStatus({
        tabId: _params.tabId,
        status: 'error',
        message: 'Native RDP engine is experimental and has not been moved behind the engine facade yet.',
      });
      throw new Error('Native RDP engine is experimental and not available through the facade yet');
    },
  };
}
```

- [ ] **Step 2: Replace top-level imports in `RdpManager`**

Change engine imports from:

```ts
import {
  isNativeRdpMode,
  isOfficialIronRdpWebMode,
  parseRdpBooleanFlag,
  resolveRdpEngineMode,
} from '@/lib/rdp-engine';
```

to:

```ts
import {
  isNativeRdpMode,
  isOfficialIronRdpWebMode,
  parseRdpBooleanFlag,
  resolveRdpEngineMode,
} from '@/rdp/engine-flags';
```

- [ ] **Step 3: Add an explicit native experimental log near constants**

Below `USE_NATIVE_RDP`, add:

```ts
if (USE_NATIVE_RDP) {
  rdpLog.warn('native', 'Native RDP engine is running in experimental mode');
}
```

- [ ] **Step 4: Verify tests and build**

Run:

```bash
cd frontend && npm run test -- src/test/rdp-engine.test.ts src/test/rdp-engine-flags.test.ts
cd frontend && npm run build
```

Expected: PASS.

---

### Task 6: Shrink the Official-Web Runtime Profile

**Files:**

- Modify: `frontend/src/components/RdpManager.tsx`
- Modify: `frontend/src/rdp/engine-flags.ts`
- Modify: `frontend/src/test/rdp-engine-flags.test.ts`

- [ ] **Step 1: Add stable official-web extension profile constants**

In `frontend/src/rdp/engine-flags.ts`, add:

```ts
export type OfficialWebFeatureFlags = {
  audio: boolean;
  gfx: boolean;
  fileTransfer: boolean;
  displayControl: boolean;
};

export function resolveOfficialWebFeatureFlags(read: (storageKey: string, envKey: string) => string | null): OfficialWebFeatureFlags {
  const value = (storageKey: string, envKey: string, defaultValue: boolean) => {
    const storageValue = read(storageKey, '');
    const envValue = read('', envKey);
    return resolveRdpRuntimeBooleanFlag({ storageValue, envValue, defaultValue });
  };

  return {
    audio: value('nextdesk_official_web_audio', 'VITE_NEXTDESK_OFFICIAL_WEB_AUDIO', false),
    gfx: value('nextdesk_official_web_gfx', 'VITE_NEXTDESK_OFFICIAL_WEB_GFX', false),
    fileTransfer: value('nextdesk_official_web_file_transfer', 'VITE_NEXTDESK_OFFICIAL_WEB_FILE_TRANSFER', false),
    displayControl: value('nextdesk_official_web_display_control', 'VITE_NEXTDESK_OFFICIAL_WEB_DISPLAY_CONTROL', true),
  };
}
```

- [ ] **Step 2: Add tests for the stable profile**

Update the existing import from `@/rdp/engine-flags` so it also imports `resolveOfficialWebFeatureFlags`, then append the new `describe` block.

The import block should look like:

```ts
import {
  RDP_ENGINE_STORAGE_KEY,
  parseRdpEngineMode,
  resolveOfficialWebFeatureFlags,
  resolveRdpEngineMode,
  resolveRdpRuntimeBooleanFlag,
} from '@/rdp/engine-flags';
```

Append this `describe` block below the existing tests:

```ts
describe('official-web stable profile', () => {
  it('defaults to stable IronRDP-first baseline', () => {
    const flags = resolveOfficialWebFeatureFlags(() => null);
    expect(flags).toEqual({
      audio: false,
      gfx: false,
      fileTransfer: false,
      displayControl: true,
    });
  });

  it('allows feature flags to be enabled explicitly', () => {
    const flags = resolveOfficialWebFeatureFlags((storageKey, envKey) => {
      const values: Record<string, string> = {
        nextdesk_official_web_audio: '1',
        VITE_NEXTDESK_OFFICIAL_WEB_GFX: 'true',
        nextdesk_official_web_file_transfer: 'yes',
        nextdesk_official_web_display_control: '0',
      };
      return values[storageKey] ?? values[envKey] ?? null;
    });

    expect(flags).toEqual({
      audio: true,
      gfx: true,
      fileTransfer: true,
      displayControl: false,
    });
  });
});
```

- [ ] **Step 3: Use the feature flag object in `RdpManager`**

Replace these constants:

```ts
const OFFICIAL_WEB_ENABLE_AUDIO = resolveRdpRuntimeBooleanFlag(...);
const OFFICIAL_WEB_ENABLE_GFX = resolveRdpRuntimeBooleanFlag(...);
const OFFICIAL_WEB_ENABLE_FILE_TRANSFER = resolveRdpRuntimeBooleanFlag(...);
const OFFICIAL_WEB_ENABLE_DISPLAY_CONTROL = resolveRdpRuntimeBooleanFlag(...);
```

with:

```ts
const OFFICIAL_WEB_FEATURES = resolveOfficialWebFeatureFlags((storageKey, envKey) => {
  if (storageKey) return readRdpRuntimeStorageFlag(storageKey);
  return readRdpRuntimeEnvFlag(envKey);
});
```

Then replace usage:

```ts
OFFICIAL_WEB_ENABLE_AUDIO -> OFFICIAL_WEB_FEATURES.audio
OFFICIAL_WEB_ENABLE_GFX -> OFFICIAL_WEB_FEATURES.gfx
OFFICIAL_WEB_ENABLE_FILE_TRANSFER -> OFFICIAL_WEB_FEATURES.fileTransfer
OFFICIAL_WEB_ENABLE_DISPLAY_CONTROL -> OFFICIAL_WEB_FEATURES.displayControl
```

- [ ] **Step 4: Verify tests**

Run:

```bash
cd frontend && npm run test -- src/test/rdp-engine-flags.test.ts
cd frontend && npm run build
```

Expected: PASS.

---

### Task 7: Keep Native Behind Explicit Experimental Mode

**Files:**

- Modify: `frontend/src/components/RdpManager.tsx`
- Modify: `frontend/src/test/rdp-engine.test.ts`
- Modify: `docs/rdp/ironrdp-kernel-baseline.md`

- [ ] **Step 1: Add a runtime guard before native connection**

In `connectSession`, before the existing native path:

```ts
if (USE_NATIVE_RDP) {
  rdpLog.warn('native', 'Using experimental native RDP path instead of IronRDP official-web');
}
```

If `resolveRdpEngineMode()` returns `official-web`, the native block must be skipped.

- [ ] **Step 2: Update baseline document**

Add:

```markdown
## Native Experimental Rule

Native RDP is not a production fallback. It can only be used when both are true:

1. `nextdesk_rdp_engine` or `VITE_NEXTDESK_RDP_ENGINE` is `native`
2. `nextdesk_experimental_native_rdp` or `VITE_NEXTDESK_EXPERIMENTAL_NATIVE_RDP` is enabled

If either value is missing, NextDesk must use `official-web`.
```

- [ ] **Step 3: Verify**

Run:

```bash
cd frontend && npm run test -- src/test/rdp-engine.test.ts src/test/rdp-engine-flags.test.ts
```

Expected: PASS and native cannot be selected by `nextdesk_rdp_engine=native` alone.

---

### Task 8: Inventory Local IronRDP Patches

**Files:**

- Create: `docs/ironrdp-nextdesk-patches.md`

- [x] **Step 1: Create patch inventory document**

Create:

````markdown
# NextDesk IronRDP Patch Inventory

## Purpose

NextDesk depends on a local modified IronRDP checkout at `../../IronRDP`. This inventory makes the fork boundary explicit before the RDP kernel is called stable.

## Required Directory Layout

```text
<parent>/
  IronRDP/
  NextDesk/
```

## Patch Inventory

| Crate | Files | Reason | Stability Risk | Verification |
| --- | --- | --- | --- | --- |
| ironrdp-cliprdr | `crates/ironrdp-cliprdr/src/pdu/format_data/file_list.rs` | File list PDU parsing used by CLIPRDR file copy | Clipboard file regressions | Copy file remote to local and local to remote |
| ironrdp-connector | `crates/ironrdp-connector/src/connection.rs`, `crates/ironrdp-connector/src/connection_activation.rs` | NextDesk connection handshake behavior | Authentication or activation failures | Connect to NLA-enabled Windows host 10 times |
| ironrdp-dvc | `crates/ironrdp-dvc/src/client.rs` | Dynamic virtual channel support used by DisplayControl/GFX/audio | Resize or DVC channel failures | Resize and DVC logs |
| ironrdp-rdpsnd-native | `crates/ironrdp-rdpsnd-native/src/cpal.rs` | macOS native audio backend | Audio crackle or device failure | Enable audio flag and play remote sound |
| ironrdp-rdpsnd | `crates/ironrdp-rdpsnd/src/client.rs` | RDPSND client integration | Audio negotiation failures | RDPSND format and wave logs |
| iron-remote-desktop | `crates/iron-remote-desktop/src/lib.rs`, `crates/iron-remote-desktop/src/session.rs` | WASM high level session API | API mismatch with frontend | `frontend/src/wasm/ironrdp_web.d.ts` matches usage |
| ironrdp-web | `crates/ironrdp-web/src/canvas.rs`, `clipboard.rs`, `gfx.rs`, `image.rs`, `lib.rs`, `rdpdr.rs`, `rdpsnd.rs`, `session.rs` | Main IronRDP Web runtime used by NextDesk | Highest RDP rendering risk | Stable profile matrix |

## Rules

- Do not replace `../../IronRDP` with upstream master during this migration.
- Do not add new patches without updating this file.
- Every patch must have a manual verification case.
- Upstream sync must happen after the IronRDP-first baseline is stable.
```
````

- [x] **Step 2: Verify local IronRDP exists**

Run:

```bash
test -d ../IronRDP/crates/ironrdp-web && test -d ../IronRDP/crates/ironrdp-connector
```

Expected: exit code 0.

Verified:

```text
test -d ../IronRDP/crates/ironrdp-web && test -d ../IronRDP/crates/ironrdp-connector
exit 0
```

Patch inventory update:

- `docs/ironrdp-nextdesk-patches.md` now records the official ClearCodec alignment across `ironrdp-pdu`, `ironrdp-graphics`, `ironrdp-egfx`, and `ironrdp-web`.
- The inventory keeps NextDesk-specific adapters separate from upstream-aligned ClearCodec protocol/graphics modules.

---

### Task 9: Run Focused Automated Verification

**Files:**

- No code changes.

- [x] **Step 1: Frontend engine tests**

Run:

```bash
cd frontend && npm run test -- src/test/rdp-engine.test.ts src/test/rdp-engine-flags.test.ts
```

Expected: PASS.

Verified:

```text
npm run test -- src/test/rdp-engine.test.ts src/test/rdp-engine-flags.test.ts
Test Files 2 passed (2); Tests 30 passed (30)
```

- [x] **Step 2: Frontend build**

Run:

```bash
cd frontend && npm run build
```

Expected: PASS.

Verified:

```text
npm run build
✓ built in 1.95s
```

Note: Vite still reports the existing wasm-bindgen `eval` warning in `src/wasm/ironrdp_web.js`.

- [x] **Step 3: Rust RDP session tests**

Run:

```bash
cd src-tauri && cargo test rdp_session::tests
```

Expected: PASS.

Verified:

```text
cargo test rdp_session::tests
test result: ok. 23 passed; 0 failed
```

Note: existing warnings remain in `ironrdp-dvc` and macOS clipboard modules.

- [x] **Step 4: Rust compile check**

Run:

```bash
cd src-tauri && cargo check
```

Expected: PASS.

Verified:

```text
cargo check
Finished `dev` profile ... target(s) in 11.16s
```

Note: existing warnings remain in `ironrdp-dvc` and macOS clipboard modules.

- [x] **Step 5: Manual stable profile smoke test**

Run the app with the stable profile:

```bash
cd frontend
npm run dev
```

In a second terminal:

```bash
npx tauri dev
```

Expected:

- RDP connects through official-web.
- No `rdp_native_connect` log appears unless experimental native is enabled.
- Canvas renders through IronRDP `renderCanvas`.
- Text clipboard works.
- Closing the tab does not schedule an unintended reconnect.

Runtime evidence captured on 2026-06-15:

```text
Command:
VITE_NEXTDESK_RDP_ENGINE=official-web \
VITE_NEXTDESK_EXPERIMENTAL_NATIVE_RDP=0 \
VITE_NEXTDESK_OFFICIAL_WEB_GFX=0 \
VITE_NEXTDESK_OFFICIAL_WEB_GFX_FORCE=0 \
VITE_NEXTDESK_OFFICIAL_WEB_AUDIO=0 \
VITE_NEXTDESK_OFFICIAL_WEB_FILE_TRANSFER=0 \
VITE_NEXTDESK_OFFICIAL_WEB_DISPLAY_CONTROL=1 \
npx tauri dev

Runtime window:
2026-06-15T03:21:* through 2026-06-15T03:22:*

official ironrdp web connected:
2

Official canvas graphics update:
22

clipboard:
Remote → Local text: 123123213213123213213123123
paste-shortcut local text injected before remote paste
Remote has received format list successfully
Focus text-only mode because RDPDR is active: "5555"

native/GFX fallback/error search:
no matches for rdp_native_connect, frame_ws, native RDP, GFX WireToSurface,
unsupported_codec, official-web GFX fallback, decode error, panic, crash, exception, or [error]

tab close:
RDP session terminated disconnect_reason=user initiated disconnect
session.ended reason=user initiated disconnect
no reconnect/connect request after 2026-06-15T03:25:36
```

Observed:
- both `192.168.3.105:3389` and `64.20.10.254:3389` connected through official-web
- `officialWebFeatures` recorded `audio:false`, `gfx:false`, `gfxRequested:false`, `gfxForce:false`, `fileTransfer:false`, `displayControl:true`
- official canvas updates confirmed bitmap stable rendering
- user verified bidirectional text clipboard in the UI
- log evidence recorded both remote-to-local text and local-to-remote paste-shortcut delivery
- user closed the top RDP tab and confirmed no automatic reconnect; log evidence recorded user-initiated disconnect and no later reconnect

---

### Task 10: Optional Follow-Up - Move Clipboard/File/Audio Extensions Into IronRDP Web Engine

**Files:**

- Modify: `frontend/src/rdp/ironrdp-web-engine.ts`
- Modify: `frontend/src/components/RdpManager.tsx`

- [ ] **Step 1: Move one extension at a time**

Move extensions in this exact order:

```text
1. DisplayControl
2. text clipboard callbacks
3. CLIPRDR file callbacks
4. RDPDR drive sharing callbacks
5. RDPSND audio callback
6. GFX H.264 callback
```

Progress:

- [x] 2026-06-14 DisplayControl moved into `applyIronRdpDisplayControlExtension` in `frontend/src/rdp/ironrdp-web-engine.ts`; production official-web path now calls the engine helper from `RdpManager.tsx`.
- [x] text clipboard callbacks
  - 2026-06-14 code/build status: callback registration moved into `applyIronRdpTextClipboardCallbacks`; `cd frontend && npm run build` PASS with the existing `src/wasm/ironrdp_web.js` eval warning.
  - Manual status: PASS. User verified bidirectional text clipboard on 2026-06-14. `/tmp/nextdesk_rdp_debug.log` recorded `forceUpdate Local→Remote text delivered`, repeated `Remote has received format list successfully`, and no `error`/`failed`/`panic`/`crash` level entries during the validation window.
- [x] CLIPRDR file callbacks
  - 2026-06-14 code/build status: `fileContentsRequestCallback`, `fileContentsResponseCallback`, and `fileChunkCallback` registration moved into `applyIronRdpCliprdrFileCallbacks`; `cd frontend && npm run build` PASS with the existing `src/wasm/ironrdp_web.js` eval warning.
  - Manual status: PASS. User verified bidirectional file copy/paste on 2026-06-14. Evidence included `FileContentsRequest`, `Focus sync → FormatList sent for files`, `Remote has received format list successfully`, `File Ice.zip complete via WS`, `Chunked transfer committed`, and `File NextDesk-main.zip complete via WS`.
- [x] RDPDR drive sharing callbacks
  - 2026-06-14 code/build status: `drive_share_name`, `drive_entries`, and `rdpdr_read_callback` extension registration moved into `applyIronRdpRdpdrDriveSharingExtensions`; `cd frontend && npm run build` PASS with the existing `src/wasm/ironrdp_web.js` eval warning.
  - 2026-06-14 settings exposure status: added Settings -> Remote Desktop folder sharing switch backed by `useFolderSharingSetting`; `cd frontend && npm run test -- src/test/session-store.test.tsx` PASS after RED failure confirmed cross-instance sync was missing; `cd frontend && npm run build` PASS with the existing wasm eval warning.
  - Manual status: PASS with caveats. User screenshot shows `NextDesk on NextDesk` under redirected drives and a visible shared item named `ignored`; user reported copy normal. `/tmp/nextdesk_rdp_debug.log` recorded `RDPDR active`, Drive capability negotiation, `device announce response`, repeated Create/QueryInformation/Close requests, `DeviceReadRequest`, and `deferred read` entries for `WPA-Dictionary-276M.zip` and `art002e000192.jpg`. Latest RDPDR validation window had no new `[error]`, panic, crash, or exception entries. Caveats: Windows Explorer generated expected metadata/probe warnings for missing `desktop.ini`, directory change notifications are currently logged as `unhandled io request`, and attempted write/create probes for `276M.zip` logged `create: no such path`; the user-visible copy still completed.
- [x] RDPSND audio callback
  - 2026-06-14 code/build status: `audio_callback` extension registration moved into `applyIronRdpRdpsndAudioCallback`; `cd frontend && npm run build` PASS with the existing `src/wasm/ironrdp_web.js` eval warning.
  - Manual status: PASS. User confirmed audible remote playback on 2026-06-14. `/tmp/nextdesk_rdp_debug.log` recorded `officialWebFeatures":{"audio":true,"gfx":false,"fileTransfer":true,"displayControl":true}`, `Audio callback configured`, `RDPSND audio redirection enabled (native cpal backend)`, `RDPSND audio redirection channel registered`, `AUDIO_PLAYBACK_DVC registered`, `RDPSND DVC: channel opened (AUDIO_PLAYBACK_DVC)`, and repeated `rdpsnd: format changed - 2 ch, 44100 Hz, 16 bit, tag=pcm` events during playback. The sampled validation window had no new `[error]`, panic, crash, or exception entries.
- [x] GFX H.264 callback stability guard
  - 2026-06-14 code/build status: `gfx_callback` extension registration moved into `applyIronRdpGfxH264Callback`; `cd frontend && npm run build` PASS with the existing `src/wasm/ironrdp_web.js` eval warning.
  - Manual status: GUARDED, forced rendering BLOCKED. With `VITE_NEXTDESK_OFFICIAL_WEB_GFX=1 VITE_NEXTDESK_OFFICIAL_WEB_GFX_FORCE=1`, both `64.20.10.254:3389` and `192.168.3.105:3389` connected through RDCleanPath and IronRDP Web, but the RDP area stayed black. `/tmp/nextdesk_rdp_debug.log` recorded `officialWebFeatures":{"audio":false,"gfx":true,"fileTransfer":false,"displayControl":true}`, `GFX H.264 pipeline enabled`, `GFX graphics pipeline channel registered`, and repeated `GFX WireToSurface1 codec="clearcodec"` frames. No `h264_frame` callback or `Official canvas graphics update` was observed in the forced run. Root cause: `WasmGfxHandler` forwards only H.264 frames to JS, skips non-H.264 codecs such as ClearCodec, and consumes the GFX PDU instead of drawing it through the official canvas. Production protection: `nextdesk_official_web_gfx` / `VITE_NEXTDESK_OFFICIAL_WEB_GFX` now records `gfxRequested:true` but keeps actual `gfx:false`; registering the GFX channel requires the unsafe `nextdesk_official_web_gfx_force` / `VITE_NEXTDESK_OFFICIAL_WEB_GFX_FORCE` flag. Verification: `cd frontend && npm run test -- src/test/rdp-engine-flags.test.ts src/test/rdp-engine.test.ts src/test/session-store.test.tsx` PASS (30 tests); `cd frontend && npm run build` PASS with the existing wasm eval warning.
  - 2026-06-15 ClearCodec decode status: UNBLOCKED for captured Windows GFX payload decoding, but visual compositor status: FAIL. Official upstream ClearCodec PDU and graphics decoder modules were ported into the local IronRDP checkout, `WasmGfxHandler` now emits `clearcodec_rgba_patch`, and forced GFX runtime logs at `2026-06-15T03:01:*` recorded 161 `official-web ClearCodec frame` entries, 7 throttled `official-web ClearCodec RGBA patch` entries, and no `official-web GFX fallback`, `decode error`, `official-web GFX disabled`, `unsupported_codec`, or `clearcodec decode error` matches. A later forced-GFX manual retest at `2026-06-15T03:39:*` produced visible flower-screen/block artifacts while logs still showed ClearCodec decode success. Forced GFX is therefore not stable and must not be used for the 30-minute idle gate until the web GFX compositor handles the required surface operations instead of drawing decoded patches as a complete desktop.
  - 2026-06-15 AVC420/H.264 live negotiation status: NOT YET NEGOTIATED on the tested targets. A forced-GFX retest started with `VITE_NEXTDESK_OFFICIAL_WEB_GFX=1`, `VITE_NEXTDESK_OFFICIAL_WEB_GFX_FORCE=1`, audio/file transfer disabled, and DisplayControl enabled. Parsed `/tmp/nextdesk_rdp_debug.log` after `2026-06-15T06:45:00Z` returned `connect_request=2`, `connected=2`, `gfx_channel=2`, `h264_pipeline_enabled=2`, but `h264_frame=0` and `h264_true_codec=0`. The same window returned `clearcodec_codec_lines=158`, `clearcodec_frame_lines=158`, `clearcodec_rgba_patch_lines=8`, and `error_or_fallback_lines=0`. This validates that the H.264 pipeline initializes, but it does not validate runtime AVC420/H.264 rendering because both Windows targets still selected ClearCodec.

- [x] **Step 2: Verification rule for each extension**

After moving each extension, run:

```bash
cd frontend && npm run build
```

Then run the corresponding manual case from `docs/rdp/ironrdp-kernel-baseline.md`.

DisplayControl verification on 2026-06-14:

- `cd frontend && npm run build`: PASS, with the existing `src/wasm/ironrdp_web.js` eval warning.
- Manual target: `64.20.10.254:3389` through `target/debug/nextdesk`, stable official-web profile.
- Evidence: `/tmp/nextdesk_rdp_debug.log` recorded `officialWebFeatures.displayControl=true`, `DisplayControl DVC enabled for dynamic resolution`, and `adaptive resize (observer, official-web) → dynamic PDU sent: 1036 x 651`.
- WASM evidence: resize event received and `Official canvas resize applied after DeactivateAll width=1036 height=651`.
- Process cleanup: the `tauri dev` process was stopped after verification; no `target/debug/nextdesk` or `127.0.0.1:18765` listener remained.

Text clipboard + CLIPRDR file callback verification on 2026-06-14:

- User explicitly approved batching these two manual verification cases instead of stopping after text clipboard only.
- Code/build verification completed for both callback registration moves.
- Manual verification completed after the macOS desktop was unlocked, with the installed `/Applications/NextDesk.app` instance closed and `npx tauri dev` running `target/debug/nextdesk`.
- Runtime profile: `official-web`, experimental native disabled, GFX disabled, DisplayControl enabled, file transfer enabled, audio callback registered.
- User result: bidirectional text clipboard and bidirectional file copy/paste were normal.
- Log evidence: `/tmp/nextdesk_rdp_debug.log` showed `official ironrdp web connected`, `officialWebFeatures":{"audio":true,"gfx":false,"fileTransfer":true,"displayControl":true}`, `forceUpdate Local→Remote text delivered`, `FileContentsRequest`, `Remote file list`, `All files transferred via WS`, and `Chunked transfer committed`.
- Log caveat: one `Unknown stream_id in FileContentsResponse: 90` warning appeared during repeated file validation, but the same transfer later logged `File NextDesk-main.zip complete via WS` and `All files transferred via WS`; no user-visible failure was observed.

RDPDR + RDPSND + GFX callback verification status on 2026-06-14:

- User explicitly approved moving the remaining three callback groups before manual verification.
- Code/build verification completed after each callback group move.
- RDPDR drive visibility and read callback behavior are verified by user screenshots, user copy confirmation, and log evidence. Non-blocking warnings remain for Explorer metadata probes and directory-change notifications.
- RDPSND manual audio playback is verified by user audible playback confirmation and log evidence for callback registration, channel registration, DVC open, and PCM format negotiation.
- GFX/H.264 forced rendering was blocked on 2026-06-14 because the tested targets selected ClearCodec instead of H.264 and the handler did not yet draw non-H.264 GFX frames. This was only partially superseded on 2026-06-15: the official ClearCodec decoder path now emits RGBA patches, but a manual forced-GFX visual retest produced flower-screen/block artifacts. The production path remains guarded, so stable profile still uses `GFX=0` and `GFX_FORCE=0`; the next GFX task is a real EGFX surface compositor or a fallback trigger for incomplete compositor coverage.
- 2026-06-15 forced AVC420/H.264 negotiation retest did not reach H.264 on either tested target. The browser H.264 pipeline initialized, but all GFX frames in the sampled runtime window were ClearCodec. Therefore the project cannot mark IronRDP-native H.264 visual rendering as complete from the current targets.

Stable profile 30 minute idle coverage on 2026-06-15:

- Runtime profile: `official-web`, experimental native disabled, GFX disabled, GFX force disabled, audio disabled, file transfer disabled, DisplayControl enabled.
- Target: `64.20.10.254:3389`.
- Idle window: `2026-06-15T04:09:42.339Z` through `2026-06-15T04:40:35Z` after the final `mouse UP` at `2026-06-15T04:09:42.338Z`.
- Result: PASS. Independent log parse returned `input=0`, `bad=0`, `reconnect=0`, and `Official canvas graphics update=59` during 1852 seconds.
- Scope note: this validates the stable bitmap canvas profile only. It does not validate forced GFX/ClearCodec because forced GFX produced visible compositor artifacts in the preceding manual test.

Drag stutter / jagged motion mitigation on 2026-06-14:

- Observation: user reported visible jagged/stutter while dragging windows. `/tmp/nextdesk_rdp_debug.log` showed stable official-web bitmap rendering, no renderer crash, and continued `Official canvas graphics update` entries.
- Root-cause evidence: the active public session used `64.20.10.254:3389` through SOCKS5 and a fixed `1920 x 1080` desktop while the visible canvas wrapper was smaller (`getCanvasSize: 1502 x 906` in the later reconnect). Earlier local validation also showed repeated fixed `1920 x 1080` resize calls, each causing `Server Deactivate All PDU` and `Official canvas resize applied after DeactivateAll`.
- Mitigation applied in `frontend/src/components/RdpManager.tsx`: official-web mousemove events are now coalesced with `requestAnimationFrame` and flushed before mouse down/up, reducing input burst pressure during drag. Fixed official-web resize now skips if the canvas is already at the requested size, preventing duplicate same-size Deactivate/Reactivation cycles.
- Verification: `cd frontend && npm run build` PASS with the existing `src/wasm/ironrdp_web.js` eval warning. Manual drag smoothness still requires user validation after reconnect.

- [x] **Step 3: Stop if a moved extension destabilizes the baseline**

If an extension breaks the baseline, revert only that extension move and leave the engine facade in place. Do not switch the production path back to native.

---

## Completion Criteria

The migration is complete only when all of these are true:

- `official-web` is the default and only production RDP engine.
- native RDP requires an explicit experimental flag.
- the stable profile in `docs/rdp/ironrdp-kernel-baseline.md` has real verification evidence.
- `docs/ironrdp-nextdesk-patches.md` explains why the local IronRDP checkout differs from upstream.
- frontend tests and build pass.
- Rust RDP session tests and `cargo check` pass.
- no user-facing flow depends on `frame_ws.rs` unless experimental native is explicitly enabled.

## Execution Notes

- Keep each task as a separate change set.
- Do not commit unless the user explicitly approves.
- If three attempts to stabilize a moved extension fail, stop and treat that extension as an architecture problem rather than adding more patches.

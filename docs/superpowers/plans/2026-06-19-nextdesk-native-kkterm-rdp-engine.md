# NextDesk Native KKTerm RDP Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current KKTerm vendor bridge with a first-class NextDesk `kkterm_rdp` engine that uses KKTerm's macOS IronRDP canvas client and Windows ActiveX host while keeping the NextDesk UI shell unchanged.

**Architecture:** NextDesk remains the shell for tabs, server selection, SOCKS routing, menu actions, and visibility. The `kkterm-copy` engine owns RDP rendering/input/connection through `src-tauri/src/kkterm_rdp` and `frontend/src/rdp/kkterm`, removing the old `api.rdpKkterm*`, `KktermVendorRdpView`, and vendor bridge layers after migration. The existing NextDesk native/web RDP paths remain available outside `kkterm-copy`.

**Tech Stack:** Tauri 2, React 19, TypeScript, KKTerm macOS IronRDP 0.15 / ironrdp-tokio 0.9 / tokio-rustls, KKTerm Windows ActiveX `mstscax.dll`, NextDesk built-in SOCKS proxy.

**No Commit Rule:** The user requested no commits for this experimental version. Treat every "checkpoint" step as `git status`, `git diff --check`, and test evidence, not `git commit`.

---

## File Structure

### Rust

- Create: `src-tauri/src/kkterm_rdp/mod.rs`
  - Exposes platform modules and shared command-facing types.
- Create: `src-tauri/src/kkterm_rdp/types.rs`
  - Defines direct `kkterm_rdp_*` command request/response types.
- Create: `src-tauri/src/kkterm_rdp/macos.rs`
  - Native module form of current `src-tauri/vendor/kkterm-rdp-bridge/src/rdp_client.rs`.
- Create: `src-tauri/src/kkterm_rdp/windows.rs`
  - Native module form of current `src-tauri/vendor/kkterm-rdp-bridge/src/rdp.rs`.
- Modify: `src-tauri/src/lib.rs`
  - Register `kkterm_rdp_*` commands and replace old bridge command handlers.
- Modify: `src-tauri/Cargo.kkterm.toml`
  - Replace `kkterm-rdp-bridge` path dependency with direct dependencies needed by `kkterm_rdp`.
- Modify: `scripts/dev-kkterm-rdp.sh`
  - Rename cfg/feature from bridge wording to native module wording after Cargo feature rename.
- Delete after no references remain: `src-tauri/vendor/kkterm-rdp-bridge/`

### Frontend

- Create: `frontend/src/rdp/kkterm/KktermRdpSurface.tsx`
  - Native NextDesk surface based on KKTerm `RdpCanvasView.tsx`.
- Create: `frontend/src/rdp/kkterm/rdpScancodes.ts`
  - Moved from KKTerm.
- Create: `frontend/src/rdp/kkterm/kktermSession.ts`
  - Stable session IDs and active-tab session helpers.
- Create: `frontend/src/rdp/kkterm/styles.css`
  - Moved from KKTerm remote desktop CSS.
- Create: `frontend/src/rdp/kkterm/commands.ts`
  - Thin direct Tauri invoke helpers for `kkterm_rdp_*` commands. This is not a high-level translation wrapper.
- Modify: `frontend/src/components/RdpManager.tsx`
  - Replace `KktermVendorRdpView` and `api.rdpKkterm*` usage with direct `KktermRdpSurface` and `kkterm_rdp` commands.
- Modify: `frontend/src/api.ts`
  - Remove `KktermRdpStartRequest`, `KktermRdpBoundsRequest`, and `api.rdpKkterm*` once no references remain.
- Delete after no references remain: `frontend/src/components/KktermVendorRdpView.tsx`
- Delete after no references remain: `frontend/src/vendor/kkterm/`

### Tests

- Move/replace: `frontend/src/test/kkterm-rdp-canvas-view.test.tsx`
  - New target: `frontend/src/test/kkterm-rdp-surface.test.tsx`
- Replace: `frontend/src/test/kkterm-vendor-rdp-view.test.tsx`
  - New target: `frontend/src/test/kkterm-rdp-manager-shell.test.tsx`
- Replace/remove: `frontend/src/test/kkterm-api.test.ts`
  - New target: `frontend/src/test/kkterm-rdp-commands.test.ts`
- Keep and update if needed: `frontend/src/test/kkterm-rdp-session-id.test.ts`
- Keep: `frontend/src/test/rdp-engine-flags.test.ts`

---

## Task 1: Add Failing Tests For Native KKTerm Boundary

**Files:**
- Create: `frontend/src/test/kkterm-rdp-commands.test.ts`
- Create: `frontend/src/test/kkterm-rdp-surface.test.tsx`
- Modify: `frontend/src/test/kkterm-vendor-rdp-view.test.tsx` only if temporarily needed before replacement

- [ ] **Step 1: Write a failing command test that expects direct `kkterm_rdp_*` commands**

Create `frontend/src/test/kkterm-rdp-commands.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  kktermRdpCtrlAltDelete,
  kktermRdpDisconnect,
  kktermRdpKey,
  kktermRdpPointer,
  kktermRdpSetBounds,
  kktermRdpStart,
  kktermRdpText,
} from '@/rdp/kkterm/commands';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

describe('kkterm RDP direct commands', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it('starts a KKTerm session without api.rdpKkterm translation wrappers', async () => {
    await kktermRdpStart({
      tabId: 'tab-public',
      host: '64.20.10.254',
      port: 3389,
      username: 'administrator',
      password: 'secret',
      domain: 'ACME',
      desktopWidth: 1440,
      desktopHeight: 900,
    });

    expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_start', {
      request: {
        tabId: 'tab-public',
        host: '64.20.10.254',
        port: 3389,
        username: 'administrator',
        password: 'secret',
        domain: 'ACME',
        desktopWidth: 1440,
        desktopHeight: 900,
      },
    });
  });

  it('sends low-level KKTerm input directly to kkterm_rdp commands', async () => {
    await kktermRdpPointer({ tabId: 'tab-public', x: 10, y: 20, buttonMask: 1 });
    await kktermRdpKey({ tabId: 'tab-public', scancode: 0x1d, down: true });
    await kktermRdpText({ tabId: 'tab-public', text: 'hello' });
    await kktermRdpCtrlAltDelete({ tabId: 'tab-public' });
    await kktermRdpSetBounds({
      tabId: 'tab-public',
      x: 1,
      y: 2,
      width: 1280,
      height: 800,
      scaleFactor: 2,
      visible: true,
    });
    await kktermRdpDisconnect({ tabId: 'tab-public' });

    expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_pointer', {
      request: { tabId: 'tab-public', x: 10, y: 20, buttonMask: 1 },
    });
    expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_key', {
      request: { tabId: 'tab-public', scancode: 0x1d, down: true },
    });
    expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_text', {
      request: { tabId: 'tab-public', text: 'hello' },
    });
    expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_ctrl_alt_delete', {
      request: { tabId: 'tab-public' },
    });
    expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_set_bounds', {
      request: {
        tabId: 'tab-public',
        x: 1,
        y: 2,
        width: 1280,
        height: 800,
        scaleFactor: 2,
        visible: true,
      },
    });
    expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_disconnect', {
      request: { tabId: 'tab-public' },
    });
  });
});
```

- [ ] **Step 2: Run command test to verify RED**

Run:

```bash
cd frontend && npm test -- --run src/test/kkterm-rdp-commands.test.ts
```

Expected: FAIL with a module resolution error for `@/rdp/kkterm/commands`.

- [ ] **Step 3: Write failing surface test for direct surface ownership**

Create `frontend/src/test/kkterm-rdp-surface.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KktermRdpSurface } from '@/rdp/kkterm/KktermRdpSurface';
import type { ServerEntry } from '@/lib/rdp-types';

const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn());
const readTextMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: (...args: unknown[]) => readTextMock(...args),
}));

const server: ServerEntry = {
  id: 'server-public',
  name: '64.20.10.254',
  host: '64.20.10.254',
  port: 3389,
  username: 'administrator',
  password: 'secret',
  domain: 'ACME',
  groupId: 'default',
  isFavorite: false,
  colorTag: '',
};

describe('KktermRdpSurface', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    readTextMock.mockReset();
    listenMock.mockResolvedValue(() => undefined);
    invokeMock.mockResolvedValue({ tabId: 'tab-public' });
    readTextMock.mockResolvedValue('clipboard text');
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('starts through kkterm_rdp_start with NextDesk shell state only', async () => {
    render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1600, height: 900 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_start', {
        request: expect.objectContaining({
          tabId: 'tab-public',
          host: '64.20.10.254',
          port: 3389,
          username: 'administrator',
          password: 'secret',
          domain: 'ACME',
          desktopWidth: 1600,
          desktopHeight: 900,
        }),
      });
    });
  });

  it('maps macOS Command+C to a remote Ctrl+C chord on the surface input path', async () => {
    render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_start', expect.any(Object));
    });
    invokeMock.mockClear();

    fireEvent.keyDown(screen.getByLabelText('remoteDesktop.displayAria'), {
      code: 'KeyC',
      key: 'c',
      metaKey: true,
    });

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'kkterm_rdp_key', {
      request: { tabId: 'tab-public', scancode: 0x1d, down: true },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'kkterm_rdp_key', {
      request: { tabId: 'tab-public', scancode: 0x2e, down: true },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'kkterm_rdp_key', {
      request: { tabId: 'tab-public', scancode: 0x2e, down: false },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'kkterm_rdp_key', {
      request: { tabId: 'tab-public', scancode: 0x1d, down: false },
    });
  });
});
```

- [ ] **Step 4: Run surface test to verify RED**

Run:

```bash
cd frontend && npm test -- --run src/test/kkterm-rdp-surface.test.tsx
```

Expected: FAIL with a module resolution error for `@/rdp/kkterm/KktermRdpSurface`.

---

## Task 2: Create Frontend Native KKTerm Engine Folder

**Files:**
- Create: `frontend/src/rdp/kkterm/commands.ts`
- Create: `frontend/src/rdp/kkterm/kktermSession.ts`
- Create: `frontend/src/rdp/kkterm/rdpScancodes.ts`
- Create: `frontend/src/rdp/kkterm/styles.css`
- Create: `frontend/src/rdp/kkterm/KktermRdpSurface.tsx`

- [ ] **Step 1: Create direct command helpers**

Create `frontend/src/rdp/kkterm/commands.ts`:

```ts
import { invoke } from '@tauri-apps/api/core';

export type KktermRdpStartRequest = {
  tabId: string;
  host: string;
  port: number;
  username: string;
  password: string;
  domain?: string;
  desktopWidth?: number;
  desktopHeight?: number;
};

export type KktermRdpBoundsRequest = {
  tabId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
  visible: boolean;
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

export function kktermRdpStart(request: KktermRdpStartRequest) {
  return invoke('kkterm_rdp_start', { request });
}

export function kktermRdpSetBounds(request: KktermRdpBoundsRequest) {
  return invoke('kkterm_rdp_set_bounds', { request });
}

export function kktermRdpPointer(request: KktermRdpPointerRequest) {
  return invoke('kkterm_rdp_pointer', { request });
}

export function kktermRdpKey(request: KktermRdpKeyRequest) {
  return invoke('kkterm_rdp_key', { request });
}

export function kktermRdpText(request: KktermRdpTextRequest) {
  return invoke('kkterm_rdp_text', { request });
}

export function kktermRdpCtrlAltDelete(request: KktermRdpSimpleRequest) {
  return invoke('kkterm_rdp_ctrl_alt_delete', { request });
}

export function kktermRdpDisconnect(request: KktermRdpSimpleRequest) {
  return invoke('kkterm_rdp_disconnect', { request });
}
```

- [ ] **Step 2: Move session helper**

Create `frontend/src/rdp/kkterm/kktermSession.ts` from current `frontend/src/vendor/kkterm/src/modules/workspace/connections/remote-desktop/kktermSessionId.ts`.

The exported function must remain:

```ts
export function createRdpSessionId(connectionId: string) {
  return `rdp-${connectionId}`;
}
```

If the current helper has different stable behavior, keep the current behavior exactly and update tests to import from `@/rdp/kkterm/kktermSession`.

- [ ] **Step 3: Move scancode table**

Copy current `frontend/src/vendor/kkterm/src/modules/workspace/connections/remote-desktop/rdpScancodes.ts` to:

```text
frontend/src/rdp/kkterm/rdpScancodes.ts
```

Keep exported names:

```ts
export function scancodeForCode(code: string): number | undefined;
export function isCharacterCode(code: string): boolean;
```

- [ ] **Step 4: Move styles**

Copy current `frontend/src/vendor/kkterm/src/modules/workspace/connections/remote-desktop/remote-desktop.css` to:

```text
frontend/src/rdp/kkterm/styles.css
```

Keep class names:

```text
rdp-canvas-view
rdp-canvas-surface
rdp-canvas-ime-input
rdp-canvas-status
rdp-canvas-status-blackout
```

- [ ] **Step 5: Create `KktermRdpSurface`**

Create `frontend/src/rdp/kkterm/KktermRdpSurface.tsx` by moving current `RdpCanvasView.tsx` logic into a NextDesk-native component.

Required public props:

```ts
type KktermRdpSurfaceProps = {
  tabId: string;
  server: ServerEntry;
  active: boolean;
  desktopSize?: { width: number; height: number } | null;
  cadSignal: number;
  winSignal: number;
  textSignal?: { sequence: number; text: string } | null;
  onConnected: (tabId: string, width?: number, height?: number) => void;
  onDisconnected: (tabId: string) => void;
  onError: (tabId: string, message: string) => void;
  onCanvasRef?: (tabId: string, canvas: HTMLCanvasElement | null) => void;
};
```

Required imports:

```ts
import { listen } from '@tauri-apps/api/event';
import { readText as readClipboardText } from '@tauri-apps/plugin-clipboard-manager';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { isCharacterCode, scancodeForCode } from './rdpScancodes';
import './styles.css';
```

Required behavioral changes from current vendor component:

- Use `tabId` as the shell session owner.
- Call `kktermRdpStart(...)` instead of `invokeCommand("start_rdp_client_session", ...)`.
- Listen to `kkterm-rdp-canvas-event` if Rust event is renamed; otherwise keep `rdp-canvas-event` until Task 4 renames Rust.
- Call `kktermRdpPointer`, `kktermRdpKey`, `kktermRdpText`, `kktermRdpCtrlAltDelete`, and `kktermRdpDisconnect` directly.
- Do not import from `frontend/src/vendor/kkterm`.

- [ ] **Step 6: Run frontend command and surface tests**

Run:

```bash
cd frontend && npm test -- --run src/test/kkterm-rdp-commands.test.ts src/test/kkterm-rdp-surface.test.tsx
```

Expected: PASS for command helper tests. Surface test may still fail until Rust event naming and RdpManager imports are wired; if it fails only on event name, continue to Task 4.

---

## Task 3: Create Rust Native `kkterm_rdp` Module

**Files:**
- Create: `src-tauri/src/kkterm_rdp/mod.rs`
- Create: `src-tauri/src/kkterm_rdp/types.rs`
- Create: `src-tauri/src/kkterm_rdp/macos.rs`
- Create: `src-tauri/src/kkterm_rdp/windows.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.kkterm.toml`

- [ ] **Step 1: Create module skeleton**

Create `src-tauri/src/kkterm_rdp/mod.rs`:

```rust
pub mod types;

#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(not(target_os = "windows"))]
pub mod macos;
```

- [ ] **Step 2: Create shared command types**

Create `src-tauri/src/kkterm_rdp/types.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KktermRdpStartRequest {
    pub tab_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default)]
    pub desktop_width: Option<u16>,
    #[serde(default)]
    pub desktop_height: Option<u16>,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub width: Option<f64>,
    #[serde(default)]
    pub height: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KktermRdpStarted {
    pub tab_id: String,
    pub host: String,
    pub port: u16,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KktermRdpBoundsRequest {
    pub tab_id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale_factor: f64,
    pub visible: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KktermRdpPointerRequest {
    pub tab_id: String,
    pub x: u16,
    pub y: u16,
    pub button_mask: u8,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KktermRdpKeyRequest {
    pub tab_id: String,
    pub scancode: u16,
    pub down: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KktermRdpTextRequest {
    pub tab_id: String,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KktermRdpSimpleRequest {
    pub tab_id: String,
}
```

- [ ] **Step 3: Move macOS engine code**

Create `src-tauri/src/kkterm_rdp/macos.rs` by moving the contents of current:

```text
src-tauri/vendor/kkterm-rdp-bridge/src/rdp_client.rs
```

Mechanical replacements:

```text
StartRdpClientSessionRequest -> KktermRdpStartRequest
RdpClientSessionStarted -> KktermRdpStarted
RdpClientPointerEventRequest -> KktermRdpPointerRequest
RdpClientKeyEventRequest -> KktermRdpKeyRequest
RdpClientTextRequest -> KktermRdpTextRequest
RdpClientSimpleRequest -> KktermRdpSimpleRequest
session_id -> tab_id where the field identifies the NextDesk tab/session
emit("rdp-canvas-event", ...) -> emit("kkterm-rdp-canvas-event", ...)
```

Keep unchanged:

- IronRDP 0.15 connector flow.
- `connect_rdp_transport` SOCKS/direct logic.
- `RdpInput` event handling.
- raw RGBA canvas event generation.
- pointer decoding.
- text input as Unicode key events.
- Ctrl+Alt+Del scancode sequence.

- [ ] **Step 4: Move Windows engine code**

Create `src-tauri/src/kkterm_rdp/windows.rs` by moving the contents of current:

```text
src-tauri/vendor/kkterm-rdp-bridge/src/rdp.rs
```

Mechanical replacements:

```text
StartRdpSessionRequest -> KktermRdpStartRequest
RdpSessionStarted -> KktermRdpStarted
RdpSimpleRequest -> KktermRdpSimpleRequest
SendRdpTextRequest -> KktermRdpTextRequest
SendRdpKeyPressRequest usage -> map from KktermRdpKeyRequest or keep an internal helper
SendRdpMouseClickRequest usage -> map from KktermRdpPointerRequest
session_id -> tab_id where the field identifies the NextDesk tab/session
```

Keep unchanged:

- ActiveX host creation.
- `AtlAxWin` / `MsTscAx` ProgID probing.
- Display/bounds behavior.
- `RedirectClipboard` default.
- `RedirectDrives` default false.
- text via clipboard + Ctrl+V fallback.
- Ctrl+Alt+End / SendCtrlAltDel fallback sequence.

- [ ] **Step 5: Register module in `lib.rs`**

Modify `src-tauri/src/lib.rs`:

```rust
#[cfg(all(feature = "kkterm-rdp", nextdesk_kkterm_rdp))]
mod kkterm_rdp;
```

Add managers:

```rust
#[cfg(all(feature = "kkterm-rdp", nextdesk_kkterm_rdp, target_os = "windows"))]
static KKTERM_RDP_WINDOWS_MANAGER: std::sync::OnceLock<kkterm_rdp::windows::RdpSessionManager> =
    std::sync::OnceLock::new();

#[cfg(all(feature = "kkterm-rdp", nextdesk_kkterm_rdp, not(target_os = "windows")))]
static KKTERM_RDP_MACOS_MANAGER: std::sync::OnceLock<kkterm_rdp::macos::RdpClientSessionManager> =
    std::sync::OnceLock::new();
```

Add Tauri command handlers with these names:

```rust
kkterm_rdp_start
kkterm_rdp_set_bounds
kkterm_rdp_pointer
kkterm_rdp_key
kkterm_rdp_text
kkterm_rdp_ctrl_alt_delete
kkterm_rdp_disconnect
kkterm_rdp_status
```

The macOS `kkterm_rdp_start` handler must:

1. Check `rdp_target_requires_internal_engine(&request.host)`.
2. Call `start_engine_inner(app_state.inner()).await?` for public targets.
3. Read `app_state.proxy_port`.
4. Set the SOCKS port on the macOS request.
5. Spawn blocking to start the KKTerm runtime manager.

The Windows `kkterm_rdp_start` handler must:

1. Convert `domain + username` only inside the Windows module if ActiveX needs it.
2. Start the ActiveX session on the main thread.
3. Return `KktermRdpStarted`.

- [ ] **Step 6: Update `Cargo.kkterm.toml` feature naming**

Modify `src-tauri/Cargo.kkterm.toml`:

```toml
[features]
default = []
nextdesk-native-rdp = []
kkterm-rdp = []
```

Remove:

```toml
kkterm-rdp-bridge = { path = "vendor/kkterm-rdp-bridge" }
```

Keep direct KKTerm dependencies already present in the bridge:

```toml
[target.'cfg(not(target_os = "windows"))'.dependencies]
ironrdp = { version = "0.15", features = ["connector", "session", "graphics", "pdu", "input"] }
ironrdp-tokio = "0.9"
tokio-rustls = "0.26"
rustls = { version = "0.23", features = ["ring"] }
x509-cert = "0.2"
tokio-socks = "0.5"

[target.'cfg(target_os = "windows")'.dependencies]
windows = { version = "0.61.3", features = [
  "Win32_Foundation",
  "Win32_Graphics_Gdi",
  "Win32_System_Com",
  "Win32_System_DataExchange",
  "Win32_System_LibraryLoader",
  "Win32_System_Memory",
  "Win32_System_Ole",
  "Win32_System_SystemInformation",
  "Win32_UI_Input_KeyboardAndMouse",
  "Win32_UI_Shell",
  "Win32_UI_WindowsAndMessaging",
] }
```

Use the version set that compiles with the rest of NextDesk. If `windows = "0.62"` is required by the moved KKTerm code, update the plan execution note and verify with Windows target separately.

- [ ] **Step 7: Run Rust check**

Run:

```bash
cd src-tauri && RUSTFLAGS="--cfg nextdesk_kkterm_rdp" cargo check --features kkterm-rdp
```

Expected: PASS on macOS. Existing unrelated dead-code warnings are acceptable. New unresolved imports from `kkterm-rdp-bridge` are not acceptable.

---

## Task 4: Wire `RdpManager` To Native `KktermRdpSurface`

**Files:**
- Modify: `frontend/src/components/RdpManager.tsx`
- Modify: `frontend/src/api.ts`
- Delete after references removed: `frontend/src/components/KktermVendorRdpView.tsx`

- [ ] **Step 1: Replace import**

In `frontend/src/components/RdpManager.tsx`, replace:

```ts
import { KktermVendorRdpView } from './KktermVendorRdpView';
```

with:

```ts
import { KktermRdpSurface } from '@/rdp/kkterm/KktermRdpSurface';
import {
  kktermRdpDisconnect,
  kktermRdpKey,
  kktermRdpSetBounds,
  kktermRdpText,
} from '@/rdp/kkterm/commands';
```

- [ ] **Step 2: Replace command calls**

In `RdpManager.tsx`, replace:

```ts
api.rdpKktermDisconnect(tabId)
api.rdpKktermSetBounds(bounds)
api.rdpKktermKey(tabId, 0xe05b, true)
api.rdpKktermText(tabId, text)
api.rdpKktermCtrlAltDelete(tabId)
api.rdpKktermStart(...)
```

with direct helpers:

```ts
kktermRdpDisconnect({ tabId })
kktermRdpSetBounds(bounds)
kktermRdpKey({ tabId, scancode: 0xe05b, down: true })
kktermRdpText({ tabId, text })
```

For Ctrl+Alt+Del on Windows, import and use:

```ts
kktermRdpCtrlAltDelete({ tabId })
```

For session start, do not call a helper in `RdpManager` on macOS because `KktermRdpSurface` owns macOS start. On Windows ActiveX, use `kktermRdpStart` from the command helper because Windows has no canvas surface lifecycle.

- [ ] **Step 3: Replace rendered component**

Replace JSX:

```tsx
<KktermVendorRdpView
  ...
/>
```

with:

```tsx
<KktermRdpSurface
  tabId={tab.id}
  server={server}
  active={active}
  desktopSize={kktermVendorDesktopSize[tab.id] ?? null}
  cadSignal={kktermVendorCadSignalByTab[tab.id] ?? 0}
  winSignal={kktermVendorWinSignalByTab[tab.id] ?? 0}
  textSignal={kktermVendorTextSignalByTab[tab.id] ?? null}
  onConnected={markKktermTabConnected}
  onDisconnected={handleKktermDisconnected}
  onError={handleKktermError}
  onCanvasRef={handleKktermCanvasRef}
/>
```

Rename state variables from `kktermVendor*` to `kktermRdp*` after tests pass. The rename is mechanical and should happen only once behavior is green.

- [ ] **Step 4: Remove `api.rdpKkterm*`**

In `frontend/src/api.ts`, remove:

```ts
KktermRdpStartRequest
KktermRdpStartResponse
KktermRdpBoundsRequest
api.rdpKktermStart
api.rdpKktermSetBounds
api.rdpKktermPointer
api.rdpKktermKey
api.rdpKktermText
api.rdpKktermCtrlAltDelete
api.rdpKktermDisconnect
```

Then run:

```bash
cd frontend && npm run build
```

Expected: FAIL only if there are remaining references to removed `api.rdpKkterm*`. Fix references before continuing.

- [ ] **Step 5: Run frontend tests**

Run:

```bash
cd frontend && npm test -- --run src/test/kkterm-rdp-commands.test.ts src/test/kkterm-rdp-surface.test.tsx src/test/kkterm-rdp-session-id.test.ts src/test/rdp-engine-flags.test.ts
```

Expected: PASS.

---

## Task 5: Remove Old Vendor Bridge And Vendor Frontend

**Files:**
- Delete: `frontend/src/components/KktermVendorRdpView.tsx`
- Delete: `frontend/src/vendor/kkterm/`
- Delete: `src-tauri/vendor/kkterm-rdp-bridge/`
- Modify tests that imported old paths.

- [ ] **Step 1: Confirm no old references**

Run:

```bash
rg -n "KktermVendorRdpView|vendor/kkterm|kkterm-rdp-bridge|rdpKkterm" frontend/src src-tauri/src src-tauri/Cargo.kkterm.toml src-tauri/Cargo.toml
```

Expected: no matches except deleted-file references in git status are not counted.

- [ ] **Step 2: Delete old frontend wrapper**

Delete:

```text
frontend/src/components/KktermVendorRdpView.tsx
```

- [ ] **Step 3: Delete old frontend vendor folder**

Delete:

```text
frontend/src/vendor/kkterm/
```

- [ ] **Step 4: Delete old Rust bridge folder**

Delete:

```text
src-tauri/vendor/kkterm-rdp-bridge/
```

- [ ] **Step 5: Run reference scan again**

Run:

```bash
rg -n "KktermVendorRdpView|vendor/kkterm|kkterm-rdp-bridge|rdpKkterm" frontend/src src-tauri/src src-tauri/Cargo.kkterm.toml src-tauri/Cargo.toml
```

Expected: no matches.

---

## Task 6: Update Dev Script And Engine Naming

**Files:**
- Modify: `scripts/dev-kkterm-rdp.sh`
- Modify: `src-tauri/Cargo.kkterm.toml`
- Modify: `src-tauri/src/lib.rs`
- Modify: `frontend/src/rdp/engine-flags.ts` only if the user wants the visible engine name changed.

- [ ] **Step 1: Update dev script cfg and feature**

Modify `scripts/dev-kkterm-rdp.sh`:

```bash
export VITE_NEXTDESK_RDP_ENGINE="${VITE_NEXTDESK_RDP_ENGINE:-kkterm-copy}"
export RUSTFLAGS="${RUSTFLAGS:-} --cfg nextdesk_kkterm_rdp"

cd "$ROOT_DIR"
npx tauri dev --features kkterm-rdp
```

Keep manifest restore behavior unchanged.

- [ ] **Step 2: Update cfg guards**

In `src-tauri/src/lib.rs`, replace:

```rust
kkterm-vendor-rdp
nextdesk_kkterm_vendor_rdp
```

with:

```rust
kkterm-rdp
nextdesk_kkterm_rdp
```

Use Rust syntax for feature cfg:

```rust
#[cfg(all(feature = "kkterm-rdp", nextdesk_kkterm_rdp))]
```

- [ ] **Step 3: Keep public engine flag stable**

Do not rename frontend engine mode yet:

```ts
'kkterm-copy'
```

Reason: the user-facing opt-in setting and existing localStorage/env workflows already use `kkterm-copy`.

- [ ] **Step 4: Verify script starts the dev build**

Run:

```bash
scripts/dev-kkterm-rdp.sh
```

In another terminal or after startup logs appear, run:

```bash
pgrep -af "target/debug/nextdesk|/Applications/NextDesk|tauri dev|frontend/node_modules/.bin/vite"
```

Expected:

- repo-local `tauri dev --features kkterm-rdp`
- repo-local `frontend/node_modules/.bin/vite`
- `target/debug/nextdesk`
- no reliance on `/Applications/NextDesk.app`

Do not leave duplicate dev servers running.

---

## Task 7: Final Verification

**Files:**
- No source edits expected unless verification reveals an issue.

- [ ] **Step 1: Run KKTerm frontend tests**

Run:

```bash
cd frontend && npm test -- --run src/test/kkterm-rdp-commands.test.ts src/test/kkterm-rdp-surface.test.tsx src/test/kkterm-rdp-session-id.test.ts src/test/rdp-engine-flags.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run frontend build**

Run:

```bash
cd frontend && npm run build
```

Expected: build passes. Existing WASM `eval` warning is acceptable.

- [ ] **Step 3: Run Rust kkterm check**

Run:

```bash
cd src-tauri && RUSTFLAGS="--cfg nextdesk_kkterm_rdp" cargo check --features kkterm-rdp
```

Expected: check passes on macOS. Existing unrelated dead-code warnings are acceptable. New `kkterm_rdp` warnings should be reviewed and either fixed or explicitly documented.

- [ ] **Step 4: Run whitespace diff check**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 5: Run reference cleanup scan**

Run:

```bash
rg -n "KktermVendorRdpView|vendor/kkterm|kkterm-rdp-bridge|api\\.rdpKkterm|rdpKkterm" frontend/src src-tauri/src src-tauri/Cargo.kkterm.toml src-tauri/Cargo.toml || true
```

Expected: no matches.

- [ ] **Step 6: Start dev server for user testing**

Run:

```bash
scripts/dev-kkterm-rdp.sh
```

Verify:

```bash
pgrep -af "target/debug/nextdesk|/Applications/NextDesk|tauri dev|frontend/node_modules/.bin/vite"
```

Expected:

- `target/debug/nextdesk` is running.
- repo-local Vite is running.
- The active test app is not `/Applications/NextDesk.app`.

- [ ] **Step 7: Manual macOS smoke test**

In the dev app:

- Connect to public RDP target and confirm logs show SOCKS route.
- Connect to private/local RDP target and confirm direct route.
- Test mouse click and drag.
- Test keyboard text.
- Test IME/composition if needed.
- Test Command+V text injection.
- Test Command+C remote Ctrl+C mapping.
- Test Send Win Key.
- Test Send Ctrl+Alt+Del only affects the active tab.
- Test resolution change uses the KKTerm reconnect/blackout path.

- [ ] **Step 8: Windows validation note**

Record that Windows ActiveX runtime behavior requires a Windows machine:

```text
Windows ActiveX compile/runtime validation is not proven by macOS cargo check.
Validate on Windows: build, connect, bounds, clipboard, Win key, CAD, active-tab isolation, disconnect cleanup.
```

---

## Self-Review Checklist

- Spec coverage:
  - Native `kkterm_rdp` Rust module: Task 3.
  - Frontend native KKTerm surface: Task 2.
  - Remove old wrapper/bridge layers: Tasks 4 and 5.
  - Keep UI shell unchanged: Task 4.
  - Keep env opt-in behavior: Task 6.
  - macOS and Windows included: Tasks 3 and 7.
  - Verification and dev server proof: Task 7.
- Red-flag scan:
  - Search this plan for unfinished markers before execution; the current saved plan should produce no matches.
- Type consistency:
  - Frontend command names use `kkterm_rdp_*`.
  - Rust request types use `tabId` externally and `tab_id` internally.
  - Public engine flag remains `kkterm-copy`.

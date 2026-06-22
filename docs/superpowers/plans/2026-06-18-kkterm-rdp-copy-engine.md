# KKTerm RDP Copy Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `kkterm-copy` RDP engine that ports KKTerm's Windows ActiveX renderer and macOS simple IronRDP canvas renderer without changing the default NextDesk RDP path.

**Architecture:** Keep the new engine isolated behind the existing RDP engine flag system. Windows uses a new native HWND/ActiveX backend; macOS uses a dedicated simple RGBA canvas backend and frontend view. Existing native/web RDP modes remain the default path unless `kkterm-copy` is explicitly selected.

**Tech Stack:** Tauri 2, Rust, React 19, TypeScript, existing local IronRDP crates, Windows `mstscax.dll` ActiveX, Tauri events, HTML canvas 2D.

## Global Constraints

- `kkterm-copy` is disabled by default.
- Do not remove or rewrite the current NextDesk RDP engine.
- Do not change existing clipboard, audio, drive redirection, Tube, or proxy behavior outside this opt-in engine.
- Windows `kkterm-copy` uses Microsoft RDP ActiveX.
- macOS `kkterm-copy` uses simple RGBA canvas rendering.
- Prefer NextDesk's existing local IronRDP crates; do not downgrade the dependency graph.
- Retain KKTerm MIT attribution in copied/adapted source files.
- Do not create git commits for this version; the user explicitly said this version does not need commits.

---

## File Structure

- Modify `frontend/src/rdp/engine-flags.ts`: add `kkterm-copy` parsing and helper.
- Modify `frontend/src/test/rdp-engine-flags.test.ts`: cover parsing, env/localStorage/global behavior, and default-off behavior.
- Create `frontend/src/components/KktermRdpCanvasView.tsx`: macOS simple canvas view copied/adapted from KKTerm.
- Modify `frontend/src/components/RdpManager.tsx`: route `kkterm-copy` to the new ActiveX or canvas path.
- Modify `frontend/src/api.ts`: add typed wrappers for `rdp_kkterm_*` commands.
- Modify `src-tauri/Cargo.toml`: add missing Windows crate features needed by ActiveX.
- Modify `src-tauri/src/lib.rs`: register new modules and commands.
- Create `src-tauri/src/rdp_activex.rs`: Windows-only ActiveX backend copied/adapted from KKTerm.
- Create `src-tauri/src/rdp_kkterm_client.rs`: macOS/non-Windows simple IronRDP canvas backend copied/adapted from KKTerm.

---

### Task 1: Add `kkterm-copy` Engine Flag

**Files:**
- Modify: `frontend/src/rdp/engine-flags.ts`
- Modify: `frontend/src/test/rdp-engine-flags.test.ts`
- Optional Modify: `frontend/src/rdp/engine-types.ts`

**Interfaces:**
- Produces: `RdpEngineMode = 'native' | 'native-drift' | 'official-web' | 'kkterm-copy'`
- Produces: `isKktermCopyRdpMode(mode: RdpEngineMode): boolean`

- [ ] **Step 1: Extend the engine mode type**

In `frontend/src/rdp/engine-flags.ts`, change:

```ts
export type RdpEngineMode = 'native' | 'native-drift' | 'official-web';
```

to:

```ts
export type RdpEngineMode = 'native' | 'native-drift' | 'official-web' | 'kkterm-copy';
```

- [ ] **Step 2: Parse `kkterm-copy` aliases**

In `parseRdpEngineMode`, add before `return null`:

```ts
  if (
    normalized === 'kkterm-copy' ||
    normalized === 'kkterm' ||
    normalized === 'mstscax' ||
    normalized === 'activex'
  ) {
    return 'kkterm-copy';
  }
```

- [ ] **Step 3: Allow explicit `kkterm-copy` without changing defaults**

In `resolveRdpEngineMode`, add this branch inside the candidate loop:

```ts
    if (mode === 'kkterm-copy') return 'kkterm-copy';
```

Keep the existing final default:

```ts
  return experimentalNative ? DEFAULT_RDP_ENGINE_MODE : 'official-web';
```

- [ ] **Step 4: Add helper**

At the bottom of `frontend/src/rdp/engine-flags.ts`, add:

```ts
export function isKktermCopyRdpMode(mode: RdpEngineMode): boolean {
  return mode === 'kkterm-copy';
}
```

- [ ] **Step 5: Add failing tests first**

Append to `frontend/src/test/rdp-engine-flags.test.ts`:

```ts
  it('parses kkterm-copy aliases as an explicit opt-in engine', () => {
    expect(parseRdpEngineMode('kkterm-copy')).toBe('kkterm-copy');
    expect(parseRdpEngineMode('kkterm')).toBe('kkterm-copy');
    expect(parseRdpEngineMode('mstscax')).toBe('kkterm-copy');
    expect(parseRdpEngineMode('activex')).toBe('kkterm-copy');
  });

  it('does not make kkterm-copy the default engine', () => {
    expect(DEFAULT_RDP_ENGINE_MODE).toBe('native-drift');
    expect(resolveRdpEngineMode({
      envValue: null,
      storage: createStorage(),
      globalValue: null,
      experimentalNativeValue: undefined,
    })).toBe('native-drift');
  });

  it('allows kkterm-copy from env, storage, or global override', () => {
    expect(resolveRdpEngineMode({
      envValue: 'kkterm-copy',
      storage: createStorage(),
      globalValue: null,
      experimentalNativeValue: '0',
    })).toBe('kkterm-copy');

    expect(resolveRdpEngineMode({
      envValue: null,
      storage: createStorage({ [RDP_ENGINE_STORAGE_KEY]: 'kkterm-copy' }),
      globalValue: null,
      experimentalNativeValue: '0',
    })).toBe('kkterm-copy');

    expect(resolveRdpEngineMode({
      envValue: null,
      storage: createStorage(),
      globalValue: 'kkterm-copy',
      experimentalNativeValue: '0',
    })).toBe('kkterm-copy');
  });
```

- [ ] **Step 6: Run targeted test**

Run:

```bash
cd frontend && npm test -- --run src/test/rdp-engine-flags.test.ts
```

Expected: tests pass after implementation.

---

### Task 2: Add Backend Command Interfaces

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/src/rdp_activex.rs`
- Create: `src-tauri/src/rdp_kkterm_client.rs`
- Modify: `frontend/src/api.ts`

**Interfaces:**
- Produces Rust commands:
  - `rdp_kkterm_start`
  - `rdp_kkterm_set_bounds`
  - `rdp_kkterm_disconnect`
  - `rdp_kkterm_pointer`
  - `rdp_kkterm_key`
  - `rdp_kkterm_text`
  - `rdp_kkterm_ctrl_alt_delete`
- Produces frontend API wrappers with the same names in camelCase.

- [ ] **Step 1: Add minimal module declarations**

In `src-tauri/src/lib.rs`, add:

```rust
#[cfg(target_os = "windows")]
mod rdp_activex;
#[cfg(target_os = "macos")]
mod rdp_kkterm_client;
```

- [ ] **Step 2: Create Windows command stubs**

Create `src-tauri/src/rdp_activex.rs` with MIT attribution and temporary stubs:

```rust
// Adapted from KKTerm (MIT License): https://github.com/ryantsai/KKTerm

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    pub tab_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub domain: Option<String>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundsRequest {
    pub tab_id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale_factor: f64,
    pub visible: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimpleRequest {
    pub tab_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartResponse {
    pub tab_id: String,
}

pub fn start(_request: StartRequest) -> Result<StartResponse, String> {
    Err("kkterm-copy ActiveX backend is not implemented yet".to_string())
}

pub fn set_bounds(_request: BoundsRequest) -> Result<(), String> {
    Err("kkterm-copy ActiveX backend is not implemented yet".to_string())
}

pub fn disconnect(_request: SimpleRequest) -> Result<(), String> {
    Ok(())
}
```

- [ ] **Step 3: Create macOS command stubs**

Create `src-tauri/src/rdp_kkterm_client.rs` with matching start/input structs and temporary stubs:

```rust
// Adapted from KKTerm (MIT License): https://github.com/ryantsai/KKTerm

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    pub tab_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub domain: Option<String>,
    pub desktop_width: u16,
    pub desktop_height: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PointerRequest {
    pub tab_id: String,
    pub x: u16,
    pub y: u16,
    pub button_mask: u8,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyRequest {
    pub tab_id: String,
    pub scancode: u16,
    pub down: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRequest {
    pub tab_id: String,
    pub text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimpleRequest {
    pub tab_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartResponse {
    pub tab_id: String,
}

pub fn start(_app: tauri::AppHandle, _request: StartRequest) -> Result<StartResponse, String> {
    Err("kkterm-copy canvas backend is not implemented yet".to_string())
}

pub fn pointer(_request: PointerRequest) -> Result<(), String> {
    Err("kkterm-copy canvas backend is not implemented yet".to_string())
}

pub fn key(_request: KeyRequest) -> Result<(), String> {
    Err("kkterm-copy canvas backend is not implemented yet".to_string())
}

pub fn text(_request: TextRequest) -> Result<(), String> {
    Err("kkterm-copy canvas backend is not implemented yet".to_string())
}

pub fn ctrl_alt_delete(_request: SimpleRequest) -> Result<(), String> {
    Err("kkterm-copy canvas backend is not implemented yet".to_string())
}

pub fn disconnect(_request: SimpleRequest) -> Result<(), String> {
    Ok(())
}
```

- [ ] **Step 4: Register platform-specific commands in `lib.rs`**

Add `#[tauri::command]` wrappers near the native RDP commands. Register them in `generate_handler!` behind matching `#[cfg(...)]`.

- [ ] **Step 5: Add frontend API wrappers**

In `frontend/src/api.ts`, add wrappers that invoke the new commands with explicit request objects. Keep names distinct from current native API wrappers:

```ts
rdpKktermStart(request: KktermRdpStartRequest) {
  return invoke<KktermRdpStartResponse>('rdp_kkterm_start', { request });
}
```

Repeat for set bounds, disconnect, pointer, key, text, and Ctrl+Alt+Delete.

- [ ] **Step 6: Run backend/frontend checks**

Run:

```bash
cd src-tauri && cargo check
cd ../frontend && npm test -- --run src/test/rdp-engine-flags.test.ts
```

Expected: command stubs compile; targeted frontend tests pass.

---

### Task 3: Port Windows ActiveX Backend

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/rdp_activex.rs`

**Interfaces:**
- Consumes: `rdp_kkterm_start`, `rdp_kkterm_set_bounds`, `rdp_kkterm_disconnect`
- Produces: a Windows-only session manager internal to `rdp_activex.rs`.

- [ ] **Step 1: Expand Windows crate features**

In `src-tauri/Cargo.toml`, extend the Windows dependency features to include:

```toml
"Win32_Graphics_Gdi",
"Win32_System_LibraryLoader",
"Win32_UI_Input_KeyboardAndMouse",
"Win32_UI_WindowsAndMessaging",
```

Keep existing features already present.

- [ ] **Step 2: Port KKTerm constants and COM helpers**

Copy/adapt from `/tmp/kkterm-src/src-tauri/src/rdp.rs`:

- `RDP_PROGIDS`
- `ADVANCED_SETTINGS_PROPERTIES`
- `EXTENDED_SETTINGS_PROPERTIES`
- `SECURED_SETTINGS_PROPERTIES`
- `AtlFunctions`
- `atl_functions`
- `control_dispatch`
- IDispatch helpers

Add attribution comment at the top of the file.

- [ ] **Step 3: Port session start**

Implement `start(request: StartRequest)` to:

- validate `tab_id`, host, port
- call `OleInitialize`
- initialize ATL ActiveX hosting
- get the Tauri main window HWND
- create `AtlAxWin` using `CreateWindowExW`
- configure the RDP control properties
- call `Connect`
- store session by `tab_id`

- [ ] **Step 4: Port bounds and visibility**

Implement `set_bounds(request: BoundsRequest)` to:

- convert CSS pixels to physical pixels using `scale_factor`
- when visible, position the ActiveX HWND using `SetWindowPos`
- when hidden, park the HWND offscreen
- call `UpdateSessionDisplaySettings` when bounds change and the selected mode tracks pane size

- [ ] **Step 5: Port disconnect**

Implement `disconnect(request: SimpleRequest)` to:

- remove the session from the map
- call `Disconnect` if available
- destroy the ActiveX HWND

- [ ] **Step 6: Verify Windows compile shape**

On macOS this module is cfg-gated, so run:

```bash
cd src-tauri && cargo check
```

Expected on macOS: no non-Windows symbols leak into the build. Windows compile must be verified on a Windows machine later with `cargo check`.

---

### Task 4: Port macOS Simple Canvas Backend

**Files:**
- Modify: `src-tauri/src/rdp_kkterm_client.rs`

**Interfaces:**
- Consumes: `rdp_kkterm_start`, `rdp_kkterm_pointer`, `rdp_kkterm_key`, `rdp_kkterm_text`, `rdp_kkterm_ctrl_alt_delete`, `rdp_kkterm_disconnect`
- Emits: Tauri event `rdp-kkterm-canvas-event`

- [ ] **Step 1: Port event types**

Define:

```rust
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
enum KktermRdpCanvasEvent {
    Connected { tab_id: String },
    Resolution { tab_id: String, width: u16, height: u16 },
    RawImage { tab_id: String, x: u16, y: u16, width: u16, height: u16, rgba: String },
    SetCursor { tab_id: String, width: u16, height: u16, hot_x: u16, hot_y: u16, rgba: String },
    Error { tab_id: String, message: String },
    Disconnected { tab_id: String },
}
```

- [ ] **Step 2: Port session manager**

Adapt KKTerm's `RdpClientSessionManager` as module-local static state or AppState-owned manager. Use:

- `tokio::runtime::Runtime`
- `HashMap<String, RdpClientSession>`
- unbounded input channel
- stop channel

- [ ] **Step 3: Port connection flow**

Adapt KKTerm's `rdp_connect` flow to local IronRDP APIs. Prefer NextDesk's existing `rdp_session.rs` connection helpers when API mismatch is large.

The flow must produce:

- `ConnectionResult`
- upgraded framed stream

- [ ] **Step 4: Port event loop**

Process `framed.read_pdu()` with `ActiveStage`. For `GraphicsUpdate`, extract RGBA rect and emit:

```rust
app.emit("rdp-kkterm-canvas-event", KktermRdpCanvasEvent::RawImage { ... })
```

- [ ] **Step 5: Port input**

Port KKTerm's `send_rdp_input`:

- pointer move/button transitions
- vertical wheel bits
- scancode press/release
- Unicode text press/release
- Ctrl+Alt+Delete scancode sequence

- [ ] **Step 6: Run macOS backend check**

Run:

```bash
cd src-tauri && cargo check
```

Expected: macOS backend compiles with local IronRDP crates.

---

### Task 5: Add Frontend `kkterm-copy` Runtime Path

**Files:**
- Create: `frontend/src/components/KktermRdpCanvasView.tsx`
- Modify: `frontend/src/components/RdpManager.tsx`
- Modify: `frontend/src/rdp/engine-flags.ts`

**Interfaces:**
- Consumes: `isKktermCopyRdpMode`
- Consumes: API wrappers from Task 2
- Produces: visible RDP session when `RDP_ENGINE_MODE === 'kkterm-copy'`

- [ ] **Step 1: Create canvas component**

Copy/adapt KKTerm's `RdpCanvasView.tsx` into `KktermRdpCanvasView.tsx`. Rename event to `rdp-kkterm-canvas-event`. Use NextDesk tab id as the session id.

- [ ] **Step 2: Add platform detection**

Use browser platform detection or existing NextDesk platform helpers. Required behavior:

- Windows + `kkterm-copy`: use ActiveX path
- macOS + `kkterm-copy`: render `KktermRdpCanvasView`
- other platforms + `kkterm-copy`: show unsupported engine error

- [ ] **Step 3: Route connection startup**

In `RdpManager`, add a branch before existing native/web startup:

```ts
if (USE_KKTERM_COPY_RDP) {
  // route to ActiveX on Windows or KktermRdpCanvasView on macOS
}
```

Keep existing `USE_NATIVE_RDP` and `USE_OFFICIAL_IRONRDP_WEB` paths unchanged.

- [ ] **Step 4: Route disconnect and resize**

Ensure `disconnect`, tab close, visibility changes, and resize call the `rdpKkterm*` API wrappers only for `kkterm-copy` sessions.

- [ ] **Step 5: Run frontend checks**

Run:

```bash
cd frontend && npm test -- --run src/test/rdp-engine-flags.test.ts
cd frontend && npm run build
```

Expected: tests and build pass.

---

### Task 6: Final Verification

**Files:**
- No new files expected unless fixing issues discovered by verification.

**Interfaces:**
- Verifies all interfaces created in Tasks 1-5.

- [ ] **Step 1: Rust check**

Run:

```bash
cd src-tauri && cargo check
```

Expected: success on current platform.

- [ ] **Step 2: Frontend test**

Run:

```bash
cd frontend && npm test -- --run src/test/rdp-engine-flags.test.ts
```

Expected: success.

- [ ] **Step 3: Frontend build**

Run:

```bash
cd frontend && npm run build
```

Expected: success.

- [ ] **Step 4: Manual smoke modes**

In DevTools/localStorage:

```js
localStorage.setItem('nextdesk_rdp_engine', 'kkterm-copy')
```

Restart the frontend/Tauri app and verify:

- Windows: RDP session starts through ActiveX.
- macOS: RDP session starts through canvas and receives `rawImage` events.
- Clearing the key returns to the existing default engine.

Use:

```js
localStorage.removeItem('nextdesk_rdp_engine')
```

Expected: current default engine behavior resumes.

---

## Self-Review

- Spec coverage: enablement, Windows ActiveX, macOS canvas, frontend routing, dependency notes, risks, and acceptance criteria are mapped to Tasks 1-6.
- Red-flag scan: no unfinished marker text or unspecified implementation buckets remain.
- Type consistency: `kkterm-copy`, `rdp_kkterm_*`, and `rdp-kkterm-canvas-event` names are used consistently.
- Git operations: commit steps are intentionally omitted because the user explicitly said this version does not need commits.

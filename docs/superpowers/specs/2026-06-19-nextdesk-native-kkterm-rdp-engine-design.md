# NextDesk Native KKTerm RDP Engine Design

Date: 2026-06-19

## Goal

Use NextDesk as the product shell and use KKTerm as the RDP engine for both supported desktop platforms:

- macOS uses KKTerm's IronRDP 0.15 canvas client.
- Windows uses KKTerm's Microsoft RDP ActiveX host.
- NextDesk does not maintain a separate renderer for this `kkterm-copy` path.

The current `vendor bridge + api.rdpKkterm* + KktermVendorRdpView` shape is an intermediate port. This design replaces it with a native NextDesk engine module named `kkterm_rdp`.

## Non-Goals

These are intentionally out of scope because they are not part of KKTerm's current RDP capability:

- Implementing macOS CLIPRDR bidirectional clipboard.
- Implementing macOS file transfer / RDPDR.
- Enabling macOS RDP audio.
- Rewriting the NextDesk shell UI.
- Making `kkterm-copy` the default engine before validation.

## Product UI Boundary

The NextDesk UI remains the shell:

- Left navigation remains unchanged.
- Server list remains unchanged.
- Multi-tab UI remains unchanged.
- Top tab bar remains unchanged.
- Resolution menu remains unchanged.
- Disconnect / reconnect actions remain unchanged.
- Menu actions such as Send Win Key and Send Ctrl+Alt+Del remain unchanged.

The UI can expose the same controls, but capability availability must match KKTerm's engine behavior:

- macOS KKTerm mode does not advertise file transfer or audio.
- Windows ActiveX mode can rely on ActiveX clipboard redirection.
- macOS paste behavior is text input / local text injection unless a later KKTerm upstream capability exists.

## Allowed Adaptation Boundary

The only allowed adaptation layer is:

```text
NextDesk server/tab/proxy state -> KKTerm session configuration
```

This layer may:

- Read the active NextDesk server entry.
- Read the active tab ID.
- Read the selected desktop size.
- Read the built-in SOCKS proxy port.
- Pass menu signals to the active KKTerm session.

This layer must not:

- Reimplement RDP rendering.
- Reimplement frame transport.
- Reimplement KKTerm keyboard/mouse semantics.
- Translate every low-level input event through an extra NextDesk API wrapper.
- Mix NextDesk native-drift or official-web rendering code into KKTerm mode.

## Target Rust Architecture

Move KKTerm RDP code into a first-class NextDesk module:

```text
src-tauri/src/kkterm_rdp/
  mod.rs
  macos.rs
  windows.rs
  types.rs
```

### `kkterm_rdp::macos`

Source basis:

- `/tmp/kkterm-src/src-tauri/src/rdp_client.rs`

Responsibilities:

- Own the KKTerm IronRDP 0.15 / ironrdp-tokio 0.9 / tokio-rustls session manager.
- Connect to RDP targets.
- Use the NextDesk SOCKS port for public targets.
- Keep direct routing for private/local targets.
- Emit KKTerm canvas events to the frontend.
- Accept KKTerm pointer/key/text/CAD input commands.

It must not depend on NextDesk native-drift frame streaming.

### `kkterm_rdp::windows`

Source basis:

- `/tmp/kkterm-src/src-tauri/src/rdp.rs`

Responsibilities:

- Own the KKTerm ActiveX session manager.
- Host `mstscax.dll` in a native child window.
- Manage bounds and visibility for the active tab.
- Use KKTerm's ActiveX configuration behavior.
- Send text/key/mouse/CAD commands through the ActiveX path.

It must not render into a web canvas.

### `kkterm_rdp::types`

This module defines the shell-to-engine boundary:

- `KktermRdpStartRequest`
- `KktermRdpBoundsRequest`
- `KktermRdpTextRequest`
- `KktermRdpKeyRequest`
- `KktermRdpPointerRequest`
- `KktermRdpSimpleRequest`

These types should represent KKTerm engine concepts directly. They should not mirror the old `api.rdpKkterm*` wrapper shape.

## Target Frontend Architecture

Move the KKTerm canvas implementation into a NextDesk RDP engine folder:

```text
frontend/src/rdp/kkterm/
  KktermRdpSurface.tsx
  rdpScancodes.ts
  kktermSession.ts
  styles.css
```

Source basis:

- `/tmp/kkterm-src/src/modules/workspace/connections/remote-desktop/RdpCanvasView.tsx`
- `/tmp/kkterm-src/src/modules/workspace/connections/remote-desktop/rdpScancodes.ts`
- `/tmp/kkterm-src/src/modules/workspace/connections/remote-desktop/remote-desktop.css`

### `KktermRdpSurface`

Responsibilities:

- Render the KKTerm canvas surface.
- Own KKTerm's hidden input / IME handling.
- Send pointer/key/text commands directly to `kkterm_rdp` Tauri commands.
- Listen for KKTerm canvas events.
- Receive only shell-level props from `RdpManager`.

Allowed props:

- `tabId`
- `server`
- `active`
- `desktopSize`
- `winSignal`
- `cadSignal`
- `textSignal`
- `onConnected`
- `onDisconnected`
- `onError`
- `onCanvasRef`

It should replace `KktermVendorRdpView`.

## RdpManager Role

`RdpManager` remains the shell orchestrator. In `kkterm-copy` mode it should:

- Create a KKTerm session for the active tab.
- Pass server, tab, desktop size, and menu signals to `KktermRdpSurface`.
- Manage tab status and errors.
- Sync Windows ActiveX bounds when running on Windows.
- Disconnect KKTerm sessions when tabs close.

It should not:

- Call `api.rdpKkterm*` wrappers.
- Convert low-level scancodes or pointer events for KKTerm mode.
- Perform canvas drawing for KKTerm mode.

## Command Shape

Replace old wrapper commands with direct engine commands:

```text
kkterm_rdp_start
kkterm_rdp_set_bounds
kkterm_rdp_pointer
kkterm_rdp_key
kkterm_rdp_text
kkterm_rdp_ctrl_alt_delete
kkterm_rdp_disconnect
kkterm_rdp_status
```

On macOS these route to `kkterm_rdp::macos`.

On Windows these route to `kkterm_rdp::windows`.

Unsupported platforms should return a clear error.

## Dependency Strategy

NextDesk currently has a separate local IronRDP dependency graph for its native/web paths. KKTerm requires IronRDP 0.15 / ironrdp-tokio 0.9. These should remain isolated.

The current `scripts/dev-kkterm-rdp.sh` already swaps to `Cargo.kkterm.toml` and sets:

```bash
RUSTFLAGS="--cfg nextdesk_kkterm_vendor_rdp"
--features kkterm-vendor-rdp
```

The native `kkterm_rdp` engine should keep this isolation, but rename the feature/config once the bridge is removed:

```text
feature: kkterm-rdp
cfg: nextdesk_kkterm_rdp
```

The final naming can be done during implementation, but the architectural rule is fixed: do not link the two IronRDP stacks in one Cargo graph.

## Migration Plan

1. Create `src-tauri/src/kkterm_rdp/` and move the current bridge code into it.
2. Register direct `kkterm_rdp_*` Tauri commands.
3. Create `frontend/src/rdp/kkterm/` and move the KKTerm canvas files into it.
4. Replace `KktermVendorRdpView` with `KktermRdpSurface`.
5. Remove `api.rdpKkterm*` usage from `RdpManager`.
6. Keep `kkterm-copy` env/localStorage gating.
7. Keep the normal NextDesk engine path unchanged.
8. Remove `src-tauri/vendor/kkterm-rdp-bridge/` and `frontend/src/vendor/kkterm/` once no imports remain.

## Verification

macOS verification:

- `cd frontend && npm test -- --run <kkterm tests>`
- `cd frontend && npm run build`
- `cd src-tauri && RUSTFLAGS="--cfg nextdesk_kkterm_rdp" cargo check --features kkterm-rdp`
- Start with repo dev server, not installed app:
  - `scripts/dev-kkterm-rdp.sh` or replacement script
  - confirm `target/debug/nextdesk`
  - confirm repo-local Vite
- Test public RDP target through built-in SOCKS.
- Test private/local RDP target direct.
- Test mouse, keyboard, IME text, Win key signal, Ctrl+Alt+Del, resolution reconnect.

Windows verification:

- Build with the Windows target.
- Confirm ActiveX control starts.
- Confirm child window bounds track the active tab surface.
- Confirm clipboard redirection behavior matches KKTerm.
- Confirm Win key and Ctrl+Alt+Del operate only on the active tab.
- Confirm disconnect/reconnect releases ActiveX sessions cleanly.

## Acceptance Criteria

- In `kkterm-copy` mode, macOS uses KKTerm IronRDP canvas only.
- In `kkterm-copy` mode, Windows uses KKTerm ActiveX only.
- NextDesk native-drift and official-web renderers are not used by KKTerm mode.
- NextDesk UI remains visually unchanged.
- `api.rdpKkterm*` wrapper layer is removed or no longer used.
- `KktermVendorRdpView` is removed or no longer used.
- Old vendor bridge directories are removed after migration.
- Normal NextDesk RDP engines remain available outside `kkterm-copy`.

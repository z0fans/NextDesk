# KKTerm RDP Copy Engine Design

## Goal

Add a separate, opt-in RDP engine that ports KKTerm's RDP rendering approaches into NextDesk without replacing the existing IronRDP native or web engines.

This engine is intended as a stability fallback. It should be inactive unless explicitly enabled by runtime configuration.

## Non-Goals

- Do not remove or rewrite the current NextDesk RDP engine.
- Do not make the KKTerm copy engine the only available RDP path.
- Do not merge KKTerm rendering code into the existing native frame pipeline.
- Do not change existing clipboard, audio, drive redirection, Tube, or proxy behavior outside this opt-in engine.

## Enablement

Add a new RDP engine mode:

```text
kkterm-copy
```

The mode should be enabled through the existing engine flag system, using the same precedence rules already used by NextDesk:

- environment/runtime flag, such as `VITE_NEXTDESK_RDP_ENGINE=kkterm-copy`
- localStorage override, such as `nextdesk_rdp_engine=kkterm-copy`

When the mode is not selected, current NextDesk behavior must remain unchanged.

## Windows Implementation

On Windows, the copy engine should port KKTerm's Microsoft RDP ActiveX host.

The new backend should be isolated in a Windows-only Rust module, for example:

```text
src-tauri/src/rdp_activex.rs
```

The module should adapt KKTerm's approach:

- create an `AtlAxWin` host window
- try registered `MsTscAx.MsTscAx.*` ProgIDs
- obtain the control through `IDispatch`
- configure host, username, domain, password, port, color depth, clipboard, drives, bitmap cache, performance flags, SmartSizing, and display settings
- call `Connect`
- manage visibility and bounds using native HWND positioning
- support dynamic display updates through `UpdateSessionDisplaySettings`
- park hidden sessions offscreen instead of unmounting them

The frontend should not render a canvas for this path. It should only report pane bounds, visibility, reconnect, and close events to the backend.

## macOS Implementation

On macOS, the copy engine should port KKTerm's simple IronRDP canvas path.

The new backend should be isolated in a module such as:

```text
src-tauri/src/rdp_kkterm_client.rs
```

The module should adapt KKTerm's flow:

- TCP connect to the RDP server
- perform IronRDP connector begin/finalize
- upgrade TLS and extract the server public key
- use `ActiveStage` and `DecodedImage`
- process `GraphicsUpdate` outputs into RGBA rectangles
- emit Tauri events for resolution, raw image rectangles, cursor updates, errors, and disconnects
- accept pointer, scancode, Unicode text, and Ctrl+Alt+Delete input commands

The frontend should add a dedicated canvas view, for example:

```text
frontend/src/components/KktermRdpCanvasView.tsx
```

The view should:

- listen for the copy engine's canvas events
- draw raw RGBA rectangles using 2D canvas `putImageData`
- map local pointer coordinates into remote desktop coordinates
- send text input through Unicode events
- send control/navigation keys through scancodes

This path should intentionally avoid NextDesk's current EGFX/H.264/WebGL/worker rendering pipeline.

## Frontend Routing

`RdpManager` should route sessions by engine mode:

- existing modes continue using existing code
- `kkterm-copy` on Windows uses the ActiveX backend
- `kkterm-copy` on macOS uses the simple canvas backend
- unsupported platforms should show a clear unsupported-engine error

Routing should be narrow and reversible. The new mode should not require changing existing tab data models.

## Dependency Notes

The Windows module needs additional `windows` crate features for GDI, COM, OLE, memory, clipboard, keyboard/mouse input, and window management.

The macOS module should prefer NextDesk's existing local IronRDP crates where practical. If KKTerm's exact crate versions or APIs differ, adapt the code to the local IronRDP API rather than downgrading NextDesk's dependency graph.

KKTerm is MIT licensed. Any copied source file or substantially copied block should retain a short attribution comment.

## Risks

- ActiveX is Windows-only and creates native HWND airspace issues.
- ActiveX overlays do not obey normal DOM z-index or clipping.
- macOS simple canvas may be slower than the existing advanced renderer.
- The copied macOS path may not support NextDesk's richer clipboard, audio, drive redirection, or proxy behavior initially.
- IronRDP API differences may require adaptation instead of byte-for-byte copy.

## Acceptance Criteria

- `kkterm-copy` is disabled by default.
- Existing RDP modes behave the same when `kkterm-copy` is not selected.
- Windows with `kkterm-copy` starts an RDP session through Microsoft RDP ActiveX.
- macOS with `kkterm-copy` starts an RDP session and renders RGBA updates to a 2D canvas.
- Basic mouse, keyboard, text input, reconnect, and close work in both enabled paths.
- Unsupported platforms return a clear error.
- Run targeted frontend checks and Rust checks before claiming completion.


# Drift Renderer Migration Plan

> Feature: migrate the proven `CREVIOS/drift-rdp` rendering approach into NextDesk as an experimental native-fast rendering path, while preserving the current stable IronRDP Web/WASM path as the default fallback.

## REQUIRED SUB-SKILL

Use `superpowers:executing-plans` when implementing this plan.

## Goal

NextDesk currently renders RDP through a WebView/canvas pipeline. It works, but user testing shows visible frame cutting and stutter compared with `ironrdp-desktop/ironrdpcli` and with the locally tested `CREVIOS/drift-rdp` project.

The goal is to migrate the useful parts of Drift's rendering architecture into NextDesk:

- dirty-rect frame transport with fewer redundant full-frame uploads
- Rust-side shared frame buffer with explicit dirty notification
- native GPU renderer prototype using `wgpu`
- final embedded display inside the existing NextDesk RDP display area, without popping a terminal or independent external window
- reversible rollout behind a profile flag until manual validation proves it is better than the current stable path

This plan must not remove the current working renderer. The existing renderer remains the production fallback until the new path passes the validation gates.

## Architecture

### Current NextDesk Path

```text
IronRDP native session
  -> src-tauri/src/rdp_session.rs
  -> src-tauri/src/frame_ws.rs
  -> frontend WebSocket
  -> frontend/src/components/RdpManager.tsx
  -> Canvas/WebGL in WebView
```

Strengths:

- already integrated with NextDesk tabs, UI, input, clipboard, audio, and file redirection
- already supports the current manual validation flow
- can be used as a fallback when experimental paths fail

Weaknesses:

- every frame still competes with the WebView/JS render loop
- frame packing and thumbnail/queue behavior can add pressure under motion
- production app and dev app can feel different due to scheduling/logging/runtime differences

### Drift Path To Reuse

```text
IronRDP graphics update
  -> batch dirty regions
  -> SharedFrame write guard
  -> mark dirty via Condvar
  -> render thread wakes
  -> wgpu texture upload
  -> present with low latency
```

Important audit result:

Drift is not a drop-in complete native embedded renderer. Its code still sends image update packets to a React canvas, and its `wgpu` renderer is attached at the Tauri window level. For NextDesk, the reusable value is the frame pacing, dirty-rect batching, shared frame model, and low-latency GPU renderer design. We still need an explicit embedded display-slot integration for NextDesk's RDP content area.

### Target NextDesk Path

```text
IronRDP native session
  -> dirty-rect batcher
  -> SharedFrame per tab
  -> NativeRenderView per active tab
  -> wgpu surface/texture presenter
  -> embedded inside current RDP display region

Fallback:
IronRDP native/WASM session
  -> existing frame_ws/canvas renderer
```

The migration is phased so that each stage can be validated independently:

1. Drift-style packet and queue optimization in the existing canvas renderer.
2. Rust `SharedFrame` integration with deterministic dirty updates.
3. Native `wgpu` render loop prototype.
4. Embedded display-area integration for macOS first, then Windows.
5. Rollout gate and fallback cleanup.

## Tech Stack

- NextDesk: Tauri 2, React 19, TypeScript, Vite 7
- Current RDP engine: local modified IronRDP crates under `../../IronRDP`
- Reference project: `CREVIOS/drift-rdp`
- Candidate native renderer: `wgpu`
- Existing frame transport: `src-tauri/src/frame_ws.rs`
- Existing frontend renderer: `frontend/src/components/RdpManager.tsx`
- Existing queue helper: `frontend/src/lib/native-frame-queue.ts`

## Constraints

- Preserve the current stable path as the default unless the user explicitly validates the new path.
- Do not switch to crates.io IronRDP. NextDesk must continue to use local `../../IronRDP` path crates.
- Keep clipboard, file redirection, audio, resize, and tab lifecycle behavior intact.
- Do not spawn a terminal or independent desktop window for RDP rendering.
- The final renderer must be embedded in the existing NextDesk RDP display area.
- macOS is the first target. Windows must remain buildable and must either use a guarded implementation or clean fallback.
- No feature is considered complete without manual visual validation on the user's RDP targets.

## Implementation Plan

### Task 1: Create An Experimental Renderer Profile

Add a dedicated profile instead of changing the existing default path.

Files:

- `frontend/src/rdp/engine-flags.ts`
- `frontend/src/components/RdpManager.tsx`
- `frontend/src/api.ts`
- `src-tauri/src/rdp_session.rs`

Behavior:

- Add a renderer mode named `native-drift` or `native-fast`.
- Keep the existing stable mode as default.
- Mode selection must be explicit through the existing engine flag mechanism or a development-only environment/profile flag.
- Logs must clearly show the selected route:

```text
[rdp.engine] mode=native-drift transport=dirty-rect renderer=canvas
```

Validation:

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend
npm run test -- rdp-engine-flags
```

Expected output:

```text
PASS src/test/rdp-engine-flags.test.ts
```

Acceptance:

- Existing default behavior remains unchanged.
- New mode can be selected for one connection without affecting other tabs.
- Reconnecting or closing a tab does not leak the profile to unrelated tabs.

### Task 2: Add Drift-Style Dirty Rect Frame Protocol

Introduce a packet format that can carry dirty rectangles without forcing every update into a full-frame packet.

Files:

- `src-tauri/src/rdp_frame.rs`
- `src-tauri/src/lib.rs`
- `frontend/src/lib/drift-frame-protocol.ts`
- `frontend/src/test/drift-frame-protocol.test.ts`

Rust packet shape:

```rust
pub enum NativeFrameKind {
    FullFrame = 1,
    DirtyRects = 2,
    H264 = 3,
}

pub struct DirtyRect<'a> {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
    pub stride: usize,
    pub rgba: &'a [u8],
}
```

Wire format:

```text
u8   kind
u16  surface_width
u16  surface_height
u16  rect_count
repeat rect_count:
  u16 x
  u16 y
  u16 width
  u16 height
  bytes rgba rows, width * height * 4
```

Frontend parser:

```ts
export type DriftFramePacket =
  | { kind: "full"; width: number; height: number; rgba: Uint8Array }
  | { kind: "dirty"; width: number; height: number; rects: DriftDirtyRect[] }
  | { kind: "h264"; width: number; height: number; payload: Uint8Array };

export function parseDriftFramePacket(bytes: Uint8Array): DriftFramePacket;
```

Validation:

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend
npm run test -- drift-frame-protocol
```

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri
cargo test rdp_frame
```

Expected output:

```text
PASS src/test/drift-frame-protocol.test.ts
test result: ok
```

Acceptance:

- Parser rejects truncated packets.
- Multiple dirty rects decode correctly.
- Rect row stride is respected.
- Full-frame packets still work.
- H.264 packets are parsed but not enabled as default rendering.

### Task 3: Compact Native Frame Queue For Dirty Rects

Update the frontend frame queue to keep the latest useful updates without accumulating stale intermediate packets.

Files:

- `frontend/src/lib/native-frame-queue.ts`
- `frontend/src/test/native-frame-queue.test.ts`
- `frontend/src/lib/drift-frame-protocol.ts`

Behavior:

- Existing raw-frame compaction remains supported.
- Drift dirty packets are compacted by surface size and update generation.
- Overflow drops stale packets, not the latest packet.
- Active tab rendering takes priority over inactive thumbnail generation.

Validation:

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend
npm run test -- native-frame-queue drift-frame-protocol
```

Expected output:

```text
PASS src/test/native-frame-queue.test.ts
PASS src/test/drift-frame-protocol.test.ts
```

Acceptance:

- Queue pressure does not grow while dragging windows.
- No periodic thumbnail capture runs unless grid view is opened.
- Dirty packets do not reorder across surface resize.

### Task 4: Wire Dirty Rect Packets Into Current Canvas Renderer

Before building a native surface, prove that Drift-style packetization improves the existing path.

Files:

- `src-tauri/src/rdp_session.rs`
- `src-tauri/src/frame_ws.rs`
- `frontend/src/components/RdpManager.tsx`
- `frontend/src/lib/drift-frame-protocol.ts`
- `frontend/src/lib/native-frame-queue.ts`

Behavior:

- In `native-drift` mode, the Rust session emits dirty-rect packets when IronRDP reports updated regions.
- The frontend applies dirty rects to an existing canvas backing buffer.
- The renderer uploads only the changed regions where possible. If the current WebGL path cannot partial-upload cleanly, keep a single backing buffer and redraw once per animation frame.
- Resize forces a full-frame reset.

Instrumentation:

```text
[rdp.render] mode=native-drift dirty_rects=12 bytes=184320 queue=1 dropped=4 fps=52
```

Validation:

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend
npm run build
```

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri
cargo check
```

Manual validation:

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk
npx tauri dev
```

User validates:

- connect to public RDP target
- drag Chrome window rapidly
- scroll page
- switch tabs
- open grid view and close grid view
- verify no black screen and no corrupted frame blocks

Acceptance:

- Visual output is at least as correct as the current default renderer.
- Dragging does not show worse tearing than the default renderer.
- Logs show reduced transferred bytes during dirty updates.
- The current stable renderer can still be selected and works.

### Task 5: Port Drift SharedFrame Into NextDesk

Add the Rust shared-frame buffer as a standalone internal component. This task does not yet make it visible as the primary renderer.

Files:

- `src-tauri/src/rdp_shared_frame.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/rdp_session.rs`

SharedFrame API:

```rust
pub struct SharedFrame;

impl SharedFrame {
    pub fn new(width: u32, height: u32) -> Self;
    pub fn resize(&self, width: u32, height: u32);
    pub fn begin_write(&self) -> SharedFrameWriteGuard<'_>;
    pub fn mark_dirty(&self);
    pub fn publish(&self) -> Option<FrameSnapshot>;
    pub fn wait_for_frame(&self, timeout: Duration) -> Option<FrameSnapshot>;
}
```

Behavior:

- One `SharedFrame` per native RDP tab.
- One write lock per graphics batch.
- Dirty rect writes update only changed rows.
- `publish()` swaps buffers and clears dirty state.
- Resize clears stale buffers and forces next frame to be complete.

Validation:

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri
cargo test rdp_shared_frame
```

Expected output:

```text
test result: ok
```

Acceptance:

- Dirty rect updates produce expected pixels.
- `wait_for_frame()` returns only after `mark_dirty()` or timeout.
- Resize invalidates old dimensions safely.
- Multiple writes before publish coalesce into one snapshot.

### Task 6: Add Native GPU Renderer Prototype

Add a `wgpu` renderer that consumes `SharedFrame` and renders to a native surface. Keep it experimental and guarded.

Files:

- `src-tauri/Cargo.toml`
- `src-tauri/src/rdp_gpu_renderer.rs`
- `src-tauri/src/rdp_shared_frame.rs`
- `src-tauri/src/lib.rs`

Dependency:

```toml
wgpu = "24"
raw-window-handle = "0.6"
```

Renderer behavior:

- One render thread for the experimental renderer.
- Wait on `SharedFrame::wait_for_frame(Duration::from_millis(100))`.
- Upload the latest snapshot to a GPU texture.
- Prefer low-latency present mode when supported.
- Log render FPS and upload time every 5 seconds in dev builds only.

Validation:

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri
cargo check
```

Manual validation:

- Start the renderer in hidden diagnostic mode.
- Confirm no crash on macOS.
- Confirm fallback renderer still displays frames.
- Confirm closing the RDP tab stops the render thread.

Acceptance:

- Renderer compiles on macOS.
- Windows build remains guarded and does not break `cargo check`.
- Render thread exits cleanly when the tab disconnects.
- GPU upload timing is visible in dev logs.

### Task 7: Embed Native Renderer Into NextDesk Display Area On macOS

This is the key task for the user's requirement: no terminal, no external window, fully embedded inside the current RDP display region.

Files:

- `src-tauri/src/rdp_native_view.rs`
- `src-tauri/src/rdp_gpu_renderer.rs`
- `src-tauri/src/lib.rs`
- `frontend/src/components/RdpManager.tsx`
- `frontend/src/api.ts`

Frontend sends display bounds:

```ts
await api.rdpNativeSetViewBounds(tabId, {
  x,
  y,
  width,
  height,
  scaleFactor: window.devicePixelRatio,
  visible,
});
```

Rust command:

```rust
#[tauri::command]
async fn rdp_native_set_view_bounds(
    tab_id: u32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale_factor: f64,
    visible: bool,
) -> Result<(), String>
```

macOS behavior:

- Create or attach a native child rendering surface aligned to the RDP content rectangle.
- Move/resize it when the React layout changes.
- Hide it when the tab is inactive or grid view is open.
- Keep the React canvas fallback underneath for recovery and screenshots.

Validation:

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk
npx tauri dev
```

Manual validation:

- active tab renders in the existing display area
- no detached window appears
- sidebar, tab bar, dialogs, and grid view remain clickable
- resizing the app keeps the native renderer aligned
- switching tabs hides/shows the correct renderer
- disconnecting a tab destroys its native surface

Acceptance:

- User can operate RDP exactly through existing NextDesk UI.
- Native surface never covers the sidebar or toolbar.
- The view does not stay visible after tab close.
- The old canvas renderer can be restored instantly through the mode flag.

### Task 8: Windows Guard And Compatibility Plan

Keep Windows compatible even if native embedded rendering lands on macOS first.

Files:

- `src-tauri/src/rdp_native_view.rs`
- `src-tauri/src/rdp_gpu_renderer.rs`
- `src-tauri/src/lib.rs`

Behavior:

- `#[cfg(target_os = "macos")]` enables the first native embedded implementation.
- `#[cfg(target_os = "windows")]` either implements HWND child-surface embedding or returns a clean unsupported status while falling back to canvas.
- `#[cfg(not(any(target_os = "macos", target_os = "windows")))]` returns unsupported and uses fallback.

Validation:

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri
cargo check
```

If Windows runner is available:

```powershell
npx tauri build --target x86_64-pc-windows-msvc
```

Acceptance:

- macOS implementation does not break Windows builds.
- Unsupported native renderer status is surfaced as a fallback event, not a crash.
- Windows-specific renderer work is isolated for later implementation.

### Task 9: Performance Profile And Comparison

Measure the current renderer, the Drift-style canvas path, and the native GPU path with the same actions.

Files:

- `src-tauri/src/logging.rs`
- `src-tauri/src/rdp_session.rs`
- `src-tauri/src/rdp_gpu_renderer.rs`
- `frontend/src/components/RdpManager.tsx`

Metrics:

- server frame/update rate
- encoded bytes per second
- WebSocket queue length
- dropped/stale frames
- canvas draw FPS
- native GPU upload time
- native GPU present FPS
- input-to-visible response during dragging, measured manually

Log sample:

```text
[rdp.perf] tab=1 mode=native-drift updates=58 fps=54 bytes=3.8MiB queue=0 dropped=7 upload_ms=1.4 present=mailbox
```

Validation:

Manual test matrix:

| Scenario | Current Stable | native-drift canvas | native-drift gpu |
|---|---:|---:|---:|
| idle desktop | record | record | record |
| drag Chrome window | record | record | record |
| scroll Chrome | record | record | record |
| switch tabs | record | record | record |
| grid view open | record | record | record |

Acceptance:

- New path has lower queue pressure than current stable path.
- New path does not introduce black screen, flower screen, or stale frame blocks.
- If native GPU path is not clearly better, do not promote it.

### Task 10: Rollout Gate And Fallback

Promote only after manual validation proves the new path is better.

Files:

- `frontend/src/rdp/engine-flags.ts`
- `frontend/src/components/RdpManager.tsx`
- `src-tauri/src/rdp_session.rs`
- `docs/superpowers/plans/2026-06-16-drift-renderer-migration.md`

Rollout stages:

1. Experimental hidden flag.
2. Developer profile selectable in code/config.
3. User manual validation on macOS public RDP and LAN RDP.
4. Default for macOS only if stable.
5. Windows remains fallback until separately validated.

Rollback:

- Disable `native-drift`.
- Keep stable renderer selected.
- Do not remove any working current path until one full release cycle has passed.

Validation:

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend
npm run build
```

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri
cargo check
```

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk
npx tauri dev
```

Acceptance:

- User confirms visual smoothness is equal to or better than Drift local test.
- User confirms current UI operation logic is unchanged.
- User confirms no external renderer window appears.
- Stable fallback still works after toggling back.

## Risk Register

### Risk: Drift's wgpu renderer is not already embedded

Impact:

- Copying Drift code directly will not satisfy the requirement.

Mitigation:

- Treat Drift as an architecture reference.
- Build a NextDesk-specific embedded native view layer.
- Validate native view alignment before promoting.

### Risk: Native surface z-order conflicts with WebView UI

Impact:

- Renderer may cover sidebar, tabs, dialogs, or grid view.

Mitigation:

- Native view bounds are driven by the RDP content rectangle only.
- Hide native renderer when dialogs/grid view/overlay UI is active.
- Keep canvas fallback underneath.

### Risk: Cross-platform native window handles diverge

Impact:

- macOS and Windows require different native embedding code.

Mitigation:

- Land macOS first behind cfg guards.
- Keep Windows fallback clean.
- Implement Windows HWND child view as a separate follow-up task.

### Risk: Dirty rect decoding causes artifacts

Impact:

- Black blocks, stale rectangles, or flower screen.

Mitigation:

- Keep full-frame reset on resize and reconnect.
- Add parser tests for truncated packets and row stride.
- Add a runtime fallback to request/send a full frame after decode error.

### Risk: Performance gains disappear in production build

Impact:

- User sees dev smoothness but release stutter.

Mitigation:

- Keep production RDP hot path logging disabled by default.
- Compare dev and release app with the same metrics.
- Avoid periodic thumbnail capture while grid view is closed.

## Verification Gate Before Any Merge Or Push

Run the targeted checks:

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/frontend
npm run test -- rdp-engine-flags drift-frame-protocol native-frame-queue
npm run build
```

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk/src-tauri
cargo test rdp_frame rdp_shared_frame
cargo check
```

Run manual validation:

```bash
cd /Users/yuu/Downloads/vibe_coding/rdp_project/NextDesk
npx tauri dev
```

Manual acceptance checklist:

- [ ] Public RDP target connects and renders.
- [ ] LAN RDP target connects and renders.
- [ ] Chrome window dragging is visually smoother or equal to Drift local test.
- [ ] No black screen.
- [ ] No flower screen.
- [ ] No detached renderer window.
- [ ] Existing tab bar, sidebar, dialogs, grid view, clipboard, file redirection, and audio still work.
- [ ] Closing a tab stops the RDP session and renderer.
- [ ] Fallback renderer can still be selected.

## Execution Order

- [x] Task 1: Create experimental renderer profile.
- [x] Task 2: Add Drift-style dirty rect frame protocol.
- [x] Task 3: Compact native frame queue for dirty rects.
- [x] Task 4: Wire dirty rect packets into current canvas renderer.
- [x] Task 5: Port Drift SharedFrame into NextDesk.
- [x] Task 6: Add native GPU renderer prototype.
- [ ] Task 7: Embed native renderer into NextDesk display area on macOS.
- [ ] Task 8: Add Windows guard and compatibility path.
- [ ] Task 9: Run performance profile and comparison.
- [ ] Task 10: Rollout gate and fallback decision.

## Progress Notes

### 2026-06-16

- Completed Task 1 by adding `native-drift` / `native-fast` aliases behind the existing experimental native gate.
- Completed Task 2 by adding Rust `rdp_frame` encoding helpers and frontend `drift-frame-protocol` parsing helpers.
- Completed Task 3 by extending native frame queue compaction to understand Drift full and dirty-rect packets.
- Completed Task 4 by making `native-drift` emit Drift dirty-rect packets from the native session and by teaching the existing WebGL canvas renderer to draw them.
- Completed Task 5 by adding a standalone Rust `SharedFrame` buffer with guarded writes, dirty notification, publish snapshots, resize invalidation, and targeted tests. It is not yet on the active hot path, so the current smooth `native-drift` canvas path remains unchanged.
- Completed Task 6 by adding a guarded headless `wgpu` upload prototype that consumes `SharedFrame` snapshots and uploads them into a GPU texture without creating a detached window or changing the active renderer. Task 7 will handle actual embedded native view integration.
- Continued Task 7 by adding the frontend-to-Rust `rdp_native_set_view_bounds` channel. React now reports the active `native-drift` RDP display rectangle on layout/visibility changes; Rust validates and caches those bounds per tab. A guarded macOS `with_webview` native host probe verifies the main `NSWindow` handle can be reached when the bounds are visible. Rust now also tracks a per-tab native host lifecycle state (`created`, `changed`, `visible`, `generation`, `prepared`) and clears it on tab disconnect. This still does not create a native child view, so the validated canvas renderer remains the visible path.
- Investigated a transient `tauri dev` linker failure in `tauri::resources::Resource::name` after concurrent test/check/dev builds. `cargo check` and standalone `cargo build --no-default-features` passed; cleaning the `nextdesk` package build artifacts with `cargo clean -p nextdesk` removed the inconsistent incremental state, and `tauri dev` launched successfully again.
- Started Task 10 rollout decision by promoting the user-validated `native-drift` canvas path to the temporary default renderer. `official-web` remains an explicit fallback through `nextdesk_rdp_engine=official-web`, `VITE_NEXTDESK_RDP_ENGINE=official-web`, or the native kill switch `nextdesk_experimental_native_rdp=0`.
- Verified:
  - `cd frontend && npm run test -- rdp-engine-flags drift-frame-protocol native-frame-queue`
  - `cd frontend && npm run build`
  - `cd src-tauri && cargo test rdp_frame`
  - `cd src-tauri && cargo test rdp_shared_frame`
  - `cd src-tauri && cargo test rdp_gpu_renderer`
  - `cd src-tauri && cargo test rdp_native_view`
  - `cd src-tauri && cargo check`
  - `cd src-tauri && cargo build --no-default-features`
- Manual `npx tauri dev` validation passed with `VITE_NEXTDESK_EXPERIMENTAL_NATIVE_RDP=1 VITE_NEXTDESK_RDP_ENGINE=native-drift npx tauri dev`; user confirmed the rendering path is very smooth.

## Recommended First Implementation Slice

Start with Tasks 1 to 4 only.

Reason:

- They reuse the current working display area and avoid native surface/z-order risk.
- They test whether Drift-style dirty rect batching alone reduces stutter.
- They create a safe baseline before adding `wgpu`.
- If Tasks 1 to 4 do not improve smoothness, the issue is less likely to be just WebSocket packet shape and more likely to require native `wgpu` embedding.

First slice acceptance:

- Current stable renderer remains default.
- Experimental mode connects and renders.
- Dirty rect packets are parsed and rendered correctly.
- User can compare smoothness against current stable path in `npx tauri dev`.

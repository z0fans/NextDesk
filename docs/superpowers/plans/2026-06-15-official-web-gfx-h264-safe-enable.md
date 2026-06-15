# Official Web GFX/H.264 Safe Enable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable an experimental official-web RDPGFX/H.264 path with codec diagnostics and automatic fallback to the current bitmap renderer.

**Architecture:** Keep bitmap rendering as the stable default. When the user opts into official-web GFX, register the IronRDP GFX dynamic channel, report negotiated codec events to the frontend, decode only H.264/AVC frames with WebCodecs, and reconnect without GFX if the server sends unsupported codecs or WebCodecs fails.

**Tech Stack:** Tauri 2, React 19, TypeScript/Vitest, IronRDP WASM, WebCodecs.

---

### Task 1: Feature Flag Contract

**Files:**
- Modify: `frontend/src/rdp/engine-flags.ts`
- Modify: `frontend/src/test/rdp-engine-flags.test.ts`

- [x] **Step 1: Write failing tests**

Add tests asserting that requested GFX is now allowed without the old unsafe force flag, while preserving an explicit force flag for manual override.

```ts
it('enables requested official-web GFX through the safe H.264 fallback path', () => {
  const flags = resolveOfficialWebFeatureFlags((storageKey, envKey) => {
    const values: Record<string, string> = {
      VITE_NEXTDESK_OFFICIAL_WEB_GFX: 'true',
    };
    return values[storageKey] ?? values[envKey] ?? null;
  });

  expect(flags.gfxRequested).toBe(true);
  expect(flags.gfx).toBe(true);
  expect(flags.gfxForce).toBe(false);
});

it('keeps force flag visible for diagnostics', () => {
  const flags = resolveOfficialWebFeatureFlags((storageKey, envKey) => {
    const values: Record<string, string> = {
      nextdesk_official_web_gfx: '1',
      VITE_NEXTDESK_OFFICIAL_WEB_GFX_FORCE: 'true',
    };
    return values[storageKey] ?? values[envKey] ?? null;
  });

  expect(flags.gfx).toBe(true);
  expect(flags.gfxRequested).toBe(true);
  expect(flags.gfxForce).toBe(true);
});
```

- [x] **Step 2: Verify red**

Run:

```bash
cd frontend && npm test -- src/test/rdp-engine-flags.test.ts
```

Expected: the first new test fails because current code requires `gfxRequested && gfxForce`.

- [x] **Step 3: Implement minimal flag change**

Add `gfxForce` to `OfficialWebFeatureFlags` and set `gfx` to `gfxRequested || gfxForce`.

- [x] **Step 4: Verify green**

Run the same test command. Expected: all `rdp-engine-flags` tests pass.

### Task 2: IronRDP WASM GFX Codec Diagnostics

**Files:**
- Modify: `../IronRDP/crates/ironrdp-web/src/gfx.rs`
- Modify: `../IronRDP/crates/ironrdp-web/src/session.rs`

- [x] **Step 1: Emit codec events for every WireToSurface1**

When `WasmGfxHandler` receives `WireToSurface1`, call JS with:

```text
gfx_codec
{
  surfaceId,
  codec,
  h264,
  dataLen,
  left,
  top,
  right,
  bottom
}
```

- [x] **Step 2: Emit unsupported codec events**

For non-H.264 codecs, call JS with:

```text
unsupported_codec
{
  surfaceId,
  codec,
  dataLen
}
```

Then return `None`; do not attempt to decode or draw unsupported codec bytes.

- [x] **Step 3: Keep existing H.264 frame event**

For `Avc420`, `Avc444`, and `Avc444v2`, keep sending `h264_frame` with the existing payload.

- [x] **Step 4: Add registration log**

When `GraphicsPipelineClient` is registered, log that official-web GFX is enabled and H.264-only rendering is guarded by JS fallback.

### Task 3: Frontend Fallback and H.264 Overlay Guard

**Files:**
- Modify: `frontend/src/components/RdpManager.tsx`

- [x] **Step 1: Add per-tab GFX fallback guard**

Track one fallback attempt per tab so an unsupported codec or WebCodecs failure reconnects once with GFX disabled for that tab/session.

- [x] **Step 2: Log diagnostics**

In `gfxCallback`, log `gfx_codec`, `unsupported_codec`, H.264 frame counts, and decode errors through `rdpLog`.

- [x] **Step 3: Reconnect without GFX on unsupported codec**

If `unsupported_codec` is received, disconnect that official-web session and reconnect with a per-tab override that disables GFX for the retry.

- [x] **Step 4: Reconnect without GFX on WebCodecs failure**

If the decode worker posts an `error`, log it and use the same fallback path.

- [x] **Step 5: Preserve bitmap default**

If GFX is not requested or fallback has tripped, keep the current bitmap canvas path unchanged.

### Task 4: Verification

**Files:**
- Test: `frontend/src/test/rdp-engine-flags.test.ts`
- Runtime logs: `/tmp/nextdesk_rdp_debug.log`

- [x] **Step 1: Run frontend tests**

```bash
cd frontend && npm test -- src/test/rdp-engine-flags.test.ts
```

- [x] **Step 2: Type-check or build if practical**

```bash
cd frontend && npm run build
```

- [x] **Step 3: Rebuild IronRDP WASM if Rust files changed**

```bash
cd ../IronRDP
wasm-pack build --target web crates/ironrdp-web
cp -r crates/ironrdp-web/pkg/* ../NextDesk/frontend/src/wasm/
```

- [x] **Step 4: Manual validation**

Start `npx tauri dev`, enable `nextdesk_official_web_gfx=1`, connect to `192.168.3.105`, and verify logs show one of:

```text
GFX codec h264 ... h264_frame ...
```

or:

```text
unsupported_codec ... reconnecting without GFX
official-web GFX disabled by fallback
```

Both outcomes are acceptable for this task; the first enables the smoother path, the second proves safe fallback instead of black screen.

### Verification Evidence

- `cd frontend && npm test -- src/test/rdp-gfx-fallback.test.ts src/test/rdp-engine-flags.test.ts` — 2 files, 13 tests passed.
- `cd frontend && npm run build` — TypeScript + Vite build passed with the existing wasm eval warning.
- `cd ../IronRDP && cargo fmt --package ironrdp-web -- --check` — passed; rustfmt reported existing stable-channel config warnings only.
- `cd ../IronRDP && wasm-pack build --target web crates/ironrdp-web` — completed and produced `crates/ironrdp-web/pkg`.
- Copied `crates/ironrdp-web/pkg/*` into `../NextDesk/frontend/src/wasm/`.
- Manual runtime validation: `nextdesk_official_web_gfx=1` + `nextdesk_official_web_gfx_force=1` registered GFX, both tested hosts emitted `clearcodec`, and the client reconnected with `gfxDisabledByFallback=true`. The visible desktop came from the bitmap fallback path, which is the expected safe outcome for unsupported codecs.

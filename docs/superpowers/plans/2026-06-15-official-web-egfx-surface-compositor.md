# Official Web EGFX Surface Compositor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the forced-GFX rendering path by adding an EGFX surface compositor that correctly renders ClearCodec, uncompressed, and future AVC420/H.264 updates without destabilizing the stable bitmap profile.

**Architecture:** Keep the stable official-web profile on `GFX=0` until this plan passes visual and idle gates. The Rust/WASM side emits protocol-accurate EGFX events and decoded pixel updates; the frontend owns a per-tab compositor that maintains surfaces, mapped output positions, frame lifecycle, and cache/copy operations. Start with a main-thread Canvas2D compositor for correctness, then move the same event contract to an OffscreenCanvas worker/WebGL path for smoothness.

**Tech Stack:** Tauri 2, React 19, TypeScript/Vitest, IronRDP `ironrdp-web` + `ironrdp-egfx` + `ironrdp-graphics`, WebCodecs, Canvas2D, optional OffscreenCanvas/WebGL.

---

## Current Evidence

- Stable profile passed 30 minute idle with `GFX=0`.
- Forced GFX connects and registers `rdpgfx`.
- Tested targets selected ClearCodec, not AVC420/H.264.
- ClearCodec frames decode and emit RGBA patches.
- Manual forced-GFX visual gate fails with block artifacts because patches are drawn directly to the output canvas instead of through an EGFX surface model.
- After rebuilding the reverted WASM, ClearCodec patch dimensions match EGFX canvas-exclusive rectangles, but manual validation still shows stale black/block regions. Current hypothesis is frontend compositor output/copy semantics, not ClearCodec coordinate expansion.

Reference materials:

- FreeRDP RDPGFX model: https://freerdp-freerdp.mintlify.app/concepts/codecs
- FreeRDP GFX client implementation: https://github.com/FreeRDP/FreeRDP/blob/master/channels/rdpgfx/client/rdpgfx_main.c
- FreeRDP codec dispatch: https://github.com/FreeRDP/FreeRDP/blob/master/channels/rdpgfx/client/rdpgfx_codec.c
- IronRDP upstream: https://github.com/Devolutions/IronRDP
- Web compositor reference candidate: https://github.com/qxsch/freerdp-web

## Target File Structure

- Create `frontend/src/rdp/gfx-types.ts`
  - Defines normalized EGFX event and rectangle types used by the frontend.
- Create `frontend/src/rdp/gfx-compositor.ts`
  - Owns surfaces, surface mappings, frame lifecycle, drawing, cache, and commit behavior.
- Create `frontend/src/rdp/gfx-compositor.test.ts`
  - Unit tests for surface creation, ClearCodec patch placement, output mapping, copy, cache, and reset.
- Modify `frontend/src/lib/decode-worker.ts`
  - Preserve `surfaceId` with pending H.264 frame metadata.
- Modify `frontend/src/lib/h264-overlay.ts`
  - Keep only generic draw helpers or replace direct overlay calls with compositor calls.
- Modify `frontend/src/components/RdpManager.tsx`
  - Route all GFX callback events through the compositor.
- Modify `../IronRDP/crates/ironrdp-web/src/gfx.rs`
  - Emit normalized events for EGFX operations not currently surfaced to JS.
- Modify `../IronRDP/crates/ironrdp-egfx/src/client.rs`
  - Port or align missing upstream EGFX client behavior where it reduces custom web-only logic.
- Update `docs/rdp/ironrdp-kernel-baseline.md`
  - Add forced-GFX compositor validation matrix and final stability gate.
- Update `docs/ironrdp-nextdesk-patches.md`
  - Record which EGFX/Web rendering pieces are upstream-aligned and which remain NextDesk-specific adapters.

## Non-Goals

- Do not enable forced GFX in the stable profile until the visual gate passes.
- Do not replace IronRDP with FreeRDP.
- Do not require H.264 negotiation for this plan to pass; ClearCodec correctness is the current primary path.
- Do not implement RAIL window composition in the first pass.
- Do not remove the stable bitmap canvas fallback.

---

### Task 1: Define the Frontend EGFX Event Contract

**Files:**
- Create: `frontend/src/rdp/gfx-types.ts`
- Test: `frontend/src/rdp/gfx-compositor.test.ts`

- [x] **Step 1: Create shared EGFX types**

Add `frontend/src/rdp/gfx-types.ts`:

```ts
export type GfxSurfaceId = number;
export type GfxFrameId = number;

export interface GfxRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface GfxPoint {
  x: number;
  y: number;
}

export interface GfxSize {
  width: number;
  height: number;
}

export interface GfxRgbaPatch {
  surfaceId: GfxSurfaceId;
  rect: GfxRect;
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

export interface GfxH264Frame {
  surfaceId: GfxSurfaceId;
  rect: GfxRect;
  frame: VideoFrame;
}

export type GfxEvent =
  | { type: 'reset_graphics'; width: number; height: number }
  | { type: 'create_surface'; surfaceId: GfxSurfaceId; width: number; height: number }
  | { type: 'delete_surface'; surfaceId: GfxSurfaceId }
  | { type: 'map_surface'; surfaceId: GfxSurfaceId; x: number; y: number }
  | { type: 'unmap_surface'; surfaceId: GfxSurfaceId }
  | { type: 'start_frame'; frameId: GfxFrameId }
  | { type: 'end_frame'; frameId: GfxFrameId }
  | { type: 'clearcodec_rgba_patch'; patch: GfxRgbaPatch }
  | { type: 'h264_frame'; frame: GfxH264Frame }
  | { type: 'solid_fill'; surfaceId: GfxSurfaceId; rect: GfxRect; color: number }
  | { type: 'surface_to_surface'; srcSurfaceId: GfxSurfaceId; dstSurfaceId: GfxSurfaceId; srcRect: GfxRect; dst: GfxPoint }
  | { type: 'surface_to_cache'; surfaceId: GfxSurfaceId; cacheSlot: number; rect: GfxRect }
  | { type: 'cache_to_surface'; surfaceId: GfxSurfaceId; cacheSlot: number; dst: GfxPoint }
  | { type: 'evict_cache'; cacheSlot: number };

export function rectWidth(rect: GfxRect): number {
  return Math.max(0, rect.right - rect.left);
}

export function rectHeight(rect: GfxRect): number {
  return Math.max(0, rect.bottom - rect.top);
}

export function isValidRect(rect: GfxRect): boolean {
  return rectWidth(rect) > 0 && rectHeight(rect) > 0;
}
```

- [x] **Step 2: Add a compile-only import test**

Append to `frontend/src/rdp/gfx-compositor.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isValidRect, rectHeight, rectWidth } from './gfx-types';

describe('gfx-types', () => {
  it('treats EGFX rectangles as exclusive right/bottom coordinates', () => {
    const rect = { left: 10, top: 20, right: 42, bottom: 52 };

    expect(rectWidth(rect)).toBe(32);
    expect(rectHeight(rect)).toBe(32);
    expect(isValidRect(rect)).toBe(true);
  });
});
```

- [x] **Step 3: Run the type test**

Run:

```bash
cd frontend && npm run test -- src/rdp/gfx-compositor.test.ts
```

Expected: PASS for `gfx-types`.

---

### Task 2: Implement a Correct Canvas2D Surface Compositor

**Files:**
- Create: `frontend/src/rdp/gfx-compositor.ts`
- Modify: `frontend/src/rdp/gfx-compositor.test.ts`

- [x] **Step 1: Write failing compositor tests**

Replace `frontend/src/rdp/gfx-compositor.test.ts` with:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GfxSurfaceCompositor } from './gfx-compositor';
import { isValidRect, rectHeight, rectWidth } from './gfx-types';

function makeCanvas(width = 300, height = 200): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d');
  return canvas;
}

function rgba(width: number, height: number, r: number, g: number, b: number, a = 255): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = a;
  }
  return out;
}

describe('gfx-types', () => {
  it('treats EGFX rectangles as exclusive right/bottom coordinates', () => {
    const rect = { left: 10, top: 20, right: 42, bottom: 52 };

    expect(rectWidth(rect)).toBe(32);
    expect(rectHeight(rect)).toBe(32);
    expect(isValidRect(rect)).toBe(true);
  });
});

describe('GfxSurfaceCompositor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a mapped surface and commits it at the mapped output origin', () => {
    const output = makeCanvas(120, 80);
    const outputCtx = output.getContext('2d')!;
    const drawSpy = vi.spyOn(outputCtx, 'drawImage');
    const compositor = new GfxSurfaceCompositor(output);

    compositor.resetGraphics(120, 80);
    compositor.createSurface(1, 64, 64);
    compositor.mapSurface(1, 16, 8);
    compositor.drawRgbaPatch({
      surfaceId: 1,
      rect: { left: 0, top: 0, right: 32, bottom: 32 },
      width: 32,
      height: 32,
      data: rgba(32, 32, 255, 0, 0),
    });
    compositor.endFrame(1);

    expect(drawSpy).toHaveBeenCalledWith(expect.any(HTMLCanvasElement), 16, 8);
  });

  it('places ClearCodec patches relative to the target surface, not directly on output', () => {
    const output = makeCanvas(200, 100);
    const compositor = new GfxSurfaceCompositor(output);

    compositor.createSurface(7, 100, 100);
    compositor.mapSurface(7, 50, 10);
    compositor.drawRgbaPatch({
      surfaceId: 7,
      rect: { left: 10, top: 20, right: 12, bottom: 22 },
      width: 2,
      height: 2,
      data: rgba(2, 2, 0, 255, 0),
    });
    compositor.endFrame(1);

    const pixel = output.getContext('2d')!.getImageData(60, 30, 1, 1).data;
    expect(Array.from(pixel)).toEqual([0, 255, 0, 255]);
  });

  it('supports surface-to-surface copies before frame commit', () => {
    const output = makeCanvas(200, 100);
    const compositor = new GfxSurfaceCompositor(output);

    compositor.createSurface(1, 64, 64);
    compositor.createSurface(2, 64, 64);
    compositor.mapSurface(2, 20, 20);
    compositor.drawRgbaPatch({
      surfaceId: 1,
      rect: { left: 0, top: 0, right: 8, bottom: 8 },
      width: 8,
      height: 8,
      data: rgba(8, 8, 0, 0, 255),
    });
    compositor.surfaceToSurface(1, 2, { left: 0, top: 0, right: 8, bottom: 8 }, { x: 4, y: 4 });
    compositor.endFrame(2);

    const pixel = output.getContext('2d')!.getImageData(24, 24, 1, 1).data;
    expect(Array.from(pixel)).toEqual([0, 0, 255, 255]);
  });

  it('clears stale state on resetGraphics', () => {
    const output = makeCanvas(100, 100);
    const compositor = new GfxSurfaceCompositor(output);

    compositor.createSurface(1, 10, 10);
    compositor.mapSurface(1, 0, 0);
    compositor.resetGraphics(320, 240);

    expect(output.width).toBe(320);
    expect(output.height).toBe(240);
    expect(compositor.surfaceCount()).toBe(0);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run:

```bash
cd frontend && npm run test -- src/rdp/gfx-compositor.test.ts
```

Expected: FAIL because `./gfx-compositor` does not exist.

- [x] **Step 3: Implement compositor**

Create `frontend/src/rdp/gfx-compositor.ts`:

```ts
import type { GfxPoint, GfxRect, GfxRgbaPatch } from './gfx-types';
import { isValidRect, rectHeight, rectWidth } from './gfx-types';

type SurfaceRecord = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
};

type CacheRecord = {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
};

export class GfxSurfaceCompositor {
  private readonly output: HTMLCanvasElement;
  private readonly outputCtx: CanvasRenderingContext2D;
  private readonly surfaces = new Map<number, SurfaceRecord>();
  private readonly mappings = new Map<number, GfxPoint>();
  private readonly cache = new Map<number, CacheRecord>();

  constructor(output: HTMLCanvasElement) {
    const outputCtx = output.getContext('2d');
    if (!outputCtx) {
      throw new Error('GFX output canvas 2D context unavailable');
    }
    this.output = output;
    this.outputCtx = outputCtx;
  }

  resetGraphics(width: number, height: number) {
    this.output.width = Math.max(1, width);
    this.output.height = Math.max(1, height);
    this.outputCtx.clearRect(0, 0, this.output.width, this.output.height);
    this.surfaces.clear();
    this.mappings.clear();
    this.cache.clear();
  }

  createSurface(surfaceId: number, width: number, height: number) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error(`GFX surface ${surfaceId} 2D context unavailable`);
    }
    this.surfaces.set(surfaceId, { canvas, ctx, width: canvas.width, height: canvas.height });
  }

  deleteSurface(surfaceId: number) {
    this.surfaces.delete(surfaceId);
    this.mappings.delete(surfaceId);
  }

  mapSurface(surfaceId: number, x: number, y: number) {
    this.mappings.set(surfaceId, { x, y });
  }

  unmapSurface(surfaceId: number) {
    this.mappings.delete(surfaceId);
  }

  drawRgbaPatch(patch: GfxRgbaPatch) {
    const surface = this.surfaces.get(patch.surfaceId);
    if (!surface || patch.width <= 0 || patch.height <= 0 || !isValidRect(patch.rect)) return;

    const data = patch.data instanceof Uint8ClampedArray
      ? patch.data
      : new Uint8ClampedArray(patch.data.buffer, patch.data.byteOffset, patch.data.byteLength);
    const imageData = new ImageData(new Uint8ClampedArray(data), patch.width, patch.height);
    surface.ctx.putImageData(imageData, patch.rect.left, patch.rect.top);
  }

  drawVideoFrame(surfaceId: number, frame: VideoFrame, rect: GfxRect) {
    const surface = this.surfaces.get(surfaceId);
    if (!surface || !isValidRect(rect)) return;
    surface.ctx.drawImage(frame, rect.left, rect.top, rectWidth(rect), rectHeight(rect));
  }

  solidFill(surfaceId: number, rect: GfxRect, color: number) {
    const surface = this.surfaces.get(surfaceId);
    if (!surface || !isValidRect(rect)) return;
    const r = color & 0xff;
    const g = (color >> 8) & 0xff;
    const b = (color >> 16) & 0xff;
    const a = (color >> 24) & 0xff || 255;
    surface.ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a / 255})`;
    surface.ctx.fillRect(rect.left, rect.top, rectWidth(rect), rectHeight(rect));
  }

  surfaceToSurface(srcSurfaceId: number, dstSurfaceId: number, srcRect: GfxRect, dst: GfxPoint) {
    const src = this.surfaces.get(srcSurfaceId);
    const dstSurface = this.surfaces.get(dstSurfaceId);
    if (!src || !dstSurface || !isValidRect(srcRect)) return;
    dstSurface.ctx.drawImage(
      src.canvas,
      srcRect.left,
      srcRect.top,
      rectWidth(srcRect),
      rectHeight(srcRect),
      dst.x,
      dst.y,
      rectWidth(srcRect),
      rectHeight(srcRect),
    );
  }

  surfaceToCache(surfaceId: number, cacheSlot: number, rect: GfxRect) {
    const surface = this.surfaces.get(surfaceId);
    if (!surface || !isValidRect(rect)) return;
    const canvas = document.createElement('canvas');
    canvas.width = rectWidth(rect);
    canvas.height = rectHeight(rect);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(surface.canvas, rect.left, rect.top, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    this.cache.set(cacheSlot, { canvas, width: canvas.width, height: canvas.height });
  }

  cacheToSurface(surfaceId: number, cacheSlot: number, dst: GfxPoint) {
    const surface = this.surfaces.get(surfaceId);
    const cached = this.cache.get(cacheSlot);
    if (!surface || !cached) return;
    surface.ctx.drawImage(cached.canvas, dst.x, dst.y);
  }

  evictCache(cacheSlot: number) {
    this.cache.delete(cacheSlot);
  }

  endFrame(_frameId: number) {
    this.commit();
  }

  commit() {
    this.outputCtx.clearRect(0, 0, this.output.width, this.output.height);
    for (const [surfaceId, point] of this.mappings) {
      const surface = this.surfaces.get(surfaceId);
      if (surface) {
        this.outputCtx.drawImage(surface.canvas, point.x, point.y);
      }
    }
  }

  surfaceCount(): number {
    return this.surfaces.size;
  }
}
```

- [x] **Step 4: Run compositor tests**

Run:

```bash
cd frontend && npm run test -- src/rdp/gfx-compositor.test.ts
```

Expected: PASS.

---

### Task 3: Route Current ClearCodec Events Through the Compositor

**Files:**
- Modify: `frontend/src/components/RdpManager.tsx`
- Modify: `frontend/src/lib/h264-overlay.ts`
- Test: `frontend/src/rdp/gfx-compositor.test.ts`

- [x] **Step 1: Add compositor refs to `RdpManager.tsx`**

Near the existing RDP refs in `RdpManager.tsx`, add:

```ts
import { GfxSurfaceCompositor } from '@/rdp/gfx-compositor';
```

Then add:

```ts
const gfxCompositorRefs = useRef<Map<string, GfxSurfaceCompositor>>(new Map());
```

- [x] **Step 2: Initialize compositor when GFX is enabled**

Inside the official-web GFX setup block, after the overlay canvas is available:

```ts
const overlay = h264OverlayRefs.current.get(tabId);
if (overlay) {
  gfxCompositorRefs.current.set(tabId, new GfxSurfaceCompositor(overlay));
}
```

- [x] **Step 3: Route surface lifecycle events**

Inside `gfxCallback`, before codec-specific handling:

```ts
const compositor = gfxCompositorRefs.current.get(tabId);

if (type === 'reset_graphics' && compositor) {
  compositor.resetGraphics(Number(data?.width || 1), Number(data?.height || 1));
  return;
}

if (type === 'create_surface' && compositor) {
  compositor.createSurface(Number(data?.surfaceId), Number(data?.width || 1), Number(data?.height || 1));
  return;
}

if (type === 'delete_surface' && compositor) {
  compositor.deleteSurface(Number(data?.surfaceId));
  return;
}

if (type === 'map_surface' && compositor) {
  compositor.mapSurface(Number(data?.surfaceId), Number(data?.x || 0), Number(data?.y || 0));
  return;
}

if (type === 'end_frame' && compositor) {
  compositor.endFrame(Number(data || data?.frameId || 0));
  return;
}
```

- [x] **Step 4: Replace direct ClearCodec overlay drawing**

Change `clearcodec_rgba_patch` handling from direct `drawRgbaPatchToOverlay(...)` to:

```ts
if (type === 'clearcodec_rgba_patch') {
  const compositor = gfxCompositorRefs.current.get(tabId);
  if (compositor && data?.data && data?.width > 0 && data?.height > 0) {
    compositor.drawRgbaPatch({
      surfaceId: Number(data.surfaceId),
      rect: {
        left: Number(data.left ?? 0),
        top: Number(data.top ?? 0),
        right: Number(data.right ?? data.width ?? 0),
        bottom: Number(data.bottom ?? data.height ?? 0),
      },
      width: Number(data.width),
      height: Number(data.height),
      data: data.data,
    });
  }

  const patchCount = (officialWebClearCodecPatchCountRef.current.get(tabId) ?? 0) + 1;
  officialWebClearCodecPatchCountRef.current.set(tabId, patchCount);
  if (patchCount <= 3 || patchCount % 60 === 0) {
    rdpLog.info('render', 'official-web ClearCodec RGBA patch', {
      tabId,
      patchCount,
      codec,
      surfaceId: data?.surfaceId,
      width: data?.width,
      height: data?.height,
      bytes: data?.data?.byteLength,
      rect: {
        left: data?.left,
        top: data?.top,
        right: data?.right,
        bottom: data?.bottom,
      },
    });
  }
  return;
}
```

- [x] **Step 5: Run targeted frontend tests**

Run:

```bash
cd frontend && npm run test -- src/rdp/gfx-compositor.test.ts src/test/rdp-gfx-fallback.test.ts src/test/rdp-engine-flags.test.ts
```

Expected: PASS.

---

### Task 4: Preserve Surface Metadata for H.264 Frames

**Files:**
- Modify: `frontend/src/lib/decode-worker.ts`
- Modify: `frontend/src/components/RdpManager.tsx`
- Test: `frontend/src/rdp/gfx-compositor.test.ts`

- [x] **Step 1: Extend pending H.264 metadata**

In `frontend/src/lib/decode-worker.ts`, replace:

```ts
type PendingRect = { left: number; top: number; right: number; bottom: number } | undefined;
const pendingRects: PendingRect[] = [];
```

with:

```ts
type PendingFrameMeta = {
  surfaceId: number;
  rect: { left: number; top: number; right: number; bottom: number };
} | undefined;
const pendingFrames: PendingFrameMeta[] = [];
```

- [x] **Step 2: Post surface metadata with decoded frames**

Replace the worker `output` callback body with:

```ts
const meta = pendingFrames.shift();
self.postMessage({ type: 'frame', frame, surfaceId: meta?.surfaceId, rect: meta?.rect }, [frame] as any);
```

Replace `pendingRects.push(msg.rect)` with:

```ts
pendingFrames.push({ surfaceId: Number(msg.surfaceId ?? 0), rect: msg.rect });
```

Replace each `pendingRects` reference with `pendingFrames`.

- [x] **Step 3: Draw decoded H.264 into the compositor surface**

In `RdpManager.tsx` worker `onmessage`, replace direct overlay drawing with:

```ts
if (msg.type === 'frame') {
  const frame = msg.frame as VideoFrame;
  const compositor = gfxCompositorRefs.current.get(tabId);
  if (compositor && msg.rect) {
    compositor.drawVideoFrame(Number(msg.surfaceId ?? 0), frame, msg.rect);
  } else {
    const overlay = h264OverlayRefs.current.get(tabId);
    if (overlay) {
      drawDecodedH264FrameToOverlay(overlay, frame, msg.rect);
    }
  }
  frame.close();
}
```

- [x] **Step 4: Send `surfaceId` into the worker**

In the `h264_frame` handler, include:

```ts
surfaceId: Number(data.surfaceId ?? 0),
```

in the `postMessage` payload.

- [x] **Step 5: Run targeted tests and build**

Run:

```bash
cd frontend && npm run test -- src/rdp/gfx-compositor.test.ts src/test/rdp-gfx-fallback.test.ts
cd frontend && npm run build
```

Expected: tests PASS and build PASS with only the existing wasm eval warning.

---

### Task 5: Emit Missing EGFX Operations From IronRDP Web

**Files:**
- Modify: `../IronRDP/crates/ironrdp-web/src/gfx.rs`
- Test: `../IronRDP/crates/ironrdp-egfx/src/client.rs` if operation helpers are added there

- [x] **Step 1: Add JS emitters for surface operations**

In `../IronRDP/crates/ironrdp-web/src/gfx.rs`, extend `handle_pdu` to emit:

```rust
GfxPdu::SolidFill(pdu) => {
    for rect in &pdu.rectangles {
        let obj = js_sys::Object::new();
        let _ = js_sys::Reflect::set(&obj, &"surfaceId".into(), &pdu.surface_id.into());
        let _ = js_sys::Reflect::set(&obj, &"left".into(), &rect.left.into());
        let _ = js_sys::Reflect::set(&obj, &"top".into(), &rect.top.into());
        let _ = js_sys::Reflect::set(&obj, &"right".into(), &rect.right.into());
        let _ = js_sys::Reflect::set(&obj, &"bottom".into(), &rect.bottom.into());
        let _ = js_sys::Reflect::set(&obj, &"color".into(), &color_to_rgba_u32(&pdu.fill_pixel).into());
        self.call_js("solid_fill", &obj.into());
    }
}
```

If `Color` has no `From<Color> for u32`, add a local conversion helper:

```rust
fn color_to_rgba_u32(color: &ironrdp_egfx::pdu::Color) -> u32 {
    u32::from(color.r)
        | (u32::from(color.g) << 8)
        | (u32::from(color.b) << 16)
        | (u32::from(color.xa) << 24)
}
```

- [x] **Step 2: Emit `surface_to_surface`**

Add:

```rust
GfxPdu::SurfaceToSurface(pdu) => {
    for dest in &pdu.destination_points {
        let obj = js_sys::Object::new();
        let _ = js_sys::Reflect::set(&obj, &"srcSurfaceId".into(), &pdu.source_surface_id.into());
        let _ = js_sys::Reflect::set(&obj, &"dstSurfaceId".into(), &pdu.destination_surface_id.into());
        let _ = js_sys::Reflect::set(&obj, &"srcLeft".into(), &pdu.source_rectangle.left.into());
        let _ = js_sys::Reflect::set(&obj, &"srcTop".into(), &pdu.source_rectangle.top.into());
        let _ = js_sys::Reflect::set(&obj, &"srcRight".into(), &pdu.source_rectangle.right.into());
        let _ = js_sys::Reflect::set(&obj, &"srcBottom".into(), &pdu.source_rectangle.bottom.into());
        let _ = js_sys::Reflect::set(&obj, &"dstX".into(), &dest.x.into());
        let _ = js_sys::Reflect::set(&obj, &"dstY".into(), &dest.y.into());
        self.call_js("surface_to_surface", &obj.into());
    }
}
```

- [x] **Step 3: Emit cache operations**

Add:

```rust
GfxPdu::SurfaceToCache(pdu) => {
    let obj = js_sys::Object::new();
    let _ = js_sys::Reflect::set(&obj, &"surfaceId".into(), &pdu.surface_id.into());
    let _ = js_sys::Reflect::set(&obj, &"cacheSlot".into(), &pdu.cache_slot.into());
    let _ = js_sys::Reflect::set(&obj, &"cacheKey".into(), &pdu.cache_key.to_string().into());
    let _ = js_sys::Reflect::set(&obj, &"left".into(), &pdu.source_rectangle.left.into());
    let _ = js_sys::Reflect::set(&obj, &"top".into(), &pdu.source_rectangle.top.into());
    let _ = js_sys::Reflect::set(&obj, &"right".into(), &pdu.source_rectangle.right.into());
    let _ = js_sys::Reflect::set(&obj, &"bottom".into(), &pdu.source_rectangle.bottom.into());
    self.call_js("surface_to_cache", &obj.into());
}

GfxPdu::CacheToSurface(pdu) => {
    for dest in &pdu.destination_points {
        let obj = js_sys::Object::new();
        let _ = js_sys::Reflect::set(&obj, &"surfaceId".into(), &pdu.surface_id.into());
        let _ = js_sys::Reflect::set(&obj, &"cacheSlot".into(), &pdu.cache_slot.into());
        let _ = js_sys::Reflect::set(&obj, &"dstX".into(), &dest.x.into());
        let _ = js_sys::Reflect::set(&obj, &"dstY".into(), &dest.y.into());
        self.call_js("cache_to_surface", &obj.into());
    }
}

GfxPdu::EvictCacheEntry(pdu) => {
    let obj = js_sys::Object::new();
    let _ = js_sys::Reflect::set(&obj, &"cacheSlot".into(), &pdu.cache_slot.into());
    self.call_js("evict_cache", &obj.into());
}
```

Each event must include the numeric `cacheSlot`, source surface ID, rectangle, and destination point fields.

- [x] **Step 4: Check Rust WASM build**

Run:

```bash
cd ../IronRDP
export PATH="$HOME/.cargo/bin:$PATH"
cargo check -p ironrdp-web --target wasm32-unknown-unknown
```

Expected: exit 0. Existing warnings are acceptable; new `gfx.rs` warnings are not.

---

### Task 6: Wire Missing EGFX Operations Into the Frontend Compositor

**Files:**
- Modify: `frontend/src/components/RdpManager.tsx`
- Modify: `frontend/src/rdp/gfx-compositor.ts`
- Modify: `frontend/src/rdp/gfx-compositor.test.ts`

- [x] **Step 1: Handle `solid_fill`**

Add to `gfxCallback`:

```ts
if (type === 'solid_fill' && compositor) {
  compositor.solidFill(Number(data.surfaceId), {
    left: Number(data.left ?? 0),
    top: Number(data.top ?? 0),
    right: Number(data.right ?? 0),
    bottom: Number(data.bottom ?? 0),
  }, Number(data.color ?? 0xffffffff));
  return;
}
```

- [x] **Step 2: Handle `surface_to_surface`**

Add:

```ts
if (type === 'surface_to_surface' && compositor) {
  compositor.surfaceToSurface(
    Number(data.srcSurfaceId),
    Number(data.dstSurfaceId),
    {
      left: Number(data.srcLeft ?? 0),
      top: Number(data.srcTop ?? 0),
      right: Number(data.srcRight ?? 0),
      bottom: Number(data.srcBottom ?? 0),
    },
    { x: Number(data.dstX ?? 0), y: Number(data.dstY ?? 0) },
  );
  return;
}
```

- [x] **Step 3: Handle cache operations**

Add:

```ts
if (type === 'surface_to_cache' && compositor) {
  compositor.surfaceToCache(Number(data.surfaceId), Number(data.cacheSlot), {
    left: Number(data.left ?? 0),
    top: Number(data.top ?? 0),
    right: Number(data.right ?? 0),
    bottom: Number(data.bottom ?? 0),
  });
  return;
}

if (type === 'cache_to_surface' && compositor) {
  compositor.cacheToSurface(Number(data.surfaceId), Number(data.cacheSlot), {
    x: Number(data.dstX ?? 0),
    y: Number(data.dstY ?? 0),
  });
  return;
}

if (type === 'evict_cache' && compositor) {
  compositor.evictCache(Number(data.cacheSlot));
  return;
}
```

- [x] **Step 4: Run frontend tests**

Run:

```bash
cd frontend && npm run test -- src/rdp/gfx-compositor.test.ts src/test/rdp-engine-flags.test.ts src/test/rdp-gfx-fallback.test.ts
```

Expected: PASS.

---

### Task 7: Rebuild WASM and Validate Forced-GFX Smoke

**Files:**
- Generated: `frontend/src/wasm/*`
- Update: `docs/rdp/ironrdp-kernel-baseline.md`

- [x] **Step 1: Rebuild IronRDP Web WASM**

Run:

```bash
cd ../IronRDP
export PATH="$HOME/.cargo/bin:$PATH"
wasm-pack build --target web crates/ironrdp-web
cp -r crates/ironrdp-web/pkg/* ../NextDesk/frontend/src/wasm/
```

Expected: `Your wasm pkg is ready`.

- [x] **Step 2: Run frontend build**

Run:

```bash
cd frontend && npm run build
```

Expected: PASS with only the existing wasm eval warning.

- [x] **Step 3: Start forced-GFX validation profile**

Run from repo root:

```bash
VITE_NEXTDESK_RDP_ENGINE=official-web \
VITE_NEXTDESK_EXPERIMENTAL_NATIVE_RDP=0 \
VITE_NEXTDESK_OFFICIAL_WEB_GFX=1 \
VITE_NEXTDESK_OFFICIAL_WEB_GFX_FORCE=1 \
VITE_NEXTDESK_OFFICIAL_WEB_AUDIO=0 \
VITE_NEXTDESK_OFFICIAL_WEB_FILE_TRANSFER=0 \
VITE_NEXTDESK_OFFICIAL_WEB_DISPLAY_CONTROL=1 \
PATH="$HOME/.cargo/bin:$PATH" \
npx tauri dev
```

- [ ] **Step 4: Manual validation**

Connect to:

```text
192.168.3.105:3389
64.20.10.254:3389
```

Expected:

```text
RDP desktop visible
No black canvas
No flower screen/block artifacts after idle desktop load
Window drag leaves no stale tile blocks after frame commit
```

Observed on 2026-06-15 15:50 Asia/Shanghai:

```text
Manual validation failed.
Both targets rendered visible block artifacts.
Log evidence showed ClearCodec/cache operations were present and bad=0, but the active server path emitted no StartFrame/EndFrame PDU logs.
Applied frontend remediation: schedule compositor commits after surface mutations instead of relying only on end_frame.
Status: reconnect required for re-validation.
```

Observed on 2026-06-15 16:02 Asia/Shanghai:

```text
Manual validation improved but still showed stale tile/block artifacts.
Log evidence: forced-GFX ClearCodec/EGFX is active, unsupported/unhandled PDU count is 0, bad decode count is 0.
Tested hypothesis: treat EGFX right/bottom as inclusive and decode ClearCodec with width/height = right-left+1 / bottom-top+1.
Result: rejected. Reconnect logs produced out-of-surface patches, e.g. surface width=1194 while patch right=1195 and surface height=731 while patch bottom=732.
Action: reverted the +1 rectangle conversion and returned the source to canvas-exclusive right/bottom handling. Rebuild/restart is required because the running WASM still contains the rejected +1 build.
Status: rebuild WASM, restart forced-GFX profile, then reconnect for re-validation.
```

Observed on 2026-06-15 16:27 Asia/Shanghai:

```text
Rebuilt ironrdp-web WASM from the reverted source and copied pkg output into frontend/src/wasm.
Restarted the forced-GFX validation profile.
Reconnect logs show ClearCodec patch dimensions now match canvas-exclusive rectangles, e.g. rect right-left=40 and patch width=40; rect bottom-top=27 and patch height=27.
Post-reconnect log summary: codec=184, clear_frame=184, sampled clear_patch=8, reset=2, create=2, map=2, bad_nonzero=0, unsupported_or_unhandled=0, worker_errors=0.
Status: manual visual validation pending.
```

Observed on 2026-06-15 16:40 Asia/Shanghai:

```text
Manual validation still failed after the rebuilt WASM: desktop/window content is visible but stale black/block regions remain.
Log evidence still points away from the rejected +1 coordinate hypothesis: ClearCodec dimensions match canvas-exclusive rectangles and no bad decode count was observed in the sampled summary.
Applied targeted frontend compositor fix: use Canvas2D globalCompositeOperation="copy" for surface/cache pixel copy operations and clear the output canvas before each commit so stale mapped pixels cannot remain after surface movement.
Added regression tests for stale output clearing and transparent cache pixel copy semantics.
Verification: cd frontend && npm run test -- src/rdp/gfx-compositor.test.ts src/test/rdp-engine-flags.test.ts src/test/rdp-gfx-fallback.test.ts passed with 25 tests. cd frontend && npm run build passed with only the existing wasm eval warning.
Status: restart forced-GFX profile and reconnect for manual visual re-validation. If artifacts persist, next root-cause step is explicit logging/handling for any unreported EGFX PDU variants such as WireToSurface2 or scaled/window mapping.
```

Observed on 2026-06-15 16:49 Asia/Shanghai:

```text
Post-restart screenshot no longer showed the same high-contrast flower blocks, but the remote surface rendered as a mostly white/transparent canvas with only small opaque regions.
Root-cause refinement: ClearCodec decoder initializes untouched pixels with alpha=0 and only writes alpha=0xFF where layers produce pixels. Therefore ClearCodec RGBA patches must be alpha-composited over the existing surface; using ImageData as a direct overwrite clears existing pixels to transparent and exposes the app background.
Applied targeted frontend compositor fix: ClearCodec patch writes now stage ImageData into a temporary canvas and draw it with normal source-over semantics. Surface/cache copy operations still use copy semantics.
Added regression test: transparent ClearCodec patch pixels preserve existing surface pixels.
Verification: cd frontend && npm run test -- src/rdp/gfx-compositor.test.ts src/test/rdp-engine-flags.test.ts src/test/rdp-gfx-fallback.test.ts passed with 26 tests. cd frontend && npm run build passed with only the existing wasm eval warning.
Status: forced-GFX dev profile restarted at 16:50; waiting for reconnect and manual visual re-validation.
```

Observed on 2026-06-15 16:52 Asia/Shanghai:

```text
Manual validation failed again: user screenshot showed a mostly white RDP canvas with only a small stale/partial strip near the top.
Decision: stop using forced-GFX as the active validation profile. Roll runtime back to the previous stable official-web bitmap path with GFX disabled.
Started stable profile with VITE_NEXTDESK_OFFICIAL_WEB_GFX=0 and VITE_NEXTDESK_OFFICIAL_WEB_GFX_FORCE=0. Startup log after 16:55 showed IronRDP ready and no GFX/ClearCodec lines before reconnect.
Next alignment direction: compare the stable bitmap path against ironrdp-cli for latency/frame pacing and reduce stutter there before returning to EGFX/ClearCodec compositor work.
Status: Task 7 remains failed for forced-GFX manual visual validation.
```

- [x] **Step 5: Log verification**

Run:

```bash
awk 'BEGIN{start="2026-06-15T00:00:00"} /^\[/ {ts=substr($0,2,20); if (ts>=start) { if ($0 ~ /official-web ClearCodec frame/) clear_frame++; if ($0 ~ /official-web ClearCodec RGBA patch/) clear_patch++; if ($0 ~ /create_surface|map_surface|end_frame|surface_to_surface|cache_to_surface|solid_fill|GFX CreateSurface|GFX MapSurfaceToOutput|GFX EndFrame|GFX SurfaceToSurface|GFX SurfaceToCache|GFX CacheToSurface|GFX SolidFill/) compositor++; if ($0 ~ /unsupported_codec|decode error|panic|crash|exception|\[error\]/) bad++; }} END{printf "clear_frame=%d\nclear_patch=%d\ncompositor_events=%d\nbad=%d\n", clear_frame, clear_patch, compositor, bad}' /tmp/nextdesk_rdp_debug.log
```

Expected:

```text
clear_frame > 0
clear_patch > 0
compositor_events > 0
bad=0
```

---

### Task 8: Add a Safe Fallback Gate for Incomplete Compositor Coverage

**Files:**
- Modify: `frontend/src/rdp/gfx-fallback.ts`
- Modify: `frontend/src/test/rdp-gfx-fallback.test.ts`
- Modify: `frontend/src/components/RdpManager.tsx`

- [ ] **Step 1: Add fallback reasons**

In `frontend/src/rdp/gfx-fallback.ts`, extend the fallback function:

```ts
if (input.type === 'gfx_compositor_error') {
  return {
    shouldFallback: true,
    reason: `gfx_compositor_error:${input.detail || 'unknown'}`,
  };
}
```

- [ ] **Step 2: Add tests**

Append to `frontend/src/test/rdp-gfx-fallback.test.ts`:

```ts
it('falls back when the compositor reports an unrecoverable error', () => {
  expect(describeOfficialWebGfxFallback({
    type: 'gfx_compositor_error',
    detail: 'surface-missing',
  })).toEqual({
    shouldFallback: true,
    reason: 'gfx_compositor_error:surface-missing',
  });
});
```

- [ ] **Step 3: Wrap compositor calls**

In `RdpManager.tsx`, wrap compositor operations:

```ts
try {
  compositor.drawRgbaPatch(...);
} catch (error) {
  triggerOfficialWebGfxFallback({
    type: 'gfx_compositor_error',
    detail: error instanceof Error ? error.message : String(error),
  });
}
```

Apply the same wrapper to `resetGraphics`, `createSurface`, `drawVideoFrame`, `solidFill`, and cache/copy operations.

- [ ] **Step 4: Run fallback tests**

Run:

```bash
cd frontend && npm run test -- src/test/rdp-gfx-fallback.test.ts
```

Expected: PASS.

---

### Task 9: Port Upstream IronRDP EGFX Client Model Incrementally

**Files:**
- Modify: `../IronRDP/crates/ironrdp-egfx/src/client.rs`
- Modify: `../IronRDP/crates/ironrdp-web/src/gfx.rs`
- Update: `docs/ironrdp-nextdesk-patches.md`

- [ ] **Step 1: Diff local EGFX client against upstream master**

Run:

```bash
tmpdir=$(mktemp -d /tmp/ironrdp-upstream-egfx-XXXXXX)
git clone --depth 1 https://github.com/Devolutions/IronRDP.git "$tmpdir"
diff -u "$tmpdir/crates/ironrdp-egfx/src/client.rs" ../IronRDP/crates/ironrdp-egfx/src/client.rs > /tmp/nextdesk-egfx-client.diff || true
sed -n '1,240p' /tmp/nextdesk-egfx-client.diff
```

Expected: diff shows local NextDesk AVC/ClearCodec helpers and missing upstream client state model sections.

- [ ] **Step 2: Port upstream handler callbacks**

Port these upstream concepts while preserving local helpers:

```rust
pub struct BitmapUpdate {
    pub surface_id: u16,
    pub destination_rectangle: ExclusiveRectangle,
    pub codec_id: Codec1Type,
    pub data: Vec<u8>,
    pub width: u16,
    pub height: u16,
}

pub trait GraphicsPipelineHandler: Send {
    fn capabilities(&self) -> Vec<CapabilitySet>;
    fn on_reset_graphics(&mut self, width: u32, height: u32) {}
    fn on_surface_created(&mut self, surface: &Surface) {}
    fn on_surface_deleted(&mut self, surface_id: u16) {}
    fn on_surface_mapped(&mut self, surface_id: u16, origin_x: u32, origin_y: u32) {}
    fn on_bitmap_updated(&mut self, update: &BitmapUpdate) {}
    fn on_frame_complete(&mut self, frame_id: u32) {}
    fn on_unhandled_pdu(&mut self, pdu: &GfxPdu) {}
}
```

- [ ] **Step 3: Keep NextDesk-specific WASM event emission in `ironrdp-web`**

Adapt `WasmGfxHandler` to implement the callback methods above. It should emit JS events from callback methods, not from a monolithic `handle_pdu` switch once the upstream state machine owns PDU dispatch.

- [ ] **Step 4: Run Rust verification**

Run:

```bash
cd ../IronRDP
export PATH="$HOME/.cargo/bin:$PATH"
cargo test -p ironrdp-egfx avc420
cargo test -p ironrdp-pdu clearcodec
cargo test -p ironrdp-graphics clearcodec
cargo check -p ironrdp-web --target wasm32-unknown-unknown
```

Expected: all commands exit 0.

---

### Task 10: Move Compositor to Worker/WebGL After Correctness Passes

**Files:**
- Create: `frontend/src/lib/gfx-compositor-worker.ts`
- Modify: `frontend/src/rdp/gfx-compositor.ts`
- Modify: `frontend/src/components/RdpManager.tsx`
- Test: `frontend/src/rdp/gfx-compositor.test.ts`

- [ ] **Step 1: Add worker wrapper after Canvas2D correctness**

Create `frontend/src/lib/gfx-compositor-worker.ts` with the same event contract as `GfxSurfaceCompositor`. The first worker implementation may use OffscreenCanvas 2D; WebGL can follow after visual parity is proven.

- [ ] **Step 2: Gate worker usage by capability**

In `RdpManager.tsx`:

```ts
const canUseGfxWorker = typeof OffscreenCanvas !== 'undefined' && typeof Worker !== 'undefined';
```

If false, keep the main-thread compositor.

- [ ] **Step 3: Add performance log counters**

Log once every 120 committed frames:

```ts
rdpLog.info('render', 'official-web GFX compositor stats', {
  tabId,
  frames,
  surfaces,
  patches,
  avgCommitMs,
});
```

- [ ] **Step 4: Manual performance gate**

Forced-GFX profile must pass:

```text
No flower screen
No stale blocks after dragging a window
No reconnect during 10 minute active dragging/idle mix
Frame commit average below 16 ms on LAN target
No bad log lines for decode/fallback/panic/crash/exception
```

---

### Task 11: Final Stability Gate Before Promoting GFX

**Files:**
- Update: `docs/rdp/ironrdp-kernel-baseline.md`
- Update: `docs/superpowers/plans/2026-06-14-ironrdp-first-kernel-alignment.md`

- [ ] **Step 1: Run forced-GFX 30 minute idle**

Use:

```bash
VITE_NEXTDESK_RDP_ENGINE=official-web \
VITE_NEXTDESK_EXPERIMENTAL_NATIVE_RDP=0 \
VITE_NEXTDESK_OFFICIAL_WEB_GFX=1 \
VITE_NEXTDESK_OFFICIAL_WEB_GFX_FORCE=1 \
VITE_NEXTDESK_OFFICIAL_WEB_AUDIO=0 \
VITE_NEXTDESK_OFFICIAL_WEB_FILE_TRANSFER=0 \
VITE_NEXTDESK_OFFICIAL_WEB_DISPLAY_CONTROL=1 \
PATH="$HOME/.cargo/bin:$PATH" \
npx tauri dev
```

Expected:

```text
30 minutes connected
No visual corruption
No input during idle sample
No reconnect
No black canvas
ClearCodec or H.264 frames continue rendering correctly
```

- [ ] **Step 2: Run active drag smoke**

Manual case:

```text
Open Notepad or PowerShell.
Drag the window continuously for 60 seconds on 192.168.3.105.
Repeat on 64.20.10.254.
Switch between tabs.
Close one tab.
Reconnect.
```

Expected:

```text
No block artifacts
No stale surface regions
No frozen frame after tab switch
No server auto-reconnect after user-close
```

- [ ] **Step 3: Promote only after evidence**

Only after both gates pass, update defaults:

```text
Keep VITE_NEXTDESK_OFFICIAL_WEB_GFX=0 by default until user approval.
Document a release candidate profile for GFX.
Then consider a UI setting: "Experimental accelerated graphics".
```

---

## Verification Matrix

| Gate | Command / Manual Case | Required Result |
| --- | --- | --- |
| Type/unit tests | `cd frontend && npm run test -- src/rdp/gfx-compositor.test.ts src/test/rdp-gfx-fallback.test.ts src/test/rdp-engine-flags.test.ts` | PASS |
| Frontend build | `cd frontend && npm run build` | PASS, only existing wasm eval warning |
| Rust EGFX tests | `cd ../IronRDP && cargo test -p ironrdp-egfx avc420` | PASS |
| ClearCodec tests | `cargo test -p ironrdp-pdu clearcodec && cargo test -p ironrdp-graphics clearcodec` | PASS |
| WASM check | `cargo check -p ironrdp-web --target wasm32-unknown-unknown` | PASS |
| WASM rebuild | `wasm-pack build --target web crates/ironrdp-web` | PASS |
| Forced-GFX visual | Manual connect to both targets | No flower/block artifacts |
| Forced-GFX idle | 30 minute idle | No reconnect, black canvas, or bad logs |

## Execution Strategy

Recommended sequence:

1. Execute Tasks 1-4 inline to get the first visual fix quickly.
2. Run forced-GFX smoke on both targets.
3. Execute Tasks 5-8 to cover more EGFX operations and add safe fallback.
4. Execute Task 9 as a separate review checkpoint because it touches IronRDP core.
5. Execute Task 10 only after visual correctness passes.
6. Execute Task 11 before changing any default setting.

This plan intentionally keeps `GFX_FORCE=1` as the only entry point until the compositor passes both manual and log-based gates.

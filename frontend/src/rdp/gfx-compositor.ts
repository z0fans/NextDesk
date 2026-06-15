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

type DrawImageArgs =
  | [dx: number, dy: number]
  | [sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number];

function drawImageCopy(ctx: CanvasRenderingContext2D, source: CanvasImageSource, ...args: DrawImageArgs) {
  const previous = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'copy';
  try {
    if (args.length === 2) {
      ctx.drawImage(source, args[0], args[1]);
    } else {
      ctx.drawImage(source, args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7]);
    }
  } finally {
    ctx.globalCompositeOperation = previous;
  }
}

export class GfxSurfaceCompositor {
  private readonly output: HTMLCanvasElement;
  private readonly outputCtx: CanvasRenderingContext2D;
  private readonly surfaces = new Map<number, SurfaceRecord>();
  private readonly mappings = new Map<number, GfxPoint>();
  private readonly cache = new Map<number, CacheRecord>();
  private patchCanvas?: SurfaceRecord;
  private commitScheduled = false;

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
    this.output.style.opacity = '0';
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
    this.requestCommit();
  }

  mapSurface(surfaceId: number, x: number, y: number) {
    this.mappings.set(surfaceId, { x, y });
    this.requestCommit();
  }

  unmapSurface(surfaceId: number) {
    this.mappings.delete(surfaceId);
    this.requestCommit();
  }

  drawRgbaPatch(patch: GfxRgbaPatch) {
    const surface = this.surfaces.get(patch.surfaceId);
    if (!surface || patch.width <= 0 || patch.height <= 0 || !isValidRect(patch.rect)) return;

    const data = patch.data instanceof Uint8ClampedArray
      ? patch.data
      : new Uint8ClampedArray(patch.data.buffer, patch.data.byteOffset, patch.data.byteLength);
    const imageData = new ImageData(new Uint8ClampedArray(data), patch.width, patch.height);
    const patchCanvas = this.getPatchCanvas(patch.width, patch.height);
    patchCanvas.ctx.putImageData(imageData, 0, 0);
    surface.ctx.drawImage(patchCanvas.canvas, patch.rect.left, patch.rect.top);
    this.requestCommit();
  }

  drawVideoFrame(surfaceId: number, frame: VideoFrame, rect: GfxRect) {
    const surface = this.surfaces.get(surfaceId);
    if (!surface || !isValidRect(rect)) return;
    surface.ctx.drawImage(frame, rect.left, rect.top, rectWidth(rect), rectHeight(rect));
    this.requestCommit();
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
    this.requestCommit();
  }

  surfaceToSurface(srcSurfaceId: number, dstSurfaceId: number, srcRect: GfxRect, dst: GfxPoint) {
    const src = this.surfaces.get(srcSurfaceId);
    const dstSurface = this.surfaces.get(dstSurfaceId);
    if (!src || !dstSurface || !isValidRect(srcRect)) return;
    drawImageCopy(
      dstSurface.ctx,
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
    this.requestCommit();
  }

  surfaceToCache(surfaceId: number, cacheSlot: number, rect: GfxRect) {
    const surface = this.surfaces.get(surfaceId);
    if (!surface || !isValidRect(rect)) return;
    const canvas = document.createElement('canvas');
    canvas.width = rectWidth(rect);
    canvas.height = rectHeight(rect);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawImageCopy(ctx, surface.canvas, rect.left, rect.top, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    this.cache.set(cacheSlot, { canvas, width: canvas.width, height: canvas.height });
  }

  cacheToSurface(surfaceId: number, cacheSlot: number, dst: GfxPoint) {
    const surface = this.surfaces.get(surfaceId);
    const cached = this.cache.get(cacheSlot);
    if (!surface || !cached) return;
    drawImageCopy(surface.ctx, cached.canvas, dst.x, dst.y);
    this.requestCommit();
  }

  evictCache(cacheSlot: number) {
    this.cache.delete(cacheSlot);
  }

  endFrame(_frameId: number) {
    this.commit();
  }

  private requestCommit() {
    if (this.commitScheduled) return;
    this.commitScheduled = true;
    const flush = () => {
      this.commitScheduled = false;
      this.commit();
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(flush);
    } else {
      queueMicrotask(flush);
    }
  }

  commit() {
    this.outputCtx.clearRect(0, 0, this.output.width, this.output.height);
    for (const [surfaceId, point] of this.mappings) {
      const surface = this.surfaces.get(surfaceId);
      if (surface) {
        this.outputCtx.drawImage(surface.canvas, point.x, point.y);
      }
    }
    this.output.style.opacity = '1';
  }

  surfaceCount(): number {
    return this.surfaces.size;
  }

  private getPatchCanvas(width: number, height: number): SurfaceRecord {
    const canvasWidth = Math.max(1, width);
    const canvasHeight = Math.max(1, height);
    if (!this.patchCanvas) {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('GFX patch canvas 2D context unavailable');
      }
      this.patchCanvas = { canvas, ctx, width: 1, height: 1 };
    }

    const patchCanvas = this.patchCanvas;
    if (patchCanvas.width !== canvasWidth || patchCanvas.height !== canvasHeight) {
      patchCanvas.canvas.width = canvasWidth;
      patchCanvas.canvas.height = canvasHeight;
      patchCanvas.width = canvasWidth;
      patchCanvas.height = canvasHeight;
    } else {
      patchCanvas.ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    }
    return patchCanvas;
  }
}

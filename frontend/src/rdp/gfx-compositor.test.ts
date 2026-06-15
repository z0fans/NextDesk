import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GfxSurfaceCompositor } from './gfx-compositor';
import { isValidRect, rectHeight, rectWidth } from './gfx-types';

type MockCanvasState = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

type MockCanvasContext = {
  canvas: HTMLCanvasElement;
  fillStyle: string;
  globalCompositeOperation: GlobalCompositeOperation;
  clearRect: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
  fillRect: ReturnType<typeof vi.fn>;
  getImageData: ReturnType<typeof vi.fn>;
  putImageData: ReturnType<typeof vi.fn>;
};

const canvasStates = new WeakMap<HTMLCanvasElement, MockCanvasState>();
const canvasContexts = new WeakMap<HTMLCanvasElement, MockCanvasContext>();

function getCanvasState(canvas: HTMLCanvasElement): MockCanvasState {
  const width = Math.max(1, canvas.width || 300);
  const height = Math.max(1, canvas.height || 150);
  const existing = canvasStates.get(canvas);
  if (existing && existing.width === width && existing.height === height) {
    return existing;
  }

  const state = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  canvasStates.set(canvas, state);
  return state;
}

function copyPixel(
  source: MockCanvasState,
  target: MockCanvasState,
  srcX: number,
  srcY: number,
  dstX: number,
  dstY: number,
) {
  if (srcX < 0 || srcY < 0 || dstX < 0 || dstY < 0) return;
  if (srcX >= source.width || srcY >= source.height || dstX >= target.width || dstY >= target.height) return;

  const sourceOffset = ((srcY * source.width) + srcX) * 4;
  const targetOffset = ((dstY * target.width) + dstX) * 4;
  target.data[targetOffset] = source.data[sourceOffset];
  target.data[targetOffset + 1] = source.data[sourceOffset + 1];
  target.data[targetOffset + 2] = source.data[sourceOffset + 2];
  target.data[targetOffset + 3] = source.data[sourceOffset + 3];
}

function blendPixel(
  source: MockCanvasState,
  target: MockCanvasState,
  srcX: number,
  srcY: number,
  dstX: number,
  dstY: number,
) {
  if (srcX < 0 || srcY < 0 || dstX < 0 || dstY < 0) return;
  if (srcX >= source.width || srcY >= source.height || dstX >= target.width || dstY >= target.height) return;

  const sourceOffset = ((srcY * source.width) + srcX) * 4;
  const targetOffset = ((dstY * target.width) + dstX) * 4;
  const sourceAlpha = source.data[sourceOffset + 3] / 255;
  if (sourceAlpha <= 0) return;
  const inverseAlpha = 1 - sourceAlpha;

  target.data[targetOffset] = Math.round(source.data[sourceOffset] * sourceAlpha + target.data[targetOffset] * inverseAlpha);
  target.data[targetOffset + 1] = Math.round(source.data[sourceOffset + 1] * sourceAlpha + target.data[targetOffset + 1] * inverseAlpha);
  target.data[targetOffset + 2] = Math.round(source.data[sourceOffset + 2] * sourceAlpha + target.data[targetOffset + 2] * inverseAlpha);
  target.data[targetOffset + 3] = Math.round(255 * sourceAlpha + target.data[targetOffset + 3] * inverseAlpha);
}

function createMockContext(canvas: HTMLCanvasElement): MockCanvasContext {
  const ctx: MockCanvasContext = {
    canvas,
    fillStyle: 'rgba(0, 0, 0, 1)',
    globalCompositeOperation: 'source-over',
    clearRect: vi.fn((left: number, top: number, width: number, height: number) => {
      const state = getCanvasState(canvas);
      for (let y = top; y < top + height; y += 1) {
        for (let x = left; x < left + width; x += 1) {
          if (x < 0 || y < 0 || x >= state.width || y >= state.height) continue;
          const offset = ((y * state.width) + x) * 4;
          state.data[offset] = 0;
          state.data[offset + 1] = 0;
          state.data[offset + 2] = 0;
          state.data[offset + 3] = 0;
        }
      }
    }),
    drawImage: vi.fn((sourceCanvas: HTMLCanvasElement, ...args: number[]) => {
      const source = getCanvasState(sourceCanvas);
      const target = getCanvasState(canvas);
      const [sx, sy, sw, sh, dx, dy, dw, dh] = args.length === 2
        ? [0, 0, source.width, source.height, args[0], args[1], source.width, source.height]
        : args;
      const width = Math.max(0, Math.min(sw, dw));
      const height = Math.max(0, Math.min(sh, dh));
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (ctx.globalCompositeOperation === 'copy') {
            copyPixel(source, target, sx + x, sy + y, dx + x, dy + y);
          } else {
            blendPixel(source, target, sx + x, sy + y, dx + x, dy + y);
          }
        }
      }
    }),
    fillRect: vi.fn((left: number, top: number, width: number, height: number) => {
      const state = getCanvasState(canvas);
      const match = ctx.fillStyle.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([0-9.]+)\)/);
      const r = match ? Number(match[1]) : 0;
      const g = match ? Number(match[2]) : 0;
      const b = match ? Number(match[3]) : 0;
      const a = match ? Math.round(Number(match[4]) * 255) : 255;
      for (let y = top; y < top + height; y += 1) {
        for (let x = left; x < left + width; x += 1) {
          if (x < 0 || y < 0 || x >= state.width || y >= state.height) continue;
          const offset = ((y * state.width) + x) * 4;
          state.data[offset] = r;
          state.data[offset + 1] = g;
          state.data[offset + 2] = b;
          state.data[offset + 3] = a;
        }
      }
    }),
    getImageData: vi.fn((left: number, top: number, width: number, height: number) => {
      const state = getCanvasState(canvas);
      const out = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const sourceX = left + x;
          const sourceY = top + y;
          if (sourceX < 0 || sourceY < 0 || sourceX >= state.width || sourceY >= state.height) continue;
          const sourceOffset = ((sourceY * state.width) + sourceX) * 4;
          const targetOffset = ((y * width) + x) * 4;
          out[targetOffset] = state.data[sourceOffset];
          out[targetOffset + 1] = state.data[sourceOffset + 1];
          out[targetOffset + 2] = state.data[sourceOffset + 2];
          out[targetOffset + 3] = state.data[sourceOffset + 3];
        }
      }
      return new ImageData(out, width, height);
    }),
    putImageData: vi.fn((imageData: ImageData, left: number, top: number) => {
      const state = getCanvasState(canvas);
      for (let y = 0; y < imageData.height; y += 1) {
        for (let x = 0; x < imageData.width; x += 1) {
          const targetX = left + x;
          const targetY = top + y;
          if (targetX < 0 || targetY < 0 || targetX >= state.width || targetY >= state.height) continue;
          const sourceOffset = ((y * imageData.width) + x) * 4;
          const targetOffset = ((targetY * state.width) + targetX) * 4;
          state.data[targetOffset] = imageData.data[sourceOffset];
          state.data[targetOffset + 1] = imageData.data[sourceOffset + 1];
          state.data[targetOffset + 2] = imageData.data[sourceOffset + 2];
          state.data[targetOffset + 3] = imageData.data[sourceOffset + 3];
        }
      }
    }),
  };

  return ctx;
}

function installCanvasMock() {
  if (typeof ImageData === 'undefined') {
    (globalThis as any).ImageData = class {
      data: Uint8ClampedArray;
      width: number;
      height: number;

      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    };
  }

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function getContext(this: HTMLCanvasElement, type: string) {
    if (type !== '2d') return null;
    let ctx = canvasContexts.get(this);
    if (!ctx) {
      ctx = createMockContext(this);
      canvasContexts.set(this, ctx);
    }
    return ctx as unknown as CanvasRenderingContext2D;
  });
}

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
    installCanvasMock();
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

  it('commits updates even when the server does not send frame boundaries', () => {
    const output = makeCanvas(160, 120);
    const compositor = new GfxSurfaceCompositor(output);

    compositor.createSurface(9, 80, 80);
    compositor.mapSurface(9, 12, 14);
    compositor.drawRgbaPatch({
      surfaceId: 9,
      rect: { left: 5, top: 6, right: 7, bottom: 8 },
      width: 2,
      height: 2,
      data: rgba(2, 2, 40, 50, 60),
    });

    const pixel = output.getContext('2d')!.getImageData(17, 20, 1, 1).data;
    expect(Array.from(pixel)).toEqual([40, 50, 60, 255]);
    expect(output.style.opacity).toBe('1');
  });

  it('clears stale output pixels when a mapped surface moves', () => {
    const output = makeCanvas(80, 40);
    const compositor = new GfxSurfaceCompositor(output);

    compositor.createSurface(1, 16, 16);
    compositor.drawRgbaPatch({
      surfaceId: 1,
      rect: { left: 0, top: 0, right: 4, bottom: 4 },
      width: 4,
      height: 4,
      data: rgba(4, 4, 200, 10, 20),
    });
    compositor.mapSurface(1, 0, 0);
    compositor.endFrame(1);
    expect(Array.from(output.getContext('2d')!.getImageData(0, 0, 1, 1).data)).toEqual([200, 10, 20, 255]);

    compositor.mapSurface(1, 10, 0);
    compositor.endFrame(2);

    expect(Array.from(output.getContext('2d')!.getImageData(0, 0, 1, 1).data)).toEqual([0, 0, 0, 0]);
    expect(Array.from(output.getContext('2d')!.getImageData(10, 0, 1, 1).data)).toEqual([200, 10, 20, 255]);
  });

  it('preserves existing surface pixels for transparent ClearCodec patch pixels', () => {
    const output = makeCanvas(40, 40);
    const compositor = new GfxSurfaceCompositor(output);

    compositor.createSurface(1, 8, 8);
    compositor.mapSurface(1, 0, 0);
    compositor.drawRgbaPatch({
      surfaceId: 1,
      rect: { left: 0, top: 0, right: 1, bottom: 1 },
      width: 1,
      height: 1,
      data: rgba(1, 1, 20, 40, 60),
    });
    compositor.drawRgbaPatch({
      surfaceId: 1,
      rect: { left: 0, top: 0, right: 1, bottom: 1 },
      width: 1,
      height: 1,
      data: rgba(1, 1, 0, 0, 0, 0),
    });
    compositor.endFrame(2);

    const pixel = output.getContext('2d')!.getImageData(0, 0, 1, 1).data;
    expect(Array.from(pixel)).toEqual([20, 40, 60, 255]);
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

  it('fills solid rectangles on the target surface', () => {
    const output = makeCanvas(100, 100);
    const compositor = new GfxSurfaceCompositor(output);

    compositor.createSurface(1, 32, 32);
    compositor.mapSurface(1, 8, 8);
    compositor.solidFill(1, { left: 2, top: 3, right: 4, bottom: 5 }, 0xffff00ff);
    compositor.endFrame(3);

    const pixel = output.getContext('2d')!.getImageData(10, 11, 1, 1).data;
    expect(Array.from(pixel)).toEqual([255, 0, 255, 255]);
  });

  it('supports surface cache roundtrips before frame commit', () => {
    const output = makeCanvas(120, 120);
    const compositor = new GfxSurfaceCompositor(output);

    compositor.createSurface(1, 32, 32);
    compositor.createSurface(2, 32, 32);
    compositor.mapSurface(2, 10, 10);
    compositor.drawRgbaPatch({
      surfaceId: 1,
      rect: { left: 0, top: 0, right: 4, bottom: 4 },
      width: 4,
      height: 4,
      data: rgba(4, 4, 10, 20, 30),
    });
    compositor.surfaceToCache(1, 99, { left: 0, top: 0, right: 4, bottom: 4 });
    compositor.cacheToSurface(2, 99, { x: 5, y: 6 });
    compositor.evictCache(99);
    compositor.endFrame(4);

    const pixel = output.getContext('2d')!.getImageData(15, 16, 1, 1).data;
    expect(Array.from(pixel)).toEqual([10, 20, 30, 255]);
  });

  it('uses copy semantics for transparent cache pixels', () => {
    const output = makeCanvas(40, 40);
    const compositor = new GfxSurfaceCompositor(output);

    compositor.createSurface(1, 8, 8);
    compositor.createSurface(2, 8, 8);
    compositor.mapSurface(2, 0, 0);
    compositor.drawRgbaPatch({
      surfaceId: 1,
      rect: { left: 0, top: 0, right: 1, bottom: 1 },
      width: 1,
      height: 1,
      data: rgba(1, 1, 0, 0, 0, 0),
    });
    compositor.drawRgbaPatch({
      surfaceId: 2,
      rect: { left: 0, top: 0, right: 1, bottom: 1 },
      width: 1,
      height: 1,
      data: rgba(1, 1, 255, 0, 0),
    });
    compositor.surfaceToCache(1, 100, { left: 0, top: 0, right: 1, bottom: 1 });
    compositor.cacheToSurface(2, 100, { x: 0, y: 0 });
    compositor.endFrame(5);

    const pixel = output.getContext('2d')!.getImageData(0, 0, 1, 1).data;
    expect(Array.from(pixel)).toEqual([0, 0, 0, 0]);
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

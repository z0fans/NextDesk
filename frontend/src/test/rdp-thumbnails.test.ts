import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureConnectedTabThumbnails } from '@/lib/rdp-thumbnails';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('captureConnectedTabThumbnails', () => {
  it('captures thumbnails for all connected tabs when grid view opens', () => {
    const inactiveCanvas = {
      width: 1280,
      height: 720,
      toDataURL: vi.fn(() => 'data:image/jpeg;base64,inactive'),
    } as unknown as HTMLCanvasElement;
    const activeCanvas = {
      width: 1280,
      height: 720,
      toDataURL: vi.fn(() => 'data:image/jpeg;base64,active'),
    } as unknown as HTMLCanvasElement;

    const updateTabThumbnail = vi.fn();

    const captured = captureConnectedTabThumbnails({
      tabs: [
        { id: 'active', status: 'connected' },
        { id: 'inactive', status: 'connected' },
        { id: 'idle', status: 'idle' },
      ],
      canvasRefs: new Map([
        ['active', activeCanvas],
        ['inactive', inactiveCanvas],
      ]),
      updateTabThumbnail,
    });

    expect(captured).toBe(2);
    expect(activeCanvas.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.5);
    expect(inactiveCanvas.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.5);
    expect(updateTabThumbnail).toHaveBeenCalledWith('active', 'data:image/jpeg;base64,active');
    expect(updateTabThumbnail).toHaveBeenCalledWith('inactive', 'data:image/jpeg;base64,inactive');
  });

  it('prefers an active overlay canvas over the primary RDP canvas', () => {
    const primaryCanvas = {
      width: 1280,
      height: 720,
      toDataURL: vi.fn(() => 'data:image/jpeg;base64,primary-black'),
    } as unknown as HTMLCanvasElement;
    const overlayCanvas = {
      width: 1280,
      height: 720,
      style: { opacity: '1' },
      toDataURL: vi.fn(() => 'data:image/jpeg;base64,overlay-frame'),
    } as unknown as HTMLCanvasElement;
    const updateTabThumbnail = vi.fn();

    const captured = captureConnectedTabThumbnails({
      tabs: [{ id: 'tab-1', status: 'connected' }],
      canvasRefs: new Map([['tab-1', primaryCanvas]]),
      overlayCanvasRefs: new Map([['tab-1', overlayCanvas]]),
      updateTabThumbnail,
    });

    expect(captured).toBe(1);
    expect(overlayCanvas.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.5);
    expect(primaryCanvas.toDataURL).not.toHaveBeenCalled();
    expect(updateTabThumbnail).toHaveBeenCalledWith('tab-1', 'data:image/jpeg;base64,overlay-frame');
  });

  it('reads WebGL pixels from the primary canvas before exporting a thumbnail', () => {
    const readPixels = vi.fn((
      _x: number,
      _y: number,
      width: number,
      height: number,
      _format: number,
      _type: number,
      pixels: Uint8Array,
    ) => {
      for (let i = 0; i < width * height; i++) {
        const offset = i * 4;
        pixels[offset] = 32;
        pixels[offset + 1] = 64;
        pixels[offset + 2] = 128;
        pixels[offset + 3] = 255;
      }
    });
    const primaryCanvas = {
      width: 2,
      height: 2,
      getContext: vi.fn((type: string) => (
        type === 'webgl2'
          ? { RGBA: 0x1908, UNSIGNED_BYTE: 0x1401, readPixels }
          : null
      )),
      toDataURL: vi.fn(() => 'data:image/jpeg;base64,black-frame'),
    } as unknown as HTMLCanvasElement;
    const thumbnailCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn((type: string) => (
        type === '2d'
          ? { putImageData: vi.fn() }
          : null
      )),
      toDataURL: vi.fn(() => 'data:image/jpeg;base64,webgl-readback'),
    } as unknown as HTMLCanvasElement;
    vi.spyOn(document, 'createElement').mockReturnValue(thumbnailCanvas);
    vi.stubGlobal('ImageData', class {
      readonly data: Uint8ClampedArray;
      readonly width: number;
      readonly height: number;

      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    });
    const updateTabThumbnail = vi.fn();

    const captured = captureConnectedTabThumbnails({
      tabs: [{ id: 'tab-1', status: 'connected' }],
      canvasRefs: new Map([['tab-1', primaryCanvas]]),
      updateTabThumbnail,
    });

    expect(captured).toBe(1);
    expect(readPixels).toHaveBeenCalled();
    expect(primaryCanvas.toDataURL).not.toHaveBeenCalled();
    expect(updateTabThumbnail).toHaveBeenCalledWith('tab-1', 'data:image/jpeg;base64,webgl-readback');
  });

  it('requests a session snapshot before falling back to canvas capture', () => {
    const primaryCanvas = {
      width: 1280,
      height: 720,
      toDataURL: vi.fn(() => 'data:image/jpeg;base64,canvas-black'),
    } as unknown as HTMLCanvasElement;
    const updateTabThumbnail = vi.fn();
    const requestSessionThumbnail = vi.fn((_tabId: string, update: (thumbnailUrl: string) => void) => {
      update('data:image/png;base64,cpu-snapshot');
      return true;
    });

    const captured = captureConnectedTabThumbnails({
      tabs: [{ id: 'tab-1', status: 'connected' }],
      canvasRefs: new Map([['tab-1', primaryCanvas]]),
      updateTabThumbnail,
      requestSessionThumbnail,
    });

    expect(captured).toBe(1);
    expect(requestSessionThumbnail).toHaveBeenCalledWith('tab-1', expect.any(Function));
    expect(primaryCanvas.toDataURL).not.toHaveBeenCalled();
    expect(updateTabThumbnail).toHaveBeenCalledWith('tab-1', 'data:image/png;base64,cpu-snapshot');
  });
});

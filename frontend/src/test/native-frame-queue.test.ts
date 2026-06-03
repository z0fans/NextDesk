import { describe, expect, it } from 'vitest';
import {
  compactNativeFrameQueue,
  nativeBitmapFrameKey,
} from '@/lib/native-frame-queue';

const HEADER_SIZE = 12;

function bitmapFrame(
  desktopW: number,
  desktopH: number,
  x: number,
  y: number,
  width: number,
  height: number,
  marker: number,
): ArrayBuffer {
  const raw = new ArrayBuffer(HEADER_SIZE + 4);
  const hdr = new DataView(raw);
  hdr.setUint16(0, desktopW, true);
  hdr.setUint16(2, desktopH, true);
  hdr.setUint16(4, x, true);
  hdr.setUint16(6, y, true);
  hdr.setUint16(8, width, true);
  hdr.setUint16(10, height, true);
  new Uint8Array(raw)[HEADER_SIZE] = marker;
  return raw;
}

function gfxFrame(marker: number): ArrayBuffer {
  const raw = new ArrayBuffer(20 + 1);
  const hdr = new DataView(raw);
  hdr.setUint16(0, 0xffff, true);
  hdr.setUint16(2, 1, true);
  hdr.setUint32(16, 1, true);
  new Uint8Array(raw)[20] = marker;
  return raw;
}

function marker(raw: ArrayBuffer): number {
  return new Uint8Array(raw)[raw.byteLength === 21 ? 20 : HEADER_SIZE];
}

describe('native frame queue compaction', () => {
  it('builds stable keys for bitmap dirty rectangles', () => {
    const frame = bitmapFrame(1192, 731, 10, 20, 300, 40, 1);

    expect(nativeBitmapFrameKey(frame)).toBe('1192x731:10,20,300,40');
  });

  it('does not treat GFX frames as bitmap frames', () => {
    expect(nativeBitmapFrameKey(gfxFrame(1))).toBeNull();
  });

  it('keeps only the newest frame for duplicate bitmap rectangles', () => {
    const queue = [
      bitmapFrame(1192, 731, 10, 20, 300, 40, 1),
      bitmapFrame(1192, 731, 50, 60, 120, 80, 2),
      bitmapFrame(1192, 731, 10, 20, 300, 40, 3),
    ];

    const result = compactNativeFrameQueue(queue, { maxFrames: 16 });

    expect(result.droppedDuplicateFrames).toBe(1);
    expect(result.droppedOverflowFrames).toBe(0);
    expect(result.frames.map(marker)).toEqual([2, 3]);
  });

  it('preserves GFX frames while compacting bitmap duplicates', () => {
    const queue = [
      bitmapFrame(1192, 731, 0, 0, 100, 100, 1),
      gfxFrame(2),
      bitmapFrame(1192, 731, 0, 0, 100, 100, 3),
    ];

    const result = compactNativeFrameQueue(queue, { maxFrames: 16 });

    expect(result.frames.map(marker)).toEqual([2, 3]);
  });

  it('limits severe backlog by keeping the newest frames', () => {
    const queue = Array.from({ length: 6 }, (_, index) =>
      bitmapFrame(1192, 731, index, 0, 10, 10, index + 1),
    );

    const result = compactNativeFrameQueue(queue, { maxFrames: 3 });

    expect(result.droppedOverflowFrames).toBe(3);
    expect(result.frames.map(marker)).toEqual([4, 5, 6]);
  });
});

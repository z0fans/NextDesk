import { describe, expect, it } from 'vitest';
import { compactNativeFrameQueue, nativeBitmapFrameKey, nativeFrameQueueKey } from '@/lib/native-frame-queue';
import { DRIFT_FRAME_KIND_DIRTY_RECTS, DRIFT_FRAME_KIND_FULL } from '@/lib/drift-frame-protocol';

function le16(value: number): [number, number] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function bytes(parts: number[]): ArrayBuffer {
  return Uint8Array.from(parts).buffer;
}

function rawBitmapFrame(width = 1920, height = 1080, x = 0, y = 0, rectW = 2, rectH = 1): ArrayBuffer {
  return bytes([
    ...le16(width),
    ...le16(height),
    ...le16(x),
    ...le16(y),
    ...le16(rectW),
    ...le16(rectH),
    1, 2, 3, 255,
    4, 5, 6, 255,
  ]);
}

function driftDirtyFrame(x: number, y: number, value: number): ArrayBuffer {
  return bytes([
    DRIFT_FRAME_KIND_DIRTY_RECTS,
    ...le16(1920),
    ...le16(1080),
    ...le16(1),
    ...le16(x),
    ...le16(y),
    ...le16(2),
    ...le16(1),
    value, value, value, 255,
    value + 1, value + 1, value + 1, 255,
  ]);
}

function driftFullFrame(value: number): ArrayBuffer {
  return bytes([
    DRIFT_FRAME_KIND_FULL,
    ...le16(2),
    ...le16(1),
    ...le16(0),
    value, value, value, 255,
    value + 1, value + 1, value + 1, 255,
  ]);
}

describe('native frame queue compaction', () => {
  it('keeps existing raw bitmap keys stable', () => {
    const frame = rawBitmapFrame(1920, 1080, 10, 20, 2, 1);

    expect(nativeBitmapFrameKey(frame)).toBe('1920x1080:10,20,2,1');
    expect(nativeFrameQueueKey(frame)).toBe('1920x1080:10,20,2,1');
  });

  it('keys drift dirty frames by surface and rect set', () => {
    expect(nativeFrameQueueKey(driftDirtyFrame(5, 6, 10))).toBe('drift:dirty:1920x1080:5,6,2,1');
  });

  it('drops older duplicate drift dirty frames', () => {
    const oldFrame = driftDirtyFrame(5, 6, 10);
    const newFrame = driftDirtyFrame(5, 6, 20);
    const otherFrame = driftDirtyFrame(7, 8, 30);

    const result = compactNativeFrameQueue([oldFrame, otherFrame, newFrame], { maxFrames: 10 });

    expect(result.frames).toEqual([otherFrame, newFrame]);
    expect(result.droppedDuplicateFrames).toBe(1);
    expect(result.droppedOverflowFrames).toBe(0);
  });

  it('drops older duplicate drift full frames', () => {
    const oldFrame = driftFullFrame(1);
    const newFrame = driftFullFrame(9);

    const result = compactNativeFrameQueue([oldFrame, newFrame], { maxFrames: 10 });

    expect(result.frames).toEqual([newFrame]);
    expect(result.droppedDuplicateFrames).toBe(1);
  });

  it('drops overflow from the oldest kept frames', () => {
    const frames = [
      rawBitmapFrame(1920, 1080, 0, 0),
      driftDirtyFrame(1, 1, 10),
      driftDirtyFrame(2, 2, 20),
    ];

    const result = compactNativeFrameQueue(frames, { maxFrames: 2 });

    expect(result.frames).toEqual([frames[1], frames[2]]);
    expect(result.droppedOverflowFrames).toBe(1);
  });
});

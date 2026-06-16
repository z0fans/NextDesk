import { describe, expect, it } from 'vitest';
import {
  DRIFT_FRAME_KIND_DIRTY_RECTS,
  DRIFT_FRAME_KIND_FULL,
  DRIFT_FRAME_KIND_H264,
  isPotentialDriftFramePacket,
  parseDriftFramePacket,
} from '@/lib/drift-frame-protocol';

function packet(parts: number[]): ArrayBuffer {
  return Uint8Array.from(parts).buffer;
}

function le16(value: number): [number, number] {
  return [value & 0xff, (value >> 8) & 0xff];
}

describe('drift frame protocol', () => {
  it('parses full frames', () => {
    const raw = packet([
      DRIFT_FRAME_KIND_FULL,
      ...le16(2),
      ...le16(1),
      ...le16(0),
      1, 2, 3, 255,
      4, 5, 6, 255,
    ]);

    const parsed = parseDriftFramePacket(raw);

    expect(parsed.kind).toBe('full');
    expect(parsed.width).toBe(2);
    expect(parsed.height).toBe(1);
    if (parsed.kind === 'full') {
      expect(Array.from(parsed.rgba)).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
    }
  });

  it('parses multiple dirty rects', () => {
    const raw = packet([
      DRIFT_FRAME_KIND_DIRTY_RECTS,
      ...le16(8),
      ...le16(6),
      ...le16(2),
      ...le16(1),
      ...le16(2),
      ...le16(1),
      ...le16(1),
      9, 9, 9, 255,
      ...le16(4),
      ...le16(3),
      ...le16(2),
      ...le16(1),
      1, 2, 3, 255,
      4, 5, 6, 255,
    ]);

    const parsed = parseDriftFramePacket(raw);

    expect(parsed.kind).toBe('dirty');
    if (parsed.kind === 'dirty') {
      expect(parsed.rects).toHaveLength(2);
      expect(parsed.rects[0]).toMatchObject({ x: 1, y: 2, width: 1, height: 1 });
      expect(Array.from(parsed.rects[0].rgba)).toEqual([9, 9, 9, 255]);
      expect(parsed.rects[1]).toMatchObject({ x: 4, y: 3, width: 2, height: 1 });
      expect(Array.from(parsed.rects[1].rgba)).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
    }
  });

  it('parses h264 payloads', () => {
    const raw = packet([
      DRIFT_FRAME_KIND_H264,
      ...le16(1920),
      ...le16(1080),
      ...le16(0),
      0, 0, 1, 103,
    ]);

    const parsed = parseDriftFramePacket(raw);

    expect(parsed.kind).toBe('h264');
    if (parsed.kind === 'h264') {
      expect(Array.from(parsed.payload)).toEqual([0, 0, 1, 103]);
    }
  });

  it('rejects truncated dirty rect payloads', () => {
    const raw = packet([
      DRIFT_FRAME_KIND_DIRTY_RECTS,
      ...le16(4),
      ...le16(4),
      ...le16(1),
      ...le16(0),
      ...le16(0),
      ...le16(2),
      ...le16(2),
      1, 2, 3,
    ]);

    expect(() => parseDriftFramePacket(raw)).toThrow(/payload is truncated/);
  });

  it('rejects dirty rects outside the surface', () => {
    const raw = packet([
      DRIFT_FRAME_KIND_DIRTY_RECTS,
      ...le16(4),
      ...le16(4),
      ...le16(1),
      ...le16(3),
      ...le16(3),
      ...le16(2),
      ...le16(2),
      ...new Array(16).fill(0),
    ]);

    expect(() => parseDriftFramePacket(raw)).toThrow(/out of bounds/);
  });

  it('detects only candidate packet kinds', () => {
    expect(isPotentialDriftFramePacket(packet([DRIFT_FRAME_KIND_FULL, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0]))).toBe(true);
    expect(isPotentialDriftFramePacket(packet([99, 1, 0, 1, 0, 0, 0]))).toBe(false);
    expect(isPotentialDriftFramePacket(packet([DRIFT_FRAME_KIND_FULL, 1]))).toBe(false);
  });
});

const FRAME_HEADER_SIZE = 7;
const RECT_HEADER_SIZE = 8;
const BYTES_PER_PIXEL = 4;

export const DRIFT_FRAME_KIND_FULL = 1;
export const DRIFT_FRAME_KIND_DIRTY_RECTS = 2;
export const DRIFT_FRAME_KIND_H264 = 3;

export interface DriftDirtyRect {
  x: number;
  y: number;
  width: number;
  height: number;
  rgba: Uint8Array;
}

export type DriftFramePacket =
  | { kind: 'full'; width: number; height: number; rgba: Uint8Array }
  | { kind: 'dirty'; width: number; height: number; rects: DriftDirtyRect[] }
  | { kind: 'h264'; width: number; height: number; payload: Uint8Array };

export function isPotentialDriftFramePacket(raw: ArrayBuffer): boolean {
  if (raw.byteLength < FRAME_HEADER_SIZE) return false;
  const kind = new DataView(raw, 0, 1).getUint8(0);
  return kind === DRIFT_FRAME_KIND_FULL ||
    kind === DRIFT_FRAME_KIND_DIRTY_RECTS ||
    kind === DRIFT_FRAME_KIND_H264;
}

export function parseDriftFramePacket(raw: ArrayBuffer): DriftFramePacket {
  if (raw.byteLength < FRAME_HEADER_SIZE) {
    throw new Error(`Drift frame too short: ${raw.byteLength}`);
  }

  const view = new DataView(raw);
  const bytes = new Uint8Array(raw);
  const kind = view.getUint8(0);
  const width = view.getUint16(1, true);
  const height = view.getUint16(3, true);
  const rectCount = view.getUint16(5, true);

  if (width === 0 || height === 0) {
    throw new Error(`Drift frame has invalid surface size: ${width}x${height}`);
  }

  if (kind === DRIFT_FRAME_KIND_FULL) {
    if (rectCount !== 0) {
      throw new Error(`Full Drift frame must have rect_count=0, got ${rectCount}`);
    }
    const expectedBytes = checkedPixelBytes(width, height, 'full frame');
    const payloadStart = FRAME_HEADER_SIZE;
    const payloadEnd = payloadStart + expectedBytes;
    if (raw.byteLength !== payloadEnd) {
      throw new Error(`Full Drift frame length mismatch: expected ${payloadEnd}, got ${raw.byteLength}`);
    }
    return {
      kind: 'full',
      width,
      height,
      rgba: bytes.subarray(payloadStart, payloadEnd),
    };
  }

  if (kind === DRIFT_FRAME_KIND_H264) {
    if (rectCount !== 0) {
      throw new Error(`H.264 Drift frame must have rect_count=0, got ${rectCount}`);
    }
    return {
      kind: 'h264',
      width,
      height,
      payload: bytes.subarray(FRAME_HEADER_SIZE),
    };
  }

  if (kind !== DRIFT_FRAME_KIND_DIRTY_RECTS) {
    throw new Error(`Unknown Drift frame kind: ${kind}`);
  }
  if (rectCount === 0) {
    throw new Error('Dirty Drift frame requires at least one rect');
  }

  let offset = FRAME_HEADER_SIZE;
  const rects: DriftDirtyRect[] = [];
  for (let i = 0; i < rectCount; i++) {
    if (offset + RECT_HEADER_SIZE > raw.byteLength) {
      throw new Error(`Dirty Drift frame rect ${i} header is truncated`);
    }
    const x = view.getUint16(offset, true);
    const y = view.getUint16(offset + 2, true);
    const rectWidth = view.getUint16(offset + 4, true);
    const rectHeight = view.getUint16(offset + 6, true);
    offset += RECT_HEADER_SIZE;

    if (rectWidth === 0 || rectHeight === 0) {
      throw new Error(`Dirty Drift frame rect ${i} has invalid size: ${rectWidth}x${rectHeight}`);
    }
    if (x + rectWidth > width || y + rectHeight > height) {
      throw new Error(
        `Dirty Drift frame rect ${i} out of bounds: ${rectWidth}x${rectHeight}+${x},${y} surface=${width}x${height}`,
      );
    }

    const payloadBytes = checkedPixelBytes(rectWidth, rectHeight, `dirty rect ${i}`);
    const payloadEnd = offset + payloadBytes;
    if (payloadEnd > raw.byteLength) {
      throw new Error(`Dirty Drift frame rect ${i} payload is truncated`);
    }
    rects.push({
      x,
      y,
      width: rectWidth,
      height: rectHeight,
      rgba: bytes.subarray(offset, payloadEnd),
    });
    offset = payloadEnd;
  }

  if (offset !== raw.byteLength) {
    throw new Error(`Dirty Drift frame has trailing bytes: ${raw.byteLength - offset}`);
  }

  return { kind: 'dirty', width, height, rects };
}

function checkedPixelBytes(width: number, height: number, context: string): number {
  const bytes = width * height * BYTES_PER_PIXEL;
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`Pixel byte count overflow for ${context}`);
  }
  return bytes;
}

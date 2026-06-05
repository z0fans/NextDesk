const HEADER_SIZE = 12;
const GFX_FRAME_MAGIC = 0xffff;

export interface NativeFrameQueueCompactOptions {
  maxFrames: number;
}

export interface NativeFrameQueueCompactResult {
  frames: ArrayBuffer[];
  droppedDuplicateFrames: number;
  droppedOverflowFrames: number;
}

export function nativeBitmapFrameKey(raw: ArrayBuffer): string | null {
  if (raw.byteLength < HEADER_SIZE) return null;

  const hdr = new DataView(raw, 0, HEADER_SIZE);
  if (hdr.getUint16(0, true) === GFX_FRAME_MAGIC) return null;

  const desktopW = hdr.getUint16(0, true) & 0x7fff;
  const desktopH = hdr.getUint16(2, true);
  const x = hdr.getUint16(4, true);
  const y = hdr.getUint16(6, true);
  const width = hdr.getUint16(8, true);
  const height = hdr.getUint16(10, true);

  return `${desktopW}x${desktopH}:${x},${y},${width},${height}`;
}

export function compactNativeFrameQueue(
  queue: ArrayBuffer[],
  options: NativeFrameQueueCompactOptions,
): NativeFrameQueueCompactResult {
  const seenBitmapKeys = new Set<string>();
  const keptReversed: ArrayBuffer[] = [];
  let droppedDuplicateFrames = 0;

  for (let i = queue.length - 1; i >= 0; i--) {
    const frame = queue[i];
    const key = nativeBitmapFrameKey(frame);

    if (key && seenBitmapKeys.has(key)) {
      droppedDuplicateFrames++;
      continue;
    }

    if (key) seenBitmapKeys.add(key);
    keptReversed.push(frame);
  }

  keptReversed.reverse();

  const overflow = Math.max(0, keptReversed.length - options.maxFrames);
  const frames = overflow > 0 ? keptReversed.slice(overflow) : keptReversed;

  return {
    frames,
    droppedDuplicateFrames,
    droppedOverflowFrames: overflow,
  };
}

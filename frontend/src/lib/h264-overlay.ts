export interface GfxRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface H264DrawRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RgbaPatch {
  data: Uint8Array | Uint8ClampedArray;
  left: number;
  top: number;
  right?: number;
  bottom?: number;
  width: number;
  height: number;
}

export function gfxRectToDrawRect(
  rect: GfxRect | undefined,
  fallbackWidth: number,
  fallbackHeight: number,
): H264DrawRect {
  if (!rect) {
    return { x: 0, y: 0, width: fallbackWidth, height: fallbackHeight };
  }

  const exclusiveWidth = rect.right - rect.left;
  const exclusiveHeight = rect.bottom - rect.top;
  if (exclusiveWidth > 0 && exclusiveHeight > 0) {
    return {
      x: rect.left,
      y: rect.top,
      width: exclusiveWidth,
      height: exclusiveHeight,
    };
  }

  return {
    x: rect.left,
    y: rect.top,
    width: Math.max(1, rect.right - rect.left + 1),
    height: Math.max(1, rect.bottom - rect.top + 1),
  };
}

export function ensureOverlaySize(
  overlay: HTMLCanvasElement,
  width: number,
  height: number,
) {
  if (overlay.width !== width || overlay.height !== height) {
    overlay.width = width;
    overlay.height = height;
  }
}

export function drawDecodedH264FrameToOverlay(
  overlay: HTMLCanvasElement,
  frame: VideoFrame,
  rect?: GfxRect,
) {
  ensureOverlaySize(overlay, Math.max(1, overlay.clientWidth || frame.displayWidth), Math.max(1, overlay.clientHeight || frame.displayHeight));
  const drawRect = gfxRectToDrawRect(rect, frame.displayWidth, frame.displayHeight);
  const ctx2d = overlay.getContext('2d');
  if (ctx2d) {
    ctx2d.drawImage(frame, drawRect.x, drawRect.y, drawRect.width, drawRect.height);
  }
  overlay.style.opacity = '1';
}

export function drawRgbaPatchToOverlay(
  overlay: HTMLCanvasElement,
  patch: RgbaPatch,
) {
  const targetWidth = Math.max(1, overlay.clientWidth || patch.right || patch.width);
  const targetHeight = Math.max(1, overlay.clientHeight || patch.bottom || patch.height);
  ensureOverlaySize(overlay, targetWidth, targetHeight);

  const ctx2d = overlay.getContext('2d');
  if (!ctx2d) return;

  const rgba = patch.data instanceof Uint8ClampedArray
    ? patch.data
    : new Uint8ClampedArray(patch.data.buffer, patch.data.byteOffset, patch.data.byteLength);
  const imageData = new ImageData(new Uint8ClampedArray(rgba), patch.width, patch.height);
  ctx2d.putImageData(imageData, patch.left, patch.top);
  overlay.style.opacity = '1';
}

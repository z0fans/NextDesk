type ThumbnailTab = {
  id: string;
  status: string;
};

type CaptureConnectedTabThumbnailsOptions = {
  tabs: ThumbnailTab[];
  canvasRefs: Map<string, HTMLCanvasElement>;
  overlayCanvasRefs?: Map<string, HTMLCanvasElement>;
  updateTabThumbnail: (tabId: string, thumbnailUrl: string) => void;
  requestSessionThumbnail?: (
    tabId: string,
    updateThumbnail: (thumbnailUrl: string) => void,
  ) => boolean;
  mimeType?: string;
  quality?: number;
};

function isReadableCanvas(canvas: HTMLCanvasElement | undefined): canvas is HTMLCanvasElement {
  return Boolean(canvas && canvas.width > 0 && canvas.height > 0);
}

function isReadableOverlayCanvas(canvas: HTMLCanvasElement | undefined): canvas is HTMLCanvasElement {
  if (!isReadableCanvas(canvas)) return false;
  return canvas.style.opacity !== '0';
}

function hasContext(canvas: HTMLCanvasElement): boolean {
  return typeof canvas.getContext === 'function';
}

function captureWebGlCanvasDataUrl(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality: number,
): string | null {
  if (!hasContext(canvas)) return null;

  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true }) ??
    canvas.getContext('webgl', { preserveDrawingBuffer: true });
  if (!gl || typeof gl.readPixels !== 'function') return null;

  const width = canvas.width;
  const height = canvas.height;
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  const rowBytes = width * 4;
  const flipped = new Uint8ClampedArray(pixels.length);
  for (let y = 0; y < height; y++) {
    const srcStart = (height - 1 - y) * rowBytes;
    flipped.set(pixels.subarray(srcStart, srcStart + rowBytes), y * rowBytes);
  }

  const output = document.createElement('canvas');
  output.width = width;
  output.height = height;
  const ctx = output.getContext('2d');
  if (!ctx) return null;

  ctx.putImageData(new ImageData(flipped, width, height), 0, 0);
  return output.toDataURL(mimeType, quality);
}

function captureCanvasDataUrl(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality: number,
): string {
  return captureWebGlCanvasDataUrl(canvas, mimeType, quality) ??
    canvas.toDataURL(mimeType, quality);
}

export function captureConnectedTabThumbnails({
  tabs,
  canvasRefs,
  overlayCanvasRefs,
  updateTabThumbnail,
  requestSessionThumbnail,
  mimeType = 'image/jpeg',
  quality = 0.5,
}: CaptureConnectedTabThumbnailsOptions): number {
  let captured = 0;

  for (const tab of tabs) {
    if (tab.status !== 'connected') continue;

    if (requestSessionThumbnail?.(tab.id, thumbnailUrl => updateTabThumbnail(tab.id, thumbnailUrl))) {
      captured++;
      continue;
    }

    const overlayCanvas = overlayCanvasRefs?.get(tab.id);
    const canvas = isReadableOverlayCanvas(overlayCanvas)
      ? overlayCanvas
      : canvasRefs.get(tab.id);
    if (!isReadableCanvas(canvas)) continue;

    try {
      const url = captureCanvasDataUrl(canvas, mimeType, quality);
      updateTabThumbnail(tab.id, url);
      captured++;
    } catch {
      // Canvas readback can fail if the graphics context is unavailable.
      // Thumbnail refresh is best-effort and must not affect the RDP session.
    }
  }

  return captured;
}

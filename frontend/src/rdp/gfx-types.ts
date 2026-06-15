export type GfxSurfaceId = number;
export type GfxFrameId = number;

export interface GfxRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface GfxPoint {
  x: number;
  y: number;
}

export interface GfxSize {
  width: number;
  height: number;
}

export interface GfxRgbaPatch {
  surfaceId: GfxSurfaceId;
  rect: GfxRect;
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

export interface GfxH264Frame {
  surfaceId: GfxSurfaceId;
  rect: GfxRect;
  frame: VideoFrame;
}

export type GfxEvent =
  | { type: 'reset_graphics'; width: number; height: number }
  | { type: 'create_surface'; surfaceId: GfxSurfaceId; width: number; height: number }
  | { type: 'delete_surface'; surfaceId: GfxSurfaceId }
  | { type: 'map_surface'; surfaceId: GfxSurfaceId; x: number; y: number }
  | { type: 'unmap_surface'; surfaceId: GfxSurfaceId }
  | { type: 'start_frame'; frameId: GfxFrameId }
  | { type: 'end_frame'; frameId: GfxFrameId }
  | { type: 'clearcodec_rgba_patch'; patch: GfxRgbaPatch }
  | { type: 'h264_frame'; frame: GfxH264Frame }
  | { type: 'solid_fill'; surfaceId: GfxSurfaceId; rect: GfxRect; color: number }
  | { type: 'surface_to_surface'; srcSurfaceId: GfxSurfaceId; dstSurfaceId: GfxSurfaceId; srcRect: GfxRect; dst: GfxPoint }
  | { type: 'surface_to_cache'; surfaceId: GfxSurfaceId; cacheSlot: number; rect: GfxRect }
  | { type: 'cache_to_surface'; surfaceId: GfxSurfaceId; cacheSlot: number; dst: GfxPoint }
  | { type: 'evict_cache'; cacheSlot: number };

export function rectWidth(rect: GfxRect): number {
  return Math.max(0, rect.right - rect.left);
}

export function rectHeight(rect: GfxRect): number {
  return Math.max(0, rect.bottom - rect.top);
}

export function isValidRect(rect: GfxRect): boolean {
  return rectWidth(rect) > 0 && rectHeight(rect) > 0;
}

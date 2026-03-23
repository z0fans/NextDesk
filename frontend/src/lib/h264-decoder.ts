/**
 * H.264 Decoder — WebCodecs VideoDecoder wrapper for RDP GFX pipeline.
 *
 * Receives H.264 NAL units from WASM GFX handler, decodes them using
 * the browser's hardware-accelerated VideoDecoder, and draws decoded
 * frames onto a WebGL2 canvas texture.
 */

export interface GfxEvent {
  surfaceId: number;
  codec: string;
  data: Uint8Array;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SurfaceInfo {
  surfaceId: number;
  width: number;
  height: number;
}

export class H264Decoder {
  private decoder: VideoDecoder | null = null;
  private targetCanvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null = null;
  private surfaces = new Map<number, SurfaceInfo>();
  private frameCount = 0;
  private _isSupported = false;

  constructor(canvas: HTMLCanvasElement) {
    this.targetCanvas = canvas;
    this._isSupported = typeof VideoDecoder !== 'undefined';
    if (this._isSupported) {
      this.initDecoder();
    } else {
      console.warn('[h264] WebCodecs VideoDecoder not supported');
    }
  }

  get isSupported(): boolean {
    return this._isSupported;
  }

  private initDecoder() {
    this.decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        this.onFrame(frame);
      },
      error: (err: DOMException) => {
        console.error('[h264] decoder error:', err.message);
      },
    });

    this.decoder.configure({
      codec: 'avc1.64001f', // H.264 High profile, level 3.1
      optimizeForLatency: true,
    });

    console.log('[h264] VideoDecoder initialized');
  }

  /**
   * Handle GFX events from WASM.
   * Called by the gfx_callback registered in session builder.
   */
  handleGfxEvent(type: string, data: any) {
    switch (type) {
      case 'h264_frame':
        this.decodeFrame(data as GfxEvent);
        break;
      case 'create_surface':
        this.createSurface(data as SurfaceInfo);
        break;
      case 'delete_surface':
        this.surfaces.delete(data as number);
        break;
      case 'map_surface':
        // Surface mapping — store position info
        break;
      case 'reset_graphics':
        this.reset();
        break;
      case 'start_frame':
      case 'end_frame':
        // Frame markers — could be used for batching
        break;
      default:
        break;
    }
  }

  private createSurface(info: SurfaceInfo) {
    this.surfaces.set(info.surfaceId, info);
    console.log('[h264] surface created:', info.surfaceId,
      info.width, 'x', info.height);
  }

  private decodeFrame(event: GfxEvent) {
    if (!this.decoder || this.decoder.state === 'closed') return;

    const isKeyFrame = this.isKeyFrame(event.data);
    const chunk = new EncodedVideoChunk({
      type: isKeyFrame ? 'key' : 'delta',
      timestamp: performance.now() * 1000, // microseconds
      data: event.data,
    });

    try {
      this.decoder.decode(chunk);
    } catch (err) {
      console.warn('[h264] decode error:', err);
    }
  }

  private onFrame(frame: VideoFrame) {
    // Draw decoded H.264 frame directly onto the target canvas
    if (!this.ctx) {
      this.ctx = this.targetCanvas.getContext('2d');
    }
    if (this.ctx) {
      this.ctx.drawImage(frame, 0, 0,
        this.targetCanvas.width, this.targetCanvas.height);
    }
    this.frameCount++;
    frame.close();
  }

  /**
   * Check if NAL unit is an IDR (key frame) by inspecting the NAL type.
   * NAL type is in bits 0-4 of the first byte after start code.
   */
  private isKeyFrame(data: Uint8Array): boolean {
    // Find NAL unit type after start code (0x00 0x00 0x01 or 0x00 0x00 0x00 0x01)
    for (let i = 0; i < data.length - 1; i++) {
      if (data[i] === 0 && data[i + 1] === 0) {
        let nalStart = -1;
        if (i + 2 < data.length && data[i + 2] === 1) {
          nalStart = i + 3;
        } else if (i + 3 < data.length && data[i + 2] === 0
          && data[i + 3] === 1) {
          nalStart = i + 4;
        }
        if (nalStart >= 0 && nalStart < data.length) {
          const nalType = data[nalStart] & 0x1f;
          // NAL type 5 = IDR slice (key frame)
          if (nalType === 5) return true;
        }
      }
    }
    return false;
  }

  reset() {
    if (this.decoder && this.decoder.state !== 'closed') {
      this.decoder.reset();
      this.initDecoder();
    }
    this.surfaces.clear();
    this.frameCount = 0;
  }

  close() {
    if (this.decoder && this.decoder.state !== 'closed') {
      this.decoder.close();
    }
    this.decoder = null;
    this.surfaces.clear();
  }
}

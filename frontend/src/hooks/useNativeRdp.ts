/**
 * useNativeRdp — Hook for native Rust RDP session rendering.
 *
 * Uses local WebSocket for zero-overhead binary frame streaming.
 * Frame format: [12B header] + [RGBA pixels].
 * Compressed frames set desktop_width bit15=1 and append
 * [4B uncompressed_len] + [LZ4 data].
 * GFX H.264 frames use [0xFFFF magic] + metadata + payload.
 */
import { useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { RdpPointerEvent, RdpStatusEvent } from '@/api';
import { compactNativeFrameQueue } from '@/lib/native-frame-queue';
import { rdpLog } from '@/lib/rdp-logger';

const GFX_FRAME_MAGIC = 0xffff;
const GFX_FRAME_KIND_H264 = 1;
const GFX_FRAME_HEADER_SIZE = 20;
const BITMAP_FLUSH_BUDGET_MS = 4;
const BITMAP_MAX_FRAMES_PER_FLUSH = 3;
const BITMAP_QUEUE_COMPACT_THRESHOLD = 48;
const BITMAP_QUEUE_HARD_LIMIT = 180;
const BITMAP_BACKLOG_WARN_THRESHOLD = 120;

export interface NativeGfxH264Frame {
  surfaceId: number;
  codecId: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  data: ArrayBuffer;
}

export interface NativeBitmapFrameInfo {
  desktopW: number;
  desktopH: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

// ── LZ4 Block Decompressor (pure TypeScript, no deps) ───────

/**
 * Decompress LZ4 block format data produced by lz4_flex::compress_prepend_size.
 * Input format: [4B LE uncompressed_size] + [LZ4 block data]
 *
 * Optimized: uses pre-allocated buffer + Uint8Array.copyWithin() for fast match copies.
 */
// Pre-allocated decompression buffer (reused across frames, resized as needed)
let _decompBuf = new Uint8Array(4 * 1024 * 1024); // 4MB initial

function decompressLz4(input: Uint8Array): Uint8Array {
  const uncompressedSize =
    input[0] | (input[1] << 8) | (input[2] << 16) | ((input[3] << 24) >>> 0);

  // Resize buffer if needed (over-allocate 2x to reduce future resizes)
  if (_decompBuf.length < uncompressedSize) {
    _decompBuf = new Uint8Array(uncompressedSize * 2);
  }
  const output = _decompBuf;

  let ip = 4;
  let op = 0;

  while (ip < input.length && op < uncompressedSize) {
    const token = input[ip++];

    // ── Literal copy ──
    let litLen = token >>> 4;
    if (litLen === 15) {
      let b: number;
      do { b = input[ip++]; litLen += b; } while (b === 255);
    }
    if (litLen > 0) {
      output.set(input.subarray(ip, ip + litLen), op);
      ip += litLen;
      op += litLen;
    }

    if (op >= uncompressedSize) break;

    // ── Match copy ──
    const offset = input[ip] | (input[ip + 1] << 8);
    ip += 2;

    let matchLen = (token & 0x0f) + 4;
    if ((token & 0x0f) === 15) {
      let b: number;
      do { b = input[ip++]; matchLen += b; } while (b === 255);
    }

    // Fast path: non-overlapping copy
    if (offset >= matchLen) {
      output.copyWithin(op, op - offset, op - offset + matchLen);
      op += matchLen;
    } else {
      // Overlapping (RLE pattern): copy in chunks of 'offset' size
      let remaining = matchLen;
      while (remaining > 0) {
        const chunk = Math.min(offset, remaining);
        output.copyWithin(op, op - offset, op - offset + chunk);
        op += chunk;
        remaining -= chunk;
      }
    }
  }

  // Return a VIEW into the pre-allocated buffer (no copy)
  return output.subarray(0, uncompressedSize);
}

// ── WebGL2 Renderer ─────────────────────────────────

interface GL2Renderer {
  gl: WebGL2RenderingContext;
  texture: WebGLTexture;
  program: WebGLProgram;
}

function initGL2(canvas: HTMLCanvasElement): GL2Renderer | null {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    desynchronized: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  });
  if (!gl) return null;

  // Vertex shader: fullscreen quad
  const vs = gl.createShader(gl.VERTEX_SHADER)!;
  gl.shaderSource(vs, `#version 300 es
    const vec2 pos[4] = vec2[](
      vec2(-1,-1), vec2(1,-1), vec2(-1,1), vec2(1,1)
    );
    const vec2 uv[4] = vec2[](
      vec2(0,1), vec2(1,1), vec2(0,0), vec2(1,0)
    );
    out vec2 v_uv;
    void main() {
      gl_Position = vec4(pos[gl_VertexID], 0, 1);
      v_uv = uv[gl_VertexID];
    }
  `);
  gl.compileShader(vs);

  // Fragment shader: direct RGBA passthrough
  const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(fs, `#version 300 es
    precision mediump float;
    in vec2 v_uv;
    uniform sampler2D u_tex;
    out vec4 color;
    void main() {
      color = texture(u_tex, v_uv);
    }
  `);
  gl.compileShader(fs);

  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.useProgram(program);

  // Create texture
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  return { gl, texture, program };
}

/** Frame header: 12 bytes = 6 × u16 (little-endian) */
const HEADER_SIZE = 12;

// ── Hook Interface ──────────────────────────────────

interface UseNativeRdpOptions {
  tabId: string | null;
  canvas: HTMLCanvasElement | null;
  onFrame?: (frame?: NativeBitmapFrameInfo) => void;
  onStatus?: (tabId: string, status: string, message?: string) => void;
}

interface NativeFrameDebugContext {
  tabId?: string;
  host?: string;
  shouldRenderFrame?: () => boolean;
}

/**
 * Connect to the local WebSocket frame server and start rendering.
 * Returns a cleanup function that closes the WebSocket.
 */
export function connectFrameWebSocket(
  wsPort: number,
  canvas: HTMLCanvasElement,
  onFrame?: (frame?: NativeBitmapFrameInfo) => void,
  onGfxH264Frame?: (frame: NativeGfxH264Frame) => void,
  onUnexpectedClose?: (event: CloseEvent) => void,
  debugContext: NativeFrameDebugContext = {},
): () => void {
  const logContext = {
    wsPort,
    tabId: debugContext.tabId,
    host: debugContext.host,
  };
  const renderer = initGL2(canvas);
  if (!renderer) {
    rdpLog.error('render', 'WebGL2 init failed for native frame websocket', {
      ...logContext,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
    });
    throw new Error('WebGL2 not supported');
  }

  const { gl, texture } = renderer;
  rdpLog.info('render', 'native frame renderer initialized', {
    ...logContext,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
  });

  // ── Bitmap state ──
  let currentW = 0;
  let currentH = 0;
  let textureInitialized = false;

  // ── rAF frame/upload batching ──
  // WebSocket events can arrive in bursts during window drag/selection.
  // Queueing them into the next rAF keeps texture uploads aligned to the
  // browser's paint cadence instead of slicing the main thread per packet.
  const frameQueue: ArrayBuffer[] = [];
  let needsDraw = false;
  let renderRafId = 0;
  let highQueueLogged = false;
  let lastBatchLogAt = 0;
  let lastCompactLogAt = 0;

  // ── Stream stats ──
  let receivedFrames = 0;
  let receivedBytes = 0;
  let processedBitmapFrames = 0;
  let processedGfxFrames = 0;
  let drawnFrames = 0;
  let droppedDuplicateFrames = 0;
  let droppedOverflowFrames = 0;
  let droppedInactiveFrames = 0;
  let maxQueueLength = 0;
  let lastFrameAt = 0;
  let lastFlushMs = 0;
  let lastStatsAt = performance.now();
  let lastStatsReceivedFrames = 0;
  let lastStatsReceivedBytes = 0;
  let lastStatsProcessedFrames = 0;
  let lastStatsDrawnFrames = 0;

  function bytesToMiB(bytes: number) {
    return bytes / 1024 / 1024;
  }

  function logFrameStreamStats(reason: string) {
    const now = performance.now();
    const elapsed = Math.max((now - lastStatsAt) / 1000, 0.001);
    const processedFrames = processedBitmapFrames + processedGfxFrames;
    const deltaReceivedFrames = receivedFrames - lastStatsReceivedFrames;
    const deltaReceivedBytes = receivedBytes - lastStatsReceivedBytes;
    const deltaProcessedFrames = processedFrames - lastStatsProcessedFrames;
    const deltaDrawnFrames = drawnFrames - lastStatsDrawnFrames;

    rdpLog.info('render', 'native frame stream stats', {
      ...logContext,
      reason,
      recvFrames: deltaReceivedFrames,
      recvFps: Math.round((deltaReceivedFrames / elapsed) * 10) / 10,
      recvMiBS: Math.round((bytesToMiB(deltaReceivedBytes) / elapsed) * 100) / 100,
      processedFrames: deltaProcessedFrames,
      processedFps: Math.round((deltaProcessedFrames / elapsed) * 10) / 10,
      drawnFrames: deltaDrawnFrames,
      drawFps: Math.round((deltaDrawnFrames / elapsed) * 10) / 10,
      queued: frameQueue.length,
      maxQueue: maxQueueLength,
      droppedDuplicateFrames,
      droppedOverflowFrames,
      droppedInactiveFrames,
      lastFrameAgeMs: lastFrameAt > 0 ? Math.round(now - lastFrameAt) : null,
      lastFlushMs: Math.round(lastFlushMs * 10) / 10,
      totalReceivedFrames: receivedFrames,
      totalProcessedFrames: processedFrames,
      totalDrawnFrames: drawnFrames,
    });

    lastStatsAt = now;
    lastStatsReceivedFrames = receivedFrames;
    lastStatsReceivedBytes = receivedBytes;
    lastStatsProcessedFrames = processedFrames;
    lastStatsDrawnFrames = drawnFrames;
    maxQueueLength = frameQueue.length;
    droppedDuplicateFrames = 0;
    droppedOverflowFrames = 0;
    droppedInactiveFrames = 0;
  }

  function markNeedsDraw() {
    needsDraw = true;
  }

  function scheduleFrameFlush() {
    if (renderRafId !== 0) return;
    renderRafId = requestAnimationFrame(flushFrameQueue);
  }

  function flushFrameQueue() {
    renderRafId = 0;
    const startedAt = performance.now();
    let processed = 0;
    const queuedAtStart = frameQueue.length;
    const maxFramesThisFlush = Math.min(queuedAtStart, BITMAP_MAX_FRAMES_PER_FLUSH);

    while (processed < maxFramesThisFlush) {
      const raw = frameQueue[processed];
      try {
        handleBitmapFrame(raw);
        processed++;
      } catch (error) {
        rdpLog.error('render', 'native frame handling failed', {
          wsPort,
          byteLength: raw.byteLength,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      if (processed > 0 && performance.now() - startedAt >= BITMAP_FLUSH_BUDGET_MS) {
        break;
      }
    }

    if (processed > 0) {
      frameQueue.splice(0, processed);
    }

    if (needsDraw) {
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      drawnFrames++;
      needsDraw = false;
    }

    const elapsed = performance.now() - startedAt;
    lastFlushMs = elapsed;
    const now = performance.now();
    const hasBacklog = frameQueue.length > 0;
    if (
      processed > 0 &&
      (elapsed > BITMAP_FLUSH_BUDGET_MS || queuedAtStart > 32 || hasBacklog) &&
      now - lastBatchLogAt > 1000
    ) {
      lastBatchLogAt = now;
      rdpLog.debug('render', 'native frame batch flushed', {
        ...logContext,
        processed,
        queuedAtStart,
        remaining: frameQueue.length,
        ms: Math.round(elapsed * 10) / 10,
      });
    }

    if (hasBacklog) {
      scheduleFrameFlush();
    } else if (highQueueLogged) {
      highQueueLogged = false;
    }
  }

  // ── Frame stats ──
  let frameCount = 0;
  let lastLogTime = performance.now();
  let firstBitmapFrameLogged = false;
  let firstGfxFrameLogged = false;

  function logFps() {
    frameCount++;
    const now = performance.now();
    if (now - lastLogTime > 10000) {
      const elapsed = (now - lastLogTime) / 1000;
      console.log(
        `[frame-ws] bitmap ${(frameCount / elapsed).toFixed(1)} fps` +
        ` (${frameCount} frames in ${elapsed.toFixed(1)}s)`,
      );
      frameCount = 0;
      lastLogTime = now;
    }
  }

  // ── WebSocket ──
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  ws.binaryType = 'arraybuffer';
  let closedByCleanup = false;
  const statsTimer = window.setInterval(() => {
    logFrameStreamStats('interval');
  }, 5000);

  ws.onopen = () => {
    console.log(`[frame-ws] connected to port ${wsPort}`);
    rdpLog.info('render', 'native frame websocket opened', logContext);
  };

  ws.onmessage = (event: MessageEvent) => {
    const raw = event.data as ArrayBuffer;
    receivedFrames++;
    receivedBytes += raw.byteLength;
    lastFrameAt = performance.now();

    if (debugContext.shouldRenderFrame && !debugContext.shouldRenderFrame()) {
      droppedInactiveFrames++;
      return;
    }

    frameQueue.push(raw);
    maxQueueLength = Math.max(maxQueueLength, frameQueue.length);
    if (frameQueue.length > BITMAP_QUEUE_COMPACT_THRESHOLD) {
      const compacted = compactNativeFrameQueue(frameQueue, {
        maxFrames: BITMAP_QUEUE_HARD_LIMIT,
      });
      if (
        compacted.droppedDuplicateFrames > 0 ||
        compacted.droppedOverflowFrames > 0
      ) {
        droppedDuplicateFrames += compacted.droppedDuplicateFrames;
        droppedOverflowFrames += compacted.droppedOverflowFrames;
        frameQueue.splice(0, frameQueue.length, ...compacted.frames);
        const now = performance.now();
        if (now - lastCompactLogAt > 1000) {
          lastCompactLogAt = now;
          rdpLog.debug('render', 'native frame queue compacted', {
            ...logContext,
            queued: frameQueue.length,
            droppedDuplicateFrames: compacted.droppedDuplicateFrames,
            droppedOverflowFrames: compacted.droppedOverflowFrames,
          });
        }
      }
    }
    if (!highQueueLogged && frameQueue.length > BITMAP_BACKLOG_WARN_THRESHOLD) {
      highQueueLogged = true;
      rdpLog.warn('render', 'native frame queue is backing up', {
        ...logContext,
        queued: frameQueue.length,
      });
    }
    scheduleFrameFlush();
  };

  // ── Bitmap frame handler (with LZ4 decompression) ──
  function handleBitmapFrame(raw: ArrayBuffer) {
    if (raw.byteLength < HEADER_SIZE) {
      rdpLog.warn('render', 'native frame too short', {
        ...logContext,
        byteLength: raw.byteLength,
      });
      return;
    }

    const hdr = new DataView(raw, 0, HEADER_SIZE);
    if (hdr.getUint16(0, true) === GFX_FRAME_MAGIC) {
      handleGfxFrame(raw);
      return;
    }

    const rawDesktopW = hdr.getUint16(0, true);
    const desktopH = hdr.getUint16(2, true);
    const x        = hdr.getUint16(4, true);
    const y        = hdr.getUint16(6, true);
    const width    = hdr.getUint16(8, true);
    const height   = hdr.getUint16(10, true);

    // Check compression flag (bit15 of desktop_width)
    const isCompressed = (rawDesktopW & 0x8000) !== 0;
    const desktopW = rawDesktopW & 0x7FFF;

    if (!firstBitmapFrameLogged) {
      firstBitmapFrameLogged = true;
      rdpLog.info('render', 'first native bitmap frame received', {
        ...logContext,
        desktopW,
        desktopH,
        x,
        y,
        width,
        height,
        compressed: isCompressed,
        byteLength: raw.byteLength,
      });
    }

    if (currentW !== desktopW || currentH !== desktopH) {
      canvas.width = desktopW;
      canvas.height = desktopH;
      gl.viewport(0, 0, desktopW, desktopH);
      currentW = desktopW;
      currentH = desktopH;

      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA,
        desktopW, desktopH, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, null,
      );
      textureInitialized = true;
      needsDraw = false;
    }

    if (!textureInitialized) return;

    let pixelData: Uint8Array;
    if (isCompressed) {
      // Compressed: [12B hdr] + [4B uncompressed_len] + [LZ4 compressed data]
      // lz4_flex::compress_prepend_size prepends 4B LE uncompressed size to LZ4 block
      // Our header adds another 4B uncompressed_len, so skip it and use the LZ4 data directly
      const lz4Data = new Uint8Array(raw, HEADER_SIZE + 4);
      pixelData = decompressLz4(lz4Data);
    } else {
      const expectedBytes = width * height * 4;
      if (raw.byteLength < HEADER_SIZE + expectedBytes) {
        rdpLog.warn('render', 'native bitmap frame payload too short', {
          ...logContext,
          width,
          height,
          expectedBytes,
          byteLength: raw.byteLength,
        });
        return;
      }
      pixelData = new Uint8Array(raw, HEADER_SIZE, expectedBytes);
    }

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0,
      x, y, width, height,
      gl.RGBA, gl.UNSIGNED_BYTE, pixelData,
    );

    markNeedsDraw();
    processedBitmapFrames++;
    onFrame?.({ desktopW, desktopH, x, y, width, height });
    logFps();
  }

  function handleGfxFrame(raw: ArrayBuffer) {
    if (!onGfxH264Frame || raw.byteLength < GFX_FRAME_HEADER_SIZE) return;

    const hdr = new DataView(raw, 0, GFX_FRAME_HEADER_SIZE);
    const kind = hdr.getUint16(2, true);
    if (kind !== GFX_FRAME_KIND_H264) return;

    const payloadLen = hdr.getUint32(16, true);
    const payloadStart = GFX_FRAME_HEADER_SIZE;
    const payloadEnd = payloadStart + payloadLen;
    if (payloadEnd > raw.byteLength) {
      rdpLog.warn('render', 'native GFX frame payload too short', {
        ...logContext,
        payloadLen,
        byteLength: raw.byteLength,
      });
      return;
    }

    const data = raw.slice(payloadStart, payloadEnd);
    if (!firstGfxFrameLogged) {
      firstGfxFrameLogged = true;
      rdpLog.info('render', 'first native GFX frame received', {
        ...logContext,
        surfaceId: hdr.getUint16(4, true),
        codecId: hdr.getUint16(6, true),
        payloadLen,
      });
    }
    onGfxH264Frame({
      surfaceId: hdr.getUint16(4, true),
      codecId: hdr.getUint16(6, true),
      left: hdr.getUint16(8, true),
      top: hdr.getUint16(10, true),
      right: hdr.getUint16(12, true),
      bottom: hdr.getUint16(14, true),
      data,
    });
    processedGfxFrames++;
    onFrame?.();
  }

  ws.onerror = (e) => {
    console.error('[frame-ws] error:', e);
    rdpLog.error('render', 'native frame websocket error', logContext);
  };

  ws.onclose = (event) => {
    console.log('[frame-ws] disconnected');
    logFrameStreamStats('close');
    window.clearInterval(statsTimer);
    rdpLog.info('render', 'native frame websocket closed', {
      ...logContext,
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
      closedByCleanup,
    });
    if (renderRafId !== 0) {
      cancelAnimationFrame(renderRafId);
      renderRafId = 0;
    }
    frameQueue.length = 0;
    if (!closedByCleanup) {
      onUnexpectedClose?.(event);
    }
  };

  // Cleanup function
  return () => {
    closedByCleanup = true;
    window.clearInterval(statsTimer);
    if (renderRafId !== 0) {
      cancelAnimationFrame(renderRafId);
      renderRafId = 0;
    }
    frameQueue.length = 0;
    if (ws.readyState <= WebSocket.OPEN) {
      ws.close();
    }
  };
}

/**
 * useNativeRdp — React hook for RDP status/pointer events.
 *
 * Frame rendering is handled by connectFrameWebSocket (raw binary).
 * This hook only manages status and pointer events.
 */
export function useNativeRdp({
  tabId,
  canvas,
  onStatus,
}: UseNativeRdpOptions) {
  const onStatusRef = useRef(onStatus);

  useEffect(() => {
    onStatusRef.current = onStatus;
  }, [onStatus]);

  useEffect(() => {
    if (!tabId) return;

    let disposed = false;
    let unlistenStatus: UnlistenFn | null = null;

    const setupStatusListener = async () => {
      const unStatus = await listen<RdpStatusEvent>('rdp://status', (e) => {
        const s = e.payload;
        if (s.tab_id !== tabId) return;
        onStatusRef.current?.(s.tab_id, s.status, s.message ?? undefined);
      });
      if (disposed) {
        unStatus();
        return;
      }
      unlistenStatus = unStatus;
    };

    setupStatusListener();

    return () => {
      disposed = true;
      unlistenStatus?.();
    };
  }, [tabId]);

  useEffect(() => {
    if (!tabId || !canvas) return;

    let disposed = false;
    let unlistenPointer: UnlistenFn | null = null;

    const setupPointerListener = async () => {
      const unPointer = await listen<RdpPointerEvent>('rdp://pointer', (e) => {
        const p = e.payload;
        if (p.tab_id !== tabId) return;

        switch (p.kind) {
          case 'default':
            canvas.style.cursor = 'default';
            break;
          case 'hidden':
            // Ignore — Windows sends PointerHidden before switching cursor.
            break;
          case 'bitmap':
            if (p.bitmap && p.width && p.height) {
              try {
                const imgData = new ImageData(
                  new Uint8ClampedArray(p.bitmap),
                  p.width,
                  p.height,
                );
                const oc = document.createElement('canvas');
                oc.width = p.width;
                oc.height = p.height;
                const ctx = oc.getContext('2d')!;
                ctx.putImageData(imgData, 0, 0);
                const hotX = p.hotspot_x ?? 0;
                const hotY = p.hotspot_y ?? 0;
                canvas.style.cursor = `url(${oc.toDataURL()}) ${hotX} ${hotY}, auto`;
              } catch {
                canvas.style.cursor = 'default';
              }
            }
            break;
        }
      });
      if (disposed) {
        unPointer();
        return;
      }
      unlistenPointer = unPointer;
    };

    setupPointerListener();

    return () => {
      disposed = true;
      unlistenPointer?.();
    };
  }, [tabId, canvas]);
}

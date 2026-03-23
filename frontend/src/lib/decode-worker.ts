/**
 * H.264 Decode Worker — offloads VideoDecoder to a dedicated thread.
 *
 * Phase 4: Receives H.264 NAL units from the main thread, decodes them
 * using WebCodecs VideoDecoder, and sends decoded VideoFrames back.
 *
 * Messages IN:  { type: 'decode', data: ArrayBuffer, timestamp: number }
 *               { type: 'configure', codec: string }
 *               { type: 'reset' }
 * Messages OUT: { type: 'frame', frame: VideoFrame }  (transferable)
 *               { type: 'error', message: string }
 */

let decoder: VideoDecoder | null = null;

function isKeyFrame(data: Uint8Array): boolean {
  for (let i = 0; i < data.length - 4; i++) {
    if (data[i] === 0 && data[i + 1] === 0) {
      let nalStart = -1;
      if (data[i + 2] === 1) {
        nalStart = i + 3;
      } else if (data[i + 2] === 0 && data[i + 3] === 1) {
        nalStart = i + 4;
      }
      if (nalStart >= 0 && nalStart < data.length) {
        const nalType = data[nalStart] & 0x1f;
        if (nalType === 5) return true; // IDR
      }
    }
  }
  return false;
}

function initDecoder(codec = 'avc1.64001f') {
  if (decoder && decoder.state !== 'closed') {
    decoder.close();
  }

  decoder = new VideoDecoder({
    output: (frame: VideoFrame) => {
      // Transfer VideoFrame back to main thread (zero-copy)
      self.postMessage({ type: 'frame', frame }, [frame] as any);
    },
    error: (err: DOMException) => {
      self.postMessage({ type: 'error', message: err.message });
    },
  });

  decoder.configure({
    codec,
    optimizeForLatency: true,
  });
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;

  switch (msg.type) {
    case 'configure': {
      initDecoder(msg.codec || 'avc1.64001f');
      break;
    }

    case 'decode': {
      if (!decoder || decoder.state === 'closed') {
        initDecoder();
      }
      const data = new Uint8Array(msg.data);
      const chunk = new EncodedVideoChunk({
        type: isKeyFrame(data) ? 'key' : 'delta',
        timestamp: msg.timestamp,
        data: msg.data,
      });
      try {
        decoder!.decode(chunk);
      } catch (err: any) {
        self.postMessage({
          type: 'error', message: err?.message || String(err),
        });
      }
      break;
    }

    case 'reset': {
      if (decoder && decoder.state !== 'closed') {
        decoder.reset();
        initDecoder();
      }
      break;
    }

    case 'close': {
      if (decoder && decoder.state !== 'closed') {
        decoder.close();
      }
      decoder = null;
      break;
    }
  }
};

// Signal ready
self.postMessage({ type: 'ready' });

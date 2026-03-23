/**
 * RDP Audio Player — Web Audio API integration for RDPSND
 *
 * Receives PCM / A-law / µ-law audio data from the WASM rdpsnd backend
 * and plays it through the browser's AudioContext.
 */

export interface AudioFormatInfo {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  formatTag: 'pcm' | 'alaw' | 'mulaw' | 'float' | 'unknown';
}

export class RdpAudioPlayer {
  private ctx: AudioContext | null = null;
  private format: AudioFormatInfo | null = null;
  private gainNode: GainNode | null = null;
  private nextPlayTime = 0;
  private _muted = false;
  private _volume = 1.0;

  /** Create audio callback for passing to the WASM SessionBuilder */
  createCallback(): (type: string, data: any) => void {
    return (type: string, data: any) => {
      switch (type) {
        case 'format':
          this.handleFormat(data as AudioFormatInfo);
          break;
        case 'wave':
          this.handleWave(data as Uint8Array);
          break;
        case 'volume':
          this.handleVolume(data);
          break;
        case 'close':
          this.handleClose();
          break;
      }
    };
  }

  private ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext();
      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = this._muted ? 0 : this._volume;
      this.gainNode.connect(this.ctx.destination);
      this.nextPlayTime = 0;
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  private handleFormat(info: AudioFormatInfo) {
    console.log('[rdp-audio] format:', info);
    this.format = info;
    // Reset play time on format change
    this.nextPlayTime = 0;

    // Recreate context if sample rate changed
    if (this.ctx && this.ctx.sampleRate !== info.sampleRate) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }

  private handleWave(rawData: Uint8Array) {
    if (!this.format) return;
    const ctx = this.ensureContext();
    const { channels, sampleRate, bitsPerSample, formatTag } = this.format;

    let floatSamples: Float32Array;

    if (formatTag === 'pcm') {
      floatSamples = this.decodePcm(rawData, bitsPerSample);
    } else if (formatTag === 'alaw') {
      floatSamples = this.decodeAlaw(rawData);
    } else if (formatTag === 'mulaw') {
      floatSamples = this.decodeMulaw(rawData);
    } else if (formatTag === 'float') {
      floatSamples = new Float32Array(rawData.buffer, rawData.byteOffset, rawData.byteLength / 4);
    } else {
      return; // Unsupported format
    }

    const numFrames = Math.floor(floatSamples.length / channels);
    if (numFrames === 0) return;

    const buffer = ctx.createBuffer(channels, numFrames, sampleRate);

    if (channels === 1) {
      buffer.copyToChannel(Float32Array.from(floatSamples.subarray(0, numFrames)), 0);
    } else {
      // De-interleave stereo
      const left = new Float32Array(numFrames);
      const right = new Float32Array(numFrames);
      for (let i = 0; i < numFrames; i++) {
        left[i] = floatSamples[i * 2];
        right[i] = floatSamples[i * 2 + 1];
      }
      buffer.copyToChannel(Float32Array.from(left), 0);
      buffer.copyToChannel(Float32Array.from(right), 1);
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gainNode!);

    const now = ctx.currentTime;
    if (this.nextPlayTime < now) {
      this.nextPlayTime = now;
    }
    source.start(this.nextPlayTime);
    this.nextPlayTime += buffer.duration;
  }

  private handleVolume(vol: { left: number; right: number }) {
    // RDP volume: 0-65535, normalize to 0-1
    const avg = ((vol.left + vol.right) / 2) / 65535;
    this._volume = avg;
    if (this.gainNode && !this._muted) {
      this.gainNode.gain.setValueAtTime(avg, this.ctx!.currentTime);
    }
    console.log('[rdp-audio] volume:', avg.toFixed(2));
  }

  private handleClose() {
    console.log('[rdp-audio] close');
    this.nextPlayTime = 0;
  }

  /** Convert PCM bytes to Float32Array (-1..1) */
  private decodePcm(data: Uint8Array, bits: number): Float32Array {
    if (bits === 16) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const samples = new Float32Array(data.byteLength / 2);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = view.getInt16(i * 2, true) / 32768;
      }
      return samples;
    }
    if (bits === 8) {
      const samples = new Float32Array(data.length);
      for (let i = 0; i < data.length; i++) {
        samples[i] = (data[i] - 128) / 128;
      }
      return samples;
    }
    // Fallback: treat as 16-bit
    return this.decodePcm(data, 16);
  }

  /** A-law → linear PCM (ITU-T G.711) */
  private decodeAlaw(data: Uint8Array): Float32Array {
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
      out[i] = alawToLinear(data[i]) / 32768;
    }
    return out;
  }

  /** µ-law → linear PCM (ITU-T G.711) */
  private decodeMulaw(data: Uint8Array): Float32Array {
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
      out[i] = ulawToLinear(data[i]) / 32768;
    }
    return out;
  }

  // ── Public API ──

  get muted() { return this._muted; }
  set muted(v: boolean) {
    this._muted = v;
    if (this.gainNode && this.ctx) {
      this.gainNode.gain.setValueAtTime(v ? 0 : this._volume, this.ctx.currentTime);
    }
  }

  get volume() { return this._volume; }
  set volume(v: number) {
    this._volume = Math.max(0, Math.min(1, v));
    if (this.gainNode && this.ctx && !this._muted) {
      this.gainNode.gain.setValueAtTime(this._volume, this.ctx.currentTime);
    }
  }

  destroy() {
    if (this.ctx && this.ctx.state !== 'closed') {
      this.ctx.close().catch(() => {});
    }
    this.ctx = null;
    this.gainNode = null;
    this.format = null;
    this.nextPlayTime = 0;
  }
}

// ── G.711 decoding tables ──

function alawToLinear(alaw: number): number {
  let a = alaw ^ 0x55;
  let sign = (a & 0x80) ? -1 : 1;
  a &= 0x7f;
  const seg = (a >> 4) & 0x07;
  const quant = a & 0x0f;
  let val: number;
  if (seg === 0) {
    val = (quant * 2 + 1) * 2;
  } else {
    val = ((quant * 2 + 33) << (seg - 1)) * 2;
  }
  return sign * val;
}

function ulawToLinear(ulaw: number): number {
  let u = ~ulaw & 0xff;
  const sign = (u & 0x80) ? -1 : 1;
  u &= 0x7f;
  const seg = (u >> 4) & 0x07;
  const quant = u & 0x0f;
  const val = ((quant * 2 + 33) << seg) - 33;
  return sign * val;
}

/**
 * RDP Audio Player — Automated unit tests
 *
 * Tests PCM / A-law / µ-law decoding, callback dispatch,
 * volume control, stereo de-interleave, and lifecycle management.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Install Web Audio API mock BEFORE importing the module under test
import {
  installWebAudioMock,
  removeWebAudioMock,
  MockAudioContext,
  MockAudioBuffer,
} from './mocks/web-audio-mock';

// Mock rdp-logger to avoid Tauri invoke in test env
vi.mock('@/lib/rdp-logger', () => ({
  rdpLog: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
  },
}));

import { RdpAudioPlayer, type AudioFormatInfo } from '@/lib/rdp-audio';

describe('RdpAudioPlayer', () => {
  let player: RdpAudioPlayer;

  beforeEach(() => {
    installWebAudioMock();
    player = new RdpAudioPlayer();
  });

  afterEach(() => {
    player.destroy();
    removeWebAudioMock();
  });

  // ── Helper: send format then wave via callback ──
  function sendFormat(
    cb: (type: string, data: any) => void,
    override: Partial<AudioFormatInfo> = {},
  ) {
    const fmt: AudioFormatInfo = {
      channels: 1,
      sampleRate: 44100,
      bitsPerSample: 16,
      formatTag: 'pcm',
      ...override,
    };
    cb('format', fmt);
    return fmt;
  }

  // ════════════════════════════════════════
  // 1. Callback dispatch
  // ════════════════════════════════════════
  describe('Callback 分发', () => {
    it('createCallback 返回函数，正确路由 format/wave/volume/close', () => {
      const cb = player.createCallback();
      expect(typeof cb).toBe('function');

      // format → should not throw
      cb('format', {
        channels: 2, sampleRate: 48000, bitsPerSample: 16, formatTag: 'pcm',
      });

      // wave → needs format first (already set above)
      const pcm16 = new Uint8Array([0, 0]); // silence
      cb('wave', pcm16);

      // volume
      cb('volume', { left: 32768, right: 32768 });

      // close
      cb('close', null);

      // unknown type → no crash
      cb('unknown_event', {});
    });
  });

  // ════════════════════════════════════════
  // 2. PCM 16-bit decoding
  // ════════════════════════════════════════
  describe('PCM 16-bit 解码', () => {
    it('将有符号 16-bit LE 正确转换为 Float32 [-1, 1]', () => {
      const cb = player.createCallback();
      sendFormat(cb, { channels: 1, sampleRate: 44100, bitsPerSample: 16 });

      // Known samples: 0x0000=0, 0x7FFF=32767, 0x0080=−32768 (LE)
      const data = new Uint8Array([
        0x00, 0x00,  // 0  → 0.0
        0xFF, 0x7F,  // 32767  → ~0.99997
        0x00, 0x80,  // -32768 → -1.0
      ]);
      cb('wave', data);

      // Verify buffer was created and data written
      const ctx = (player as any).ctx as MockAudioContext;
      expect(ctx.createBuffer).toHaveBeenCalledWith(1, 3, 44100);

      const buf = ctx.createBuffer.mock.results[0].value as MockAudioBuffer;
      expect(buf.copyToChannel).toHaveBeenCalled();

      const ch0 = buf.channelData.get(0)!;
      expect(ch0[0]).toBeCloseTo(0, 4);
      expect(ch0[1]).toBeCloseTo(32767 / 32768, 4);
      expect(ch0[2]).toBeCloseTo(-1, 4);
    });
  });

  // ════════════════════════════════════════
  // 3. PCM 8-bit decoding
  // ════════════════════════════════════════
  describe('PCM 8-bit 解码', () => {
    it('将无符号 8-bit 正确转换为 Float32', () => {
      const cb = player.createCallback();
      sendFormat(cb, { channels: 1, sampleRate: 8000, bitsPerSample: 8 });

      // 128=silence(0), 255=max(~1.0), 0=min(−1.0)
      const data = new Uint8Array([128, 255, 0]);
      cb('wave', data);

      const ctx = (player as any).ctx as MockAudioContext;
      const buf = ctx.createBuffer.mock.results[0].value as MockAudioBuffer;
      const ch0 = buf.channelData.get(0)!;

      expect(ch0[0]).toBeCloseTo(0, 2);
      expect(ch0[1]).toBeCloseTo(127 / 128, 2);
      expect(ch0[2]).toBeCloseTo(-128 / 128, 2);
    });
  });

  // ════════════════════════════════════════
  // 4. A-law decoding (G.711)
  // ════════════════════════════════════════
  describe('A-law 解码', () => {
    it('ITU-T G.711 A-law 已知向量验证', () => {
      const cb = player.createCallback();
      sendFormat(cb, {
        channels: 1, sampleRate: 8000, bitsPerSample: 8, formatTag: 'alaw',
      });

      // A-law encoded silence = 0xD5
      // A-law encoded max positive = 0x2A
      const data = new Uint8Array([0xD5, 0x2A]);
      cb('wave', data);

      const ctx = (player as any).ctx as MockAudioContext;
      const buf = ctx.createBuffer.mock.results[0].value as MockAudioBuffer;
      const ch0 = buf.channelData.get(0)!;

      // Values should be finite, in [-1, 1] range
      expect(ch0[0]).toBeGreaterThanOrEqual(-1);
      expect(ch0[0]).toBeLessThanOrEqual(1);
      // 0xD5 XOR 0x55 = 0x80 → sign bit set, seg=0, quant=0 → small value near 0
      expect(Math.abs(ch0[0])).toBeLessThan(0.01);
    });
  });

  // ════════════════════════════════════════
  // 5. µ-law decoding (G.711)
  // ════════════════════════════════════════
  describe('µ-law 解码', () => {
    it('ITU-T G.711 µ-law 已知向量验证', () => {
      const cb = player.createCallback();
      sendFormat(cb, {
        channels: 1, sampleRate: 8000, bitsPerSample: 8, formatTag: 'mulaw',
      });

      // µ-law encoded silence = 0xFF, max positive = 0x80
      const data = new Uint8Array([0xFF, 0x80]);
      cb('wave', data);

      const ctx = (player as any).ctx as MockAudioContext;
      const buf = ctx.createBuffer.mock.results[0].value as MockAudioBuffer;
      const ch0 = buf.channelData.get(0)!;

      // 0xFF → ~0 (near silence): ~0xFF = 0x00, sign=0, seg=0, quant=0 → val=33-33=0
      expect(Math.abs(ch0[0])).toBeLessThan(0.01);
      // 0x80 → ~0x80 = 0x7F, sign=0, seg=7, quant=15 → large positive value
      expect(ch0[1]).toBeGreaterThan(0.1);
    });
  });

  // ════════════════════════════════════════
  // 6. Stereo de-interleave
  // ════════════════════════════════════════
  describe('Stereo 解交织', () => {
    it('双声道 L/R 正确分离到各通道', () => {
      const cb = player.createCallback();
      sendFormat(cb, { channels: 2, sampleRate: 44100, bitsPerSample: 16 });

      // 2 frames, interleaved: [L0, R0, L1, R1]
      // L0=16384(0x4000), R0=-16384(0xC000), L1=8192(0x2000), R1=-8192(0xE000)
      const buf = new ArrayBuffer(8);
      const view = new DataView(buf);
      view.setInt16(0, 16384, true);   // L0
      view.setInt16(2, -16384, true);  // R0
      view.setInt16(4, 8192, true);    // L1
      view.setInt16(6, -8192, true);   // R1

      cb('wave', new Uint8Array(buf));

      const ctx = (player as any).ctx as MockAudioContext;
      const abuf = ctx.createBuffer.mock.results[0].value as MockAudioBuffer;

      // Should create stereo buffer
      expect(ctx.createBuffer).toHaveBeenCalledWith(2, 2, 44100);
      expect(abuf.copyToChannel).toHaveBeenCalledTimes(2);

      const left = abuf.channelData.get(0)!;
      const right = abuf.channelData.get(1)!;

      expect(left[0]).toBeCloseTo(16384 / 32768, 4);
      expect(left[1]).toBeCloseTo(8192 / 32768, 4);
      expect(right[0]).toBeCloseTo(-16384 / 32768, 4);
      expect(right[1]).toBeCloseTo(-8192 / 32768, 4);
    });
  });

  // ════════════════════════════════════════
  // 7. Volume control
  // ════════════════════════════════════════
  describe('音量控制', () => {
    it('RDP volume (0-65535) 正确 normalize 到 0-1', () => {
      const cb = player.createCallback();
      sendFormat(cb, { channels: 1, sampleRate: 44100, bitsPerSample: 16 });
      // Trigger context creation
      cb('wave', new Uint8Array([0, 0, 0, 0]));

      cb('volume', { left: 65535, right: 65535 });
      expect(player.volume).toBeCloseTo(1.0, 2);

      cb('volume', { left: 0, right: 0 });
      expect(player.volume).toBeCloseTo(0.0, 2);

      cb('volume', { left: 32768, right: 32768 });
      expect(player.volume).toBeCloseTo(0.5, 1);
    });
  });

  // ════════════════════════════════════════
  // 8. Mute toggle
  // ════════════════════════════════════════
  describe('静音控制', () => {
    it('muted 属性切换 → gain 设为 0/恢复', () => {
      const cb = player.createCallback();
      sendFormat(cb, { channels: 1, sampleRate: 44100, bitsPerSample: 16 });
      cb('wave', new Uint8Array([0, 0]));

      const ctx = (player as any).ctx as MockAudioContext;
      const gain = ctx.lastGainNode;

      player.muted = true;
      expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0, expect.any(Number));
      expect(player.muted).toBe(true);

      player.muted = false;
      // Should restore to current volume
      expect(gain.gain.value).toBeGreaterThan(0);
    });
  });

  // ════════════════════════════════════════
  // 9. Format change (sampleRate)
  // ════════════════════════════════════════
  describe('格式切换', () => {
    it('sampleRate 变化时重建 AudioContext', () => {
      const cb = player.createCallback();
      sendFormat(cb, { channels: 1, sampleRate: 44100, bitsPerSample: 16 });
      cb('wave', new Uint8Array([0, 0]));

      const ctx1 = (player as any).ctx as MockAudioContext;
      expect(ctx1).toBeTruthy();

      // Change format with different sample rate
      sendFormat(cb, { channels: 1, sampleRate: 48000, bitsPerSample: 16 });

      // Old context should be closed
      expect(ctx1.close).toHaveBeenCalled();
      // Internal ctx should be cleared (new one created on next wave)
      expect((player as any).ctx).toBeNull();
    });
  });

  // ════════════════════════════════════════
  // 10. Destroy lifecycle
  // ════════════════════════════════════════
  describe('Destroy 生命周期', () => {
    it('调用 destroy() 后 context 关闭、引用清空', () => {
      const cb = player.createCallback();
      sendFormat(cb, { channels: 1, sampleRate: 44100, bitsPerSample: 16 });
      cb('wave', new Uint8Array([0, 0]));

      const ctx = (player as any).ctx as MockAudioContext;
      expect(ctx).toBeTruthy();

      player.destroy();

      expect(ctx.close).toHaveBeenCalled();
      expect((player as any).ctx).toBeNull();
      expect((player as any).gainNode).toBeNull();
      expect((player as any).format).toBeNull();
    });
  });

  // ════════════════════════════════════════
  // 11. No-format guard
  // ════════════════════════════════════════
  describe('无格式保护', () => {
    it('format 未设置时 wave 数据被安全丢弃', () => {
      const cb = player.createCallback();
      // Do NOT send format — go straight to wave
      cb('wave', new Uint8Array([0x00, 0x00]));

      // No AudioContext should have been created
      expect((player as any).ctx).toBeNull();
    });
  });

  // ════════════════════════════════════════
  // 12. Float format passthrough
  // ════════════════════════════════════════
  describe('Float32 直通', () => {
    it('float 格式数据直接作为 Float32Array 使用', () => {
      const cb = player.createCallback();
      sendFormat(cb, {
        channels: 1, sampleRate: 44100, bitsPerSample: 32, formatTag: 'float',
      });

      const floats = new Float32Array([0.5, -0.5, 0.25]);
      const bytes = new Uint8Array(floats.buffer);
      cb('wave', bytes);

      const ctx = (player as any).ctx as MockAudioContext;
      const buf = ctx.createBuffer.mock.results[0].value as MockAudioBuffer;
      const ch0 = buf.channelData.get(0)!;

      expect(ch0[0]).toBeCloseTo(0.5, 4);
      expect(ch0[1]).toBeCloseTo(-0.5, 4);
      expect(ch0[2]).toBeCloseTo(0.25, 4);
    });
  });
});

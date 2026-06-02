/**
 * Web Audio API mock for Vitest/jsdom environment.
 * Provides minimal AudioContext, GainNode, AudioBuffer, AudioBufferSourceNode
 * stubs so that RdpAudioPlayer can be unit-tested without real audio hardware.
 */
import { vi } from 'vitest';

// ── AudioParam mock ──
class MockAudioParam {
  value = 1;
  defaultValue = 1;
  minValue = -3.4028235e38;
  maxValue = 3.4028235e38;
  setValueAtTime = vi.fn((value: number, _time: number) => {
    this.value = value;
    return this;
  });
  linearRampToValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
}

// ── GainNode mock ──
export class MockGainNode {
  gain = new MockAudioParam();
  connect = vi.fn(() => this);
  disconnect = vi.fn();
}

// ── AudioBuffer mock ──
export class MockAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly duration: number;
  channelData: Map<number, Float32Array> = new Map();

  constructor(opts: { numberOfChannels: number; length: number; sampleRate: number }) {
    this.numberOfChannels = opts.numberOfChannels;
    this.length = opts.length;
    this.sampleRate = opts.sampleRate;
    this.duration = opts.length / opts.sampleRate;
  }

  copyToChannel = vi.fn((source: Float32Array, channel: number) => {
    this.channelData.set(channel, Float32Array.from(source));
  });

  getChannelData(channel: number): Float32Array {
    return this.channelData.get(channel) ?? new Float32Array(this.length);
  }
}

// ── AudioBufferSourceNode mock ──
export class MockAudioBufferSourceNode {
  buffer: MockAudioBuffer | null = null;
  connect = vi.fn(() => this);
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
}

// ── AudioContext mock ──
export class MockAudioContext {
  state: AudioContextState = 'running';
  sampleRate = 44100;
  currentTime = 0;

  private _gainNode = new MockGainNode();

  createGain = vi.fn(() => this._gainNode);

  createBuffer = vi.fn(
    (channels: number, length: number, sampleRate: number) =>
      new MockAudioBuffer({ numberOfChannels: channels, length, sampleRate }),
  );

  createBufferSource = vi.fn(() => new MockAudioBufferSourceNode());

  get destination() {
    return {} as AudioDestinationNode;
  }

  resume = vi.fn(async () => {
    this.state = 'running';
  });

  close = vi.fn(async () => {
    this.state = 'closed';
  });

  /** Helper: get the last created GainNode */
  get lastGainNode(): MockGainNode {
    return this._gainNode;
  }
}

/**
 * Install the mock AudioContext on globalThis.
 * Call in beforeEach / setup to enable tests.
 */
export function installWebAudioMock() {
  (globalThis as any).AudioContext = MockAudioContext;
  (globalThis as any).webkitAudioContext = MockAudioContext;
}

/**
 * Remove the mock from globalThis.
 */
export function removeWebAudioMock() {
  delete (globalThis as any).AudioContext;
  delete (globalThis as any).webkitAudioContext;
}

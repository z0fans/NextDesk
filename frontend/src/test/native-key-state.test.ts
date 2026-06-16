import { describe, expect, it } from 'vitest';
import { NativePressedKeyTracker } from '@/lib/native-key-state';

describe('NativePressedKeyTracker', () => {
  it('releases tracked native keys exactly once on focus loss', () => {
    const tracker = new NativePressedKeyTracker();
    const released: number[] = [];

    tracker.press(0x2A);
    tracker.press(0x1D);
    tracker.release(0x1D);
    tracker.releaseAll(scancode => released.push(scancode));
    tracker.releaseAll(scancode => released.push(scancode));

    expect(released).toEqual([0x2A]);
  });

  it('handles extended native scancodes in releaseAll', () => {
    const tracker = new NativePressedKeyTracker();
    const released: number[] = [];

    tracker.press(0xE01D);
    tracker.press(0xE05B);
    tracker.releaseAll(scancode => released.push(scancode));

    expect(released).toEqual([0xE01D, 0xE05B]);
  });
});

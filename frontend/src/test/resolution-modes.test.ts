import { describe, expect, it } from 'vitest';
import {
  planKktermLocalScaling,
  supportsKktermLocalScaling,
} from '@/rdp/resolution-modes';

describe('KKTerm local scaling modes', () => {
  it('is available on both supported desktop platforms', () => {
    expect(supportsKktermLocalScaling('windows')).toBe(true);
    expect(supportsKktermLocalScaling('macos')).toBe(true);
    expect(supportsKktermLocalScaling('other')).toBe(false);
  });

  it('keeps the current remote desktop size on macOS without reconnecting', () => {
    expect(planKktermLocalScaling(
      'macos',
      { w: 1440, h: 900 },
      { w: 1920, h: 1080 },
    )).toEqual({
      desktopSize: { w: 1440, h: 900 },
      reconnect: false,
    });
  });

  it('reconnects Windows into ActiveX SmartSizing and normalizes fallback size', () => {
    expect(planKktermLocalScaling(
      'windows',
      { w: 0, h: 0 },
      { w: 100.4, h: 80.6 },
    )).toEqual({
      desktopSize: { w: 320, h: 240 },
      reconnect: true,
    });
  });
});

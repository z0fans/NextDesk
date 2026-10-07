import { describe, expect, it } from 'vitest';
import {
  planKktermLocalScaling,
  restoreRdpResolution,
  supportsKktermLocalScaling,
} from '@/rdp/resolution-modes';

it('restores the selected mode and initial connection size', () => {
  for (const mode of ['1920x1080', '1600x900', '1440x900', '1366x768', '1280x720']) {
    const [w, h] = mode.split('x').map(Number);
    expect(restoreRdpResolution(mode, false)).toEqual({ mode, desktopSize: { w, h } });
  }
  expect(restoreRdpResolution('adaptive', true)).toEqual({ mode: 'adaptive', desktopSize: null });
  expect(restoreRdpResolution('smartSizing', true)).toEqual({ mode: 'smartSizing', desktopSize: null });
  for (const mode of ['smartSizing', 'invalid', '99999x99999']) {
    expect(restoreRdpResolution(mode, false)).toEqual({ mode: 'adaptive', desktopSize: null });
  }
});

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

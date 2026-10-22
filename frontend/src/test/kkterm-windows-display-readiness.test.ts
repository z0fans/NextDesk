import { describe, expect, it } from 'vitest';
import {
  isKktermWindowsDisplayReady,
  shouldRevealKktermWindowsSurface,
} from '@/rdp/kkterm/windows-display-readiness';

describe('KKTerm Windows display readiness', () => {
  it('does not treat an establishing ActiveX session as display-ready', () => {
    const establishing = {
      connectionState: 2,
      connected: false,
      displaySynced: true,
      surfaceReady: true,
    };

    expect(shouldRevealKktermWindowsSurface(establishing)).toBe(false);
    expect(isKktermWindowsDisplayReady(establishing)).toBe(false);
  });

  it('does not report success while the native surface is still hidden', () => {
    const hidden = {
      connectionState: 1,
      connected: true,
      displaySynced: true,
      surfaceReady: false,
    };

    expect(shouldRevealKktermWindowsSurface(hidden)).toBe(true);
    expect(isKktermWindowsDisplayReady(hidden)).toBe(false);
  });

  it('requires both a connected session and a visible on-screen native surface', () => {
    const visible = {
      connectionState: 1,
      connected: true,
      displaySynced: true,
      surfaceReady: true,
    };

    expect(shouldRevealKktermWindowsSurface(visible)).toBe(true);
    expect(isKktermWindowsDisplayReady(visible)).toBe(true);
  });
});

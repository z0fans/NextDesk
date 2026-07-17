import { describe, expect, it } from 'vitest';
import {
  canRecoverKktermWindowsResize,
  KKTERM_WINDOWS_RESIZE_RECOVERY_COOLDOWN_MS,
} from '@/rdp/kkterm/resize-recovery';

describe('KKTerm Windows resize recovery', () => {
  it('allows the first failed adaptive resize to reconnect', () => {
    expect(canRecoverKktermWindowsResize(10_000, undefined)).toBe(true);
  });

  it('blocks reconnect loops during the recovery cooldown', () => {
    expect(canRecoverKktermWindowsResize(20_000, 19_000)).toBe(false);
    expect(canRecoverKktermWindowsResize(
      19_000 + KKTERM_WINDOWS_RESIZE_RECOVERY_COOLDOWN_MS,
      19_000,
    )).toBe(true);
  });
});

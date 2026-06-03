import { describe, expect, it } from 'vitest';
import { isNonRecoverableRdpError } from '@/lib/rdp-errors';

describe('isNonRecoverableRdpError', () => {
  it('treats RDPGFX H.264 negotiation failure as non-recoverable', () => {
    expect(isNonRecoverableRdpError(
      'Session error: [RDPGFX] reason: RDPGFX H.264 test mode is active, but the server did not negotiate AVC420/H.264',
    )).toBe(true);
  });

  it('keeps generic transport failures recoverable', () => {
    expect(isNonRecoverableRdpError('read frame timed out')).toBe(false);
  });
});

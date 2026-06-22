import { describe, expect, it } from 'vitest';
import { createRdpSessionId } from '@/rdp/kkterm/kktermSession';

describe('KKTerm RDP session id', () => {
  it('is stable for the same connection id', () => {
    expect(createRdpSessionId('tab-public-1')).toBe(createRdpSessionId('tab-public-1'));
  });

  it('uses only backend-safe characters and stays within the session id limit', () => {
    const id = createRdpSessionId('tab:/公网 RDP with spaces and symbols!'.repeat(4));
    expect(id).toMatch(/^rdp-[A-Za-z0-9_-]+$/);
    expect(id.length).toBeLessThanOrEqual(96);
  });
});

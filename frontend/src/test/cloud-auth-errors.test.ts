import { describe, expect, it } from 'vitest';
import { cloudAuthErrorKey } from '@/lib/cloud-auth-errors';

describe('cloudAuthErrorKey', () => {
  it('maps the device limit response to a useful account error', () => {
    expect(cloudAuthErrorKey('cloud_auth_too_many_devices (HTTP 429)'))
      .toBe('cloudAuthorizationTooManyDevices');
  });

  it('keeps a generic 429 distinct from the device limit', () => {
    expect(cloudAuthErrorKey('cloud_auth_rate_limited (HTTP 429)'))
      .toBe('cloudAuthorizationRateLimited');
  });

  it('maps the authenticated gateway rate limit without requiring HTTP text', () => {
    expect(cloudAuthErrorKey('cloud_rate_limited')).toBe('cloudRateLimited');
  });
});

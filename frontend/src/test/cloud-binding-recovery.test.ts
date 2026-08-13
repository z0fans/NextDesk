import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import {
  cloudBindingKeepaliveAction,
  recoverGoneCloudBinding,
} from '@/rdp/cloud-binding-recovery';

describe('cloud binding keepalive recovery', () => {
  it('replaces the route when the control plane reports that the binding is gone', () => {
    expect(cloudBindingKeepaliveAction('cloud_binding_gone')).toBe('replace-route');
    expect(cloudBindingKeepaliveAction(new Error('cloud_binding_gone'))).toBe('replace-route');
  });

  it('retains the current route for a transient keepalive failure', () => {
    expect(cloudBindingKeepaliveAction('cloud renew request failed: connection reset'))
      .toBe('retain-route');

    const stopKeepalive = vi.fn();
    const replaceRoute = vi.fn();
    expect(recoverGoneCloudBinding(
      'cloud renew request failed: connection reset',
      { stopKeepalive, replaceRoute },
    )).toBe(false);
    expect(stopKeepalive).not.toHaveBeenCalled();
    expect(replaceRoute).not.toHaveBeenCalled();
  });

  it('stops keepalive and replaces the invalid route exactly once', () => {
    const stopKeepalive = vi.fn();
    const replaceRoute = vi.fn();

    expect(recoverGoneCloudBinding('cloud_binding_gone', { stopKeepalive, replaceRoute }))
      .toBe(true);
    expect(stopKeepalive).toHaveBeenCalledTimes(1);
    expect(replaceRoute).toHaveBeenCalledTimes(1);
  });
});

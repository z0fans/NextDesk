import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  Channel: class<T> { onmessage?: (message: T) => void },
}));

import { api } from '@/api';

describe('connection outcome IPC bridge', () => {
  beforeEach(() => invokeMock.mockReset());

  it('loads and saves the RDP resolution preference through native config', async () => {
    invokeMock.mockResolvedValueOnce('1920x1080').mockResolvedValueOnce(undefined);
    expect(await api.rdpResolutionGet()).toBe('1920x1080');
    await api.rdpResolutionSet('1280x720');
    expect(invokeMock.mock.calls).toEqual([
      ['rdp_resolution_get'],
      ['rdp_resolution_set', { mode: '1280x720' }],
    ]);
  });

  it('reports a protocol-neutral RDP lifecycle outcome without connection secrets', async () => {
    invokeMock.mockResolvedValue(undefined);

    await api.connectionOutcomeReport({
      sessionId: 'rdp-tab-1',
      serviceKind: 'rdp',
      status: 'failed',
      stage: 'transport',
      errorCode: 'rdp_transport_timeout',
      durationMs: 15000,
      userInitiated: false,
      stageDurationsMs: { scheduling: 90, transport: 14910 },
    });

    expect(invokeMock).toHaveBeenCalledWith('connection_outcome_report', {
      input: {
        sessionId: 'rdp-tab-1',
        serviceKind: 'rdp',
        status: 'failed',
        stage: 'transport',
        errorCode: 'rdp_transport_timeout',
        durationMs: 15000,
        userInitiated: false,
        stageDurationsMs: { scheduling: 90, transport: 14910 },
      },
    });
    expect(JSON.stringify(invokeMock.mock.calls)).not.toContain('password');
    expect(JSON.stringify(invokeMock.mock.calls)).not.toContain('username');
  });

  it('requests privacy-safe route health evidence by service and session only', async () => {
    invokeMock.mockResolvedValue({ supported: true, recommendation: false });

    await api.connectionRouteHealthCheck('ssh', 'ssh-tab-1');

    expect(invokeMock).toHaveBeenCalledWith('connection_route_health_check', {
      serviceKind: 'ssh',
      sessionId: 'ssh-tab-1',
    });
  });

  it('persists the anonymous quality feedback opt-out through the native config', async () => {
    invokeMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(api.anonymousQualityFeedbackGet()).resolves.toBe(true);
    await expect(api.anonymousQualityFeedbackSet(false)).resolves.toBe(false);

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'anonymous_quality_feedback_get');
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'anonymous_quality_feedback_set', {
      enabled: false,
    });
  });
});

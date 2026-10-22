import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RdpConnectionOutcomes, readRdpFailure } from '@/rdp/connection-outcomes';

describe('RDP attempt outcome ownership', () => {
  const send = vi.fn();
  let outcomes: RdpConnectionOutcomes;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    send.mockReset();
    outcomes = new RdpConnectionOutcomes(send);
    outcomes.begin('tab', 'attempt-1');
  });
  afterEach(() => vi.useRealTimers());

  it('reports only one terminal outcome across competing event sources', () => {
    outcomes.report('tab', 'failed', 'transport', { error: 'timed out', sourceRouteLeaseId: 7 });
    outcomes.report('tab', 'disconnected', 'disconnected');
    outcomes.report('tab', 'connected', 'first_interactive_result');
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: 'attempt-1', eventId: 'attempt-1-failed-transport',
      routeLeaseId: 7, errorCode: 'rdp_transport_timeout',
    }));
  });

  it('keeps backend-owned startup failures terminal without sending a second report', () => {
    outcomes.report('tab', 'failed', 'transport', {
      error: { message: 'refused', outcomeReported: true },
    });
    outcomes.report('tab', 'failed', 'disconnected', { error: 'closed' });
    expect(send).not.toHaveBeenCalled();
  });

  it('ignores stale attempts and resets first-frame and terminal state on replacement', () => {
    outcomes.report('tab', 'connected', 'first_interactive_result');
    outcomes.report('tab', 'connected', 'first_interactive_result');
    outcomes.begin('tab', 'attempt-2');
    outcomes.report('tab', 'failed', 'transport', { sourceAttemptId: 'attempt-1' });
    outcomes.report('tab', 'connected', 'first_interactive_result', { sourceAttemptId: 'attempt-2' });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([input]) => input.attemptId)).toEqual(['attempt-1', 'attempt-2']);
  });

  it('does not recreate an attempt from events after close', () => {
    outcomes.forget('tab');
    outcomes.report('tab', 'failed', 'transport');
    expect(outcomes.attemptId('tab')).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('drops all late events after the workspace unmounts', () => {
    outcomes.begin('other', 'other-attempt');
    outcomes.dispose();
    outcomes.report('tab', 'failed', 'transport');
    outcomes.report('other', 'failed', 'transport');
    expect(send).not.toHaveBeenCalled();
  });

  it('tracks elapsed stages and session duration without inheriting previous attempts', () => {
    outcomes.report('tab', 'connecting', 'transport', { useCurrentRoute: false, sourceRouteLeaseId: 9 });
    vi.advanceTimersByTime(200);
    outcomes.report('tab', 'connecting', 'authentication');
    vi.advanceTimersByTime(100);
    outcomes.report('tab', 'connected', 'session_established');
    vi.advanceTimersByTime(500);
    outcomes.report('tab', 'disconnected', 'disconnected', { userInitiated: true });
    expect(send.mock.calls[0][0].routeLeaseId).toBeUndefined();
    expect(send.mock.lastCall?.[0]).toMatchObject({
      sessionDurationMs: 500, userInitiated: true,
      stageDurationsMs: { transport: 200, authentication: 100, session_established: 500 },
    });
    outcomes.begin('tab', 'attempt-2');
    outcomes.report('tab', 'failed', 'transport');
    expect(send.mock.lastCall?.[0]).toMatchObject({ durationMs: 0, stageDurationsMs: { transport: 0 } });
  });

  it('extracts typed ownership without treating arbitrary truthy values as reported', () => {
    expect(readRdpFailure({ message: 'refused', outcomeReported: true })).toEqual({ message: 'refused', outcomeReported: true });
    expect(readRdpFailure({ message: 'refused', outcomeReported: 'true' }).outcomeReported).toBe(false);
    expect(readRdpFailure(new Error('refused'))).toEqual({ message: 'refused', outcomeReported: false });
    expect(readRdpFailure({ backtrace: () => 'TLS handshake failed' }).message).toBe('TLS handshake failed');
  });
});

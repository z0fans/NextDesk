import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RouteHealthAssessment } from '@/api';

const connectionRouteHealthCheck = vi.hoisted(() => vi.fn());

vi.mock('@/api', () => ({
  api: { connectionRouteHealthCheck },
}));

vi.mock('@/i18n/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import {
  EMPTY_ROUTE_DEGRADATION_TRACKER,
  updateRouteDegradationTracker,
} from '@/lib/route-degradation';
import { RouteDegradationNotice } from '@/components/RouteDegradationNotice';

const advantage: RouteHealthAssessment = {
  supported: true,
  checkedAtMs: 1,
  recommendation: true,
  thresholdPercent: 20,
  checkIntervalMs: 15_000,
  requiredObservations: 2,
  recoveryObservations: 2,
  improvementPercent: 35,
  reason: 'better_route_observed',
  current: { routeLabel: 'cloud', reachable: true, scoreMs: 200, candidateRef: 'agent-a' },
  alternative: { routeLabel: 'cloud', reachable: true, scoreMs: 130, candidateRef: 'agent-b' },
};

const healthy: RouteHealthAssessment = {
  ...advantage,
  recommendation: false,
  improvementPercent: 5,
  reason: 'improvement_below_threshold',
};

describe('route degradation hysteresis', () => {
  it('requires a stable repeated advantage before showing and two recovery checks before hiding', () => {
    const first = updateRouteDegradationTracker(EMPTY_ROUTE_DEGRADATION_TRACKER, advantage, 0);
    expect(first.visible).toBeUndefined();

    const stable = updateRouteDegradationTracker(first, advantage, 15_000);
    expect(stable.visible).toEqual(advantage);

    const firstRecovery = updateRouteDegradationTracker(stable, healthy, 30_000);
    expect(firstRecovery.visible).toEqual(advantage);

    const recovered = updateRouteDegradationTracker(firstRecovery, healthy, 45_000);
    expect(recovered.visible).toBeUndefined();
  });

  it('does not carry observations across different alternatives', () => {
    const first = updateRouteDegradationTracker(EMPTY_ROUTE_DEGRADATION_TRACKER, advantage, 0);
    const changed = updateRouteDegradationTracker(first, {
      ...advantage,
      alternative: { ...advantage.alternative!, candidateRef: 'agent-c' },
    }, 15_000);

    expect(changed.advantageObservations).toBe(1);
    expect(changed.visible).toBeUndefined();
  });
});

describe('RouteDegradationNotice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    connectionRouteHealthCheck.mockReset().mockResolvedValue(advantage);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the session connected until the user confirms a one-click reconnect', async () => {
    const onReconnect = vi.fn();
    render(
      <RouteDegradationNotice
        serviceKind="ssh"
        sessionId="ssh-a"
        enabled
        onReconnect={onReconnect}
      />,
    );

    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getByRole('status', { name: 'routeQualityDegraded' })).toBeInTheDocument();
    expect(onReconnect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'routeQualityReconnect' }));
    expect(screen.getByText('routeQualityReconnectWarning')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'routeQualityConfirmReconnect' }));
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('lets the user dismiss a stable suggestion', async () => {
    render(
      <RouteDegradationNotice
        serviceKind="rdp"
        sessionId="rdp-a"
        enabled
        onReconnect={() => undefined}
      />,
    );
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });

    fireEvent.click(screen.getByRole('button', { name: 'routeQualityDismiss' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

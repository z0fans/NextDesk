import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RdpConnectionOverlay } from '@/components/RdpConnectionOverlay';

vi.mock('@/i18n/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (
      params?.name ? `${key}:${params.name}` : key
    ),
  }),
}));

describe('RdpConnectionOverlay', () => {
  it('shows a neutral route-selection state before the route is known', () => {
    render(<RdpConnectionOverlay name="US Desktop" />);

    expect(screen.getByText('rdpSelectingRoute')).toBeInTheDocument();
    expect(screen.getByText('rdpConnectingTarget:US Desktop')).toBeInTheDocument();
    expect(screen.queryByText('routeCloudAccelerated')).not.toBeInTheDocument();
  });

  it('clearly identifies a cloud-accelerated connection', () => {
    render(<RdpConnectionOverlay name="US Desktop" routeLabel="cloud" />);

    expect(screen.getByText('routeCloudAccelerated')).toBeInTheDocument();
    expect(screen.getByText('rdpConnectingCloud')).toBeInTheDocument();
    expect(screen.getByText('rdpConnectingCloudDetail:US Desktop')).toBeInTheDocument();
  });

  it('explains when cloud routing falls back to a direct connection', () => {
    render(<RdpConnectionOverlay name="US Desktop" routeLabel="cloud_fallback" />);

    expect(screen.getByText('routeCloudFallback')).toBeInTheDocument();
    expect(screen.getByText('rdpConnectingDirectFallback')).toBeInTheDocument();
  });
});

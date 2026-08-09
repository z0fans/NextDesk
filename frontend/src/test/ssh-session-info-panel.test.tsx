import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const monitorSnapshot = vi.hoisted(() => vi.fn());

vi.mock('@/i18n/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const templates: Record<string, string> = {
        sshMonitorUptimeValue: '{days}d {hours}h {minutes}m',
        sshMonitorLatencyValue: '{value} ms',
        sshMonitorRateValue: '{value}/s',
        sshMonitorPercentValue: '{value}%',
        sshMonitorSizeValue: '{value} {unit}',
        sshMonitorBytes: 'B',
        sshMonitorKilobytes: 'KB',
        sshMonitorMegabytes: 'MB',
        sshMonitorGigabytes: 'GB',
        sshMonitorTerabytes: 'TB',
      };
      let value = templates[key] ?? key;
      Object.entries(params ?? {}).forEach(([name, replacement]) => {
        value = value.replace(`{${name}}`, String(replacement));
      });
      return value;
    },
  }),
}));

vi.mock('@/ssh/ssh-api', () => ({
  sshApi: {
    monitorSnapshot,
  },
}));

import { SshSessionInfoPanel } from '@/ssh/SshSessionInfoPanel';

describe('SSH session information panel', () => {
  beforeEach(() => {
    monitorSnapshot.mockReset().mockResolvedValue({
      supported: true,
      platform: 'linux',
      uptimeSeconds: 219900,
      loadAverage: [0, 0.02, 0],
      cpuPercent: 4,
      memoryUsedBytes: 3 * 1024 ** 3,
      memoryTotalBytes: 8 * 1024 ** 3,
      swapUsedBytes: 0,
      swapTotalBytes: 0,
      processes: [
        { memoryBytes: 69 * 1024 ** 2, cpuPercent: 1, command: 'omni-rs-bin' },
      ],
      networkInterface: 'eth0',
      networkReceiveBytesPerSecond: 355 * 1024,
      networkTransmitBytesPerSecond: 346 * 1024,
      latencyMs: 278.3,
      disks: [
        { path: '/', availableBytes: 16 * 1024 ** 3, totalBytes: 20 * 1024 ** 3 },
      ],
    });
  });

  it('shows live host, process, network, latency, and disk metrics while connected', async () => {
    render(
      <SshSessionInfoPanel
        sessionId="ssh-alpha"
        active
        connection={{
          id: 'alpha',
          name: 'Alpha',
          host: '185.241.40.55',
          port: 22,
          username: 'root',
          authMethod: 'password',
          routePolicy: 'auto',
        }}
        state="connected"
        routeLabel="cloud"
        onDetectedOs={vi.fn()}
      />,
    );

    await waitFor(() => expect(monitorSnapshot).toHaveBeenCalledWith('ssh-alpha'));

    const panel = screen.getByRole('complementary', { name: 'sshSessionInformation' });
    const info = within(panel);
    expect(info.getByText('root@185.241.40.55:22')).toBeInTheDocument();
    expect(info.getByText('sshRealtimeMonitor')).toBeInTheDocument();
    expect(info.queryByText('sshHost')).not.toBeInTheDocument();
    expect(info.getByText('2d 13h 5m')).toBeInTheDocument();
    expect(info.getByText('0.00 0.02 0.00')).toBeInTheDocument();
    expect(info.getByText('omni-rs-bin')).toBeInTheDocument();
    expect(info.getByText('eth0')).toBeInTheDocument();
    expect(info.getByText('↑ 346 KB/s')).toBeInTheDocument();
    expect(info.getByText('↓ 355 KB/s')).toBeInTheDocument();
    expect(info.getByText('278.3 ms')).toBeInTheDocument();
    expect(info.getByText('/')).toBeInTheDocument();
    expect(info.getByText('16 GB / 20 GB')).toBeInTheDocument();

    const details = info.getByRole('button', { name: 'sshConnectionDetails' });
    expect(details).toHaveClass('h-11', 'border-t', 'border-border');
    expect(details).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(details);
    expect(details).toHaveAttribute('aria-expanded', 'true');
    expect(details).not.toHaveClass('border-t');
    expect(document.getElementById('ssh-alpha-connection-details')).toHaveClass(
      'border-y',
      'border-border',
    );
    expect(info.getByText('sshHost')).toBeInTheDocument();
    expect(info.getByText('sshAuthentication')).toBeInTheDocument();
    expect(info.getByText('sshRoutePolicy')).toBeInTheDocument();
    expect(info.getByText('sshOperatingSystem')).toBeInTheDocument();
  });
});

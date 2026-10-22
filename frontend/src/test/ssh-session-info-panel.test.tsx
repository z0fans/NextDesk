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
        routeDiagnostics={{
          schema_version: 1,
          agent: {
            agent_ref: 'candidate-7f2a',
            country_code: 'JP',
            subregion: 'Tokyo',
            routing_group: 'apac',
            line_tags: ['cn-optimized', 'three-carrier'],
            carrier_capabilities: {
              ingress: ['telecom', 'unicom', 'mobile'],
              egress: ['telecom', 'unicom', 'mobile'],
            },
            asn_capabilities: { ingress: [], egress: [] },
            supported_protocols: ['tcp'],
            capacity: 100,
            failure_domain: 'jp-tokyo-a',
            software_version: '0.3.0',
            declared_capabilities: {},
            recommendation_rank: 1,
          },
          client_network: {
            schema_version: 1,
            country_code: 'CN',
            province: 'Guangdong',
            asn: 4134,
            carrier: 'telecom',
            source: 'direct',
            classification_source: 'rule',
          },
          shadow_evaluation: {
            schema_version: 1,
            mode: 'observe_only',
            policy_revision: 'carrier-diversity-shadow-v1',
            production_policy_revision: 'routing-v1',
            input_summary: {
              country_code: 'CN',
              province: 'Guangdong',
              asn: 4134,
              carrier: 'telecom',
              requested_protocols: ['tcp'],
              target_group: 'apac',
            },
            current_candidates: [{
              agent_ref: 'candidate-current',
              country_code: 'JP',
              subregion: 'Tokyo',
              routing_group: 'apac',
              line_tags: [],
              carrier_capabilities: { ingress: [], egress: [] },
              asn_capabilities: { ingress: [], egress: [] },
              supported_protocols: ['tcp'],
              capacity: 100,
              failure_domain: 'jp-tokyo-a',
              software_version: '0.3.0',
              declared_capabilities: {},
              recommendation_rank: 1,
              affinity_reasons: [],
            }],
            shadow_candidates: [{
              agent_ref: 'candidate-shadow',
              country_code: 'MY',
              subregion: 'Kuala Lumpur',
              routing_group: 'apac',
              line_tags: [],
              carrier_capabilities: { ingress: ['telecom'], egress: [] },
              asn_capabilities: { ingress: [4134], egress: [] },
              supported_protocols: ['tcp'],
              capacity: 100,
              failure_domain: 'my-kuala-lumpur-a',
              software_version: '0.3.0',
              declared_capabilities: {},
              recommendation_rank: 1,
              shadow_score: -1.1,
              affinity_reasons: ['carrier_match', 'asn_match'],
            }],
            excluded_summary: { capacity_exhausted: 1 },
            comparison: {
              same_order: false,
              reordered: false,
              entered: ['candidate-shadow'],
              exited: ['candidate-current'],
            },
          },
          quality_shadow: {
            schema_version: 1,
            mode: 'shadow',
            production_winner_binding_id: 'bnd-current',
            shadow_winner_binding_id: 'bnd-alternative',
            same_winner: false,
            score_delta: 18.5,
            candidates: [],
          },
        }}
        onDetectedOs={vi.fn()}
      />,
    );

    await waitFor(() => expect(monitorSnapshot).toHaveBeenCalledWith('ssh-alpha'));

    const panel = screen.getByRole('complementary', { name: 'sshSessionInformation' });
    const info = within(panel);
    expect(info.getByText('root@185.241.40.55:22')).toBeInTheDocument();
    expect(info.getByText('sshRealtimeMonitor')).toBeInTheDocument();
    expect(info.queryByText('sshHost')).not.toBeInTheDocument();
    expect(info.queryByText('sshRouteDiagnostics')).not.toBeInTheDocument();
    expect(info.queryByText(/AS4134/)).not.toBeInTheDocument();
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
    expect(info.getByText('sshRouteDiagnostics')).toBeInTheDocument();
    expect(info.getByText(/AS4134/)).not.toBeVisible();

    fireEvent.click(info.getByText('sshRouteDiagnostics'));
    expect(info.getByText('JP · Tokyo')).toBeInTheDocument();
    expect(info.getByText('cn-optimized, three-carrier')).toBeInTheDocument();
    expect(info.getByText('tcp')).toBeInTheDocument();
    expect(info.getByText('100')).toBeInTheDocument();
    expect(info.getByText('CN · Guangdong · AS4134 · sshCarrierTelecom')).toBeInTheDocument();
    expect(info.getByText('jp-tokyo-a')).toBeInTheDocument();
    expect(info.getByText('candidate-7f2a')).toBeInTheDocument();
    expect(info.getByText('sshRouteShadowMode')).toBeInTheDocument();
    expect(info.getByText('sshRouteShadowObserveOnly')).toBeInTheDocument();
    expect(info.getByText('candidate-current · JP · jp-tokyo-a')).toBeInTheDocument();
    expect(info.getByText('candidate-shadow · MY · my-kuala-lumpur-a')).toBeInTheDocument();
    expect(info.getByText('sshRouteShadowSameOrderNo')).toBeInTheDocument();
    expect(info.getByText('sshRouteQualityShadow')).toBeInTheDocument();
    expect(info.getByText('sshRouteQualityDifferentWinner')).toBeInTheDocument();
    expect(info.getByText('sshRouteQualityObserveOnly')).toBeInTheDocument();
    expect(info.getByText('18.5')).toBeInTheDocument();
    expect(panel).not.toHaveTextContent('agt_internal');
    expect(panel).not.toHaveTextContent('relay.example.com');
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LogViewer } from '@/components/LogViewer';

const { diagnosticLogRead, translate } = vi.hoisted(() => ({
  diagnosticLogRead: vi.fn(),
  translate: (key: string) => key,
}));

vi.mock('@/api', () => ({
  api: {
    diagnosticLogRead,
    logFilePath: vi.fn().mockResolvedValue('/tmp/nextdesk_debug.log'),
    rdpLogFilePath: vi.fn().mockResolvedValue('/tmp/nextdesk_rdp_debug.log'),
    logFileSize: vi.fn().mockResolvedValue(128),
    rdpLogFileSize: vi.fn().mockResolvedValue(256),
    logShowInFinder: vi.fn().mockResolvedValue(undefined),
    logCopyDiagnosticBundleToDesktop: vi.fn().mockResolvedValue('/tmp/bundle'),
    logClear: vi.fn().mockResolvedValue(undefined),
    rdpLogClear: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/i18n/useTranslation', () => ({
  useTranslation: () => ({ t: translate }),
}));

describe('LogViewer', () => {
  beforeEach(() => {
    diagnosticLogRead.mockResolvedValue([
      {
        timestamp: '2026-07-12T12:00:02.000Z',
        level: 'ERROR',
        source: 'backend',
        module: 'route',
        event: 'route.cloud.fallback',
        message: 'Cloud route failed',
        session_id: 'rdp-1',
        route: 'cloud_fallback',
        duration_ms: 1200,
        fields: {},
      },
      {
        timestamp: '2026-07-12T12:00:01.000Z',
        level: 'INFO',
        source: 'frontend',
        module: 'clipboard',
        event: 'clipboard.sync.completed',
        message: 'Clipboard synchronized',
        session_id: 'rdp-2',
        route: 'lan_direct',
        fields: {},
      },
    ]);
  });

  it('renders a merged log timeline and applies quick filters', async () => {
    render(<LogViewer />);

    await waitFor(() => expect(screen.getByText('Cloud route failed')).toBeInTheDocument());
    expect(screen.getByText('Clipboard synchronized')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'logQuickErrors' }));

    expect(screen.getByText('Cloud route failed')).toBeInTheDocument();
    expect(screen.queryByText('Clipboard synchronized')).not.toBeInTheDocument();
  });

  it('never renders internal RDP technology names returned by the backend', async () => {
    diagnosticLogRead.mockResolvedValueOnce([
      {
        timestamp: '2026-07-12T12:00:03.000Z',
        level: 'ERROR',
        source: 'backend',
        module: 'clipboard',
        event: 'cliprdr-watcher.failed',
        message: '[cliprdr-watcher] kkterm-rdp error code=0x204',
        session_id: 'kkterm-session-1',
        engine: 'ironrdp_cliprdr',
        fields: { location: 'src-tauri/src/cliprdr/watcher.rs:306' },
      },
    ]);

    render(<LogViewer />);

    await waitFor(() => expect(screen.getByText('[Next RDP Clipboard] Next RDP error code=0x204')).toBeInTheDocument());
    expect(screen.queryByText(/kkterm/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/cliprdr/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ironrdp/i)).not.toBeInTheDocument();
  });
});

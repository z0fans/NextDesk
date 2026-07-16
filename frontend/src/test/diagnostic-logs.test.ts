import { describe, expect, it } from 'vitest';
import {
  filterDiagnosticLogs,
  sanitizeDiagnosticEntry,
  sanitizeDiagnosticText,
  type DiagnosticLogEntry,
  type DiagnosticLogFilters,
} from '@/lib/diagnostic-logs';

const entries: DiagnosticLogEntry[] = [
  {
    timestamp: '2026-07-12T12:00:02.000Z',
    level: 'ERROR',
    source: 'backend',
    module: 'route',
    event: 'route.cloud.fallback',
    message: 'Cloud route failed, using local direct',
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
    message: 'Clipboard synchronization completed',
    session_id: 'rdp-2',
    route: 'lan_direct',
    fields: {},
  },
];

const baseFilters: DiagnosticLogFilters = {
  level: 'ALL',
  quick: 'ALL',
  module: 'ALL',
  session: 'ALL',
  route: 'ALL',
  keyword: '',
};

describe('diagnostic log filtering', () => {
  it('filters cloud route failures with the route quick filter', () => {
    const filtered = filterDiagnosticLogs(entries, { ...baseFilters, quick: 'ROUTE' });

    expect(filtered).toHaveLength(1);
    expect(filtered[0].event).toBe('route.cloud.fallback');
  });

  it('searches structured fields and session identifiers', () => {
    const filtered = filterDiagnosticLogs(entries, { ...baseFilters, keyword: 'rdp-2' });

    expect(filtered).toHaveLength(1);
    expect(filtered[0].module).toBe('clipboard');
  });

  it('finds slow operations using the standard duration field', () => {
    const filtered = filterDiagnosticLogs(entries, { ...baseFilters, quick: 'SLOW' });

    expect(filtered).toHaveLength(1);
    expect(filtered[0].duration_ms).toBe(1200);
  });

  it('brands internal RDP technology names without removing troubleshooting context', () => {
    const entry = sanitizeDiagnosticEntry({
      timestamp: '2026-07-12T12:00:03.000Z',
      level: 'ERROR',
      source: 'backend',
      module: 'clipboard',
      event: 'cliprdr-watcher.failed',
      message: '[cliprdr-watcher] kkterm-rdp ActiveX rustls failed code=0x204',
      session_id: 'kkterm-session-1',
      engine: 'ironrdp_cliprdr',
      fields: {
        target: 'nextdesk_lib::kkterm_rdp',
        location: 'src-tauri/src/cliprdr/watcher.rs:306',
      },
    });
    const serialized = JSON.stringify(entry).toLowerCase();

    expect(entry.message).toBe('[Next RDP Clipboard] Next RDP Windows Next RDP TLS failed code=0x204');
    expect(entry.engine).toBe('Next RDP Clipboard');
    expect(entry.session_id).toBe('next_rdp-session-1');
    expect(serialized).not.toContain('kkterm');
    expect(serialized).not.toContain('cliprdr');
    expect(serialized).not.toContain('ironrdp');
    expect(serialized).not.toContain('activex');
    expect(serialized).not.toContain('rustls');
    expect(serialized).toContain('0x204');
    expect(serialized).toContain('306');
  });

  it('brands standalone internal messages consistently', () => {
    expect(sanitizeDiagnosticText('Using opt-in KKTerm RDP path')).toBe('Using opt-in Next RDP path');
  });
});

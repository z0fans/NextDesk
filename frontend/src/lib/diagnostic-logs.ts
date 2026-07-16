export type DiagnosticLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export type DiagnosticLogQuickFilter =
  | 'ALL'
  | 'ERRORS'
  | 'SESSION'
  | 'ROUTE'
  | 'RDP'
  | 'REDIRECTION'
  | 'SLOW';

export interface DiagnosticLogEntry {
  timestamp: string;
  level: DiagnosticLogLevel;
  source: 'frontend' | 'backend' | string;
  module: string;
  event: string;
  message: string;
  session_id?: string | null;
  route?: string | null;
  engine?: string | null;
  duration_ms?: number | null;
  fields: Record<string, unknown>;
}

export interface DiagnosticLogFilters {
  level: DiagnosticLogLevel | 'ALL';
  quick: DiagnosticLogQuickFilter;
  module: string;
  session: string;
  route: string;
  keyword: string;
}

export const STANDARD_LOG_MODULES = [
  'app',
  'auth',
  'cloud',
  'route',
  'rdp',
  'display',
  'network',
  'input',
  'clipboard',
  'file',
  'audio',
] as const;

const PUBLIC_TEXT_REPLACEMENTS: Array<[RegExp, string]> = [
  [/https:\/\/docs\.rs\/rustls\/latest\/rustls\/manual\/_03_howto\/index\.html#unexpected-eof/gi, 'Next RDP TLS unexpected EOF guidance'],
  [/cliprdr[-_ ]watcher/gi, 'Next RDP Clipboard'],
  [/ironrdp[-_ ]cliprdr/gi, 'Next RDP Clipboard'],
  [/kkterm[-_ ]windows/gi, 'Next RDP Windows'],
  [/kkterm[-_ ]macos/gi, 'Next RDP macOS'],
  [/kkterm[-_ ]rdp/gi, 'Next RDP'],
  [/kkterm[-_ ]copy/gi, 'Next RDP'],
  [/kkterm[-_ ]text/gi, 'Next RDP text input'],
  [/official[-_ ]web/gi, 'Next RDP Web'],
  [/native-tls/gi, 'Next RDP TLS'],
  [/rdcleanpath/gi, 'Next RDP transport'],
  [/webcodecs/gi, 'Next RDP media'],
  [/webgl2/gi, 'Next RDP display'],
  [/webgl/gi, 'Next RDP display'],
  [/activex/gi, 'Next RDP Windows'],
  [/ironrdp/gi, 'Next RDP'],
  [/rustls/gi, 'Next RDP TLS'],
  [/wgpu/gi, 'Next RDP display'],
  [/cpal/gi, 'Next RDP Audio'],
  [/cliprdr/gi, 'Next RDP Clipboard'],
  [/rdpsnd/gi, 'Next RDP Audio'],
  [/rdpdr/gi, 'Next RDP File'],
  [/\bwasm\b/gi, 'Next RDP Web'],
  [/kkterm/gi, 'Next RDP'],
  [/Next RDP Next RDP Windows/gi, 'Next RDP Windows'],
  [/Next RDP Next RDP Web/gi, 'Next RDP Web'],
  [/Next RDP Next RDP Clipboard/gi, 'Next RDP Clipboard'],
  [/Next RDP Next RDP Audio/gi, 'Next RDP Audio'],
  [/Next RDP Next RDP File/gi, 'Next RDP File'],
];

const PUBLIC_IDENTIFIER_REPLACEMENTS: Array<[RegExp, string]> = [
  [/https:\/\/docs\.rs\/rustls\/latest\/rustls\/manual\/_03_howto\/index\.html#unexpected-eof/gi, 'next_rdp_tls_unexpected_eof_guidance'],
  [/cliprdr[-_ ]watcher/gi, 'next_rdp_clipboard'],
  [/ironrdp[-_ ]cliprdr/gi, 'next_rdp_clipboard'],
  [/kkterm[-_ ]windows/gi, 'next_rdp_windows'],
  [/kkterm[-_ ]macos/gi, 'next_rdp_macos'],
  [/kkterm[-_ ]rdp/gi, 'next_rdp'],
  [/kkterm[-_ ]copy/gi, 'next_rdp'],
  [/kkterm[-_ ]text/gi, 'next_rdp_text_input'],
  [/official[-_ ]web/gi, 'next_rdp_web'],
  [/native-tls/gi, 'next_rdp_tls'],
  [/rdcleanpath/gi, 'next_rdp_transport'],
  [/webcodecs/gi, 'next_rdp_media'],
  [/webgl2/gi, 'next_rdp_display'],
  [/webgl/gi, 'next_rdp_display'],
  [/activex/gi, 'next_rdp_windows'],
  [/ironrdp/gi, 'next_rdp'],
  [/rustls/gi, 'next_rdp_tls'],
  [/wgpu/gi, 'next_rdp_display'],
  [/cpal/gi, 'next_rdp_audio'],
  [/cliprdr/gi, 'next_rdp_clipboard'],
  [/rdpsnd/gi, 'next_rdp_audio'],
  [/rdpdr/gi, 'next_rdp_file'],
  [/\bwasm\b/gi, 'next_rdp_web'],
  [/kkterm/gi, 'next_rdp'],
  [/next_rdp next_rdp_windows/gi, 'next_rdp_windows'],
  [/next_rdp next_rdp_web/gi, 'next_rdp_web'],
  [/next_rdp next_rdp_clipboard/gi, 'next_rdp_clipboard'],
  [/next_rdp next_rdp_audio/gi, 'next_rdp_audio'],
  [/next_rdp next_rdp_file/gi, 'next_rdp_file'],
];

function applyReplacements(value: string, replacements: Array<[RegExp, string]>): string {
  return replacements.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    value,
  );
}

export function sanitizeDiagnosticText(value: string): string {
  return applyReplacements(value, PUBLIC_TEXT_REPLACEMENTS);
}

export function sanitizeDiagnosticIdentifier(value: string): string {
  return applyReplacements(value, PUBLIC_IDENTIFIER_REPLACEMENTS);
}

export function sanitizeDiagnosticValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeDiagnosticText(value);
  if (Array.isArray(value)) return value.map(sanitizeDiagnosticValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        sanitizeDiagnosticIdentifier(key),
        sanitizeDiagnosticValue(item),
      ]),
    );
  }
  return value;
}

export function sanitizeDiagnosticEntry(entry: DiagnosticLogEntry): DiagnosticLogEntry {
  return {
    ...entry,
    event: sanitizeDiagnosticIdentifier(entry.event),
    message: sanitizeDiagnosticText(entry.message),
    session_id: entry.session_id ? sanitizeDiagnosticIdentifier(entry.session_id) : entry.session_id,
    engine: entry.engine ? sanitizeDiagnosticText(entry.engine) : entry.engine,
    fields: sanitizeDiagnosticValue(entry.fields) as Record<string, unknown>,
  };
}

export function filterDiagnosticLogs(
  entries: DiagnosticLogEntry[],
  filters: DiagnosticLogFilters,
): DiagnosticLogEntry[] {
  const keyword = filters.keyword.trim().toLowerCase();

  return entries.filter((entry) => {
    if (filters.level !== 'ALL' && entry.level !== filters.level) return false;
    if (filters.module !== 'ALL' && entry.module !== filters.module) return false;
    if (filters.session !== 'ALL' && entry.session_id !== filters.session) return false;
    if (filters.route !== 'ALL' && entry.route !== filters.route) return false;

    if (filters.quick === 'ERRORS' && !['WARN', 'ERROR'].includes(entry.level)) return false;
    if (filters.quick === 'SESSION' && !entry.session_id) return false;
    if (filters.quick === 'ROUTE' && !['route', 'cloud', 'auth'].includes(entry.module)) return false;
    if (filters.quick === 'RDP' && !['rdp', 'display', 'network'].includes(entry.module)) return false;
    if (filters.quick === 'REDIRECTION' && !['clipboard', 'file', 'audio', 'input'].includes(entry.module)) return false;
    if (filters.quick === 'SLOW' && (entry.duration_ms ?? 0) < 1000) return false;

    if (keyword) {
      const searchable = [
        entry.message,
        entry.event,
        entry.module,
        entry.session_id,
        entry.route,
        entry.engine,
        JSON.stringify(entry.fields),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!searchable.includes(keyword)) return false;
    }

    return true;
  });
}

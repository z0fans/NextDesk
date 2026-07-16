import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CirclePause,
  CirclePlay,
  Copy,
  FolderOpen,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react';
import { api } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { TranslationKey } from '@/i18n/translations';
import { useTranslation } from '@/i18n/useTranslation';
import {
  filterDiagnosticLogs,
  sanitizeDiagnosticEntry,
  type DiagnosticLogEntry,
  type DiagnosticLogFilters,
  type DiagnosticLogLevel,
  type DiagnosticLogQuickFilter,
} from '@/lib/diagnostic-logs';
import { cn } from '@/lib/utils';

const LEVELS: Array<DiagnosticLogLevel | 'ALL'> = ['ALL', 'DEBUG', 'INFO', 'WARN', 'ERROR'];
const QUICK_FILTERS: Array<{ value: DiagnosticLogQuickFilter; label: TranslationKey }> = [
  { value: 'ALL', label: 'logQuickAll' },
  { value: 'ERRORS', label: 'logQuickErrors' },
  { value: 'SESSION', label: 'logQuickSession' },
  { value: 'ROUTE', label: 'logQuickRoute' },
  { value: 'RDP', label: 'logQuickRdp' },
  { value: 'REDIRECTION', label: 'logQuickRedirection' },
  { value: 'SLOW', label: 'logQuickSlow' },
];

const INITIAL_FILTERS: DiagnosticLogFilters = {
  level: 'ALL',
  quick: 'ALL',
  module: 'ALL',
  session: 'ALL',
  route: 'ALL',
  keyword: '',
};

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function levelClass(level: DiagnosticLogLevel): string {
  if (level === 'ERROR') return 'border-red-500/30 bg-red-500/10 text-red-400';
  if (level === 'WARN') return 'border-amber-500/30 bg-amber-500/10 text-amber-400';
  if (level === 'DEBUG') return 'border-border bg-muted/50 text-muted-foreground';
  return 'border-cyan-500/20 bg-cyan-500/10 text-cyan-400';
}

function routeClass(route?: string | null): string {
  if (route === 'cloud_fallback') return 'text-amber-400';
  if (route === 'cloud') return 'text-cyan-400';
  if (route === 'lan_direct') return 'text-emerald-400';
  return 'text-muted-foreground';
}

export function LogViewer() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<DiagnosticLogEntry[]>([]);
  const [filters, setFilters] = useState<DiagnosticLogFilters>(INITIAL_FILTERS);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [backendLogPath, setBackendLogPath] = useState('');
  const [rdpLogPath, setRdpLogPath] = useState('');
  const [backendLogSize, setBackendLogSize] = useState(0);
  const [rdpLogSize, setRdpLogSize] = useState(0);

  const loadLogInfo = useCallback(async () => {
    const [backendPath, rdpPath, backendSize, rdpSize] = await Promise.all([
      api.logFilePath(),
      api.rdpLogFilePath(),
      api.logFileSize(),
      api.rdpLogFileSize(),
    ]);
    setBackendLogPath(backendPath);
    setRdpLogPath(rdpPath);
    setBackendLogSize(backendSize);
    setRdpLogSize(rdpSize);
  }, []);

  const load = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const nextEntries = await api.diagnosticLogRead(1000);
      setEntries(nextEntries.map(sanitizeDiagnosticEntry));
      setError('');
    } catch (loadError) {
      console.error('Failed to load diagnostic logs', loadError);
      setError(t('logLoadFailed'));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load(true).catch(console.error);
    loadLogInfo().catch(console.error);
  }, [load, loadLogInfo]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => load(false).catch(console.error), 3000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, load]);

  const filtered = useMemo(() => filterDiagnosticLogs(entries, filters), [entries, filters]);
  const modules = useMemo(
    () => Array.from(new Set(entries.map(entry => entry.module).filter(Boolean))).sort(),
    [entries],
  );
  const sessions = useMemo(
    () => Array.from(new Set(entries.map(entry => entry.session_id).filter(Boolean) as string[])).sort(),
    [entries],
  );
  const routes = useMemo(
    () => Array.from(new Set(entries.map(entry => entry.route).filter(Boolean) as string[])).sort(),
    [entries],
  );

  const handleClear = async () => {
    if (!window.confirm(t('logClearConfirm'))) return;
    await Promise.all([api.logClear(), api.rdpLogClear()]);
    setEntries([]);
    setMessage(t('logCleared'));
    await loadLogInfo();
  };

  const handleExport = async () => {
    try {
      const path = await api.logCopyDiagnosticBundleToDesktop();
      setMessage(`${t('diagnosticBundleCopied')}: ${path}`);
    } catch (exportError) {
      console.error('Failed to export diagnostic bundle', exportError);
      setMessage(t('diagnosticBundleFailed'));
    }
  };

  const copyEntry = async (entry: DiagnosticLogEntry) => {
    await navigator.clipboard.writeText(JSON.stringify(entry, null, 2));
    setMessage(t('logEntryCopied'));
  };

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm text-muted-foreground">{t('logViewerDesc')}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {autoRefresh ? t('logAutoRefreshOn') : t('logAutoRefreshPaused')}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setAutoRefresh(value => !value)}>
            {autoRefresh ? <CirclePause /> : <CirclePlay />}
            {autoRefresh ? t('logPause') : t('logResume')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => load(true)} disabled={loading}>
            <RefreshCw className={cn(loading && 'animate-spin')} />
            {t('refresh')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => api.logShowInFinder()}>
            <FolderOpen />
            {t('logShowInFinder')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleExport().catch(console.error)}>
            <Copy />
            {t('copyDiagnosticBundle')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleClear().catch(console.error)}>
            <Trash2 />
            {t('logClear')}
          </Button>
        </div>
      </div>

      <section className="rounded-md border border-border bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          {LEVELS.map(level => (
            <button
              key={level}
              type="button"
              onClick={() => setFilters(current => ({ ...current, level }))}
              className={cn(
                'h-8 rounded-md border px-3 text-xs font-medium transition-colors',
                filters.level === level
                  ? 'border-cyan-500/40 bg-cyan-500/15 text-cyan-300'
                  : 'border-border bg-muted/30 text-muted-foreground hover:text-foreground',
              )}
            >
              {level}
            </button>
          ))}
          <div className="mx-1 h-5 w-px bg-border" />
          {QUICK_FILTERS.map(filter => (
            <button
              key={filter.value}
              type="button"
              onClick={() => setFilters(current => ({ ...current, quick: filter.value }))}
              className={cn(
                'h-8 rounded-md border px-3 text-xs transition-colors',
                filters.quick === filter.value
                  ? 'border-foreground/30 bg-foreground text-background'
                  : 'border-border bg-muted/30 text-muted-foreground hover:text-foreground',
              )}
            >
              {t(filter.label)}
            </button>
          ))}
          <span className="ml-auto text-xs text-muted-foreground">
            {filtered.length} / {entries.length} {t('logEntries')}
          </span>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-5">
          <div className="relative xl:col-span-2">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={filters.keyword}
              onChange={event => setFilters(current => ({ ...current, keyword: event.target.value }))}
              placeholder={t('logSearchPlaceholder')}
              className="pl-9"
            />
          </div>
          <select
            value={filters.module}
            onChange={event => setFilters(current => ({ ...current, module: event.target.value }))}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
          >
            <option value="ALL">{t('logAllModules')}</option>
            {modules.map(module => <option key={module} value={module}>{module}</option>)}
          </select>
          <select
            value={filters.session}
            onChange={event => setFilters(current => ({ ...current, session: event.target.value }))}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
          >
            <option value="ALL">{t('logAllSessions')}</option>
            {sessions.map(session => <option key={session} value={session}>{session}</option>)}
          </select>
          <select
            value={filters.route}
            onChange={event => setFilters(current => ({ ...current, route: event.target.value }))}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
          >
            <option value="ALL">{t('logAllRoutes')}</option>
            {routes.map(route => <option key={route} value={route}>{route}</option>)}
          </select>
        </div>

        <div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <div className="min-w-0 truncate font-mono">
            {formatBytes(backendLogSize + rdpLogSize)} · {backendLogPath} · {rdpLogPath}
          </div>
          <Button variant="ghost" size="sm" onClick={() => setFilters(INITIAL_FILTERS)}>
            <RotateCcw />
            {t('logResetFilters')}
          </Button>
        </div>
      </section>

      {(error || message) && (
        <div className={cn(
          'rounded-md border px-3 py-2 text-sm',
          error ? 'border-red-500/30 bg-red-500/10 text-red-400' : 'border-border bg-muted/30 text-muted-foreground',
        )}>
          {error || message}
        </div>
      )}

      <section className="min-h-[360px] overflow-hidden rounded-md border border-border bg-card">
        <div className="max-h-[calc(100vh-330px)] min-h-[360px] overflow-auto">
          <table className="w-full table-fixed text-left font-mono text-xs">
            <thead className="sticky top-0 z-10 bg-muted text-muted-foreground">
              <tr>
                <th className="w-8 px-2 py-2" />
                <th className="w-44 px-2 py-2 font-medium">{t('logColumnTime')}</th>
                <th className="w-20 px-2 py-2 font-medium">{t('logColumnLevel')}</th>
                <th className="w-24 px-2 py-2 font-medium">{t('logColumnModule')}</th>
                <th className="w-44 px-2 py-2 font-medium">{t('logColumnContext')}</th>
                <th className="px-2 py-2 font-medium">{t('logColumnMessage')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-20 text-center text-sm text-muted-foreground">
                    {t('logEmpty')}
                  </td>
                </tr>
              ) : filtered.map((entry, index) => {
                const key = `${entry.source}-${entry.timestamp}-${index}`;
                const isExpanded = expanded === key;
                return (
                  <LogRow
                    key={key}
                    entry={entry}
                    expanded={isExpanded}
                    onToggle={() => setExpanded(isExpanded ? null : key)}
                    onCopy={() => copyEntry(entry).catch(console.error)}
                    t={t}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function LogRow({
  entry,
  expanded,
  onToggle,
  onCopy,
  t,
}: {
  entry: DiagnosticLogEntry;
  expanded: boolean;
  onToggle: () => void;
  onCopy: () => void;
  t: (key: TranslationKey) => string;
}) {
  return (
    <>
      <tr className="cursor-pointer border-t border-border hover:bg-muted/30" onClick={onToggle}>
        <td className="px-2 py-2 text-muted-foreground">
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </td>
        <td className="truncate px-2 py-2 text-muted-foreground" title={entry.timestamp}>
          {entry.timestamp.replace('T', ' ').replace('Z', '')}
        </td>
        <td className="px-2 py-2">
          <Badge variant="outline" className={cn('rounded px-1.5 py-0 text-[10px]', levelClass(entry.level))}>
            {entry.level}
          </Badge>
        </td>
        <td className="truncate px-2 py-2 text-foreground" title={entry.module}>{entry.module}</td>
        <td className="truncate px-2 py-2" title={[entry.session_id, entry.route].filter(Boolean).join(' · ')}>
          <span className="text-muted-foreground">{entry.session_id || '-'}</span>
          {entry.route && <span className={cn('ml-2', routeClass(entry.route))}>{entry.route}</span>}
        </td>
        <td className={cn('truncate px-2 py-2', entry.level === 'ERROR' ? 'text-red-400' : 'text-foreground')} title={entry.message}>
          <span>{entry.message}</span>
          {entry.event && entry.event !== `${entry.module}.log` && (
            <span className="ml-2 text-muted-foreground">{entry.event}</span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="border-t border-border bg-background/60">
          <td colSpan={6} className="px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="grid min-w-0 flex-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
                <Detail label="event" value={entry.event} />
                <Detail label="source" value={entry.source} />
                <Detail label="engine" value={entry.engine || '-'} />
                <Detail label="duration_ms" value={entry.duration_ms?.toString() || '-'} />
                <div className="sm:col-span-2 lg:col-span-4">
                  <div className="text-[10px] uppercase text-muted-foreground">fields</div>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted/20 p-3 text-xs text-foreground">
                    {JSON.stringify(entry.fields, null, 2)}
                  </pre>
                </div>
              </div>
              <Button variant="ghost" size="icon" onClick={(event) => { event.stopPropagation(); onCopy(); }} title={t('logCopyEntry')}>
                <Copy />
              </Button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-xs text-foreground" title={value}>{value}</div>
    </div>
  );
}

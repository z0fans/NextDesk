import { useCallback, useMemo, useState } from 'react';
import {
  AlertTriangle,
  KeyRound,
  Plus,
  RotateCw,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  X,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n/useTranslation';
import type { TranslationKey } from '@/i18n/translations';
import { loadSshConnections, saveSshConnections } from './connection-store';
import { NewSshConnectionDialog } from './NewSshConnectionDialog';
import { sshApi } from './ssh-api';
import { TerminalSurface } from './TerminalSurface';
import type { SshConnection, SshEvent, SshHostKeyPreview } from './types';

interface SshWorkspaceProps {
  isVisible: boolean;
  onMainSidebarCollapse?: () => void;
}

interface SshSessionTab {
  id: string;
  connection: SshConnection;
  state: string;
  routeLabel?: string;
  message?: string;
  pendingHostKey?: SshHostKeyPreview;
  retryToken: number;
}

function newSessionId(connectionId: string): string {
  const suffix = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `ssh-${connectionId}-${suffix}`;
}

function routeBadgeClass(routeLabel?: string): string {
  if (routeLabel === 'cloud') return 'border-cyan-500/30 bg-cyan-500/10 text-cyan-400';
  if (routeLabel === 'lan_direct') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400';
  if (routeLabel === 'cloud_fallback') return 'border-amber-500/30 bg-amber-500/10 text-amber-400';
  return 'border-slate-500/30 bg-slate-500/10 text-slate-400';
}

function isReconnectable(session: SshSessionTab): boolean {
  if (session.state === 'disconnected' || session.state === 'exited') return true;
  if (session.state !== 'error' || !session.message) return false;
  return [
    'ssh_transport_',
    'ssh_channel_',
    'ssh_pty_',
    'ssh_shell_',
    'ssh_input_',
    'ssh_output_',
    'ssh_resize_',
  ].some((prefix) => session.message?.startsWith(prefix));
}

function stateTranslationKey(state: string): TranslationKey {
  const keys: Record<string, TranslationKey> = {
    resolving_route: 'sshStateResolvingRoute',
    connecting_transport: 'sshStateConnectingTransport',
    authenticating: 'sshStateAuthenticating',
    connected: 'sshStateConnected',
    disconnected: 'sshStateDisconnected',
    exited: 'sshStateExited',
    error: 'sshStateError',
    host_key_required: 'sshStateHostKeyRequired',
  };
  return keys[state] ?? 'sshStateError';
}

function errorTranslationKey(message: string): TranslationKey {
  const code = message.split(':', 1)[0];
  if (code.includes('authentication') || code === 'ssh_password_required') return 'sshErrorAuth';
  if (code.includes('private_key') || code === 'ssh_key_algorithm_failed') return 'sshErrorPrivateKey';
  if (code.startsWith('credential_')) return 'sshErrorCredential';
  if (code.startsWith('cloud_')) return 'sshErrorCloud';
  if (code.startsWith('ssh_transport_')) return 'sshErrorTransport';
  return 'sshErrorGeneric';
}

export function SshWorkspace({ isVisible, onMainSidebarCollapse }: SshWorkspaceProps) {
  const { t } = useTranslation();
  const [connections, setConnections] = useState<SshConnection[]>(loadSshConnections);
  const [sessions, setSessions] = useState<SshSessionTab[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [activeSessionId, sessions],
  );

  const openConnection = useCallback((connection: SshConnection) => {
    const sessionId = newSessionId(connection.id);
    setSessions((current) => [
      ...current,
      {
        id: sessionId,
        connection,
        state: 'resolving_route',
        retryToken: 0,
      },
    ]);
    setActiveSessionId(sessionId);
    onMainSidebarCollapse?.();
  }, [onMainSidebarCollapse]);

  const onSessionEvent = useCallback((event: SshEvent) => {
    setSessions((current) =>
      current.map((session) => {
        if (session.id !== event.sessionId) return session;
        if (event.kind === 'host_key') {
          return {
            ...session,
            state: 'host_key_required',
            pendingHostKey: event.preview,
            message: undefined,
          };
        }
        if (session.pendingHostKey && event.state === 'disconnected') return session;
        return {
          ...session,
          state: event.state,
          routeLabel: event.routeLabel ?? session.routeLabel,
          message: event.message,
        };
      }),
    );
  }, []);

  const closeSession = useCallback((sessionId: string) => {
    void sshApi.close(sessionId).catch(() => {});
    setSessions((current) => {
      const remaining = current.filter((session) => session.id !== sessionId);
      setActiveSessionId((active) => {
        if (active !== sessionId) return active;
        return remaining.at(-1)?.id ?? null;
      });
      return remaining;
    });
  }, []);

  const trustAndReconnect = useCallback(async (sessionId: string) => {
    const session = sessions.find((candidate) => candidate.id === sessionId);
    const preview = session?.pendingHostKey;
    if (!preview) return;
    try {
      await sshApi.trustHostKey({
        host: preview.host,
        port: preview.port,
        publicKey: preview.publicKey,
      });
      setSessions((current) =>
        current.map((candidate) =>
          candidate.id === sessionId
            ? {
                ...candidate,
                pendingHostKey: undefined,
                state: 'resolving_route',
                message: undefined,
                retryToken: candidate.retryToken + 1,
              }
            : candidate,
        ),
      );
    } catch (error) {
      setSessions((current) =>
        current.map((candidate) =>
          candidate.id === sessionId
            ? {
                ...candidate,
                state: 'error',
                message: error instanceof Error ? error.message : String(error),
              }
            : candidate,
        ),
      );
    }
  }, [sessions]);

  const reconnectSession = useCallback((sessionId: string) => {
    setSessions((current) =>
      current.map((candidate) =>
        candidate.id === sessionId
          ? {
              ...candidate,
              state: 'resolving_route',
              message: undefined,
              retryToken: candidate.retryToken + 1,
            }
          : candidate,
      ),
    );
  }, []);

  const addConnection = useCallback((connection: SshConnection) => {
    setConnections((current) => {
      const next = [...current, connection];
      saveSshConnections(next);
      return next;
    });
    openConnection(connection);
  }, [openConnection]);

  const removeConnection = useCallback((connection: SshConnection) => {
    sessions
      .filter((session) => session.connection.id === connection.id)
      .forEach((session) => closeSession(session.id));
    setConnections((current) => {
      const next = current.filter((candidate) => candidate.id !== connection.id);
      saveSshConnections(next);
      return next;
    });
    if (connection.credentialReference) {
      void sshApi.deleteCredential(connection.credentialReference).catch(() => {});
    }
  }, [closeSession, sessions]);

  return (
    <div className="flex h-full min-h-0 bg-[#080d16] text-slate-100">
      <aside className="flex w-64 shrink-0 flex-col border-r border-slate-800 bg-[#0c1320]">
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <div className="flex items-center gap-2">
            <TerminalSquare className="h-4 w-4 text-cyan-400" />
            <span className="text-sm font-semibold">{t('sshConnections')}</span>
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            className="text-slate-400 hover:bg-slate-800 hover:text-cyan-300"
            onClick={() => setDialogOpen(true)}
            aria-label={t('sshNewConnection')}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 space-y-1 overflow-y-auto p-2">
          {connections.map((connection) => {
            const session = sessions.find((candidate) => candidate.connection.id === connection.id);
            return (
              <div key={connection.id} className="group flex items-center rounded-md hover:bg-slate-800/70">
                <button
                  type="button"
                  onClick={() => openConnection(connection)}
                  className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left"
                  aria-label={`${t('sshConnect')} ${connection.name}`}
                >
                  <span className={cn(
                    'h-2 w-2 shrink-0 rounded-full',
                    session?.state === 'connected' ? 'bg-emerald-400' : session ? 'bg-amber-400' : 'bg-slate-600',
                  )} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-200">{connection.name}</span>
                    <span className="block truncate font-mono text-[11px] text-slate-500">
                      {connection.username}@{connection.host}:{connection.port}
                    </span>
                  </span>
                </button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="mr-1 opacity-0 text-slate-500 hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100"
                  onClick={() => removeConnection(connection)}
                  aria-label={`${t('sshDelete')} ${connection.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          })}
          {connections.length === 0 && (
            <div className="px-3 py-10 text-center text-xs leading-5 text-slate-500">
              {t('sshNoConnections')}
            </div>
          )}
        </div>

        <div className="border-t border-slate-800 p-3">
          <Button
            className="w-full bg-cyan-600 text-white hover:bg-cyan-500"
            size="sm"
            onClick={() => setDialogOpen(true)}
          >
            <Plus className="h-4 w-4" />
            {t('sshNewConnection')}
          </Button>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-end gap-1 overflow-x-auto border-b border-slate-800 bg-[#0c1320] px-2 pt-1">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={cn(
                'flex h-9 min-w-36 max-w-56 items-center rounded-t-md border border-b-0 px-2',
                session.id === activeSessionId
                  ? 'border-slate-700 bg-[#080d16] text-slate-100'
                  : 'border-transparent text-slate-500 hover:bg-slate-800/60 hover:text-slate-300',
              )}
            >
              <button
                type="button"
                onClick={() => setActiveSessionId(session.id)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs"
                aria-label={session.connection.name}
              >
                <TerminalSquare className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{session.connection.name}</span>
              </button>
              <button
                type="button"
                onClick={() => closeSession(session.id)}
                className="ml-1 rounded p-1 text-slate-600 hover:bg-slate-700 hover:text-slate-200"
                aria-label={`${t('sshClose')} ${session.connection.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>

        {activeSession && (
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-slate-800 bg-[#0a101b] px-4 text-xs">
            <div className="flex min-w-0 items-center gap-3">
              <span className="truncate font-mono text-slate-400">
                {activeSession.connection.username}@{activeSession.connection.host}:{activeSession.connection.port}
              </span>
              <Badge variant="outline" className={routeBadgeClass(activeSession.routeLabel)}>
                {activeSession.routeLabel === 'cloud'
                  ? t('sshCloudRoute')
                  : activeSession.routeLabel === 'lan_direct'
                    ? t('sshLanRoute')
                    : activeSession.routeLabel === 'cloud_fallback'
                      ? t('sshCloudFallback')
                    : activeSession.routeLabel
                      ? t('sshDirectRoute')
                      : t('sshRouteResolving')}
              </Badge>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className={cn(
                'font-medium',
                activeSession.state === 'connected' ? 'text-emerald-400' : activeSession.state === 'error' ? 'text-red-400' : 'text-amber-400',
              )}>
                {t('sshState')}: {t(stateTranslationKey(activeSession.state))}
              </span>
              {isReconnectable(activeSession) && !activeSession.message && (
                <Button size="sm" variant="outline" className="h-7 border-slate-700" onClick={() => reconnectSession(activeSession.id)}>
                  <RotateCw className="h-3.5 w-3.5" />
                  {t('sshReconnect')}
                </Button>
              )}
            </div>
          </div>
        )}

        <div className="relative min-h-0 flex-1">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={cn('absolute inset-0', session.id !== activeSessionId && 'hidden')}
            >
              <TerminalSurface
                sessionId={session.id}
                connection={session.connection}
                visible={isVisible && session.id === activeSessionId}
                retryToken={session.retryToken}
                onEvent={onSessionEvent}
              />
            </div>
          ))}

          {!activeSession && (
            <div className="flex h-full items-center justify-center bg-[radial-gradient(circle_at_center,_rgba(8,145,178,0.08),_transparent_45%)]">
              <div className="max-w-sm text-center">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl border border-cyan-500/20 bg-cyan-500/10">
                  <TerminalSquare className="h-7 w-7 text-cyan-400" />
                </div>
                <h2 className="mt-5 text-lg font-semibold text-slate-200">{t('sshWorkspaceEmptyTitle')}</h2>
                <p className="mt-2 text-sm leading-6 text-slate-500">{t('sshWorkspaceEmptyDesc')}</p>
                <Button className="mt-5 bg-cyan-600 text-white hover:bg-cyan-500" onClick={() => setDialogOpen(true)}>
                  <Plus className="h-4 w-4" />
                  {t('sshNewConnection')}
                </Button>
              </div>
            </div>
          )}

          {activeSession?.pendingHostKey && (
            <div className="absolute inset-x-4 top-4 z-20 rounded-lg border border-amber-500/40 bg-slate-950/95 p-4 shadow-2xl backdrop-blur">
              <div className="flex items-start gap-3">
                {activeSession.pendingHostKey.status === 'changed'
                  ? <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" />
                  : <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />}
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold text-slate-100">
                    {activeSession.pendingHostKey.status === 'changed'
                      ? t('sshHostKeyChanged')
                      : t('sshHostKeyUnknown')}
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-slate-400">
                    {activeSession.pendingHostKey.status === 'changed'
                      ? t('sshHostKeyChangedWarning')
                      : t('sshHostKeyUnknownWarning')}
                  </p>
                  <div className="mt-3 rounded border border-slate-800 bg-black/30 px-3 py-2 font-mono text-xs text-cyan-300">
                    <div>{activeSession.pendingHostKey.algorithm}</div>
                    <div className="mt-1 break-all text-slate-400">{activeSession.pendingHostKey.fingerprint}</div>
                  </div>
                  <div className="mt-4 flex gap-2">
                    <Button
                      size="sm"
                      className={cn(
                        activeSession.pendingHostKey.status === 'changed'
                          ? 'bg-red-600 text-white hover:bg-red-500'
                          : 'bg-amber-500 text-slate-950 hover:bg-amber-400',
                      )}
                      onClick={() => void trustAndReconnect(activeSession.id)}
                    >
                      <KeyRound className="h-4 w-4" />
                      {activeSession.pendingHostKey.status === 'changed'
                        ? t('sshReplaceAndReconnect')
                        : t('sshTrustAndReconnect')}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => closeSession(activeSession.id)}>
                      {t('sshCancel')}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeSession?.message && !activeSession.pendingHostKey && (
            <div className="absolute inset-x-4 top-4 z-10 flex items-center gap-2 rounded-md border border-red-500/30 bg-red-950/90 px-4 py-3 text-sm text-red-200">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">{t(errorTranslationKey(activeSession.message))}</span>
              {isReconnectable(activeSession) && (
                <Button size="sm" variant="outline" className="border-red-400/30 bg-transparent text-red-100 hover:bg-red-900" onClick={() => reconnectSession(activeSession.id)}>
                  <RotateCw className="h-3.5 w-3.5" />
                  {t('sshReconnect')}
                </Button>
              )}
            </div>
          )}
        </div>
      </section>

      {dialogOpen && (
        <NewSshConnectionDialog
          open
          onClose={() => setDialogOpen(false)}
          onCreated={addConnection}
        />
      )}
    </div>
  );
}

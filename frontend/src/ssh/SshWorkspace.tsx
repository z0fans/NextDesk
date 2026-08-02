import { useCallback, useMemo, useState } from 'react';
import {
  AlertTriangle,
  FolderTree,
  KeyRound,
  Pencil,
  Play,
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
import { SftpPanel } from './SftpPanel';
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
  sftpOpen: boolean;
  sftpMounted: boolean;
}

function newSessionId(connectionId: string): string {
  const suffix = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `ssh-${connectionId}-${suffix}`;
}

function routeBadgeClass(routeLabel?: string): string {
  if (routeLabel === 'cloud') {
    return 'border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-400';
  }
  if (routeLabel === 'lan_direct') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400';
  }
  if (routeLabel === 'cloud_fallback') {
    return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400';
  }
  return 'border-border bg-muted text-muted-foreground';
}

function isReconnectable(session: SshSessionTab): boolean {
  if (session.state === 'disconnected' || session.state === 'exited') return true;
  if (session.state !== 'error' || !session.message) return false;
  const code = session.message.split(':', 1)[0];
  if ([
    'ssh_session_already_exists',
    'ssh_session_cancelled',
    'ssh_session_closed',
    'ssh_session_not_found',
    'ssh_start_failed',
  ].includes(code)) return true;
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
  if (code === 'ssh_session_already_exists') return 'sshErrorSessionBusy';
  if (code === 'ssh_session_cancelled') return 'sshErrorCancelled';
  if (code === 'ssh_session_closed' || code === 'ssh_session_not_found') {
    return 'sshErrorSessionClosed';
  }
  if (code.startsWith('ssh_kex_') || code.startsWith('ssh_host_key_')) return 'sshErrorKex';
  if (code.includes('authentication') || code === 'ssh_password_required') return 'sshErrorAuth';
  if (code.includes('private_key') || code === 'ssh_key_algorithm_failed') return 'sshErrorPrivateKey';
  if (code.startsWith('credential_')) return 'sshErrorCredential';
  if (code.startsWith('cloud_')) return 'sshErrorCloud';
  if (code.startsWith('ssh_transport_')) return 'sshErrorTransport';
  if (code.endsWith('_invalid') || code.endsWith('_required')) return 'sshErrorInvalid';
  return 'sshErrorGeneric';
}

function isLifecycleClosure(message?: string): boolean {
  const code = message?.split(':', 1)[0];
  return code === 'ssh_session_closed' || code === 'ssh_session_not_found';
}

export function SshWorkspace({ isVisible, onMainSidebarCollapse }: SshWorkspaceProps) {
  const { t } = useTranslation();
  const [connections, setConnections] = useState<SshConnection[]>(loadSshConnections);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SshSessionTab[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<SshConnection | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    connection: SshConnection;
    x: number;
    y: number;
  } | null>(null);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [activeSessionId, sessions],
  );

  const openConnection = useCallback((connection: SshConnection) => {
    const sessionId = newSessionId(connection.id);
    setSelectedConnectionId(connection.id);
    setSessions((current) => [
      ...current,
      {
        id: sessionId,
        connection,
        state: 'resolving_route',
        retryToken: 0,
        sftpOpen: false,
        sftpMounted: false,
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
        if (
          session.state === 'error'
          && session.message
          && event.state === 'error'
          && isLifecycleClosure(event.message)
          && !isLifecycleClosure(session.message)
        ) {
          return {
            ...session,
            routeLabel: event.routeLabel ?? session.routeLabel,
          };
        }
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

  const updateConnection = useCallback((connection: SshConnection) => {
    setConnections((current) => {
      const next = current.map((candidate) =>
        candidate.id === connection.id ? connection : candidate,
      );
      saveSshConnections(next);
      return next;
    });
  }, []);

  const openNewConnectionDialog = useCallback(() => {
    setEditingConnection(null);
    setContextMenu(null);
    setDialogOpen(true);
  }, []);

  const openEditConnectionDialog = useCallback((connection: SshConnection) => {
    setEditingConnection(connection);
    setContextMenu(null);
    setDialogOpen(true);
  }, []);

  const removeConnection = useCallback((connection: SshConnection) => {
    sessions
      .filter((session) => session.connection.id === connection.id)
      .forEach((session) => closeSession(session.id));
    setConnections((current) => {
      const next = current.filter((candidate) => candidate.id !== connection.id);
      saveSshConnections(next);
      return next;
    });
    setSelectedConnectionId((selected) => selected === connection.id ? null : selected);
    if (connection.credentialReference) {
      void sshApi.deleteCredential(connection.credentialReference).catch(() => {});
    }
  }, [closeSession, sessions]);

  return (
    <div className="flex h-full min-h-0 bg-background text-foreground transition-colors duration-300">
      <aside className="flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        <div className="flex items-center justify-between border-b border-sidebar-border px-4 py-3">
          <div className="flex items-center gap-2">
            <TerminalSquare className="h-4 w-4 text-cyan-600 dark:text-cyan-400" />
            <span className="text-sm font-semibold">{t('sshConnections')}</span>
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            className="text-muted-foreground hover:bg-sidebar-accent hover:text-cyan-600 dark:hover:text-cyan-300"
            onClick={openNewConnectionDialog}
            aria-label={t('sshNewConnection')}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 space-y-1 overflow-y-auto p-2">
          {connections.map((connection) => {
            const session = sessions.find((candidate) => candidate.connection.id === connection.id);
            return (
              <div
                key={connection.id}
                className={cn(
                  'group flex items-center rounded-md hover:bg-sidebar-accent',
                  selectedConnectionId === connection.id
                    && 'border-l-2 border-cyan-500 bg-cyan-500/10',
                )}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setContextMenu({
                    connection,
                    x: event.clientX,
                    y: event.clientY,
                  });
                }}
              >
                <button
                  type="button"
                  onClick={() => setSelectedConnectionId((selected) =>
                    selected === connection.id ? null : connection.id
                  )}
                  onDoubleClick={() => openConnection(connection)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      openConnection(connection);
                    }
                  }}
                  className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left"
                  aria-label={`${t('sshConnect')} ${connection.name}`}
                  aria-pressed={selectedConnectionId === connection.id}
                >
                  <span className={cn(
                    'h-2 w-2 shrink-0 rounded-full',
                    session?.state === 'connected' ? 'bg-emerald-500' : session ? 'bg-amber-500' : 'bg-muted-foreground/50',
                  )} />
                  <span className="min-w-0 flex-1">
                    <span className={cn(
                      'block truncate text-sm font-medium',
                      selectedConnectionId === connection.id ? 'text-cyan-300' : 'text-sidebar-foreground',
                    )}>{connection.name}</span>
                    <span className={cn(
                      'block truncate font-mono text-[11px]',
                      selectedConnectionId === connection.id ? 'text-cyan-300/70' : 'text-muted-foreground',
                    )}>
                      {connection.username}@{connection.host}:{connection.port}
                    </span>
                  </span>
                </button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="mr-1 text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                  onClick={() => removeConnection(connection)}
                  aria-label={`${t('sshDelete')} ${connection.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          })}
          {connections.length === 0 && (
            <div className="px-3 py-10 text-center text-xs leading-5 text-muted-foreground">
              {t('sshNoConnections')}
            </div>
          )}
        </div>

        <div className="border-t border-sidebar-border p-3">
          <Button
            className="w-full bg-cyan-600 text-white hover:bg-cyan-500"
            size="sm"
            onClick={openNewConnectionDialog}
          >
            <Plus className="h-4 w-4" />
            {t('sshNewConnection')}
          </Button>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-end gap-1 overflow-x-auto border-b border-border bg-sidebar px-2 pt-1">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={cn(
                'flex h-9 min-w-36 max-w-56 items-center rounded-t-md border border-b-0 px-2',
                session.id === activeSessionId
                  ? 'border-border bg-background text-foreground'
                  : 'border-transparent text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
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
                className="ml-1 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={`${t('sshClose')} ${session.connection.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>

        {activeSession && (
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-muted/30 px-4 text-xs">
            <div className="flex min-w-0 items-center gap-3">
              <span className="truncate font-mono text-muted-foreground">
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
                      : activeSession.state === 'error'
                        ? t('sshStateError')
                        : t('sshRouteResolving')}
              </Badge>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant={activeSession.sftpOpen ? 'secondary' : 'outline'}
                className="h-7"
                disabled={activeSession.state !== 'connected'}
                onClick={() => {
                  setSessions((current) => current.map((session) => (
                    session.id === activeSession.id
                      ? {
                          ...session,
                          sftpOpen: !session.sftpOpen,
                          sftpMounted: true,
                        }
                      : session
                  )));
                }}
                aria-label={activeSession.sftpOpen ? t('sftpCloseFiles') : t('sftpOpenFiles')}
              >
                <FolderTree className="h-3.5 w-3.5" />
                {t('sftpFiles')}
              </Button>
              <span className={cn(
                'font-medium',
                activeSession.state === 'connected'
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : activeSession.state === 'error'
                    ? 'text-destructive'
                    : 'text-amber-600 dark:text-amber-400',
              )}>
                {t('sshState')}: {t(stateTranslationKey(activeSession.state))}
              </span>
              {isReconnectable(activeSession) && activeSession.state !== 'error' && (
                <Button size="sm" variant="outline" className="h-7 border-border" onClick={() => reconnectSession(activeSession.id)}>
                  <RotateCw className="h-3.5 w-3.5" />
                  {t('sshReconnect')}
                </Button>
              )}
            </div>
          </div>
        )}

        {activeSession?.state === 'error'
          && activeSession.message
          && !activeSession.pendingHostKey && (
          <div
            role="alert"
            className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-popover px-4 py-3 text-sm text-destructive shadow-sm"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1">{t(errorTranslationKey(activeSession.message))}</span>
            {isReconnectable(activeSession) && (
              <Button
                size="sm"
                variant="outline"
                className="border-destructive/30 bg-transparent text-destructive hover:bg-destructive/10"
                onClick={() => reconnectSession(activeSession.id)}
              >
                <RotateCw className="h-3.5 w-3.5" />
                {t('sshReconnect')}
              </Button>
            )}
          </div>
        )}

        <div className="relative min-h-0 flex-1">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={cn('absolute inset-0 flex', session.id !== activeSessionId && 'hidden')}
            >
              <div className="h-full min-w-0 flex-1">
                <TerminalSurface
                  sessionId={session.id}
                  connection={session.connection}
                  visible={isVisible && session.id === activeSessionId}
                  retryToken={session.retryToken}
                  onEvent={onSessionEvent}
                />
              </div>
              {session.sftpMounted && session.state === 'connected' && (
                <SftpPanel
                  sessionId={session.id}
                  visible={isVisible && session.id === activeSessionId && session.sftpOpen}
                />
              )}
            </div>
          ))}

          {!activeSession && (
            <div className="flex h-full items-center justify-center bg-[radial-gradient(circle_at_center,_rgba(8,145,178,0.08),_transparent_45%)]">
              <div className="max-w-sm text-center">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl border border-cyan-500/20 bg-cyan-500/10">
                  <TerminalSquare className="h-7 w-7 text-cyan-400" />
                </div>
                <h2 className="mt-5 text-lg font-semibold text-foreground">{t('sshWorkspaceEmptyTitle')}</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('sshWorkspaceEmptyDesc')}</p>
                <Button className="mt-5 bg-cyan-600 text-white hover:bg-cyan-500" onClick={openNewConnectionDialog}>
                  <Plus className="h-4 w-4" />
                  {t('sshNewConnection')}
                </Button>
              </div>
            </div>
          )}

          {activeSession?.pendingHostKey && (
            <div className="absolute inset-x-4 top-4 z-20 rounded-lg border border-amber-500/40 bg-popover/95 p-4 text-popover-foreground shadow-2xl backdrop-blur">
              <div className="flex items-start gap-3">
                {activeSession.pendingHostKey.status === 'changed'
                  ? <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
                  : <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />}
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold text-popover-foreground">
                    {activeSession.pendingHostKey.status === 'changed'
                      ? t('sshHostKeyChanged')
                      : t('sshHostKeyUnknown')}
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {activeSession.pendingHostKey.status === 'changed'
                      ? t('sshHostKeyChangedWarning')
                      : t('sshHostKeyUnknownWarning')}
                  </p>
                  <div className="mt-3 rounded border border-border bg-muted/50 px-3 py-2 font-mono text-xs text-cyan-700 dark:text-cyan-300">
                    <div>{activeSession.pendingHostKey.algorithm}</div>
                    <div className="mt-1 break-all text-muted-foreground">{activeSession.pendingHostKey.fingerprint}</div>
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
        </div>
      </section>

      {contextMenu && (
        <>
          <div
            className="fixed inset-0 z-50"
            onClick={() => setContextMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu(null);
            }}
          />
          <div
            className="fixed z-50 min-w-40 rounded-lg border border-border/60 bg-card/95 py-1 shadow-xl backdrop-blur-md animate-in fade-in zoom-in-95 duration-100"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              type="button"
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-accent/50"
              onClick={() => {
                const { connection } = contextMenu;
                setContextMenu(null);
                openConnection(connection);
              }}
            >
              <Play className="h-3 w-3" />
              {t('sshConnect')}
            </button>
            <button
              type="button"
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-accent/50"
              onClick={() => openEditConnectionDialog(contextMenu.connection)}
            >
              <Pencil className="h-3 w-3" />
              {t('sshEdit')}
            </button>
            <div className="my-0.5 h-px bg-border/50" />
            <button
              type="button"
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-xs text-red-400 transition-colors hover:bg-red-500/10"
              onClick={() => {
                const { connection } = contextMenu;
                setContextMenu(null);
                removeConnection(connection);
              }}
            >
              <Trash2 className="h-3 w-3" />
              {t('sshDelete')}
            </button>
          </div>
        </>
      )}

      {dialogOpen && (
        <NewSshConnectionDialog
          open
          editConnection={editingConnection}
          onClose={() => {
            setDialogOpen(false);
            setEditingConnection(null);
          }}
          onCreated={addConnection}
          onUpdated={updateConnection}
        />
      )}
    </div>
  );
}

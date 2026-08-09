import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  KeyRound,
  MoreHorizontal,
  MoveRight,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Settings2,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/api";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/i18n/useTranslation";
import type { TranslationKey } from "@/i18n/translations";
import {
  SSH_DEFAULT_GROUP_ID,
  SSH_GROUP_NAME_MAX_LENGTH,
  loadSshWorkspaceState,
  saveSshConnections,
  saveSshGroups,
} from "./connection-store";
import { NewSshConnectionDialog } from "./NewSshConnectionDialog";
import { sshApi } from "./ssh-api";
import { SshCommandBar } from "./SshCommandBar";
import { SshResizeHandle } from "./SshResizeHandle";
import { SftpPanel } from "./SftpPanel";
import { SshSessionInfoPanel } from "./SshSessionInfoPanel";
import { SshHostKeyManagerDialog } from "./SshHostKeyManagerDialog";
import { SshTerminalSettingsDialog } from "./SshTerminalSettingsDialog";
import { TerminalSurface } from "./TerminalSurface";
import {
  SSH_DOCK_MAX_HEIGHT,
  SSH_DOCK_MIN_HEIGHT,
  SSH_INFO_PANEL_MAX_WIDTH,
  SSH_INFO_PANEL_MIN_WIDTH,
  loadSshWorkspaceLayout,
  saveSshWorkspaceLayout,
} from "./ssh-workspace-layout-store";
import {
  loadSshTerminalSettings,
  saveSshTerminalSettings,
} from "./ssh-terminal-settings-store";
import type {
  SshConnection,
  SshConnectionGroup,
  SshEvent,
  SshHostKeyPreview,
} from "./types";

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
  commandHistory: string[];
}

function newSessionId(connectionId: string): string {
  const suffix =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `ssh-${connectionId}-${suffix}`;
}

function newGroupId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `group-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isReconnectable(session: SshSessionTab): boolean {
  if (session.state === "disconnected" || session.state === "exited")
    return true;
  if (session.state !== "error" || !session.message) return false;
  const code = session.message.split(":", 1)[0];
  if (
    [
      "ssh_session_already_exists",
      "ssh_session_cancelled",
      "ssh_session_closed",
      "ssh_session_not_found",
      "ssh_start_failed",
    ].includes(code)
  )
    return true;
  return [
    "ssh_transport_",
    "ssh_channel_",
    "ssh_pty_",
    "ssh_shell_",
    "ssh_input_",
    "ssh_output_",
    "ssh_resize_",
    "ssh_proxy_",
  ].some((prefix) => session.message?.startsWith(prefix));
}

function errorTranslationKey(message: string): TranslationKey {
  const code = message.split(":", 1)[0];
  if (code === "ssh_session_already_exists") return "sshErrorSessionBusy";
  if (code === "ssh_session_cancelled") return "sshErrorCancelled";
  if (code === "ssh_session_closed" || code === "ssh_session_not_found") {
    return "sshErrorSessionClosed";
  }
  if (code.startsWith("ssh_kex_") || code.startsWith("ssh_host_key_"))
    return "sshErrorKex";
  if (code.startsWith("ssh_proxy_")) return "sshErrorProxy";
  if (code.includes("authentication") || code === "ssh_password_required")
    return "sshErrorAuth";
  if (code.includes("private_key") || code === "ssh_key_algorithm_failed")
    return "sshErrorPrivateKey";
  if (code.startsWith("credential_")) return "sshErrorCredential";
  if (code.startsWith("cloud_")) return "sshErrorCloud";
  if (code.startsWith("ssh_transport_")) return "sshErrorTransport";
  if (code.endsWith("_invalid") || code.endsWith("_required"))
    return "sshErrorInvalid";
  return "sshErrorGeneric";
}

function isLifecycleClosure(message?: string): boolean {
  const code = message?.split(":", 1)[0];
  return code === "ssh_session_closed" || code === "ssh_session_not_found";
}

function credentialReferences(connection: SshConnection): string[] {
  return [
    connection.credentialReference,
    connection.proxyCredentialReference,
  ].filter((reference): reference is string => Boolean(reference));
}

function joinRemotePath(parent: string, child: string): string {
  return parent === "/"
    ? `/${child}`
    : `${parent.replace(/\/+$/, "")}/${child}`;
}

async function completeRemoteCommandPath(
  sessionId: string,
  command: string,
): Promise<string[]> {
  const tokenMatch = command.match(/(?:^|\s)([^\s]*)$/);
  const token = tokenMatch?.[1] ?? "";
  if (!token) return [];
  const home = (await api.sshSftpOpen(sessionId)).path;
  const lastSlash = token.lastIndexOf("/");
  const typedParent = lastSlash >= 0 ? token.slice(0, lastSlash + 1) : "";
  const typedName = lastSlash >= 0 ? token.slice(lastSlash + 1) : token;
  let lookupParent = home;
  if (typedParent.startsWith("/")) lookupParent = typedParent || "/";
  else if (typedParent.startsWith("~/")) {
    lookupParent = joinRemotePath(
      home,
      typedParent.slice(2).replace(/\/+$/, ""),
    );
  } else if (typedParent) {
    lookupParent = joinRemotePath(home, typedParent.replace(/\/+$/, ""));
  }
  const listing = await api.sshSftpList(sessionId, lookupParent);
  const commandPrefix = command.slice(0, command.length - token.length);
  return listing.entries
    .filter((entry) => entry.name.startsWith(typedName))
    .slice(0, 100)
    .map((entry) => {
      const escapedName = entry.name.replace(/([\s\\"'])/g, "\\$1");
      const suffix = entry.kind === "directory" ? "/" : " ";
      return `${commandPrefix}${typedParent}${escapedName}${suffix}`;
    });
}

export function SshWorkspace({
  isVisible,
  onMainSidebarCollapse,
}: SshWorkspaceProps) {
  const { t } = useTranslation();
  const [initialWorkspace] = useState(loadSshWorkspaceState);
  const [workspaceLayout, setWorkspaceLayout] = useState(
    loadSshWorkspaceLayout,
  );
  const [terminalSettings, setTerminalSettings] = useState(
    loadSshTerminalSettings,
  );
  const [connections, setConnections] = useState<SshConnection[]>(
    initialWorkspace.connections,
  );
  const [groups, setGroups] = useState<SshConnectionGroup[]>(
    initialWorkspace.groups,
  );
  const [selectedConnectionId, setSelectedConnectionId] = useState<
    string | null
  >(null);
  const [connectionsSidebarOpen, setConnectionsSidebarOpen] = useState(true);
  const [sessions, setSessions] = useState<SshSessionTab[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [hostKeyManagerOpen, setHostKeyManagerOpen] = useState(false);
  const [terminalSettingsOpen, setTerminalSettingsOpen] = useState(false);
  const [sidebarToolsOpen, setSidebarToolsOpen] = useState(false);
  const [editingConnection, setEditingConnection] =
    useState<SshConnection | null>(null);
  const [groupFormOpen, setGroupFormOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [groupNameError, setGroupNameError] = useState(false);
  const [moveMenuOpen, setMoveMenuOpen] = useState(false);
  const [groupContextMenu, setGroupContextMenu] = useState<{
    group: SshConnectionGroup;
    x: number;
    y: number;
  } | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState("");
  const [draggedConnectionId, setDraggedConnectionId] = useState<string | null>(
    null,
  );
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    connection: SshConnection;
    x: number;
    y: number;
  } | null>(null);
  const [sessionContextMenu, setSessionContextMenu] = useState<{
    sessionId: string;
    x: number;
    y: number;
  } | null>(null);
  const pendingCredentialCleanupRef = useRef(new Set<string>());
  const previousSessionCountRef = useRef(sessions.length);
  const sidebarToolsRef = useRef<HTMLDivElement>(null);
  const sidebarToolsTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    saveSshWorkspaceLayout(workspaceLayout);
  }, [workspaceLayout]);

  useEffect(() => {
    saveSshTerminalSettings(terminalSettings);
  }, [terminalSettings]);

  useEffect(() => {
    if (previousSessionCountRef.current > 0 && sessions.length === 0) {
      setConnectionsSidebarOpen(true);
    }
    previousSessionCountRef.current = sessions.length;
  }, [sessions.length]);

  useEffect(() => {
    if (!sidebarToolsOpen) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!sidebarToolsRef.current?.contains(event.target as Node)) {
        setSidebarToolsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSidebarToolsOpen(false);
      sidebarToolsTriggerRef.current?.focus();
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [sidebarToolsOpen]);

  useEffect(() => {
    if (!sidebarToolsOpen) return;
    const frame = window.requestAnimationFrame(() => {
      sidebarToolsRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
        ?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [sidebarToolsOpen]);

  useEffect(() => {
    const referencesInUse = new Set([
      ...connections.flatMap(credentialReferences),
      ...sessions.flatMap((session) =>
        credentialReferences(session.connection),
      ),
    ]);
    for (const reference of pendingCredentialCleanupRef.current) {
      if (referencesInUse.has(reference)) continue;
      pendingCredentialCleanupRef.current.delete(reference);
      void sshApi.deleteCredential(reference).catch(() => {
        pendingCredentialCleanupRef.current.add(reference);
      });
    }
  }, [connections, sessions]);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [activeSessionId, sessions],
  );

  const openConnection = useCallback(
    (connection: SshConnection) => {
      const sessionId = newSessionId(connection.id);
      setConnectionsSidebarOpen(false);
      setSelectedConnectionId(connection.id);
      setSessions((current) => [
        ...current,
        {
          id: sessionId,
          connection,
          state: "resolving_route",
          retryToken: 0,
          sftpOpen: true,
          sftpMounted: true,
          commandHistory: [],
        },
      ]);
      setActiveSessionId(sessionId);
      onMainSidebarCollapse?.();
    },
    [onMainSidebarCollapse],
  );

  const onSessionEvent = useCallback((event: SshEvent) => {
    setSessions((current) =>
      current.map((session) => {
        if (session.id !== event.sessionId) return session;
        if (event.kind === "host_key") {
          return {
            ...session,
            state: "host_key_required",
            pendingHostKey: event.preview,
            message: undefined,
          };
        }
        if (session.pendingHostKey && event.state === "disconnected")
          return session;
        if (
          session.state === "error" &&
          session.message &&
          event.state === "error" &&
          isLifecycleClosure(event.message) &&
          !isLifecycleClosure(session.message)
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

  const sendSessionCommand = useCallback(
    async (sessionId: string, command: string) => {
      await sshApi.input(sessionId, new TextEncoder().encode(`${command}\r`));
      setSessions((current) =>
        current.map((session) =>
          session.id === sessionId
            ? {
                ...session,
                commandHistory: [
                  command,
                  ...session.commandHistory.filter(
                    (entry) => entry !== command,
                  ),
                ].slice(0, 50),
              }
            : session,
        ),
      );
    },
    [],
  );

  const sendCommandToSessions = useCallback(
    async (command: string, targetSessionIds?: string[]) => {
      const requested = new Set(targetSessionIds ?? []);
      const targetIds = sessions
        .filter((session) => session.state === "connected")
        .filter((session) => requested.size === 0 || requested.has(session.id))
        .map((session) => session.id);
      if (targetIds.length === 0) throw new Error("ssh_session_not_found");
      await Promise.all(
        targetIds.map((sessionId) => sendSessionCommand(sessionId, command)),
      );
    },
    [sendSessionCommand, sessions],
  );

  const trustAndReconnect = useCallback(
    async (sessionId: string) => {
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
                  state: "resolving_route",
                  routeLabel: undefined,
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
                  state: "error",
                  message:
                    error instanceof Error ? error.message : String(error),
                }
              : candidate,
          ),
        );
      }
    },
    [sessions],
  );

  const reconnectSession = useCallback((sessionId: string) => {
    setSessions((current) =>
      current.map((candidate) =>
        candidate.id === sessionId
          ? {
              ...candidate,
              state: "resolving_route",
              routeLabel: undefined,
              message: undefined,
              retryToken: candidate.retryToken + 1,
            }
          : candidate,
      ),
    );
  }, []);

  const addConnection = useCallback(
    (connection: SshConnection) => {
      setConnections((current) => {
        const next = [...current, connection];
        saveSshConnections(next);
        return next;
      });
      openConnection(connection);
    },
    [openConnection],
  );

  const updateConnection = useCallback((connection: SshConnection) => {
    setConnections((current) => {
      const previous = current.find(
        (candidate) => candidate.id === connection.id,
      );
      const retainedReferences = new Set(credentialReferences(connection));
      credentialReferences(previous ?? connection)
        .filter((reference) => !retainedReferences.has(reference))
        .forEach((reference) =>
          pendingCredentialCleanupRef.current.add(reference),
        );
      const next = current.map((candidate) =>
        candidate.id === connection.id ? connection : candidate,
      );
      saveSshConnections(next);
      return next;
    });
  }, []);

  const updateDetectedOs = useCallback(
    (connectionId: string, detectedOs: SshConnection["detectedOs"]) => {
      if (!detectedOs || detectedOs === "unknown") return;
      setConnections((current) => {
        if (
          !current.some(
            (connection) =>
              connection.id === connectionId &&
              connection.detectedOs !== detectedOs,
          )
        )
          return current;
        const next = current.map((connection) =>
          connection.id === connectionId
            ? { ...connection, detectedOs }
            : connection,
        );
        saveSshConnections(next);
        return next;
      });
    },
    [],
  );

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

  const removeConnection = useCallback(
    (connection: SshConnection) => {
      credentialReferences(connection).forEach((reference) =>
        pendingCredentialCleanupRef.current.add(reference),
      );
      sessions
        .filter((session) => session.connection.id === connection.id)
        .forEach((session) => closeSession(session.id));
      setConnections((current) => {
        const next = current.filter(
          (candidate) => candidate.id !== connection.id,
        );
        saveSshConnections(next);
        return next;
      });
      setSelectedConnectionId((selected) =>
        selected === connection.id ? null : selected,
      );
    },
    [closeSession, sessions],
  );

  const toggleGroup = useCallback((groupId: string) => {
    setGroups((current) => {
      const next = current.map((group) =>
        group.id === groupId
          ? { ...group, isExpanded: !group.isExpanded }
          : group,
      );
      saveSshGroups(next);
      return next;
    });
  }, []);

  const closeGroupForm = useCallback(() => {
    setGroupFormOpen(false);
    setNewGroupName("");
    setGroupNameError(false);
  }, []);

  const createGroup = useCallback(() => {
    const name = newGroupName.trim();
    if (
      !name ||
      groups.some(
        (group) => group.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    ) {
      setGroupNameError(true);
      return;
    }
    setGroups((current) => {
      const next = [...current, { id: newGroupId(), name, isExpanded: true }];
      saveSshGroups(next);
      return next;
    });
    closeGroupForm();
  }, [closeGroupForm, groups, newGroupName]);

  const moveConnectionToGroup = useCallback(
    (connectionId: string, groupId: string) => {
      setConnections((current) => {
        const next = current.map((connection) =>
          connection.id === connectionId
            ? { ...connection, groupId }
            : connection,
        );
        saveSshConnections(next);
        return next;
      });
      setContextMenu(null);
      setMoveMenuOpen(false);
    },
    [],
  );

  const finishGroupRename = useCallback(
    (groupId: string) => {
      const name = editingGroupName.trim();
      if (
        name &&
        !groups.some(
          (group) =>
            group.id !== groupId &&
            group.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
        )
      ) {
        setGroups((current) => {
          const next = current.map((group) =>
            group.id === groupId ? { ...group, name } : group,
          );
          saveSshGroups(next);
          return next;
        });
      }
      setEditingGroupId(null);
      setEditingGroupName("");
    },
    [editingGroupName, groups],
  );

  const deleteGroup = useCallback((groupId: string) => {
    if (groupId === SSH_DEFAULT_GROUP_ID) return;
    setGroups((current) => {
      const next = current.filter((group) => group.id !== groupId);
      saveSshGroups(next);
      return next;
    });
    setConnections((current) => {
      const next = current.map((connection) =>
        connection.groupId === groupId
          ? { ...connection, groupId: SSH_DEFAULT_GROUP_ID }
          : connection,
      );
      saveSshConnections(next);
      return next;
    });
    setGroupContextMenu(null);
  }, []);

  return (
    <div className="flex h-full min-h-0 bg-background text-foreground transition-colors duration-300">
      {connectionsSidebarOpen && (
        <aside className="flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
          <div
            data-region="ssh-sidebar-header"
            className="flex h-[73px] shrink-0 items-center border-b border-sidebar-border px-3"
          >
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <TerminalSquare className="h-4 w-4 shrink-0 text-cyan-600 dark:text-cyan-400" />
              <span className="truncate whitespace-nowrap text-sm font-semibold">
                {t("sshConnections")}
              </span>
            </div>
            <div
              ref={sidebarToolsRef}
              className="relative ml-2 flex shrink-0 items-center gap-1"
            >
              <Button
                ref={sidebarToolsTriggerRef}
                type="button"
                size="icon-sm"
                variant="ghost"
                className={cn(
                  "text-muted-foreground hover:bg-sidebar-accent hover:text-cyan-600 dark:hover:text-cyan-300",
                  sidebarToolsOpen &&
                    "bg-sidebar-accent text-cyan-600 dark:text-cyan-300",
                )}
                onClick={() => setSidebarToolsOpen((current) => !current)}
                aria-label={t("sshMoreActions")}
                aria-haspopup="menu"
                aria-expanded={sidebarToolsOpen}
                title={t("sshMoreActions")}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>

              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="text-muted-foreground hover:bg-sidebar-accent hover:text-cyan-600 dark:hover:text-cyan-300"
                onClick={() => {
                  setSidebarToolsOpen(false);
                  setConnectionsSidebarOpen(false);
                }}
                aria-label={t("sshHideConnections")}
                title={t("sshHideConnections")}
              >
                <PanelLeftClose className="h-4 w-4" />
              </Button>

              {sidebarToolsOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-full z-50 mt-3 w-52 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-xl animate-in fade-in-0 zoom-in-95"
                  onKeyDown={(event) => {
                    if (
                      event.key !== "ArrowDown" &&
                      event.key !== "ArrowUp" &&
                      event.key !== "Home" &&
                      event.key !== "End"
                    ) {
                      return;
                    }
                    event.preventDefault();
                    const items = Array.from(
                      event.currentTarget.querySelectorAll<HTMLButtonElement>(
                        '[role="menuitem"]',
                      ),
                    );
                    if (items.length === 0) return;
                    const activeIndex = items.indexOf(
                      document.activeElement as HTMLButtonElement,
                    );
                    if (event.key === "Home") items[0]?.focus();
                    else if (event.key === "End") items.at(-1)?.focus();
                    else if (event.key === "ArrowDown") {
                      items[(activeIndex + 1) % items.length]?.focus();
                    } else {
                      items[
                        (activeIndex - 1 + items.length) % items.length
                      ]?.focus();
                    }
                  }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none"
                    onClick={() => {
                      setSidebarToolsOpen(false);
                      setTerminalSettingsOpen(true);
                    }}
                  >
                    <Settings2 className="h-4 w-4 shrink-0" />
                    {t("sshTerminalSettings")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none"
                    onClick={() => {
                      setSidebarToolsOpen(false);
                      setHostKeyManagerOpen(true);
                    }}
                  >
                    <ShieldCheck className="h-4 w-4 shrink-0" />
                    {t("sshKnownHostsTitle")}
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="flex-1 space-y-1 overflow-y-auto p-2">
            {groups.map((group) => {
              const groupName =
                group.id === SSH_DEFAULT_GROUP_ID
                  ? t("sshDefaultGroup")
                  : group.name;
              const groupConnections = connections.filter(
                (connection) => connection.groupId === group.id,
              );
              return (
                <div key={group.id} className="rounded-md">
                  {editingGroupId === group.id ? (
                    <div className="px-2 py-1">
                      <Input
                        value={editingGroupName}
                        onChange={(event) =>
                          setEditingGroupName(event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter")
                            finishGroupRename(group.id);
                          if (event.key === "Escape") {
                            setEditingGroupId(null);
                            setEditingGroupName("");
                          }
                        }}
                        onBlur={() => finishGroupRename(group.id)}
                        className="h-7 text-xs"
                        aria-label={t("sshRenameGroup")}
                        maxLength={SSH_GROUP_NAME_MAX_LENGTH}
                        autoFocus
                      />
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggleGroup(group.id)}
                      onDragOver={(event) => {
                        if (!draggedConnectionId) return;
                        event.preventDefault();
                        if (event.dataTransfer)
                          event.dataTransfer.dropEffect = "move";
                        setDragOverGroupId(group.id);
                      }}
                      onDragLeave={() =>
                        setDragOverGroupId((current) =>
                          current === group.id ? null : current,
                        )
                      }
                      onDrop={(event) => {
                        event.preventDefault();
                        if (draggedConnectionId) {
                          moveConnectionToGroup(draggedConnectionId, group.id);
                        }
                        setDraggedConnectionId(null);
                        setDragOverGroupId(null);
                      }}
                      onContextMenu={(event) => {
                        if (group.id === SSH_DEFAULT_GROUP_ID) return;
                        event.preventDefault();
                        setGroupContextMenu({
                          group,
                          x: event.clientX,
                          y: event.clientY,
                        });
                      }}
                      className={cn(
                        "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                        dragOverGroupId === group.id &&
                          "bg-cyan-500/15 text-cyan-700 ring-1 ring-inset ring-cyan-500/40 dark:text-cyan-300",
                      )}
                      aria-label={`${t("sshToggleGroup")} ${groupName}`}
                      aria-expanded={group.isExpanded}
                    >
                      {group.isExpanded ? (
                        <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                      )}
                      <span className="truncate">{groupName}</span>
                      <span className="ml-auto text-[10px] text-muted-foreground/70">
                        {groupConnections.length}
                      </span>
                    </button>
                  )}
                  {group.isExpanded &&
                    groupConnections.map((connection) => {
                      const session = sessions.find(
                        (candidate) =>
                          candidate.connection.id === connection.id,
                      );
                      return (
                        <div
                          key={connection.id}
                          className={cn(
                            "group flex items-center rounded-md hover:bg-sidebar-accent",
                            selectedConnectionId === connection.id &&
                              "border-l-2 border-cyan-500 bg-cyan-500/10",
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
                            draggable
                            onDragStart={(event) => {
                              setDraggedConnectionId(connection.id);
                              if (event.dataTransfer) {
                                event.dataTransfer.effectAllowed = "move";
                                event.dataTransfer.setData(
                                  "application/x-nextdesk-ssh-connection",
                                  connection.id,
                                );
                              }
                            }}
                            onDragEnd={() => {
                              setDraggedConnectionId(null);
                              setDragOverGroupId(null);
                            }}
                            onClick={() =>
                              setSelectedConnectionId((selected) =>
                                selected === connection.id
                                  ? null
                                  : connection.id,
                              )
                            }
                            onDoubleClick={() => openConnection(connection)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                openConnection(connection);
                              }
                            }}
                            className="flex min-w-0 flex-1 items-center gap-3 py-2 pl-5 pr-3 text-left"
                            aria-label={`${t("sshConnect")} ${connection.name}`}
                            aria-pressed={
                              selectedConnectionId === connection.id
                            }
                          >
                            <span
                              className={cn(
                                "h-2 w-2 shrink-0 rounded-full",
                                session?.state === "connected"
                                  ? "bg-emerald-500"
                                  : session
                                    ? "bg-amber-500"
                                    : "bg-muted-foreground/50",
                              )}
                            />
                            <span className="min-w-0 flex-1">
                              <span
                                className={cn(
                                  "block truncate text-sm font-medium",
                                  selectedConnectionId === connection.id
                                    ? "text-cyan-300"
                                    : "text-sidebar-foreground",
                                )}
                              >
                                {connection.name}
                              </span>
                              <span
                                className={cn(
                                  "block truncate font-mono text-[11px]",
                                  selectedConnectionId === connection.id
                                    ? "text-cyan-300/70"
                                    : "text-muted-foreground",
                                )}
                              >
                                {connection.username}@{connection.host}:
                                {connection.port}
                              </span>
                            </span>
                          </button>
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            className="mr-1 text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                            onClick={() => removeConnection(connection)}
                            aria-label={`${t("sshDelete")} ${connection.name}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      );
                    })}
                </div>
              );
            })}
            {connections.length === 0 && (
              <div className="px-3 py-10 text-center text-xs leading-5 text-muted-foreground">
                {t("sshNoConnections")}
              </div>
            )}
          </div>

          <div
            data-region="ssh-sidebar-actions"
            className={cn(
              "shrink-0 border-t border-sidebar-border px-3",
              groupFormOpen ? "py-1.5" : "flex h-11 items-center",
            )}
          >
            {groupFormOpen ? (
              <div className="space-y-1.5">
                <div className="flex gap-1">
                  <Input
                    value={newGroupName}
                    onChange={(event) => {
                      setNewGroupName(event.target.value);
                      setGroupNameError(false);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") createGroup();
                      if (event.key === "Escape") closeGroupForm();
                    }}
                    className={cn(
                      "h-8 text-xs",
                      groupNameError && "border-destructive",
                    )}
                    placeholder={t("sshGroupName")}
                    aria-label={t("sshGroupName")}
                    maxLength={SSH_GROUP_NAME_MAX_LENGTH}
                    autoFocus
                  />
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 px-2"
                    onClick={createGroup}
                    aria-label={t("sshCreateGroup")}
                  >
                    {t("sshCreate")}
                  </Button>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="h-8 w-8"
                    onClick={closeGroupForm}
                    aria-label={t("sshCancel")}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {groupNameError && (
                  <p className="px-1 text-[10px] text-destructive">
                    {t("sshDuplicateGroup")}
                  </p>
                )}
              </div>
            ) : (
              <div className="flex w-full gap-2">
                <Button
                  className="min-w-0 flex-1 bg-cyan-600 text-white hover:bg-cyan-500"
                  size="sm"
                  onClick={openNewConnectionDialog}
                >
                  <Plus className="h-4 w-4" />
                  {t("sshConnection")}
                </Button>
                <Button
                  className="min-w-0 flex-1"
                  size="sm"
                  variant="outline"
                  onClick={() => setGroupFormOpen(true)}
                  aria-label={t("sshNewGroup")}
                >
                  <FolderPlus className="h-4 w-4" />
                  {t("sshGroup")}
                </Button>
              </div>
            )}
          </div>
        </aside>
      )}

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-end gap-1 overflow-x-auto border-b border-border bg-sidebar px-2 pt-1">
          {!connectionsSidebarOpen && (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="mb-1 h-8 w-8 shrink-0 text-muted-foreground hover:bg-sidebar-accent hover:text-cyan-600 dark:hover:text-cyan-300"
              onClick={() => setConnectionsSidebarOpen(true)}
              aria-label={t("sshShowConnections")}
            >
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
          )}
          {sessions.map((session) => (
            <div
              key={session.id}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setActiveSessionId(session.id);
                setContextMenu(null);
                setGroupContextMenu(null);
                setSessionContextMenu({
                  sessionId: session.id,
                  x: Math.max(
                    8,
                    Math.min(event.clientX, window.innerWidth - 168),
                  ),
                  y: Math.max(
                    8,
                    Math.min(event.clientY, window.innerHeight - 88),
                  ),
                });
              }}
              className={cn(
                "flex h-9 min-w-36 max-w-56 items-center rounded-t-md border border-b-0 px-2",
                session.id === activeSessionId
                  ? "border-border bg-background text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
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
                aria-label={`${t("sshClose")} ${session.connection.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>

        {activeSession?.state === "error" &&
          activeSession.message &&
          !activeSession.pendingHostKey && (
            <div
              role="alert"
              className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-popover px-4 py-3 text-sm text-destructive shadow-sm"
            >
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">
                {t(errorTranslationKey(activeSession.message))}
              </span>
              {isReconnectable(activeSession) && (
                <Button
                  size="sm"
                  variant="outline"
                  className="border-destructive/30 bg-transparent text-destructive hover:bg-destructive/10"
                  onClick={() => reconnectSession(activeSession.id)}
                >
                  <RotateCw className="h-3.5 w-3.5" />
                  {t("sshReconnect")}
                </Button>
              )}
            </div>
          )}

        <div className="relative min-h-0 flex-1">
          {sessions.map((session) => {
            const persistedConnection =
              connections.find(
                (connection) => connection.id === session.connection.id,
              ) ?? session.connection;
            return (
              <div
                key={session.id}
                className={cn(
                  "absolute inset-0 flex",
                  session.id !== activeSessionId && "hidden",
                )}
              >
                <SshSessionInfoPanel
                  sessionId={session.id}
                  active={isVisible && session.id === activeSessionId}
                  connection={persistedConnection}
                  state={session.state}
                  routeLabel={session.routeLabel}
                  width={workspaceLayout.infoPanelWidth}
                  onDetectedOs={updateDetectedOs}
                />
                <SshResizeHandle
                  orientation="vertical"
                  value={workspaceLayout.infoPanelWidth}
                  minimum={SSH_INFO_PANEL_MIN_WIDTH}
                  maximum={SSH_INFO_PANEL_MAX_WIDTH}
                  label={t("sshResizeInformationPanel")}
                  onChange={(infoPanelWidth) =>
                    setWorkspaceLayout((current) => ({
                      ...current,
                      infoPanelWidth,
                    }))
                  }
                />
                <div
                  data-region="ssh-session-content"
                  className="flex min-w-0 flex-1 flex-col"
                >
                  <div
                    data-region="ssh-terminal-canvas"
                    className="relative min-h-0 min-w-0 flex-1"
                  >
                    <TerminalSurface
                      sessionId={session.id}
                      connection={session.connection}
                      visible={isVisible && session.id === activeSessionId}
                      retryToken={session.retryToken}
                      onEvent={onSessionEvent}
                      settings={terminalSettings}
                    />
                    {session.pendingHostKey && (
                      <SshHostKeyPrompt
                        sessionId={session.id}
                        preview={session.pendingHostKey}
                        onConfirm={() => void trustAndReconnect(session.id)}
                        onCancel={() => closeSession(session.id)}
                      />
                    )}
                    {!session.pendingHostKey &&
                      (session.state === "disconnected" ||
                        session.state === "exited") && (
                        <div
                          data-region="ssh-reconnect-prompt"
                          role="status"
                          className="absolute right-4 top-4 z-10 flex items-center gap-3 rounded-lg border border-amber-500/30 bg-popover/95 p-2 pl-3 text-popover-foreground shadow-xl backdrop-blur"
                        >
                          <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                            <span className="h-2 w-2 rounded-full bg-amber-500" />
                            {session.state === "exited"
                              ? t("sshStateExited")
                              : t("sshStateDisconnected")}
                          </span>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 border-amber-500/30 bg-background/70"
                            onClick={() => reconnectSession(session.id)}
                          >
                            <RotateCw className="h-3.5 w-3.5" />
                            {t("sshReconnect")}
                          </Button>
                        </div>
                      )}
                  </div>
                  <SshCommandBar
                    connected={session.state === "connected"}
                    dockOpen={session.sftpOpen}
                    history={session.commandHistory}
                    onSend={(command) =>
                      sendSessionCommand(session.id, command)
                    }
                    onComplete={(command) =>
                      completeRemoteCommandPath(session.id, command)
                    }
                    onToggleDock={() => {
                      setSessions((current) =>
                        current.map((currentSession) =>
                          currentSession.id === session.id
                            ? {
                                ...currentSession,
                                sftpOpen: !currentSession.sftpOpen,
                                sftpMounted: true,
                              }
                            : currentSession,
                        ),
                      );
                    }}
                  />
                  {session.sftpMounted && session.state === "connected" && (
                    <div
                      data-region="ssh-sftp-drawer"
                      className={cn(
                        "flex w-full shrink-0 flex-col border-t border-border",
                        !session.sftpOpen && "hidden",
                      )}
                      style={{ height: workspaceLayout.dockHeight }}
                    >
                      <SshResizeHandle
                        orientation="horizontal"
                        value={workspaceLayout.dockHeight}
                        minimum={SSH_DOCK_MIN_HEIGHT}
                        maximum={SSH_DOCK_MAX_HEIGHT}
                        label={t("sshResizeDock")}
                        onChange={(dockHeight) =>
                          setWorkspaceLayout((current) => ({
                            ...current,
                            dockHeight,
                          }))
                        }
                      />
                      <div className="min-h-0 flex-1">
                        <SftpPanel
                          sessionId={session.id}
                          visible={
                            isVisible &&
                            session.id === activeSessionId &&
                            session.sftpOpen
                          }
                          commandHistory={session.commandHistory}
                          commandTargets={sessions
                            .filter(
                              (candidate) => candidate.state === "connected",
                            )
                            .map((candidate) => ({
                              id: candidate.id,
                              name: candidate.connection.name,
                            }))}
                          onRunCommand={(command, targetSessionIds) =>
                            sendCommandToSessions(
                              command,
                              targetSessionIds ?? [session.id],
                            )
                          }
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {!activeSession && (
            <div className="flex h-full items-center justify-center bg-[radial-gradient(circle_at_center,_rgba(8,145,178,0.08),_transparent_45%)]">
              <div className="max-w-sm text-center">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl border border-cyan-500/20 bg-cyan-500/10">
                  <TerminalSquare className="h-7 w-7 text-cyan-400" />
                </div>
                <h2 className="mt-5 text-lg font-semibold text-foreground">
                  {t("sshWorkspaceEmptyTitle")}
                </h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {t("sshWorkspaceEmptyDesc")}
                </p>
                <Button
                  className="mt-5 bg-cyan-600 text-white hover:bg-cyan-500"
                  onClick={openNewConnectionDialog}
                >
                  <Plus className="h-4 w-4" />
                  {t("sshNewConnection")}
                </Button>
              </div>
            </div>
          )}

        </div>
      </section>

      {sessionContextMenu && (
        <>
          <div
            className="fixed inset-0 z-50"
            onClick={() => setSessionContextMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setSessionContextMenu(null);
            }}
          />
          <div
            data-region="ssh-session-tab-context-menu"
            role="menu"
            aria-label={t("sshReconnect")}
            className="fixed z-[51] min-w-40 rounded-lg border border-border/60 bg-card/95 py-1 shadow-xl backdrop-blur-md animate-in fade-in zoom-in-95 duration-100"
            style={{
              left: sessionContextMenu.x,
              top: sessionContextMenu.y,
            }}
          >
            <button
              type="button"
              role="menuitem"
              autoFocus
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-accent/50 focus:bg-accent/50 focus:outline-none"
              onKeyDown={(event) => {
                if (event.key === "Escape") setSessionContextMenu(null);
              }}
              onClick={() => {
                reconnectSession(sessionContextMenu.sessionId);
                setSessionContextMenu(null);
              }}
            >
              <RotateCw className="h-3.5 w-3.5" />
              {t("sshReconnect")}
            </button>
            <div className="my-0.5 h-px bg-border/50" />
            <button
              type="button"
              role="menuitem"
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10 focus:bg-destructive/10 focus:outline-none"
              onKeyDown={(event) => {
                if (event.key === "Escape") setSessionContextMenu(null);
              }}
              onClick={() => {
                closeSession(sessionContextMenu.sessionId);
                setSessionContextMenu(null);
              }}
            >
              <X className="h-3.5 w-3.5" />
              {t("sshClose")}
            </button>
          </div>
        </>
      )}

      {contextMenu && (
        <>
          <div
            className="fixed inset-0 z-50"
            onClick={() => {
              setContextMenu(null);
              setMoveMenuOpen(false);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu(null);
              setMoveMenuOpen(false);
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
              {t("sshConnect")}
            </button>
            <button
              type="button"
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-accent/50"
              onClick={() => openEditConnectionDialog(contextMenu.connection)}
            >
              <Pencil className="h-3 w-3" />
              {t("sshEdit")}
            </button>
            {groups.some(
              (group) => group.id !== contextMenu.connection.groupId,
            ) && (
              <div className="relative">
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-accent/50"
                  onClick={() => setMoveMenuOpen((open) => !open)}
                  aria-label={t("sshMoveToGroup")}
                >
                  <MoveRight className="h-3 w-3" />
                  {t("sshMoveToGroup")}
                  <ChevronRight className="ml-auto h-3 w-3" />
                </button>
                {moveMenuOpen && (
                  <div className="absolute left-full top-0 ml-1 min-w-36 rounded-lg border border-border/60 bg-card/95 py-1 shadow-xl backdrop-blur-md">
                    {groups
                      .filter(
                        (group) => group.id !== contextMenu.connection.groupId,
                      )
                      .map((group) => {
                        const groupName =
                          group.id === SSH_DEFAULT_GROUP_ID
                            ? t("sshDefaultGroup")
                            : group.name;
                        return (
                          <button
                            key={group.id}
                            type="button"
                            className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-accent/50"
                            onClick={() =>
                              moveConnectionToGroup(
                                contextMenu.connection.id,
                                group.id,
                              )
                            }
                            aria-label={`${t("sshMoveConnectionTo")} ${groupName}`}
                          >
                            <FolderPlus className="h-3 w-3 text-muted-foreground" />
                            <span className="truncate">{groupName}</span>
                          </button>
                        );
                      })}
                  </div>
                )}
              </div>
            )}
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
              {t("sshDelete")}
            </button>
          </div>
        </>
      )}

      {groupContextMenu && (
        <>
          <div
            className="fixed inset-0 z-50"
            onClick={() => setGroupContextMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setGroupContextMenu(null);
            }}
          />
          <div
            className="fixed z-50 min-w-40 rounded-lg border border-border/60 bg-card/95 py-1 shadow-xl backdrop-blur-md animate-in fade-in zoom-in-95 duration-100"
            style={{ left: groupContextMenu.x, top: groupContextMenu.y }}
          >
            <button
              type="button"
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-accent/50"
              onClick={() => {
                setEditingGroupId(groupContextMenu.group.id);
                setEditingGroupName(groupContextMenu.group.name);
                setGroupContextMenu(null);
              }}
              aria-label={t("sshRenameGroup")}
            >
              <Pencil className="h-3 w-3" />
              {t("sshRenameGroup")}
            </button>
            <div className="my-0.5 h-px bg-border/50" />
            <button
              type="button"
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-xs text-red-400 transition-colors hover:bg-red-500/10"
              onClick={() => deleteGroup(groupContextMenu.group.id)}
              aria-label={t("sshDeleteGroup")}
            >
              <Trash2 className="h-3 w-3" />
              {t("sshDeleteGroup")}
            </button>
          </div>
        </>
      )}

      {dialogOpen && (
        <NewSshConnectionDialog
          open
          editConnection={editingConnection}
          groups={groups}
          onClose={() => {
            setDialogOpen(false);
            setEditingConnection(null);
          }}
          onCreated={addConnection}
          onUpdated={updateConnection}
        />
      )}
      <SshHostKeyManagerDialog
        open={hostKeyManagerOpen}
        onClose={() => setHostKeyManagerOpen(false)}
      />
      <SshTerminalSettingsDialog
        open={terminalSettingsOpen}
        settings={terminalSettings}
        onChange={setTerminalSettings}
        onClose={() => setTerminalSettingsOpen(false)}
      />
    </div>
  );
}

function SshHostKeyPrompt({
  sessionId,
  preview,
  onConfirm,
  onCancel,
}: {
  sessionId: string;
  preview: SshHostKeyPreview;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = `${sessionId}-host-key-title`;
  const descriptionId = `${sessionId}-host-key-description`;
  const changed = preview.status === "changed";

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  return (
    <div
      data-region="ssh-host-key-prompt"
      className="absolute inset-0 z-20 flex items-start justify-center overflow-y-auto bg-background/45 p-4 pt-5 backdrop-blur-[1px]"
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
        className={cn(
          "w-full max-w-3xl rounded-xl border bg-popover/95 p-4 text-popover-foreground shadow-2xl outline-none backdrop-blur",
          changed ? "border-destructive/50" : "border-amber-500/40",
        )}
      >
        <div className="flex items-start gap-3">
          {changed ? (
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          ) : (
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
          )}
          <div className="min-w-0 flex-1">
            <h3 id={titleId} className="font-semibold text-popover-foreground">
              {changed ? t("sshHostKeyChanged") : t("sshHostKeyUnknown")}
            </h3>
            <p
              id={descriptionId}
              className="mt-1 text-xs leading-5 text-muted-foreground"
            >
              {changed
                ? t("sshHostKeyChangedWarning")
                : t("sshHostKeyUnknownWarning")}
            </p>
            <div className="mt-3 rounded-md border border-border bg-muted/50 px-3 py-2 font-mono text-xs text-cyan-700 dark:text-cyan-300">
              <div>{preview.algorithm}</div>
              <div className="mt-1 break-all text-muted-foreground">
                {preview.fingerprint}
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                size="sm"
                className={cn(
                  changed
                    ? "bg-red-600 text-white hover:bg-red-500"
                    : "bg-amber-500 text-slate-950 hover:bg-amber-400",
                )}
                onClick={onConfirm}
              >
                <KeyRound className="h-4 w-4" />
                {changed
                  ? t("sshReplaceAndReconnect")
                  : t("sshTrustAndReconnect")}
              </Button>
              <Button size="sm" variant="outline" onClick={onCancel}>
                {t("sshCancel")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

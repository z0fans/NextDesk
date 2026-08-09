import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckSquare2,
  ChevronLeft,
  Code2,
  Download,
  File,
  Folder,
  FolderPlus,
  FolderUp,
  Pencil,
  RefreshCw,
  Square,
  SlidersHorizontal,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/api";
import { useTranslation } from "@/i18n/useTranslation";
import { cn } from "@/lib/utils";
import { SftpDirectoryTree } from "./SftpDirectoryTree";
import { SftpTextEditorDialog } from "./SftpTextEditorDialog";
import {
  SshCommandLibraryPanel,
  type SshCommandTarget,
} from "./SshCommandLibraryPanel";
import type {
  SftpEntry,
  SftpRenameRequest,
  SftpTransferDirection,
  SftpTransferProgress,
  SftpTransferState,
} from "./types";

interface SftpPanelProps {
  sessionId: string;
  visible: boolean;
  commandHistory?: string[];
  commandTargets?: SshCommandTarget[];
  onRunCommand?: (
    command: string,
    targetSessionIds?: string[],
  ) => Promise<void>;
}

interface TransferView {
  id: string;
  name: string;
  direction: SftpTransferDirection;
  state: SftpTransferState;
  transferredBytes: number;
  totalBytes: number;
  message?: string;
}

type EntryDialog =
  | { kind: "create"; value: string }
  | { kind: "rename"; value: string; entry: SftpEntry }
  | { kind: "delete"; entries: SftpEntry[] }
  | { kind: "edit"; value: string; entry: SftpEntry }
  | { kind: "permissions"; value: string; entry: SftpEntry };

type OverwritePrompt =
  | {
      kind: "transfer";
      direction: SftpTransferDirection;
      request: Parameters<typeof api.sshSftpUpload>[0];
      name: string;
    }
  | { kind: "rename"; request: SftpRenameRequest };

const transferStateKey: Record<
  SftpTransferState,
  | "sftpTransferQueued"
  | "sftpTransferRunning"
  | "sftpTransferCompleted"
  | "sftpTransferCancelled"
  | "sftpTransferFailed"
> = {
  queued: "sftpTransferQueued",
  running: "sftpTransferRunning",
  completed: "sftpTransferCompleted",
  cancelled: "sftpTransferCancelled",
  failed: "sftpTransferFailed",
};

function newTransferId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function joinRemotePath(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent.replace(/\/+$/, "")}/${name}`;
}

function localFileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function joinLocalPath(parent: string, name: string): string {
  const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${separator}${name}`;
}

function parentPath(path: string): string {
  if (!path || path === "/") return "/";
  const normalized = path.replace(/\/+$/, "");
  const separator = normalized.lastIndexOf("/");
  return separator <= 0 ? "/" : normalized.slice(0, separator);
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
}

function formatModified(value?: number): string {
  if (!value) return "—";
  return new Date(value * 1000).toLocaleString();
}

function formatPermissions(value?: number): string {
  if (value === undefined) return "—";
  return (value & 0o7777).toString(8).padStart(3, "0");
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validEntryName(value: string): boolean {
  const name = value.trim();
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\0")
  );
}

export function SftpPanel({
  sessionId,
  visible,
  commandHistory = [],
  commandTargets = [],
  onRunCommand,
}: SftpPanelProps) {
  const { t } = useTranslation();
  const [activeView, setActiveView] = useState<"files" | "commands">("files");
  const [path, setPath] = useState("");
  const [homePath, setHomePath] = useState("");
  const [homeEntries, setHomeEntries] = useState<SftpEntry[]>([]);
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [transfers, setTransfers] = useState<TransferView[]>([]);
  const [entryDialog, setEntryDialog] = useState<EntryDialog | null>(null);
  const [overwritePrompt, setOverwritePrompt] =
    useState<OverwritePrompt | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const [operationError, setOperationError] = useState("");
  const selectedEntries = useMemo(
    () => entries.filter((entry) => selectedPaths.has(entry.path)),
    [entries, selectedPaths],
  );
  const selected = selectedEntries.length === 1 ? selectedEntries[0] : null;

  const loadPath = useCallback(
    async (nextPath: string) => {
      setLoading(true);
      setError("");
      try {
        const listing = await api.sshSftpList(sessionId, nextPath);
        setPath(listing.path);
        setEntries(listing.entries);
        if (listing.path === homePath) setHomeEntries(listing.entries);
        setSelectedPaths(new Set());
      } catch {
        setError(t("sftpOpenFailed"));
      } finally {
        setLoading(false);
      }
    },
    [homePath, sessionId, t],
  );

  const updateTransfer = useCallback((event: SftpTransferProgress) => {
    setTransfers((current) =>
      current.map((transfer) =>
        transfer.id === event.transferId
          ? {
              ...transfer,
              state: event.state,
              transferredBytes: event.transferredBytes,
              totalBytes: event.totalBytes,
              message: event.message,
            }
          : transfer,
      ),
    );
  }, []);

  const failTransfer = useCallback((transferId: string, error: unknown) => {
    const message = errorCode(error);
    setTransfers((current) =>
      current.map((transfer) =>
        transfer.id === transferId
          ? { ...transfer, state: "failed", message }
          : transfer,
      ),
    );
  }, []);

  const executeTransfer = useCallback(
    async (
      direction: SftpTransferDirection,
      request: Parameters<typeof api.sshSftpUpload>[0],
      name: string,
    ) => {
      try {
        if (direction === "upload") {
          await api.sshSftpUpload(request, updateTransfer);
          await loadPath(path);
        } else {
          await api.sshSftpDownload(request, updateTransfer);
        }
      } catch (transferError) {
        const code = errorCode(transferError);
        if (
          !request.overwrite &&
          (code === "sftp_remote_exists" || code === "sftp_local_exists")
        ) {
          setOverwritePrompt({ kind: "transfer", direction, request, name });
          return;
        }
        if (code === "sftp_transfer_cancelled") {
          setTransfers((current) =>
            current.map((transfer) =>
              transfer.id === request.transferId
                ? { ...transfer, state: "cancelled", message: code }
                : transfer,
            ),
          );
          return;
        }
        failTransfer(request.transferId, transferError);
      }
    },
    [failTransfer, loadPath, path, updateTransfer],
  );

  const queueUpload = useCallback(
    (localPath: string, recursive: boolean) => {
      if (!path) return;
      const name = localFileName(localPath);
      const transferId = newTransferId();
      setTransfers((current) => [
        ...current,
        {
          id: transferId,
          name,
          direction: "upload",
          state: "queued",
          transferredBytes: 0,
          totalBytes: 0,
        },
      ]);
      void executeTransfer(
        "upload",
        {
          sessionId,
          transferId,
          localPath,
          remotePath: joinRemotePath(path, name),
          overwrite: false,
          recursive,
        },
        name,
      );
    },
    [executeTransfer, path, sessionId],
  );

  const startUpload = useCallback(async () => {
    if (!path) return;
    const localPaths = await api.sshSftpChooseUploadPaths();
    localPaths.forEach((localPath) => queueUpload(localPath, false));
  }, [path, queueUpload]);

  const startUploadDirectory = useCallback(async () => {
    if (!path) return;
    const localPath = await api.sshSftpChooseUploadDirectory();
    if (localPath) queueUpload(localPath, true);
  }, [path, queueUpload]);

  const queueDownload = useCallback(
    (entry: SftpEntry, localPath: string) => {
      const transferId = newTransferId();
      setTransfers((current) => [
        ...current,
        {
          id: transferId,
          name: entry.name,
          direction: "download",
          state: "queued",
          transferredBytes: 0,
          totalBytes: entry.size,
        },
      ]);
      void executeTransfer(
        "download",
        {
          sessionId,
          transferId,
          localPath,
          remotePath: entry.path,
          overwrite: false,
          recursive: entry.kind === "directory",
        },
        entry.name,
      );
    },
    [executeTransfer, sessionId],
  );

  const startDownload = useCallback(async () => {
    if (selectedEntries.length === 0) return;
    if (
      selectedEntries.length === 1 &&
      selectedEntries[0].kind !== "directory"
    ) {
      const entry = selectedEntries[0];
      const localPath = await api.sshSftpChooseDownloadPath(entry.name);
      if (localPath) queueDownload(entry, localPath);
      return;
    }
    const localDirectory = await api.sshSftpChooseDownloadDirectory();
    if (!localDirectory) return;
    selectedEntries.forEach((entry) => {
      queueDownload(entry, joinLocalPath(localDirectory, entry.name));
    });
  }, [queueDownload, selectedEntries]);

  const submitEntryDialog = useCallback(async () => {
    if (!entryDialog || entryDialog.kind === "delete") return;
    const value = entryDialog.value.trim();
    if (
      (entryDialog.kind === "create" || entryDialog.kind === "rename") &&
      !validEntryName(value)
    ) {
      setOperationError(t("sftpInvalidName"));
      return;
    }
    if (entryDialog.kind === "permissions" && !/^[0-7]{3,4}$/.test(value)) {
      setOperationError(t("sftpPermissionsInvalid"));
      return;
    }
    setOperationBusy(true);
    setOperationError("");
    try {
      if (entryDialog.kind === "create") {
        await api.sshSftpCreateDirectory({
          sessionId,
          operationId: newTransferId(),
          path: joinRemotePath(path, value),
        });
      } else if (entryDialog.kind === "rename") {
        const request: SftpRenameRequest = {
          sessionId,
          operationId: newTransferId(),
          fromPath: entryDialog.entry.path,
          toPath: joinRemotePath(path, value),
          overwrite: false,
        };
        try {
          await api.sshSftpRename(request);
        } catch (renameError) {
          if (errorCode(renameError) === "sftp_remote_exists") {
            setEntryDialog(null);
            setOverwritePrompt({ kind: "rename", request });
            return;
          }
          throw renameError;
        }
      } else if (entryDialog.kind === "edit") {
        await api.sshSftpWriteText({
          sessionId,
          operationId: newTransferId(),
          path: entryDialog.entry.path,
          content: entryDialog.value,
        });
      } else {
        await api.sshSftpSetPermissions({
          sessionId,
          operationId: newTransferId(),
          path: entryDialog.entry.path,
          permissions: Number.parseInt(value, 8),
        });
      }
      setEntryDialog(null);
      await loadPath(path);
    } catch {
      setOperationError(t("sftpOperationFailed"));
    } finally {
      setOperationBusy(false);
    }
  }, [entryDialog, loadPath, path, sessionId, t]);

  const openTextEditor = useCallback(
    async (entry: SftpEntry) => {
      if (entry.kind !== "file") return;
      setOperationBusy(true);
      setError("");
      try {
        const response = await api.sshSftpReadText({
          sessionId,
          path: entry.path,
        });
        setOperationError("");
        setEntryDialog({ kind: "edit", value: response.content, entry });
      } catch (readError) {
        setError(
          errorCode(readError) === "sftp_text_file_too_large"
            ? t("sftpTextFileTooLarge")
            : t("sftpTextFileOpenFailed"),
        );
      } finally {
        setOperationBusy(false);
      }
    },
    [sessionId, t],
  );

  const confirmDelete = useCallback(async () => {
    if (!entryDialog || entryDialog.kind !== "delete") return;
    setOperationBusy(true);
    setOperationError("");
    try {
      for (const entry of entryDialog.entries) {
        await api.sshSftpRemove({
          sessionId,
          operationId: newTransferId(),
          path: entry.path,
          recursive: entry.kind === "directory",
        });
      }
      setEntryDialog(null);
      await loadPath(path);
    } catch {
      setOperationError(t("sftpOperationFailed"));
    } finally {
      setOperationBusy(false);
    }
  }, [entryDialog, loadPath, path, sessionId, t]);

  const confirmOverwrite = useCallback(async () => {
    if (!overwritePrompt) return;
    const prompt = overwritePrompt;
    setOverwritePrompt(null);
    if (prompt.kind === "transfer") {
      setTransfers((current) =>
        current.map((transfer) =>
          transfer.id === prompt.request.transferId
            ? { ...transfer, state: "queued", message: undefined }
            : transfer,
        ),
      );
      void executeTransfer(
        prompt.direction,
        { ...prompt.request, overwrite: true },
        prompt.name,
      );
      return;
    }
    setOperationBusy(true);
    try {
      await api.sshSftpRename({ ...prompt.request, overwrite: true });
      await loadPath(path);
    } catch {
      setError(t("sftpOperationFailed"));
    } finally {
      setOperationBusy(false);
    }
  }, [executeTransfer, loadPath, overwritePrompt, path, t]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void api
      .sshSftpOpen(sessionId)
      .then(async ({ path: initialPath }) => {
        if (cancelled) return;
        const listing = await api.sshSftpList(sessionId, initialPath);
        if (cancelled) return;
        setHomePath(initialPath);
        setHomeEntries(listing.entries);
        setPath(listing.path);
        setEntries(listing.entries);
      })
      .catch(() => {
        if (!cancelled) setError(t("sftpOpenFailed"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, t]);

  return (
    <aside
      className={cn(
        "relative flex h-full w-full min-w-0 flex-col bg-card text-card-foreground",
        !visible && "hidden",
      )}
      aria-label={t("sftpFiles")}
    >
      <div
        className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-muted/25 px-3"
        data-region="sftp-dock-toolbar"
      >
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant={activeView === "files" ? "default" : "secondary"}
            className={cn(
              "h-7 rounded-md px-3 text-xs",
              activeView === "files" &&
                "bg-blue-600 text-white hover:bg-blue-500",
            )}
            aria-pressed={activeView === "files"}
            onClick={() => setActiveView("files")}
          >
            {t("sftpFilesTab")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={activeView === "commands" ? "default" : "secondary"}
            className={cn(
              "h-7 rounded-md px-3 text-xs",
              activeView === "commands" &&
                "bg-blue-600 text-white hover:bg-blue-500",
            )}
            aria-pressed={activeView === "commands"}
            onClick={() => setActiveView("commands")}
          >
            {t("sshCommandsTab")}
          </Button>
        </div>

        {activeView === "files" && (
          <>
            <Button
              type="button"
              size="icon-sm"
              variant="secondary"
              className="h-7 w-7 shrink-0"
              disabled={!path || path === "/" || loading}
              onClick={() => void loadPath(parentPath(path))}
              aria-label={t("sftpUp")}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span
              className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
              title={path}
            >
              {path || t("sftpLoading")}
            </span>
            {selectedEntries.length > 1 && (
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {t("sftpSelectedCount", { count: selectedEntries.length })}
              </span>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <Button
                type="button"
                size="icon-sm"
                variant="secondary"
                className="h-7 w-7"
                disabled={!path || loading}
                onClick={() => void loadPath(path)}
                aria-label={t("sftpRefresh")}
              >
                <RefreshCw
                  className={cn("h-4 w-4", loading && "animate-spin")}
                />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="secondary"
                className="h-7 w-7"
                disabled={selectedEntries.length === 0 || loading}
                onClick={() => void startDownload()}
                aria-label={t("sftpDownload")}
              >
                <Download className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="secondary"
                className="h-7 w-7"
                disabled={!path || loading}
                onClick={() => void startUpload()}
                aria-label={t("sftpUpload")}
                title={t("sftpUploadFiles")}
              >
                <Upload className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="secondary"
                className="h-7 w-7"
                disabled={!path || loading}
                onClick={() => void startUploadDirectory()}
                aria-label={t("sftpUploadFolder")}
              >
                <FolderUp className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="secondary"
                className="h-7 w-7"
                disabled={!path || loading}
                onClick={() => {
                  setOperationError("");
                  setEntryDialog({ kind: "create", value: "" });
                }}
                aria-label={t("sftpNewFolder")}
              >
                <FolderPlus className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="secondary"
                className="h-7 w-7"
                disabled={!selected || loading}
                onClick={() => {
                  if (selected) {
                    setOperationError("");
                    setEntryDialog({
                      kind: "rename",
                      value: selected.name,
                      entry: selected,
                    });
                  }
                }}
                aria-label={t("sftpRename")}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="secondary"
                className="h-7 w-7"
                disabled={
                  !selected ||
                  selected.kind !== "file" ||
                  loading ||
                  operationBusy
                }
                onClick={() => {
                  if (selected) void openTextEditor(selected);
                }}
                aria-label={t("sftpEditTextFile")}
              >
                <Code2 className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="secondary"
                className="h-7 w-7"
                disabled={!selected || loading || operationBusy}
                onClick={() => {
                  if (selected) {
                    setOperationError("");
                    setEntryDialog({
                      kind: "permissions",
                      value:
                        formatPermissions(selected.permissions) === "—"
                          ? "644"
                          : formatPermissions(selected.permissions),
                      entry: selected,
                    });
                  }
                }}
                aria-label={t("sftpPermissions")}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="secondary"
                className="h-7 w-7 text-destructive hover:text-destructive"
                disabled={selectedEntries.length === 0 || loading}
                onClick={() => {
                  if (selectedEntries.length > 0) {
                    setOperationError("");
                    setEntryDialog({
                      kind: "delete",
                      entries: selectedEntries,
                    });
                  }
                }}
                aria-label={t("sftpDelete")}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </>
        )}
      </div>

      {activeView === "files" ? (
        <div className="flex min-h-0 flex-1">
          <SftpDirectoryTree
            key={`${sessionId}:${homePath}:${homeEntries.map((entry) => entry.path).join("|")}`}
            sessionId={sessionId}
            rootPath={homePath}
            rootEntries={homeEntries}
            currentPath={path}
            onNavigate={(nextPath) => void loadPath(nextPath)}
          />
          <div className="min-h-0 min-w-0 flex-1 overflow-auto">
            <div className="grid grid-cols-[28px_minmax(0,1fr)_64px_78px_118px] border-b border-border px-2 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <span />
              <span>{t("sftpName")}</span>
              <span className="text-right">{t("sftpPermissions")}</span>
              <span className="text-right">{t("sftpSize")}</span>
              <span className="text-right">{t("sftpModified")}</span>
            </div>
            {loading && (
              <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                {t("sftpLoading")}
              </div>
            )}
            {!loading && error && (
              <div
                role="alert"
                className="px-4 py-8 text-center text-xs text-destructive"
              >
                {error}
              </div>
            )}
            {!loading && !error && entries.length === 0 && (
              <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                {t("sftpEmpty")}
              </div>
            )}
            {!loading &&
              !error &&
              entries.map((entry) => {
                const isSelected = selectedPaths.has(entry.path);
                return (
                  <div
                    key={entry.path}
                    className="flex w-full items-center border-b border-border/50 px-2 text-xs hover:bg-accent/50 data-[selected=true]:bg-accent"
                    data-selected={isSelected ? "true" : undefined}
                  >
                    <button
                      type="button"
                      className="grid h-8 w-7 shrink-0 place-items-center text-muted-foreground hover:text-foreground"
                      aria-label={`${t("sftpSelectEntry")} ${entry.name}`}
                      aria-pressed={isSelected}
                      onClick={() =>
                        setSelectedPaths((current) => {
                          const next = new Set(current);
                          if (next.has(entry.path)) next.delete(entry.path);
                          else next.add(entry.path);
                          return next;
                        })
                      }
                    >
                      {isSelected ? (
                        <CheckSquare2 className="h-3.5 w-3.5 text-blue-600" />
                      ) : (
                        <Square className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_64px_78px_118px] items-center py-2 text-left"
                      onClick={(event) => {
                        if (event.metaKey || event.ctrlKey) {
                          setSelectedPaths((current) => {
                            const next = new Set(current);
                            if (next.has(entry.path)) next.delete(entry.path);
                            else next.add(entry.path);
                            return next;
                          });
                        } else {
                          setSelectedPaths(new Set([entry.path]));
                        }
                      }}
                      onDoubleClick={() => {
                        if (entry.kind === "directory")
                          void loadPath(entry.path);
                        else if (entry.kind === "file")
                          void openTextEditor(entry);
                      }}
                      aria-label={entry.name}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        {entry.kind === "directory" ? (
                          <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                        ) : (
                          <File className="h-4 w-4 shrink-0 text-muted-foreground" />
                        )}
                        <span className="truncate">{entry.name}</span>
                      </span>
                      <span className="text-right font-mono text-muted-foreground">
                        {formatPermissions(entry.permissions)}
                      </span>
                      <span className="text-right text-muted-foreground">
                        {entry.kind === "directory"
                          ? "—"
                          : formatSize(entry.size)}
                      </span>
                      <span className="truncate text-right text-muted-foreground">
                        {formatModified(entry.modified)}
                      </span>
                    </button>
                  </div>
                );
              })}
          </div>
        </div>
      ) : (
        <SshCommandLibraryPanel
          commandHistory={commandHistory}
          currentSessionId={sessionId}
          commandTargets={commandTargets}
          onRunCommand={onRunCommand}
        />
      )}

      {transfers.length > 0 && (
        <div className="max-h-40 shrink-0 overflow-auto border-t border-border bg-muted/20">
          <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("sftpTransfers")}
          </div>
          {transfers.map((transfer) => {
            const percent =
              transfer.state === "completed"
                ? 100
                : transfer.totalBytes > 0
                  ? Math.min(
                      100,
                      Math.round(
                        (transfer.transferredBytes / transfer.totalBytes) * 100,
                      ),
                    )
                  : 0;
            const active =
              transfer.state === "queued" || transfer.state === "running";
            return (
              <div
                key={transfer.id}
                className="border-t border-border/50 px-3 py-2 text-xs"
              >
                <div className="flex items-center gap-2">
                  {transfer.direction === "upload" ? (
                    <Upload className="h-3.5 w-3.5 shrink-0 text-cyan-600" />
                  ) : (
                    <Download className="h-3.5 w-3.5 shrink-0 text-cyan-600" />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {transfer.name}
                  </span>
                  <span className="text-muted-foreground">{percent}%</span>
                  {active && (
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      onClick={() =>
                        void api.sshSftpCancel(sessionId, transfer.id)
                      }
                      aria-label={`${t("sftpCancelTransfer")} ${transfer.name}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded bg-muted">
                  <div
                    className="h-full bg-cyan-500 transition-[width]"
                    style={{ width: `${percent}%` }}
                  />
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                  <span>{t(transferStateKey[transfer.state])}</span>
                  <span>
                    {formatSize(transfer.transferredBytes)} /{" "}
                    {transfer.totalBytes > 0
                      ? formatSize(transfer.totalBytes)
                      : "—"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {entryDialog?.kind === "edit" && (
        <SftpTextEditorDialog
          entry={entryDialog.entry}
          value={entryDialog.value}
          busy={operationBusy}
          error={operationError || undefined}
          onChange={(value) => setEntryDialog({ ...entryDialog, value })}
          onSave={() => void submitEntryDialog()}
          onClose={() => {
            setOperationError("");
            setEntryDialog(null);
          }}
        />
      )}

      {entryDialog && entryDialog.kind !== "edit" && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/70 p-5 backdrop-blur-[2px]">
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-sm rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-xl"
          >
            <h3 className="text-sm font-semibold">
              {entryDialog.kind === "create" && t("sftpCreateFolderTitle")}
              {entryDialog.kind === "rename" && t("sftpRenameTitle")}
              {entryDialog.kind === "delete" && t("sftpDeleteTitle")}
              {entryDialog.kind === "permissions" && t("sftpPermissionsTitle")}
            </h3>
            {entryDialog.kind === "delete" ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {t("sftpDeleteDescription")}
              </p>
            ) : (
              <Input
                className="mt-3"
                autoFocus
                value={entryDialog.value}
                aria-label={t("sftpName")}
                onChange={(event) =>
                  setEntryDialog({ ...entryDialog, value: event.target.value })
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submitEntryDialog();
                }}
              />
            )}
            {operationError && (
              <p role="alert" className="mt-2 text-xs text-destructive">
                {operationError}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={operationBusy}
                onClick={() => setEntryDialog(null)}
              >
                {t("sftpCancel")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={
                  entryDialog.kind === "delete" ? "destructive" : "default"
                }
                disabled={operationBusy}
                onClick={() =>
                  void (entryDialog.kind === "delete"
                    ? confirmDelete()
                    : submitEntryDialog())
                }
                aria-label={t(
                  entryDialog.kind === "create"
                    ? "sftpCreate"
                    : entryDialog.kind === "delete"
                      ? "sftpConfirmDelete"
                      : "sftpSave",
                )}
              >
                {t(
                  entryDialog.kind === "create"
                    ? "sftpCreate"
                    : entryDialog.kind === "delete"
                      ? "sftpConfirmDelete"
                      : "sftpSave",
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {overwritePrompt && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/70 p-5 backdrop-blur-[2px]">
          <div
            role="alertdialog"
            aria-modal="true"
            className="w-full max-w-sm rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-xl"
          >
            <h3 className="text-sm font-semibold">{t("sftpOverwriteTitle")}</h3>
            <p className="mt-2 text-xs text-muted-foreground">
              {t("sftpOverwriteDescription")}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (overwritePrompt.kind === "transfer") {
                    setTransfers((current) =>
                      current.map((transfer) =>
                        transfer.id === overwritePrompt.request.transferId
                          ? { ...transfer, state: "cancelled" }
                          : transfer,
                      ),
                    );
                  }
                  setOverwritePrompt(null);
                }}
              >
                {t("sftpCancel")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onClick={() => void confirmOverwrite()}
                aria-label={t("sftpConfirmOverwrite")}
              >
                {t("sftpConfirmOverwrite")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

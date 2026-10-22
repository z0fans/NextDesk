import { useEffect, useState } from "react";
import {
  ChevronRight,
  Download,
  Folder,
  FolderPlus,
  History,
  Play,
  Plus,
  Save,
  Settings2,
  SlidersHorizontal,
  Trash2,
  Upload,
} from "lucide-react";

import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/i18n/useTranslation";
import { cn } from "@/lib/utils";
import {
  SSH_COMMAND_CONTENT_MAX_LENGTH,
  SSH_COMMAND_GROUP_NAME_MAX_LENGTH,
  SSH_COMMAND_NAME_MAX_LENGTH,
  loadSshCommandLibrary,
  parseSshCommandLibrary,
  saveSshCommandLibrary,
  serializeSshCommandLibrary,
  type SshCommandGroup,
  type SshCommandLibrary,
  type SshSavedCommand,
} from "./ssh-command-library-store";

export interface SshCommandTarget {
  id: string;
  name: string;
}

interface SshCommandLibraryPanelProps {
  commandHistory: string[];
  currentSessionId?: string;
  commandTargets?: SshCommandTarget[];
  onRunCommand?: (
    command: string,
    targetSessionIds?: string[],
  ) => Promise<void>;
}

interface CommandDraft {
  id?: string;
  name: string;
  command: string;
  groupId: string;
}

interface GroupDialogState {
  mode: "create" | "edit";
  groupId?: string;
  value: string;
  createCommandAfterSave?: boolean;
}

interface ParameterDialogState {
  command: string;
  names: string[];
  values: Record<string, string>;
  targetSessionIds?: string[];
}

const ALL_GROUPS = "all";

function createId(prefix: string): string {
  if (typeof crypto.randomUUID === "function")
    return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function commandParameters(command: string): string[] {
  return Array.from(command.matchAll(/\{\{\s*([a-zA-Z][\w.-]{0,63})\s*\}\}/g))
    .map((match) => match[1])
    .filter((name, index, all) => all.indexOf(name) === index);
}

function applyCommandParameters(
  command: string,
  values: Record<string, string>,
): string {
  return command.replace(
    /\{\{\s*([a-zA-Z][\w.-]{0,63})\s*\}\}/g,
    (_match, name: string) => values[name] ?? "",
  );
}

export function SshCommandLibraryPanel({
  commandHistory,
  currentSessionId,
  commandTargets = [],
  onRunCommand,
}: SshCommandLibraryPanelProps) {
  const { t } = useTranslation();
  const [library, setLibrary] = useState(loadSshCommandLibrary);
  const [activeGroupId, setActiveGroupId] = useState(ALL_GROUPS);
  const [draft, setDraft] = useState<CommandDraft | null>(null);
  const [editorOpen, setEditorOpen] = useState(true);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [groupDialog, setGroupDialog] = useState<GroupDialogState | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [validationError, setValidationError] = useState("");
  const [sendFailed, setSendFailed] = useState(false);
  const [sending, setSending] = useState(false);
  const [targetSelection, setTargetSelection] = useState("current");
  const [parameterDialog, setParameterDialog] =
    useState<ParameterDialogState | null>(null);
  const [libraryIoError, setLibraryIoError] = useState(false);

  useEffect(() => {
    const stored = loadSshCommandLibrary();
    setLibrary(stored);
    setActiveGroupId((current) =>
      current === ALL_GROUPS ||
      stored.groups.some((group) => group.id === current)
        ? current
        : ALL_GROUPS,
    );
    setDraft((current) => {
      if (!current?.id) return current;
      const saved = stored.commands.find(
        (command) => command.id === current.id,
      );
      return saved ? { ...saved } : null;
    });
  }, []);

  const filteredCommands =
    activeGroupId === ALL_GROUPS
      ? library.commands
      : library.commands.filter((command) => command.groupId === activeGroupId);

  const persist = (nextLibrary: SshCommandLibrary) => {
    const saved = saveSshCommandLibrary(nextLibrary);
    setLibrary(saved);
    return saved;
  };

  const selectCommand = (command: SshSavedCommand) => {
    setDraft({ ...command });
    setEditorOpen(true);
    setOptionsOpen(false);
    setValidationError("");
    setSendFailed(false);
  };

  const createCommand = () => {
    if (library.groups.length === 0) {
      setGroupDialog({
        mode: "create",
        value: "",
        createCommandAfterSave: true,
      });
      return;
    }
    const groupId =
      activeGroupId !== ALL_GROUPS
        ? activeGroupId
        : (library.groups[0]?.id ?? "");
    setDraft({ name: "", command: "", groupId });
    setEditorOpen(true);
    setOptionsOpen(true);
    setValidationError("");
    setSendFailed(false);
  };

  const saveDraft = (): SshSavedCommand | null => {
    if (!draft) return null;
    const name = draft.name.trim();
    const command = draft.command.trim();
    if (
      !name ||
      !command ||
      !library.groups.some((group) => group.id === draft.groupId)
    ) {
      setValidationError(t("sshCommandEditorRequired"));
      return null;
    }
    const savedCommand: SshSavedCommand = {
      id: draft.id ?? createId("command"),
      name,
      command,
      groupId: draft.groupId,
    };
    const commandExists = library.commands.some(
      (item) => item.id === savedCommand.id,
    );
    persist({
      ...library,
      commands: commandExists
        ? library.commands.map((item) =>
            item.id === savedCommand.id ? savedCommand : item,
          )
        : [...library.commands, savedCommand],
    });
    setDraft({ ...savedCommand });
    setValidationError("");
    return savedCommand;
  };

  const deleteDraft = () => {
    if (!draft?.id) {
      setDraft(null);
      return;
    }
    const remaining = library.commands.filter(
      (command) => command.id !== draft.id,
    );
    persist({ ...library, commands: remaining });
    const next =
      remaining.find(
        (command) =>
          activeGroupId === ALL_GROUPS || command.groupId === activeGroupId,
      ) ?? remaining[0];
    setDraft(next ? { ...next } : null);
    setValidationError("");
  };

  const selectedTargetSessionIds = (): string[] | undefined => {
    if (commandTargets.length === 0) return undefined;
    if (targetSelection === "all")
      return commandTargets.map((target) => target.id);
    if (targetSelection === "current") {
      return currentSessionId ? [currentSessionId] : [commandTargets[0].id];
    }
    return commandTargets.some((target) => target.id === targetSelection)
      ? [targetSelection]
      : currentSessionId
        ? [currentSessionId]
        : undefined;
  };

  const executeCommand = async (
    command: string,
    targetSessionIds?: string[],
  ) => {
    if (!onRunCommand || sending || !command.trim()) return;
    setSending(true);
    setSendFailed(false);
    try {
      if (targetSessionIds)
        await onRunCommand(command.trim(), targetSessionIds);
      else await onRunCommand(command.trim());
    } catch {
      setSendFailed(true);
    } finally {
      setSending(false);
    }
  };

  const runCommand = async (command: string) => {
    const names = commandParameters(command);
    const targetSessionIds = selectedTargetSessionIds();
    if (names.length > 0) {
      setParameterDialog({
        command,
        names,
        values: Object.fromEntries(names.map((name) => [name, ""])),
        targetSessionIds,
      });
      return;
    }
    await executeCommand(command, targetSessionIds);
  };

  const importLibrary = async () => {
    setLibraryIoError(false);
    try {
      const raw = await api.sshCommandLibraryImport(
        t("sshCommandLibraryFileType"),
      );
      if (!raw) return;
      const imported = persist(parseSshCommandLibrary(raw));
      setActiveGroupId(ALL_GROUPS);
      setDraft(imported.commands[0] ? { ...imported.commands[0] } : null);
    } catch {
      setLibraryIoError(true);
    }
  };

  const exportLibrary = async () => {
    setLibraryIoError(false);
    try {
      await api.sshCommandLibraryExport(
        serializeSshCommandLibrary(library),
        t("sshCommandLibraryFileType"),
      );
    } catch {
      setLibraryIoError(true);
    }
  };

  const submitGroupDialog = () => {
    if (!groupDialog) return;
    const name = groupDialog.value.trim();
    if (
      !name ||
      library.groups.some(
        (group) =>
          group.id !== groupDialog.groupId &&
          group.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    )
      return;

    if (groupDialog.mode === "create") {
      const group: SshCommandGroup = { id: createId("group"), name };
      persist({ ...library, groups: [...library.groups, group] });
      setActiveGroupId(group.id);
      if (groupDialog.createCommandAfterSave) {
        setDraft({ name: "", command: "", groupId: group.id });
        setEditorOpen(true);
        setOptionsOpen(true);
      }
    } else if (groupDialog.groupId) {
      persist({
        ...library,
        groups: library.groups.map((group) =>
          group.id === groupDialog.groupId ? { ...group, name } : group,
        ),
      });
    }
    setGroupDialog(null);
  };

  const deleteGroup = () => {
    const groupId = groupDialog?.groupId;
    if (!groupId || library.groups.length <= 1) return;
    const fallbackGroup = library.groups.find((group) => group.id !== groupId);
    if (!fallbackGroup) return;
    const saved = persist({
      groups: library.groups.filter((group) => group.id !== groupId),
      commands: library.commands.map((command) =>
        command.groupId === groupId
          ? { ...command, groupId: fallbackGroup.id }
          : command,
      ),
    });
    if (activeGroupId === groupId) setActiveGroupId(ALL_GROUPS);
    if (draft?.groupId === groupId) {
      const updated = saved.commands.find((command) => command.id === draft.id);
      setDraft(
        updated ? { ...updated } : { ...draft, groupId: fallbackGroup.id },
      );
    }
    setGroupDialog(null);
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-muted/15"
      data-region="ssh-command-library"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
          <Button
            type="button"
            size="sm"
            variant={activeGroupId === ALL_GROUPS ? "default" : "secondary"}
            className={cn(
              "h-7 px-3 text-xs",
              activeGroupId === ALL_GROUPS &&
                "bg-blue-600 text-white hover:bg-blue-500",
            )}
            aria-pressed={activeGroupId === ALL_GROUPS}
            onClick={() => setActiveGroupId(ALL_GROUPS)}
          >
            <Folder className="h-3.5 w-3.5" />
            {t("sshCommandGroupAll")}
          </Button>
          {library.groups.map((group) => (
            <div key={group.id} className="group relative shrink-0">
              <Button
                type="button"
                size="sm"
                variant={activeGroupId === group.id ? "default" : "secondary"}
                className={cn(
                  "h-7 px-3 pr-7 text-xs",
                  activeGroupId === group.id &&
                    "bg-blue-600 text-white hover:bg-blue-500",
                )}
                aria-pressed={activeGroupId === group.id}
                onClick={() => setActiveGroupId(group.id)}
              >
                <Folder className="h-3.5 w-3.5" />
                {group.name}
              </Button>
              <button
                type="button"
                className="absolute right-1 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded opacity-60 hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
                aria-label={`${t("sshCommandEditGroup")} ${group.name}`}
                onClick={() =>
                  setGroupDialog({
                    mode: "edit",
                    groupId: group.id,
                    value: group.name,
                  })
                }
              >
                <Settings2 className="h-3 w-3" />
              </button>
            </div>
          ))}
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="h-7 w-7 shrink-0"
            aria-label={t("sshCommandNewGroup")}
            onClick={() => setGroupDialog({ mode: "create", value: "" })}
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </Button>
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-7 shrink-0 px-3 text-xs"
          onClick={createCommand}
        >
          <Plus className="h-3.5 w-3.5" />
          {t("sshCommandNew")}
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="h-7 w-7 shrink-0"
          onClick={() => void importLibrary()}
          aria-label={t("sshCommandImport")}
        >
          <Download className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="h-7 w-7 shrink-0"
          onClick={() => void exportLibrary()}
          aria-label={t("sshCommandExport")}
        >
          <Upload className="h-3.5 w-3.5" />
        </Button>
      </div>

      {libraryIoError && (
        <p
          role="alert"
          className="shrink-0 border-b border-destructive/20 px-3 py-1.5 text-[11px] text-destructive"
        >
          {t("sshCommandLibraryIoFailed")}
        </p>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto p-3">
          {filteredCommands.length === 0 ? (
            <button
              type="button"
              className="flex h-full min-h-24 w-full flex-col items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground hover:bg-accent/30"
              onClick={createCommand}
            >
              <Plus className="mb-2 h-5 w-5" />
              {t(
                library.groups.length === 0
                  ? "sshCommandEmptyStart"
                  : "sshCommandLibraryEmpty",
              )}
            </button>
          ) : (
            <div className="grid min-h-full content-start grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-2 gap-y-1 rounded-lg border border-border bg-background p-2 shadow-xs">
              {filteredCommands.map((command) => (
                <div
                  key={command.id}
                  className={cn(
                    "group flex min-w-0 items-center rounded-md transition-colors hover:bg-accent/60",
                    draft?.id === command.id &&
                      "bg-blue-600 text-white hover:bg-blue-500",
                  )}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 px-2.5 py-2 text-left"
                    onClick={() => selectCommand(command)}
                    title={command.command}
                  >
                    <span className="block truncate text-xs font-medium">
                      {command.name}
                    </span>
                  </button>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className={cn(
                      "h-7 w-7 shrink-0 text-blue-600 dark:text-blue-400",
                      draft?.id === command.id &&
                        "text-white hover:bg-white/15 hover:text-white",
                    )}
                    aria-label={`${t("sshRunCommand")} ${command.name}`}
                    disabled={!onRunCommand || sending}
                    onClick={() => void runCommand(command.command)}
                  >
                    <Play className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className={cn(
                      "h-7 w-7 shrink-0 text-muted-foreground",
                      draft?.id === command.id &&
                        "text-white/80 hover:bg-white/15 hover:text-white",
                    )}
                    aria-label={`${t("sshCommandEdit")} ${command.name}`}
                    onClick={() => selectCommand(command)}
                  >
                    <Settings2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        {editorOpen && (
          <section
            className="flex w-[36%] min-w-[300px] max-w-[420px] shrink-0 flex-col overflow-hidden border-l border-border bg-card"
            aria-label={t("sshCommandEditor")}
            data-region="ssh-command-editor"
          >
            <div className="flex h-10 shrink-0 items-center border-b border-border px-3">
              <span className="text-xs font-semibold text-muted-foreground">
                {t("sshCommandEditor")}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className={cn(
                  "ml-auto h-7 px-2 text-xs",
                  optionsOpen && "bg-accent text-foreground",
                )}
                disabled={!draft}
                aria-pressed={optionsOpen}
                onClick={() => setOptionsOpen((open) => !open)}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                {t("sshCommandOptions")}
              </Button>
              <button
                type="button"
                className="ml-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setEditorOpen(false)}
                aria-label={t("sshCommandCollapseEditor")}
              >
                {t("sshCommandCollapseEditor")}
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
            {draft ? (
              <div
                className="min-h-0 flex-1 overflow-y-auto p-3"
                data-region="ssh-command-editor-body"
              >
                <div className="flex min-h-full flex-col gap-3">
                  {optionsOpen && (
                    <div className="grid shrink-0 grid-cols-2 gap-2">
                      <label className="min-w-0 space-y-1">
                        <span className="text-[11px] font-medium text-muted-foreground">
                          {t("sshCommandName")}
                        </span>
                        <Input
                          className="h-8 text-xs"
                          value={draft.name}
                          maxLength={SSH_COMMAND_NAME_MAX_LENGTH}
                          aria-label={t("sshCommandName")}
                          onChange={(event) => {
                            setDraft({ ...draft, name: event.target.value });
                            setValidationError("");
                          }}
                        />
                      </label>
                      <label className="min-w-0 space-y-1">
                        <span className="text-[11px] font-medium text-muted-foreground">
                          {t("sshCommandGroup")}
                        </span>
                        <select
                          className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
                          value={draft.groupId}
                          aria-label={t("sshCommandGroup")}
                          onChange={(event) =>
                            setDraft({ ...draft, groupId: event.target.value })
                          }
                        >
                          {library.groups.map((group) => (
                            <option key={group.id} value={group.id}>
                              {group.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                  <label className="flex min-h-20 flex-1 flex-col gap-1">
                    <span className="text-[11px] font-medium text-muted-foreground">
                      {t("sshCommandContent")}
                    </span>
                    <textarea
                      className="min-h-20 flex-1 resize-none rounded-lg border border-input bg-background p-3 font-mono text-xs leading-5 outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
                      value={draft.command}
                      maxLength={SSH_COMMAND_CONTENT_MAX_LENGTH}
                      spellCheck={false}
                      aria-label={t("sshCommandContent")}
                      onChange={(event) => {
                        setDraft({ ...draft, command: event.target.value });
                        setValidationError("");
                        setSendFailed(false);
                      }}
                    />
                  </label>
                  {(validationError || sendFailed) && (
                    <p
                      role="alert"
                      className="shrink-0 text-[11px] text-destructive"
                    >
                      {validationError || t("sshCommandSendFailed")}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="flex min-h-0 flex-1 flex-col items-center justify-center p-6 text-center text-xs text-muted-foreground hover:bg-accent/20"
                onClick={createCommand}
              >
                <Plus className="mb-2 h-5 w-5" />
                {t("sshCommandSelectOrCreate")}
              </button>
            )}
            <div
              className="relative flex h-11 shrink-0 items-center gap-1.5 border-t border-border px-3"
              data-region="ssh-command-editor-footer"
            >
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-7 px-2 text-xs"
                disabled={commandHistory.length === 0}
                aria-expanded={historyOpen}
                onClick={() => setHistoryOpen((open) => !open)}
              >
                <History className="h-3.5 w-3.5" />
                {t("sshCommandHistory")}
              </Button>
              {draft && (
                <>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="destructive"
                    className="h-7 w-7"
                    onClick={deleteDraft}
                    aria-label={t("sshCommandDelete")}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-7 px-2 text-xs"
                    onClick={saveDraft}
                  >
                    <Save className="h-3.5 w-3.5" />
                    {t("sshCommandSave")}
                  </Button>
                </>
              )}
              {commandTargets.length > 0 ? (
                <select
                  className="ml-auto h-7 min-w-0 max-w-40 rounded-md border border-input bg-background px-2 text-[11px] outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
                  value={targetSelection}
                  aria-label={t("sshCommandTarget")}
                  onChange={(event) => setTargetSelection(event.target.value)}
                >
                  <option value="current">
                    {t("sshCommandCurrentSession")}
                  </option>
                  {commandTargets.length > 1 && (
                    <option value="all">{t("sshCommandAllSessions")}</option>
                  )}
                  {commandTargets
                    .filter((target) => target.id !== currentSessionId)
                    .map((target) => (
                      <option key={target.id} value={target.id}>
                        {target.name}
                      </option>
                    ))}
                </select>
              ) : (
                <span className="ml-auto hidden text-[11px] text-muted-foreground 2xl:inline">
                  {t("sshCommandCurrentSession")}
                </span>
              )}
              <Button
                type="button"
                size="sm"
                className="h-7 bg-blue-600 px-2 text-xs text-white hover:bg-blue-500"
                disabled={
                  !draft || !onRunCommand || sending || !draft.command.trim()
                }
                onClick={() => {
                  if (draft) void runCommand(draft.command);
                }}
              >
                <Play className="h-3.5 w-3.5" />
                {t("sshCommandSend")}
              </Button>
              {historyOpen && commandHistory.length > 0 && (
                <div className="absolute bottom-10 left-3 z-20 max-h-44 w-[calc(100%-1.5rem)] overflow-auto rounded-lg border border-border bg-popover p-1 shadow-xl">
                  {commandHistory.map((command, index) => (
                    <button
                      key={`${command}-${index}`}
                      type="button"
                      className="block w-full truncate rounded px-2 py-1.5 text-left font-mono text-xs hover:bg-accent"
                      title={command}
                      onClick={() => {
                        setDraft((current) =>
                          current
                            ? { ...current, command }
                            : {
                                name: "",
                                command,
                                groupId: library.groups[0]?.id ?? "",
                              },
                        );
                        setEditorOpen(true);
                        setOptionsOpen(library.groups.length === 0);
                        setHistoryOpen(false);
                      }}
                    >
                      {command}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

        {!editorOpen && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="m-2 h-7 shrink-0 px-2 text-xs"
            onClick={() => setEditorOpen(true)}
          >
            {t("sshCommandEditor")}
            <ChevronRight className="h-3.5 w-3.5 rotate-180" />
          </Button>
        )}
      </div>

      {groupDialog && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/70 p-5 backdrop-blur-[2px]">
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-sm rounded-lg border border-border bg-popover p-4 shadow-xl"
          >
            <h3 className="text-sm font-semibold">
              {t(
                groupDialog.mode === "create"
                  ? "sshCommandNewGroup"
                  : "sshCommandEditGroup",
              )}
            </h3>
            <Input
              autoFocus
              className="mt-3"
              value={groupDialog.value}
              maxLength={SSH_COMMAND_GROUP_NAME_MAX_LENGTH}
              aria-label={t("sshCommandGroupName")}
              onChange={(event) =>
                setGroupDialog({ ...groupDialog, value: event.target.value })
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") submitGroupDialog();
              }}
            />
            <div className="mt-4 flex items-center gap-2">
              {groupDialog.mode === "edit" && library.groups.length > 1 && (
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  onClick={deleteGroup}
                >
                  {t("sshCommandDeleteGroup")}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => setGroupDialog(null)}
              >
                {t("sshCancel")}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!groupDialog.value.trim()}
                onClick={submitGroupDialog}
              >
                {t("sshCommandSave")}
              </Button>
            </div>
          </div>
        </div>
      )}
      {parameterDialog && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/75 p-4 backdrop-blur-[2px]">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("sshCommandParameters")}
            className="w-full max-w-sm rounded-lg border border-border bg-popover p-4 shadow-xl"
          >
            <h3 className="text-sm font-semibold">
              {t("sshCommandParameters")}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("sshCommandParametersHint")}
            </p>
            <div className="mt-3 max-h-56 space-y-2 overflow-y-auto">
              {parameterDialog.names.map((name) => (
                <label key={name} className="block space-y-1">
                  <span className="text-[11px] font-medium text-muted-foreground">
                    {name}
                  </span>
                  <Input
                    value={parameterDialog.values[name] ?? ""}
                    aria-label={name}
                    onChange={(event) =>
                      setParameterDialog((current) =>
                        current
                          ? {
                              ...current,
                              values: {
                                ...current.values,
                                [name]: event.target.value,
                              },
                            }
                          : null,
                      )
                    }
                  />
                </label>
              ))}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setParameterDialog(null)}
              >
                {t("sshCancel")}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={parameterDialog.names.some(
                  (name) => !parameterDialog.values[name]?.trim(),
                )}
                onClick={() => {
                  const pending = parameterDialog;
                  setParameterDialog(null);
                  void executeCommand(
                    applyCommandParameters(pending.command, pending.values),
                    pending.targetSessionIds,
                  );
                }}
              >
                <Play className="h-3.5 w-3.5" />
                {t("sshCommandSend")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

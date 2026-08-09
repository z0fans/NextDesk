import { useCallback, useState } from "react";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";

import { api } from "@/api";
import { useTranslation } from "@/i18n/useTranslation";
import { cn } from "@/lib/utils";
import type { SftpEntry } from "./types";

interface SftpDirectoryTreeProps {
  sessionId: string;
  rootPath: string;
  rootEntries: SftpEntry[];
  currentPath: string;
  onNavigate: (path: string) => void;
}

interface DirectoryState {
  expanded: boolean;
  loading: boolean;
  children?: SftpEntry[];
}

function directoryLabel(path: string): string {
  if (path === "/") return "/";
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .filter(Boolean)
      .at(-1) ?? path
  );
}

export function SftpDirectoryTree({
  sessionId,
  rootPath,
  rootEntries,
  currentPath,
  onNavigate,
}: SftpDirectoryTreeProps) {
  const { t } = useTranslation();
  const [directories, setDirectories] = useState<
    Record<string, DirectoryState>
  >(
    rootPath
      ? {
          [rootPath]: {
            expanded: true,
            loading: false,
            children: rootEntries.filter((entry) => entry.kind === "directory"),
          },
        }
      : {},
  );

  const fetchChildren = useCallback(
    async (path: string) => {
      try {
        const listing = await api.sshSftpList(sessionId, path);
        const children = listing.entries.filter(
          (entry) => entry.kind === "directory",
        );
        setDirectories((current) => ({
          ...current,
          [path]: { expanded: true, loading: false, children },
        }));
      } catch {
        setDirectories((current) => ({
          ...current,
          [path]: {
            ...current[path],
            expanded: false,
            loading: false,
            children: [],
          },
        }));
      }
    },
    [sessionId],
  );

  const toggle = (path: string) => {
    const current = directories[path];
    if (!current?.children) {
      setDirectories((all) => ({
        ...all,
        [path]: { ...all[path], expanded: true, loading: true },
      }));
      void fetchChildren(path);
      return;
    }
    setDirectories((all) => ({
      ...all,
      [path]: { ...all[path], expanded: !all[path].expanded },
    }));
  };

  const renderNode = (path: string, depth: number) => {
    const state = directories[path] ?? { expanded: false, loading: false };
    return (
      <div key={path}>
        <div
          className={cn(
            "group flex h-7 items-center rounded px-1 text-[11px] hover:bg-accent/60",
            currentPath === path && "bg-blue-600 text-white hover:bg-blue-500",
          )}
          style={{ paddingLeft: `${Math.min(depth, 12) * 12 + 2}px` }}
        >
          <button
            type="button"
            className="grid h-5 w-5 shrink-0 place-items-center rounded hover:bg-black/10 dark:hover:bg-white/10"
            aria-label={`${t("sftpToggleDirectory")} ${directoryLabel(path)}`}
            aria-expanded={state.expanded}
            onClick={() => toggle(path)}
          >
            {state.expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </button>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
            aria-label={`${t("sftpOpenDirectory")} ${path}`}
            onClick={() => onNavigate(path)}
          >
            <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500 group-data-[active=true]:text-white" />
            <span className="truncate" title={path}>
              {directoryLabel(path)}
            </span>
          </button>
        </div>
        {state.expanded &&
          state.children?.map((child) => renderNode(child.path, depth + 1))}
      </div>
    );
  };

  return (
    <nav
      className="h-full w-44 shrink-0 overflow-auto border-r border-border bg-muted/15 p-1.5"
      aria-label={t("sftpDirectoryTree")}
    >
      {rootPath ? renderNode(rootPath, 0) : null}
    </nav>
  );
}

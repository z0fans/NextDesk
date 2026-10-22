import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";

import { useTranslation } from "@/i18n/useTranslation";
import { cn } from "@/lib/utils";
import type { SftpDirectorySnapshot } from "./useSftpDirectory";

interface SftpDirectoryTreeProps {
  rootPath: string;
  directories: Record<string, SftpDirectorySnapshot>;
  currentPath: string;
  onNavigate: (path: string) => void;
  onReadDirectory: (path: string) => Promise<void>;
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
  rootPath,
  directories,
  currentPath,
  onNavigate,
  onReadDirectory,
}: SftpDirectoryTreeProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const readExpanded = (path: string) => {
      if (!(expanded[path] ?? path === rootPath)) return;
      const directory = directories[path];
      if (!directory) {
        void onReadDirectory(path);
      } else if (!directory.loading && !directory.failed) {
        directory.entries?.filter((entry) => entry.kind === "directory")
          .forEach((entry) => readExpanded(entry.path));
      }
    };
    if (rootPath) readExpanded(rootPath);
  }, [directories, expanded, onReadDirectory, rootPath]);

  const toggle = (path: string) => {
    const nextExpanded = !(expanded[path] ?? path === rootPath);
    setExpanded((all) => ({ ...all, [path]: nextExpanded }));
    if (nextExpanded && directories[path]?.failed) {
      void onReadDirectory(path);
    }
  };

  const renderNode = (path: string, depth: number) => {
    const directory = directories[path];
    const isExpanded = expanded[path] ?? path === rootPath;
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
            aria-expanded={isExpanded}
            aria-busy={directory?.loading || undefined}
            onClick={() => toggle(path)}
          >
            {isExpanded ? (
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
        {isExpanded && directory?.loading && (
          <div className="px-4 py-1 text-[10px] text-muted-foreground" role="status">
            {t("sftpLoading")}
          </div>
        )}
        {isExpanded && directory?.failed && (
          <div className="px-4 py-1 text-[10px] text-destructive" role="alert">
            {t("sftpOpenFailed")}
          </div>
        )}
        {isExpanded && directory?.entries
          ?.filter((entry) => entry.kind === "directory")
          .map((child) => renderNode(child.path, depth + 1))}
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

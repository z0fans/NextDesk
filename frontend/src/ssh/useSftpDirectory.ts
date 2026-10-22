import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "@/api";
import type { SftpEntry } from "./types";

export interface SftpDirectorySnapshot {
  entries?: SftpEntry[];
  loading: boolean;
  failed: boolean;
}

interface DirectoryView {
  path: string;
  homePath: string;
  opening: boolean;
  openFailed: boolean;
  directories: Record<string, SftpDirectorySnapshot>;
}

// Mounted once per session by SftpPanel; late responses from that session are ignored.
export function useSftpDirectory(sessionId: string) {
  const scope = useMemo(() => ({
    sessionId,
    active: false,
    generation: 0,
    requests: new Map<string, { pending?: Promise<void> }>(),
  }), [sessionId]);
  const [view, setView] = useState<DirectoryView>({
    path: "",
    homePath: "",
    opening: true,
    openFailed: false,
    directories: {},
  });

  const readDirectory = useCallback((path: string): Promise<void> => {
    if (!scope.active) return Promise.resolve();
    const pending = scope.requests.get(path)?.pending;
    if (pending) return pending;

    const request: { pending?: Promise<void> } = {};
    scope.requests.set(path, request);
    const isCurrent = () => scope.active && scope.requests.get(path) === request;
    setView((current) => isCurrent() ? {
      ...current,
      directories: {
        ...current.directories,
        [path]: { ...current.directories[path], loading: true, failed: false },
      },
    } : current);
    request.pending = (async () => {
      try {
        const listing = await Promise.resolve().then(() => api.sshSftpList(scope.sessionId, path));
        if (!isCurrent()) return;
        const snapshot = { entries: listing.entries, loading: false, failed: false };
        setView((current) => isCurrent() ? {
          ...current,
          path: current.path === path ? listing.path : current.path,
          homePath: current.homePath === path ? listing.path : current.homePath,
          directories: {
            ...current.directories,
            [path]: snapshot,
            [listing.path]: snapshot,
          },
        } : current);
      } catch {
        if (!isCurrent()) return;
        setView((current) => isCurrent() ? {
          ...current,
          directories: {
            ...current.directories,
            [path]: { ...current.directories[path], loading: false, failed: true },
          },
        } : current);
      } finally {
        request.pending = undefined;
      }
    })();
    return request.pending;
  }, [scope]);

  const loadPath = useCallback((path: string) => {
    if (!scope.active) return Promise.resolve();
    setView((current) => ({ ...current, path }));
    return readDirectory(path);
  }, [readDirectory, scope]);

  const refreshPath = useCallback((path: string) => {
    if (!scope.active || !path) return Promise.resolve();
    const prefix = path.endsWith("/") ? path : `${path}/`;
    for (const cachedPath of scope.requests.keys()) {
      if (cachedPath === path || cachedPath.startsWith(prefix)) {
        scope.requests.delete(cachedPath);
      }
    }
    // Expanded descendants are read again by the tree once their parent is fresh.
    setView((current) => ({
      ...current,
      directories: Object.fromEntries(
        Object.entries(current.directories).filter(([cachedPath]) => !cachedPath.startsWith(prefix)),
      ),
    }));
    return readDirectory(path);
  }, [readDirectory, scope]);

  useEffect(() => {
    scope.active = true;
    const generation = ++scope.generation;
    void api.sshSftpOpen(scope.sessionId).then(async ({ path }) => {
      if (!scope.active || generation !== scope.generation) return;
      setView((current) => ({ ...current, path, homePath: path, opening: false }));
      await readDirectory(path);
    }).catch(() => {
      if (!scope.active || generation !== scope.generation) return;
      setView((current) => ({ ...current, opening: false, openFailed: true }));
    });
    return () => {
      scope.active = false;
      scope.generation += 1;
      scope.requests.clear();
    };
  }, [readDirectory, scope]);

  useEffect(() => {
    if (view.path && !view.directories[view.path]) void readDirectory(view.path);
  }, [readDirectory, view.directories, view.path]);

  const directory = view.directories[view.path];
  return {
    ...view,
    entries: directory?.entries ?? [],
    loading: view.opening || (!!view.path && (!directory || directory.loading)),
    failed: view.openFailed || !!directory?.failed,
    loadPath,
    refreshPath,
    readDirectory,
  };
}

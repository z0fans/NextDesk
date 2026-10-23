import { useState, useCallback, useEffect, useSyncExternalStore, type SetStateAction } from 'react';
import type { ServerEntry, ServerGroup, SessionTab, ViewMode, ConnectionState, RdpRoutePolicy } from './rdp-types';

function uid() {
  return crypto.randomUUID();
}

const STORAGE_KEY = 'nextdesk_servers';
const GROUPS_KEY = 'nextdesk_groups';
const FOLDER_SHARING_KEY = 'nextdesk_folder_sharing';
const FOLDER_SHARING_EVENT = 'nextdesk-folder-sharing-change';

const DEFAULT_GROUPS: ServerGroup[] = [
  { id: 'fav', name: 'Favorites', isExpanded: true },
  { id: 'default', name: 'Servers', isExpanded: true },
];

function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveToStorage<T>(key: string, data: T) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (e) {
    console.warn('[store] failed to save:', e);
  }
}

function normalizeRoutePolicy(value: unknown): RdpRoutePolicy {
  return value === 'direct' || value === 'cloud_only' ? value : 'auto';
}

function normalizeServers(value: unknown): ServerEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((server): server is ServerEntry => Boolean(server && typeof server === 'object'))
    .map((server) => {
      const preferences = Object.fromEntries(
        Object.entries(server.networkRoutePreferences ?? {})
          .filter(([scope, policy]) => /^[a-f0-9]{16,64}$/i.test(scope)
            && (policy === 'auto' || policy === 'direct' || policy === 'cloud_only'))
          .slice(0, 32),
      ) as Record<string, RdpRoutePolicy>;
      return {
        ...server,
        routePolicy: normalizeRoutePolicy(server.routePolicy),
        networkRoutePreferences: Object.keys(preferences).length > 0 ? preferences : undefined,
        lastNetworkScopeId: typeof server.lastNetworkScopeId === 'string'
          && /^[a-f0-9]{16,64}$/i.test(server.lastNetworkScopeId)
          ? server.lastNetworkScopeId
          : undefined,
      };
    });
}

const folderSharingListeners = new Set<() => void>();
let folderSharingSnapshot = false;

function getFolderSharingSnapshot(): boolean {
  // Keep live updates usable even when persistence fails; reload after all consumers leave.
  return folderSharingListeners.size > 0
    ? folderSharingSnapshot
    : loadFromStorage<unknown>(FOLDER_SHARING_KEY, false) === true;
}

function notifyFolderSharing(next: boolean) {
  folderSharingSnapshot = next;
  folderSharingListeners.forEach(listener => listener());
}

function handleFolderSharingChange(event: Event) {
  const next = (event as CustomEvent<unknown>).detail;
  if (typeof next === 'boolean') notifyFolderSharing(next);
}

function handleFolderSharingStorageChange(event: StorageEvent) {
  if (event.key === FOLDER_SHARING_KEY || event.key === null) {
    notifyFolderSharing(loadFromStorage<unknown>(FOLDER_SHARING_KEY, false) === true);
  }
}

function subscribeFolderSharing(listener: () => void) {
  if (folderSharingListeners.size === 0) {
    folderSharingSnapshot = getFolderSharingSnapshot();
    window.addEventListener(FOLDER_SHARING_EVENT, handleFolderSharingChange);
    window.addEventListener('storage', handleFolderSharingStorageChange);
  }
  folderSharingListeners.add(listener);

  return () => {
    folderSharingListeners.delete(listener);
    if (folderSharingListeners.size === 0) {
      window.removeEventListener(FOLDER_SHARING_EVENT, handleFolderSharingChange);
      window.removeEventListener('storage', handleFolderSharingStorageChange);
    }
  };
}

function setFolderSharingEnabled(value: SetStateAction<boolean>) {
  const next = typeof value === 'function' ? value(getFolderSharingSnapshot()) : value;
  saveToStorage(FOLDER_SHARING_KEY, next);
  window.dispatchEvent(new CustomEvent<boolean>(FOLDER_SHARING_EVENT, { detail: next }));
}

export function useFolderSharingSetting() {
  const folderSharingEnabled = useSyncExternalStore(subscribeFolderSharing, getFolderSharingSnapshot);
  return { folderSharingEnabled, setFolderSharingEnabled };
}

export function useSessionStore() {
  const [groups, setGroups] = useState<ServerGroup[]>(() => loadFromStorage(GROUPS_KEY, DEFAULT_GROUPS));
  const [servers, setServers] = useState<ServerEntry[]>(() => normalizeServers(loadFromStorage(STORAGE_KEY, [])));
  const [tabs, setTabs] = useState<SessionTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('tab');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const { folderSharingEnabled, setFolderSharingEnabled } = useFolderSharingSetting();

  // Persist servers whenever they change
  useEffect(() => { saveToStorage(STORAGE_KEY, servers); }, [servers]);
  useEffect(() => { saveToStorage(GROUPS_KEY, groups); }, [groups]);

  // ── Server CRUD ──
  const addServer = useCallback((entry: Omit<ServerEntry, 'id'>) => {
    const server: ServerEntry = { ...entry, id: uid() };
    setServers(prev => [...prev, server]);
    return server;
  }, []);

  const updateServer = useCallback((id: string, patch: Partial<ServerEntry>) => {
    setServers(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s));
  }, []);

  const removeServer = useCallback((id: string) => {
    setServers(prev => prev.filter(s => s.id !== id));
  }, []);

  const toggleFavorite = useCallback((id: string) => {
    setServers(prev => prev.map(s =>
      s.id === id ? { ...s, isFavorite: !s.isFavorite } : s
    ));
  }, []);

  // ── Group CRUD ──
  const addGroup = useCallback((name: string) => {
    const group: ServerGroup = { id: uid(), name, isExpanded: true };
    setGroups(prev => [...prev, group]);
    return group;
  }, []);

  const removeGroup = useCallback((id: string) => {
    if (id === 'fav' || id === 'default') return;
    setGroups(prev => prev.filter(g => g.id !== id));
    setServers(prev => prev.map(s =>
      s.groupId === id ? { ...s, groupId: 'default' } : s
    ));
  }, []);

  const toggleGroupExpand = useCallback((id: string) => {
    setGroups(prev => prev.map(g =>
      g.id === id ? { ...g, isExpanded: !g.isExpanded } : g
    ));
  }, []);

  const renameGroup = useCallback((id: string, name: string) => {
    if (id === 'fav' || !name.trim()) return;
    setGroups(prev => prev.map(g =>
      g.id === id ? { ...g, name: name.trim() } : g
    ));
  }, []);

  const moveGroup = useCallback((id: string, direction: 'up' | 'down') => {
    if (id === 'fav' || id === 'default') return;
    setGroups(prev => {
      const idx = prev.findIndex(g => g.id === id);
      if (idx < 0) return prev;
      const minIdx = prev.findIndex(g => g.id !== 'fav' && g.id !== 'default');
      const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (targetIdx < minIdx || targetIdx >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[targetIdx]] = [next[targetIdx], next[idx]];
      return next;
    });
  }, []);

  const reorderGroup = useCallback((groupId: string, toIndex: number) => {
    if (groupId === 'fav' || groupId === 'default') return;
    setGroups(prev => {
      const fromIndex = prev.findIndex(g => g.id === groupId);
      if (fromIndex < 0 || fromIndex === toIndex) return prev;
      const minIdx = prev.findIndex(g => g.id !== 'fav' && g.id !== 'default');
      if (toIndex < minIdx || toIndex > prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, []);

  // ── Session Tabs ──
  const openSession = useCallback((server: ServerEntry): string => {
    const existing = tabs.find(t => t.serverId === server.id && t.status !== 'disconnected');
    if (existing) {
      setActiveTabId(existing.id);
      return existing.id;
    }
    const tab: SessionTab = {
      id: uid(),
      serverId: server.id,
      name: server.name || server.host,
      host: `${server.host}:${server.port}`,
      status: 'idle',
      errorMsg: '',
    };
    setTabs(prev => [...prev, tab]);
    setActiveTabId(tab.id);
    return tab.id;
  }, [tabs]);

  const closeTab = useCallback((tabId: string) => {
    setTabs(prev => {
      const next = prev.filter(t => t.id !== tabId);
      if (activeTabId === tabId) {
        setActiveTabId(next.length > 0 ? next[next.length - 1].id : null);
      }
      return next;
    });
  }, [activeTabId]);

  const updateTabStatus = useCallback((tabId: string, status: ConnectionState, errorMsg = '') => {
    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, status, errorMsg } : t
    ));
  }, []);

  const updateTabRoute = useCallback((tabId: string, routeLabel: SessionTab['routeLabel']) => {
    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, routeLabel } : t
    ));
  }, []);

  const updateTabThumbnail = useCallback((tabId: string, thumbnailUrl: string) => {
    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, thumbnailUrl } : t
    ));
  }, []);

  const reorderTabs = useCallback((fromIndex: number, toIndex: number) => {
    setTabs(prev => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, []);

  const activeTab = tabs.find(t => t.id === activeTabId) ?? null;

  const getServerById = useCallback((id: string) => {
    return servers.find(s => s.id === id) ?? null;
  }, [servers]);

  return {
    groups, servers, tabs, activeTabId, activeTab, viewMode, sidebarOpen, folderSharingEnabled,
    setActiveTabId, setViewMode, setSidebarOpen, setFolderSharingEnabled,
    addServer, updateServer, removeServer, toggleFavorite,
    addGroup, removeGroup, toggleGroupExpand, renameGroup, moveGroup, reorderGroup,
    openSession, closeTab, updateTabStatus, updateTabRoute, updateTabThumbnail, reorderTabs, getServerById,
  };
}

export type SessionStore = ReturnType<typeof useSessionStore>;

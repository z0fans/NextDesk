import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Search, Star, ChevronRight, ChevronDown, Monitor,
  Plus, FolderPlus, PanelLeftClose,
  Pencil, Trash2, MoveRight, X, GripVertical, FolderOpen, Play,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { SessionStore } from '@/lib/useSessionStore';
import { useTranslation } from '@/i18n/useTranslation';

interface Props {
  store: SessionStore;
  selectedServerId: string | null;
  onConnectServer: (serverId: string) => void;
  onSelectServer: (serverId: string) => void;
  onNewServer: () => void;
  onEditServer: (serverId: string) => void;
  onDeleteServer: (serverId: string) => void;
}

const STATUS_DOT: Record<string, string> = {
  connected: 'bg-emerald-500',
  connecting: 'bg-amber-500 animate-pulse',
  error: 'bg-red-500',
  idle: 'bg-slate-600',
  disconnected: 'bg-slate-600',
};

/* ── drag state shared via ref ── */
interface DragState {
  type: 'server' | 'group';
  id: string;
  name: string;
  startY: number;
  active: boolean;
}

export function RdpSidebar({
  store, selectedServerId, onConnectServer, onSelectServer, onNewServer,
  onEditServer, onDeleteServer,
}: Props) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [groupNameError, setGroupNameError] = useState(false);
  const [hoverGroupId, setHoverGroupId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [ghostPos, setGhostPos] = useState({ x: 0, y: 0 });
  const [ghostName, setGhostName] = useState('');
  const [groupCtx, setGroupCtx] = useState<{ id: string; x: number; y: number } | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState('');
  const [groupDragInsertIdx, setGroupDragInsertIdx] = useState<number | null>(null);
  const [activeDrag, setActiveDrag] = useState<Pick<DragState, 'type' | 'id'> | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const groupRefs = useRef<Map<string, HTMLElement>>(new Map());

  const { groups, servers, tabs, sidebarOpen, setSidebarOpen } = store;

  const filteredServers = search
    ? servers.filter(s =>
        s.name.toLowerCase().includes(search.toLowerCase()) ||
        s.host.toLowerCase().includes(search.toLowerCase()))
    : servers;

  const favorites = filteredServers.filter(s => s.isFavorite);

  const getSessionStatus = (serverId: string) => {
    const tab = tabs.find(t => t.serverId === serverId && t.status !== 'disconnected');
    return tab?.status ?? 'idle';
  };

  const handleAddGroup = () => {
    const name = newGroupName.trim();
    if (!name) return;
    const duplicate = groups.some(g => g.name.toLowerCase() === name.toLowerCase());
    if (duplicate) {
      setGroupNameError(true);
      setTimeout(() => setGroupNameError(false), 600);
      return;
    }
    store.addGroup(name);
    setNewGroupName('');
    setShowNewGroup(false);
  };

  const handleCloseNewGroup = () => {
    setShowNewGroup(false);
    setNewGroupName('');
    setGroupNameError(false);
  };

  // ── Custom drag handlers ──
  const startDrag = useCallback((serverId: string, serverName: string, y: number) => {
    dragRef.current = { type: 'server', id: serverId, name: serverName, startY: y, active: false };
  }, []);

  const startGroupDrag = useCallback((groupId: string, groupName: string, y: number) => {
    dragRef.current = { type: 'group', id: groupId, name: groupName, startY: y, active: false };
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.active && Math.abs(e.clientY - d.startY) < 5) return;
      d.active = true;
      setDragging(true);
      setActiveDrag({ type: d.type, id: d.id });
      setGhostName(d.name);
      setGhostPos({ x: e.clientX + 12, y: e.clientY - 8 });

      if (d.type === 'server') {
        let foundGroup: string | null = null;
        groupRefs.current.forEach((el, gid) => {
          const rect = el.getBoundingClientRect();
          if (e.clientY >= rect.top && e.clientY <= rect.bottom &&
              e.clientX >= rect.left && e.clientX <= rect.right) {
            foundGroup = gid;
          }
        });
        setHoverGroupId(foundGroup);
        setGroupDragInsertIdx(null);
      } else {
        // Group drag: find insertion position
        const movable = groups.filter(g => g.id !== 'fav');
        let bestIdx = -1;
        let bestDist = Infinity;
        movable.forEach((g, i) => {
          const el = groupRefs.current.get(g.id);
          if (!el) return;
          const rect = el.getBoundingClientRect();
          const mid = rect.top + rect.height / 2;
          const dist = Math.abs(e.clientY - mid);
          if (dist < bestDist) { bestDist = dist; bestIdx = e.clientY < mid ? i : i + 1; }
        });
        setGroupDragInsertIdx(bestIdx >= 1 ? bestIdx : null);
        setHoverGroupId(null);
      }
    };

    const onMouseUp = () => {
      const d = dragRef.current;
      if (d?.active) {
        if (d.type === 'server' && hoverGroupId) {
          store.updateServer(d.id, { groupId: hoverGroupId });
        } else if (d.type === 'group' && groupDragInsertIdx !== null) {
          const favOffset = groups[0]?.id === 'fav' ? 1 : 0;
          store.reorderGroup(d.id, groupDragInsertIdx + favOffset);
        }
      }
      dragRef.current = null;
      setDragging(false);
      setActiveDrag(null);
      setHoverGroupId(null);
      setGroupDragInsertIdx(null);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [hoverGroupId, groupDragInsertIdx, groups, store]);

  const setGroupRef = useCallback((id: string, el: HTMLElement | null) => {
    if (el) groupRefs.current.set(id, el);
    else groupRefs.current.delete(id);
  }, []);

  if (!sidebarOpen) {
    return null;
  }

  return (
    <div className="w-52 flex flex-col bg-card/50 border-r border-sidebar-border shrink-0 overflow-hidden select-none">
      <div
        data-region="rdp-sidebar-header"
        className="flex h-[73px] shrink-0 items-center justify-between border-b border-sidebar-border px-3"
      >
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('rdpServers')}</span>
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={() => setSidebarOpen(false)}>
          <PanelLeftClose className="h-4 w-4" />
        </Button>
      </div>
      <div className="px-3 py-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
          <Input placeholder={t('rdpSearchServers')} value={search} onChange={e => setSearch(e.target.value)} className="h-8 pl-8 text-xs bg-background/50" />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-1">
        {favorites.length > 0 && (
          <div className="mb-1">
            <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-amber-500/80 font-medium">
              <Star className="h-3 w-3 fill-amber-500/60" /> {t('rdpFavorites')}
            </div>
            {favorites.map(s => (
              <ServerItem key={s.id} server={s} status={getSessionStatus(s.id)} store={store}
                isSelected={selectedServerId === s.id}
                onConnect={onConnectServer} onSelect={onSelectServer} onEdit={onEditServer} onDelete={onDeleteServer}
                groups={groups} onMoveToGroup={(sid, gid) => store.updateServer(sid, { groupId: gid })}
                onDragStart={startDrag} isDragging={dragging}
              />
            ))}
          </div>
        )}

        {/* No top insertion indicator — Servers group is always fixed at position 0 */}

        {groups.filter(g => {
          if (g.id === 'fav') return false;
          if (g.id === 'default') return true;
          // Hide custom groups when default is collapsed
          const def = groups.find(d => d.id === 'default');
          return def?.isExpanded ?? true;
        }).map((group, gi) => {
          const groupServers = filteredServers.filter(s => s.groupId === group.id);
          const isOver = hoverGroupId === group.id && dragging;
          const isDraggedGroup = dragging && activeDrag?.type === 'group' && activeDrag.id === group.id;
          return (
            <div key={group.id}>
            <div
              ref={el => setGroupRef(group.id, el)}
              className={cn(
                "mb-1 rounded-md transition-all duration-150",
                isOver && "bg-cyan-500/15 ring-1 ring-cyan-500/40 scale-[1.02]",
                isDraggedGroup && "opacity-40"
              )}
            >
              {editingGroupId === group.id ? (
                <div className="flex items-center gap-1 px-2 py-1">
                  <Input
                    value={editingGroupName}
                    onChange={e => setEditingGroupName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        store.renameGroup(group.id, editingGroupName);
                        setEditingGroupId(null);
                      } else if (e.key === 'Escape') {
                        setEditingGroupId(null);
                      }
                    }}
                    onBlur={() => {
                      store.renameGroup(group.id, editingGroupName);
                      setEditingGroupId(null);
                    }}
                    className="h-6 text-xs flex-1"
                    autoFocus
                  />
                </div>
              ) : (
                <div className={cn(
                  "flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium rounded-md transition-colors group/grp",
                  isOver ? "text-cyan-400" : "text-muted-foreground hover:text-foreground"
                )}>
                  {group.id !== 'fav' && group.id !== 'default' && (
                    <span
                      className="cursor-grab active:cursor-grabbing opacity-0 group-hover/grp:opacity-60 hover:!opacity-100 transition-opacity px-0.5"
                      onMouseDown={e => {
                        e.stopPropagation();
                        if (e.button === 0) startGroupDrag(group.id, group.name, e.clientY);
                      }}
                    >
                      <GripVertical className="h-3 w-3" />
                    </span>
                  )}
                  <button
                    className="flex items-center gap-1.5 flex-1 text-left cursor-pointer"
                    onClick={() => {
                      if (group.id === 'default' && group.isExpanded) {
                        // Collapsing default → collapse all groups
                        groups.filter(g => g.id !== 'fav' && g.isExpanded).forEach(g => store.toggleGroupExpand(g.id));
                      } else {
                        store.toggleGroupExpand(group.id);
                      }
                    }}
                    onContextMenu={e => {
                      e.preventDefault();
                      if (group.id !== 'fav' && group.id !== 'default') {
                        setGroupCtx({ id: group.id, x: e.clientX, y: e.clientY });
                      }
                    }}
                  >
                    {group.isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    {group.id === 'default' ? t('rdpServers') : group.name}
                    <span className="text-[10px] text-muted-foreground/60 ml-auto">{groupServers.length}</span>
                  </button>
                </div>
              )}
              {isOver && groupServers.length === 0 && (
                <div className="mx-2 mb-1 py-1.5 border border-dashed border-cyan-500/40 rounded text-center text-[10px] text-cyan-500/60">
                  {t('rdpDropHere')}
                </div>
              )}
              {group.isExpanded && groupServers.map(s => (
                <ServerItem key={s.id} server={s} status={getSessionStatus(s.id)} store={store}
                  isSelected={selectedServerId === s.id}
                  onConnect={onConnectServer} onSelect={onSelectServer} onEdit={onEditServer} onDelete={onDeleteServer}
                  groups={groups} onMoveToGroup={(sid, gid) => store.updateServer(sid, { groupId: gid })}
                  onDragStart={startDrag} isDragging={dragging}
                />
              ))}
            </div>
            {/* Group drag insertion indicator */}
            {groupDragInsertIdx === gi + 1 && dragging && activeDrag?.type === 'group' && (
              <div className="mx-2 my-0.5 h-0.5 rounded-full bg-cyan-500 shadow-[0_0_6px_rgba(6,182,212,0.5)] transition-all" />
            )}
            </div>
          );
        })}

        {/* Group context menu */}
        {groupCtx && (
          <>
            <div className="fixed inset-0 z-50" onClick={() => setGroupCtx(null)}
              onContextMenu={e => { e.preventDefault(); setGroupCtx(null); }} />
            <div className="fixed z-50 bg-card/95 backdrop-blur-md border border-border/60 rounded-lg shadow-xl py-1 min-w-[140px] animate-in fade-in zoom-in-95 duration-100"
              style={{ left: groupCtx.x, top: groupCtx.y }}>
              <button className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors cursor-pointer"
                onClick={() => {
                  const g = groups.find(g => g.id === groupCtx.id);
                  setEditingGroupId(groupCtx.id);
                  setEditingGroupName(g?.name ?? '');
                  setGroupCtx(null);
                }}>
                <Pencil className="h-3 w-3" /> {t('rdpRename')}
              </button>
              <div className="h-px bg-border/50 my-0.5" />
              <button className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
                onClick={() => { store.removeGroup(groupCtx.id); setGroupCtx(null); }}>
                <Trash2 className="h-3 w-3" /> {t('rdpDelete')}
              </button>
            </div>
          </>
        )}
      </div>

      <div
        data-region="rdp-sidebar-actions"
        className={cn(
          "mt-auto shrink-0 border-t border-sidebar-border px-3",
          showNewGroup ? "py-1.5" : "flex h-11 items-center",
        )}
      >
        {showNewGroup ? (
          <div className="space-y-1">
            <div className={cn("flex gap-1", groupNameError && "animate-shake")}>
              <Input
                placeholder={t('rdpGroupName')} value={newGroupName}
                onChange={e => { setNewGroupName(e.target.value); setGroupNameError(false); }}
                onKeyDown={e => { if (e.key === 'Enter') handleAddGroup(); else if (e.key === 'Escape') handleCloseNewGroup(); }}
                className={cn("h-7 text-xs transition-colors", groupNameError && "border-red-500 focus-visible:ring-red-500/30")}
                autoFocus
              />
              <Button size="sm" className="h-7 px-2 text-xs" onClick={handleAddGroup}>OK</Button>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground" onClick={handleCloseNewGroup}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
            {groupNameError && (
              <p className="text-[10px] text-red-400 px-1">{t('rdpDuplicateName')}</p>
            )}
          </div>
        ) : (
          <div className="flex w-full gap-2">
            <Button variant="outline" size="sm" className="min-w-0 flex-1" onClick={onNewServer}>
              <Plus className="h-4 w-4" /> {t('rdpServer')}
            </Button>
            <Button variant="outline" size="sm" className="min-w-0 flex-1" onClick={() => setShowNewGroup(true)}>
              <FolderPlus className="h-4 w-4" /> {t('rdpGroup')}
            </Button>
          </div>
        )}
      </div>

      {/* Drag ghost */}
      {dragging && (
        <div
          className="fixed z-[100] pointer-events-none bg-card/90 backdrop-blur border border-cyan-500/40 rounded-md px-2.5 py-1 text-xs text-cyan-300 shadow-lg shadow-cyan-500/10 flex items-center gap-1.5"
          style={{ left: ghostPos.x, top: ghostPos.y }}
        >
          {activeDrag?.type === 'group' ? <FolderOpen className="h-3 w-3" /> : <Monitor className="h-3 w-3" />} {ghostName}
        </div>
      )}
    </div>
  );
}

/* ── Server item ── */
function ServerItem({
  server, status, store, isSelected, onConnect, onSelect, onEdit, onDelete,
  groups, onMoveToGroup, onDragStart, isDragging,
}: {
  server: { id: string; name: string; host: string; isFavorite: boolean; groupId?: string; colorTag?: string };
  status: string;
  store: SessionStore;
  isSelected: boolean;
  onConnect: (id: string) => void;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  groups: { id: string; name: string }[];
  onMoveToGroup: (serverId: string, groupId: string) => void;
  onDragStart: (serverId: string, name: string, y: number) => void;
  isDragging: boolean;
}) {
  const { t } = useTranslation();
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  const [showMoveMenu, setShowMoveMenu] = useState(false);
  const otherGroups = groups.filter(g => g.id !== 'fav' && g.id !== server.groupId);
  const clickThrottleRef = useRef(false);

  const handleClick = useCallback(() => {
    if (isDragging || clickThrottleRef.current) return;
    clickThrottleRef.current = true;
    setTimeout(() => { clickThrottleRef.current = false; }, 500);
    onSelect(server.id);
  }, [isDragging, onSelect, server.id]);

  const handleDoubleClick = useCallback(() => {
    if (isDragging) return;
    onConnect(server.id);
  }, [isDragging, onConnect, server.id]);

  return (
    <>
      <button
        className={cn(
          "flex items-center gap-2 px-3 py-1.5 rounded-md text-xs w-full text-left",
          "hover:bg-accent/50 transition-colors group",
          isDragging ? "cursor-grabbing" : "cursor-grab",
          status === 'connected' && "bg-emerald-500/5",
          isSelected && "bg-cyan-500/10 border-l-2 border-cyan-500 text-cyan-300"
        )}
        onMouseDown={e => {
          if (e.button === 0) onDragStart(server.id, server.name || server.host, e.clientY);
        }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onConnect(server.id); } }}
        onContextMenu={e => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY }); }}
      >
        {server.colorTag ? (
          <span className="h-3 w-3 rounded-full shrink-0 ring-1 ring-white/10" style={{ backgroundColor: server.colorTag }} />
        ) : (
          <Monitor className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
        <span className="truncate flex-1">{server.name || server.host}</span>
        <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", STATUS_DOT[status] ?? STATUS_DOT.idle)} />
        <span
          role="button"
          tabIndex={0}
          className="opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
          onClick={e => { e.stopPropagation(); store.toggleFavorite(server.id); }}
          onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); store.toggleFavorite(server.id); } }}
        >
          <Star className={cn("h-3 w-3", server.isFavorite ? "fill-amber-500 text-amber-500" : "text-muted-foreground")} />
        </span>
      </button>

      {ctx && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => { setCtx(null); setShowMoveMenu(false); }}
            onContextMenu={e => { e.preventDefault(); setCtx(null); setShowMoveMenu(false); }} />
          <div className="fixed z-50 bg-card/95 backdrop-blur-md border border-border/60 rounded-lg shadow-xl py-1 min-w-[160px] animate-in fade-in zoom-in-95 duration-100"
            style={{ left: ctx.x, top: ctx.y }}>
            <button className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors cursor-pointer"
              onClick={() => { setCtx(null); onConnect(server.id); }}>
              <Play className="h-3 w-3" /> {t('rdpConnect')}
            </button>
            <button className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors cursor-pointer"
              onClick={() => { setCtx(null); onEdit(server.id); }}>
              <Pencil className="h-3 w-3" /> {t('rdpEdit')}
            </button>
            {otherGroups.length > 0 && (
              <div className="relative">
                <button className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors cursor-pointer"
                  onClick={() => setShowMoveMenu(!showMoveMenu)}>
                  <MoveRight className="h-3 w-3" /> {t('rdpMoveTo')}
                  <ChevronRight className="h-3 w-3 ml-auto" />
                </button>
                {showMoveMenu && (
                  <div className="absolute left-full top-0 ml-1 bg-card/95 backdrop-blur-md border border-border/60 rounded-lg shadow-xl py-1 min-w-[120px]">
                    {otherGroups.map(g => (
                      <button key={g.id} className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors cursor-pointer"
                        onClick={() => { setCtx(null); setShowMoveMenu(false); onMoveToGroup(server.id, g.id); }}>
                        <FolderPlus className="h-3 w-3 text-muted-foreground" /> {g.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="h-px bg-border/50 my-0.5" />
            <button className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
              onClick={() => { setCtx(null); onDelete(server.id); }}>
              <Trash2 className="h-3 w-3" /> {t('rdpDelete')}
            </button>
          </div>
        </>
      )}
    </>
  );
}

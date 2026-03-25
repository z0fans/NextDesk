import { useRef, useCallback, useEffect, useState } from 'react';
import { X, LayoutGrid, LayoutList, RefreshCw, MoreHorizontal, ChevronDown, FolderOpen, Monitor, ClipboardCopy, PanelLeftOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { SessionTab, ViewMode } from '@/lib/rdp-types';
import { useTranslation } from '@/i18n/useTranslation';

export interface SessionControls {
  resMode: string;
  resolution: string;
  fps: number;
  presets: readonly { label: string; value: string }[];
  macClipboardStrategy: 'session-file-url' | 'pasteboard-promise';
  hasClipboardFolder: boolean;
  onApplyResolution: (mode: string) => void;
  onToggleClipboardStrategy: () => void;
  onOpenClipboardFolder: () => void;
  onDisconnect: () => void;
}

interface Props {
  tabs: SessionTab[];
  activeTabId: string | null;
  viewMode: ViewMode;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onViewModeChange: (mode: ViewMode) => void;
  onReorderTabs?: (from: number, to: number) => void;
  onReconnectTab?: (tabId: string) => void;
  sessionControls?: SessionControls | null;
}

const STATUS_COLOR: Record<string, string> = {
  connected: 'bg-emerald-500',
  connecting: 'bg-amber-500 animate-pulse',
  error: 'bg-red-500',
  idle: 'bg-slate-500',
  disconnected: 'bg-slate-600',
};

const DRAG_THRESHOLD = 4; // px before activating drag

export function RdpTabBar({ tabs, activeTabId, viewMode, sidebarOpen, onToggleSidebar, onSelectTab, onCloseTab, onViewModeChange, onReorderTabs, onReconnectTab, sessionControls }: Props) {
  const { t } = useTranslation();
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOffsetX, setDragOffsetX] = useState(0);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const [showControlsMenu, setShowControlsMenu] = useState(false);
  const [showResSubmenu, setShowResSubmenu] = useState(false);
  const dragState = useRef<{ idx: number; startX: number; active: boolean } | null>(null);
  const tabRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const controlsBtnRef = useRef<HTMLButtonElement>(null);

  // Hit-test: find which tab index the cursor is over (skip the dragged tab itself)
  const hitTest = useCallback((clientX: number, excludeIdx?: number) => {
    let found: number | null = null;
    tabRefs.current.forEach((el, i) => {
      if (i === excludeIdx) return;
      const r = el.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right) found = i;
    });
    return found;
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragState.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      if (!d.active && Math.abs(dx) < DRAG_THRESHOLD) return;
      d.active = true;
      setDragOffsetX(dx);
      setHoverIdx(hitTest(e.clientX, d.idx));
    };
    const onUp = (e: MouseEvent) => {
      const d = dragState.current;
      if (!d) return;
      if (d.active) {
        const target = hitTest(e.clientX, d.idx);
        if (target !== null && target !== d.idx && onReorderTabs) {
          onReorderTabs(d.idx, target);
        }
      }
      dragState.current = null;
      setDragIdx(null);
      setDragOffsetX(0);
      setHoverIdx(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [hitTest, onReorderTabs]);

  // Removed early return — sidebar toggle must always be accessible

  const startDrag = (idx: number, e: React.MouseEvent) => {
    // Ignore right-click
    if (e.button !== 0) return;
    dragState.current = { idx, startX: e.clientX, active: false };
    setDragIdx(idx);
    setDragOffsetX(0);
  };

  return (
    <div className="flex items-center gap-1 px-2 py-1 bg-card/80 border-b border-border shrink-0">
      {!sidebarOpen && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 shrink-0"
          onClick={onToggleSidebar}
        >
          <PanelLeftOpen className="h-3.5 w-3.5" />
        </Button>
      )}
      <div className="flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto overflow-y-clip">
        {tabs.map((tab, idx) => (
          <div
            key={tab.id}
            ref={(el) => { if (el) tabRefs.current.set(idx, el); else tabRefs.current.delete(idx); }}
            onMouseDown={(e) => startDrag(idx, e)}
            onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ tabId: tab.id, x: e.clientX, y: e.clientY }); }}
            style={dragIdx === idx && dragState.current?.active
              ? { transform: `translateX(${dragOffsetX}px)`, zIndex: 50, position: 'relative' as const }
              : undefined}
            className={cn(
              "flex items-center shrink-0 max-w-[180px] rounded-md group transition-none select-none",
              tab.id === activeTabId
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              dragIdx === idx && dragState.current?.active && "opacity-80 shadow-lg",
              hoverIdx === idx && dragIdx !== idx && "ring-2 ring-primary ring-offset-1 ring-offset-background",
            )}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-1.5 text-xs font-medium cursor-grab active:cursor-grabbing transition-colors"
              onClick={() => {
                if (dragState.current?.active) return; // suppress click after drag
                onSelectTab(tab.id);
                onViewModeChange('tab');
              }}
            >
              <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", STATUS_COLOR[tab.status])} />
              <span className="truncate">{tab.name}</span>
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.name}`}
              className="opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity ml-1 mr-2 shrink-0 cursor-pointer"
              onClick={() => onCloseTab(tab.id)}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>

      {/* Right-click context menu */}
      {ctxMenu && (
        <>
          <div className="fixed inset-0 z-[99]" onClick={() => setCtxMenu(null)} />
          <div
            className="fixed z-[100] min-w-[140px] rounded-md border border-border bg-popover p-1 shadow-md animate-in fade-in-0 zoom-in-95"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
          >
            {onReconnectTab && (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground cursor-pointer"
                onClick={() => { onReconnectTab(ctxMenu.tabId); setCtxMenu(null); }}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {t('rdpReconnect')}
              </button>
            )}
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground text-destructive cursor-pointer"
              onClick={() => { onCloseTab(ctxMenu.tabId); setCtxMenu(null); }}
            >
              <X className="h-3.5 w-3.5" />
              {t('rdpCloseTab')}
            </button>
          </div>
        </>
      )}

      {/* Session controls ⋯ button */}
      {sessionControls && (
        <div className="relative shrink-0 ml-1">
          <Button
            ref={controlsBtnRef}
            variant="ghost"
            size="sm"
            className={cn("h-7 w-7 p-0", showControlsMenu && "bg-accent")}
            onClick={() => { setShowControlsMenu(v => !v); setShowResSubmenu(false); }}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>

          {showControlsMenu && (
            <>
              <div className="fixed inset-0 z-[99]" onClick={() => { setShowControlsMenu(false); setShowResSubmenu(false); }} />
              <div className="absolute right-0 top-full mt-1 z-[100] min-w-[180px] rounded-md border border-border bg-popover/95 backdrop-blur-md p-1 shadow-xl animate-in fade-in-0 zoom-in-95">
                {/* FPS & Resolution display */}
                <div className="flex items-center justify-between px-2 py-1.5 text-[11px] font-mono">
                  <span className="text-cyan-400/80">
                    {sessionControls.resMode === 'adaptive' ? t('rdpAuto') : (sessionControls.resolution || '—')}
                  </span>
                  <span className="text-emerald-400/80">{sessionControls.fps} fps</span>
                </div>

                <div className="h-px bg-border/60 my-0.5" />

                {/* Resolution selector */}
                <div className="relative">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground cursor-pointer"
                    onClick={() => setShowResSubmenu(v => !v)}
                  >
                    <div className="flex items-center gap-2">
                      <Monitor className="h-3.5 w-3.5" />
                      {t('rdpResolution')}
                    </div>
                    <ChevronDown className={cn("h-3 w-3 transition-transform", showResSubmenu && "rotate-180")} />
                  </button>
                  {showResSubmenu && (
                    <div className="pl-4 py-0.5">
                      {sessionControls.presets.map(p => (
                        <button
                          key={p.value}
                          className={cn(
                            "w-full text-left px-2 py-1 text-[11px] font-mono rounded-sm hover:bg-white/5 transition-colors cursor-pointer",
                            sessionControls.resMode === p.value ? "text-cyan-400" : "text-muted-foreground"
                          )}
                          onClick={() => {
                            sessionControls.onApplyResolution(p.value);
                            setShowControlsMenu(false);
                            setShowResSubmenu(false);
                          }}
                        >
                          {p.label}
                          {sessionControls.resMode === p.value && <span className="ml-1 text-[9px]">✓</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="h-px bg-border/60 my-0.5" />

                {/* Clipboard strategy */}
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground cursor-pointer whitespace-nowrap"
                  onClick={() => { sessionControls.onToggleClipboardStrategy(); }}
                >
                  <ClipboardCopy className="h-3.5 w-3.5 shrink-0" />
                  {t('rdpClipboard')} {sessionControls.macClipboardStrategy === 'session-file-url' ? 'Std' : 'Exp'}
                </button>

                {/* Open clipboard folder */}
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground cursor-pointer",
                    !sessionControls.hasClipboardFolder && "opacity-50 pointer-events-none"
                  )}
                  onClick={() => { sessionControls.onOpenClipboardFolder(); setShowControlsMenu(false); }}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  {t('rdpFiles')}
                </button>

                <div className="h-px bg-border/60 my-0.5" />

                {/* Disconnect */}
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 cursor-pointer"
                  onClick={() => { sessionControls.onDisconnect(); setShowControlsMenu(false); }}
                >
                  <X className="h-3.5 w-3.5" />
                  {t('rdpDisconnect')}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* View toggle */}
      <div className="flex items-center gap-0.5 ml-1 shrink-0">
        <Button
          variant="ghost" size="sm"
          className={cn("h-7 w-7 p-0", viewMode === 'tab' && "bg-accent")}
          onClick={() => onViewModeChange('tab')}
        >
          <LayoutList className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost" size="sm"
          className={cn("h-7 w-7 p-0", viewMode === 'grid' && "bg-accent")}
          onClick={() => onViewModeChange('grid')}
        >
          <LayoutGrid className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

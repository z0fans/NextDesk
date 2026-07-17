import { useRef, useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { X, LayoutGrid, LayoutList, RefreshCw, MoreHorizontal, ChevronDown, FolderOpen, Monitor, ClipboardCopy, PanelLeftOpen, Keyboard, ShieldAlert, Maximize2, Minimize2, Network, Cable, CloudLightning, CloudOff, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { SessionTab, ViewMode } from '@/lib/rdp-types';
import { useTranslation } from '@/i18n/useTranslation';

export interface SessionControls {
  resMode: string;
  resolution: string;
  fps: number | null;
  presets: readonly { label: string; value: string }[];
  macClipboardStrategy: 'session-file-url' | 'pasteboard-promise';
  hasClipboardFolder: boolean;
  showClipboardManagement?: boolean;
  showDriveRedirection?: boolean;
  driveRedirectionEnabled: boolean;
  showMultiMonitor?: boolean;
  multiMonitorEnabled?: boolean;
  showWinKey?: boolean;
  ctrlAltDelMode?: 'send' | 'hint' | 'hidden';
  fullscreen: boolean;
  onApplyResolution: (mode: string) => void;
  onToggleFullscreen: () => void;
  onToggleDriveRedirection: (enabled: boolean) => void;
  onToggleMultiMonitor?: (enabled: boolean) => void;
  onToggleClipboardStrategy: () => void;
  onOpenClipboardFolder: () => void;
  onSendClipboardText?: () => void;
  onSendWinKey: () => void;
  onSendCtrlAltDel: () => void;
  onDisconnect: () => void;
}

export interface SessionControlsMenuRect {
  x: number;
  y: number;
  width: number;
  height: number;
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
  activeXSafeMenus?: boolean;
  onSessionControlsMenuOpenChange?: (open: boolean, rect?: SessionControlsMenuRect) => void;
  onOverlayClipRectChange?: (id: string, open: boolean, rect?: SessionControlsMenuRect) => void;
}

const STATUS_COLOR: Record<string, string> = {
  connected: 'bg-emerald-500',
  connecting: 'bg-amber-500 animate-pulse',
  reconnecting: 'bg-cyan-500 animate-pulse',
  error: 'bg-red-500',
  idle: 'bg-slate-500',
  disconnected: 'bg-slate-600',
};

const ROUTE_TRANSLATION_KEYS = {
  cloud: 'routeCloudAccelerated',
  lan_direct: 'routeLanDirect',
  local_direct: 'routeLocalDirect',
  cloud_fallback: 'routeCloudFallback',
} as const;

const ROUTE_DISPLAY: Record<keyof typeof ROUTE_TRANSLATION_KEYS, {
  icon: LucideIcon;
  shortLabelKey: 'routeShortAccelerated' | 'routeShortLan' | 'routeShortDirect';
  iconClassName: string;
  labelClassName: string;
}> = {
  cloud: {
    icon: CloudLightning,
    shortLabelKey: 'routeShortAccelerated',
    iconClassName: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300',
    labelClassName: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300',
  },
  lan_direct: {
    icon: Network,
    shortLabelKey: 'routeShortLan',
    iconClassName: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
    labelClassName: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  },
  local_direct: {
    icon: Cable,
    shortLabelKey: 'routeShortDirect',
    iconClassName: 'bg-green-50 text-green-600 dark:bg-green-500/15 dark:text-green-300',
    labelClassName: 'bg-green-50 text-green-700 dark:bg-green-500/15 dark:text-green-300',
  },
  cloud_fallback: {
    icon: CloudOff,
    shortLabelKey: 'routeShortDirect',
    iconClassName: 'bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',
    labelClassName: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  },
};

const DRAG_THRESHOLD = 4; // px before activating drag

function rectFromElement(element: HTMLElement | null): SessionControlsMenuRect | undefined {
  const rect = element?.getBoundingClientRect();
  return rect
    ? {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      }
    : undefined;
}

function clampContextMenuLeft(left: number, width: number): number {
  const viewportWidth = typeof window === 'undefined' ? left + width : window.innerWidth;
  return Math.max(8, Math.min(left, viewportWidth - width - 8));
}

export function RdpTabBar({ tabs, activeTabId, viewMode, sidebarOpen, onToggleSidebar, onSelectTab, onCloseTab, onViewModeChange, onReorderTabs, onReconnectTab, sessionControls, activeXSafeMenus = false, onSessionControlsMenuOpenChange, onOverlayClipRectChange }: Props) {
  const { t } = useTranslation();
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOffsetX, setDragOffsetX] = useState(0);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ tabId: string; x: number; y: number; safeTop: number } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [showControlsMenu, setShowControlsMenu] = useState(false);
  const [showResSubmenu, setShowResSubmenu] = useState(false);
  const dragState = useRef<{ idx: number; startX: number; active: boolean } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const controlsBtnRef = useRef<HTMLButtonElement>(null);
  const controlsMenuRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const hasSessionControls = Boolean(sessionControls);
  const showWinKeyControl = sessionControls?.showWinKey !== false;
  const ctrlAltDelMode = sessionControls?.ctrlAltDelMode ?? 'send';
  const resolutionModeLabel = sessionControls?.resMode === 'adaptive'
    ? t('rdpAuto')
    : sessionControls?.resMode === 'smartSizing'
      ? t('rdpLocalScaling')
      : (sessionControls?.resolution || '—');

  const notifySessionControlsMenuState = useCallback(() => {
    if (!hasSessionControls || !showControlsMenu) {
      onSessionControlsMenuOpenChange?.(false);
      onOverlayClipRectChange?.('session-controls', false);
      return;
    }
    const rect = rectFromElement(controlsMenuRef.current);
    onSessionControlsMenuOpenChange?.(true, rect);
    onOverlayClipRectChange?.('session-controls', true, rect);
  }, [hasSessionControls, onOverlayClipRectChange, onSessionControlsMenuOpenChange, showControlsMenu]);

  const notifyContextMenuState = useCallback(() => {
    if (!ctxMenu || activeXSafeMenus) {
      onOverlayClipRectChange?.('tab-context-menu', false);
      return;
    }
    onOverlayClipRectChange?.('tab-context-menu', true, rectFromElement(contextMenuRef.current));
  }, [activeXSafeMenus, ctxMenu, onOverlayClipRectChange]);

  useLayoutEffect(() => {
    notifySessionControlsMenuState();
  }, [notifySessionControlsMenuState, showResSubmenu]);

  useLayoutEffect(() => {
    notifyContextMenuState();
  }, [notifyContextMenuState]);

  useEffect(() => {
    if (!showControlsMenu) return;
    window.addEventListener('resize', notifySessionControlsMenuState);
    window.visualViewport?.addEventListener('resize', notifySessionControlsMenuState);
    return () => {
      window.removeEventListener('resize', notifySessionControlsMenuState);
      window.visualViewport?.removeEventListener('resize', notifySessionControlsMenuState);
    };
  }, [notifySessionControlsMenuState, showControlsMenu]);

  useEffect(() => {
    if (!ctxMenu) return;
    window.addEventListener('resize', notifyContextMenuState);
    window.visualViewport?.addEventListener('resize', notifyContextMenuState);
    return () => {
      window.removeEventListener('resize', notifyContextMenuState);
      window.visualViewport?.removeEventListener('resize', notifyContextMenuState);
    };
  }, [ctxMenu, notifyContextMenuState]);

  useEffect(() => {
    return () => {
      onSessionControlsMenuOpenChange?.(false);
      onOverlayClipRectChange?.('session-controls', false);
      onOverlayClipRectChange?.('tab-context-menu', false);
    };
  }, [onOverlayClipRectChange, onSessionControlsMenuOpenChange]);

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
      setDragActive(true);
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
      setDragActive(false);
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
    <div ref={barRef} className="flex items-center gap-1 px-2 py-1 bg-card/80 border-b border-border shrink-0">
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
        {tabs.map((tab, idx) => {
          const route = tab.routeLabel ? ROUTE_DISPLAY[tab.routeLabel] : null;
          const RouteIcon = route?.icon;
          const fullRouteLabel = tab.routeLabel ? t(ROUTE_TRANSLATION_KEYS[tab.routeLabel]) : null;

          return (
          <div
            key={tab.id}
            ref={(el) => { if (el) tabRefs.current.set(idx, el); else tabRefs.current.delete(idx); }}
            onMouseDown={(e) => startDrag(idx, e)}
            onContextMenu={(e) => {
              e.preventDefault();
              const barRect = barRef.current?.getBoundingClientRect();
              const menuHeight = 32;
              setCtxMenu({
                tabId: tab.id,
                x: e.clientX,
                y: e.clientY,
                safeTop: barRect
                  ? Math.max(0, Math.round(barRect.top + (barRect.height - menuHeight) / 2))
                  : Math.max(0, e.clientY - menuHeight),
              });
            }}
            style={dragIdx === idx && dragActive
              ? { transform: `translateX(${dragOffsetX}px)`, zIndex: 50, position: 'relative' as const }
              : undefined}
            className={cn(
              "flex items-center shrink-0 max-w-[220px] rounded-md group transition-none select-none",
              tab.id === activeTabId
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              dragIdx === idx && dragActive && "opacity-80 shadow-lg",
              hoverIdx === idx && dragIdx !== idx && "ring-2 ring-primary ring-offset-1 ring-offset-background",
            )}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-1.5 text-xs font-medium cursor-grab active:cursor-grabbing transition-colors"
              onClick={() => {
                  if (dragActive) return; // suppress click after drag
                onSelectTab(tab.id);
                onViewModeChange('tab');
              }}
            >
              <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", STATUS_COLOR[tab.status])} title={tab.status} />
              {route && RouteIcon && fullRouteLabel && (
                <span
                  className={cn('grid h-[22px] w-[22px] shrink-0 place-items-center rounded-[7px]', route.iconClassName)}
                  title={fullRouteLabel}
                  aria-label={fullRouteLabel}
                >
                  <RouteIcon className="h-3.5 w-3.5" strokeWidth={2} />
                </span>
              )}
              <span className="truncate">{tab.name}</span>
              {route && (
                <span
                  className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold leading-none', route.labelClassName)}
                >
                  {t(route.shortLabelKey)}
                </span>
              )}
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.name}`}
              className="opacity-40 group-hover:opacity-100 hover:text-destructive transition-opacity ml-1 mr-2 shrink-0 cursor-pointer"
              onClick={() => onCloseTab(tab.id)}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          );
        })}
      </div>

      {/* Right-click context menu */}
      {ctxMenu && (
        <>
          <div className="fixed inset-0 z-[99]" onClick={() => setCtxMenu(null)} />
          <div
            ref={contextMenuRef}
            data-testid="rdp-tab-context-menu"
            className={cn(
              "fixed z-[100] border border-border bg-popover",
              activeXSafeMenus
                ? "flex h-8 items-center gap-1 rounded-md p-0.5 shadow-none"
                : "min-w-[140px] rounded-md p-1 shadow-md animate-in fade-in-0 zoom-in-95",
            )}
            style={activeXSafeMenus
              ? (() => {
                  const menuWidth = onReconnectTab ? 224 : 96;
                  return {
                    left: clampContextMenuLeft(ctxMenu.x, menuWidth),
                    top: ctxMenu.safeTop,
                  };
                })()
              : { left: ctxMenu.x, top: ctxMenu.y }}
          >
            {onReconnectTab && (
              <button
                type="button"
                className={cn(
                  "flex items-center gap-2 rounded-sm text-xs hover:bg-accent hover:text-accent-foreground cursor-pointer",
                  activeXSafeMenus ? "h-7 px-2 whitespace-nowrap" : "w-full px-2 py-1.5",
                )}
                onClick={() => { onReconnectTab(ctxMenu.tabId); setCtxMenu(null); }}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {t('rdpReconnect')}
              </button>
            )}
            <button
              type="button"
              className={cn(
                "flex items-center gap-2 rounded-sm text-xs hover:bg-accent hover:text-accent-foreground text-destructive cursor-pointer",
                activeXSafeMenus ? "h-7 px-2 whitespace-nowrap" : "w-full px-2 py-1.5",
              )}
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
            aria-label="RDP session controls"
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
              <div
                ref={controlsMenuRef}
                className={cn(
                  "absolute right-0 top-full mt-1 z-[100] min-w-[180px] border border-border p-1",
                  activeXSafeMenus
                    ? "rounded-none bg-popover shadow-none"
                    : "bg-popover/95 backdrop-blur-md shadow-xl animate-in fade-in-0 zoom-in-95",
                )}
              >
                {/* FPS & Resolution display */}
                <div className="flex items-center justify-between px-2 py-1.5 text-[11px] font-mono">
                  <span className="text-cyan-400/80">
                    {resolutionModeLabel}
                  </span>
                  {sessionControls.fps !== null && (
                    <span className="text-emerald-400/80">{sessionControls.fps} fps</span>
                  )}
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

                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground cursor-pointer"
                  onClick={() => { sessionControls.onToggleFullscreen(); setShowControlsMenu(false); }}
                >
                  {sessionControls.fullscreen
                    ? <Minimize2 className="h-3.5 w-3.5" />
                    : <Maximize2 className="h-3.5 w-3.5" />}
                  {sessionControls.fullscreen ? t('rdpExitFullscreen') : t('rdpFullscreen')}
                </button>

                <div className="h-px bg-border/60 my-0.5" />

                {sessionControls.showClipboardManagement !== false && (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground cursor-pointer whitespace-nowrap"
                    onClick={() => { sessionControls.onToggleClipboardStrategy(); }}
                  >
                    <ClipboardCopy className="h-3.5 w-3.5 shrink-0" />
                    {t('rdpClipboard')} {sessionControls.macClipboardStrategy === 'session-file-url' ? t('rdpClipboardStandard') : t('rdpClipboardExperimental')}
                  </button>
                )}

                {sessionControls.showDriveRedirection && (
                  <div className="flex w-full items-center justify-between gap-3 px-2 py-1.5 text-xs">
                    <div className="flex min-w-0 items-center gap-2">
                      <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                      <span className="whitespace-nowrap">{t('rdpDriveRedirection')}</span>
                    </div>
                    <Switch
                      checked={sessionControls.driveRedirectionEnabled}
                      onCheckedChange={enabled => {
                        sessionControls.onToggleDriveRedirection(enabled);
                        setShowControlsMenu(false);
                      }}
                      aria-label={t('rdpDriveRedirection')}
                    />
                  </div>
                )}

                {sessionControls.showMultiMonitor && (
                  <div className="flex w-full items-center justify-between gap-3 px-2 py-1.5 text-xs">
                    <div className="flex min-w-0 items-center gap-2">
                      <Monitor className="h-3.5 w-3.5 shrink-0" />
                      <span className="whitespace-nowrap">{t('rdpMultiMonitor')}</span>
                    </div>
                    <Switch
                      checked={sessionControls.multiMonitorEnabled ?? false}
                      onCheckedChange={enabled => {
                        sessionControls.onToggleMultiMonitor?.(enabled);
                        setShowControlsMenu(false);
                      }}
                      aria-label={t('rdpMultiMonitor')}
                    />
                  </div>
                )}

                {sessionControls.onSendClipboardText && (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground cursor-pointer whitespace-nowrap"
                    onClick={() => { sessionControls.onSendClipboardText?.(); setShowControlsMenu(false); }}
                  >
                    <ClipboardCopy className="h-3.5 w-3.5 shrink-0" />
                    {t('rdpSendClipboardText')}
                  </button>
                )}

                {sessionControls.showClipboardManagement !== false && (
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
                )}

                <div className="h-px bg-border/60 my-0.5" />

                {/* Virtual keys: KKTerm ActiveX exposes Ctrl+Alt+Del as a hint, not a direct Windows toolbar action. */}
                {showWinKeyControl && (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground cursor-pointer"
                    onClick={() => { sessionControls.onSendWinKey(); setShowControlsMenu(false); }}
                  >
                    <Keyboard className="h-3.5 w-3.5" />
                    {t('rdpSendWinKey')}
                  </button>
                )}
                {ctrlAltDelMode === 'send' && (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground cursor-pointer"
                    onClick={() => { sessionControls.onSendCtrlAltDel(); setShowControlsMenu(false); }}
                  >
                    <ShieldAlert className="h-3.5 w-3.5" />
                    {t('rdpSendCtrlAltDel')}
                  </button>
                )}
                {ctrlAltDelMode === 'hint' && (
                  <button
                    type="button"
                    disabled
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-muted-foreground opacity-70 cursor-default"
                    title={t('rdpSendCtrlAltDelHint')}
                  >
                    <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
                    <span className="whitespace-nowrap">{t('rdpSendCtrlAltDelHint')}</span>
                  </button>
                )}

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

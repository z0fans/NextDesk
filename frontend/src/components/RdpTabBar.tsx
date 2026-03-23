import { useRef, useCallback, useEffect, useState } from 'react';
import { X, LayoutGrid, LayoutList } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { SessionTab, ViewMode } from '@/lib/rdp-types';

interface Props {
  tabs: SessionTab[];
  activeTabId: string | null;
  viewMode: ViewMode;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onViewModeChange: (mode: ViewMode) => void;
  onReorderTabs?: (from: number, to: number) => void;
}

const STATUS_COLOR: Record<string, string> = {
  connected: 'bg-emerald-500',
  connecting: 'bg-amber-500 animate-pulse',
  error: 'bg-red-500',
  idle: 'bg-slate-500',
  disconnected: 'bg-slate-600',
};

const DRAG_THRESHOLD = 4; // px before activating drag

export function RdpTabBar({ tabs, activeTabId, viewMode, onSelectTab, onCloseTab, onViewModeChange, onReorderTabs }: Props) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOffsetX, setDragOffsetX] = useState(0);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const dragState = useRef<{ idx: number; startX: number; active: boolean } | null>(null);
  const tabRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Hit-test: find which tab index the cursor is over
  const hitTest = useCallback((clientX: number) => {
    let found: number | null = null;
    tabRefs.current.forEach((el, i) => {
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
      setHoverIdx(hitTest(e.clientX));
    };
    const onUp = (e: MouseEvent) => {
      const d = dragState.current;
      if (!d) return;
      if (d.active) {
        const target = hitTest(e.clientX);
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

  if (tabs.length === 0) return null;

  const startDrag = (idx: number, e: React.MouseEvent) => {
    // Ignore right-click
    if (e.button !== 0) return;
    dragState.current = { idx, startX: e.clientX, active: false };
    setDragIdx(idx);
    setDragOffsetX(0);
  };

  return (
    <div className="flex items-center gap-1 px-2 py-1 bg-card/80 border-b border-border overflow-x-auto shrink-0">
      <div className="flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto">
        {tabs.map((tab, idx) => (
          <div
            key={tab.id}
            ref={(el) => { if (el) tabRefs.current.set(idx, el); else tabRefs.current.delete(idx); }}
            onMouseDown={(e) => startDrag(idx, e)}
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

      {/* View toggle */}
      <div className="flex items-center gap-0.5 ml-2 shrink-0">
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

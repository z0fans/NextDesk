import { Monitor } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SessionTab } from '@/lib/rdp-types';

interface Props {
  tabs: SessionTab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
}

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  connected: { text: 'Connected', color: 'text-emerald-500' },
  connecting: { text: 'Connecting...', color: 'text-amber-500' },
  error: { text: 'Error', color: 'text-red-500' },
  idle: { text: 'Ready', color: 'text-slate-400' },
  disconnected: { text: 'Disconnected', color: 'text-slate-500' },
};

export function RdpGridView({ tabs, activeTabId, onSelectTab }: Props) {
  if (tabs.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        No active sessions
      </div>
    );
  }

  return (
    <div className="flex-1 p-4 overflow-y-auto">
      <div className="grid grid-cols-2 gap-4">
        {tabs.map(tab => {
          const st = STATUS_LABEL[tab.status] ?? STATUS_LABEL.idle;
          return (
            <button
              key={tab.id}
              className={cn(
                "relative rounded-xl overflow-hidden border transition-all cursor-pointer",
                "bg-background/50 hover:border-blue-500/50 hover:shadow-lg hover:shadow-blue-500/10",
                tab.id === activeTabId ? "border-blue-500 ring-1 ring-blue-500/30" : "border-border",
              )}
              onClick={() => onSelectTab(tab.id)}
            >
              {/* Thumbnail area */}
              <div className="aspect-video bg-[#0f172a] flex items-center justify-center overflow-hidden">
                {tab.thumbnailUrl ? (
                  <img
                    src={tab.thumbnailUrl}
                    alt={tab.name}
                    className="w-full h-full object-contain"
                    draggable={false}
                  />
                ) : (
                  <Monitor className="h-10 w-10 text-slate-700" />
                )}
              </div>
              {/* Info bar */}
              <div className="flex items-center gap-2 px-3 py-2">
                <Monitor className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="text-xs font-medium truncate flex-1 text-left">{tab.name}</span>
                <span className={cn("text-[10px]", st.color)}>{st.text}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

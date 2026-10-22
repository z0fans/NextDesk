import { Monitor, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/useTranslation';

interface RdpEmptyStateProps {
  onNewServer: () => void;
}

export function RdpEmptyState({ onNewServer }: RdpEmptyStateProps) {
  const { t } = useTranslation();

  return (
    <div
      data-region="rdp-empty-state"
      className="flex flex-1 items-center justify-center bg-[radial-gradient(circle_at_center,_rgba(8,145,178,0.08),_transparent_45%)]"
    >
      <div className="max-w-sm text-center">
        <div
          data-region="rdp-empty-state-icon"
          className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl border border-cyan-500/20 bg-cyan-500/10"
        >
          <Monitor className="h-7 w-7 text-cyan-500/60" />
        </div>
        <h3 className="mt-5 text-lg font-semibold text-foreground">
          {t('rdpNoActiveSessions')}
        </h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {t('rdpAddServerToStart')}
        </p>
        <Button
          className="mt-5 bg-gradient-to-r from-cyan-600 to-blue-600 text-white"
          onClick={onNewServer}
        >
          <Plus className="h-4 w-4" />
          {t('rdpNewConnection')}
        </Button>
      </div>
    </div>
  );
}

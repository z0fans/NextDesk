import { Cloud, Route } from 'lucide-react';
import type { ConnectionRoute } from '@/api';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n/useTranslation';

type RdpConnectionOverlayProps = {
  name: string;
  routeLabel?: ConnectionRoute;
};

const ROUTE_BADGE_KEYS = {
  cloud: 'routeCloudAccelerated',
  lan_direct: 'routeLanDirect',
  local_direct: 'routeLocalDirect',
  cloud_fallback: 'routeCloudFallback',
} as const;

const ROUTE_TITLE_KEYS = {
  cloud: 'rdpConnectingCloud',
  lan_direct: 'rdpConnectingLanDirect',
  local_direct: 'rdpConnectingLocalDirect',
  cloud_fallback: 'rdpConnectingDirectFallback',
} as const;

export function RdpConnectionOverlay({ name, routeLabel }: RdpConnectionOverlayProps) {
  const { t } = useTranslation();
  const isCloud = routeLabel === 'cloud';
  const isFallback = routeLabel === 'cloud_fallback';
  const title = routeLabel ? t(ROUTE_TITLE_KEYS[routeLabel]) : t('rdpSelectingRoute');

  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="relative flex h-14 w-14 items-center justify-center" aria-hidden="true">
        <div
          className={cn(
            'absolute inset-0 rounded-full border-[3px] animate-spin',
            isFallback
              ? 'border-amber-500/20 border-t-amber-400'
              : 'border-cyan-500/20 border-t-cyan-400',
          )}
        />
        {isCloud
          ? <Cloud className="h-5 w-5 text-cyan-300" strokeWidth={1.8} />
          : <Route className={cn('h-5 w-5', isFallback ? 'text-amber-300' : 'text-cyan-300')} strokeWidth={1.8} />}
      </div>

      <div className="mt-5 flex min-h-[104px] max-w-md flex-col items-center">
        {routeLabel && (
          <div
            className={cn(
              'mb-3 inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium tracking-wide',
              isCloud && 'border-cyan-400/25 bg-cyan-400/10 text-cyan-300',
              isFallback && 'border-amber-400/25 bg-amber-400/10 text-amber-300',
              !isCloud && !isFallback && 'border-border bg-muted/55 text-muted-foreground',
            )}
          >
            {t(ROUTE_BADGE_KEYS[routeLabel])}
          </div>
        )}

        <p className="text-base font-medium tracking-tight text-foreground sm:text-lg">
          {title}
        </p>
        <p className="mt-2 max-w-sm truncate text-sm text-muted-foreground" title={name}>
          {routeLabel === 'cloud'
            ? t('rdpConnectingCloudDetail', { name })
            : t('rdpConnectingTarget', { name })}
        </p>
      </div>
    </div>
  );
}

import { Clock3, LogIn, LogOut, RefreshCw, ShieldCheck } from 'lucide-react';
import type { CloudAccountStatus } from '@/api';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/useTranslation';
import { cn } from '@/lib/utils';

interface AccountPageProps {
  status: CloudAccountStatus | null;
  authorizing: boolean;
  refreshing: boolean;
  refreshMessage: string;
  onAuthorize: () => void;
  onRefresh: () => void;
  onSignOut: () => void;
}

function formatTimestamp(value?: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function AccountPage({
  status,
  authorizing,
  refreshing,
  refreshMessage,
  onAuthorize,
  onRefresh,
  onSignOut,
}: AccountPageProps) {
  const { t } = useTranslation();
  const authorized = status?.authorized === true;
  const cloudAvailable = authorized && status?.account_available === true;

  return (
    <div className="w-full">
      {!authorized ? (
        <section className="rounded-md border border-border bg-card p-6">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 h-5 w-5 text-muted-foreground" />
              <div>
                <div className="font-medium text-foreground">{t('notAuthorized')}</div>
                {status?.reason && (
                  <div className="mt-1 text-sm text-amber-500">{status.reason}</div>
                )}
              </div>
            </div>
            <Button onClick={onAuthorize} disabled={authorizing}>
              <LogIn />
              {authorizing ? t('authorizing') : t('signInToCloud')}
            </Button>
          </div>
        </section>
      ) : (
        <section className="rounded-md border border-border bg-card p-6">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className={cn(
                'flex items-center gap-2 text-sm',
                cloudAvailable ? 'text-emerald-500' : 'text-amber-500',
              )}>
                <ShieldCheck className="h-4 w-4" />
                {cloudAvailable ? t('authorized') : t('cloudUnavailable')}
              </div>
              <div className="mt-2 truncate text-lg font-semibold text-foreground">
                {status.display || '-'}
              </div>
              {!cloudAvailable && status.reason && (
                <div className="mt-1 text-sm text-amber-500">{status.reason}</div>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
                <RefreshCw className={cn(refreshing && 'animate-spin')} />
                {refreshing ? t('refreshing') : t('refresh')}
              </Button>
              <Button variant="outline" size="sm" onClick={onSignOut}>
                <LogOut />
                {t('signOutOfCloud')}
              </Button>
            </div>
          </div>

          {refreshMessage && (
            <div className="mt-4 text-sm text-muted-foreground" role="status">
              {refreshMessage}
            </div>
          )}

          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border border-border bg-background/50 p-4">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Clock3 className="h-4 w-4" />
                {status.account_available_until ? t('cloudAvailableUntil') : t('cloudAcceleration')}
              </div>
              <div className={cn(
                'mt-2 text-sm font-medium',
                !status.account_available_until && cloudAvailable
                  ? 'text-emerald-500'
                  : 'text-foreground',
              )}>
                {status.account_available_until
                  ? formatTimestamp(status.account_available_until)
                  : cloudAvailable
                    ? t('available')
                    : t('unavailable')}
              </div>
            </div>
            <div className="rounded-md border border-border bg-background/50 p-4">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="h-4 w-4" />
                {t('deviceAuthorization')}
              </div>
              <div
                className={cn(
                  'mt-2 text-sm font-medium',
                  status.authorized ? 'text-emerald-500' : 'text-muted-foreground',
                )}
              >
                {formatTimestamp(status.device_expires_at)}
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

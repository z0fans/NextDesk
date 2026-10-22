import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, RotateCw, X } from "lucide-react";

import { api, type ConnectionServiceKind } from "@/api";
import { EMPTY_ROUTE_DEGRADATION_TRACKER, routeHealthCandidateKey, updateRouteDegradationTracker, type RouteDegradationTracker } from "@/lib/route-degradation";
import { useTranslation } from "@/i18n/useTranslation";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const DEFAULT_ROUTE_HEALTH_INTERVAL_MS = 15_000;

function scoreLabel(score?: number): string {
  return typeof score === "number" ? `${Math.round(score)} ms` : "—";
}

export function RouteDegradationNotice({
  serviceKind,
  sessionId,
  enabled,
  onReconnect,
  placement = "overlay",
}: {
  serviceKind: ConnectionServiceKind;
  sessionId: string;
  enabled: boolean;
  onReconnect: () => void;
  placement?: "overlay" | "flow";
}) {
  const { t } = useTranslation();
  const [tracker, setTracker] = useState<RouteDegradationTracker>(EMPTY_ROUTE_DEGRADATION_TRACKER);
  const [dismissedKey, setDismissedKey] = useState<string>();
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setTracker(EMPTY_ROUTE_DEGRADATION_TRACKER);
      setConfirming(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof window.setTimeout> | undefined;
    let nextIntervalMs = DEFAULT_ROUTE_HEALTH_INTERVAL_MS;

    const check = async () => {
      try {
        const assessment = await api.connectionRouteHealthCheck(serviceKind, sessionId);
        if (!cancelled) {
          setTracker((current) => updateRouteDegradationTracker(current, assessment, Date.now()));
          nextIntervalMs = Math.max(5_000, Math.min(60_000, assessment.checkIntervalMs));
        }
      } catch {
        // Route advice is deliberately best-effort. A control-plane outage must
        // never disturb an otherwise healthy established session.
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(check, nextIntervalMs);
        }
      }
    };

    void check();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [enabled, serviceKind, sessionId]);

  const visible = tracker.visible;
  const candidateKey = useMemo(
    () => visible ? routeHealthCandidateKey(visible) : undefined,
    [visible],
  );
  useEffect(() => {
    setConfirming(false);
  }, [candidateKey]);
  if (!visible || !candidateKey || candidateKey === dismissedKey) return null;

  return (
    <section
      role="status"
      aria-label={t("routeQualityDegraded")}
      className={cn(
        "z-30 rounded-xl border border-amber-500/35 bg-popover/95 px-4 py-3 text-popover-foreground shadow-xl backdrop-blur",
        placement === "overlay"
          ? "absolute left-1/2 top-3 w-[min(680px,calc(100%-24px))] -translate-x-1/2"
          : "relative mx-3 mt-3 w-auto shrink-0",
      )}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{t("routeQualityDegraded")}</p>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {confirming
              ? t("routeQualityReconnectWarning")
              : t("routeQualityDegradedDescription")}
          </p>
          <details className="mt-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none font-medium text-foreground/80">
              {t("routeQualityDiagnostics")}
            </summary>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-muted/50 px-3 py-2">
              <dt>{t("routeQualityCurrentScore")}</dt>
              <dd className="text-right font-mono">{scoreLabel(visible.current?.scoreMs)}</dd>
              <dt>{t("routeQualityAlternativeScore")}</dt>
              <dd className="text-right font-mono">{scoreLabel(visible.alternative?.scoreMs)}</dd>
              <dt>{t("routeQualityImprovement")}</dt>
              <dd className="text-right font-mono">
                {typeof visible.improvementPercent === "number"
                  ? `${visible.improvementPercent.toFixed(0)}%`
                  : "—"}
              </dd>
              <dt>{t("routeQualityThreshold")}</dt>
              <dd className="text-right font-mono">{visible.thresholdPercent.toFixed(0)}%</dd>
            </dl>
          </details>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {confirming ? (
            <>
              <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>
                {t("routeQualityCancel")}
              </Button>
              <Button size="sm" onClick={onReconnect}>
                <RotateCw className="h-3.5 w-3.5" />
                {t("routeQualityConfirmReconnect")}
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => setConfirming(true)}>
              <RotateCw className="h-3.5 w-3.5" />
              {t("routeQualityReconnect")}
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            aria-label={t("routeQualityDismiss")}
            onClick={() => setDismissedKey(candidateKey)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </section>
  );
}

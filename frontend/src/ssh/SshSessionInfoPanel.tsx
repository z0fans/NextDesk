import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  FileText,
  KeyRound,
  Laptop,
  Network,
  Server,
  UserRound,
  Waypoints,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { useTranslation } from "@/i18n/useTranslation";
import type { TranslationKey } from "@/i18n/translations";
import { cn } from "@/lib/utils";
import { sshApi } from "./ssh-api";
import type { SshConnection, SshHostOs, SshMonitorSnapshot } from "./types";

const MONITOR_INTERVAL_MS = 2_000;
const MONITOR_HISTORY_LENGTH = 42;

interface SshSessionInfoPanelProps {
  sessionId: string;
  active: boolean;
  connection: SshConnection;
  state: string;
  routeLabel?: string;
  width?: number;
  onDetectedOs?: (connectionId: string, os: SshHostOs) => void;
}

interface MonitorState {
  snapshot?: SshMonitorSnapshot;
  loading: boolean;
  unavailable: boolean;
  networkHistory: number[];
  latencyHistory: number[];
}

type Translate = ReturnType<typeof useTranslation>["t"];

function stateTranslationKey(state: string): TranslationKey {
  const keys: Record<string, TranslationKey> = {
    resolving_route: "sshStateResolvingRoute",
    connecting_transport: "sshStateConnectingTransport",
    authenticating: "sshStateAuthenticating",
    connected: "sshStateConnected",
    disconnected: "sshStateDisconnected",
    exited: "sshStateExited",
    error: "sshStateError",
    host_key_required: "sshStateHostKeyRequired",
  };
  return keys[state] ?? "sshStateError";
}

function routeTranslationKey(
  routeLabel: string | undefined,
  state: string,
): TranslationKey {
  if (routeLabel === "cloud") return "sshCloudRoute";
  if (routeLabel === "lan_direct") return "sshLanRoute";
  if (routeLabel === "cloud_fallback") return "sshCloudFallback";
  if (routeLabel) return "sshDirectRoute";
  return state === "error" ? "sshStateError" : "sshRouteResolving";
}

function routeBadgeClass(routeLabel?: string): string {
  if (routeLabel === "cloud") {
    return "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-400";
  }
  if (routeLabel === "lan_direct") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
  }
  if (routeLabel === "cloud_fallback") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400";
  }
  return "border-border bg-muted text-muted-foreground";
}

function routePolicyTranslationKey(connection: SshConnection): TranslationKey {
  if (connection.routePolicy === "direct") return "sshRouteDirect";
  if (connection.routePolicy === "cloud_only") return "sshRouteCloudOnly";
  return "sshRouteAuto";
}

function appendHistory(history: number[], value: number): number[] {
  return [...history, Number.isFinite(value) ? Math.max(0, value) : 0].slice(
    -MONITOR_HISTORY_LENGTH,
  );
}

function useSshMonitor(sessionId: string, enabled: boolean): MonitorState {
  const [state, setState] = useState<MonitorState>({
    loading: false,
    unavailable: false,
    networkHistory: [],
    latencyHistory: [],
  });

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    setState({
      loading: enabled,
      unavailable: false,
      networkHistory: [],
      latencyHistory: [],
    });
    if (!enabled) return undefined;

    const poll = async () => {
      try {
        const snapshot = await sshApi.monitorSnapshot(sessionId);
        if (cancelled) return;
        setState((current) => ({
          snapshot,
          loading: false,
          unavailable: false,
          networkHistory: appendHistory(
            current.networkHistory,
            snapshot.networkReceiveBytesPerSecond +
              snapshot.networkTransmitBytesPerSecond,
          ),
          latencyHistory: appendHistory(
            current.latencyHistory,
            snapshot.latencyMs,
          ),
        }));
      } catch {
        if (cancelled) return;
        setState((current) => ({
          ...current,
          loading: false,
          unavailable: true,
        }));
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, MONITOR_INTERVAL_MS);
      }
    };
    void poll();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [enabled, sessionId]);

  return state;
}

export function SshSessionInfoPanel({
  sessionId,
  active,
  connection,
  state,
  routeLabel,
  width = 232,
  onDetectedOs,
}: SshSessionInfoPanelProps) {
  const { t } = useTranslation();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const connected = state === "connected";
  const failed = state === "error";
  const monitor = useSshMonitor(sessionId, active && connected);
  const detailsId = `${sessionId}-connection-details`;

  useEffect(() => {
    const platform = monitor.snapshot?.platform;
    if (platform && platform !== "unknown")
      onDetectedOs?.(connection.id, platform);
  }, [connection.id, monitor.snapshot?.platform, onDetectedOs]);

  return (
    <aside
      className="flex h-full shrink-0 flex-col bg-card/70 text-card-foreground"
      style={{ width }}
      aria-label={t("sshSessionInformation")}
    >
      <header className="shrink-0 border-b border-border px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5 text-[10px] font-medium">
            <span
              className={cn(
                "h-2 w-2 shrink-0 rounded-full",
                connected
                  ? "bg-emerald-500"
                  : failed
                    ? "bg-destructive"
                    : "bg-amber-500",
              )}
            />
            <span
              className={cn(
                "truncate",
                connected
                  ? "text-emerald-600 dark:text-emerald-400"
                  : failed
                    ? "text-destructive"
                    : "text-amber-600 dark:text-amber-400",
              )}
            >
              {t(stateTranslationKey(state))}
            </span>
          </div>
          <Badge
            variant="outline"
            className={cn(
              "h-5 min-w-0 max-w-32 px-1.5 text-[9px]",
              routeBadgeClass(routeLabel),
            )}
          >
            <span className="truncate">
              {t(routeTranslationKey(routeLabel, state))}
            </span>
          </Badge>
        </div>
        <h2 className="mt-1 truncate text-sm font-semibold text-foreground">
          {connection.name}
        </h2>
        <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
          {connection.username}@{connection.host}:{connection.port}
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <MonitorContent monitor={monitor} connected={connected} />
      </div>

      <div className="shrink-0 bg-card/95">
        {detailsOpen && (
          <section
            id={detailsId}
            className="max-h-60 overflow-y-auto border-y border-border p-3"
          >
            <dl className="grid grid-cols-2 gap-1">
              <InfoRow
                icon={Server}
                label={t("sshHost")}
                value={connection.host}
                mono
                wide
              />
              <InfoRow
                icon={Network}
                label={t("port")}
                value={String(connection.port)}
                mono
              />
              <InfoRow
                icon={UserRound}
                label={t("sshUsername")}
                value={connection.username}
              />
              <InfoRow
                icon={KeyRound}
                label={t("sshAuthentication")}
                value={t(
                  connection.authMethod === "password"
                    ? "sshPassword"
                    : "sshPrivateKey",
                )}
              />
              <InfoRow
                icon={Waypoints}
                label={t("sshRoutePolicy")}
                value={t(routePolicyTranslationKey(connection))}
                wide
              />
              <InfoRow
                icon={Laptop}
                label={t("sshOperatingSystem")}
                value={t(
                  connection.detectedOs === "windows"
                    ? "sshOperatingSystemWindows"
                    : connection.detectedOs === "linux"
                      ? "sshOperatingSystemLinux"
                      : "sshOperatingSystemUnknown",
                )}
                wide
              />
              {connection.notes && (
                <InfoRow
                  icon={FileText}
                  label={t("sshNotes")}
                  value={connection.notes}
                  wide
                />
              )}
              {connection.proxyType && connection.proxyType !== "none" && (
                <InfoRow
                  icon={Network}
                  label={t("sshProxy")}
                  value={`${connection.proxyType.toUpperCase()} · ${connection.proxyHost}:${connection.proxyPort}`}
                  mono
                  wide
                />
              )}
            </dl>
          </section>
        )}
        <button
          type="button"
          className={cn(
            "flex h-11 w-full items-center justify-between px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            !detailsOpen && "border-t border-border",
          )}
          aria-expanded={detailsOpen}
          aria-controls={detailsId}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          <span>{t("sshConnectionDetails")}</span>
          {detailsOpen ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronUp className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    </aside>
  );
}

function MonitorContent({
  monitor,
  connected,
}: {
  monitor: MonitorState;
  connected: boolean;
}) {
  const { t } = useTranslation();
  if (!connected) return null;
  if (monitor.loading && !monitor.snapshot) {
    return (
      <p className="p-4 text-xs text-muted-foreground">
        {t("sshMonitorLoading")}
      </p>
    );
  }
  if (monitor.unavailable && !monitor.snapshot) {
    return (
      <p className="p-4 text-xs text-muted-foreground">
        {t("sshMonitorUnavailable")}
      </p>
    );
  }
  const snapshot = monitor.snapshot;
  if (!snapshot) return null;
  if (!snapshot.supported) {
    return (
      <p className="p-4 text-xs leading-5 text-muted-foreground">
        {t("sshMonitorUnsupported")}
      </p>
    );
  }

  const memoryPercent = percentage(
    snapshot.memoryUsedBytes,
    snapshot.memoryTotalBytes,
  );
  const swapPercent = percentage(
    snapshot.swapUsedBytes,
    snapshot.swapTotalBytes,
  );
  return (
    <>
      {monitor.unavailable && (
        <p className="border-b border-border bg-amber-500/5 px-3 py-2 text-[10px] text-amber-700 dark:text-amber-400">
          {t("sshMonitorUnavailable")}
        </p>
      )}
      <section className="border-b border-border p-3">
        <SectionTitle>{t("sshRealtimeMonitor")}</SectionTitle>
        <div className="mt-2 space-y-1.5">
          <MetricLine
            label={t("sshMonitorUptime")}
            value={formatUptime(snapshot.uptimeSeconds, t)}
          />
          <MetricLine
            label={t("sshMonitorLoad")}
            value={snapshot.loadAverage
              .map((value) => value.toFixed(2))
              .join(" ")}
          />
          <MetricBar label={t("sshMonitorCpu")} percent={snapshot.cpuPercent} />
          <MetricBar
            label={t("sshMonitorMemory")}
            percent={memoryPercent}
            detail={`${formatBytes(snapshot.memoryUsedBytes, t)} / ${formatBytes(snapshot.memoryTotalBytes, t)}`}
            accent="cyan"
          />
          <MetricBar
            label={t("sshMonitorSwap")}
            percent={swapPercent}
            detail={`${formatBytes(snapshot.swapUsedBytes, t)} / ${formatBytes(snapshot.swapTotalBytes, t)}`}
          />
        </div>
      </section>

      <section className="border-b border-border py-3">
        <SectionTitle className="px-3">{t("sshProcessTop")}</SectionTitle>
        <div className="mt-2 grid grid-cols-[48px_36px_minmax(0,1fr)] px-3 text-[9px] text-muted-foreground">
          <span>{t("sshProcessMemory")}</span>
          <span>{t("sshProcessCpu")}</span>
          <span>{t("sshProcessCommand")}</span>
        </div>
        <div className="mt-1">
          {snapshot.processes.map((process, index) => (
            <div
              key={`${process.command}-${index}`}
              className={cn(
                "grid grid-cols-[48px_36px_minmax(0,1fr)] px-3 py-1 font-mono text-[10px]",
                index % 2 === 1 && "bg-muted/45",
              )}
            >
              <span className="text-cyan-600 dark:text-cyan-400">
                {formatBytes(process.memoryBytes, t)}
              </span>
              <span className="text-orange-600 dark:text-orange-400">
                {t("sshMonitorPercentValue", {
                  value: process.cpuPercent.toFixed(1),
                })}
              </span>
              <span
                className="truncate text-foreground"
                title={process.command}
              >
                {process.command}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="border-b border-border p-3">
        <SectionTitle>{t("sshMonitorNetwork")}</SectionTitle>
        <div className="mt-2 flex items-center justify-between gap-2 text-[10px]">
          <span className="font-mono text-muted-foreground">
            {snapshot.networkInterface ?? "-"}
          </span>
          <span className="whitespace-nowrap text-muted-foreground">
            <span className="text-emerald-600 dark:text-emerald-400">
              ↑ {formatRate(snapshot.networkTransmitBytesPerSecond, t)}
            </span>{" "}
            <span className="text-cyan-600 dark:text-cyan-400">
              ↓ {formatRate(snapshot.networkReceiveBytesPerSecond, t)}
            </span>
          </span>
        </div>
        <MiniBars values={monitor.networkHistory} colorClass="bg-emerald-400" />
      </section>

      <section className="border-b border-border p-3">
        <SectionTitle>{t("sshMonitorLatency")}</SectionTitle>
        <p className="mt-2 font-mono text-xs text-muted-foreground">
          {t("sshMonitorLatencyValue", {
            value: snapshot.latencyMs.toFixed(1),
          })}
        </p>
        <MiniBars values={monitor.latencyHistory} colorClass="bg-blue-500" />
      </section>

      <section className="p-3">
        <SectionTitle>{t("sshMonitorDisk")}</SectionTitle>
        <div className="mt-2 space-y-1">
          {snapshot.disks.map((disk, index) => (
            <div
              key={`${disk.path}-${index}`}
              className={cn(
                "grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded px-1 py-1.5 font-mono text-[10px]",
                index % 2 === 1 && "bg-muted/45",
              )}
            >
              <span className="truncate text-foreground" title={disk.path}>
                {disk.path}
              </span>
              <span className="text-muted-foreground">
                {formatBytes(disk.availableBytes, t)} /{" "}
                {formatBytes(disk.totalBytes, t)}
              </span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function SectionTitle({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <h3
      className={cn(
        "text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground",
        className,
      )}
    >
      {children}
    </h3>
  );
}

interface InfoRowProps {
  icon: typeof Server;
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
}

function InfoRow({
  icon: Icon,
  label,
  value,
  mono = false,
  wide = false,
}: InfoRowProps) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-md px-2 py-1.5 hover:bg-muted/50",
        wide && "col-span-2",
      )}
    >
      <dt className="flex items-center gap-1.5 text-[9px] text-muted-foreground">
        <Icon className="h-3 w-3 shrink-0" />
        {label}
      </dt>
      <dd
        className={cn(
          "mt-1 truncate pl-[18px] text-[11px] text-foreground",
          mono && "font-mono",
        )}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function MetricLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[10px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </div>
  );
}

function MetricBar({
  label,
  percent,
  detail,
  accent = "neutral",
}: {
  label: string;
  percent: number;
  detail?: string;
  accent?: "neutral" | "cyan";
}) {
  const { t } = useTranslation();
  const safePercent = Math.max(
    0,
    Math.min(100, Number.isFinite(percent) ? percent : 0),
  );
  return (
    <div className="grid grid-cols-[38px_minmax(0,1fr)_auto] items-center gap-1.5 text-[10px]">
      <span className="text-muted-foreground">{label}</span>
      <div className="relative h-3.5 overflow-hidden rounded-full border border-border bg-muted">
        <div
          className={cn(
            "h-full rounded-full",
            accent === "cyan" ? "bg-cyan-500/80" : "bg-foreground/15",
          )}
          style={{ width: `${safePercent}%` }}
        />
        <span className="absolute inset-0 flex items-center px-1.5 font-mono text-[9px] text-foreground">
          {t("sshMonitorPercentValue", { value: Math.round(safePercent) })}
        </span>
      </div>
      {detail && (
        <span className="whitespace-nowrap font-mono text-[9px] text-muted-foreground">
          {detail}
        </span>
      )}
    </div>
  );
}

function MiniBars({
  values,
  colorClass,
}: {
  values: number[];
  colorClass: string;
}) {
  const max = Math.max(1, ...values);
  return (
    <div
      className="mt-2 flex h-7 items-end gap-px overflow-hidden"
      aria-hidden="true"
    >
      {values.map((value, index) => (
        <span
          key={index}
          className={cn("min-w-0 flex-1 rounded-t-sm opacity-80", colorClass)}
          style={{ height: `${Math.max(8, (value / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

function percentage(used: number, total: number): number {
  return total > 0 ? (used * 100) / total : 0;
}

function formatUptime(seconds: number, t: Translate): string {
  const totalMinutes = Math.max(0, Math.floor(seconds / 60));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return t("sshMonitorUptimeValue", { days, hours, minutes });
}

function formatBytes(bytes: number, t: Translate): string {
  const unitKeys: TranslationKey[] = [
    "sshMonitorBytes",
    "sshMonitorKilobytes",
    "sshMonitorMegabytes",
    "sshMonitorGigabytes",
    "sshMonitorTerabytes",
  ];
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return t("sshMonitorSizeValue", { value: 0, unit: t(unitKeys[0]) });
  }
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < unitKeys.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 10 || Number.isInteger(value) ? 0 : 1;
  return t("sshMonitorSizeValue", {
    value: value.toFixed(digits),
    unit: t(unitKeys[unit]),
  });
}

function formatRate(bytesPerSecond: number, t: Translate): string {
  return t("sshMonitorRateValue", { value: formatBytes(bytesPerSecond, t) });
}

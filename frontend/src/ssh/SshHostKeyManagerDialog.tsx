import { useCallback, useEffect, useState } from "react";
import {
  Download,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n/useTranslation";
import { sshApi } from "./ssh-api";
import type { SshKnownHostEntry } from "./types";

interface SshHostKeyManagerDialogProps {
  open: boolean;
  onClose: () => void;
}

export function SshHostKeyManagerDialog({
  open,
  onClose,
}: SshHostKeyManagerDialogProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<SshKnownHostEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setEntries(await sshApi.knownHostsList());
    } catch {
      setError(t("sshKnownHostsOperationFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  if (!open) return null;

  const remove = async (host: string) => {
    setError("");
    try {
      await sshApi.knownHostRemove(host);
      await refresh();
    } catch {
      setError(t("sshKnownHostsOperationFailed"));
    }
  };

  const importEntries = async () => {
    setError("");
    try {
      const contents = await api.sshKnownHostsChooseImport(
        t("sshKnownHostsFileType"),
      );
      if (contents === null) return;
      await sshApi.knownHostsImport(contents);
      await refresh();
    } catch {
      setError(t("sshKnownHostsImportFailed"));
    }
  };

  const exportEntries = async () => {
    setError("");
    try {
      const contents = await sshApi.knownHostsExport();
      await api.sshKnownHostsChooseExport(contents, t("sshKnownHostsFileType"));
    } catch {
      setError(t("sshKnownHostsOperationFailed"));
    }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-known-hosts-title"
        className="flex max-h-[min(720px,calc(100vh-2rem))] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-6 py-5">
          <div className="flex min-w-0 items-start gap-3">
            <div className="rounded-lg border border-cyan-500/25 bg-cyan-500/10 p-2 text-cyan-600 dark:text-cyan-400">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2
                id="ssh-known-hosts-title"
                className="text-base font-semibold text-foreground"
              >
                {t("sshKnownHostsTitle")}
              </h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {t("sshKnownHostsDescription")}
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label={t("sshClose")}
          >
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/20 px-6 py-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void importEntries()}
          >
            <Upload className="h-3.5 w-3.5" />
            {t("sshKnownHostsImport")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void exportEntries()}
            disabled={entries.length === 0}
          >
            <Download className="h-3.5 w-3.5" />
            {t("sshKnownHostsExport")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
            />
            {t("sshKnownHostsRefresh")}
          </Button>
          <span className="ml-auto text-xs text-muted-foreground">
            {t("sshKnownHostsCount", { count: entries.length })}
          </span>
        </div>

        {error && (
          <p
            role="alert"
            className="border-b border-destructive/25 bg-destructive/5 px-6 py-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {!loading && entries.length === 0 ? (
            <div className="flex min-h-52 flex-col items-center justify-center rounded-lg border border-dashed border-border px-6 text-center">
              <ShieldCheck className="h-8 w-8 text-muted-foreground/50" />
              <p className="mt-3 text-sm font-medium text-foreground">
                {t("sshKnownHostsEmpty")}
              </p>
              <p className="mt-1 max-w-md text-xs leading-5 text-muted-foreground">
                {t("sshKnownHostsEmptyHint")}
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {entries.map((entry) => (
                <li
                  key={`${entry.host}-${entry.fingerprint}`}
                  className="flex items-center gap-3 rounded-lg border border-border bg-background/60 p-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-mono text-sm font-medium text-foreground">
                        {entry.host}
                      </span>
                      <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {entry.algorithm}
                      </span>
                    </div>
                    <p
                      className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
                      title={entry.fingerprint}
                    >
                      {entry.fingerprint}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={t("sshKnownHostRemove", { host: entry.host })}
                    onClick={() => void remove(entry.host)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

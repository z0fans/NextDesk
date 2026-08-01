import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { useTranslation } from '@/i18n/useTranslation';
import { sshApi } from './ssh-api';
import type { SshConnection, SshEvent } from './types';

interface TerminalSurfaceProps {
  sessionId: string;
  connection: SshConnection;
  visible: boolean;
  retryToken: number;
  onEvent: (event: SshEvent) => void;
}

export function TerminalSurface({
  sessionId,
  connection,
  visible,
  retryToken,
  onEvent,
}: TerminalSurfaceProps) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const backendStartedRef = useRef(false);
  const onEventRef = useRef(onEvent);
  const translationRef = useRef(t);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    translationRef.current = t;
  }, [t]);

  useEffect(() => {
    if (!hostRef.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 10_000,
      theme: {
        background: '#080d16',
        foreground: '#dbe7f3',
        cursor: '#67e8f9',
        selectionBackground: '#164e63',
        black: '#111827',
        brightBlack: '#64748b',
        green: '#34d399',
        brightGreen: '#6ee7b7',
        cyan: '#22d3ee',
        brightCyan: '#67e8f9',
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(hostRef.current);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    let disposed = false;
    let inputTail = Promise.resolve();
    const inputDisposable = terminal.onData((data) => {
      const bytes = new TextEncoder().encode(data);
      inputTail = inputTail
        .then(async () => {
          if (!disposed) await sshApi.input(sessionId, bytes);
        })
        .catch((error: unknown) => {
          if (disposed) return;
          onEventRef.current({
            kind: 'state',
            sessionId,
            state: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        });
    });
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      const bounds = hostRef.current?.getBoundingClientRect();
      void sshApi
        .resize(
          sessionId,
          cols,
          rows,
          Math.max(0, Math.round(bounds?.width ?? 0)),
          Math.max(0, Math.round(bounds?.height ?? 0)),
        )
        .catch(() => {});
    });
    const observer = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        // The surface can be zero-sized while another session tab is active.
      }
    });
    observer.observe(hostRef.current);

    return () => {
      disposed = true;
      observer.disconnect();
      inputDisposable.dispose();
      resizeDisposable.dispose();
      if (backendStartedRef.current) {
        backendStartedRef.current = false;
        void sshApi.close(sessionId).catch(() => {});
      }
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;
    let cancelled = false;
    try {
      fitAddon.fit();
    } catch {
      // Initial layout can complete after this effect; ResizeObserver retries.
    }
    const dimensions = terminal;
    terminal.write(`\r\n\x1b[38;5;45mNextDesk SSH\x1b[0m · ${translationRef.current('sshTerminalConnecting')}\r\n`);
    // StrictMode runs an effect setup/cleanup probe in development. Deferring
    // startup one task lets that probe cancel without creating a real session.
    const startupTimer = window.setTimeout(() => {
      backendStartedRef.current = true;
      void sshApi
        .start(
          {
            sessionId,
            host: connection.host,
            port: connection.port,
            username: connection.username,
            authMethod: connection.authMethod,
            credentialReference: connection.credentialReference,
            privateKeyPath: connection.privateKeyPath,
            cols: dimensions.cols,
            rows: dimensions.rows,
            pixelWidth: Math.max(0, Math.round(hostRef.current?.clientWidth ?? 0)),
            pixelHeight: Math.max(0, Math.round(hostRef.current?.clientHeight ?? 0)),
            routePolicy: connection.routePolicy,
            preferredRegion: connection.preferredRegion,
            reuseCloudBinding: retryToken > 0,
          },
          (data) => {
            if (!cancelled) terminal.write(data);
          },
          (event) => {
            if (!cancelled) onEventRef.current(event);
          },
        )
        .catch((error: unknown) => {
          if (cancelled) return;
          onEventRef.current({
            kind: 'state',
            sessionId,
            state: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(startupTimer);
    };
  }, [connection, retryToken, sessionId]);

  useEffect(() => {
    if (!visible) return;
    requestAnimationFrame(() => {
      try {
        fitAddonRef.current?.fit();
      } catch {
        // Hidden-to-visible layout can take another ResizeObserver cycle.
      }
      terminalRef.current?.focus();
    });
  }, [visible]);

  return (
    <div
      ref={hostRef}
      className="h-full w-full bg-[#080d16] p-2"
      aria-label={connection.name}
    />
  );
}

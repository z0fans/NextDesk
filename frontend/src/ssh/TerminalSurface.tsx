import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { useTranslation } from '@/i18n/useTranslation';
import { sshApi } from './ssh-api';
import type { SshConnection, SshEvent } from './types';
import {
  DEFAULT_SSH_TERMINAL_SETTINGS,
  type SshTerminalSettings,
} from './ssh-terminal-settings-store';
import {
  SshKeywordHighlighter,
  resolveSshKeywordHighlightColors,
} from './ssh-keyword-highlighter';
import { resolveSshTerminalTheme } from './ssh-terminal-themes';

interface TerminalSurfaceProps {
  sessionId: string;
  connection: SshConnection;
  visible: boolean;
  retryToken: number;
  onEvent: (event: SshEvent) => void;
  settings?: SshTerminalSettings;
}

function appThemeIsDark(): boolean {
  return typeof document !== 'undefined'
    && document.documentElement.classList.contains('dark');
}

function startFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.match(/\b(?:ssh|cloud|credential)_[a-z0-9_]{1,95}\b/)?.[0]
    ?? 'ssh_start_failed';
}

function isLateSessionClosure(code: string): boolean {
  return code === 'ssh_session_closed' || code === 'ssh_session_not_found';
}

function isTerminalSessionEvent(event: SshEvent): boolean {
  return event.kind === 'state'
    && (event.state === 'disconnected' || event.state === 'exited' || event.state === 'error');
}

const KEYWORD_COALESCE_DELAY_MS = 50;

export function TerminalSurface({
  sessionId,
  connection,
  visible,
  retryToken,
  onEvent,
  settings = DEFAULT_SSH_TERMINAL_SETTINGS,
}: TerminalSurfaceProps) {
  const { t } = useTranslation();
  const [isDarkTheme, setIsDarkTheme] = useState(appThemeIsDark);
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const keywordHighlighterRef = useRef<SshKeywordHighlighter | null>(null);
  const keywordFlushTimerRef = useRef<number | null>(null);
  const backendStartedRef = useRef(false);
  const onEventRef = useRef(onEvent);
  const translationRef = useRef(t);
  const settingsRef = useRef(settings);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    translationRef.current = t;
  }, [t]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    const root = document.documentElement;
    const syncTheme = () => setIsDarkTheme(root.classList.contains('dark'));
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!hostRef.current) return;
    const initialSettings = settingsRef.current;
    const terminal = new Terminal({
      cursorBlink: initialSettings.cursorBlink,
      cursorStyle: initialSettings.cursorStyle,
      convertEol: false,
      drawBoldTextInBrightColors: false,
      fontFamily: initialSettings.fontFamily,
      fontSize: initialSettings.fontSize,
      lineHeight: initialSettings.lineHeight,
      scrollback: initialSettings.scrollback,
      theme: resolveSshTerminalTheme(initialSettings.palette, appThemeIsDark()),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(hostRef.current);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    keywordHighlighterRef.current = new SshKeywordHighlighter();

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
          const code = startFailureCode(error);
          if (isLateSessionClosure(code)) return;
          onEventRef.current({
            kind: 'state',
            sessionId,
            state: 'error',
            message: code,
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
      const activeHighlighter = keywordHighlighterRef.current;
      const liveSettings = settingsRef.current;
      if (activeHighlighter?.hasPendingPlainText()) {
        terminal.write(activeHighlighter.flush(
          resolveSshKeywordHighlightColors(
            liveSettings.palette,
            appThemeIsDark(),
          ),
          liveSettings.keywordHighlighting,
        ));
      }
      if (keywordFlushTimerRef.current !== null) {
        window.clearTimeout(keywordFlushTimerRef.current);
        keywordFlushTimerRef.current = null;
      }
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      keywordHighlighterRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const options = terminal.options;
    // Lightweight terminal mocks used by lifecycle tests may omit mutable options.
    if (!options) return;
    options.cursorBlink = settings.cursorBlink;
    options.cursorStyle = settings.cursorStyle;
    options.fontFamily = settings.fontFamily;
    options.fontSize = settings.fontSize;
    options.lineHeight = settings.lineHeight;
    options.scrollback = settings.scrollback;
    options.theme = resolveSshTerminalTheme(settings.palette, isDarkTheme);
    try {
      fitAddonRef.current?.fit();
    } catch {
      // A hidden session is refitted when it becomes visible.
    }
  }, [isDarkTheme, settings]);

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
    const highlighter = keywordHighlighterRef.current;
    if (keywordFlushTimerRef.current !== null) {
      window.clearTimeout(keywordFlushTimerRef.current);
      keywordFlushTimerRef.current = null;
    }
    if (highlighter?.hasPendingPlainText()) {
      const previousSettings = settingsRef.current;
      terminal.write(highlighter.flush(
        resolveSshKeywordHighlightColors(
          previousSettings.palette,
          appThemeIsDark(),
        ),
        previousSettings.keywordHighlighting,
      ));
    }
    highlighter?.reset();
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
            proxyType: connection.proxyType,
            proxyHost: connection.proxyHost,
            proxyPort: connection.proxyPort,
            proxyUsername: connection.proxyUsername,
            proxyCredentialReference: connection.proxyCredentialReference,
          },
          (data) => {
            if (cancelled) return;
            const currentSettings = settingsRef.current;
            const activeHighlighter = keywordHighlighterRef.current;
            if (!activeHighlighter) {
              terminal.write(data);
              return;
            }

            if (keywordFlushTimerRef.current !== null) {
              window.clearTimeout(keywordFlushTimerRef.current);
              keywordFlushTimerRef.current = null;
            }
            const colors = resolveSshKeywordHighlightColors(
              currentSettings.palette,
              appThemeIsDark(),
            );
            const output = activeHighlighter.transform(
              data,
              colors,
              currentSettings.keywordHighlighting,
            );
            if (output) terminal.write(output);
            if (activeHighlighter.hasPendingPlainText()) {
              keywordFlushTimerRef.current = window.setTimeout(() => {
                keywordFlushTimerRef.current = null;
                if (cancelled) return;
                const liveSettings = settingsRef.current;
                const pendingOutput = activeHighlighter.flush(
                  resolveSshKeywordHighlightColors(
                    liveSettings.palette,
                    appThemeIsDark(),
                  ),
                  liveSettings.keywordHighlighting,
                  false,
                );
                if (pendingOutput) terminal.write(pendingOutput);
              }, KEYWORD_COALESCE_DELAY_MS);
            }
          },
          (event) => {
            if (cancelled) return;
            const activeHighlighter = keywordHighlighterRef.current;
            const liveSettings = settingsRef.current;
            if (isTerminalSessionEvent(event) && activeHighlighter?.hasPendingPlainText()) {
              if (keywordFlushTimerRef.current !== null) {
                window.clearTimeout(keywordFlushTimerRef.current);
                keywordFlushTimerRef.current = null;
              }
              terminal.write(activeHighlighter.flush(
                resolveSshKeywordHighlightColors(
                  liveSettings.palette,
                  appThemeIsDark(),
                ),
                liveSettings.keywordHighlighting,
              ));
            }
            onEventRef.current(event);
          },
        )
        .catch((error: unknown) => {
          if (cancelled) return;
          const code = startFailureCode(error);
          void sshApi.logStartFailure(code).catch(() => {});
          onEventRef.current({
            kind: 'state',
            sessionId,
            state: 'error',
            message: code,
          });
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(startupTimer);
      if (keywordFlushTimerRef.current !== null) {
        window.clearTimeout(keywordFlushTimerRef.current);
        keywordFlushTimerRef.current = null;
      }
      const activeHighlighter = keywordHighlighterRef.current;
      const liveSettings = settingsRef.current;
      if (activeHighlighter?.hasPendingPlainText()) {
        terminal.write(activeHighlighter.flush(
          resolveSshKeywordHighlightColors(
            liveSettings.palette,
            appThemeIsDark(),
          ),
          liveSettings.keywordHighlighting,
        ));
      }
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
      data-region="ssh-terminal-surface"
      className="flex h-full w-full flex-col px-2 pt-2 pb-3"
      style={{ backgroundColor: resolveSshTerminalTheme(settings.palette, isDarkTheme).background }}
    >
      <div
        ref={hostRef}
        data-region="ssh-terminal-host"
        className="min-h-0 w-full flex-1"
        aria-label={connection.name}
      />
    </div>
  );
}

/**
 * RDP Debug Logger — structured logging for RDP operations.
 *
 * Logs are:
 *   1. Printed to console with color-coded module tags
 *   2. Batched and forwarded to Rust backend → /tmp/nextdesk_rdp_debug.log
 *
 * Log level control:
 *   - Default: 'info' (hides debug spam like mouse events, canvas size)
 *   - Set window.__RDP_LOG_LEVEL = 'debug' in console to see everything
 *   - Set window.__RDP_LOG_MODULES = 'input,render' to filter by module
 *   - Dev-only internal technology names require VITE_NEXTDESK_INTERNAL_LOGS=true
 *
 * Usage:
 *   import { rdpLog } from '@/lib/rdp-logger';
 *   rdpLog.info('rdp', 'Session connected', { tabId, host });
 *   rdpLog.error('clipboard', 'FormatList failed', { error });
 */

import { invoke } from '@tauri-apps/api/core';
import { sanitizeDiagnosticText } from '@/lib/diagnostic-logs';

export type RdpLogModule =
  | 'app'          // application lifecycle and configuration
  | 'auth'         // device authorization and account state
  | 'cloud'        // cloud API, gateway discovery, binding health
  | 'route'        // cloud/direct route selection and fallback
  | 'rdp'          // connect / disconnect / reconnect / engine state
  | 'display'      // canvas / resolution / GFX
  | 'network'      // TCP / WebSocket / online state
  | 'clipboard'   // clipboard sync (CLIPRDR)
  | 'input'       // keyboard / mouse events
  | 'audio'       // RDPSND audio
  | 'file';       // file transfer (RDPDR)

export type RdpLogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  ts: string;
  level: RdpLogLevel;
  module: RdpLogModule;
  msg: string;
  data?: string;
}

const INTERNAL_DIAGNOSTICS_ENABLED =
  import.meta.env.DEV && import.meta.env.VITE_NEXTDESK_INTERNAL_LOGS === 'true';

// Level priority for filtering
const LEVEL_PRIORITY: Record<RdpLogLevel, number> = {
  debug: 0, info: 1, warn: 2, error: 3,
};

function createLogger() {
  const BATCH_INTERVAL = 500;
  const BATCH_SIZE = 20;
  const RING_SIZE = 5000;

  const ring: LogEntry[] = [];
  let batch: LogEntry[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let initialized = false;

  // Default minimum log level.
  // Production retains operational INFO events; high-frequency rendering and
  // input events stay DEBUG so they do not inflate routine diagnostics.
  // Override at runtime: window.__RDP_LOG_LEVEL = 'debug'
  const DEFAULT_MIN_LEVEL: RdpLogLevel = 'info';
  const DEFAULT_FILE_MIN_LEVEL: RdpLogLevel = import.meta.env.DEV ? 'debug' : 'info';

  // Module → console color mapping
  const MODULE_COLORS: Record<RdpLogModule, string> = {
    app:        '#90a4ae',
    auth:       '#26a69a',
    cloud:      '#42a5f5',
    route:      '#29b6f6',
    rdp:        '#4fc3f7',
    display:    '#ba68c8',
    network:    '#4dd0e1',
    clipboard:  '#81c784',
    input:      '#ffb74d',
    audio:      '#f06292',
    file:       '#aed581',
  };

  const LEVEL_METHODS = {
    debug: 'debug',
    info: 'log',
    warn: 'warn',
    error: 'error',
  } as const;

  function init() {
    if (initialized) return;
    initialized = true;
  }

  function doFlush() {
    if (batch.length === 0) return;
    const toSend = batch;
    batch = [];
    invoke('rdp_log_batch', { entries: toSend }).catch(() => {});
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      doFlush();
    }, BATCH_INTERVAL);
  }

  /** Check if a log should be printed to console */
  function shouldPrint(level: RdpLogLevel): boolean {
    const minLevel = (
      (window as any).__RDP_LOG_LEVEL || DEFAULT_MIN_LEVEL
    ) as RdpLogLevel;
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minLevel];
  }

  /** Check if a log should be persisted to disk. */
  function shouldPersist(level: RdpLogLevel): boolean {
    const minLevel = (
      (window as any).__RDP_LOG_FILE_LEVEL || DEFAULT_FILE_MIN_LEVEL
    ) as RdpLogLevel;
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minLevel];
  }

  /** Check if module is in the filter (if set) */
  function moduleAllowed(module: RdpLogModule): boolean {
    const filter = (window as any).__RDP_LOG_MODULES as string | undefined;
    if (!filter) return true;
    return filter.split(',').includes(module);
  }

  function setLevel(level: RdpLogLevel) {
    (window as any).__RDP_LOG_LEVEL = level;
  }

  function getLevel(): RdpLogLevel {
    return ((window as any).__RDP_LOG_LEVEL || DEFAULT_MIN_LEVEL) as RdpLogLevel;
  }

  function setModules(modules: RdpLogModule[]) {
    if (modules.length === 0) {
      delete (window as any).__RDP_LOG_MODULES;
      return;
    }
    (window as any).__RDP_LOG_MODULES = modules.join(',');
  }

  function getModules(): RdpLogModule[] {
    const filter = (window as any).__RDP_LOG_MODULES as string | undefined;
    if (!filter) return [];
    return filter
      .split(',')
      .filter(Boolean) as RdpLogModule[];
  }

  function log(
    level: RdpLogLevel,
    module: RdpLogModule,
    msg: string,
    data?: any,
  ) {
    const print = shouldPrint(level) && moduleAllowed(module);
    const persist = shouldPersist(level);
    const keepRing = import.meta.env.DEV || print || persist;
    if (!keepRing) return;

    init();

    const ts = new Date().toISOString();
    const publicMessage = INTERNAL_DIAGNOSTICS_ENABLED ? msg : sanitizeDiagnosticText(msg);
    const rawData = data !== undefined ? JSON.stringify(data) : undefined;
    const dataStr = rawData !== undefined && !INTERNAL_DIAGNOSTICS_ENABLED
      ? sanitizeDiagnosticText(rawData)
      : rawData;
    let consoleData = data;
    if (dataStr !== undefined && !INTERNAL_DIAGNOSTICS_ENABLED) {
      try {
        consoleData = JSON.parse(dataStr);
      } catch {
        consoleData = dataStr;
      }
    }
    const entry: LogEntry = { ts, level, module, msg: publicMessage, data: dataStr };

    // Always store in ring buffer (for debugging)
    if (ring.length >= RING_SIZE) ring.shift();
    ring.push(entry);

    // Console output — respect level + module filter
    if (print) {
      const color = MODULE_COLORS[module];
      const tag = `%c[${module}]`;
      const method = LEVEL_METHODS[level];
      if (data !== undefined) {
        (console as any)[method](
          tag, `color:${color};font-weight:bold`, publicMessage, consoleData,
        );
      } else {
        (console as any)[method](
          tag, `color:${color};font-weight:bold`, publicMessage,
        );
      }
    }

    if (persist) {
      batch.push(entry);
      if (batch.length >= BATCH_SIZE) {
        doFlush();
      } else {
        scheduleFlush();
      }
    }
  }

  return {
    debug: (module: RdpLogModule, msg: string, data?: any) =>
      log('debug', module, msg, data),
    info: (module: RdpLogModule, msg: string, data?: any) =>
      log('info', module, msg, data),
    warn: (module: RdpLogModule, msg: string, data?: any) =>
      log('warn', module, msg, data),
    error: (module: RdpLogModule, msg: string, data?: any) =>
      log('error', module, msg, data),
    flush: doFlush,
    setLevel,
    getLevel,
    setModules,
    getModules,
  };
}

/**
 * Singleton RDP logger.
 * Structured logging to console + file.
 * Default level: 'info' (hides debug noise).
 * To see all logs: window.__RDP_LOG_LEVEL = 'debug'
 * To filter modules: window.__RDP_LOG_MODULES = 'input,render'
 */
export const rdpLog = createLogger();

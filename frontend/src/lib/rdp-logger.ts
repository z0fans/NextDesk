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
 *
 * Usage:
 *   import { rdpLog } from '@/lib/rdp-logger';
 *   rdpLog.info('connection', 'Session connected', { tabId, host });
 *   rdpLog.error('clipboard', 'FormatList failed', { error });
 */

import { invoke } from '@tauri-apps/api/core';

export type RdpLogModule =
  | 'connection'  // connect / disconnect / reconnect
  | 'clipboard'   // clipboard sync (CLIPRDR)
  | 'input'       // keyboard / mouse events
  | 'render'      // canvas / resolution / GFX
  | 'audio'       // RDPSND audio
  | 'file'        // file transfer (RDPDR)
  | 'network'     // online / offline detection
  | 'proxy'       // WebSocket / RDCleanPath proxy
  | 'freerdp'     // FreeRDP sidecar renderer
  | 'native'      // native Rust RDP backend
  | 'wasm';       // IronRDP WASM internal logs

export type RdpLogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  ts: string;
  level: RdpLogLevel;
  module: RdpLogModule;
  msg: string;
  data?: string;
}

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

  // Default minimum log level — hides debug spam
  // Override at runtime: window.__RDP_LOG_LEVEL = 'debug'
  const DEFAULT_MIN_LEVEL: RdpLogLevel = 'info';

  // Module → console color mapping
  const MODULE_COLORS: Record<RdpLogModule, string> = {
    connection: '#4fc3f7',
    clipboard:  '#81c784',
    input:      '#ffb74d',
    render:     '#ba68c8',
    audio:      '#f06292',
    file:       '#aed581',
    network:    '#4dd0e1',
    proxy:      '#ffd54f',
    freerdp:    '#66bb6a',
    native:     '#ef5350',
    wasm:       '#90a4ae',
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
    invoke('rdp_log_clear').catch(() => {});
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

  /** Check if module is in the filter (if set) */
  function moduleAllowed(module: RdpLogModule): boolean {
    const filter = (window as any).__RDP_LOG_MODULES as string | undefined;
    if (!filter) return true;
    return filter.split(',').includes(module);
  }

  function log(
    level: RdpLogLevel,
    module: RdpLogModule,
    msg: string,
    data?: any,
  ) {
    init();

    const ts = new Date().toISOString();
    const dataStr = data !== undefined
      ? JSON.stringify(data)
      : undefined;
    const entry: LogEntry = { ts, level, module, msg, data: dataStr };

    // Always store in ring buffer (for debugging)
    if (ring.length >= RING_SIZE) ring.shift();
    ring.push(entry);

    // Console output — respect level + module filter
    if (shouldPrint(level) && moduleAllowed(module)) {
      const color = MODULE_COLORS[module];
      const tag = `%c[${module}]`;
      const method = LEVEL_METHODS[level];
      if (data !== undefined) {
        (console as any)[method](
          tag, `color:${color};font-weight:bold`, msg, data,
        );
      } else {
        (console as any)[method](
          tag, `color:${color};font-weight:bold`, msg,
        );
      }
    }

    // Always batch for file write (file gets everything)
    batch.push(entry);
    if (batch.length >= BATCH_SIZE) {
      doFlush();
    } else {
      scheduleFlush();
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

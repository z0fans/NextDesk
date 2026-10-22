export const SSH_TERMINAL_SETTINGS_STORAGE_KEY = 'nextdesk_ssh_terminal_settings_v1';

export const SSH_TERMINAL_PALETTES = [
  'follow_theme',
  'nextdesk',
  'nextdesk_light',
  'nextdesk_classic',
  'classic',
  'dracula',
  'solarized_dark',
  'gruvbox_dark',
  'nord',
  'tokyo_night',
  'solarized_light',
] as const;

export type SshTerminalPalette = typeof SSH_TERMINAL_PALETTES[number];
export type SshTerminalCursorStyle = 'block' | 'underline' | 'bar';

export interface SshTerminalSettings {
  palette: SshTerminalPalette;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: SshTerminalCursorStyle;
  cursorBlink: boolean;
  keywordHighlighting: boolean;
  scrollback: number;
}

export const DEFAULT_SSH_TERMINAL_SETTINGS: SshTerminalSettings = {
  palette: 'nextdesk',
  fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: 13,
  lineHeight: 1.15,
  cursorStyle: 'block',
  cursorBlink: true,
  keywordHighlighting: true,
  scrollback: 10_000,
};

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

export function sanitizeSshTerminalSettings(value: unknown): SshTerminalSettings {
  const candidate = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const persistedPalette = String(candidate.palette ?? '');
  // Versions before the PixShell-style selector stored the light theme as `light`.
  const migratedPalette = persistedPalette === 'light' ? 'nextdesk_light' : persistedPalette;
  const palette = SSH_TERMINAL_PALETTES.includes(migratedPalette as SshTerminalPalette)
    ? migratedPalette as SshTerminalPalette
    : DEFAULT_SSH_TERMINAL_SETTINGS.palette;
  const cursorStyle = ['block', 'underline', 'bar'].includes(String(candidate.cursorStyle))
    ? candidate.cursorStyle as SshTerminalCursorStyle
    : DEFAULT_SSH_TERMINAL_SETTINGS.cursorStyle;
  const fontFamily = typeof candidate.fontFamily === 'string' && candidate.fontFamily.trim()
    ? candidate.fontFamily.trim().slice(0, 256)
    : DEFAULT_SSH_TERMINAL_SETTINGS.fontFamily;
  return {
    palette,
    cursorStyle,
    fontFamily,
    fontSize: Math.round(boundedNumber(candidate.fontSize, DEFAULT_SSH_TERMINAL_SETTINGS.fontSize, 10, 24)),
    lineHeight: boundedNumber(candidate.lineHeight, DEFAULT_SSH_TERMINAL_SETTINGS.lineHeight, 1, 1.6),
    cursorBlink: typeof candidate.cursorBlink === 'boolean'
      ? candidate.cursorBlink
      : DEFAULT_SSH_TERMINAL_SETTINGS.cursorBlink,
    keywordHighlighting: typeof candidate.keywordHighlighting === 'boolean'
      ? candidate.keywordHighlighting
      : DEFAULT_SSH_TERMINAL_SETTINGS.keywordHighlighting,
    scrollback: Math.round(boundedNumber(candidate.scrollback, DEFAULT_SSH_TERMINAL_SETTINGS.scrollback, 1000, 100_000)),
  };
}

export function loadSshTerminalSettings(): SshTerminalSettings {
  try {
    const raw = localStorage.getItem(SSH_TERMINAL_SETTINGS_STORAGE_KEY);
    return sanitizeSshTerminalSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_SSH_TERMINAL_SETTINGS };
  }
}

export function saveSshTerminalSettings(settings: SshTerminalSettings): void {
  localStorage.setItem(
    SSH_TERMINAL_SETTINGS_STORAGE_KEY,
    JSON.stringify(sanitizeSshTerminalSettings(settings)),
  );
}

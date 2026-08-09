import type { ITheme } from '@xterm/xterm';

import type { SshTerminalPalette } from './ssh-terminal-settings-store';

const NEXTDESK_DARK: ITheme = {
  background: '#000000',
  foreground: '#f2f2f2',
  cursor: '#4d4d4d',
  cursorAccent: '#000000',
  selectionBackground: '#f2f2f280',
  black: '#2e2e2e',
  red: '#c93434',
  green: '#348e48',
  yellow: '#e09e00',
  blue: '#002bc7',
  magenta: '#e235ff',
  cyan: '#3fc1dd',
  white: '#d0cfcf',
  brightBlack: '#5b5b5b',
  brightRed: '#ff6767',
  brightGreen: '#31ff31',
  brightYellow: '#ffdca8',
  brightBlue: '#4465da',
  brightMagenta: '#ff5fc8',
  brightCyan: '#8debff',
  brightWhite: '#e6e6e6',
};

const NEXTDESK_CLASSIC_DARK: ITheme = {
  background: '#080d16',
  foreground: '#dbe7f3',
  cursor: '#67e8f9',
  cursorAccent: '#080d16',
  selectionBackground: '#164e63',
  black: '#111827',
  red: '#fb7185',
  green: '#34d399',
  yellow: '#facc15',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#dbe7f3',
  brightBlack: '#64748b',
  brightRed: '#fda4af',
  brightGreen: '#6ee7b7',
  brightYellow: '#fde047',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#f8fafc',
};

const NEXTDESK_LIGHT: ITheme = {
  background: '#f8fafc',
  foreground: '#0f172a',
  cursor: '#0891b2',
  cursorAccent: '#f8fafc',
  selectionBackground: '#bae6fd',
  black: '#0f172a',
  red: '#be123c',
  green: '#15803d',
  yellow: '#a16207',
  blue: '#1d4ed8',
  magenta: '#7e22ce',
  cyan: '#0e7490',
  white: '#e2e8f0',
  brightBlack: '#64748b',
  brightRed: '#e11d48',
  brightGreen: '#16a34a',
  brightYellow: '#ca8a04',
  brightBlue: '#2563eb',
  brightMagenta: '#9333ea',
  brightCyan: '#0891b2',
  brightWhite: '#ffffff',
};

const FIXED_TERMINAL_THEMES: Record<Exclude<SshTerminalPalette, 'follow_theme'>, ITheme> = {
  nextdesk: NEXTDESK_DARK,
  nextdesk_classic: NEXTDESK_CLASSIC_DARK,
  classic: {
    background: '#000000', foreground: '#e5e5e5', cursor: '#ffffff', cursorAccent: '#000000', selectionBackground: '#404040',
    black: '#000000', red: '#cc0000', green: '#22c55e', yellow: '#c4a000', blue: '#3465a4', magenta: '#75507b', cyan: '#06989a', white: '#d3d7cf',
    brightBlack: '#737373', brightRed: '#ef2929', brightGreen: '#86efac', brightYellow: '#fce94f', brightBlue: '#729fcf', brightMagenta: '#ad7fa8', brightCyan: '#67e8f9', brightWhite: '#ffffff',
  },
  dracula: {
    background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36', selectionBackground: '#44475a',
    black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
  },
  solarized_dark: {
    background: '#002b36', foreground: '#839496', cursor: '#93a1a1', cursorAccent: '#002b36', selectionBackground: '#075466',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  },
  gruvbox_dark: {
    background: '#282828', foreground: '#ebdbb2', cursor: '#fabd2f', cursorAccent: '#282828', selectionBackground: '#504945',
    black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
    brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
  },
  nord: {
    background: '#2e3440', foreground: '#d8dee9', cursor: '#88c0d0', cursorAccent: '#2e3440', selectionBackground: '#434c5e',
    black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
    brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
  },
  tokyo_night: {
    background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', cursorAccent: '#1a1b26', selectionBackground: '#33467c',
    black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
    brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5',
  },
  nextdesk_light: NEXTDESK_LIGHT,
  solarized_light: {
    background: '#fdf6e3', foreground: '#657b83', cursor: '#586e75', cursorAccent: '#fdf6e3', selectionBackground: '#eee8d5',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  },
};

export function resolveSshTerminalTheme(
  palette: SshTerminalPalette,
  appThemeIsDark: boolean,
): ITheme {
  if (palette === 'follow_theme') {
    return appThemeIsDark ? NEXTDESK_DARK : NEXTDESK_LIGHT;
  }
  return FIXED_TERMINAL_THEMES[palette];
}

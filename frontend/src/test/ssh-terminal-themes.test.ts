import { describe, expect, it } from 'vitest';

import { resolveSshTerminalTheme } from '@/ssh/ssh-terminal-themes';

describe('SSH terminal themes', () => {
  it('resolves the built-in follow-theme palette from the active app theme', () => {
    const dark = resolveSshTerminalTheme('follow_theme', true);
    const light = resolveSshTerminalTheme('follow_theme', false);

    expect(dark.background).toBe('#000000');
    expect(light.background).toBe('#f8fafc');
    expect(dark.background).not.toBe(light.background);
  });

  it('keeps fixed palettes independent from the active app theme', () => {
    const inDarkApp = resolveSshTerminalTheme('nextdesk', true);
    const inLightApp = resolveSshTerminalTheme('nextdesk', false);

    expect(inDarkApp).toBe(inLightApp);
    expect(inDarkApp).toMatchObject({
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
    });
  });

  it('keeps the previous NextDesk dark palette available as NextDesk Classic', () => {
    expect(resolveSshTerminalTheme('nextdesk_classic', true)).toMatchObject({
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
    });
  });
});

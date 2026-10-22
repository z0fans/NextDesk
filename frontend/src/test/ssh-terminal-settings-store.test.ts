import { beforeEach, describe, expect, it } from 'vitest';

import {
  SSH_TERMINAL_SETTINGS_STORAGE_KEY,
  loadSshTerminalSettings,
  saveSshTerminalSettings,
} from '@/ssh/ssh-terminal-settings-store';

describe('SSH terminal settings store', () => {
  beforeEach(() => localStorage.clear());

  it('persists supported terminal appearance settings', () => {
    saveSshTerminalSettings({
      palette: 'solarized_dark',
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 15,
      lineHeight: 1.25,
      cursorStyle: 'bar',
      cursorBlink: false,
      keywordHighlighting: false,
      scrollback: 25_000,
    });

    expect(loadSshTerminalSettings()).toEqual({
      palette: 'solarized_dark',
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 15,
      lineHeight: 1.25,
      cursorStyle: 'bar',
      cursorBlink: false,
      keywordHighlighting: false,
      scrollback: 25_000,
    });
  });

  it('bounds malformed persisted values', () => {
    localStorage.setItem(SSH_TERMINAL_SETTINGS_STORAGE_KEY, JSON.stringify({
      palette: 'invalid',
      fontSize: 99,
      lineHeight: -1,
      scrollback: 1,
    }));

    const settings = loadSshTerminalSettings();
    expect(settings.palette).toBe('nextdesk');
    expect(settings.fontSize).toBe(24);
    expect(settings.lineHeight).toBe(1);
    expect(settings.scrollback).toBe(1000);
    expect(settings.keywordHighlighting).toBe(true);
  });

  it('migrates the legacy light palette without changing its appearance family', () => {
    localStorage.setItem(SSH_TERMINAL_SETTINGS_STORAGE_KEY, JSON.stringify({
      palette: 'light',
    }));

    expect(loadSshTerminalSettings().palette).toBe('nextdesk_light');
  });
});

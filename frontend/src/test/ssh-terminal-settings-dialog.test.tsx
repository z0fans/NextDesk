import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { SshTerminalSettingsDialog } from '@/ssh/SshTerminalSettingsDialog';
import { DEFAULT_SSH_TERMINAL_SETTINGS } from '@/ssh/ssh-terminal-settings-store';

describe('SSH terminal settings dialog', () => {
  it('groups the follow-theme and NextDesk palettes before third-party palettes', () => {
    render(
      <SshTerminalSettingsDialog
        open
        settings={{ ...DEFAULT_SSH_TERMINAL_SETTINGS }}
        onChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const paletteSelect = screen.getByRole('combobox', {
      name: 'sshTerminalPalette',
    });
    const options = Array.from(paletteSelect.querySelectorAll('option'));
    expect(options.slice(0, 4).map((option) => option.textContent)).toEqual([
      'sshTerminalPaletteFollowTheme',
      'sshTerminalPaletteNextDesk',
      'sshTerminalPaletteNextDeskLight',
      'sshTerminalPaletteNextDeskClassic',
    ]);
    expect(options).toHaveLength(11);
    expect(paletteSelect).toHaveValue('nextdesk');
  });

  it('selects a terminal font preset and preserves custom font families', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <SshTerminalSettingsDialog
        open
        settings={{ ...DEFAULT_SSH_TERMINAL_SETTINGS }}
        onChange={onChange}
        onClose={vi.fn()}
      />,
    );

    const fontSelect = screen.getByRole('combobox', {
      name: 'sshTerminalFontFamily',
    });
    fireEvent.change(fontSelect, {
      target: { value: 'JetBrains Mono, monospace' },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_SSH_TERMINAL_SETTINGS,
      fontFamily: 'JetBrains Mono, monospace',
    });

    rerender(
      <SshTerminalSettingsDialog
        open
        settings={{
          ...DEFAULT_SSH_TERMINAL_SETTINGS,
          fontFamily: 'My Local Mono, monospace',
        }}
        onChange={onChange}
        onClose={vi.fn()}
      />,
    );

    expect(fontSelect).toHaveValue('__custom__');
    const customFont = screen.getByRole('textbox', {
      name: 'sshTerminalFontCustom',
    });
    expect(customFont).toHaveValue('My Local Mono, monospace');
    fireEvent.change(customFont, {
      target: { value: 'Another Mono, monospace' },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_SSH_TERMINAL_SETTINGS,
      fontFamily: 'Another Mono, monospace',
    });
  });

  it('lets users toggle Termius-style keyword highlighting', () => {
    const onChange = vi.fn();
    render(
      <SshTerminalSettingsDialog
        open
        settings={{ ...DEFAULT_SSH_TERMINAL_SETTINGS }}
        onChange={onChange}
        onClose={vi.fn()}
      />,
    );

    const checkbox = screen.getByRole('checkbox', {
      name: 'sshTerminalKeywordHighlighting',
    });
    expect(checkbox).toBeChecked();

    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_SSH_TERMINAL_SETTINGS,
      keywordHighlighting: false,
    });
  });
});

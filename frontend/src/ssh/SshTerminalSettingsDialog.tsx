import { useState } from 'react';
import { RotateCcw, Settings2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/i18n/useTranslation';
import {
  DEFAULT_SSH_TERMINAL_SETTINGS,
  type SshTerminalSettings,
} from './ssh-terminal-settings-store';

interface SshTerminalSettingsDialogProps {
  open: boolean;
  settings: SshTerminalSettings;
  onChange: (settings: SshTerminalSettings) => void;
  onClose: () => void;
}

const CUSTOM_FONT_FAMILY = '__custom__';

const TERMINAL_PALETTE_OPTIONS = [
  { value: 'follow_theme', label: 'sshTerminalPaletteFollowTheme' },
  { value: 'nextdesk', label: 'sshTerminalPaletteNextDesk' },
  { value: 'nextdesk_light', label: 'sshTerminalPaletteNextDeskLight' },
  { value: 'nextdesk_classic', label: 'sshTerminalPaletteNextDeskClassic' },
  { value: 'classic', label: 'sshTerminalPaletteClassic' },
  { value: 'dracula', label: 'sshTerminalPaletteDracula' },
  { value: 'solarized_dark', label: 'sshTerminalPaletteSolarizedDark' },
  { value: 'gruvbox_dark', label: 'sshTerminalPaletteGruvboxDark' },
  { value: 'nord', label: 'sshTerminalPaletteNord' },
  { value: 'tokyo_night', label: 'sshTerminalPaletteTokyoNight' },
  { value: 'solarized_light', label: 'sshTerminalPaletteSolarizedLight' },
] as const satisfies ReadonlyArray<{
  value: SshTerminalSettings['palette'];
  label: string;
}>;

const FONT_FAMILY_PRESETS = [
  {
    value: DEFAULT_SSH_TERMINAL_SETTINGS.fontFamily,
    label: 'sshTerminalFontSystem',
  },
  {
    value: 'SFMono-Regular, SF Mono, Menlo, monospace',
    label: 'sshTerminalFontSfMono',
  },
  {
    value: 'Menlo, Monaco, monospace',
    label: 'sshTerminalFontMenlo',
  },
  {
    value: 'JetBrains Mono, monospace',
    label: 'sshTerminalFontJetBrainsMono',
  },
  {
    value: 'Fira Code, monospace',
    label: 'sshTerminalFontFiraCode',
  },
  {
    value: 'Cascadia Mono, Consolas, monospace',
    label: 'sshTerminalFontCascadiaMono',
  },
  {
    value: 'Consolas, Courier New, monospace',
    label: 'sshTerminalFontConsolas',
  },
] as const;

function fontFamilySelection(fontFamily: string): string {
  return FONT_FAMILY_PRESETS.some((preset) => preset.value === fontFamily)
    ? fontFamily
    : CUSTOM_FONT_FAMILY;
}

export function SshTerminalSettingsDialog({
  open,
  settings,
  onChange,
  onClose,
}: SshTerminalSettingsDialogProps) {
  const { t } = useTranslation();
  const [forceCustomFont, setForceCustomFont] = useState(false);
  const detectedFontSelection = fontFamilySelection(settings.fontFamily);
  const fontSelection = forceCustomFont
    ? CUSTOM_FONT_FAMILY
    : detectedFontSelection;

  if (!open) return null;

  const update = <Key extends keyof SshTerminalSettings>(
    key: Key,
    value: SshTerminalSettings[Key],
  ) => onChange({ ...settings, [key]: value });

  const closeSettings = () => {
    setForceCustomFont(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <section role="dialog" aria-modal="true" aria-labelledby="ssh-terminal-settings-title" className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
          <div className="flex items-start gap-3">
            <div className="rounded-lg border border-cyan-500/25 bg-cyan-500/10 p-2 text-cyan-600 dark:text-cyan-400">
              <Settings2 className="h-5 w-5" />
            </div>
            <div>
              <h2 id="ssh-terminal-settings-title" className="text-base font-semibold text-foreground">{t('sshTerminalSettings')}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{t('sshTerminalSettingsHint')}</p>
            </div>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={closeSettings} aria-label={t('sshClose')}>
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div className="grid gap-4 px-6 py-5 sm:grid-cols-2">
          <label htmlFor="ssh-terminal-palette" className="space-y-1.5 sm:col-span-2">
            <span className="block text-xs font-medium text-muted-foreground">{t('sshTerminalPalette')}</span>
            <select
              id="ssh-terminal-palette"
              value={settings.palette}
              onChange={(event) => update('palette', event.target.value as SshTerminalSettings['palette'])}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/50"
            >
              {TERMINAL_PALETTE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.label)}
                </option>
              ))}
            </select>
          </label>
          <div className="space-y-1.5 sm:col-span-2">
            <label
              htmlFor="ssh-terminal-font-family"
              className="block text-xs font-medium text-muted-foreground"
            >
              {t('sshTerminalFontFamily')}
            </label>
            <select
              id="ssh-terminal-font-family"
              aria-describedby="ssh-terminal-font-hint"
              value={fontSelection}
              onChange={(event) => {
                const value = event.target.value;
                const custom = value === CUSTOM_FONT_FAMILY;
                setForceCustomFont(custom);
                if (!custom) update('fontFamily', value);
              }}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/50"
            >
              {FONT_FAMILY_PRESETS.map((preset) => (
                <option key={preset.value} value={preset.value}>
                  {t(preset.label)}
                </option>
              ))}
              <option value={CUSTOM_FONT_FAMILY}>{t('sshTerminalFontCustom')}</option>
            </select>
            {fontSelection === CUSTOM_FONT_FAMILY && (
              <Input
                value={settings.fontFamily}
                onChange={(event) => update('fontFamily', event.target.value.slice(0, 256))}
                placeholder={t('sshTerminalFontCustomPlaceholder')}
                aria-label={t('sshTerminalFontCustom')}
                spellCheck={false}
              />
            )}
            <span
              id="ssh-terminal-font-hint"
              className="block text-[10px] leading-4 text-muted-foreground"
            >
              {t('sshTerminalFontHint')}
            </span>
          </div>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('sshTerminalFontSize')}</span>
            <Input type="number" min={10} max={24} value={settings.fontSize} onChange={(event) => update('fontSize', Math.min(24, Math.max(10, Number(event.target.value) || 13)))} />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('sshTerminalLineHeight')}</span>
            <Input type="number" min={1} max={1.6} step={0.05} value={settings.lineHeight} onChange={(event) => update('lineHeight', Math.min(1.6, Math.max(1, Number(event.target.value) || 1.15)))} />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('sshTerminalCursor')}</span>
            <select value={settings.cursorStyle} onChange={(event) => update('cursorStyle', event.target.value as SshTerminalSettings['cursorStyle'])} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/50">
              <option value="block">{t('sshTerminalCursorBlock')}</option>
              <option value="underline">{t('sshTerminalCursorUnderline')}</option>
              <option value="bar">{t('sshTerminalCursorBar')}</option>
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{t('sshTerminalScrollback')}</span>
            <Input type="number" min={1000} max={100000} step={1000} value={settings.scrollback} onChange={(event) => update('scrollback', Math.min(100_000, Math.max(1000, Number(event.target.value) || 10_000)))} />
          </label>
          <label className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-foreground sm:col-span-2">
            <input type="checkbox" checked={settings.cursorBlink} onChange={(event) => update('cursorBlink', event.target.checked)} />
            {t('sshTerminalCursorBlink')}
          </label>
          <label className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-sm text-foreground sm:col-span-2">
            <input
              type="checkbox"
              checked={settings.keywordHighlighting}
              onChange={(event) => update('keywordHighlighting', event.target.checked)}
              aria-label={t('sshTerminalKeywordHighlighting')}
              className="mt-0.5"
            />
            <span>
              <span className="block">{t('sshTerminalKeywordHighlighting')}</span>
              <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">
                {t('sshTerminalKeywordHighlightingHint')}
              </span>
            </span>
          </label>
        </div>

        <footer className="flex justify-between border-t border-border bg-muted/20 px-6 py-4">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setForceCustomFont(false);
              onChange({ ...DEFAULT_SSH_TERMINAL_SETTINGS });
            }}
          >
            <RotateCcw className="h-4 w-4" />
            {t('sshTerminalReset')}
          </Button>
          <Button type="button" onClick={closeSettings}>{t('sshSave')}</Button>
        </footer>
      </section>
    </div>
  );
}

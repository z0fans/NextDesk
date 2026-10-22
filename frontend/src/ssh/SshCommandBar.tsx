import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTranslation } from '@/i18n/useTranslation';

interface SshCommandBarProps {
  connected: boolean;
  dockOpen: boolean;
  history: string[];
  onSend: (command: string) => Promise<void>;
  onComplete?: (command: string) => Promise<string[]>;
  onToggleDock: () => void;
}

export function SshCommandBar({
  connected,
  dockOpen,
  history,
  onSend,
  onComplete,
  onToggleDock,
}: SshCommandBarProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [sending, setSending] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const [completions, setCompletions] = useState<string[]>([]);
  const [completionIndex, setCompletionIndex] = useState(-1);
  const [completing, setCompleting] = useState(false);

  const submit = async () => {
    const command = value.trim();
    if (!connected || sending || !command) return;
    setSending(true);
    setSendFailed(false);
    try {
      await onSend(command);
      setValue('');
      setHistoryIndex(-1);
      setHistoryOpen(false);
      setCompletions([]);
      setCompletionIndex(-1);
    } catch {
      setSendFailed(true);
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="relative flex h-11 shrink-0 items-center gap-2 border-t border-border bg-card px-3"
      data-region="ssh-command-bar"
    >
      <span className="shrink-0 text-xs font-medium text-muted-foreground">
        {t('sshCommandLabel')}
      </span>
      <Input
        className="h-7 min-w-16 flex-1 bg-background text-xs"
        value={value}
        disabled={!connected || sending}
        aria-label={t('sshCommandInputLabel')}
        aria-invalid={sendFailed || undefined}
        placeholder={t('sshCommandPlaceholder')}
        onChange={(event) => {
          setValue(event.target.value);
          setHistoryIndex(-1);
          setSendFailed(false);
          setCompletions([]);
          setCompletionIndex(-1);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void submit();
            return;
          }
          if (event.key === 'ArrowUp' && history.length > 0) {
            event.preventDefault();
            const nextIndex = Math.min(history.length - 1, historyIndex + 1);
            setHistoryIndex(nextIndex);
            setValue(history[nextIndex]);
          }
          if (event.key === 'ArrowDown' && historyIndex >= 0) {
            event.preventDefault();
            const nextIndex = historyIndex - 1;
            setHistoryIndex(nextIndex);
            setValue(nextIndex >= 0 ? history[nextIndex] : '');
          }
          if (event.key === 'Tab' && onComplete && value.trim()) {
            event.preventDefault();
            if (completions.length > 0 && completions.includes(value)) {
              const nextIndex = (completionIndex + 1) % completions.length;
              setCompletionIndex(nextIndex);
              setValue(completions[nextIndex]);
              return;
            }
            setCompleting(true);
            void onComplete(value)
              .then((options) => {
                setCompletions(options);
                setCompletionIndex(options.length > 0 ? 0 : -1);
                if (options[0]) setValue(options[0]);
              })
              .finally(() => setCompleting(false));
          }
        }}
      />
      <div className="relative shrink-0">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-7 px-3 text-xs"
          disabled={!connected || history.length === 0}
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen((open) => !open)}
        >
          {t('sshCommandHistory')}
        </Button>
        {historyOpen && history.length > 0 && (
          <div
            role="menu"
            className="absolute bottom-full right-0 z-30 mb-2 max-h-48 w-72 overflow-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl"
          >
            {history.map((command, index) => (
              <button
                key={`${command}-${index}`}
                type="button"
                role="menuitem"
                className="block w-full truncate rounded px-2 py-1.5 text-left font-mono text-xs hover:bg-accent hover:text-accent-foreground"
                title={command}
                onClick={() => {
                  setValue(command);
                  setHistoryIndex(index);
                  setHistoryOpen(false);
                }}
              >
                {command}
              </button>
            ))}
          </div>
        )}
      </div>
      <Button
        type="button"
        size="sm"
        className="h-7 bg-blue-600 px-3 text-xs text-white hover:bg-blue-500"
        disabled={!connected || sending || completing || !value.trim()}
        onClick={() => void submit()}
      >
        {t('sshCommandSend')}
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="secondary"
        className="h-7 w-7"
        disabled={!connected}
        aria-label={dockOpen ? t('sftpCloseFiles') : t('sftpOpenFiles')}
        onClick={onToggleDock}
      >
        {dockOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
      </Button>
      {sendFailed && <span role="alert" className="sr-only">{t('sshCommandSendFailed')}</span>}
    </div>
  );
}

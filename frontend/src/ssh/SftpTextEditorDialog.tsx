import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n/useTranslation";
import { cn } from "@/lib/utils";
import type { SftpEntry } from "./types";

interface SftpTextEditorDialogProps {
  entry: SftpEntry;
  value: string;
  busy: boolean;
  error?: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onClose: () => void;
}

interface CursorPosition {
  line: number;
  column: number;
}

function cursorPosition(value: string, offset: number): CursorPosition {
  const beforeCursor = value.slice(0, Math.max(0, offset));
  const lines = beforeCursor.split("\n");
  return {
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
  };
}

export function SftpTextEditorDialog({
  entry,
  value,
  busy,
  error,
  onChange,
  onSave,
  onClose,
}: SftpTextEditorDialogProps) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLPreElement>(null);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [showLineNumbers, setShowLineNumbers] = useState(true);
  const [wordWrap, setWordWrap] = useState(false);
  const [cursor, setCursor] = useState<CursorPosition>({ line: 1, column: 1 });

  const lineCount = useMemo(() => Math.max(1, value.split("\n").length), [value]);
  const lineNumbers = useMemo(
    () => Array.from({ length: lineCount }, (_, index) => index + 1).join("\n"),
    [lineCount],
  );

  const updateCursor = useCallback(() => {
    const offset = textareaRef.current?.selectionStart ?? 0;
    setCursor(cursorPosition(value, offset));
  }, [value]);

  const selectMatch = useCallback(
    (direction: "previous" | "next") => {
      const textarea = textareaRef.current;
      if (!textarea || !findText) return;
      const selectionStart = textarea.selectionStart;
      const selectionEnd = textarea.selectionEnd;
      let match = -1;
      if (direction === "next") {
        match = value.indexOf(findText, selectionEnd);
        if (match < 0) match = value.indexOf(findText);
      } else {
        match = value.lastIndexOf(findText, Math.max(0, selectionStart - 1));
        if (match < 0) match = value.lastIndexOf(findText);
      }
      if (match < 0) return;
      textarea.focus();
      textarea.setSelectionRange(match, match + findText.length);
      setCursor(cursorPosition(value, match));
    },
    [findText, value],
  );

  const replaceSelection = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea || !findText) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    if (value.slice(start, end) !== findText) {
      selectMatch("next");
      return;
    }
    const nextValue = `${value.slice(0, start)}${replaceText}${value.slice(end)}`;
    const nextOffset = start + replaceText.length;
    onChange(nextValue);
    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(nextOffset, nextOffset);
      setCursor(cursorPosition(nextValue, nextOffset));
    });
  }, [findText, onChange, replaceText, selectMatch, value]);

  const replaceAll = useCallback(() => {
    if (!findText || !value.includes(findText)) return;
    const nextValue = value.split(findText).join(replaceText);
    onChange(nextValue);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(0, 0);
      setCursor({ line: 1, column: 1 });
    });
  }, [findText, onChange, replaceText, value]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!busy) onSave();
      } else if (event.key === "Escape" && !busy) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose, onSave]);

  return createPortal(
    <div className="fixed inset-0 z-[140] flex items-center justify-center bg-slate-950/70 p-6 backdrop-blur-sm">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="sftp-text-editor-title"
        className="flex h-[min(84vh,1120px)] min-h-[520px] w-[min(88vw,1640px)] flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl"
      >
        <header className="flex shrink-0 items-center justify-between gap-5 px-7 pb-4 pt-6">
          <div className="flex min-w-0 items-center gap-4">
            <h2 id="sftp-text-editor-title" className="truncate text-xl font-semibold tracking-tight">
              {entry.name}
            </h2>
            <span className="shrink-0 rounded-full bg-blue-500/15 px-3 py-1 text-xs font-medium text-blue-600 dark:text-blue-300">
              {t("sftpEditorPlainText")}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <Button
              type="button"
              className="h-10 bg-blue-600 px-6 text-white hover:bg-blue-500"
              disabled={busy}
              onClick={onSave}
            >
              {t("sftpSave")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="h-10 px-6"
              disabled={busy}
              onClick={onClose}
            >
              {t("sftpClose")}
            </Button>
          </div>
        </header>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-7 pb-4">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <input
              value={findText}
              onChange={(event) => setFindText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  selectMatch(event.shiftKey ? "previous" : "next");
                }
              }}
              placeholder={t("sftpEditorFind")}
              aria-label={t("sftpEditorFind")}
              className="h-9 w-40 rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500/30 xl:w-56"
            />
            <Button
              type="button"
              size="icon-sm"
              variant="secondary"
              onClick={() => selectMatch("previous")}
              aria-label={t("sftpEditorPreviousMatch")}
            >
              <ChevronUp className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="secondary"
              onClick={() => selectMatch("next")}
              aria-label={t("sftpEditorNextMatch")}
            >
              <ChevronDown className="h-4 w-4" />
            </Button>
            <input
              value={replaceText}
              onChange={(event) => setReplaceText(event.target.value)}
              placeholder={t("sftpEditorReplaceWith")}
              aria-label={t("sftpEditorReplaceWith")}
              className="ml-1 h-9 w-40 rounded-md border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500/30 xl:w-56"
            />
            <Button type="button" size="sm" variant="secondary" onClick={replaceSelection}>
              {t("sftpEditorReplace")}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={replaceAll}>
              {t("sftpEditorReplaceAll")}
            </Button>
          </div>
          <div className="flex shrink-0 items-center gap-5 text-sm">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={showLineNumbers}
                onChange={(event) => setShowLineNumbers(event.target.checked)}
                className="h-4 w-4 accent-blue-600"
              />
              {t("sftpEditorLineNumbers")}
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={wordWrap}
                onChange={(event) => setWordWrap(event.target.checked)}
                className="h-4 w-4 accent-blue-600"
              />
              {t("sftpEditorWordWrap")}
            </label>
          </div>
        </div>

        <div className="mx-6 flex min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-background shadow-inner">
          {showLineNumbers && (
            <pre
              ref={gutterRef}
              data-region="sftp-editor-line-numbers"
              aria-hidden="true"
              className="h-full min-w-16 select-none overflow-hidden border-r border-border bg-muted/35 px-3 py-3 text-right font-mono text-sm leading-6 text-muted-foreground"
            >
              {lineNumbers}
            </pre>
          )}
          <textarea
            ref={textareaRef}
            data-region="sftp-editor-content"
            autoFocus
            spellCheck={false}
            wrap={wordWrap ? "soft" : "off"}
            value={value}
            aria-label={t("sftpTextFileContent")}
            className={cn(
              "min-h-0 min-w-0 flex-1 resize-none border-0 bg-background px-5 py-3 font-mono text-sm leading-6 text-foreground outline-none",
              wordWrap ? "overflow-y-auto whitespace-pre-wrap" : "overflow-auto whitespace-pre",
            )}
            onScroll={(event) => {
              if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop;
            }}
            onChange={(event) => {
              const nextValue = event.target.value;
              const nextOffset = event.currentTarget.selectionStart;
              onChange(nextValue);
              setCursor(cursorPosition(nextValue, nextOffset));
            }}
            onClick={updateCursor}
            onKeyUp={updateCursor}
            onSelect={updateCursor}
          />
        </div>

        <footer className="flex h-12 shrink-0 items-center gap-7 px-7 text-xs text-muted-foreground">
          <span>
            {t("sftpEditorLineColumn", { line: cursor.line, column: cursor.column })}
          </span>
          <span>{t("sftpEditorCharacterCount", { count: Array.from(value).length })}</span>
          <span>{t("sftpEditorEncoding")}</span>
          {error && <span role="alert" className="ml-auto text-destructive">{error}</span>}
        </footer>
      </section>
    </div>,
    document.body,
  );
}

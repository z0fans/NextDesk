import type { SshTerminalPalette } from './ssh-terminal-settings-store';

export interface SshKeywordHighlightColors {
  error: string;
  warning: string;
  ok: string;
  info: string;
  debug: string;
  address: string;
}

const TERMIUS_DARK_HIGHLIGHT_COLORS: SshKeywordHighlightColors = {
  error: '#F25E61',
  warning: '#FFCB00',
  ok: '#81D254',
  info: '#2091F6',
  debug: '#8686FF',
  address: '#D2549A',
};

const TERMIUS_LIGHT_HIGHLIGHT_COLORS: SshKeywordHighlightColors = {
  error: '#FF000F',
  warning: '#E36D00',
  ok: '#009618',
  info: '#0029FF',
  debug: '#9E00E9',
  address: '#EE0064',
};

const LIGHT_PALETTES = new Set<SshTerminalPalette>([
  'nextdesk_light',
  'solarized_light',
]);

const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)';
const IPV4_PATTERN = new RegExp(
  `(?<![A-Za-z0-9_.])${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}(?![A-Za-z0-9_.])`,
  'g',
);
const MAC_PATTERN = /(?<![A-Za-z0-9_:])(?:[\da-f]{2}:){5}[\da-f]{2}(?![A-Za-z0-9_:])/gi;
const IPV6_CANDIDATE_PATTERN = /[\da-f:.]+/gi;
const HIGHLIGHT_KEYWORDS = ['error', 'warning', 'ok', 'info', 'debug'] as const;
const KEYWORD_PATTERN = new RegExp(`\\b(?:${HIGHLIGHT_KEYWORDS.join('|')})\\b`, 'gi');
const TRAILING_TOKEN_PATTERN = /[A-Za-z0-9_:.]+$/;
const MAX_PENDING_TOKEN_LENGTH = 64;
const MAX_TRACKED_CSI_LENGTH = 256;

interface HighlightMatch {
  start: number;
  end: number;
  color: string;
}

type EscapeState = 'normal' | 'escape' | 'csi' | 'string';

export function resolveSshKeywordHighlightColors(
  palette: SshTerminalPalette,
  appThemeIsDark: boolean,
): SshKeywordHighlightColors {
  const useLightColors = palette === 'follow_theme'
    ? !appThemeIsDark
    : LIGHT_PALETTES.has(palette);
  return useLightColors
    ? TERMIUS_LIGHT_HIGHLIGHT_COLORS
    : TERMIUS_DARK_HIGHLIGHT_COLORS;
}

function trueColorSequence(color: string): string {
  const channels = color.match(/[\da-f]{2}/gi)?.map((channel) => Number.parseInt(channel, 16));
  if (!channels || channels.length !== 3) return '';
  return `\x1b[38;2;${channels.join(';')}m`;
}

function retainedTrailingLength(token: string): number {
  const normalized = token.toLowerCase();
  const mayBecomeKeyword = HIGHLIGHT_KEYWORDS.some((keyword) => keyword.startsWith(normalized));
  const mayBecomeAddress = /^[\da-f:.]+$/i.test(token);
  return mayBecomeKeyword || mayBecomeAddress
    ? Math.min(token.length, MAX_PENDING_TOKEN_LENGTH)
    : Math.min(token.length, 1);
}

function isValidIpv4(value: string): boolean {
  const octets = value.split('.');
  return octets.length === 4 && octets.every((octet) => (
    /^\d{1,3}$/.test(octet)
    && Number.parseInt(octet, 10) <= 255
    && (octet === '0' || !octet.startsWith('0'))
  ));
}

function isValidIpv6(value: string): boolean {
  if (!value.includes(':') || value.includes(':::')) return false;
  if ((value.startsWith(':') && !value.startsWith('::'))
    || (value.endsWith(':') && !value.endsWith('::'))) return false;

  let normalized = value;
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    if (lastColon < 0 || !isValidIpv4(value.slice(lastColon + 1))) return false;
    // An embedded IPv4 address occupies the final two 16-bit IPv6 groups.
    normalized = `${value.slice(0, lastColon)}:0:0`;
  }

  const compressionParts = normalized.split('::');
  if (compressionParts.length > 2) return false;

  const groups = normalized.split(':').filter(Boolean);
  if (!groups.every((group) => /^[\da-f]{1,4}$/i.test(group))) return false;
  return compressionParts.length === 2
    ? groups.length < 8
    : groups.length === 8;
}

function addPatternMatches(
  text: string,
  pattern: RegExp,
  color: string,
  matches: HighlightMatch[],
): void {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue;
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
      color,
    });
  }
}

function highlightPlainText(text: string, colors: SshKeywordHighlightColors): string {
  if (!text) return text;
  const matches: HighlightMatch[] = [];

  addPatternMatches(text, IPV4_PATTERN, colors.address, matches);
  addPatternMatches(text, MAC_PATTERN, colors.address, matches);

  IPV6_CANDIDATE_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(IPV6_CANDIDATE_PATTERN)) {
    if (match.index === undefined) continue;
    const leadingPunctuation = match[0].match(/^\.+/)?.[0].length ?? 0;
    const candidate = match[0].slice(leadingPunctuation).replace(/\.+$/, '');
    if (!candidate || !isValidIpv6(candidate)) continue;
    const start = match.index + leadingPunctuation;
    const end = start + candidate.length;
    const before = text[start - 1];
    const after = text[end];
    if ((before && /[A-Za-z0-9_]/.test(before))
      || (after && /[A-Za-z0-9_]/.test(after))) continue;
    matches.push({
      start,
      end,
      color: colors.address,
    });
  }

  KEYWORD_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(KEYWORD_PATTERN)) {
    if (match.index === undefined) continue;
    const color = colors[match[0].toLowerCase() as keyof Omit<SshKeywordHighlightColors, 'address'>];
    matches.push({ start: match.index, end: match.index + match[0].length, color });
  }

  if (matches.length === 0) return text;
  matches.sort((left, right) => left.start - right.start || right.end - left.end);

  let result = '';
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    result += text.slice(cursor, match.start);
    result += `${trueColorSequence(match.color)}${text.slice(match.start, match.end)}\x1b[39m`;
    cursor = match.end;
  }
  return result + text.slice(cursor);
}

export class SshKeywordHighlighter {
  private decoder = new TextDecoder();
  private pendingPlainText = '';
  private foregroundIsDefault = true;
  private escapeState: EscapeState = 'normal';
  private csiBuffer = '';
  private stringEscapePending = false;

  transform(
    input: Uint8Array | string,
    colors: SshKeywordHighlightColors,
    enabled: boolean,
  ): string {
    const decoded = typeof input === 'string'
      ? input
      : this.decoder.decode(input, { stream: true });
    let result = '';
    let plainText = this.pendingPlainText;
    this.pendingPlainText = '';

    const commitPlainText = () => {
      result += enabled && this.foregroundIsDefault
        ? highlightPlainText(plainText, colors)
        : plainText;
      plainText = '';
    };

    for (const character of decoded) {
      if (character === '\x18' || character === '\x1a') {
        if (this.escapeState === 'normal') commitPlainText();
        result += character;
        this.escapeState = 'normal';
        this.csiBuffer = '';
        this.stringEscapePending = false;
        continue;
      }

      if (character === '\u009b') {
        if (this.escapeState === 'normal') commitPlainText();
        result += character;
        this.escapeState = 'csi';
        this.csiBuffer = '\x1b[';
        this.stringEscapePending = false;
        continue;
      }

      if (character === '\u0090' || character === '\u0098'
        || character === '\u009d' || character === '\u009e' || character === '\u009f') {
        if (this.escapeState === 'normal') commitPlainText();
        result += character;
        this.escapeState = 'string';
        this.csiBuffer = '';
        this.stringEscapePending = false;
        continue;
      }

      if (character === '\u009c') {
        if (this.escapeState === 'normal') commitPlainText();
        result += character;
        this.escapeState = 'normal';
        this.csiBuffer = '';
        this.stringEscapePending = false;
        continue;
      }

      if (this.escapeState === 'normal') {
        if (character === '\x1b') {
          commitPlainText();
          result += character;
          this.escapeState = 'escape';
        } else {
          plainText += character;
        }
        continue;
      }

      result += character;
      if (this.escapeState === 'escape') {
        if (character === '[') {
          this.escapeState = 'csi';
          this.csiBuffer = '\x1b[';
        } else if (character === ']' || character === 'P' || character === 'X'
          || character === '^' || character === '_') {
          this.escapeState = 'string';
          this.stringEscapePending = false;
        } else {
          this.escapeState = 'normal';
        }
        continue;
      }

      if (this.escapeState === 'csi') {
        if (this.csiBuffer.length < MAX_TRACKED_CSI_LENGTH) {
          this.csiBuffer += character;
        }
        const code = character.charCodeAt(0);
        if (code >= 0x40 && code <= 0x7e) {
          this.updateForegroundState(this.csiBuffer);
          this.csiBuffer = '';
          this.escapeState = 'normal';
        }
        continue;
      }

      if (character === '\x07') {
        this.escapeState = 'normal';
        this.stringEscapePending = false;
      } else if (this.stringEscapePending && character === '\\') {
        this.escapeState = 'normal';
        this.stringEscapePending = false;
      } else {
        this.stringEscapePending = character === '\x1b';
      }
    }

    if (this.escapeState === 'normal' && enabled && this.foregroundIsDefault) {
      const trailingToken = plainText.match(TRAILING_TOKEN_PATTERN)?.[0] ?? '';
      if (trailingToken) {
        const retainedLength = retainedTrailingLength(trailingToken);
        const tokenStart = plainText.length - trailingToken.length;
        const retainedStart = plainText.length - retainedLength;
        this.pendingPlainText = plainText.slice(retainedStart);
        result += highlightPlainText(plainText.slice(0, tokenStart), colors);
        result += plainText.slice(tokenStart, retainedStart);
      } else {
        result += highlightPlainText(plainText, colors);
      }
    } else {
      result += plainText;
    }
    return result;
  }

  flush(
    colors: SshKeywordHighlightColors,
    enabled: boolean,
    allowHighlight = true,
  ): string {
    const pending = this.pendingPlainText;
    this.pendingPlainText = '';
    return allowHighlight && enabled && this.foregroundIsDefault
      ? highlightPlainText(pending, colors)
      : pending;
  }

  hasPendingPlainText(): boolean {
    return this.pendingPlainText.length > 0;
  }

  reset(): void {
    this.decoder = new TextDecoder();
    this.pendingPlainText = '';
    this.foregroundIsDefault = true;
    this.escapeState = 'normal';
    this.csiBuffer = '';
    this.stringEscapePending = false;
  }

  private updateForegroundState(sequence: string): void {
    if (!sequence.startsWith('\x1b[') || !sequence.endsWith('m')) return;
    const rawParameters = sequence.slice(2, -1);
    const parameters = rawParameters === '' ? ['0'] : rawParameters.split(';');

    for (let index = 0; index < parameters.length; index += 1) {
      const token = parameters[index];
      const parameter = Number.parseInt(token.split(':', 1)[0], 10);
      if (parameter === 0 || parameter === 39) {
        this.foregroundIsDefault = true;
      } else if ((parameter >= 30 && parameter <= 37)
        || (parameter >= 90 && parameter <= 97)
      ) {
        this.foregroundIsDefault = false;
      } else if (parameter === 38 || parameter === 48 || parameter === 58) {
        if (parameter === 38) this.foregroundIsDefault = false;
        if (token.includes(':')) continue;

        const colorMode = Number.parseInt(parameters[index + 1] ?? '', 10);
        if (colorMode === 5) {
          index += 2;
        } else if (colorMode === 2) {
          index += 4;
        }
      }
    }
  }
}

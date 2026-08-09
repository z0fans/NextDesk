import { describe, expect, it } from 'vitest';

import {
  SshKeywordHighlighter,
  resolveSshKeywordHighlightColors,
} from '@/ssh/ssh-keyword-highlighter';

const PRO_COLORS = resolveSshKeywordHighlightColors('nextdesk', true);
const LIGHT_COLORS = {
  error: '#FF000F',
  warning: '#E36D00',
  ok: '#009618',
  info: '#0029FF',
  debug: '#9E00E9',
  address: '#EE0064',
};

function foreground(color: string): string {
  const channels = color.match(/[\da-f]{2}/gi)?.map((channel) => Number.parseInt(channel, 16));
  if (!channels || channels.length !== 3) throw new Error(`Invalid color: ${color}`);
  return `\x1b[38;2;${channels.join(';')}m`;
}

function transformAndFlush(highlighter: SshKeywordHighlighter, input: string): string {
  return highlighter.transform(input, PRO_COLORS, true)
    + highlighter.flush(PRO_COLORS, true);
}

describe('SSH keyword highlighting', () => {
  it('uses the Termius Pro colors for keywords, IP addresses, and MAC addresses', () => {
    const highlighter = new SshKeywordHighlighter();
    const input = 'Error Warning OK Info Debug 127.0.0.1 bc:24:11:b2:67:e6 fe80::1';

    expect(transformAndFlush(highlighter, input)).toBe([
      `${foreground(PRO_COLORS.error)}Error\x1b[39m`,
      `${foreground(PRO_COLORS.warning)}Warning\x1b[39m`,
      `${foreground(PRO_COLORS.ok)}OK\x1b[39m`,
      `${foreground(PRO_COLORS.info)}Info\x1b[39m`,
      `${foreground(PRO_COLORS.debug)}Debug\x1b[39m`,
      `${foreground(PRO_COLORS.address)}127.0.0.1\x1b[39m`,
      `${foreground(PRO_COLORS.address)}bc:24:11:b2:67:e6\x1b[39m`,
      `${foreground(PRO_COLORS.address)}fe80::1\x1b[39m`,
    ].join(' '));
  });

  it('does not override text that the remote shell already colored', () => {
    const highlighter = new SshKeywordHighlighter();
    const input = '\x1b[31m127.0.0.1\x1b[39m 10.0.0.1';

    expect(transformAndFlush(highlighter, input)).toBe(
      `\x1b[31m127.0.0.1\x1b[39m ${foreground(PRO_COLORS.address)}10.0.0.1\x1b[39m`,
    );
  });

  it('does not override remote true-color or 256-color foreground text', () => {
    const highlighter = new SshKeywordHighlighter();
    const input = [
      '\x1b[38;2;0;255;0mError\x1b[39m',
      '\x1b[38;5;0mWarning\x1b[39m',
      'Info ',
    ].join(' ');

    expect(highlighter.transform(input, PRO_COLORS, true)).toBe(
      '\x1b[38;2;0;255;0mError\x1b[39m '
      + '\x1b[38;5;0mWarning\x1b[39m '
      + `${foreground(PRO_COLORS.info)}Info\x1b[39m `,
    );
  });

  it('does not mistake extended background color payloads for a foreground reset', () => {
    const highlighter = new SshKeywordHighlighter();
    const input = '\x1b[31m\x1b[48;2;0;0;0mError\x1b[39m OK ';

    expect(highlighter.transform(input, PRO_COLORS, true)).toBe(
      '\x1b[31m\x1b[48;2;0;0;0mError\x1b[39m '
      + `${foreground(PRO_COLORS.ok)}OK\x1b[39m `,
    );
  });

  it('tracks ANSI sequences split across SSH output chunks', () => {
    const highlighter = new SshKeywordHighlighter();

    expect(
      highlighter.transform('\x1b[3', PRO_COLORS, true)
      + highlighter.transform('1m10.0.0.1\x1b[39m 127.0.0.1', PRO_COLORS, true)
      + highlighter.flush(PRO_COLORS, true),
    ).toBe(
      `\x1b[31m10.0.0.1\x1b[39m ${foreground(PRO_COLORS.address)}127.0.0.1\x1b[39m`,
    );
  });

  it('highlights keywords and addresses split across SSH output chunks', () => {
    const highlighter = new SshKeywordHighlighter();

    expect(highlighter.transform('Err', PRO_COLORS, true)).toBe('');
    expect(highlighter.transform('or 10.0.', PRO_COLORS, true)).toBe(
      `${foreground(PRO_COLORS.error)}Error\x1b[39m `,
    );
    expect(highlighter.transform('0.1 00:11:22:', PRO_COLORS, true)).toBe(
      `${foreground(PRO_COLORS.address)}10.0.0.1\x1b[39m `,
    );
    expect(highlighter.transform('33:44:55 ', PRO_COLORS, true)).toBe(
      `${foreground(PRO_COLORS.address)}00:11:22:33:44:55\x1b[39m `,
    );

    expect(highlighter.transform('my_', PRO_COLORS, true)).toBe('my');
    expect(highlighter.transform('Error ', PRO_COLORS, true)).toBe('_Error ');
  });

  it('highlights a complete IPv4-embedded IPv6 address and rejects embedded tokens', () => {
    const highlighter = new SshKeywordHighlighter();
    const input = '::ffff:192.0.2.128 x10.0.0.1z x00:11:22:33:44:55z x2001:db8::1z ';

    expect(highlighter.transform(input, PRO_COLORS, true)).toBe(
      `${foreground(PRO_COLORS.address)}::ffff:192.0.2.128\x1b[39m `
      + 'x10.0.0.1z x00:11:22:33:44:55z x2001:db8::1z ',
    );
  });

  it('keeps punctuation outside IPv6 highlighting', () => {
    const highlighter = new SshKeywordHighlighter();

    expect(highlighter.transform('2001:db8::1. ', PRO_COLORS, true)).toBe(
      `${foreground(PRO_COLORS.address)}2001:db8::1\x1b[39m. `,
    );
  });

  it('does not create a false keyword boundary when bounding a long token', () => {
    const highlighter = new SshKeywordHighlighter();
    const token = `Error${'x'.repeat(64)}`;

    expect(
      highlighter.transform(token, PRO_COLORS, true)
      + highlighter.flush(PRO_COLORS, true),
    ).toBe(token);
  });

  it.each([
    'Errorx',
    '10.0.0.1z',
    '00:11:22:33:44:55z',
    '2001:db8::1z',
  ])('does not create a false boundary at the end of %s', (token) => {
    const highlighter = new SshKeywordHighlighter();

    expect(
      highlighter.transform(token, PRO_COLORS, true)
      + highlighter.flush(PRO_COLORS, true),
    ).toBe(token);
  });

  it('tracks C1 CSI foreground colors without overriding remote text', () => {
    const highlighter = new SshKeywordHighlighter();
    const input = '\u009b31m Error \u009b39m OK ';

    expect(highlighter.transform(input, PRO_COLORS, true)).toBe(
      `\u009b31m Error \u009b39m ${foreground(PRO_COLORS.ok)}OK\x1b[39m `,
    );
  });

  it('resumes highlighting after C1 ST and CAN/SUB cancel controls', () => {
    const highlighter = new SshKeywordHighlighter();

    expect(highlighter.transform('\u009dtitle\u009cError ', PRO_COLORS, true)).toBe(
      `\u009dtitle\u009c${foreground(PRO_COLORS.error)}Error\x1b[39m `,
    );
    expect(highlighter.transform('\x1b]title\x18Warning ', PRO_COLORS, true)).toBe(
      `\x1b]title\x18${foreground(PRO_COLORS.warning)}Warning\x1b[39m `,
    );
    expect(highlighter.transform('\x1b]title\x1aInfo ', PRO_COLORS, true)).toBe(
      `\x1b]title\x1a${foreground(PRO_COLORS.info)}Info\x1b[39m `,
    );
  });

  it('tracks a C1 CSI foreground change that re-enters from a string control', () => {
    const highlighter = new SshKeywordHighlighter();
    const input = '\u009dtitle\u009b31m\u009c Error \u009b39m OK ';

    expect(highlighter.transform(input, PRO_COLORS, true)).toBe(
      `\u009dtitle\u009b31m\u009c Error \u009b39m ${foreground(PRO_COLORS.ok)}OK\x1b[39m `,
    );
  });

  it('streams incomplete OSC output without buffering it and resumes after its terminator', () => {
    const highlighter = new SshKeywordHighlighter();
    const malformedOsc = `\x1b]${'x'.repeat(4_096)}`;

    expect(highlighter.transform(malformedOsc, PRO_COLORS, true)).toBe(malformedOsc);
    expect(highlighter.transform('\x07', PRO_COLORS, true)).toBe('\x07');
    expect(highlighter.transform('Error ', PRO_COLORS, true)).toBe(
      `${foreground(PRO_COLORS.error)}Error\x1b[39m `,
    );
  });

  it('resets decoder, escape, and foreground state for a new SSH transport', () => {
    const highlighter = new SshKeywordHighlighter();

    expect(highlighter.transform('\x1b[31mErr', PRO_COLORS, true)).toBe('\x1b[31mErr');
    highlighter.reset();
    expect(highlighter.transform('Error ', PRO_COLORS, true)).toBe(
      `${foreground(PRO_COLORS.error)}Error\x1b[39m `,
    );
  });

  it('uses exact Termius light colors for light and follow-theme palettes', () => {
    expect(resolveSshKeywordHighlightColors('nextdesk_light', true)).toEqual(LIGHT_COLORS);
    expect(resolveSshKeywordHighlightColors('solarized_light', true)).toEqual(LIGHT_COLORS);
    expect(resolveSshKeywordHighlightColors('follow_theme', false)).toEqual(LIGHT_COLORS);
    expect(resolveSshKeywordHighlightColors('follow_theme', true)).toEqual(PRO_COLORS);
  });

  it('preserves output when highlighting is disabled and rejects invalid IPv4 values', () => {
    const highlighter = new SshKeywordHighlighter();

    expect(highlighter.transform('Error 999.0.0.1', PRO_COLORS, false)).toBe('Error 999.0.0.1');
    expect(transformAndFlush(highlighter, '999.0.0.1')).toBe('999.0.0.1');
  });
});

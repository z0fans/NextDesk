import { StrictMode } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  startMock,
  closeMock,
  inputMock,
  logStartFailureMock,
  writeMock,
  terminalCallbacks,
  terminalOptions,
} = vi.hoisted(() => ({
  startMock: vi.fn(),
  closeMock: vi.fn(),
  inputMock: vi.fn(),
  logStartFailureMock: vi.fn(),
  writeMock: vi.fn(),
  terminalCallbacks: {
    onData: undefined as ((data: string) => void) | undefined,
  },
  terminalOptions: {} as Record<string, unknown>,
}));

vi.mock('@/i18n/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/ssh/ssh-api', () => ({
  sshApi: {
    start: startMock,
    close: closeMock,
    input: inputMock,
    logStartFailure: logStartFailureMock,
    resize: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options = terminalOptions;
    cols = 80;
    rows = 24;
    constructor(options: Record<string, unknown>) {
      Object.assign(terminalOptions, options);
    }
    loadAddon = vi.fn();
    open = vi.fn();
    write = writeMock;
    focus = vi.fn();
    dispose = vi.fn();
    onData = vi.fn((callback: (data: string) => void) => {
      terminalCallbacks.onData = callback;
      return { dispose: vi.fn() };
    });
    onResize = vi.fn(() => ({ dispose: vi.fn() }));
  },
}));

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

import { TerminalSurface } from '@/ssh/TerminalSurface';

describe('SSH terminal StrictMode lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    startMock.mockReset().mockResolvedValue({ sessionId: 'ssh-alpha', routeLabel: 'cloud' });
    closeMock.mockReset().mockResolvedValue(undefined);
    inputMock.mockReset().mockResolvedValue(undefined);
    logStartFailureMock.mockReset().mockResolvedValue(undefined);
    writeMock.mockReset();
    terminalCallbacks.onData = undefined;
    for (const key of Object.keys(terminalOptions)) delete terminalOptions[key];
  });

  afterEach(() => {
    document.documentElement.classList.remove('dark');
    vi.useRealTimers();
  });

  it('reserves a small bottom inset above the command bar', () => {
    const { container } = render(
      <TerminalSurface
        sessionId="ssh-alpha"
        connection={{
          id: 'alpha',
          name: 'Alpha',
          host: 'alpha.example.com',
          port: 22,
          username: 'root',
          authMethod: 'password',
          credentialReference: 'ssh-alpha',
          routePolicy: 'auto',
        }}
        visible
        retryToken={0}
        onEvent={vi.fn()}
      />,
    );

    const surface = container.querySelector<HTMLElement>('[data-region="ssh-terminal-surface"]');
    const host = container.querySelector<HTMLElement>('[data-region="ssh-terminal-host"]');

    expect(surface).toHaveClass('flex', 'pb-3');
    expect(host).toHaveClass('min-h-0', 'flex-1');
    expect(surface).toContainElement(host);
  });

  it('updates a follow-theme terminal when the app theme changes', async () => {
    render(
      <TerminalSurface
        sessionId="ssh-alpha"
        connection={{
          id: 'alpha',
          name: 'Alpha',
          host: 'alpha.example.com',
          port: 22,
          username: 'root',
          authMethod: 'password',
          credentialReference: 'ssh-alpha',
          routePolicy: 'auto',
        }}
        visible
        retryToken={0}
        onEvent={vi.fn()}
        settings={{
          palette: 'follow_theme',
          fontFamily: 'monospace',
          fontSize: 13,
          lineHeight: 1.15,
          cursorStyle: 'block',
          cursorBlink: true,
          keywordHighlighting: true,
          scrollback: 10_000,
        }}
      />,
    );

    expect(terminalOptions.theme).toMatchObject({ background: '#f8fafc' });

    await act(async () => {
      document.documentElement.classList.add('dark');
      await Promise.resolve();
    });

    expect(terminalOptions.theme).toMatchObject({ background: '#000000' });
  });

  it('keeps bold ANSI colors on the base Pro palette like Termius', () => {
    render(
      <TerminalSurface
        sessionId="ssh-alpha"
        connection={{
          id: 'alpha',
          name: 'Alpha',
          host: 'alpha.example.com',
          port: 22,
          username: 'root',
          authMethod: 'password',
          credentialReference: 'ssh-alpha',
          routePolicy: 'auto',
        }}
        visible
        retryToken={0}
        onEvent={vi.fn()}
      />,
    );

    expect(terminalOptions.drawBoldTextInBrightColors).toBe(false);
  });

  it('highlights plain SSH output before writing it to xterm', async () => {
    render(
      <TerminalSurface
        sessionId="ssh-alpha"
        connection={{
          id: 'alpha',
          name: 'Alpha',
          host: 'alpha.example.com',
          port: 22,
          username: 'root',
          authMethod: 'password',
          credentialReference: 'ssh-alpha',
          routePolicy: 'auto',
        }}
        visible
        retryToken={0}
        onEvent={vi.fn()}
      />,
    );

    await act(async () => {
      vi.runAllTimers();
      await Promise.resolve();
    });
    writeMock.mockClear();

    const onOutput = startMock.mock.calls[0][1] as (data: Uint8Array) => void;
    act(() => onOutput(new TextEncoder().encode('inet 127.0.0.1')));

    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenNthCalledWith(1, 'inet ');

    act(() => onOutput(new TextEncoder().encode('\r\n')));

    expect(writeMock).toHaveBeenNthCalledWith(
      2,
      '\x1b[38;2;210;84;154m127.0.0.1\x1b[39m\r\n',
    );
  });

  it('coalesces a split keyword inside the bounded SSH output window', async () => {
    render(
      <TerminalSurface
        sessionId="ssh-alpha"
        connection={{
          id: 'alpha',
          name: 'Alpha',
          host: 'alpha.example.com',
          port: 22,
          username: 'root',
          authMethod: 'password',
          credentialReference: 'ssh-alpha',
          routePolicy: 'auto',
        }}
        visible
        retryToken={0}
        onEvent={vi.fn()}
      />,
    );

    await act(async () => {
      vi.runAllTimers();
      await Promise.resolve();
    });
    writeMock.mockClear();
    const onOutput = startMock.mock.calls[0][1] as (data: Uint8Array) => void;

    act(() => onOutput(new TextEncoder().encode('Err')));
    act(() => vi.advanceTimersByTime(25));
    expect(writeMock).not.toHaveBeenCalled();

    act(() => onOutput(new TextEncoder().encode('or ')));
    expect(writeMock).toHaveBeenCalledWith('\x1b[38;2;242;94;97mError\x1b[39m ');
  });

  it('flushes an unfinished candidate without speculative color after the idle delay', async () => {
    render(
      <TerminalSurface
        sessionId="ssh-alpha"
        connection={{
          id: 'alpha',
          name: 'Alpha',
          host: 'alpha.example.com',
          port: 22,
          username: 'root',
          authMethod: 'password',
          credentialReference: 'ssh-alpha',
          routePolicy: 'auto',
        }}
        visible
        retryToken={0}
        onEvent={vi.fn()}
      />,
    );

    await act(async () => {
      vi.runAllTimers();
      await Promise.resolve();
    });
    writeMock.mockClear();
    const onOutput = startMock.mock.calls[0][1] as (data: Uint8Array) => void;

    act(() => onOutput(new TextEncoder().encode('Error')));
    expect(writeMock).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(50));

    expect(writeMock).toHaveBeenCalledWith('Error');

    act(() => onOutput(new TextEncoder().encode('x ')));
    expect(writeMock).toHaveBeenLastCalledWith('x ');
  });

  it('resets keyword parsing before a reconnect starts', async () => {
    const connection = {
      id: 'alpha',
      name: 'Alpha',
      host: 'alpha.example.com',
      port: 22,
      username: 'root',
      authMethod: 'password' as const,
      credentialReference: 'ssh-alpha',
      routePolicy: 'auto' as const,
    };
    const { rerender } = render(
      <TerminalSurface
        sessionId="ssh-alpha"
        connection={connection}
        visible
        retryToken={0}
        onEvent={vi.fn()}
      />,
    );

    await act(async () => {
      vi.runAllTimers();
      await Promise.resolve();
    });
    const firstOutput = startMock.mock.calls[0][1] as (data: Uint8Array) => void;
    act(() => firstOutput(new TextEncoder().encode('Err')));
    writeMock.mockClear();

    rerender(
      <TerminalSurface
        sessionId="ssh-alpha"
        connection={connection}
        visible
        retryToken={1}
        onEvent={vi.fn()}
      />,
    );
    await act(async () => {
      vi.runAllTimers();
      await Promise.resolve();
    });
    const secondOutput = startMock.mock.calls[1][1] as (data: Uint8Array) => void;
    act(() => secondOutput(new TextEncoder().encode('Error ')));

    expect(writeMock).toHaveBeenCalledWith('Err');
    expect(writeMock).toHaveBeenCalledWith('\x1b[38;2;242;94;97mError\x1b[39m ');
  });

  it('flushes a pending visible token before the terminal unmounts', async () => {
    const { unmount } = render(
      <TerminalSurface
        sessionId="ssh-alpha"
        connection={{
          id: 'alpha',
          name: 'Alpha',
          host: 'alpha.example.com',
          port: 22,
          username: 'root',
          authMethod: 'password',
          credentialReference: 'ssh-alpha',
          routePolicy: 'auto',
        }}
        visible
        retryToken={0}
        onEvent={vi.fn()}
      />,
    );

    await act(async () => {
      vi.runAllTimers();
      await Promise.resolve();
    });
    writeMock.mockClear();
    const onOutput = startMock.mock.calls[0][1] as (data: Uint8Array) => void;
    act(() => onOutput(new TextEncoder().encode('Err')));

    unmount();

    expect(writeMock).toHaveBeenCalledWith('Err');
  });

  it('starts exactly one backend session after the StrictMode effect probe', async () => {
    render(
      <StrictMode>
        <TerminalSurface
          sessionId="ssh-alpha"
          connection={{
            id: 'alpha',
            name: 'Alpha',
            host: 'alpha.example.com',
            port: 22,
            username: 'root',
            authMethod: 'password',
            credentialReference: 'ssh-alpha',
            routePolicy: 'auto',
          }}
          visible
          retryToken={0}
          onEvent={vi.fn()}
        />
      </StrictMode>,
    );

    await act(async () => {
      vi.runAllTimers();
      await Promise.resolve();
    });

    expect(startMock).toHaveBeenCalledTimes(1);
    expect(closeMock).not.toHaveBeenCalled();
    expect(startMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ssh-alpha', reuseCloudBinding: false }),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('serializes terminal input while the backend queue applies backpressure', async () => {
    let releaseFirstInput!: () => void;
    inputMock
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => {
          releaseFirstInput = resolve;
        }),
      )
      .mockResolvedValue(undefined);

    render(
      <TerminalSurface
        sessionId="ssh-alpha"
        connection={{
          id: 'alpha',
          name: 'Alpha',
          host: 'alpha.example.com',
          port: 22,
          username: 'root',
          authMethod: 'password',
          credentialReference: 'ssh-alpha',
          routePolicy: 'auto',
        }}
        visible
        retryToken={0}
        onEvent={vi.fn()}
      />,
    );

    await act(async () => {
      terminalCallbacks.onData?.('first');
      terminalCallbacks.onData?.('second');
      await Promise.resolve();
    });
    expect(inputMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseFirstInput();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(inputMock).toHaveBeenCalledTimes(2);
    expect(new TextDecoder().decode(inputMock.mock.calls[0][1])).toBe('first');
    expect(new TextDecoder().decode(inputMock.mock.calls[1][1])).toBe('second');
  });

  it('reports only a sanitized backend start failure code', async () => {
    const onEvent = vi.fn();
    startMock.mockRejectedValueOnce(
      new Error('invoke failed: ssh_session_already_exists: internal details'),
    );

    render(
      <TerminalSurface
        sessionId="ssh-alpha"
        connection={{
          id: 'alpha',
          name: 'Alpha',
          host: 'alpha.example.com',
          port: 22,
          username: 'root',
          authMethod: 'password',
          credentialReference: 'ssh-alpha',
          routePolicy: 'auto',
        }}
        visible
        retryToken={0}
        onEvent={onEvent}
      />,
    );

    await act(async () => {
      vi.runAllTimers();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(logStartFailureMock).toHaveBeenCalledWith('ssh_session_already_exists');
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'error', message: 'ssh_session_already_exists' }),
    );
  });

  it('does not overwrite a backend transport failure with late terminal input closure', async () => {
    const onEvent = vi.fn();
    inputMock.mockRejectedValueOnce(new Error('ssh_session_closed'));

    render(
      <TerminalSurface
        sessionId="ssh-alpha"
        connection={{
          id: 'alpha',
          name: 'Alpha',
          host: 'alpha.example.com',
          port: 22,
          username: 'root',
          authMethod: 'password',
          credentialReference: 'ssh-alpha',
          routePolicy: 'auto',
        }}
        visible
        retryToken={0}
        onEvent={onEvent}
      />,
    );

    await act(async () => {
      vi.runAllTimers();
      await Promise.resolve();
      terminalCallbacks.onData?.('late input');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(inputMock).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'error', message: 'ssh_session_closed' }),
    );
  });
});

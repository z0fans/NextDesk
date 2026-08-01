import { StrictMode } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { startMock, closeMock, inputMock, terminalCallbacks } = vi.hoisted(() => ({
  startMock: vi.fn(),
  closeMock: vi.fn(),
  inputMock: vi.fn(),
  terminalCallbacks: {
    onData: undefined as ((data: string) => void) | undefined,
  },
}));

vi.mock('@/i18n/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/ssh/ssh-api', () => ({
  sshApi: {
    start: startMock,
    close: closeMock,
    input: inputMock,
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
    cols = 80;
    rows = 24;
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
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
    terminalCallbacks.onData = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
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
});

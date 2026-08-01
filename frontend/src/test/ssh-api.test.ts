import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, channels } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  channels: [] as Array<{ onmessage?: (message: unknown) => void }>,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  Channel: class<T> {
    onmessage?: (message: T) => void;

    constructor() {
      channels.push(this as { onmessage?: (message: unknown) => void });
    }
  },
}));

import { sshApi } from '@/ssh/ssh-api';

describe('SSH IPC bridge', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    channels.length = 0;
  });

  it('starts a session with separate binary-output and event channels', async () => {
    invokeMock.mockResolvedValue({ sessionId: 'tab-1', routeLabel: 'cloud' });
    const onOutput = vi.fn();
    const onEvent = vi.fn();

    await sshApi.start(
      {
        sessionId: 'tab-1',
        host: 'server.example.com',
        port: 22,
        username: 'deploy',
        authMethod: 'password',
        credentialReference: 'ssh/server-1',
        cols: 80,
        rows: 24,
        pixelWidth: 0,
        pixelHeight: 0,
        routePolicy: 'auto',
        reuseCloudBinding: true,
      },
      onOutput,
      onEvent,
    );

    expect(invokeMock).toHaveBeenCalledWith(
      'ssh_session_start',
      expect.objectContaining({
        request: expect.objectContaining({ sessionId: 'tab-1' }),
        onOutput: channels[0],
        onEvent: channels[1],
      }),
    );

    channels[0].onmessage?.(new Uint8Array([65, 66]).buffer);
    channels[1].onmessage?.({ kind: 'state', sessionId: 'tab-1', state: 'connected' });
    expect(onOutput).toHaveBeenCalledWith(new Uint8Array([65, 66]));
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'state', state: 'connected' }),
    );
  });
});

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

  it('records a sanitized start failure code in backend diagnostics', async () => {
    invokeMock.mockResolvedValue(undefined);

    await sshApi.logStartFailure('ssh_session_already_exists');

    expect(invokeMock).toHaveBeenCalledWith('ssh_log_start_failure', {
      code: 'ssh_session_already_exists',
    });
  });

  it('requests a live monitor snapshot for an active SSH session', async () => {
    const snapshot = {
      supported: true,
      uptimeSeconds: 90061,
      loadAverage: [0.1, 0.2, 0.3],
      cpuPercent: 12,
      memoryUsedBytes: 1024,
      memoryTotalBytes: 4096,
      swapUsedBytes: 0,
      swapTotalBytes: 0,
      processes: [],
      networkInterface: 'eth0',
      networkReceiveBytesPerSecond: 128,
      networkTransmitBytesPerSecond: 64,
      latencyMs: 14.5,
      disks: [],
    };
    invokeMock.mockResolvedValue(snapshot);

    await expect(sshApi.monitorSnapshot('tab-1')).resolves.toEqual(snapshot);

    expect(invokeMock).toHaveBeenCalledWith('ssh_monitor_snapshot', { sessionId: 'tab-1' });
  });

  it('stores a typed private-key credential through the Rust boundary', async () => {
    invokeMock.mockResolvedValue(undefined);

    await sshApi.storePrivateKeyCredential(
      'ssh-key-1',
      'Deployment key',
      '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----',
      'ssh-ed25519 AAAATEST deployment@example',
      'passphrase',
    );

    expect(invokeMock).toHaveBeenCalledWith('ssh_private_key_credential_store', {
      reference: 'ssh-key-1',
      label: 'Deployment key',
      privateKey: expect.stringContaining('BEGIN PRIVATE KEY'),
      publicKey: 'ssh-ed25519 AAAATEST deployment@example',
      passphrase: 'passphrase',
    });
  });
});

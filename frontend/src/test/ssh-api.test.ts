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

function startSession(sessionId = 'input-session') {
  return sshApi.start({
    sessionId,
    host: 'server.example.com',
    port: 22,
    username: 'deploy',
    authMethod: 'private_key',
    cols: 80,
    rows: 24,
    pixelWidth: 0,
    pixelHeight: 0,
    routePolicy: 'auto',
    reuseCloudBinding: false,
  }, vi.fn(), vi.fn());
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

describe('SSH input ordering', () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue(undefined);
    channels.length = 0;
  });

  it('keeps a terminal paste and command-bar input ordered under backend backpressure', async () => {
    await startSession();
    invokeMock.mockClear();
    const firstChunk = deferred();
    invokeMock.mockImplementationOnce(() => firstChunk.promise);
    const paste = new Uint8Array(32 * 1024 + 7).fill(65);

    const terminalInput = sshApi.input('input-session', paste);
    const commandInput = sshApi.input('input-session', new TextEncoder().encode('B\r'));
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('ssh_session_input', {
      sessionId: 'input-session', data: Array.from(paste.subarray(0, 16 * 1024)),
    });

    firstChunk.resolve();
    await Promise.all([terminalInput, commandInput]);

    expect(invokeMock.mock.calls.map(([, args]) => args.data.length)).toEqual([
      16 * 1024, 16 * 1024, 7, 2,
    ]);
    expect(invokeMock.mock.calls.flatMap(([, args]) => args.data)).toEqual([
      ...paste, 66, 13,
    ]);
  });

  it('does not block another session behind a slow input', async () => {
    await startSession();
    await startSession('other-session');
    invokeMock.mockClear();
    const firstChunk = deferred();
    invokeMock.mockImplementationOnce(() => firstChunk.promise);

    const slowInput = sshApi.input('input-session', new Uint8Array(16 * 1024 + 1));
    await Promise.resolve();
    await sshApi.input('other-session', new Uint8Array([66]));

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenLastCalledWith('ssh_session_input', {
      sessionId: 'other-session', data: [66],
    });

    firstChunk.resolve();
    await slowInput;
  });

  it('propagates the input error and continues with the next queued input', async () => {
    await startSession();
    invokeMock.mockClear();
    const failedChunk = deferred();
    invokeMock.mockImplementationOnce(() => failedChunk.promise);
    const failure = new Error('ssh_input_backpressure');

    const failedInput = sshApi.input('input-session', new Uint8Array(16 * 1024 + 1));
    const rejected = expect(failedInput).rejects.toBe(failure);
    const nextInput = sshApi.input('input-session', new Uint8Array([66]));
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    failedChunk.reject(failure);
    await rejected;
    await nextInput;
    await sshApi.input('input-session', new Uint8Array([67]));

    expect(invokeMock.mock.calls.map(([, args]) => args.data.length)).toEqual([16 * 1024, 1, 1]);
    expect(invokeMock).toHaveBeenLastCalledWith('ssh_session_input', {
      sessionId: 'input-session', data: [67],
    });
  });

  it.each(['close', 'restart'] as const)('%s cancels remaining chunks and queued input for a reused session ID', async (action) => {
    await startSession();
    invokeMock.mockClear();
    const firstChunk = deferred();
    invokeMock.mockImplementationOnce(() => firstChunk.promise);
    const oldInput = sshApi.input('input-session', new Uint8Array(16 * 1024 + 1));
    const queuedInput = sshApi.input('input-session', new Uint8Array([66]));
    const oldRejected = expect(oldInput).rejects.toThrow('ssh_session_closed');
    const queuedRejected = expect(queuedInput).rejects.toThrow('ssh_session_closed');
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    if (action === 'close') {
      await sshApi.close('input-session');
      await expect(sshApi.input('input-session', new Uint8Array([67])))
        .rejects.toThrow('ssh_session_closed');
    }
    await startSession();
    await sshApi.input('input-session', new Uint8Array([68]));
    firstChunk.resolve();
    await Promise.all([oldRejected, queuedRejected]);
    await sshApi.input('input-session', new Uint8Array([69]));

    expect(invokeMock.mock.calls.filter(([command]) => command === 'ssh_session_input')
      .map(([, args]) => args.data.length)).toEqual([16 * 1024, 1, 1]);
    expect(invokeMock).toHaveBeenLastCalledWith('ssh_session_input', {
      sessionId: 'input-session', data: [69],
    });
  });

  it('cancels even an input whose first chunk has not been dispatched', async () => {
    await startSession();
    invokeMock.mockClear();
    const pending = sshApi.input('input-session', new Uint8Array([65]));
    const rejected = expect(pending).rejects.toThrow('ssh_session_closed');

    await sshApi.close('input-session');
    await rejected;

    expect(invokeMock).toHaveBeenCalledExactlyOnceWith('ssh_session_close', {
      sessionId: 'input-session',
    });
  });

  it('holds new input until startup completes and never revives a closed queue', async () => {
    const startup = deferred();
    invokeMock.mockImplementationOnce(() => startup.promise);
    const started = startSession();
    const pending = sshApi.input('input-session', new Uint8Array([65]));
    const rejected = expect(pending).rejects.toThrow('ssh_session_closed');
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    await sshApi.close('input-session');
    startup.resolve();
    await started;
    await rejected;

    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      'ssh_session_start', 'ssh_session_close',
    ]);
  });

  it('propagates startup failure and cancels input waiting for that session', async () => {
    const startup = deferred();
    invokeMock.mockImplementationOnce(() => startup.promise);
    const failure = new Error('ssh_start_failed');
    const started = startSession();
    const startRejected = expect(started).rejects.toBe(failure);
    const pending = sshApi.input('input-session', new Uint8Array([65]));
    const inputRejected = expect(pending).rejects.toThrow('ssh_session_closed');

    startup.reject(failure);
    await Promise.all([startRejected, inputRejected]);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it.each(['disconnected', 'exited', 'error'])('cancels unsent input on a %s event but ignores stale lifecycle events', async (state) => {
    await startSession();
    const oldEvents = channels[1];
    const pending = sshApi.input('input-session', new Uint8Array([65]));
    const rejected = expect(pending).rejects.toThrow('ssh_session_closed');
    oldEvents.onmessage?.({ kind: 'state', sessionId: 'input-session', state });
    await rejected;

    await startSession();
    invokeMock.mockClear();
    oldEvents.onmessage?.({ kind: 'state', sessionId: 'input-session', state });
    await sshApi.input('input-session', new Uint8Array([66]));

    expect(invokeMock).toHaveBeenCalledExactlyOnceWith('ssh_session_input', {
      sessionId: 'input-session', data: [66],
    });
  });
});

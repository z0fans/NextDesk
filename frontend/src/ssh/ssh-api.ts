import { api } from '@/api';

import type {
  SshEvent,
  SshHostKeyTrustRequest,
  SshKnownHostEntry,
  SshMonitorSnapshot,
  SshStartRequest,
  SshStartResponse,
} from './types';

const SSH_INPUT_CHUNK_SIZE = 16 * 1024;
const inputQueues = new Map<string, { tail: Promise<void> }>();

export const sshApi = {
  start(
    request: SshStartRequest,
    onOutput: (data: Uint8Array) => void,
    onEvent: (event: SshEvent) => void,
  ): Promise<SshStartResponse> {
    // A fresh queue identity prevents old chunks from reaching a reused session ID.
    const queue = { tail: Promise.resolve() };
    inputQueues.set(request.sessionId, queue);
    const cancelInput = () => {
      if (inputQueues.get(request.sessionId) === queue) {
        inputQueues.delete(request.sessionId);
      }
    };
    const started = api.sshSessionStart(request, onOutput, (event) => {
      if (event.kind === 'state'
        && (event.state === 'disconnected' || event.state === 'exited' || event.state === 'error')) {
        cancelInput();
      }
      onEvent(event);
    }).catch((error: unknown) => {
      cancelInput();
      throw error;
    });
    queue.tail = started.then(() => {}, () => {});
    return started;
  },

  async input(sessionId: string, data: Uint8Array): Promise<void> {
    const queue = inputQueues.get(sessionId);
    if (!queue) throw new Error('ssh_session_closed');
    const pending = queue.tail.then(async () => {
      for (let offset = 0; offset < data.length; offset += SSH_INPUT_CHUNK_SIZE) {
        if (inputQueues.get(sessionId) !== queue) throw new Error('ssh_session_closed');
        await api.sshSessionInput(sessionId, data.subarray(offset, offset + SSH_INPUT_CHUNK_SIZE));
      }
    });
    queue.tail = pending.catch(() => {});
    return pending;
  },

  resize(
    sessionId: string,
    cols: number,
    rows: number,
    pixelWidth: number,
    pixelHeight: number,
  ): Promise<void> {
    return api.sshSessionResize(sessionId, cols, rows, pixelWidth, pixelHeight);
  },

  close(sessionId: string): Promise<void> {
    inputQueues.delete(sessionId);
    return api.sshSessionClose(sessionId);
  },

  monitorSnapshot(sessionId: string): Promise<SshMonitorSnapshot> {
    return api.sshMonitorSnapshot(sessionId);
  },

  logStartFailure(code: string): Promise<void> {
    return api.sshLogStartFailure(code);
  },

  storeCredential(reference: string, secret: string): Promise<void> {
    return api.sshCredentialStore(reference, secret);
  },

  storePrivateKeyCredential(
    reference: string,
    label: string,
    privateKey: string,
    publicKey?: string,
    passphrase?: string,
  ): Promise<void> {
    return api.sshPrivateKeyCredentialStore(reference, label, privateKey, publicKey, passphrase);
  },

  deleteCredential(reference: string): Promise<void> {
    return api.sshCredentialDelete(reference);
  },

  credentialExists(reference: string): Promise<boolean> {
    return api.sshCredentialExists(reference);
  },

  trustHostKey(request: SshHostKeyTrustRequest): Promise<void> {
    return api.sshTrustHostKey(request);
  },

  knownHostsList(): Promise<SshKnownHostEntry[]> {
    return api.sshKnownHostsList();
  },

  knownHostRemove(host: string): Promise<void> {
    return api.sshKnownHostRemove(host);
  },

  knownHostsImport(contents: string): Promise<number> {
    return api.sshKnownHostsImport(contents);
  },

  knownHostsExport(): Promise<string> {
    return api.sshKnownHostsExport();
  },
};

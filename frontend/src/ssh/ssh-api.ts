import { api } from '@/api';

import type {
  SshEvent,
  SshHostKeyTrustRequest,
  SshStartRequest,
  SshStartResponse,
} from './types';

const SSH_INPUT_CHUNK_SIZE = 16 * 1024;

export const sshApi = {
  start(
    request: SshStartRequest,
    onOutput: (data: Uint8Array) => void,
    onEvent: (event: SshEvent) => void,
  ): Promise<SshStartResponse> {
    return api.sshSessionStart(request, onOutput, onEvent);
  },

  async input(sessionId: string, data: Uint8Array): Promise<void> {
    for (let offset = 0; offset < data.length; offset += SSH_INPUT_CHUNK_SIZE) {
      await api.sshSessionInput(sessionId, data.subarray(offset, offset + SSH_INPUT_CHUNK_SIZE));
    }
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
    return api.sshSessionClose(sessionId);
  },

  storeCredential(reference: string, secret: string): Promise<void> {
    return api.sshCredentialStore(reference, secret);
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
};

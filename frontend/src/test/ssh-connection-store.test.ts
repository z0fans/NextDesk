import { beforeEach, describe, expect, it } from 'vitest';

import {
  SSH_CONNECTIONS_STORAGE_KEY,
  loadSshConnections,
  saveSshConnections,
} from '@/ssh/connection-store';

describe('SSH connection metadata store', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('persists connection metadata without passwords or passphrases', () => {
    saveSshConnections([
      {
        id: 'server-1',
        name: 'Production',
        host: '203.0.113.10',
        port: 22,
        username: 'deploy',
        authMethod: 'password',
        credentialReference: 'ssh/server-1',
        routePolicy: 'auto',
        password: 'must-not-leak',
        secret: 'must-not-leak-either',
      } as never,
    ]);

    const persisted = localStorage.getItem(SSH_CONNECTIONS_STORAGE_KEY) ?? '';
    expect(persisted).not.toContain('must-not-leak');
    expect(JSON.parse(persisted)).toEqual([
      expect.objectContaining({
        id: 'server-1',
        credentialReference: 'ssh/server-1',
      }),
    ]);
  });

  it('drops legacy secret fields while loading metadata', () => {
    localStorage.setItem(
      SSH_CONNECTIONS_STORAGE_KEY,
      JSON.stringify([
        {
          id: 'legacy',
          name: 'Legacy',
          host: 'localhost',
          port: 22,
          username: 'root',
          authMethod: 'password',
          routePolicy: 'direct',
          password: 'old-password',
          secret: 'old-secret',
        },
      ]),
    );

    const loaded = loadSshConnections();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).not.toHaveProperty('password');
    expect(loaded[0]).not.toHaveProperty('secret');
    const rewritten = localStorage.getItem(SSH_CONNECTIONS_STORAGE_KEY) ?? '';
    expect(rewritten).not.toContain('old-password');
    expect(rewritten).not.toContain('old-secret');
  });
});

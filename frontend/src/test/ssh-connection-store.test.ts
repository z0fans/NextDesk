import { beforeEach, describe, expect, it } from 'vitest';

import {
  SSH_CONNECTIONS_STORAGE_KEY,
  SSH_DEFAULT_GROUP_ID,
  SSH_GROUPS_STORAGE_KEY,
  loadSshConnections,
  loadSshWorkspaceState,
  saveSshConnections,
  saveSshGroups,
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
        notes: 'Production relay',
        detectedOs: 'linux',
        proxyType: 'socks5',
        proxyHost: '127.0.0.1',
        proxyPort: 1080,
        proxyUsername: 'proxy-user',
        proxyCredentialReference: 'ssh-proxy/server-1',
        proxyPassword: 'must-not-leak-proxy',
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
        notes: 'Production relay',
        detectedOs: 'linux',
        proxyType: 'socks5',
        proxyHost: '127.0.0.1',
        proxyCredentialReference: 'ssh-proxy/server-1',
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

  it('migrates legacy ungrouped connections into the default SSH group', () => {
    localStorage.setItem(
      SSH_CONNECTIONS_STORAGE_KEY,
      JSON.stringify([
        {
          id: 'legacy',
          name: 'Legacy',
          host: 'legacy.example.com',
          port: 22,
          username: 'root',
          authMethod: 'password',
          credentialReference: 'ssh-legacy',
          routePolicy: 'auto',
        },
      ]),
    );

    const workspace = loadSshWorkspaceState();

    expect(workspace.groups).toEqual([
      { id: SSH_DEFAULT_GROUP_ID, name: '', isExpanded: true },
    ]);
    expect(workspace.connections[0]).toEqual(expect.objectContaining({
      id: 'legacy',
      groupId: SSH_DEFAULT_GROUP_ID,
      credentialReference: 'ssh-legacy',
    }));
    expect(localStorage.getItem(SSH_GROUPS_STORAGE_KEY)).toBe(JSON.stringify(workspace.groups));
    expect(localStorage.getItem(SSH_CONNECTIONS_STORAGE_KEY)).toBe(JSON.stringify(workspace.connections));
  });

  it('persists custom groups and returns orphaned connections to the default group', () => {
    saveSshGroups([
      { id: SSH_DEFAULT_GROUP_ID, name: 'ignored', isExpanded: false },
      { id: 'production', name: 'Production', isExpanded: false },
    ]);
    localStorage.setItem(
      SSH_CONNECTIONS_STORAGE_KEY,
      JSON.stringify([
        {
          id: 'production-host',
          name: 'Production host',
          host: 'prod.example.com',
          port: 22,
          username: 'deploy',
          authMethod: 'private_key',
          credentialReference: 'ssh-production',
          groupId: 'production',
          routePolicy: 'cloud_only',
        },
        {
          id: 'orphan',
          name: 'Orphan',
          host: 'orphan.example.com',
          port: 22,
          username: 'root',
          authMethod: 'password',
          credentialReference: 'ssh-orphan',
          groupId: 'deleted-group',
          routePolicy: 'auto',
        },
      ]),
    );

    const workspace = loadSshWorkspaceState();

    expect(workspace.groups).toEqual([
      { id: SSH_DEFAULT_GROUP_ID, name: '', isExpanded: false },
      { id: 'production', name: 'Production', isExpanded: false },
    ]);
    expect(workspace.connections.map(({ id, groupId }) => ({ id, groupId }))).toEqual([
      { id: 'production-host', groupId: 'production' },
      { id: 'orphan', groupId: SSH_DEFAULT_GROUP_ID },
    ]);
  });
});

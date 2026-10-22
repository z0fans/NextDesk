import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useSessionStore } from '@/lib/useSessionStore';

describe('useSessionStore folder sharing setting', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('syncs folder sharing changes across mounted store instances', () => {
    const first = renderHook(() => useSessionStore());
    const second = renderHook(() => useSessionStore());

    expect(first.result.current.folderSharingEnabled).toBe(false);
    expect(second.result.current.folderSharingEnabled).toBe(false);

    act(() => {
      first.result.current.setFolderSharingEnabled(true);
    });

    expect(first.result.current.folderSharingEnabled).toBe(true);
    expect(second.result.current.folderSharingEnabled).toBe(true);
    expect(localStorage.getItem('nextdesk_folder_sharing')).toBe('true');
  });

  it('migrates old servers to intelligent mode and isolates valid network overrides', () => {
    localStorage.setItem('nextdesk_servers', JSON.stringify([
      {
        id: 'server-1',
        name: 'Server',
        host: '203.0.113.20',
        port: 3389,
        username: 'administrator',
        password: '',
        domain: '',
        groupId: 'default',
        isFavorite: false,
        colorTag: '#3B82F6',
        networkRoutePreferences: {
          'abcdef0123456789abcdef0123456789': 'direct',
          unsafe: 'cloud_only',
        },
        lastNetworkScopeId: 'abcdef0123456789abcdef0123456789',
      },
    ]));

    const { result } = renderHook(() => useSessionStore());

    expect(result.current.servers[0]).toEqual(expect.objectContaining({
      routePolicy: 'auto',
      networkRoutePreferences: {
        'abcdef0123456789abcdef0123456789': 'direct',
      },
      lastNetworkScopeId: 'abcdef0123456789abcdef0123456789',
    }));
  });
});

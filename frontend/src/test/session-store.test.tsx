import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useFolderSharingSetting, useSessionStore } from '@/lib/useSessionStore';

const FOLDER_SHARING_KEY = 'nextdesk_folder_sharing';
const FOLDER_SHARING_EVENT = 'nextdesk-folder-sharing-change';

describe('useSessionStore folder sharing setting', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => vi.restoreAllMocks());

  it('restores the saved setting for every subscriber', () => {
    localStorage.setItem(FOLDER_SHARING_KEY, 'true');
    const first = renderHook(useFolderSharingSetting, { reactStrictMode: true });
    const second = renderHook(useFolderSharingSetting, { reactStrictMode: true });

    expect(first.result.current.folderSharingEnabled).toBe(true);
    expect(second.result.current.folderSharingEnabled).toBe(true);
  });

  it('persists and broadcasts each batched toggle once across StrictMode subscribers', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const first = renderHook(useFolderSharingSetting, { reactStrictMode: true });
    const second = renderHook(useFolderSharingSetting, { reactStrictMode: true });
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const renderErrors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const toggle = vi.fn((previous: boolean) => !previous);
    expect(write).not.toHaveBeenCalled();

    act(() => {
      first.result.current.setFolderSharingEnabled(toggle);
      second.result.current.setFolderSharingEnabled(toggle);
      first.result.current.setFolderSharingEnabled(toggle);
    });

    expect(toggle.mock.calls).toEqual([[false], [true], [false]]);
    expect(first.result.current.folderSharingEnabled).toBe(true);
    expect(second.result.current.folderSharingEnabled).toBe(true);
    expect(write.mock.calls).toEqual([
      [FOLDER_SHARING_KEY, 'true'],
      [FOLDER_SHARING_KEY, 'false'],
      [FOLDER_SHARING_KEY, 'true'],
    ]);
    expect(dispatch.mock.calls.map(([event]) => [event.type, (event as CustomEvent).detail]))
      .toEqual([[FOLDER_SHARING_EVENT, true], [FOLDER_SHARING_EVENT, false], [FOLDER_SHARING_EVENT, true]]);
    expect(renderErrors).not.toHaveBeenCalled();
  });

  it('notifies subscribers of a storage change without writing it back', () => {
    const first = renderHook(useFolderSharingSetting);
    const second = renderHook(useFolderSharingSetting);
    localStorage.setItem(FOLDER_SHARING_KEY, 'true');
    const write = vi.spyOn(Storage.prototype, 'setItem');

    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: FOLDER_SHARING_KEY, newValue: 'true' }));
    });

    expect(first.result.current.folderSharingEnabled).toBe(true);
    expect(second.result.current.folderSharingEnabled).toBe(true);
    expect(write).not.toHaveBeenCalled();
    act(() => second.result.current.setFolderSharingEnabled(previous => !previous));
    expect(first.result.current.folderSharingEnabled).toBe(false);
    expect(localStorage.getItem(FOLDER_SHARING_KEY)).toBe('false');
  });

  it('resets every subscriber when another window clears storage without writing it back', () => {
    localStorage.setItem(FOLDER_SHARING_KEY, 'true');
    const first = renderHook(useFolderSharingSetting, { reactStrictMode: true });
    const second = renderHook(useFolderSharingSetting, { reactStrictMode: true });
    expect(first.result.current.folderSharingEnabled).toBe(true);
    expect(second.result.current.folderSharingEnabled).toBe(true);
    const write = vi.spyOn(Storage.prototype, 'setItem');

    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });

    expect(first.result.current.folderSharingEnabled).toBe(false);
    expect(second.result.current.folderSharingEnabled).toBe(false);
    expect(localStorage.getItem(FOLDER_SHARING_KEY)).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps consecutive updates synchronized when persistence fails', () => {
    const first = renderHook(useFolderSharingSetting);
    const second = renderHook(useFolderSharingSetting);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage full'); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    act(() => {
      first.result.current.setFolderSharingEnabled(true);
      second.result.current.setFolderSharingEnabled(previous => !previous);
    });

    expect(first.result.current.folderSharingEnabled).toBe(false);
    expect(second.result.current.folderSharingEnabled).toBe(false);
  });

  it('retains notifications until the last subscriber unmounts and reloads storage on remount', () => {
    const first = renderHook(useFolderSharingSetting);
    const second = renderHook(useFolderSharingSetting);
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const remove = vi.spyOn(window, 'removeEventListener');
    first.unmount();
    expect(remove).not.toHaveBeenCalled();
    act(() => second.result.current.setFolderSharingEnabled(true));
    expect(second.result.current.folderSharingEnabled).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    second.unmount();
    expect(remove).toHaveBeenCalledWith(FOLDER_SHARING_EVENT, expect.any(Function));
    expect(remove).toHaveBeenCalledWith('storage', expect.any(Function));

    localStorage.setItem(FOLDER_SHARING_KEY, 'false');
    const remounted = renderHook(useFolderSharingSetting);
    expect(remounted.result.current.folderSharingEnabled).toBe(false);
  });

  it('uses the disabled default for non-boolean stored values', () => {
    localStorage.setItem(FOLDER_SHARING_KEY, '{}');
    const { result } = renderHook(useFolderSharingSetting);
    expect(result.current.folderSharingEnabled).toBe(false);
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

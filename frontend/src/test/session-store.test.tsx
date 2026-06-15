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
});

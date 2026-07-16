import { describe, expect, it, vi, beforeEach } from 'vitest';
import { api } from '@/api';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

describe('cloud gateway api bridge', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(null);
  });

  it('starts browser authorization from the built-in cloud service', async () => {
    await api.cloudStartAuthorization();

    expect(invokeMock).toHaveBeenCalledWith('cloud_start_authorization');
  });

  it('exposes status, callback, refresh and disable commands', async () => {
    await api.cloudHandleCallback('nextdesk://auth/callback?code=abc&state=xyz');
    await api.cloudGetStatus();
    await api.cloudRefreshStatus();
    await api.cloudDisable();

    expect(invokeMock).toHaveBeenCalledWith('cloud_handle_callback', {
      callbackUrl: 'nextdesk://auth/callback?code=abc&state=xyz',
    });
    expect(invokeMock).toHaveBeenCalledWith('cloud_get_status');
    expect(invokeMock).toHaveBeenCalledWith('cloud_refresh_status');
    expect(invokeMock).toHaveBeenCalledWith('cloud_disable');
  });
});

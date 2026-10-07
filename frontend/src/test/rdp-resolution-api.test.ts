import { describe, expect, it, vi } from 'vitest';
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock, Channel: class {} }));
import { api } from '@/api';
describe('RDP resolution preference bridge', () => {
  it('loads and saves through native config', async () => {
    invokeMock.mockResolvedValueOnce('1920x1080').mockResolvedValueOnce(undefined);
    expect(await api.rdpResolutionGet()).toBe('1920x1080');
    await api.rdpResolutionSet('1280x720');
    expect(invokeMock.mock.calls).toEqual([
      ['rdp_resolution_get'],
      ['rdp_resolution_set', { mode: '1280x720' }],
    ]);
  });
});

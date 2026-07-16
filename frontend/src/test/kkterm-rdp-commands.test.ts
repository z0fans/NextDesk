import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  kktermRdpCtrlAltDelete,
  kktermRdpDisconnect,
  kktermRdpForceClipboardCheck,
  kktermRdpKey,
  kktermRdpPointer,
  kktermRdpSetActiveClipboardSession,
  kktermRdpSetBounds,
  kktermRdpStart,
  kktermRdpStatus,
  kktermRdpSyncDisplaySize,
  kktermRdpText,
} from '@/rdp/kkterm/commands';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

describe('kkterm RDP direct commands', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it('starts a KKTerm session through the native kkterm_rdp command namespace', async () => {
    await kktermRdpStart({
      tabId: 'tab-public',
      host: '64.20.10.254',
      port: 3389,
      username: 'administrator',
      password: 'secret',
      domain: 'ACME',
      desktopWidth: 1440,
      desktopHeight: 900,
      remoteResolution: '1440x900',
      redirectDrives: true,
      scaleFactor: 1.5,
    });

    expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_start', {
      request: {
        tabId: 'tab-public',
        host: '64.20.10.254',
        port: 3389,
        username: 'administrator',
        password: 'secret',
        domain: 'ACME',
        desktopWidth: 1440,
        desktopHeight: 900,
        remoteResolution: '1440x900',
        redirectDrives: true,
        scaleFactor: 1.5,
      },
    });
  });

  it('sends low-level KKTerm input directly to kkterm_rdp commands', async () => {
    await kktermRdpPointer({ tabId: 'tab-public', x: 10, y: 20, buttonMask: 1 });
    await kktermRdpKey({ tabId: 'tab-public', scancode: 0x1d, down: true });
    await kktermRdpText({ tabId: 'tab-public', text: 'hello' });
    await kktermRdpCtrlAltDelete({ tabId: 'tab-public' });
    await kktermRdpSetActiveClipboardSession('tab-public');
    await kktermRdpForceClipboardCheck({ tabId: 'tab-public' });
    await kktermRdpSetBounds({
      tabId: 'tab-public',
      x: 1,
      y: 2,
      width: 1280,
      height: 800,
      scaleFactor: 2,
      visible: true,
      clipRect: { x: 100, y: 120, width: 180, height: 220 },
      clipRects: [
        { x: 100, y: 120, width: 180, height: 220 },
        { x: 210, y: 88, width: 150, height: 62 },
      ],
    });
    await kktermRdpStatus({ tabId: 'tab-public' });
    await kktermRdpSyncDisplaySize({
      tabId: 'tab-public',
      x: 1,
      y: 2,
      width: 1280,
      height: 800,
      scaleFactor: 2,
      visible: true,
    });
    await kktermRdpDisconnect({ tabId: 'tab-public' });

    expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_pointer', {
      request: { tabId: 'tab-public', x: 10, y: 20, buttonMask: 1 },
    });
    expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_key', {
      request: { tabId: 'tab-public', scancode: 0x1d, down: true },
    });
    expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_text', {
      request: { tabId: 'tab-public', text: 'hello' },
    });
    expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_ctrl_alt_delete', {
      request: { tabId: 'tab-public' },
    });
    expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_set_active_clipboard_session', {
      tabId: 'tab-public',
    });
    expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_force_clipboard_check', {
      request: { tabId: 'tab-public' },
    });
    expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_set_bounds', {
      request: {
        tabId: 'tab-public',
        x: 1,
        y: 2,
        width: 1280,
        height: 800,
        scaleFactor: 2,
        visible: true,
        clipRect: { x: 100, y: 120, width: 180, height: 220 },
        clipRects: [
          { x: 100, y: 120, width: 180, height: 220 },
          { x: 210, y: 88, width: 150, height: 62 },
        ],
      },
    });
    expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_status', {
      request: { tabId: 'tab-public' },
    });
    expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_sync_display_size', {
      request: {
        tabId: 'tab-public',
        x: 1,
        y: 2,
        width: 1280,
        height: 800,
        scaleFactor: 2,
        visible: true,
      },
    });
    expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_disconnect', {
      request: { tabId: 'tab-public' },
    });
  });
});

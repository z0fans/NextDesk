import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RdpTabBar, type SessionControls } from '@/components/RdpTabBar';

vi.mock('@/i18n/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const baseControls: SessionControls = {
  resMode: 'adaptive',
  resolution: '1280x800',
  fps: null,
  presets: [{ label: 'Auto', value: 'adaptive' }],
  macClipboardStrategy: 'session-file-url',
  hasClipboardFolder: true,
  onApplyResolution: vi.fn(),
  onToggleClipboardStrategy: vi.fn(),
  onOpenClipboardFolder: vi.fn(),
  onSendClipboardText: vi.fn(),
  onSendWinKey: vi.fn(),
  onSendCtrlAltDel: vi.fn(),
  onDisconnect: vi.fn(),
};

describe('RdpTabBar session controls', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hides native clipboard management controls when the KKTerm engine only supports text injection', () => {
    const onSessionControlsMenuOpenChange = vi.fn();
    render(
      <RdpTabBar
        tabs={[{
          id: 'tab-1',
          serverId: 'server-1',
          name: '64.20.10.254',
          host: '64.20.10.254',
          status: 'connected',
          errorMsg: '',
        }]}
        activeTabId="tab-1"
        viewMode="tab"
        sidebarOpen
        onToggleSidebar={vi.fn()}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onViewModeChange={vi.fn()}
        onSessionControlsMenuOpenChange={onSessionControlsMenuOpenChange}
        sessionControls={{
          ...baseControls,
          showClipboardManagement: false,
        }}
      />,
    );

    fireEvent.click(screen.getByLabelText('RDP session controls'));

    expect(screen.queryByText(/rdpClipboard/)).not.toBeInTheDocument();
    expect(screen.queryByText('rdpFiles')).not.toBeInTheDocument();
    expect(screen.getByText('rdpSendClipboardText')).toBeInTheDocument();
    expect(onSessionControlsMenuOpenChange).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({
        x: expect.any(Number),
        y: expect.any(Number),
        width: expect.any(Number),
        height: expect.any(Number),
      }),
    );
  });

  it('reports an updated controls menu rect after opening the resolution submenu', () => {
    const onSessionControlsMenuOpenChange = vi.fn();
    const getBoundingClientRect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({
        x: 100,
        y: 120,
        left: 100,
        top: 120,
        right: 280,
        bottom: 260,
        width: 180,
        height: 140,
        toJSON: () => ({}),
      } as DOMRect);

    render(
      <RdpTabBar
        tabs={[{
          id: 'tab-1',
          serverId: 'server-1',
          name: '64.20.10.254',
          host: '64.20.10.254',
          status: 'connected',
          errorMsg: '',
        }]}
        activeTabId="tab-1"
        viewMode="tab"
        sidebarOpen
        onToggleSidebar={vi.fn()}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onViewModeChange={vi.fn()}
        onSessionControlsMenuOpenChange={onSessionControlsMenuOpenChange}
        sessionControls={{
          ...baseControls,
          presets: [
            { label: 'Auto', value: 'adaptive' },
            { label: '1920x1080', value: '1920x1080' },
          ],
          showClipboardManagement: false,
        }}
      />,
    );

    fireEvent.click(screen.getByLabelText('RDP session controls'));
    expect(onSessionControlsMenuOpenChange).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ height: 140 }),
    );

    getBoundingClientRect.mockReturnValue({
      x: 100,
      y: 120,
      left: 100,
      top: 120,
      right: 280,
      bottom: 380,
      width: 180,
      height: 260,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.click(screen.getByText('rdpResolution'));

    expect(onSessionControlsMenuOpenChange).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ height: 260 }),
    );
  });

  it('uses KKTerm ActiveX strict controls without direct Win or Ctrl+Alt+Del actions', () => {
    const onSendWinKey = vi.fn();
    const onSendCtrlAltDel = vi.fn();
    render(
      <RdpTabBar
        tabs={[{
          id: 'tab-1',
          serverId: 'server-1',
          name: '64.20.10.254',
          host: '64.20.10.254',
          status: 'connected',
          errorMsg: '',
        }]}
        activeTabId="tab-1"
        viewMode="tab"
        sidebarOpen
        onToggleSidebar={vi.fn()}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onViewModeChange={vi.fn()}
        sessionControls={{
          ...baseControls,
          showWinKey: false,
          ctrlAltDelMode: 'hint',
          onSendWinKey,
          onSendCtrlAltDel,
        }}
      />,
    );

    fireEvent.click(screen.getByLabelText('RDP session controls'));

    expect(screen.queryByText('rdpSendWinKey')).not.toBeInTheDocument();
    expect(screen.queryByText('rdpSendCtrlAltDel')).not.toBeInTheDocument();
    const hint = screen.getByText('rdpSendCtrlAltDelHint');
    expect(hint.closest('button')).toBeDisabled();

    fireEvent.click(hint);

    expect(onSendWinKey).not.toHaveBeenCalled();
    expect(onSendCtrlAltDel).not.toHaveBeenCalled();
  });

  it('reports the tab context menu rect for native overlay clipping', () => {
    const onOverlayClipRectChange = vi.fn();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({
        x: 210,
        y: 88,
        left: 210,
        top: 88,
        right: 360,
        bottom: 150,
        width: 150,
        height: 62,
        toJSON: () => ({}),
      } as DOMRect);

    render(
      <RdpTabBar
        tabs={[{
          id: 'tab-1',
          serverId: 'server-1',
          name: '64.20.10.254',
          host: '64.20.10.254',
          status: 'connected',
          errorMsg: '',
        }]}
        activeTabId="tab-1"
        viewMode="tab"
        sidebarOpen
        onToggleSidebar={vi.fn()}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onViewModeChange={vi.fn()}
        onReconnectTab={vi.fn()}
        onOverlayClipRectChange={onOverlayClipRectChange}
      />,
    );

    fireEvent.contextMenu(screen.getByText('64.20.10.254'));

    expect(onOverlayClipRectChange).toHaveBeenLastCalledWith(
      'tab-context-menu',
      true,
      expect.objectContaining({
        x: 210,
        y: 88,
        width: 150,
        height: 62,
      }),
    );
  });

  it('keeps the tab context menu in the tab bar instead of clipping ActiveX', () => {
    const onOverlayClipRectChange = vi.fn();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({
        x: 210,
        y: 88,
        left: 210,
        top: 88,
        right: 360,
        bottom: 150,
        width: 150,
        height: 62,
        toJSON: () => ({}),
      } as DOMRect);

    render(
      <RdpTabBar
        tabs={[{
          id: 'tab-1',
          serverId: 'server-1',
          name: '64.20.10.254',
          host: '64.20.10.254',
          status: 'connected',
          errorMsg: '',
        }]}
        activeTabId="tab-1"
        viewMode="tab"
        sidebarOpen
        onToggleSidebar={vi.fn()}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onViewModeChange={vi.fn()}
        onReconnectTab={vi.fn()}
        activeXSafeMenus
        onOverlayClipRectChange={onOverlayClipRectChange}
      />,
    );

    fireEvent.contextMenu(screen.getByText('64.20.10.254'));

    expect(screen.getByTestId('rdp-tab-context-menu')).toHaveClass('flex');
    expect(onOverlayClipRectChange).toHaveBeenLastCalledWith('tab-context-menu', false);
    expect(onOverlayClipRectChange).not.toHaveBeenCalledWith(
      'tab-context-menu',
      true,
      expect.anything(),
    );
  });
});

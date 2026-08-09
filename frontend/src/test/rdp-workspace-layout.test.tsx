import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RdpEmptyState } from '@/components/RdpEmptyState';
import { RdpSidebar } from '@/components/RdpSidebar';
import { translations } from '@/i18n/translations';
import type { SessionStore } from '@/lib/useSessionStore';

vi.mock('@/i18n/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key === 'rdpServers' ? '服务器' : key,
  }),
}));

function createStore(): SessionStore {
  return {
    groups: [
      { id: 'fav', name: 'Favorites', isExpanded: true },
      { id: 'default', name: 'Servers', isExpanded: true },
    ],
    servers: [],
    tabs: [],
    sidebarOpen: true,
    setSidebarOpen: vi.fn(),
    addGroup: vi.fn(),
    updateServer: vi.fn(),
    toggleGroupExpand: vi.fn(),
    reorderGroup: vi.fn(),
    renameGroup: vi.fn(),
    removeGroup: vi.fn(),
  } as unknown as SessionStore;
}

describe('RDP workspace layout', () => {
  it('keeps the built-in server group localized in Chinese and English', () => {
    expect(translations['zh-CN'].rdpServers).toBe('服务器');
    expect(translations['en-US'].rdpServers).toBe('Servers');
  });

  it('aligns the sidebar header and footer with the app navigation rails', () => {
    const { container } = render(
      <RdpSidebar
        store={createStore()}
        selectedServerId={null}
        onConnectServer={vi.fn()}
        onSelectServer={vi.fn()}
        onNewServer={vi.fn()}
        onEditServer={vi.fn()}
        onDeleteServer={vi.fn()}
      />,
    );

    expect(
      container.querySelector('[data-region="rdp-sidebar-header"]'),
    ).toHaveClass('h-[73px]', 'shrink-0', 'items-center');
    expect(
      container.querySelector('[data-region="rdp-sidebar-actions"]'),
    ).toHaveClass('h-11', 'shrink-0', 'items-center');
  });

  it('localizes only the built-in server group name', () => {
    render(
      <RdpSidebar
        store={createStore()}
        selectedServerId={null}
        onConnectServer={vi.fn()}
        onSelectServer={vi.fn()}
        onNewServer={vi.fn()}
        onEditServer={vi.fn()}
        onDeleteServer={vi.fn()}
      />,
    );

    expect(screen.getAllByText('服务器')).toHaveLength(2);
    expect(screen.queryByText('Servers')).not.toBeInTheDocument();
  });

  it('matches the SSH empty-state structure while preserving the RDP button gradient', () => {
    const onNewServer = vi.fn();
    const { container } = render(
      <RdpEmptyState onNewServer={onNewServer} />,
    );

    expect(
      container.querySelector('[data-region="rdp-empty-state"]'),
    ).toHaveClass(
      'bg-[radial-gradient(circle_at_center,_rgba(8,145,178,0.08),_transparent_45%)]',
    );
    expect(
      container.querySelector('[data-region="rdp-empty-state-icon"]'),
    ).toHaveClass('h-14', 'w-14', 'rounded-xl', 'border-cyan-500/20');

    const button = screen.getByRole('button', { name: 'rdpNewConnection' });
    expect(button).toHaveClass(
      'bg-gradient-to-r',
      'from-cyan-600',
      'to-blue-600',
    );
    expect(button.querySelector('.lucide-plus')).toBeInTheDocument();

    fireEvent.click(button);
    expect(onNewServer).toHaveBeenCalledOnce();
  });
});

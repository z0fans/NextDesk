import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NewConnectionDialog } from '@/components/NewConnectionDialog';
import type { SessionStore } from '@/lib/useSessionStore';
import type { ServerEntry } from '@/lib/rdp-types';

vi.mock('@/i18n/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const editServer: ServerEntry = {
  id: 'server-1',
  name: 'Test server',
  host: '192.0.2.10',
  port: 3389,
  username: 'Administrator',
  password: 'secret-password',
  domain: '',
  groupId: 'default',
  isFavorite: false,
  colorTag: '#3B82F6',
};

const store = {
  groups: [
    { id: 'fav', name: 'Favorites', isExpanded: true },
    { id: 'default', name: 'Servers', isExpanded: true },
  ],
} as unknown as SessionStore;

describe('NewConnectionDialog password visibility', () => {
  it('saves new servers in zero-choice intelligent mode by default', () => {
    const addServer = vi.fn().mockReturnValue({ id: 'new-server' });
    const onSaved = vi.fn();
    const writableStore = { ...store, addServer } as unknown as SessionStore;

    render(
      <NewConnectionDialog
        store={writableStore}
        open
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('192.168.1.100'), {
      target: { value: '203.0.113.10' },
    });
    fireEvent.change(screen.getByPlaceholderText('Administrator'), {
      target: { value: 'administrator' },
    });
    expect(screen.getByRole('combobox')).toHaveValue('auto');
    fireEvent.click(screen.getByRole('button', { name: 'rdpSaveAndConnect' }));

    expect(addServer).toHaveBeenCalledWith(expect.objectContaining({
      host: '203.0.113.10',
      routePolicy: 'auto',
    }));
    expect(onSaved).toHaveBeenCalledWith('new-server', true);
  });

  it('stores a route override only for the last anonymous network scope', () => {
    const updateServer = vi.fn();
    const scopedServer: ServerEntry = {
      ...editServer,
      routePolicy: 'auto',
      lastNetworkScopeId: '0123456789abcdef0123456789abcdef',
      networkRoutePreferences: {
        '0123456789abcdef0123456789abcdef': 'cloud_only',
      },
    };
    const writableStore = { ...store, updateServer } as unknown as SessionStore;

    render(
      <NewConnectionDialog
        store={writableStore}
        open
        onClose={vi.fn()}
        onSaved={vi.fn()}
        editServer={scopedServer}
      />,
    );

    expect(screen.getByRole('combobox')).toHaveValue('cloud_only');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'direct' } });
    fireEvent.click(screen.getByRole('button', { name: 'rdpSave' }));

    expect(updateServer).toHaveBeenCalledWith('server-1', expect.objectContaining({
      routePolicy: 'auto',
      networkRoutePreferences: {
        '0123456789abcdef0123456789abcdef': 'direct',
      },
    }));
  });

  it('localizes the built-in default group without changing custom group names', () => {
    const localizedStore = {
      groups: [
        { id: 'fav', name: 'Favorites', isExpanded: true },
        { id: 'default', name: 'Servers', isExpanded: true },
        { id: 'production', name: 'Production', isExpanded: true },
      ],
    } as unknown as SessionStore;

    render(
      <NewConnectionDialog
        store={localizedStore}
        open
        onClose={vi.fn()}
        onSaved={vi.fn()}
        editServer={editServer}
      />,
    );

    const groupSelect = screen.getByRole('button', { name: 'rdpServers' });
    expect(groupSelect).toBeInTheDocument();
    fireEvent.click(groupSelect);

    expect(screen.getAllByText('rdpServers')).toHaveLength(2);
    expect(screen.getByText('Production')).toBeInTheDocument();
    expect(screen.queryByText('Servers')).not.toBeInTheDocument();
  });

  it('shows and hides the saved password from the trailing eye button', () => {
    render(
      <NewConnectionDialog
        store={store}
        open
        onClose={vi.fn()}
        onSaved={vi.fn()}
        editServer={editServer}
      />,
    );

    const passwordInput = screen.getByDisplayValue('secret-password') as HTMLInputElement;

    expect(passwordInput).toHaveAttribute('type', 'password');

    fireEvent.click(screen.getByRole('button', { name: 'rdpShowPassword' }));
    expect(passwordInput).toHaveAttribute('type', 'text');

    fireEvent.click(screen.getByRole('button', { name: 'rdpHidePassword' }));
    expect(passwordInput).toHaveAttribute('type', 'password');
  });
});

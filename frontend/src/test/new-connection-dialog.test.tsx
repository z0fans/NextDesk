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

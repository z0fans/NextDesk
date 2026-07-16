import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AccountPage } from '@/components/AccountPage';
import { translations } from '@/i18n/translations';

vi.mock('@/i18n/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: keyof typeof translations['zh-CN']) => translations['zh-CN'][key] ?? key,
  }),
}));

describe('AccountPage', () => {
  it('offers device authorization while signed out', () => {
    const onAuthorize = vi.fn();

    render(
      <AccountPage
        status={null}
        authorizing={false}
        refreshing={false}
        refreshMessage=""
        onAuthorize={onAuthorize}
        onRefresh={vi.fn()}
        onSignOut={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '登录并启用云端加速' }));
    expect(onAuthorize).toHaveBeenCalledOnce();
  });

  it('shows account status and sign out while authorized', () => {
    render(
      <AccountPage
        status={{
          enabled: true,
          authorized: true,
          account_available: true,
          account_available_until: '2026-08-01T00:00:00Z',
          device_expires_at: '2026-08-02T00:00:00Z',
          display: 'user@example.com',
        }}
        authorizing={false}
        refreshing={false}
        refreshMessage=""
        onAuthorize={vi.fn()}
        onRefresh={vi.fn()}
        onSignOut={vi.fn()}
      />,
    );

    expect(screen.getByText('user@example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '退出登录' })).toBeInTheDocument();
  });

  it('shows an unavailable entitlement as expired instead of cloud-ready', () => {
    render(
      <AccountPage
        status={{
          enabled: true,
          authorized: true,
          account_available: false,
          display: 'user@example.com',
          reason: 'account_expired',
        }}
        authorizing={false}
        refreshing={false}
        refreshMessage=""
        onAuthorize={vi.fn()}
        onRefresh={vi.fn()}
        onSignOut={vi.fn()}
      />,
    );

    expect(screen.getByText('授权不可用')).toBeInTheDocument();
    expect(screen.getByText('account_expired')).toBeInTheDocument();
    expect(screen.queryByText('已授权')).not.toBeInTheDocument();
  });

  it('shows visible feedback while refreshing account status', () => {
    render(
      <AccountPage
        status={{
          enabled: true,
          authorized: true,
          account_available: true,
          display: 'user@example.com',
        }}
        authorizing={false}
        refreshing
        refreshMessage="账户状态已更新"
        onAuthorize={vi.fn()}
        onRefresh={vi.fn()}
        onSignOut={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '刷新中...' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('账户状态已更新');
  });

  it('shows cloud availability instead of a dash when no expiry is provided', () => {
    render(
      <AccountPage
        status={{
          enabled: true,
          authorized: true,
          account_available: true,
          account_available_until: null,
          device_expires_at: '2026-10-03T16:09:34Z',
          display: 'user@example.com',
        }}
        authorizing={false}
        refreshing={false}
        refreshMessage=""
        onAuthorize={vi.fn()}
        onRefresh={vi.fn()}
        onSignOut={vi.fn()}
      />,
    );

    expect(screen.getByText('云端加速')).toBeInTheDocument();
    expect(screen.getByText('可用')).toBeInTheDocument();
    expect(screen.queryByText('-')).not.toBeInTheDocument();
  });
});

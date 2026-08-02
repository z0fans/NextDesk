import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SSH_CONNECTIONS_STORAGE_KEY } from '@/ssh/connection-store';

const terminalProps = vi.hoisted(() => new Map<string, {
  sessionId: string;
  retryToken: number;
  connection: {
    id: string;
    credentialReference?: string;
  };
  onEvent: (event: {
    kind: 'state';
    sessionId: string;
    state: string;
    routeLabel?: string;
    message?: string;
  }) => void;
}>());

const credentialApi = vi.hoisted(() => ({
  storeCredential: vi.fn<(...args: [string, string]) => Promise<void>>(),
  storePrivateKeyCredential: vi.fn<(
    ...args: [string, string, string, string?, string?]
  ) => Promise<void>>(),
  deleteCredential: vi.fn<(...args: [string]) => Promise<void>>(),
}));

vi.mock('@/i18n/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/ssh/TerminalSurface', () => ({
  TerminalSurface: (props: {
    sessionId: string;
    connection: { id: string };
    visible: boolean;
    retryToken: number;
    onEvent: (event: {
      kind: 'state';
      sessionId: string;
      state: string;
      routeLabel?: string;
      message?: string;
    }) => void;
  }) => {
    terminalProps.set(props.connection.id, props);
    return <div data-testid={`terminal-${props.connection.id}`} data-visible={String(props.visible)} />;
  },
}));

vi.mock('@/ssh/ssh-api', () => ({
  sshApi: credentialApi,
}));

vi.mock('@/ssh/SftpPanel', () => ({
  SftpPanel: ({ sessionId, visible }: { sessionId: string; visible: boolean }) => (
    <div data-testid={`sftp-${sessionId}`} data-visible={String(visible)} />
  ),
}));

import { SshWorkspace } from '@/ssh/SshWorkspace';

describe('SSH workspace', () => {
  beforeEach(() => {
    terminalProps.clear();
    credentialApi.storeCredential.mockReset().mockResolvedValue(undefined);
    credentialApi.storePrivateKeyCredential.mockReset().mockResolvedValue(undefined);
    credentialApi.deleteCredential.mockReset().mockResolvedValue(undefined);
    localStorage.clear();
    localStorage.setItem(
      SSH_CONNECTIONS_STORAGE_KEY,
      JSON.stringify([
        {
          id: 'alpha',
          name: 'Alpha',
          host: 'alpha.example.com',
          port: 22,
          username: 'root',
          authMethod: 'password',
          credentialReference: 'ssh-alpha',
          routePolicy: 'auto',
        },
        {
          id: 'beta',
          name: 'Beta',
          host: 'beta.example.com',
          port: 22,
          username: 'root',
          authMethod: 'password',
          credentialReference: 'ssh-beta',
          routePolicy: 'direct',
        },
      ]),
    );
  });

  it('uses application theme tokens for workspace chrome and the empty state', () => {
    const { container } = render(<SshWorkspace isVisible />);
    const workspace = container.firstElementChild;
    const connectionSidebar = workspace?.querySelector('aside');

    expect(workspace).toHaveClass('bg-background', 'text-foreground');
    expect(workspace).not.toHaveClass('bg-[#080d16]', 'text-slate-100');
    expect(connectionSidebar).toHaveClass('bg-sidebar', 'border-sidebar-border');
    expect(screen.getByText('sshWorkspaceEmptyTitle')).toHaveClass('text-foreground');
    expect(screen.getByText('sshWorkspaceEmptyDesc')).toHaveClass('text-muted-foreground');
  });

  it('selects a saved connection on single click and opens it on double click', async () => {
    const user = userEvent.setup();
    render(<SshWorkspace isVisible />);
    const alpha = screen.getByRole('button', { name: 'sshConnect Alpha' });

    await user.click(alpha);
    expect(alpha).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Alpha')).toHaveClass('text-cyan-300');
    expect(screen.queryByTestId('terminal-alpha')).not.toBeInTheDocument();

    await user.click(alpha);
    expect(alpha).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Alpha')).toHaveClass('text-sidebar-foreground');

    await user.dblClick(alpha);
    expect(screen.getByTestId('terminal-alpha')).toHaveAttribute('data-visible', 'true');
  });

  it('keeps inactive terminals mounted while switching session tabs', () => {
    render(<SshWorkspace isVisible />);

    fireEvent.doubleClick(screen.getByRole('button', { name: 'sshConnect Alpha' }));
    fireEvent.doubleClick(screen.getByRole('button', { name: 'sshConnect Beta' }));

    const alpha = screen.getByTestId('terminal-alpha');
    const beta = screen.getByTestId('terminal-beta');
    expect(alpha).toHaveAttribute('data-visible', 'false');
    expect(beta).toHaveAttribute('data-visible', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    expect(alpha).toHaveAttribute('data-visible', 'true');
    expect(beta).toHaveAttribute('data-visible', 'false');
  });

  it('opens the SFTP browser only after the SSH session is connected', () => {
    render(<SshWorkspace isVisible />);
    fireEvent.doubleClick(screen.getByRole('button', { name: 'sshConnect Alpha' }));
    const session = terminalProps.get('alpha');
    const filesButton = screen.getByRole('button', { name: 'sftpOpenFiles' });
    expect(filesButton).toBeDisabled();

    act(() => {
      session?.onEvent({
        kind: 'state',
        sessionId: session.sessionId,
        state: 'connected',
      });
    });
    expect(filesButton).toBeEnabled();
    fireEvent.click(filesButton);

    expect(screen.getByTestId(`sftp-${session?.sessionId}`)).toHaveAttribute('data-visible', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'sftpCloseFiles' }));
    expect(screen.getByTestId(`sftp-${session?.sessionId}`)).toHaveAttribute('data-visible', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'sftpOpenFiles' }));
    expect(screen.getByTestId(`sftp-${session?.sessionId}`)).toHaveAttribute('data-visible', 'true');
  });

  it('edits a saved connection from the right-click menu without opening a session', () => {
    render(<SshWorkspace isVisible />);

    fireEvent.contextMenu(screen.getByRole('button', { name: 'sshConnect Alpha' }), {
      clientX: 120,
      clientY: 80,
    });
    fireEvent.click(screen.getByRole('button', { name: 'sshEdit' }));

    expect(screen.getByRole('heading', { name: 'sshEditConnection' })).toBeInTheDocument();
    expect(screen.getByLabelText('sshName')).toHaveValue('Alpha');
    expect(screen.getByLabelText('sshHost')).toHaveValue('alpha.example.com');
    expect(screen.getByLabelText('port')).toHaveValue(22);
    expect(screen.getByLabelText('sshUsername')).toHaveValue('root');

    fireEvent.change(screen.getByLabelText('sshName'), { target: { value: 'Alpha Updated' } });
    fireEvent.change(screen.getByLabelText('sshHost'), { target: { value: 'new-alpha.example.com' } });
    fireEvent.change(screen.getByLabelText('port'), { target: { value: '2222' } });
    fireEvent.change(screen.getByLabelText('sshUsername'), { target: { value: 'deploy' } });
    fireEvent.change(screen.getByLabelText('sshRoutePolicy'), { target: { value: 'direct' } });
    fireEvent.click(screen.getByRole('button', { name: 'sshSave' }));

    expect(screen.getByText('Alpha Updated')).toBeInTheDocument();
    expect(screen.getByText('deploy@new-alpha.example.com:2222')).toBeInTheDocument();
    expect(terminalProps.get('alpha')).toBeUndefined();

    const saved = JSON.parse(localStorage.getItem(SSH_CONNECTIONS_STORAGE_KEY) ?? '[]');
    expect(saved[0]).toMatchObject({
      id: 'alpha',
      name: 'Alpha Updated',
      host: 'new-alpha.example.com',
      port: 2222,
      username: 'deploy',
      routePolicy: 'direct',
      credentialReference: 'ssh-alpha',
    });
  });

  it('uses an in-app authentication control and stores pasted private keys outside connection metadata', async () => {
    render(<SshWorkspace isVisible />);
    fireEvent.click(screen.getAllByRole('button', { name: 'sshNewConnection' })[0]);

    expect(screen.getByRole('radiogroup', { name: 'sshAuthentication' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'sshAuthentication' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'sshPrivateKey' }));
    fireEvent.change(screen.getByLabelText('sshHost'), { target: { value: 'key.example.com' } });
    fireEvent.change(screen.getByLabelText('sshPrivateKeyLabel'), { target: { value: 'Deployment key' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'sshPrivateKeyContent' }), {
      target: { value: '-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-material\n-----END OPENSSH PRIVATE KEY-----' },
    });
    fireEvent.change(screen.getByLabelText('sshPublicKey'), {
      target: { value: 'ssh-ed25519 AAAATEST deployment@example' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'sshSaveAndConnect' }));

    await waitFor(() => expect(credentialApi.storePrivateKeyCredential).toHaveBeenCalledOnce());
    const [credentialReference, storedLabel, storedPrivateKey, storedPublicKey, storedPassphrase] =
      credentialApi.storePrivateKeyCredential.mock.calls[0];
    expect(credentialReference).toMatch(/^ssh-/);
    expect(storedLabel).toBe('Deployment key');
    expect(storedPrivateKey).toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(storedPublicKey).toBe('ssh-ed25519 AAAATEST deployment@example');
    expect(storedPassphrase).toBeUndefined();

    const savedRaw = localStorage.getItem(SSH_CONNECTIONS_STORAGE_KEY) ?? '';
    expect(savedRaw).not.toContain('private-material');
    expect(JSON.parse(savedRaw).at(-1)).toMatchObject({
      authMethod: 'private_key',
      privateKeyLabel: 'Deployment key',
      publicKey: 'ssh-ed25519 AAAATEST deployment@example',
      credentialReference,
    });
  });

  it('versions a replacement credential without changing an active session snapshot', async () => {
    render(<SshWorkspace isVisible />);
    fireEvent.doubleClick(screen.getByRole('button', { name: 'sshConnect Alpha' }));

    fireEvent.contextMenu(screen.getByRole('button', { name: 'sshConnect Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'sshEdit' }));
    fireEvent.change(screen.getByPlaceholderText('sshKeepSavedCredential'), {
      target: { value: 'replacement-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'sshSave' }));

    await waitFor(() => expect(credentialApi.storeCredential).toHaveBeenCalledOnce());
    const [newReference] = credentialApi.storeCredential.mock.calls[0];
    expect(newReference).not.toBe('ssh-alpha');
    expect(terminalProps.get('alpha')?.connection.credentialReference).toBe('ssh-alpha');
    expect(credentialApi.deleteCredential).not.toHaveBeenCalled();

    const savedRaw = localStorage.getItem(SSH_CONNECTIONS_STORAGE_KEY) ?? '';
    expect(savedRaw).not.toContain('replacement-secret');
    expect(JSON.parse(savedRaw)[0].credentialReference).toBe(newReference);
  });

  it('keeps an active session credential when the saved connection changes authentication', async () => {
    render(<SshWorkspace isVisible />);
    fireEvent.doubleClick(screen.getByRole('button', { name: 'sshConnect Alpha' }));

    fireEvent.contextMenu(screen.getByRole('button', { name: 'sshConnect Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'sshEdit' }));
    fireEvent.click(screen.getByRole('radio', { name: 'sshPrivateKey' }));
    fireEvent.change(screen.getByLabelText('sshPrivateKeyLabel'), {
      target: { value: 'Alpha deployment key' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'sshPrivateKeyContent' }), {
      target: {
        value: '-----BEGIN OPENSSH PRIVATE KEY-----\nreplacement-key\n-----END OPENSSH PRIVATE KEY-----',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'sshSave' }));

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'sshEditConnection' })).not.toBeInTheDocument());
    expect(terminalProps.get('alpha')?.connection.credentialReference).toBe('ssh-alpha');
    expect(credentialApi.deleteCredential).not.toHaveBeenCalled();
    const saved = JSON.parse(localStorage.getItem(SSH_CONNECTIONS_STORAGE_KEY) ?? '[]')[0];
    expect(saved.credentialReference).not.toBe('ssh-alpha');
    expect(saved.privateKeyLabel).toBe('Alpha deployment key');
  });

  it('keeps a legacy private-key path when adding its passphrase', async () => {
    localStorage.setItem(
      SSH_CONNECTIONS_STORAGE_KEY,
      JSON.stringify([{
        id: 'legacy-key',
        name: 'Legacy key',
        host: 'legacy.example.com',
        port: 22,
        username: 'root',
        authMethod: 'private_key',
        privateKeyPath: '~/.ssh/id_ed25519',
        routePolicy: 'direct',
      }]),
    );
    render(<SshWorkspace isVisible />);

    fireEvent.contextMenu(screen.getByRole('button', { name: 'sshConnect Legacy key' }));
    fireEvent.click(screen.getByRole('button', { name: 'sshEdit' }));
    fireEvent.change(screen.getByLabelText('sshPassphraseOptional'), {
      target: { value: 'legacy-passphrase' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'sshSave' }));

    await waitFor(() => expect(credentialApi.storeCredential).toHaveBeenCalledOnce());
    expect(credentialApi.storePrivateKeyCredential).not.toHaveBeenCalled();
    const saved = JSON.parse(localStorage.getItem(SSH_CONNECTIONS_STORAGE_KEY) ?? '[]')[0];
    expect(saved.privateKeyPath).toBe('~/.ssh/id_ed25519');
    expect(saved.credentialReference).toMatch(/^ssh-legacy-key-/);
  });

  it('shows direct fallback distinctly and retries the same session lease', () => {
    render(<SshWorkspace isVisible />);
    fireEvent.doubleClick(screen.getByRole('button', { name: 'sshConnect Alpha' }));
    const first = terminalProps.get('alpha');
    expect(first).toBeDefined();

    act(() => {
      first?.onEvent({
        kind: 'state',
        sessionId: first.sessionId,
        state: 'error',
        routeLabel: 'cloud_fallback',
        message: 'ssh_transport_connect_failed:connection reset',
      });
    });

    expect(screen.getByText('sshCloudFallback')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'sshReconnect' }));
    const retried = terminalProps.get('alpha');
    expect(retried?.sessionId).toBe(first?.sessionId);
    expect(retried?.retryToken).toBe(1);
  });

  it('renders session failures as an opaque in-flow alert with a specific message', () => {
    render(<SshWorkspace isVisible />);
    fireEvent.doubleClick(screen.getByRole('button', { name: 'sshConnect Alpha' }));
    const session = terminalProps.get('alpha');

    act(() => {
      session?.onEvent({
        kind: 'state',
        sessionId: session.sessionId,
        state: 'error',
        message: 'ssh_session_already_exists',
      });
    });

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('sshErrorSessionBusy');
    expect(alert).toHaveClass('bg-popover');
    expect(alert).not.toHaveClass('absolute', 'bg-destructive/10');
  });

  it('does not present a normal remote exit status as a session error', () => {
    render(<SshWorkspace isVisible />);
    fireEvent.doubleClick(screen.getByRole('button', { name: 'sshConnect Alpha' }));
    const session = terminalProps.get('alpha');

    act(() => {
      session?.onEvent({
        kind: 'state',
        sessionId: session.sessionId,
        state: 'exited',
        message: '0',
      });
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('sshErrorGeneric')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'sshReconnect' })).toBeInTheDocument();
  });

  it('preserves the first transport failure when a lifecycle error arrives later', () => {
    render(<SshWorkspace isVisible />);
    fireEvent.doubleClick(screen.getByRole('button', { name: 'sshConnect Alpha' }));
    const session = terminalProps.get('alpha');

    act(() => {
      session?.onEvent({
        kind: 'state',
        sessionId: session.sessionId,
        state: 'error',
        routeLabel: 'cloud_fallback',
        message: 'ssh_transport_connect_failed',
      });
      session?.onEvent({
        kind: 'state',
        sessionId: session.sessionId,
        state: 'error',
        message: 'ssh_session_closed',
      });
    });

    expect(screen.getByRole('alert')).toHaveTextContent('sshErrorTransport');
    expect(screen.getByText('sshCloudFallback')).toBeInTheDocument();
  });
});

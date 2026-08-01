import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SSH_CONNECTIONS_STORAGE_KEY } from '@/ssh/connection-store';

const terminalProps = vi.hoisted(() => new Map<string, {
  sessionId: string;
  retryToken: number;
  onEvent: (event: {
    kind: 'state';
    sessionId: string;
    state: string;
    routeLabel?: string;
    message?: string;
  }) => void;
}>());

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

import { SshWorkspace } from '@/ssh/SshWorkspace';

describe('SSH workspace', () => {
  beforeEach(() => {
    terminalProps.clear();
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

  it('keeps inactive terminals mounted while switching session tabs', () => {
    render(<SshWorkspace isVisible />);

    fireEvent.click(screen.getByRole('button', { name: 'sshConnect Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'sshConnect Beta' }));

    const alpha = screen.getByTestId('terminal-alpha');
    const beta = screen.getByTestId('terminal-beta');
    expect(alpha).toHaveAttribute('data-visible', 'false');
    expect(beta).toHaveAttribute('data-visible', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    expect(alpha).toHaveAttribute('data-visible', 'true');
    expect(beta).toHaveAttribute('data-visible', 'false');
  });

  it('shows direct fallback distinctly and retries the same session lease', () => {
    render(<SshWorkspace isVisible />);
    fireEvent.click(screen.getByRole('button', { name: 'sshConnect Alpha' }));
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
});

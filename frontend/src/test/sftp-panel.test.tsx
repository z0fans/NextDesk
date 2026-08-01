import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sftpApi = vi.hoisted(() => ({
  sshSftpOpen: vi.fn(),
  sshSftpList: vi.fn(),
  sshSftpCreateDirectory: vi.fn(),
  sshSftpRename: vi.fn(),
  sshSftpRemove: vi.fn(),
  sshSftpUpload: vi.fn(),
  sshSftpDownload: vi.fn(),
  sshSftpCancel: vi.fn(),
  sshSftpChooseUploadPath: vi.fn(),
  sshSftpChooseDownloadPath: vi.fn(),
}));

const translate = vi.hoisted(() => (key: string) => key);

vi.mock('@/i18n/useTranslation', () => ({
  useTranslation: () => ({ t: translate }),
}));

vi.mock('@/api', () => ({ api: sftpApi }));

import { SftpPanel } from '@/ssh/SftpPanel';

describe('SFTP panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sftpApi.sshSftpOpen.mockResolvedValue({ path: '/home/root' });
    sftpApi.sshSftpList.mockImplementation(async (_sessionId: string, path: string) => ({
      path,
      entries: path === '/home/root'
        ? [
            {
              name: 'logs',
              path: '/home/root/logs',
              kind: 'directory',
              size: 0,
              modified: 1_722_470_400,
            },
            {
              name: 'notes.txt',
              path: '/home/root/notes.txt',
              kind: 'file',
              size: 12,
              modified: 1_722_470_500,
            },
          ]
        : [],
    }));
    sftpApi.sshSftpChooseUploadPath.mockResolvedValue(null);
    sftpApi.sshSftpChooseDownloadPath.mockResolvedValue(null);
  });

  it('opens the SFTP subsystem and browses a remote directory', async () => {
    render(<SftpPanel sessionId="ssh-alpha" visible />);

    expect(await screen.findByText('notes.txt')).toBeInTheDocument();
    expect(screen.getByText('logs')).toBeInTheDocument();
    expect(screen.getByText('/home/root')).toBeInTheDocument();
    expect(sftpApi.sshSftpOpen).toHaveBeenCalledWith('ssh-alpha');
    expect(sftpApi.sshSftpList).toHaveBeenCalledWith('ssh-alpha', '/home/root');

    fireEvent.doubleClick(screen.getByRole('button', { name: 'logs' }));
    await waitFor(() => {
      expect(sftpApi.sshSftpList).toHaveBeenLastCalledWith('ssh-alpha', '/home/root/logs');
    });
  });

  it('uploads with progress and lets the user cancel the transfer', async () => {
    sftpApi.sshSftpChooseUploadPath.mockResolvedValue('/tmp/report.txt');
    sftpApi.sshSftpUpload.mockImplementation(async (
      request: { transferId: string },
      onProgress: (event: Record<string, unknown>) => void,
    ) => {
      onProgress({
        transferId: request.transferId,
        direction: 'upload',
        state: 'running',
        transferredBytes: 5,
        totalBytes: 10,
      });
      return new Promise(() => {});
    });
    sftpApi.sshSftpCancel.mockResolvedValue(undefined);
    render(<SftpPanel sessionId="ssh-alpha" visible />);
    await screen.findByText('notes.txt');

    fireEvent.click(screen.getByRole('button', { name: 'sftpUpload' }));
    await waitFor(() => expect(sftpApi.sshSftpUpload).toHaveBeenCalledOnce());
    expect(sftpApi.sshSftpUpload.mock.calls[0][0]).toMatchObject({
      sessionId: 'ssh-alpha',
      localPath: '/tmp/report.txt',
      remotePath: '/home/root/report.txt',
      overwrite: false,
    });
    expect(await screen.findByText('50%')).toBeInTheDocument();
    expect(screen.getByText('5 B / 10 B')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'sftpCancelTransfer report.txt' }));
    expect(sftpApi.sshSftpCancel).toHaveBeenCalledWith(
      'ssh-alpha',
      sftpApi.sshSftpUpload.mock.calls[0][0].transferId,
    );
  });

  it('downloads the selected remote file to a user-chosen local path', async () => {
    sftpApi.sshSftpChooseDownloadPath.mockResolvedValue('/tmp/notes.txt');
    sftpApi.sshSftpDownload.mockImplementation(async (
      request: { transferId: string },
      onProgress: (event: Record<string, unknown>) => void,
    ) => {
      onProgress({
        transferId: request.transferId,
        direction: 'download',
        state: 'completed',
        transferredBytes: 12,
        totalBytes: 12,
      });
    });
    render(<SftpPanel sessionId="ssh-alpha" visible />);
    await screen.findByText('notes.txt');

    fireEvent.click(screen.getByRole('button', { name: 'notes.txt' }));
    fireEvent.click(screen.getByRole('button', { name: 'sftpDownload' }));

    await waitFor(() => expect(sftpApi.sshSftpDownload).toHaveBeenCalledOnce());
    expect(sftpApi.sshSftpDownload.mock.calls[0][0]).toMatchObject({
      sessionId: 'ssh-alpha',
      localPath: '/tmp/notes.txt',
      remotePath: '/home/root/notes.txt',
      overwrite: false,
    });
  });

  it('creates, renames, and deletes remote entries from the file toolbar', async () => {
    sftpApi.sshSftpCreateDirectory.mockResolvedValue(undefined);
    sftpApi.sshSftpRename.mockResolvedValue(undefined);
    sftpApi.sshSftpRemove.mockResolvedValue(undefined);
    render(<SftpPanel sessionId="ssh-alpha" visible />);
    await screen.findByText('notes.txt');

    fireEvent.click(screen.getByRole('button', { name: 'sftpNewFolder' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'sftpName' }), {
      target: { value: 'archive' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'sftpCreate' }));
    await waitFor(() => expect(sftpApi.sshSftpCreateDirectory).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'ssh-alpha',
      path: '/home/root/archive',
    })));

    fireEvent.click(screen.getByRole('button', { name: 'notes.txt' }));
    fireEvent.click(screen.getByRole('button', { name: 'sftpRename' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'sftpName' }), {
      target: { value: 'renamed.txt' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'sftpSave' }));
    await waitFor(() => expect(sftpApi.sshSftpRename).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'ssh-alpha',
      fromPath: '/home/root/notes.txt',
      toPath: '/home/root/renamed.txt',
      overwrite: false,
    })));

    fireEvent.click(screen.getByRole('button', { name: 'logs' }));
    fireEvent.click(screen.getByRole('button', { name: 'sftpDelete' }));
    fireEvent.click(screen.getByRole('button', { name: 'sftpConfirmDelete' }));
    await waitFor(() => expect(sftpApi.sshSftpRemove).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'ssh-alpha',
      path: '/home/root/logs',
      recursive: true,
    })));
  });

  it('asks before overwriting and retries an upload only after confirmation', async () => {
    sftpApi.sshSftpChooseUploadPath.mockResolvedValue('/tmp/notes.txt');
    sftpApi.sshSftpUpload
      .mockRejectedValueOnce(new Error('sftp_remote_exists'))
      .mockResolvedValueOnce(undefined);
    render(<SftpPanel sessionId="ssh-alpha" visible />);
    await screen.findByText('notes.txt');

    fireEvent.click(screen.getByRole('button', { name: 'sftpUpload' }));
    expect(await screen.findByText('sftpOverwriteTitle')).toBeInTheDocument();
    expect(sftpApi.sshSftpUpload).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'sftpConfirmOverwrite' }));
    await waitFor(() => expect(sftpApi.sshSftpUpload).toHaveBeenCalledTimes(2));
    expect(sftpApi.sshSftpUpload.mock.calls[1][0]).toMatchObject({
      remotePath: '/home/root/notes.txt',
      overwrite: true,
    });
  });

  it('uses the final file name from a Windows upload path', async () => {
    sftpApi.sshSftpChooseUploadPath.mockResolvedValue('C:\\Users\\Administrator\\report.txt');
    sftpApi.sshSftpUpload.mockResolvedValue(undefined);
    render(<SftpPanel sessionId="ssh-alpha" visible />);
    await screen.findByText('notes.txt');

    fireEvent.click(screen.getByRole('button', { name: 'sftpUpload' }));

    await waitFor(() => expect(sftpApi.sshSftpUpload).toHaveBeenCalledOnce());
    expect(sftpApi.sshSftpUpload.mock.calls[0][0]).toMatchObject({
      localPath: 'C:\\Users\\Administrator\\report.txt',
      remotePath: '/home/root/report.txt',
    });
  });

  it('keeps a cancelled transfer cancelled when the command rejects after its final event', async () => {
    sftpApi.sshSftpChooseUploadPath.mockResolvedValue('/tmp/report.txt');
    sftpApi.sshSftpUpload.mockImplementation(async (
      request: { transferId: string },
      onProgress: (event: Record<string, unknown>) => void,
    ) => {
      onProgress({
        transferId: request.transferId,
        direction: 'upload',
        state: 'cancelled',
        transferredBytes: 5,
        totalBytes: 10,
        message: 'sftp_transfer_cancelled',
      });
      throw new Error('sftp_transfer_cancelled');
    });
    render(<SftpPanel sessionId="ssh-alpha" visible />);
    await screen.findByText('notes.txt');

    fireEvent.click(screen.getByRole('button', { name: 'sftpUpload' }));

    expect(await screen.findByText('sftpTransferCancelled')).toBeInTheDocument();
    expect(screen.queryByText('sftpTransferFailed')).not.toBeInTheDocument();
  });
});

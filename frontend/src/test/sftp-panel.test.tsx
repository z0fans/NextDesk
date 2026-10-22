import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sftpApi = vi.hoisted(() => ({
  sshSftpOpen: vi.fn(),
  sshSftpList: vi.fn(),
  sshSftpCreateDirectory: vi.fn(),
  sshSftpRename: vi.fn(),
  sshSftpRemove: vi.fn(),
  sshSftpReadText: vi.fn(),
  sshSftpWriteText: vi.fn(),
  sshSftpSetPermissions: vi.fn(),
  sshSftpUpload: vi.fn(),
  sshSftpDownload: vi.fn(),
  sshSftpCancel: vi.fn(),
  sshSftpChooseUploadPath: vi.fn(),
  sshSftpChooseUploadPaths: vi.fn(),
  sshSftpChooseUploadDirectory: vi.fn(),
  sshSftpChooseDownloadPath: vi.fn(),
  sshSftpChooseDownloadDirectory: vi.fn(),
  sshCommandLibraryImport: vi.fn(),
  sshCommandLibraryExport: vi.fn(),
}));

const translate = vi.hoisted(() => (key: string) => key);

vi.mock('@/i18n/useTranslation', () => ({
  useTranslation: () => ({ t: translate }),
}));

vi.mock('@/api', () => ({ api: sftpApi }));

import { SftpPanel } from '@/ssh/SftpPanel';
import { SSH_COMMAND_LIBRARY_STORAGE_KEY } from '@/ssh/ssh-command-library-store';
import type { SftpEntry, SftpListResponse } from '@/ssh/types';

const homePath = '/home/root';
const logsPath = `${homePath}/logs`;

function entry(path: string, kind: SftpEntry['kind'] = 'directory'): SftpEntry {
  return { name: path.split('/').at(-1)!, path, kind, size: 0 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('SFTP panel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
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
    sftpApi.sshSftpChooseUploadPaths.mockResolvedValue([]);
    sftpApi.sshSftpChooseUploadDirectory.mockResolvedValue(null);
    sftpApi.sshSftpChooseDownloadPath.mockResolvedValue(null);
    sftpApi.sshSftpChooseDownloadDirectory.mockResolvedValue(null);
    sftpApi.sshSftpReadText.mockResolvedValue({ content: "alpha\nbeta\nalpha" });
    sftpApi.sshSftpWriteText.mockResolvedValue(undefined);
    sftpApi.sshSftpSetPermissions.mockResolvedValue(undefined);
    sftpApi.sshCommandLibraryImport.mockResolvedValue(null);
    sftpApi.sshCommandLibraryExport.mockResolvedValue(true);
  });

  it('opens the SFTP subsystem and browses a remote directory', async () => {
    render(<SftpPanel sessionId="ssh-alpha" visible />);

    const panel = screen.getByRole('complementary', { name: 'sftpFiles' });
    expect(panel).toHaveClass('h-full', 'w-full');
    expect(panel).not.toHaveClass('w-[420px]', 'border-l');
    expect(panel.querySelector('[data-region="sftp-dock-toolbar"]')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'sftpFilesTab' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'sshCommandsTab' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText('sftpFiles')).not.toBeInTheDocument();
    expect(await screen.findByText('notes.txt')).toBeInTheDocument();
    const directoryTree = screen.getByRole('navigation', { name: 'sftpDirectoryTree' });
    expect(await within(directoryTree).findByText('logs')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'logs' })).toBeInTheDocument();
    expect(screen.getByText('/home/root')).toBeInTheDocument();
    expect(sftpApi.sshSftpOpen).toHaveBeenCalledWith('ssh-alpha');
    expect(sftpApi.sshSftpList).toHaveBeenCalledWith('ssh-alpha', '/home/root');

    fireEvent.doubleClick(screen.getByRole('button', { name: 'logs' }));
    await waitFor(() => {
      expect(sftpApi.sshSftpList).toHaveBeenLastCalledWith('ssh-alpha', '/home/root/logs');
    });
  });

  it('keeps expanded tree directories and the list in sync after create, rename, delete, and root refresh', async () => {
    const directories: Record<string, SftpEntry[]> = {
      [homePath]: [entry(logsPath)],
      [logsPath]: [entry(`${logsPath}/keep`)],
    };
    sftpApi.sshSftpList.mockImplementation(async (_sessionId: string, path: string) => ({
      path, entries: [...(directories[path] ?? [])],
    }));
    sftpApi.sshSftpCreateDirectory.mockImplementation(async ({ path }: { path: string }) => {
      const parent = path.slice(0, path.lastIndexOf('/'));
      directories[parent] = [...directories[parent], entry(path)];
    });
    sftpApi.sshSftpRename.mockImplementation(async ({ fromPath, toPath }: { fromPath: string; toPath: string }) => {
      directories[logsPath] = directories[logsPath].map((item) => item.path === fromPath ? entry(toPath) : item);
    });
    sftpApi.sshSftpRemove.mockImplementation(async ({ path }: { path: string }) => {
      directories[logsPath] = directories[logsPath].filter((item) => item.path !== path);
    });
    render(<SftpPanel sessionId="ssh-alpha" visible />);
    await screen.findByRole('button', { name: 'logs' });
    const tree = screen.getByRole('navigation', { name: 'sftpDirectoryTree' });
    const toggleLogs = () => within(tree).getByRole('button', { name: 'sftpToggleDirectory logs' });
    fireEvent.click(toggleLogs());
    await within(tree).findByText('keep');
    fireEvent.click(within(tree).getByRole('button', { name: `sftpOpenDirectory ${logsPath}` }));
    await screen.findByRole('button', { name: 'keep' });

    fireEvent.click(screen.getByRole('button', { name: 'sftpNewFolder' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'sftpName' }), { target: { value: 'archive' } });
    fireEvent.click(screen.getByRole('button', { name: 'sftpCreate' }));
    await screen.findByRole('button', { name: 'archive' });
    expect(within(tree).getByText('archive')).toBeInTheDocument();
    expect(toggleLogs()).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'sftpSelectEntry archive' }));
    fireEvent.click(screen.getByRole('button', { name: 'sftpRename' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'sftpName' }), { target: { value: 'renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'sftpSave' }));
    await screen.findByRole('button', { name: 'renamed' });
    expect(within(tree).getByText('renamed')).toBeInTheDocument();
    expect(screen.queryByText('archive')).not.toBeInTheDocument();
    expect(toggleLogs()).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'sftpSelectEntry renamed' }));
    fireEvent.click(screen.getByRole('button', { name: 'sftpDelete' }));
    fireEvent.click(screen.getByRole('button', { name: 'sftpConfirmDelete' }));
    await waitFor(() => expect(screen.queryByText('renamed')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'keep' })).toBeInTheDocument();
    expect(within(tree).getByText('keep')).toBeInTheDocument();
    expect(toggleLogs()).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(within(tree).getByRole('button', { name: `sftpOpenDirectory ${homePath}` }));
    await screen.findByRole('button', { name: 'logs' });
    fireEvent.click(screen.getByRole('button', { name: 'sftpNewFolder' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'sftpName' }), { target: { value: 'root-new' } });
    fireEvent.click(screen.getByRole('button', { name: 'sftpCreate' }));
    await screen.findByRole('button', { name: 'root-new' });
    expect(within(tree).getByText('root-new')).toBeInTheDocument();
    await within(tree).findByText('keep');
    expect(toggleLogs()).toHaveAttribute('aria-expanded', 'true');

    directories[logsPath] = [...directories[logsPath], entry(`${logsPath}/external`)];
    fireEvent.click(screen.getByRole('button', { name: 'sftpRefresh' }));
    await within(tree).findByText('external');
    expect(toggleLogs()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(within(tree).getByRole('button', { name: `sftpOpenDirectory ${logsPath}` }));
    await screen.findByRole('button', { name: 'external' });
  });

  it.each(['success', 'failure'])('keeps the latest navigation when an earlier read finishes with %s', async (result) => {
    const oldRead = deferred<SftpListResponse>();
    const otherPath = `${homePath}/other`;
    sftpApi.sshSftpList.mockImplementation(async (_sessionId: string, path: string) => {
      if (path === logsPath) return oldRead.promise;
      return { path, entries: path === homePath
        ? [entry(logsPath), entry(otherPath)] : [entry(`${otherPath}/current.txt`, 'file')] };
    });
    render(<SftpPanel sessionId="ssh-alpha" visible />);
    await screen.findByRole('button', { name: 'logs' });
    const tree = screen.getByRole('navigation', { name: 'sftpDirectoryTree' });
    fireEvent.click(within(tree).getByRole('button', { name: 'sftpToggleDirectory logs' }));
    fireEvent.click(within(tree).getByRole('button', { name: `sftpOpenDirectory ${logsPath}` }));
    await waitFor(() => expect(sftpApi.sshSftpList.mock.calls.filter(([, path]) => path === logsPath)).toHaveLength(1));
    expect(within(tree).getByRole('button', { name: 'sftpToggleDirectory logs' })).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(within(tree).getByRole('button', { name: `sftpOpenDirectory ${otherPath}` }));
    await screen.findByRole('button', { name: 'current.txt' });

    await act(async () => {
      if (result === 'success') oldRead.resolve({ path: logsPath, entries: [entry(`${logsPath}/late-child`)] });
      else oldRead.reject(new Error('old directory unavailable'));
    });
    expect(screen.getByText(otherPath)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'current.txt' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'late-child' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'sftpRefresh' })).toBeEnabled();
  });

  it('discards old session listings even when both sessions have the same paths', async () => {
    const oldRead = deferred<SftpListResponse>();
    sftpApi.sshSftpList.mockImplementation(async (sessionId: string, path: string) => {
      if (path === homePath) return { path, entries: [entry(logsPath)] };
      if (sessionId === 'ssh-alpha') return oldRead.promise;
      return { path, entries: [entry(`${logsPath}/beta-child`)] };
    });
    const { rerender } = render(<SftpPanel sessionId="ssh-alpha" visible />);
    await screen.findByRole('button', { name: 'logs' });
    fireEvent.click(screen.getByRole('button', { name: 'sftpToggleDirectory logs' }));
    fireEvent.click(screen.getByRole('button', { name: `sftpOpenDirectory ${logsPath}` }));
    await waitFor(() => expect(sftpApi.sshSftpList).toHaveBeenCalledWith('ssh-alpha', logsPath));

    rerender(<SftpPanel sessionId="ssh-beta" visible />);
    await screen.findByRole('button', { name: 'logs' });
    expect(screen.getByRole('button', { name: 'sftpToggleDirectory logs' })).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'sftpToggleDirectory logs' }));
    fireEvent.click(screen.getByRole('button', { name: `sftpOpenDirectory ${logsPath}` }));
    await screen.findByRole('button', { name: 'beta-child' });
    await act(async () => oldRead.resolve({ path: logsPath, entries: [entry(`${logsPath}/alpha-child`)] }));
    expect(screen.queryByText('alpha-child')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'beta-child' })).toBeInTheDocument();
    expect(within(screen.getByRole('navigation')).getByText('beta-child')).toBeInTheDocument();
  });

  it('ignores a late subsystem open from a previous session', async () => {
    const oldOpen = deferred<{ path: string }>();
    sftpApi.sshSftpOpen.mockImplementation((sessionId: string) => sessionId === 'ssh-alpha'
      ? oldOpen.promise : Promise.resolve({ path: homePath }));
    const { rerender } = render(<SftpPanel sessionId="ssh-alpha" visible />);
    rerender(<SftpPanel sessionId="ssh-beta" visible />);
    await screen.findByText('notes.txt');
    await act(async () => oldOpen.resolve({ path: '/old-home' }));
    expect(screen.getByText(homePath)).toBeInTheDocument();
    expect(sftpApi.sshSftpList).not.toHaveBeenCalledWith('ssh-alpha', '/old-home');
  });

  it.each(['success', 'failure'])('invalidates pending child reads after upload, including late %s', async (result) => {
    const oldRead = deferred<SftpListResponse>();
    let childReads = 0;
    sftpApi.sshSftpList.mockImplementation(async (_sessionId: string, path: string) => {
      if (path === homePath) return { path, entries: [entry(logsPath)] };
      childReads += 1;
      return childReads === 1 ? oldRead.promise : { path, entries: [entry(`${logsPath}/fresh-child`)] };
    });
    sftpApi.sshSftpChooseUploadDirectory.mockResolvedValue('/tmp/logs');
    sftpApi.sshSftpUpload.mockResolvedValue(undefined);
    render(<SftpPanel sessionId="ssh-alpha" visible />);
    await screen.findByRole('button', { name: 'logs' });
    fireEvent.click(screen.getByRole('button', { name: 'sftpToggleDirectory logs' }));
    await waitFor(() => expect(childReads).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'sftpUploadFolder' }));
    const tree = screen.getByRole('navigation');
    await within(tree).findByText('fresh-child');
    await act(async () => {
      if (result === 'success') oldRead.resolve({ path: logsPath, entries: [entry(`${logsPath}/stale-child`)] });
      else oldRead.reject(new Error('expired request failed'));
    });
    expect(screen.queryByText('stale-child')).not.toBeInTheDocument();
    expect(within(tree).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(tree).getByText('fresh-child')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'sftpToggleDirectory logs' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(within(tree).getByRole('button', { name: `sftpOpenDirectory ${logsPath}` }));
    await screen.findByRole('button', { name: 'fresh-child' });
  });

  it('refreshes the upload destination without navigating back after the user browses away', async () => {
    const upload = deferred<void>();
    let uploaded = false;
    sftpApi.sshSftpChooseUploadDirectory.mockResolvedValue('/tmp/uploaded');
    sftpApi.sshSftpUpload.mockImplementation(() => upload.promise);
    sftpApi.sshSftpList.mockImplementation(async (_sessionId: string, path: string) => ({
      path, entries: path === homePath
        ? [entry(logsPath), ...(uploaded ? [entry(`${homePath}/uploaded`)] : [])]
        : [entry(`${logsPath}/current.txt`, 'file')],
    }));
    render(<SftpPanel sessionId="ssh-alpha" visible />);
    await screen.findByRole('button', { name: 'logs' });
    fireEvent.click(screen.getByRole('button', { name: 'sftpUploadFolder' }));
    await waitFor(() => expect(sftpApi.sshSftpUpload).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: `sftpOpenDirectory ${logsPath}` }));
    await screen.findByRole('button', { name: 'current.txt' });
    await act(async () => {
      uploaded = true;
      upload.resolve();
    });
    await within(screen.getByRole('navigation')).findByText('uploaded');
    expect(screen.getByText(logsPath)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'current.txt' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'uploaded' })).not.toBeInTheDocument();
  });

  it('retries a failed tree read without losing the expanded parent', async () => {
    let childReads = 0;
    sftpApi.sshSftpList.mockImplementation(async (_sessionId: string, path: string) => {
      if (path === homePath) return { path, entries: [entry(logsPath)] };
      if (++childReads === 1) throw new Error('read failed');
      return { path, entries: [entry(`${logsPath}/recovered`)] };
    });
    render(<SftpPanel sessionId="ssh-alpha" visible />);
    await screen.findByRole('button', { name: 'logs' });
    const toggle = screen.getByRole('button', { name: 'sftpToggleDirectory logs' });
    fireEvent.click(toggle);
    const tree = screen.getByRole('navigation');
    expect(await within(tree).findByRole('alert')).toHaveTextContent('sftpOpenFailed');
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    await within(tree).findByText('recovered');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(tree).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('opens a usable directory under StrictMode effect replay', async () => {
    render(<StrictMode><SftpPanel sessionId="ssh-alpha" visible /></StrictMode>);
    await screen.findByText('notes.txt');
    expect(within(screen.getByRole('navigation')).getByText('logs')).toBeInTheDocument();
    expect(sftpApi.sshSftpList).toHaveBeenCalledTimes(1);
  });

  it('edits remote text files in a PixShell-style full workspace editor', async () => {
    const { container } = render(<SftpPanel sessionId="ssh-alpha" visible />);
    await screen.findByText('notes.txt');

    fireEvent.click(screen.getByRole('button', { name: 'sftpSelectEntry notes.txt' }));
    fireEvent.click(screen.getByRole('button', { name: 'sftpEditTextFile' }));

    const editor = await screen.findByRole('dialog', { name: 'notes.txt' });
    expect(editor).not.toBe(container);
    expect(editor).toHaveClass('w-[min(88vw,1640px)]');
    expect(within(editor).getByText('sftpEditorPlainText')).toBeInTheDocument();
    expect(within(editor).getByRole('checkbox', { name: 'sftpEditorLineNumbers' })).toBeChecked();
    expect(within(editor).getByRole('checkbox', { name: 'sftpEditorWordWrap' })).not.toBeChecked();
    expect(editor.querySelector('[data-region="sftp-editor-line-numbers"]')).toHaveTextContent('1');

    const content = within(editor).getByRole('textbox', { name: 'sftpTextFileContent' });
    fireEvent.change(within(editor).getByRole('textbox', { name: 'sftpEditorFind' }), {
      target: { value: 'alpha' },
    });
    fireEvent.click(within(editor).getByRole('button', { name: 'sftpEditorNextMatch' }));
    fireEvent.change(within(editor).getByRole('textbox', { name: 'sftpEditorReplaceWith' }), {
      target: { value: 'omega' },
    });
    fireEvent.click(within(editor).getByRole('button', { name: 'sftpEditorReplace' }));
    expect(content).toHaveValue('omega\nbeta\nalpha');

    fireEvent.click(within(editor).getByRole('button', { name: 'sftpSave' }));
    await waitFor(() => expect(sftpApi.sshSftpWriteText).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'ssh-alpha',
        path: '/home/root/notes.txt',
        content: 'omega\nbeta\nalpha',
      }),
    ));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'notes.txt' })).not.toBeInTheDocument());
    await waitFor(() => expect(sftpApi.sshSftpList).toHaveBeenCalledTimes(2));
    expect(sftpApi.sshSftpList).toHaveBeenLastCalledWith('ssh-alpha', homePath);
  });

  it('uploads with progress and lets the user cancel the transfer', async () => {
    sftpApi.sshSftpChooseUploadPaths.mockResolvedValue(['/tmp/report.txt']);
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
      recursive: false,
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
      recursive: false,
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
    sftpApi.sshSftpChooseUploadPaths.mockResolvedValue(['/tmp/notes.txt']);
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
    sftpApi.sshSftpChooseUploadPaths.mockResolvedValue(['C:\\Users\\Administrator\\report.txt']);
    sftpApi.sshSftpUpload.mockResolvedValue(undefined);
    render(<SftpPanel sessionId="ssh-alpha" visible />);
    await screen.findByText('notes.txt');

    fireEvent.click(screen.getByRole('button', { name: 'sftpUpload' }));

    await waitFor(() => expect(sftpApi.sshSftpUpload).toHaveBeenCalledOnce());
    expect(sftpApi.sshSftpUpload.mock.calls[0][0]).toMatchObject({
      localPath: 'C:\\Users\\Administrator\\report.txt',
      remotePath: '/home/root/report.txt',
      recursive: false,
    });
  });

  it('keeps a cancelled transfer cancelled when the command rejects after its final event', async () => {
    sftpApi.sshSftpChooseUploadPaths.mockResolvedValue(['/tmp/report.txt']);
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

  it('uploads a selected local directory recursively', async () => {
    sftpApi.sshSftpChooseUploadDirectory.mockResolvedValue('/tmp/config');
    sftpApi.sshSftpUpload.mockResolvedValue(undefined);
    render(<SftpPanel sessionId="ssh-alpha" visible />);
    await screen.findByText('notes.txt');

    fireEvent.click(screen.getByRole('button', { name: 'sftpUploadFolder' }));

    await waitFor(() => expect(sftpApi.sshSftpUpload).toHaveBeenCalledOnce());
    expect(sftpApi.sshSftpUpload.mock.calls[0][0]).toMatchObject({
      localPath: '/tmp/config',
      remotePath: '/home/root/config',
      recursive: true,
    });
  });

  it('selects and downloads multiple files and directories into one local folder', async () => {
    sftpApi.sshSftpChooseDownloadDirectory.mockResolvedValue('/tmp/export');
    sftpApi.sshSftpDownload.mockResolvedValue(undefined);
    render(<SftpPanel sessionId="ssh-alpha" visible />);
    await screen.findByText('notes.txt');

    fireEvent.click(screen.getByRole('button', { name: 'sftpSelectEntry logs' }));
    fireEvent.click(screen.getByRole('button', { name: 'sftpSelectEntry notes.txt' }));
    expect(screen.getByText('sftpSelectedCount')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'sftpDownload' }));

    await waitFor(() => expect(sftpApi.sshSftpDownload).toHaveBeenCalledTimes(2));
    expect(sftpApi.sshSftpDownload.mock.calls.map((call: unknown[]) => call[0])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          localPath: '/tmp/export/logs',
          remotePath: '/home/root/logs',
          recursive: true,
        }),
        expect.objectContaining({
          localPath: '/tmp/export/notes.txt',
          remotePath: '/home/root/notes.txt',
          recursive: false,
        }),
      ]),
    );
  });

  it('opens with no default groups or commands', async () => {
    render(
      <SftpPanel
        sessionId="ssh-alpha"
        visible
        commandHistory={['uptime', 'df -h']}
      />,
    );

    await screen.findByText('notes.txt');
    fireEvent.click(screen.getByRole('button', { name: 'sshCommandsTab' }));

    expect(screen.getByRole('button', { name: 'sshCommandsTab' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('notes.txt')).not.toBeInTheDocument();
    expect(screen.getByText('sshCommandEmptyStart')).toBeInTheDocument();
    expect(screen.queryByText('sshCommandGroupSystem')).not.toBeInTheDocument();
    expect(screen.queryByText('sshCommandPresetMemory')).not.toBeInTheDocument();
  });

  it('lets the user create, save, and run a custom command', async () => {
    const runCommand = vi.fn<(...args: [string]) => Promise<void>>().mockResolvedValue(undefined);
    render(<SftpPanel sessionId="ssh-alpha" visible onRunCommand={runCommand} />);
    await screen.findByText('notes.txt');

    fireEvent.click(screen.getByRole('button', { name: 'sshCommandsTab' }));
    fireEvent.click(screen.getByRole('button', { name: 'sshCommandNew' }));
    const groupDialog = screen.getByRole('dialog');
    fireEvent.change(screen.getByRole('textbox', { name: 'sshCommandGroupName' }), {
      target: { value: 'Custom' },
    });
    fireEvent.click(within(groupDialog).getByRole('button', { name: 'sshCommandSave' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'sshCommandName' }), {
      target: { value: 'Custom diagnostic' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'sshCommandContent' }), {
      target: { value: 'uname -a' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'sshCommandSave' }));

    expect(screen.getByText('Custom diagnostic')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'sshRunCommand Custom diagnostic' }));
    await waitFor(() => expect(runCommand).toHaveBeenCalledWith('uname -a'));
    expect(localStorage.getItem(SSH_COMMAND_LIBRARY_STORAGE_KEY)).toContain('Custom diagnostic');

    const editor = screen.getByRole('region', { name: 'sshCommandEditor' });
    expect(editor).toHaveClass('overflow-hidden');
    expect(editor.querySelector('[data-region="ssh-command-editor-body"]')).toHaveClass('overflow-y-auto');
    expect(editor.querySelector('[data-region="ssh-command-editor-footer"]')).toHaveClass('shrink-0');
  });

  it('creates and edits custom command groups without losing their commands', async () => {
    render(<SftpPanel sessionId="ssh-alpha" visible />);
    await screen.findByText('notes.txt');
    fireEvent.click(screen.getByRole('button', { name: 'sshCommandsTab' }));

    fireEvent.click(screen.getByRole('button', { name: 'sshCommandNewGroup' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(screen.getByRole('textbox', { name: 'sshCommandGroupName' }), {
      target: { value: 'Deployments' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'sshCommandSave' }));

    expect(screen.getByRole('button', { name: 'Deployments' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'sshCommandNew' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'sshCommandName' }), {
      target: { value: 'Deploy status' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'sshCommandContent' }), {
      target: { value: 'systemctl status app' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'sshCommandSave' }));
    expect(screen.getByText('Deploy status')).toBeInTheDocument();
  });

  it('fills command parameters and broadcasts to all selected sessions', async () => {
    localStorage.setItem(SSH_COMMAND_LIBRARY_STORAGE_KEY, JSON.stringify({
      groups: [{ id: 'services', name: 'Services' }],
      commands: [{
        id: 'service-status',
        name: 'Service status',
        command: 'systemctl status {{service}}',
        groupId: 'services',
      }],
    }));
    const runCommand = vi.fn<(...args: [string, string[]?]) => Promise<void>>().mockResolvedValue(undefined);
    render(
      <SftpPanel
        sessionId="ssh-alpha"
        visible
        commandTargets={[
          { id: 'ssh-alpha', name: 'Alpha' },
          { id: 'ssh-beta', name: 'Beta' },
        ]}
        onRunCommand={runCommand}
      />,
    );
    await screen.findByText('notes.txt');
    fireEvent.click(screen.getByRole('button', { name: 'sshCommandsTab' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'sshCommandTarget' }), {
      target: { value: 'all' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'sshRunCommand Service status' }));

    const parameterDialog = screen.getByRole('dialog', { name: 'sshCommandParameters' });
    fireEvent.change(within(parameterDialog).getByRole('textbox', { name: 'service' }), {
      target: { value: 'nginx' },
    });
    fireEvent.click(within(parameterDialog).getByRole('button', { name: 'sshCommandSend' }));

    await waitFor(() => expect(runCommand).toHaveBeenCalledWith(
      'systemctl status nginx',
      ['ssh-alpha', 'ssh-beta'],
    ));
  });

  it('imports and exports a versioned command library file', async () => {
    sftpApi.sshCommandLibraryImport.mockResolvedValue(JSON.stringify({
      version: 1,
      groups: [{ id: 'ops', name: 'Operations' }],
      commands: [{ id: 'uptime', name: 'Uptime', command: 'uptime', groupId: 'ops' }],
    }));
    render(<SftpPanel sessionId="ssh-alpha" visible />);
    await screen.findByText('notes.txt');
    fireEvent.click(screen.getByRole('button', { name: 'sshCommandsTab' }));

    fireEvent.click(screen.getByRole('button', { name: 'sshCommandImport' }));
    expect(await screen.findByText('Uptime')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'sshCommandExport' }));

    await waitFor(() => expect(sftpApi.sshCommandLibraryExport).toHaveBeenCalledOnce());
    expect(sftpApi.sshCommandLibraryExport.mock.calls[0][0]).toContain('"version": 1');
    expect(sftpApi.sshCommandLibraryExport.mock.calls[0][0]).toContain('"Uptime"');
  });
});

import { beforeEach, describe, expect, it } from 'vitest';

import {
  SSH_COMMAND_LIBRARY_LEGACY_STORAGE_KEY,
  SSH_COMMAND_LIBRARY_STORAGE_KEY,
  loadSshCommandLibrary,
  parseSshCommandLibrary,
  saveSshCommandLibrary,
  serializeSshCommandLibrary,
} from '@/ssh/ssh-command-library-store';

describe('SSH command library store', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('persists user-defined groups and commands', () => {
    saveSshCommandLibrary({
      groups: [{ id: 'deploy', name: 'Deployments' }],
      commands: [{ id: 'status', name: 'Status', command: 'systemctl status app', groupId: 'deploy' }],
    });

    expect(loadSshCommandLibrary()).toEqual({
      groups: [{ id: 'deploy', name: 'Deployments' }],
      commands: [{ id: 'status', name: 'Status', command: 'systemctl status app', groupId: 'deploy' }],
    });
  });

  it('starts empty with no default groups or commands', () => {
    expect(loadSshCommandLibrary()).toEqual({ groups: [], commands: [] });
  });

  it('removes old built-in presets while preserving user-created legacy commands', () => {
    localStorage.setItem(SSH_COMMAND_LIBRARY_LEGACY_STORAGE_KEY, JSON.stringify({
      groups: [
        { id: 'system', name: 'System' },
        { id: 'deploy', name: 'Deployments' },
      ],
      commands: [
        { id: 'disk-usage', name: 'Disk', command: 'df -h', groupId: 'system' },
        { id: 'custom-system', name: 'Kernel', command: 'uname -a', groupId: 'system' },
        { id: 'deploy-status', name: 'Deploy', command: 'systemctl status app', groupId: 'deploy' },
      ],
    }));

    expect(loadSshCommandLibrary()).toEqual({
      groups: [
        { id: 'system', name: 'System' },
        { id: 'deploy', name: 'Deployments' },
      ],
      commands: [
        { id: 'custom-system', name: 'Kernel', command: 'uname -a', groupId: 'system' },
        { id: 'deploy-status', name: 'Deploy', command: 'systemctl status app', groupId: 'deploy' },
      ],
    });
    expect(localStorage.getItem(SSH_COMMAND_LIBRARY_LEGACY_STORAGE_KEY)).toBeNull();
  });

  it('migrates a presets-only legacy library to an empty library', () => {
    localStorage.setItem(SSH_COMMAND_LIBRARY_LEGACY_STORAGE_KEY, JSON.stringify({
      groups: [
        { id: 'system', name: 'System' },
        { id: 'services', name: 'Services' },
        { id: 'containers', name: 'Containers' },
      ],
      commands: [
        { id: 'disk-usage', name: 'Disk', command: 'df -h', groupId: 'system' },
        { id: 'failed-services', name: 'Services', command: 'systemctl --failed', groupId: 'services' },
        { id: 'docker-ps', name: 'Docker', command: 'docker ps', groupId: 'containers' },
      ],
    }));

    expect(loadSshCommandLibrary()).toEqual({ groups: [], commands: [] });
  });

  it('removes invalid saved entries', () => {
    localStorage.setItem(SSH_COMMAND_LIBRARY_STORAGE_KEY, JSON.stringify({
      groups: [{ id: 'system', name: 'System' }],
      commands: [
        { id: 'valid', name: 'Valid', command: 'uptime', groupId: 'system' },
        { id: 'invalid', name: 'Invalid', command: 'whoami', groupId: 'missing' },
      ],
    }));

    expect(loadSshCommandLibrary().commands).toEqual([
      { id: 'valid', name: 'Valid', command: 'uptime', groupId: 'system' },
    ]);
  });

  it('round-trips a versioned command library export', () => {
    const library = {
      groups: [{ id: 'ops', name: 'Operations' }],
      commands: [{ id: 'uptime', name: 'Uptime', command: 'uptime', groupId: 'ops' }],
    };

    expect(parseSshCommandLibrary(serializeSshCommandLibrary(library))).toEqual(library);
    expect(() => parseSshCommandLibrary('{"version":99,"groups":[],"commands":[]}')).toThrow(
      'ssh_command_library_version_invalid',
    );
  });
});

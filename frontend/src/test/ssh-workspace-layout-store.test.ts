import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SSH_WORKSPACE_LAYOUT,
  SSH_DOCK_MAX_HEIGHT,
  SSH_DOCK_MIN_HEIGHT,
  SSH_INFO_PANEL_MAX_WIDTH,
  SSH_INFO_PANEL_MIN_WIDTH,
  SSH_WORKSPACE_LAYOUT_STORAGE_KEY,
  loadSshWorkspaceLayout,
  saveSshWorkspaceLayout,
} from '@/ssh/ssh-workspace-layout-store';

const LEGACY_SSH_WORKSPACE_LAYOUT_STORAGE_KEY = 'nextdesk_ssh_workspace_layout_v1';

describe('SSH workspace layout store', () => {
  beforeEach(() => localStorage.clear());

  it('uses stable defaults when no layout has been saved', () => {
    expect(loadSshWorkspaceLayout()).toEqual({
      infoPanelWidth: 232,
      dockHeight: 260,
    });
    expect(DEFAULT_SSH_WORKSPACE_LAYOUT).toEqual({
      infoPanelWidth: 232,
      dockHeight: 260,
    });
  });

  it('migrates the legacy default dimensions without overriding custom dimensions', () => {
    localStorage.setItem(LEGACY_SSH_WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify({
      infoPanelWidth: 256,
      dockHeight: 320,
    }));

    expect(loadSshWorkspaceLayout()).toEqual({
      infoPanelWidth: 232,
      dockHeight: 260,
    });

    localStorage.clear();
    localStorage.setItem(LEGACY_SSH_WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify({
      infoPanelWidth: 288,
      dockHeight: 360,
    }));

    expect(loadSshWorkspaceLayout()).toEqual({
      infoPanelWidth: 288,
      dockHeight: 360,
    });
  });

  it('persists layout dimensions', () => {
    saveSshWorkspaceLayout({ infoPanelWidth: 300, dockHeight: 420 });

    expect(loadSshWorkspaceLayout()).toEqual({ infoPanelWidth: 300, dockHeight: 420 });
  });

  it('clamps malformed and out-of-range dimensions', () => {
    localStorage.setItem(SSH_WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify({
      infoPanelWidth: 9_999,
      dockHeight: 1,
    }));

    expect(loadSshWorkspaceLayout()).toEqual({
      infoPanelWidth: SSH_INFO_PANEL_MAX_WIDTH,
      dockHeight: SSH_DOCK_MIN_HEIGHT,
    });

    localStorage.setItem(SSH_WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify({
      infoPanelWidth: -1,
      dockHeight: 9_999,
    }));
    expect(loadSshWorkspaceLayout()).toEqual({
      infoPanelWidth: SSH_INFO_PANEL_MIN_WIDTH,
      dockHeight: SSH_DOCK_MAX_HEIGHT,
    });
  });
});

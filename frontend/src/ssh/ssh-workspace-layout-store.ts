export const SSH_WORKSPACE_LAYOUT_STORAGE_KEY = 'nextdesk_ssh_workspace_layout_v2';

export interface SshWorkspaceLayout {
  infoPanelWidth: number;
  dockHeight: number;
}

const LEGACY_SSH_WORKSPACE_LAYOUT_STORAGE_KEY = 'nextdesk_ssh_workspace_layout_v1';
const LEGACY_DEFAULT_SSH_WORKSPACE_LAYOUT: SshWorkspaceLayout = {
  infoPanelWidth: 256,
  dockHeight: 320,
};

export const SSH_INFO_PANEL_MIN_WIDTH = 208;
export const SSH_INFO_PANEL_MAX_WIDTH = 360;
export const SSH_DOCK_MIN_HEIGHT = 224;
export const SSH_DOCK_MAX_HEIGHT = 600;

export const DEFAULT_SSH_WORKSPACE_LAYOUT: SshWorkspaceLayout = {
  infoPanelWidth: 232,
  dockHeight: 260,
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function sanitizeSshWorkspaceLayout(value: unknown): SshWorkspaceLayout {
  if (!value || typeof value !== 'object') return { ...DEFAULT_SSH_WORKSPACE_LAYOUT };
  const candidate = value as Partial<SshWorkspaceLayout>;
  return {
    infoPanelWidth: Number.isFinite(candidate.infoPanelWidth)
      ? clamp(Number(candidate.infoPanelWidth), SSH_INFO_PANEL_MIN_WIDTH, SSH_INFO_PANEL_MAX_WIDTH)
      : DEFAULT_SSH_WORKSPACE_LAYOUT.infoPanelWidth,
    dockHeight: Number.isFinite(candidate.dockHeight)
      ? clamp(Number(candidate.dockHeight), SSH_DOCK_MIN_HEIGHT, SSH_DOCK_MAX_HEIGHT)
      : DEFAULT_SSH_WORKSPACE_LAYOUT.dockHeight,
  };
}

export function loadSshWorkspaceLayout(): SshWorkspaceLayout {
  try {
    const raw = localStorage.getItem(SSH_WORKSPACE_LAYOUT_STORAGE_KEY);
    if (raw) return sanitizeSshWorkspaceLayout(JSON.parse(raw));

    const legacyRaw = localStorage.getItem(LEGACY_SSH_WORKSPACE_LAYOUT_STORAGE_KEY);
    if (!legacyRaw) return { ...DEFAULT_SSH_WORKSPACE_LAYOUT };
    const legacyLayout = sanitizeSshWorkspaceLayout(JSON.parse(legacyRaw));
    if (
      legacyLayout.infoPanelWidth === LEGACY_DEFAULT_SSH_WORKSPACE_LAYOUT.infoPanelWidth
      && legacyLayout.dockHeight === LEGACY_DEFAULT_SSH_WORKSPACE_LAYOUT.dockHeight
    ) {
      return { ...DEFAULT_SSH_WORKSPACE_LAYOUT };
    }
    return legacyLayout;
  } catch {
    return { ...DEFAULT_SSH_WORKSPACE_LAYOUT };
  }
}

export function saveSshWorkspaceLayout(layout: SshWorkspaceLayout): SshWorkspaceLayout {
  const sanitized = sanitizeSshWorkspaceLayout(layout);
  localStorage.setItem(SSH_WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify(sanitized));
  return sanitized;
}

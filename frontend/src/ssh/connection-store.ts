import type {
  SshAuthMethod,
  SshConnection,
  SshConnectionGroup,
  SshHostOs,
  SshProxyType,
  SshRoutePolicy,
} from './types';

export const SSH_CONNECTIONS_STORAGE_KEY = 'nextdesk_ssh_connections_v1';
export const SSH_GROUPS_STORAGE_KEY = 'nextdesk_ssh_groups_v1';
export const SSH_DEFAULT_GROUP_ID = 'default';
export const SSH_GROUP_NAME_MAX_LENGTH = 80;

const DEFAULT_SSH_GROUP: SshConnectionGroup = {
  id: SSH_DEFAULT_GROUP_ID,
  name: '',
  isExpanded: true,
};

function validAuthMethod(value: unknown): value is SshAuthMethod {
  return value === 'password' || value === 'private_key';
}

function validRoutePolicy(value: unknown): value is SshRoutePolicy {
  return value === 'auto' || value === 'direct' || value === 'cloud_only';
}

function validHostOs(value: unknown): value is SshHostOs {
  return value === 'linux' || value === 'windows' || value === 'unknown';
}

function validProxyType(value: unknown): value is SshProxyType {
  return value === 'none' || value === 'socks5' || value === 'http';
}

function sanitizeConnection(value: unknown): SshConnection | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.name !== 'string' ||
    typeof candidate.host !== 'string' ||
    typeof candidate.username !== 'string' ||
    typeof candidate.port !== 'number' ||
    !Number.isInteger(candidate.port) ||
    candidate.port < 1 ||
    candidate.port > 65535 ||
    !validAuthMethod(candidate.authMethod) ||
    !validRoutePolicy(candidate.routePolicy)
  ) {
    return null;
  }

  return {
    id: candidate.id,
    name: candidate.name,
    host: candidate.host,
    port: candidate.port,
    username: candidate.username,
    authMethod: candidate.authMethod,
    groupId: typeof candidate.groupId === 'string' && candidate.groupId.trim()
      ? candidate.groupId.trim()
      : SSH_DEFAULT_GROUP_ID,
    routePolicy: candidate.routePolicy,
    ...(typeof candidate.credentialReference === 'string'
      ? { credentialReference: candidate.credentialReference }
      : {}),
    ...(typeof candidate.privateKeyLabel === 'string'
      ? { privateKeyLabel: candidate.privateKeyLabel }
      : {}),
    ...(typeof candidate.publicKey === 'string'
      ? { publicKey: candidate.publicKey }
      : {}),
    ...(typeof candidate.privateKeyPath === 'string'
      ? { privateKeyPath: candidate.privateKeyPath }
      : {}),
    ...(typeof candidate.preferredRegion === 'string'
      ? { preferredRegion: candidate.preferredRegion }
      : {}),
    ...(typeof candidate.notes === 'string' && candidate.notes.trim()
      ? { notes: candidate.notes.trim().slice(0, 2000) }
      : {}),
    ...(validHostOs(candidate.detectedOs)
      ? { detectedOs: candidate.detectedOs }
      : {}),
    ...(validProxyType(candidate.proxyType) ? { proxyType: candidate.proxyType } : {}),
    ...(typeof candidate.proxyHost === 'string' && candidate.proxyHost.trim()
      ? { proxyHost: candidate.proxyHost.trim().slice(0, 255) }
      : {}),
    ...(typeof candidate.proxyPort === 'number'
      && Number.isInteger(candidate.proxyPort)
      && candidate.proxyPort >= 1
      && candidate.proxyPort <= 65535
      ? { proxyPort: candidate.proxyPort }
      : {}),
    ...(typeof candidate.proxyUsername === 'string' && candidate.proxyUsername.trim()
      ? { proxyUsername: candidate.proxyUsername.trim().slice(0, 255) }
      : {}),
    ...(typeof candidate.proxyCredentialReference === 'string'
      ? { proxyCredentialReference: candidate.proxyCredentialReference }
      : {}),
  };
}

function sanitizeGroups(value: unknown): SshConnectionGroup[] {
  const candidates = Array.isArray(value) ? value : [];
  const savedDefault = candidates.find((value) => (
    value
    && typeof value === 'object'
    && (value as Record<string, unknown>).id === SSH_DEFAULT_GROUP_ID
  )) as Record<string, unknown> | undefined;
  const groups: SshConnectionGroup[] = [{
    ...DEFAULT_SSH_GROUP,
    isExpanded: savedDefault?.isExpanded !== false,
  }];
  const ids = new Set([SSH_DEFAULT_GROUP_ID]);
  const names = new Set<string>();

  for (const value of candidates) {
    if (!value || typeof value !== 'object') continue;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string') continue;
    const id = candidate.id.trim();
    const name = candidate.name.trim();
    if (
      !id
      || id === SSH_DEFAULT_GROUP_ID
      || id.length > 128
      || !name
      || name.length > SSH_GROUP_NAME_MAX_LENGTH
      || ids.has(id)
      || names.has(name.toLocaleLowerCase())
    ) continue;
    ids.add(id);
    names.add(name.toLocaleLowerCase());
    groups.push({
      id,
      name,
      isExpanded: candidate.isExpanded !== false,
    });
  }

  return groups;
}

export function loadSshConnections(): SshConnection[] {
  try {
    const raw = localStorage.getItem(SSH_CONNECTIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const connections = parsed
      .map(sanitizeConnection)
      .filter((connection): connection is SshConnection => connection !== null);
    const sanitized = JSON.stringify(connections);
    if (sanitized !== raw) {
      localStorage.setItem(SSH_CONNECTIONS_STORAGE_KEY, sanitized);
    }
    return connections;
  } catch {
    return [];
  }
}

export function saveSshConnections(connections: readonly SshConnection[]): void {
  const safeConnections = connections
    .map(sanitizeConnection)
    .filter((connection): connection is SshConnection => connection !== null);
  localStorage.setItem(SSH_CONNECTIONS_STORAGE_KEY, JSON.stringify(safeConnections));
}

export function loadSshGroups(): SshConnectionGroup[] {
  try {
    const raw = localStorage.getItem(SSH_GROUPS_STORAGE_KEY);
    return sanitizeGroups(raw ? JSON.parse(raw) : []);
  } catch {
    return [{ ...DEFAULT_SSH_GROUP }];
  }
}

export function saveSshGroups(groups: readonly SshConnectionGroup[]): void {
  localStorage.setItem(SSH_GROUPS_STORAGE_KEY, JSON.stringify(sanitizeGroups(groups)));
}

export function loadSshWorkspaceState(): {
  groups: SshConnectionGroup[];
  connections: SshConnection[];
} {
  const groups = loadSshGroups();
  const groupIds = new Set(groups.map((group) => group.id));
  const connections = loadSshConnections().map((connection) => (
    connection.groupId && groupIds.has(connection.groupId)
      ? connection
      : { ...connection, groupId: SSH_DEFAULT_GROUP_ID }
  ));
  saveSshGroups(groups);
  saveSshConnections(connections);
  return { groups, connections };
}

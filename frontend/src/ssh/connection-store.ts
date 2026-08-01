import type { SshAuthMethod, SshConnection, SshRoutePolicy } from './types';

export const SSH_CONNECTIONS_STORAGE_KEY = 'nextdesk_ssh_connections_v1';

function validAuthMethod(value: unknown): value is SshAuthMethod {
  return value === 'password' || value === 'private_key';
}

function validRoutePolicy(value: unknown): value is SshRoutePolicy {
  return value === 'auto' || value === 'direct' || value === 'cloud_only';
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
  };
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

export interface SshCommandGroup {
  id: string;
  name: string;
}

export interface SshSavedCommand {
  id: string;
  name: string;
  command: string;
  groupId: string;
}

export interface SshCommandLibrary {
  groups: SshCommandGroup[];
  commands: SshSavedCommand[];
}

export const SSH_COMMAND_LIBRARY_STORAGE_KEY = 'nextdesk_ssh_command_library_v2';
export const SSH_COMMAND_LIBRARY_LEGACY_STORAGE_KEY = 'nextdesk_ssh_command_library_v1';
export const SSH_COMMAND_NAME_MAX_LENGTH = 80;
export const SSH_COMMAND_GROUP_NAME_MAX_LENGTH = 40;
export const SSH_COMMAND_CONTENT_MAX_LENGTH = 16_384;
export const SSH_COMMAND_LIBRARY_FILE_VERSION = 1;

function sanitizeGroup(value: unknown): SshCommandGroup | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string') return null;
  const id = candidate.id.trim();
  const name = candidate.name.trim();
  if (
    !id
    || id.length > 128
    || !name
    || name.length > SSH_COMMAND_GROUP_NAME_MAX_LENGTH
  ) return null;
  return { id, name };
}

function sanitizeCommand(value: unknown, groupIds: ReadonlySet<string>): SshSavedCommand | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== 'string'
    || typeof candidate.name !== 'string'
    || typeof candidate.command !== 'string'
    || typeof candidate.groupId !== 'string'
  ) return null;
  const id = candidate.id.trim();
  const name = candidate.name.trim();
  const command = candidate.command.trim();
  const groupId = candidate.groupId.trim();
  if (
    !id
    || id.length > 128
    || !name
    || name.length > SSH_COMMAND_NAME_MAX_LENGTH
    || !command
    || command.length > SSH_COMMAND_CONTENT_MAX_LENGTH
    || !groupIds.has(groupId)
  ) return null;
  return { id, name, command, groupId };
}

function sanitizeLibrary(value: unknown): SshCommandLibrary {
  if (!value || typeof value !== 'object') return { groups: [], commands: [] };
  const candidate = value as Record<string, unknown>;
  const groups: SshCommandGroup[] = [];
  const groupIds = new Set<string>();
  const groupNames = new Set<string>();
  for (const rawGroup of Array.isArray(candidate.groups) ? candidate.groups : []) {
    const group = sanitizeGroup(rawGroup);
    if (!group) continue;
    const normalizedName = group.name.toLocaleLowerCase();
    if (groupIds.has(group.id) || groupNames.has(normalizedName)) continue;
    groups.push(group);
    groupIds.add(group.id);
    groupNames.add(normalizedName);
  }

  const commands: SshSavedCommand[] = [];
  const commandIds = new Set<string>();
  for (const rawCommand of Array.isArray(candidate.commands) ? candidate.commands : []) {
    const command = sanitizeCommand(rawCommand, groupIds);
    if (!command || commandIds.has(command.id)) continue;
    commands.push(command);
    commandIds.add(command.id);
  }
  return { groups, commands };
}

function migrateLegacyLibrary(value: unknown): SshCommandLibrary {
  const legacy = sanitizeLibrary(value);
  const presetCommandIds = new Set([
    'disk-usage',
    'memory-usage',
    'process-top',
    'listening-ports',
    'failed-services',
    'docker-ps',
  ]);
  const presetGroupIds = new Set(['system', 'services', 'containers']);
  const commands = legacy.commands.filter((command) => !presetCommandIds.has(command.id));
  const referencedGroupIds = new Set(commands.map((command) => command.groupId));
  const groups = legacy.groups.filter((group) => (
    !presetGroupIds.has(group.id) || referencedGroupIds.has(group.id)
  ));
  return sanitizeLibrary({ groups, commands });
}

export function loadSshCommandLibrary(): SshCommandLibrary {
  try {
    const raw = localStorage.getItem(SSH_COMMAND_LIBRARY_STORAGE_KEY);
    if (raw) return sanitizeLibrary(JSON.parse(raw));

    const legacyRaw = localStorage.getItem(SSH_COMMAND_LIBRARY_LEGACY_STORAGE_KEY);
    const library = legacyRaw
      ? migrateLegacyLibrary(JSON.parse(legacyRaw))
      : { groups: [], commands: [] };
    localStorage.setItem(SSH_COMMAND_LIBRARY_STORAGE_KEY, JSON.stringify(library));
    if (legacyRaw) localStorage.removeItem(SSH_COMMAND_LIBRARY_LEGACY_STORAGE_KEY);
    return library;
  } catch {
    return { groups: [], commands: [] };
  }
}

export function saveSshCommandLibrary(library: SshCommandLibrary): SshCommandLibrary {
  const sanitized = sanitizeLibrary(library);
  localStorage.setItem(SSH_COMMAND_LIBRARY_STORAGE_KEY, JSON.stringify(sanitized));
  return sanitized;
}

export function serializeSshCommandLibrary(library: SshCommandLibrary): string {
  const sanitized = sanitizeLibrary(library);
  return JSON.stringify({ version: SSH_COMMAND_LIBRARY_FILE_VERSION, ...sanitized }, null, 2);
}

export function parseSshCommandLibrary(raw: string): SshCommandLibrary {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed?.version !== SSH_COMMAND_LIBRARY_FILE_VERSION) {
    throw new Error('ssh_command_library_version_invalid');
  }
  if (!Array.isArray(parsed.groups) || !Array.isArray(parsed.commands)) {
    throw new Error('ssh_command_library_invalid');
  }
  return sanitizeLibrary(parsed);
}

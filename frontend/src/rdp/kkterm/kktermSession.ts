const SESSION_ID_MAX_LENGTH = 96;

export function createRdpSessionId(connectionId: string) {
  const safeId = connectionId
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'session';
  return `rdp-${safeId}`.slice(0, SESSION_ID_MAX_LENGTH);
}
